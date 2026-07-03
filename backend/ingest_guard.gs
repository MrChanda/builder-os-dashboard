/**
 * BUILDER OS — ingest_guard.gs (Stage 1)
 * Fixes the duplicate-day-row bug found in DAILY_HEALTH (rows keyed at
 * both 46195.0 and 46195.9167 — date keys carrying time components so
 * upserts miss and append instead of matching) and adds a validation/
 * quarantine layer on HAE ingestion.
 *
 * WIRING (handleHealthAutoExport):
 *   1. Wherever you derive the upsert key date, wrap it:
 *        var key = normalizeDateKey_(rawDate);
 *      Use key for BOTH the row lookup and the value written to DATE.
 *   2. Before writing a metrics row:
 *        var v = validateHealthPayload_(rowObj);
 *        if (!v.ok) { quarantine_('DAILY_HEALTH', rowObj, v.issues); return; }
 *   3. One-time cleanup of existing duplicates:
 *        run repairDailyHealthKeys(true)  → read the report in Logs
 *        run repairDailyHealthKeys(false) → apply
 */

/** Floors any date representation (Date, sheet serial, ISO string,
 *  HAE "+0200" strings) to a Date at local midnight. Returns null if
 *  unparseable — caller must treat null as a validation failure. */
function normalizeDateKey_(v) {
  var d = null;
  if (v instanceof Date && !isNaN(v)) d = v;
  else if (typeof v === 'number' && isFinite(v)) {
    // Sheets serial (days since 1899-12-30). Guard the MAXIFS=0 epoch trap.
    if (v < 20000) return null; // pre-1954 = garbage in this system
    d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  } else if (typeof v === 'string' && v.trim()) {
    var s = v.trim().replace(' +', '+').replace(/(\+\d{2})(\d{2})$/, '$1:$2');
    d = new Date(s);
    if (isNaN(d)) { var m = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/); if (m) d = new Date(+m[1], +m[2]-1, +m[3]); }
  }
  if (!d || isNaN(d)) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Type/range gates on inbound health metrics. Bounds are generous —
 *  the goal is catching misrouted metrics (e.g. an HRV landing in the
 *  Steps column as 17.2), not judging the data. */
var HEALTH_BOUNDS_ = {
  HRV_MS:            [5, 250],
  RESTING_HR_BPM:    [30, 120],
  RESP_RATE_BPM:     [5, 40],
  BLOOD_OX_PCT:      [70, 100],
  STEPS:             [0, 100000],
  FLIGHTS_CLIMBED:   [0, 500],
  ACTIVE_ENERGY_KCAL:[0, 8000],
  STAND_HOURS:       [0, 24],
  VO2_MAX:           [10, 90],
  BODY_WEIGHT_KG:    [30, 250],
  BODY_FAT_PCT:      [3, 60],
  BMI:               [10, 60],
  SLEEP_DURATION_HRS:[0, 16],
  WATER_LITRES:      [0, 15]
};

function validateHealthPayload_(rowObj) {
  var issues = [];
  if (!normalizeDateKey_(rowObj.DATE)) issues.push('DATE unparseable: ' + rowObj.DATE);
  for (var k in HEALTH_BOUNDS_) {
    var v = rowObj[k];
    if (v === '' || v == null) continue;           // sparse rows are normal
    var num = Number(v);
    if (isNaN(num)) { issues.push(k + ' not numeric: ' + v); continue; }
    var b = HEALTH_BOUNDS_[k];
    if (num < b[0] || num > b[1]) issues.push(k + ' out of range [' + b[0] + ',' + b[1] + ']: ' + num);
  }
  return { ok: issues.length === 0, issues: issues };
}

function quarantine_(sourceSheet, rowObj, issues) {
  var ss = SpreadsheetApp.getActive();
  var q = ss.getSheetByName('QUARANTINE') || ss.insertSheet('QUARANTINE');
  if (q.getLastRow() === 0) q.appendRow(['TS', 'SOURCE', 'ISSUES', 'PAYLOAD_JSON']);
  q.appendRow([new Date(), sourceSheet, issues.join(' | '), JSON.stringify(rowObj)]);
}

/** Two-phase repair of DAILY_HEALTH duplicate-day rows.
 *  dryRun=true  → report only (Logger + return value), no writes.
 *  dryRun=false → floors all DATE keys, merges duplicate days
 *                 (earliest row wins position; non-empty cells win
 *                 values; later duplicates deleted). LockService held. */
function repairDailyHealthKeys(dryRun) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName('DAILY_HEALTH');
    var data = sh.getDataRange().getValues();
    var HEADER_ROWS = 2; // banner + column headers — adjust if yours differs
    var groups = {}, report = { scanned: 0, floored: 0, duplicate_days: [], merged_rows: 0 };

    for (var r = HEADER_ROWS; r < data.length; r++) {
      var raw = data[r][0]; if (raw === '' || raw == null) continue;
      report.scanned++;
      var key = normalizeDateKey_(raw); if (!key) continue;
      var ks = Utilities.formatDate(key, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      var wasTimestamped = (typeof raw === 'number' && raw % 1 !== 0);
      if (wasTimestamped) report.floored++;
      (groups[ks] = groups[ks] || []).push(r);
    }
    for (var day in groups) if (groups[day].length > 1)
      report.duplicate_days.push({ day: day, rows: groups[day].map(function(x){return x+1;}) });

    if (dryRun) { Logger.log(JSON.stringify(report, null, 2)); return report; }

    var toDelete = [];
    for (var day2 in groups) {
      var rows = groups[day2];
      var keep = rows[0];
      // floor the kept row's key
      var k2 = normalizeDateKey_(data[keep][0]);
      sh.getRange(keep + 1, 1).setValue(k2);
      for (var i = 1; i < rows.length; i++) {
        var dup = rows[i];
        for (var c = 1; c < data[keep].length; c++) {
          var keepEmpty = data[keep][c] === '' || data[keep][c] == null;
          var dupHas = data[dup][c] !== '' && data[dup][c] != null;
          if (keepEmpty && dupHas) { sh.getRange(keep + 1, c + 1).setValue(data[dup][c]); report.merged_rows++; }
        }
        toDelete.push(dup);
      }
    }
    toDelete.sort(function(a,b){return b-a;}).forEach(function(r){ sh.deleteRow(r + 1); });
    report.deleted_rows = toDelete.length;
    Logger.log(JSON.stringify(report, null, 2));
    return report;
  } finally { lock.releaseLock(); }
}

function testNormalizeDateKey() {
  ['2026-06-29 10:07:00 +0200', 46195.9166, 46195, new Date(), 0, 'garbage'].forEach(function(v){
    Logger.log(v + ' → ' + normalizeDateKey_(v));
  });
}
