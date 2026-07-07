/**
 * ============================================================
 * BUILDER OS — Google Apps Script
 * Version 6.4 | Backend API for Builder Dashboard
 * PATCHED: date typing + formula propagation + complete routing
 *          + Stage 1 auth gate, config endpoint, awarded-delta,
 *          ingest date-key normalization + validation/quarantine
 *          + Stage 1 close-out: task-ID autogen, cadence guard,
 *          points_late formula inheritance, decay-column support
 * ============================================================
 *
 * CHANGES FROM v6.3 (Stage 1 close-out, 2026-07-06):
 *
 * 1. BUG 2 — handleAddTask now auto-generates task_id from a
 *    DOMAIN_PREFIX map when task_id is omitted (nextTaskId_()),
 *    inside a LockService critical section (two rapid adds cannot
 *    collide). Dotted sub-IDs (HG3.1) count toward their integer
 *    parent for max-scan purposes — next HEALTH ID after HG7 +
 *    HG3.1–3.4 is HG8, never HG3.5. Manual IDs still accepted but
 *    collision-checked case/whitespace-insensitively
 *    (findTaskRow_()), replacing the exact-string check.
 * 2. BUG 1 — due_date is now type-guarded in both handleAddTask
 *    and handleUpdateTask: RECURRING requires a cadence from
 *    CADENCES (written as text, '@' format — Sheets can't coerce
 *    it); MILESTONE requires a parseable date (or blank/'TBD').
 *    A cadence on a MILESTONE or a date on a RECURRING task is
 *    rejected with an error instead of silently writing
 *    Invalid Date into TASKS_MASTER!E.
 * 3. BUG 3 — points_late (col I): handleAddTask writes the live
 *    formula =ROUND(H{row}*0.75,0) by default; a static value is
 *    only written when the frontend sends points_late_override.
 *    handleUpdateTask: numeric points_late → static override;
 *    empty-string points_late → formula restored; key absent →
 *    cell untouched (formula survives). One-time repair tool
 *    repairPointsLateFormulas_() re-links rows frozen at exactly
 *    75% and logs (does not touch) intentional overrides.
 * 4. BUG 4 — no backend change needed for decay_trigger /
 *    decay_pts_day (fieldMap already routed them); UI columns
 *    added in index.html. Covered by testDecayColumnsRoundTrip.
 * 5. FOUND DURING PATCH — POST task handlers previously returned
 *    errorResponse() (a ContentService.TextOutput); the router
 *    then spread that object into jsonResponse(), producing
 *    {"status":"ok"} and swallowing the error text. Task handlers
 *    now return errObj_() plain objects so errors survive the
 *    router wrap. Other handlers left as-is (out of scope).
 * 6. §1 ITEM 5 (STR decay fork) — Option B implemented (per
 *    autonomous-session authority): N3's stat-wide inactivity net
 *    is UNCHANGED; new STAT_HISTORY columns AA (STR_TASK_DECAY_WKLY)
 *    and AB (END_TASK_DECAY_WKLY) apply per-task Monday close-out
 *    decay for HG3.1–3.3 / HG3.4 that does NOT reset on unrelated
 *    STR/END activity. One-time installer:
 *    installPerTaskWeeklyDecayColumns_(). dailyRecalc's propagation
 *    list extended C:Z → C:AB. migrateHG3Split_() adds the four
 *    tasks (4/4/4/3 pts, 3/3/3/3 decay — boss-confirmed values,
 *    unmodified) and retires HG3 (status CANCELLED).
 *    Rationale for B over A: additive, preserves historical decay
 *    rows, keeps the safety net for STR work outside the split,
 *    and decouples the two failure modes instead of merging them.
 *
 * CHANGES FROM v6.2 (Stage 1 integration, this pass):
 *
 * 1. doGet/doPost both gate on requireAuth_() first — no-op while
 *    AUTH_ENABLED Script Property is unset (default v1 behavior).
 * 2. doGet routes 'config' → handleGetConfig() (config_api.gs).
 * 3. handleUpdateTask attaches result.awarded (true GOAL_COMPLETIONS
 *    delta, from points_delta.gs) whenever a task is marked COMPLETE.
 * 4. handleHealthAutoExport keys DAILY_HEALTH rows through
 *    normalizeDateKey_() instead of raw toSheetDate(string) — closes
 *    the duplicate-day bug (rows keyed at e.g. 46195.0 vs 46195.9167).
 *    Metrics also pass through validateHealthPayload_() bounds-check
 *    before writing; failures route to a QUARANTINE sheet instead of
 *    writing garbage or silently dropping.
 * 5. Requires auth.gs, config_api.gs, ingest_guard.gs, points_delta.gs
 *    to be present as sibling files in this Apps Script project —
 *    Apps Script shares global scope, no imports needed, but this
 *    file will not compile/run standalone without them.
 *
 * CHANGES FROM v6.1 (prior consolidation pass):
 *
 * 1. Removed a duplicate, unpatched handleLogDrink() — v6.1 had
 *    two definitions of this function. JS silently let the second
 *    (patched) one win, so behavior was correct, but the file lied
 *    about itself on a top-to-bottom read. Only the patched version
 *    remains now.
 *
 * 2. doPost()'s switch was missing routing for four handlers that
 *    existed in the file but were never wired up: update_task,
 *    add_task, delete_task, log_water. All four were silently
 *    falling through to the "Unknown action" default case.
 *
 * 3. doGet()'s switch was missing routing for stat_trend and
 *    completions_heatmap, same failure mode.
 *
 * Everything else is unchanged from v6.1 — see the original header
 * comments preserved below for the date-typing and formula-
 * propagation fixes from that pass.
 *
 * ------------------------------------------------------------
 * ORIGINAL v6.1 HEADER (kept for context):
 *
 * 1. New helper toSheetDate() — every DATE column write now uses
 *    a real Date object instead of a string. Strings broke two
 *    things silently:
 *      - MAXIFS(GOAL_COMPLETIONS!$B:$B, ...) in STAT_HISTORY's
 *        decay formulas treats text as non-numeric and returns 0,
 *        which the zero-guard then reads as "never completed" —
 *        flooring STR/END/SOV decay even on days you logged.
 *      - VLOOKUP(STAT_HISTORY!A3, DAILY_HEALTH!$A:$AJ, ...) needs
 *        matching types on both sides. If STAT_HISTORY!A is a real
 *        date but DAILY_HEALTH!A is text (or vice versa), the
 *        lookup silently fails and your health-points columns
 *        (X, Y in STAT_HISTORY) return 0 even when health data
 *        exists for that date.
 *
 * 2. New helper copyFormulaRowDown() — every place that appends a
 *    new row to GOAL_COMPLETIONS or STAT_HISTORY now copies the
 *    calculated-column formulas down from the row above. Before
 *    this, logGoalCompletion() only wrote columns A:I — J:M
 *    (ON_TIME, POINTS_AWARDED, POINTS_SECONDARY, STREAK_ELIGIBLE)
 *    stayed blank, so new completions never scored. Same problem
 *    in dailyRecalc() for STAT_HISTORY's C:Z columns.
 *
 * NOTE: this patch does NOT rewrite the decay formula text itself
 * (the N:R columns in STAT_HISTORY). If those cells on the live
 * sheet still use the old _xludf.days()/_xludf.maxifs() pattern,
 * fix that ONCE directly in the sheet (row 3, columns N:R) using:
 *   =IF(A3="","",MIN(0,(IF(MAXIFS(GOAL_COMPLETIONS!$B:$B,GOAL_COMPLETIONS!$H:$H,"STR")=0,999,DAYS(A3,MAXIFS(GOAL_COMPLETIONS!$B:$B,GOAL_COMPLETIONS!$H:$H,"STR")))-CONFIG!$B$38)*-3))
 * (swap "STR"/$B$38/-3 for the relevant stat/config row/multiplier
 * per column). Once row 3 is correct, copyFormulaRowDown() will
 * propagate that correct formula to every new row going forward.
 * ============================================================
 */

// ── CONFIG ───────────────────────────────────────────────────
const SHEET_ID = "1tPD8m060y_ESCZjuaBvOR8Q05pmxx6cE8UZDxTVbGP0";

const SHEETS = {
  DAILY_HEALTH:      "DAILY_HEALTH",
  ALCOHOL_SESSIONS:  "ALCOHOL_SESSIONS",
  GOAL_COMPLETIONS:  "GOAL_COMPLETIONS",
  STAT_HISTORY:      "STAT_HISTORY",
  TASKS_MASTER:      "TASKS_MASTER",
  CONFIG:            "CONFIG",
};

const COL = {
  DAILY_HEALTH: {
    DATE: 1, SHORTCUT_PULL_TS: 2, SLEEP_START: 3, SLEEP_END: 4,
    SLEEP_DURATION: 5,
    CHECKIN_TS: 6, DAY_OF_WEEK: 7,
    CHECK_IN_COMPLETE: 8,
    HRV: 9, RESTING_HR: 10, RESP_RATE: 11, BLOOD_OX: 12, CARDIO_RECOVERY: 13,
    STEPS: 14, FLIGHTS: 15, ACTIVE_ENERGY: 16, METs: 17,
    WORKOUT_DETECTED: 18, WORKOUT_TYPE: 19,
    WORKOUT_START: 20, WORKOUT_END: 21,
    WORKOUT_DURATION: 22,
    STAND_HOURS: 23, VO2_MAX: 24,
    BODY_WEIGHT: 25, BODY_FAT: 26, BMI: 27,
    ATHLYTIC: 28, SLEEP_QUALITY: 29, MOOD: 30, WATER: 31,
    NOTES: 43,
  },
  ALCOHOL_SESSIONS: {
    SESSION_ID: 1, DATE: 2, DRINK_TS: 3, SESSION_OPEN: 4, SESSION_CLOSE: 5,
    DRINK_TYPE: 6, VOLUME_ML: 7, ABV_PCT: 8,
    NOTES: 17,
  },
  GOAL_COMPLETIONS: {
    LOG_ID: 1, DATE: 2, COMPLETION_TS: 3, DOMAIN: 4, TASK_ID: 5,
    TASK_NAME: 6, COMPLETION_TYPE: 7, STAT_AWARDED: 8, STAT_SECONDARY: 9,
    NOTES: 14,
  },
  STAT_HISTORY: {
    DATE: 1, CALCULATED_AT: 2,
  },
  TASKS_MASTER: {
    TASK_ID: 1, STATUS: 12, COMPLETION_DATE: 13,
  },
};


// ── UTILITIES ─────────────────────────────────────────────────

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ss.getSheetByName(name);
  if (!ws) throw new Error("Sheet not found: " + name);
  return ws;
}

function todayISO() {
  return Utilities.formatDate(new Date(), "Africa/Johannesburg", "yyyy-MM-dd");
}

function nowISO() {
  return Utilities.formatDate(new Date(), "Africa/Johannesburg", "yyyy-MM-dd HH:mm:ss");
}

// PATCH v6.1: convert a "yyyy-MM-dd" string (or pass-through a Date)
// into a real Date object at local midnight, so sheet cells written
// from this value are numeric dates — not text — for MAXIFS/VLOOKUP.
function toSheetDate(value) {
  if (value instanceof Date) return value;
  const s = String(value).substring(0, 10);
  const parts = s.split('-');
  if (parts.length !== 3) return new Date(value); // fallback, shouldn't normally hit this
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

// PATCH v6.1: copy formulas from the row above into a newly appended
// row, for the given column letters. Call AFTER raw values are written
// into the new row so relative references (e.g. A{row}) resolve correctly.
function copyFormulaRowDown(ws, newRow, colLetters) {
  if (newRow < 4) return; // nothing to copy from if this is the first data row
  const fromRow = newRow - 1;
  colLetters.forEach(function(col) {
    const f = ws.getRange(col + fromRow).getFormula();
    if (f) ws.getRange(col + newRow).setFormula(f);
  });
}

// Strip timezone suffix from HAE datetime strings so Sheets can parse them
// "2026-06-28 21:02:00 +0200" → "2026-06-28 21:02:00"
function cleanDateTime(str) {
  if (!str) return '';
  return str.replace(/\s*[+-]\d{4}$/, '').trim();
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonResponse(data, status) {
  const payload = JSON.stringify({ status: status || "ok", ...data });
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(msg) {
  return jsonResponse({ error: msg }, "error");
}

function findRow(ws, col, value) {
  const data = ws.getDataRange().getValues();
  // Normalise both sides to "yyyy-MM-dd" — handles Date objects and slash-formatted strings
  const target = value instanceof Date
    ? Utilities.formatDate(value, "Africa/Johannesburg", "yyyy-MM-dd")
    : String(value).substring(0, 10).replace(/\//g, '-');
  for (let i = 1; i < data.length; i++) {
    const cell = data[i][col - 1];
    const cellStr = cell instanceof Date
      ? Utilities.formatDate(cell, "Africa/Johannesburg", "yyyy-MM-dd")
      : String(cell).substring(0, 10).replace(/\//g, '-');
    if (cellStr === target) return i + 1;
  }
  return -1;
}

function lastDataRow(ws) {
  const vals = ws.getRange("A:A").getValues().flat();
  let last = 1;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] !== "") last = i + 1;
  }
  return last;
}

function nextId(ws, col, prefix) {
  const last = lastDataRow(ws);
  if (last < 3) return prefix + "001";
  const vals = ws.getRange(3, col, last - 2, 1).getValues().flat();
  const nums = vals
    .filter(v => String(v).startsWith(prefix))
    .map(v => parseInt(String(v).replace(prefix, "")) || 0);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return prefix + String(next).padStart(3, "0");
}


// ── ROUTER ────────────────────────────────────────────────────

function doPost(e) {
  try {
    let payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }

    var auth = requireAuth_(e, payload);
    if (!auth.ok) return authJson_({ error: 'AUTH', detail: auth.detail });

    // Always log raw payload to Debug sheet
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const debug = ss.getSheetByName('Debug') || ss.insertSheet('Debug');
    debug.appendRow([new Date().toISOString(), JSON.stringify(payload).substring(0, 50000)]);

    const action = payload.action;

    // No action field — Health Auto Export push (metrics, workouts, or both)
    if (!action) {
      if (payload.data && (payload.data.metrics || payload.data.workouts)) {
        return respond(handleHealthAutoExport(payload));
      }
      return respond({ status: 'error', message: 'No action field. Payload logged to Debug sheet.' });
    }

    // FIX (this pass): update_task / add_task / delete_task / log_water all
    // existed as functions below but were never routed here — every call to
    // them was silently hitting the default case and returning "Unknown action".
    switch (action) {
      case 'shortcut_health': return jsonResponse(handleShortcutHealth(payload));
      case 'checkin':         return jsonResponse(handleCheckin(payload));
      case 'log_drink':       return jsonResponse(handleLogDrink(payload));
      case 'log_goal':        return jsonResponse(handleLogGoal(payload));
      case 'complete_task':   return jsonResponse(handleCompleteTask(payload));
      case 'update_task':     return jsonResponse(handleUpdateTask(payload));
      case 'add_task':        return jsonResponse(handleAddTask(payload));
      case 'delete_task':     return jsonResponse(handleDeleteTask(payload));
      case 'log_water':       return jsonResponse(handleLogWater(payload));
      case 'ping':            return respond({ status: 'ok', ts: new Date().toISOString() });
      default:                return respond({ status: 'error', message: 'Unknown action: ' + action });
    }

  } catch (err) {
    return respond({ status: 'error', message: err.message, stack: err.stack });
  }
}

function doGet(e) {
  try {
    var auth = requireAuth_(e, null);
    if (!auth.ok) return authJson_({ error: 'AUTH', detail: auth.detail });

    const action = e.parameter.action || "today_stats";
    // FIX (this pass): stat_trend / completions_heatmap existed as functions
    // below but were never routed here — same "Unknown action" failure mode
    // as the doPost gaps above.
    switch (action) {
      case "today_stats":         return serveTodayStats();
      case "today_health":        return serveTodayHealth();
      case "history":             return serveHistory(parseInt(e.parameter.days) || 30);
      case "tasks":               return serveTasks();
      case "alcohol_week":        return serveAlcoholWeek();
      case "pending_checkin":     return servePendingCheckin();
      case "stat_trend":          return handleStatTrend(e);
      case "completions_heatmap": return handleCompletionsHeatmap(e);
      case "config":               return authJson_(handleGetConfig());
      default:                    return errorResponse("Unknown action: " + action);
    }
  } catch (err) {
    return errorResponse(err.message);
  }
}


// ── POST HANDLERS ─────────────────────────────────────────────

function handleHealthAutoExport(payload) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = getSheet(SHEETS.DAILY_HEALTH);

  const metrics = payload.data?.metrics || payload.metrics || [];
  const m = {};
  metrics.forEach(metric => { m[metric.name] = metric.data || []; });

  const workoutsRaw = payload.data?.workouts || [];

  // Use the date embedded in the payload, not today — HAE exports "since last sync"
  // which may be yesterday or earlier. We write to the correct date row.
  function getPayloadDate() {
    for (const key of Object.keys(m)) {
      const entries = m[key] || [];
      if (entries.length && entries[0].date) return entries[0].date.substring(0, 10);
    }
    if (workoutsRaw.length && workoutsRaw[0].start) return workoutsRaw[0].start.substring(0, 10);
    return todayISO();
  }
  const today = getPayloadDate(); // "2026-06-25" — actual date of the data

  // Sum all qty entries where date string contains today
  function sumQty(entries) {
    return entries
      .filter(e => e.date && e.date.includes(today))
      .reduce((acc, e) => acc + (parseFloat(e.qty) || 0), 0);
  }

  // Latest qty from Watch (SE3) only, today preferred, any date as fallback
  function latestWatch(entries) {
    const todayWatch = (entries || []).filter(e =>
      e.date && e.date.includes(today) &&
      e.source && e.source.includes('SE3') && !e.source.includes('Athlytic')
    );
    if (todayWatch.length) return todayWatch[todayWatch.length - 1].qty ?? '';

    // Fallback: most recent SE3 entry regardless of date
    const anyWatch = (entries || []).filter(e =>
      e.source && e.source.includes('SE3') && !e.source.includes('Athlytic')
    );
    return anyWatch.length ? anyWatch[anyWatch.length - 1].qty ?? '' : '';
  }

  // Latest qty from any source today
  function latestAny(entries) {
    const filtered = (entries || []).filter(e => e.date && e.date.includes(today));
    return filtered.length ? filtered[filtered.length - 1].qty ?? '' : '';
  }

  // ── Sleep — find entry whose date matches today
  let sleepStart = '', sleepEnd = '', sleepDuration = '';
  const sleepEntries = m['sleep_analysis'] || [];
  const todaySleep = sleepEntries.find(e => e.date && e.date.includes(today));
  if (todaySleep) {
    // Strip timezone so Sheets can parse as datetime and calculate duration
    sleepStart    = cleanDateTime(todaySleep.sleepStart || '');
    sleepEnd      = cleanDateTime(todaySleep.sleepEnd   || '');
    sleepDuration = parseFloat((todaySleep.totalSleep   || 0).toFixed(2));
  }

  // ── Summed metrics (accumulate across the day)
  const steps        = Math.round(sumQty(m['step_count']          || []));
  const flights      = parseFloat(sumQty(m['flights_climbed']     || []).toFixed(1));
  const standHours   = Math.round(sumQty(m['apple_stand_hour']    || []));
  const exerciseMins = Math.round(sumQty(m['apple_exercise_time'] || []));

  // ── Single-value metrics (Watch preferred)
  const rhr       = latestWatch(m['resting_heart_rate']      || []);
  const hrv       = latestWatch(m['heart_rate_variability']  || []);
  const vo2max    = latestWatch(m['vo2_max']                 || []);
  const respRate  = latestWatch(m['respiratory_rate']        || []);
  const bloodOx   = latestWatch(m['blood_oxygen_saturation'] || []);
  const cardioRec = latestWatch(m['cardio_recovery']         || []);

  // Active energy: HAE sends kJ, sheet column is kcal — convert
  const activeEnergyRaw = latestAny(m['active_energy'] || []);
  const activeEnergy = activeEnergyRaw !== ''
    ? parseFloat((parseFloat(activeEnergyRaw) / 4.184).toFixed(1))
    : '';

  // Body metrics
  const weight  = latestAny(m['weight_body_mass']      || []);
  const bodyFat = latestAny(m['body_fat_percentage']   || []);
  const bmi     = latestAny(m['body_mass_index']       || []);

  // ── Workouts — payload.data.workouts array (separate HAE automation, same endpoint)
  let workoutDetected = 'NO';
  let workoutType = '', workoutStart = '', workoutEnd = '';
  let workoutDuration = '', mets = '', workoutEnergy = '';

  const workouts = workoutsRaw; // already extracted above
  const todayWorkouts = workouts.filter(w => w.start && w.start.includes(today));

  if (todayWorkouts.length > 0) {
    // Multiple workouts in one day — take the longest
    const w = todayWorkouts.reduce((a, b) =>
      (a.duration || 0) > (b.duration || 0) ? a : b
    );
    workoutDetected = 'YES';
    workoutType     = w.name || '';
    workoutStart    = cleanDateTime(w.start || '');
    workoutEnd      = cleanDateTime(w.end   || '');
    workoutDuration = parseFloat(((w.duration || 0) / 60).toFixed(1)); // seconds → minutes
    mets            = parseFloat((w.intensity?.qty || 0).toFixed(2));  // kcal/hr·kg = METs

    // Sum workout activeEnergy array (kJ) → convert to kcal
    const workoutEnergyKJ = (w.activeEnergy || [])
      .reduce((acc, e) => acc + (parseFloat(e.qty) || 0), 0);
    workoutEnergy = parseFloat((workoutEnergyKJ / 4.184).toFixed(1));
  }

  const c = COL.DAILY_HEALTH;

  // ── Serialise concurrent writes (two HAE automations may fire close together)
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  // ── Pass 1: Metrics + Workouts → keyed on payload date (today)
  if (metrics.length > 0 || workouts.length > 0) {
    // PATCH Stage 1 (ingest_guard.gs): floor the key through normalizeDateKey_
    // instead of raw toSheetDate(today) — closes the duplicate-day bug where
    // rows got keyed at e.g. 46195.0 and 46195.9167 (same day, time component
    // riding along) and upserts missed each other, appending instead of matching.
    const dateKey = normalizeDateKey_(today);
    if (!dateKey) {
      quarantine_('DAILY_HEALTH', { DATE: today, note: 'metrics/workouts payload' }, ['DATE unparseable']);
      lock.releaseLock();
      return { status: 'error', message: 'Unparseable payload date, quarantined: ' + today };
    }

    let metricsRow = findRow(ws, COL.DAILY_HEALTH.DATE, dateKey);
    if (metricsRow === -1) {
      metricsRow = lastDataRow(ws) + 1;
      // dateKey is already a real, floored Date — write it directly.
      ws.getRange(metricsRow, c.DATE).setValue(dateKey);
      ws.getRange(metricsRow, c.DATE).setNumberFormat('yyyy-mm-dd');
      SpreadsheetApp.flush();
    }

    // PATCH Stage 1 (ingest_guard.gs): bounds-check inbound metrics before
    // writing. Catches misrouted values (e.g. an HRV landing in Steps) rather
    // than silently writing garbage. Only metrics writes are gated — workout
    // fields aren't in HEALTH_BOUNDS_ and pass through unchanged.
    if (metrics.length > 0) {
      const v = validateHealthPayload_({
        DATE: today,
        HRV_MS: hrv, RESTING_HR_BPM: rhr, RESP_RATE_BPM: respRate,
        BLOOD_OX_PCT: bloodOx, STEPS: steps, FLIGHTS_CLIMBED: flights,
        ACTIVE_ENERGY_KCAL: activeEnergy, STAND_HOURS: standHours,
        VO2_MAX: vo2max, BODY_WEIGHT_KG: weight, BODY_FAT_PCT: bodyFat,
        BMI: bmi, SLEEP_DURATION_HRS: sleepDuration
      });
      if (!v.ok) {
        quarantine_('DAILY_HEALTH', { date: today, metrics_snapshot: { hrv, rhr, respRate, bloodOx, steps, flights, activeEnergy, standHours, vo2max, weight, bodyFat, bmi } }, v.issues);
        Logger.log('Metrics quarantined for ' + today + ': ' + v.issues.join(' | '));
        lock.releaseLock();
        return { status: 'error', message: 'Metrics out of bounds, quarantined', issues: v.issues };
      }
    }

    if (metrics.length > 0) {
      ws.getRange(metricsRow, c.SHORTCUT_PULL_TS).setValue(nowISO());
      ws.getRange(metricsRow, c.HRV).setValue(hrv);
      ws.getRange(metricsRow, c.RESTING_HR).setValue(rhr);
      ws.getRange(metricsRow, c.RESP_RATE).setValue(respRate);
      ws.getRange(metricsRow, c.BLOOD_OX).setValue(bloodOx);
      ws.getRange(metricsRow, c.CARDIO_RECOVERY).setValue(cardioRec);
      ws.getRange(metricsRow, c.STEPS).setValue(steps);
      ws.getRange(metricsRow, c.FLIGHTS).setValue(flights);
      ws.getRange(metricsRow, c.ACTIVE_ENERGY).setValue(activeEnergy);
      ws.getRange(metricsRow, c.STAND_HOURS).setValue(standHours);
      ws.getRange(metricsRow, c.VO2_MAX).setValue(vo2max);
      if (weight  !== '') ws.getRange(metricsRow, c.BODY_WEIGHT).setValue(weight);
      if (bodyFat !== '') ws.getRange(metricsRow, c.BODY_FAT).setValue(bodyFat);
      if (bmi     !== '') ws.getRange(metricsRow, c.BMI).setValue(bmi);
    }

    if (workouts.length > 0) {
      ws.getRange(metricsRow, c.WORKOUT_DETECTED).setValue(workoutDetected);
      ws.getRange(metricsRow, c.WORKOUT_TYPE).setValue(workoutType);
      ws.getRange(metricsRow, c.WORKOUT_START).setValue(workoutStart);
      ws.getRange(metricsRow, c.WORKOUT_END).setValue(workoutEnd);
      ws.getRange(metricsRow, c.WORKOUT_DURATION).setValue(workoutDuration);
      ws.getRange(metricsRow, c.METs).setValue(mets);
      if (activeEnergy === '' && workoutEnergy !== '') {
        ws.getRange(metricsRow, c.ACTIVE_ENERGY).setValue(workoutEnergy);
      }
    }

    const existingStatus = ws.getRange(metricsRow, c.CHECK_IN_COMPLETE).getValue();
    if (!existingStatus || existingStatus === '') {
      ws.getRange(metricsRow, c.CHECK_IN_COMPLETE).setValue('SHORTCUT_DONE');
    }
  }

  // ── Pass 2: Sleep → keyed on sleepStart date (the night it began)
  // Sleep sessions span midnight: a session starting "2026-06-22 23:00" is assigned
  // date "2026-06-23" by Apple Health, but belongs to the 22nd row.
  // We use sleepStart.substring(0,10) to find/create the correct row.
  if (sleepStart) {
    const sleepDateRaw = sleepStart.substring(0, 10); // "2026-06-22"
    // PATCH Stage 1 (ingest_guard.gs): same floor-through-normalizeDateKey_
    // treatment as the metrics/workouts key above.
    const sleepDateKey = normalizeDateKey_(sleepDateRaw);
    if (!sleepDateKey) {
      quarantine_('DAILY_HEALTH', { sleepStart, sleepEnd, note: 'sleep payload' }, ['sleep DATE unparseable: ' + sleepDateRaw]);
      Logger.log('Sleep payload quarantined — unparseable date: ' + sleepDateRaw);
    } else {
    let sleepRow = findRow(ws, COL.DAILY_HEALTH.DATE, sleepDateKey);
    if (sleepRow === -1) {
      sleepRow = lastDataRow(ws) + 1;
      // sleepDateKey is already a real, floored Date — write it directly.
      ws.getRange(sleepRow, c.DATE).setValue(sleepDateKey);
      ws.getRange(sleepRow, c.DATE).setNumberFormat('yyyy-mm-dd');
      SpreadsheetApp.flush();
    }
    ws.getRange(sleepRow, c.SLEEP_START).setValue(sleepStart);
    ws.getRange(sleepRow, c.SLEEP_END).setValue(sleepEnd);
    // SLEEP_DURATION (col 5) is a sheet formula — fires automatically from START/END

    // Mark row as having shortcut data if not already checked in
    const sleepRowStatus = ws.getRange(sleepRow, c.CHECK_IN_COMPLETE).getValue();
    if (!sleepRowStatus || sleepRowStatus === '') {
      ws.getRange(sleepRow, c.CHECK_IN_COMPLETE).setValue('SHORTCUT_DONE');
    }
    Logger.log('Sleep written to row for ' + sleepDateRaw + ' (sleepStart: ' + sleepStart + ')');
    } // end sleepDateKey else
  }

  // ── Audit trail → Health_Log
  let logSheet = ss.getSheetByName('Health_Log');
  if (!logSheet) {
    logSheet = ss.insertSheet('Health_Log');
    logSheet.appendRow([
      'Date', 'Steps', 'RHR', 'HRV', 'Sleep_hrs', 'Sleep_Start', 'Sleep_End',
      'Active_Energy_kcal', 'Exercise_min', 'Resp_Rate', 'SpO2', 'Cardio_Recovery',
      'Flights', 'Stand_hrs', 'Weight_kg', 'Body_Fat_pct', 'BMI', 'VO2Max',
      'Workout', 'Workout_Duration_min', 'METs'
    ]);
  }
  logSheet.appendRow([
    today, steps, rhr, hrv, sleepDuration, sleepStart, sleepEnd,
    activeEnergy || workoutEnergy, exerciseMins, respRate, bloodOx, cardioRec,
    flights, standHours, weight, bodyFat, bmi, vo2max,
    workoutType, workoutDuration, mets
  ]);

  const summary = {
    steps, rhr, hrv,
    sleep_hrs:      sleepDuration,
    stand_hours:    standHours,
    exercise_mins:  exerciseMins,
    active_kcal:    activeEnergy || workoutEnergy,
    workout:        workoutDetected === 'YES' ? `${workoutType} ${workoutDuration}min` : 'none'
  };
  Logger.log('HAE write complete: ' + JSON.stringify(summary));

  lock.releaseLock();

  return {
    status: 'ok',
    date: today,
    metrics_received: metrics.length,
    workouts_received: workouts.length,
    summary
  };
}

function handleShortcutHealth(body) {
  const ws   = getSheet(SHEETS.DAILY_HEALTH);
  const date = body.date || todayISO();

  let targetRow = findRow(ws, COL.DAILY_HEALTH.DATE, date);
  if (targetRow === -1) {
    targetRow = lastDataRow(ws) + 1;
    // PATCH v6.1: real Date, not string.
    ws.getRange(targetRow, COL.DAILY_HEALTH.DATE).setValue(toSheetDate(date));
    ws.getRange(targetRow, COL.DAILY_HEALTH.DATE).setNumberFormat('yyyy-mm-dd');
  }

  const c = COL.DAILY_HEALTH;
  const r = targetRow;

  ws.getRange(r, c.SHORTCUT_PULL_TS).setValue(body.pull_timestamp || nowISO());
  ws.getRange(r, c.SLEEP_START).setValue(body.sleep_start || "");
  ws.getRange(r, c.SLEEP_END).setValue(body.sleep_end || "");
  ws.getRange(r, c.HRV).setValue(body.hrv ?? "");
  ws.getRange(r, c.RESTING_HR).setValue(body.resting_hr ?? "");
  ws.getRange(r, c.RESP_RATE).setValue(body.resp_rate ?? "");
  ws.getRange(r, c.BLOOD_OX).setValue(body.blood_ox ?? "");
  ws.getRange(r, c.CARDIO_RECOVERY).setValue(body.cardio_recovery ?? "");
  ws.getRange(r, c.STEPS).setValue(body.steps ?? "");
  ws.getRange(r, c.FLIGHTS).setValue(body.flights ?? "");
  ws.getRange(r, c.ACTIVE_ENERGY).setValue(body.active_energy ?? "");
  ws.getRange(r, c.METs).setValue(body.mets ?? "");
  ws.getRange(r, c.WORKOUT_DETECTED).setValue(body.workout_detected ? "YES" : "NO");
  ws.getRange(r, c.WORKOUT_TYPE).setValue(body.workout_type || "");
  ws.getRange(r, c.WORKOUT_START).setValue(body.workout_start || "");
  ws.getRange(r, c.WORKOUT_END).setValue(body.workout_end || "");
  ws.getRange(r, c.STAND_HOURS).setValue(body.stand_hours ?? "");
  ws.getRange(r, c.VO2_MAX).setValue(body.vo2_max ?? "");

  if (body.body_weight != null) ws.getRange(r, c.BODY_WEIGHT).setValue(body.body_weight);
  if (body.body_fat   != null) ws.getRange(r, c.BODY_FAT).setValue(body.body_fat);
  if (body.bmi        != null) ws.getRange(r, c.BMI).setValue(body.bmi);

  const existing = ws.getRange(r, c.CHECK_IN_COMPLETE).getValue();
  if (!existing || existing === "") {
    ws.getRange(r, c.CHECK_IN_COMPLETE).setValue("SHORTCUT_DONE");
  }

  return { message: "Health data written", row: targetRow, date: date };
}

function handleCheckin(body) {
  const ws   = getSheet(SHEETS.DAILY_HEALTH);
  const date = body.date || todayISO();

  let targetRow = findRow(ws, COL.DAILY_HEALTH.DATE, date);
  if (targetRow === -1) {
    targetRow = lastDataRow(ws) + 1;
    // PATCH v6.1: real Date, not string.
    ws.getRange(targetRow, COL.DAILY_HEALTH.DATE).setValue(toSheetDate(date));
    ws.getRange(targetRow, COL.DAILY_HEALTH.DATE).setNumberFormat('yyyy-mm-dd');
  }

  const c = COL.DAILY_HEALTH;
  const r = targetRow;

  ws.getRange(r, c.CHECKIN_TS).setValue(nowISO());
  ws.getRange(r, c.ATHLYTIC).setValue(body.athlytic_score ?? "");
  ws.getRange(r, c.SLEEP_QUALITY).setValue(body.sleep_quality ?? "");
  ws.getRange(r, c.MOOD).setValue(body.mood ?? "");
  ws.getRange(r, c.WATER).setValue(body.water ?? "");
  ws.getRange(r, c.NOTES).setValue(body.notes || "");
  ws.getRange(r, c.CHECK_IN_COMPLETE).setValue("YES");

  if (body.completions) {
    const completionMap = {
      msc_session:        { domain: "SCHOOL", task_id: "S4",  name: "MSc study session",           stat: "INT", secondary: "" },
      ntcsa_deliverable:  { domain: "WORK",   task_id: "W4",  name: "NTCSA technical deliverable",  stat: "BLD", secondary: "INT" },
      journaling:         { domain: "INNER",  task_id: "IW1", name: "Journaling session",           stat: "EQ",  secondary: "" },
      mentoring:          { domain: "HELP",   task_id: "HP2", name: "Help/mentoring interaction",   stat: "EQ",  secondary: "SOV" },
      financial_move:     { domain: "SOV",    task_id: "SV2", name: "Financial move / savings hit", stat: "SOV", secondary: "" },
      maz_time:           { domain: "INNER",  task_id: "IW2", name: "Intentional time with Maz",   stat: "EQ",  secondary: "" },
      hustle_session:     { domain: "HUSTLE", task_id: "H4",  name: "Hustle session",              stat: "BLD", secondary: "" },
      reading:            { domain: "SCHOOL", task_id: "S5",  name: "Course / reading logged",     stat: "INT", secondary: "" },
    };

    for (const [key, meta] of Object.entries(completionMap)) {
      if (body.completions[key] === true) {
        logGoalCompletion(date, meta.domain, meta.task_id, meta.name,
                          "RECURRING", meta.stat, meta.secondary, "");
      }
    }
  }

  return { message: "Check-in saved", row: targetRow, date: date };
}

// PATCH v6.1: date typing + I:P formula propagation. This is the only
// handleLogDrink() in the file now — v6.1 had an earlier, unpatched
// duplicate of this function that's been removed in this pass.
function handleLogDrink(body) {
  const ws   = getSheet(SHEETS.ALCOHOL_SESSIONS);
  const date = body.date || todayISO();
  const now  = body.drink_timestamp || nowISO();

  let sessionId = body.session_id;
  if (!sessionId || sessionId === "NEW") {
    sessionId = nextId(ws, COL.ALCOHOL_SESSIONS.SESSION_ID, "SES_");
  }

  let sessionOpen = now;
  const allData = ws.getDataRange().getValues();
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][0]) === sessionId) {
      sessionOpen = allData[i][3];
      break;
    }
  }

  const newRow = lastDataRow(ws) + 1;
  const c = COL.ALCOHOL_SESSIONS;

  ws.getRange(newRow, c.SESSION_ID).setValue(sessionId);
  // PATCH: real Date, not string — consistent with every other DATE column fix.
  ws.getRange(newRow, c.DATE).setValue(toSheetDate(date));
  ws.getRange(newRow, c.DATE).setNumberFormat('yyyy-mm-dd');
  ws.getRange(newRow, c.DRINK_TS).setValue(now);
  ws.getRange(newRow, c.SESSION_OPEN).setValue(sessionOpen);
  ws.getRange(newRow, c.SESSION_CLOSE).setValue("OPEN");
  ws.getRange(newRow, c.DRINK_TYPE).setValue(body.drink_type || "");
  ws.getRange(newRow, c.VOLUME_ML).setValue(body.volume_ml ?? 0);
  ws.getRange(newRow, c.ABV_PCT).setValue(body.abv_pct ?? 0);
  ws.getRange(newRow, c.NOTES).setValue(body.notes || "");

  // PATCH: propagate the calculated BAC/units chain (I:P) from the row
  // above — same fix pattern as the other three sheets.
  copyFormulaRowDown(ws, newRow, ['I', 'J', 'K', 'L', 'M', 'N', 'O', 'P']);

  SpreadsheetApp.flush();
  return { message: "Drink logged", session_id: sessionId, row: newRow };
}

function handleCompleteTask(body) {
  const ws     = getSheet(SHEETS.TASKS_MASTER);
  const taskId = body.task_id;
  const row    = findRow(ws, COL.TASKS_MASTER.TASK_ID, taskId);

  if (row === -1) return errorResponse("Task not found: " + taskId);

  ws.getRange(row, COL.TASKS_MASTER.STATUS).setValue("COMPLETE");
  ws.getRange(row, COL.TASKS_MASTER.COMPLETION_DATE).setValue(todayISO());

  return { message: "Task marked complete", task_id: taskId, row: row };
}

// ── TASKS_MASTER CRUD ────────────────────────────────────
// Column mapping matches serveTasks()'s existing 16-column read (A:P) —
// task_id, domain, task_name, type, due_date, stat_primary,
// stat_secondary, points_on_time, points_late, decay_trigger,
// decay_pts_day, status, completion_date, days_overdue*, decay_total*,
// effective_pts* (* = formula columns, never written directly).
//
// v6.4 shared task-CRUD infrastructure:

// The only legal due_date strings for RECURRING tasks. Everything the
// sheet formulas branch on (IF(OR(E="DAILY","WEEKLY",...))) — keep in
// sync with the N/P column formulas in TASKS_MASTER if ever extended.
var CADENCES = ['DAILY', 'WEEKLY', 'FORTNIGHTLY', 'MONTHLY', '3X_WEEKLY'];

// Domain → task-ID prefix. Derived from the live ID population
// (S*, W*, H*, HG*, HP*, SV*, IW*, F*). WORK also contains legacy
// T0xx rows — those never match the W-prefix regex, so they neither
// collide with nor advance the W counter.
var DOMAIN_PREFIX = {
  SCHOOL: 'S', WORK: 'W', HUSTLE: 'H', HEALTH: 'HG',
  HELP: 'HP', INNER: 'IW', SOV: 'SV', FINANCE: 'F',
};

function normalizeTaskId_(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

// v6.4: plain-object error for POST task handlers. Do NOT use
// errorResponse() inside handlers the router wraps with jsonResponse():
// spreading a ContentService.TextOutput yields {"status":"ok"} and the
// error text vanishes. jsonResponse spreads this AFTER its default, so
// status:'error' survives.
function errObj_(msg) {
  return { status: 'error', error: msg };
}

// Case/whitespace-insensitive TASK_ID row lookup. Replaces findRow()
// for task CRUD: findRow's substring(0,10) date-normalisation is wrong
// for IDs, and exact-match let "hg8 " slip past the collision check.
function findTaskRow_(ws, taskId) {
  var target = normalizeTaskId_(taskId);
  if (!target) return -1;
  var last = lastDataRow(ws);
  if (last < 3) return -1;
  var vals = ws.getRange(3, COL.TASKS_MASTER.TASK_ID, last - 2, 1).getValues().flat();
  for (var i = 0; i < vals.length; i++) {
    if (normalizeTaskId_(vals[i]) === target) return i + 3;
  }
  return -1;
}

// Next sequential ID for a domain. Dotted sub-IDs (HG3.1) count toward
// their INTEGER parent — existing HG1..HG7 + HG3.1–3.4 → next is HG8,
// never HG3.5. Prefix matching is anchored, so HUSTLE's 'H' cannot
// swallow 'HG'/'HP' IDs (the remainder must be purely numeric).
function nextTaskId_(ws, domain) {
  var prefix = DOMAIN_PREFIX[String(domain || '').trim().toUpperCase()];
  if (!prefix) throw new Error('No ID prefix mapped for domain: ' + domain);
  var maxN = 0;
  var last = lastDataRow(ws);
  if (last >= 3) {
    var vals = ws.getRange(3, COL.TASKS_MASTER.TASK_ID, last - 2, 1).getValues().flat();
    var re = new RegExp('^' + prefix + '(\\d+)(?:\\.\\d+)?$');
    vals.forEach(function (v) {
      var m = re.exec(normalizeTaskId_(v));
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    });
  }
  return prefix + (maxN + 1);
}

// Type-guards a due_date value. Returns {value, isCadence} or throws.
// RECURRING → must be a CADENCES member (uppercased). MILESTONE → must
// parse to a real Date. Blank/'TBD' handled by callers (allowed for
// MILESTONE only — the live sheet already contains 'TBD' milestones).
function normalizeDueDateForType_(type, dueRaw) {
  var t = String(type || '').trim().toUpperCase();
  var raw = String(dueRaw == null ? '' : dueRaw).trim();
  if (t === 'RECURRING') {
    var cad = raw.toUpperCase();
    if (CADENCES.indexOf(cad) === -1) {
      throw new Error('RECURRING task due_date must be a cadence (' +
        CADENCES.join('/') + ') — got: "' + raw + '"');
    }
    return { value: cad, isCadence: true };
  }
  if (CADENCES.indexOf(raw.toUpperCase()) !== -1) {
    throw new Error('MILESTONE task due_date must be a date, not a cadence — got: "' + raw + '"');
  }
  var d = toSheetDate(raw);
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    throw new Error('MILESTONE task due_date must be a valid yyyy-MM-dd date — got: "' + raw + '"');
  }
  return { value: d, isCadence: false };
}

// Writes a type-guarded due value into TASKS_MASTER!E{row}.
// Cadence strings get '@' (plain text) format so Sheets cannot coerce
// them; dates get a real Date + yyyy-mm-dd format (v6.1 MAXIFS/VLOOKUP
// typing rules).
function writeDueDate_(ws, row, normalized) {
  var cell = ws.getRange(row, 5);
  if (normalized.isCadence) {
    cell.setNumberFormat('@');
    cell.setValue(normalized.value);
  } else {
    cell.setValue(normalized.value);
    cell.setNumberFormat('yyyy-mm-dd');
  }
}

function pointsLateFormula_(row) {
  return '=ROUND(H' + row + '*0.75,0)';
}

function handleUpdateTask(body) {
  const ws = getSheet(SHEETS.TASKS_MASTER);
  const taskId = body.task_id;
  if (!taskId) return errObj_("task_id is required");

  const row = findTaskRow_(ws, taskId);
  if (row === -1) return errObj_("Task not found: " + taskId);

  // ── BUG 1 guard: resolve the EFFECTIVE type (incoming if provided,
  // else the stored one) and validate due_date against it BEFORE any
  // write — all-or-nothing, no partially-updated row on rejection.
  const storedType = String(ws.getRange(row, 4).getValue() || '').trim().toUpperCase();
  const effType = body.type !== undefined
    ? String(body.type || '').trim().toUpperCase()
    : storedType;

  let dueNormalized = null;
  const dueRaw = body.due_date !== undefined ? String(body.due_date).trim() : undefined;
  const dueIsBlankish = dueRaw !== undefined && (dueRaw === '' || dueRaw.toUpperCase() === 'TBD');

  if (dueRaw !== undefined && !dueIsBlankish) {
    try {
      dueNormalized = normalizeDueDateForType_(effType, dueRaw);
    } catch (err) {
      return errObj_(err.message);
    }
  }

  // Type flip without a compatible due_date: refuse rather than leave a
  // stale date under a RECURRING type (or a cadence under a MILESTONE).
  if (body.type !== undefined && effType !== storedType && dueNormalized === null) {
    const storedDue = String(ws.getRange(row, 5).getValue() || '').trim().toUpperCase();
    const storedIsCadence = CADENCES.indexOf(storedDue) !== -1;
    if (effType === 'RECURRING' && !storedIsCadence) {
      return errObj_('Changing type to RECURRING requires a cadence due_date (' + CADENCES.join('/') + ')');
    }
    if (effType === 'MILESTONE' && storedIsCadence) {
      return errObj_('Changing type to MILESTONE requires a date due_date — stored value "' + storedDue + '" is a cadence');
    }
  }

  if (effType === 'RECURRING' && dueIsBlankish) {
    return errObj_('RECURRING task due_date cannot be blank — pick a cadence (' + CADENCES.join('/') + ')');
  }

  const fieldMap = {
    domain:          2,
    task_name:       3,
    type:            4,
    // due_date (5) and points_late (9) handled specially below
    stat_primary:    6,
    stat_secondary:  7,
    points_on_time:  8,
    decay_trigger:   10,
    decay_pts_day:   11,
    status:          12,
  };

  Object.keys(fieldMap).forEach(function(key) {
    if (body[key] !== undefined) {
      ws.getRange(row, fieldMap[key]).setValue(body[key]);
    }
  });

  if (dueNormalized !== null) {
    writeDueDate_(ws, row, dueNormalized);
  } else if (dueIsBlankish && effType !== 'RECURRING') {
    ws.getRange(row, 5).setNumberFormat('@');
    ws.getRange(row, 5).setValue(dueRaw === '' ? '' : 'TBD');
  }

  // ── BUG 3 semantics:
  //   points_late absent          → cell untouched (live formula survives)
  //   points_late "" (explicit)   → restore =ROUND(H*0.75,0) auto-link
  //   points_late numeric         → static override (points_late_override
  //                                 flag is informational; mobile never
  //                                 sends this key at all)
  if (body.points_late !== undefined) {
    if (body.points_late === '' || body.points_late === null) {
      ws.getRange(row, 9).setFormula(pointsLateFormula_(row));
    } else {
      ws.getRange(row, 9).setValue(Number(body.points_late) || 0);
    }
  }

  SpreadsheetApp.flush();

  const result = { message: "Task updated", task_id: taskId, row: row };
  if (body.status !== undefined && String(body.status).toUpperCase() === 'COMPLETE') {
    result.awarded = getAwardedDelta_(taskId);
  }
  return result;
}

function handleAddTask(body) {
  const ws = getSheet(SHEETS.TASKS_MASTER);

  const type = String(body.type || 'MILESTONE').trim().toUpperCase();

  // ── BUG 1 guard (validate before locking — cheap rejection path)
  let dueNormalized = null;
  const dueRaw = body.due_date !== undefined ? String(body.due_date).trim() : '';
  const dueIsBlankish = dueRaw === '' || dueRaw.toUpperCase() === 'TBD';
  if (!dueIsBlankish) {
    try {
      dueNormalized = normalizeDueDateForType_(type, dueRaw);
    } catch (err) {
      return errObj_(err.message);
    }
  } else if (type === 'RECURRING') {
    return errObj_('RECURRING task requires a cadence due_date (' + CADENCES.join('/') + ')');
  }

  // ── BUG 2: ID assignment + row append are one atomic critical
  // section. Two near-simultaneous add_task calls serialize here —
  // the second computes its ID only after the first's row exists.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return errObj_('Could not obtain write lock — another add is in flight, retry.');
  }

  try {
    let taskId = normalizeTaskId_(body.task_id);
    if (taskId) {
      if (findTaskRow_(ws, taskId) !== -1) {
        return errObj_("task_id already exists: " + taskId);
      }
    } else {
      if (!body.domain) {
        return errObj_("domain is required when task_id is omitted (auto-ID)");
      }
      try {
        taskId = nextTaskId_(ws, body.domain);
      } catch (err) {
        return errObj_(err.message);
      }
    }

    const newRow = lastDataRow(ws) + 1;

    ws.getRange(newRow, 1).setValue(taskId);
    ws.getRange(newRow, 2).setValue(body.domain || "");
    ws.getRange(newRow, 3).setValue(body.task_name || "");
    ws.getRange(newRow, 4).setValue(type);
    if (dueNormalized !== null) writeDueDate_(ws, newRow, dueNormalized);
    ws.getRange(newRow, 6).setValue(body.stat_primary || "");
    ws.getRange(newRow, 7).setValue(body.stat_secondary || "");
    ws.getRange(newRow, 8).setValue(body.points_on_time != null ? body.points_on_time : 0);

    // ── BUG 3: default = inherit the live 75% formula (self-corrects
    // if points_on_time is edited later). Static write ONLY on an
    // explicit frontend override.
    if (body.points_late_override === true && body.points_late != null && body.points_late !== '') {
      ws.getRange(newRow, 9).setValue(Number(body.points_late) || 0);
    } else {
      ws.getRange(newRow, 9).setFormula(pointsLateFormula_(newRow));
    }

    ws.getRange(newRow, 10).setValue(body.decay_trigger || "");
    ws.getRange(newRow, 11).setValue(body.decay_pts_day != null ? Number(body.decay_pts_day) || 0 : 0);
    ws.getRange(newRow, 12).setValue(body.status || "PENDING");
    // column 13 (completion_date) intentionally left blank

    // PATCH v6.1 pattern: propagate the formula columns (days_overdue,
    // decay_total, effective_pts — N:P) from the row above.
    copyFormulaRowDown(ws, newRow, ['N', 'O', 'P']);

    SpreadsheetApp.flush();
    return { message: "Task added", task_id: taskId, row: newRow };
  } finally {
    lock.releaseLock();
  }
}

function handleDeleteTask(body) {
  const ws = getSheet(SHEETS.TASKS_MASTER);
  const taskId = body.task_id;
  if (!taskId) return errObj_("task_id is required");

  // v6.4: normalized lookup + errObj_ (see header change 5).
  const row = findTaskRow_(ws, taskId);
  if (row === -1) return errObj_("Task not found: " + taskId);

  ws.deleteRow(row);
  SpreadsheetApp.flush();
  return { message: "Task deleted", task_id: taskId };
}

// ── WATER LOGGING ────────────────────────────────────────────
// Adds the given amount (litres) to today's running WATER total in
// DAILY_HEALTH, creating today's row if it doesn't exist yet. This is
// additive (running total), not a replacement — each "+250ml" tap adds
// to whatever's already logged today.
//
// Note: this writes directly into DAILY_HEALTH!WATER (column 31), the
// same column handleCheckin's "water" field writes during the daily
// check-in. If you log water through this handler AND set a water
// value during checkin the same day, checkin's setValue() will
// overwrite (not add to) whatever this handler accumulated — worth
// knowing if you use both paths on the same day.
function handleLogWater(body) {
  const ws   = getSheet(SHEETS.DAILY_HEALTH);
  const date = body.date || todayISO();

  let targetRow = findRow(ws, COL.DAILY_HEALTH.DATE, date);
  if (targetRow === -1) {
    targetRow = lastDataRow(ws) + 1;
    ws.getRange(targetRow, COL.DAILY_HEALTH.DATE).setValue(toSheetDate(date));
    ws.getRange(targetRow, COL.DAILY_HEALTH.DATE).setNumberFormat('yyyy-mm-dd');
  }

  const c = COL.DAILY_HEALTH;
  const amount = Number(body.amount_litres) || 0;
  const current = Number(ws.getRange(targetRow, c.WATER).getValue()) || 0;
  const newTotal = parseFloat((current + amount).toFixed(2));

  ws.getRange(targetRow, c.WATER).setValue(newTotal);
  SpreadsheetApp.flush();

  return { message: "Water logged", date: date, total_litres: newTotal };
}


// ── SHARED HELPER ─────────────────────────────────────────────

function logGoalCompletion(date, domain, taskId, taskName, type, stat, secondary, notes) {
  const ws  = getSheet(SHEETS.GOAL_COMPLETIONS);
  const row = lastDataRow(ws) + 1;
  const c   = COL.GOAL_COMPLETIONS;
  const id  = nextId(ws, c.LOG_ID, "G");

  ws.getRange(row, c.LOG_ID).setValue(id);
  // PATCH v6.1: real Date, not string — this is the column MAXIFS reads
  // in STAT_HISTORY's decay formulas. Text here is read as 0 by MAXIFS,
  // which the zero-guard then treats as "never completed".
  ws.getRange(row, c.DATE).setValue(toSheetDate(date));
  ws.getRange(row, c.DATE).setNumberFormat('yyyy-mm-dd');
  ws.getRange(row, c.COMPLETION_TS).setValue(new Date());
  ws.getRange(row, c.COMPLETION_TS).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  ws.getRange(row, c.DOMAIN).setValue(domain);
  ws.getRange(row, c.TASK_ID).setValue(taskId);
  ws.getRange(row, c.TASK_NAME).setValue(taskName);
  ws.getRange(row, c.COMPLETION_TYPE).setValue(type);
  ws.getRange(row, c.STAT_AWARDED).setValue(stat);
  ws.getRange(row, c.STAT_SECONDARY).setValue(secondary);
  ws.getRange(row, c.NOTES).setValue(notes);

  // PATCH v6.1: propagate the calculated columns (ON_TIME, POINTS_AWARDED,
  // POINTS_SECONDARY, STREAK_ELIGIBLE — columns J:M) from the row above.
  // Without this, every new completion scored 0 points.
  copyFormulaRowDown(ws, row, ['J', 'K', 'L', 'M']);
}


// ── GET HANDLERS ──────────────────────────────────────────────

function serveTodayStats() {
  const ws    = getSheet(SHEETS.STAT_HISTORY);
  const today = todayISO();
  let   row   = findRow(ws, 1, today);
  let   fresh = true;

  if (row === -1) {
    row   = lastDataRow(ws);
    fresh = false;
  }

  if (row < 3) return jsonResponse({ message: "No stat history yet", stats: null });

  const vals = ws.getRange(row, 1, 1, 26).getValues()[0];

  return jsonResponse({
    fresh: fresh,
    stats: {
      date:          vals[0],
      calculated_at: vals[1],
      str:           vals[2],
      end:           vals[3],
      rec:           vals[4],
      int:           vals[5],
      eq:            vals[6],
      sov:           vals[7],
      builder_level: vals[8],
      builder_title: vals[9],
      weakest_stat:  vals[10],
      weakest_value: vals[11],
      pillar_cap:    vals[12],
      decay_str:     vals[13],
      decay_end:     vals[14],
      decay_int:     vals[15],
      decay_eq:      vals[16],
      decay_sov:     vals[17],
      decay_flags:   vals[25],
    }
  });
}

function serveTodayHealth() {
  const ws    = getSheet(SHEETS.DAILY_HEALTH);
  const today = todayISO();
  const row   = findRow(ws, 1, today);

  if (row === -1) return jsonResponse({ message: "No health data today yet", health: null });

  const vals = ws.getRange(row, 1, 1, 43).getValues()[0];

  return jsonResponse({
    health: {
      date:              vals[0],
      pull_timestamp:    vals[1],
      sleep_start:       vals[2],
      sleep_end:         vals[3],
      sleep_duration:    vals[4],
      checkin_ts:        vals[5],
      check_in_complete: vals[7],
      hrv:               vals[8],
      resting_hr:        vals[9],
      resp_rate:         vals[10],
      blood_ox:          vals[11],
      cardio_recovery:   vals[12],
      steps:             vals[13],
      flights:           vals[14],
      active_energy:     vals[15],
      mets:              vals[16],
      workout_detected:  vals[17],
      workout_type:      vals[18],
      workout_start:     vals[19],
      workout_end:       vals[20],
      workout_duration:  vals[21],
      stand_hours:       vals[22],
      vo2_max:           vals[23],
      body_weight:       vals[24],
      body_fat:          vals[25],
      bmi:               vals[26],
      athlytic:          vals[27],
      sleep_quality:     vals[28],
      mood:              vals[29],
      water:             vals[30],
      hrv_vs_baseline:   vals[31],
      hrv_pct_baseline:  vals[32],
      steps_tier_pts:    vals[33],
      energy_pts:        vals[34],
      stand_pts:         vals[35],
      alcohol_free_yday: vals[36],
      weekly_units:      vals[37],
      af_days_last7:     vals[38],
      rec_bonus:         vals[39],
      rec_penalty:       vals[40],
      rec_score:         vals[41],
      notes:             vals[42],
    }
  });
}

function serveHistory(days) {
  const ws      = getSheet(SHEETS.STAT_HISTORY);
  const lastRow = lastDataRow(ws);
  if (lastRow < 3) return jsonResponse({ history: [] });

  const startRow = Math.max(3, lastRow - days + 1);
  const numRows  = lastRow - startRow + 1;
  const data     = ws.getRange(startRow, 1, numRows, 12).getValues();

  const history = data
    .filter(row => row[0] !== "")
    .map(row => ({
      date:          row[0],
      str:           row[2],
      end:           row[3],
      rec:           row[4],
      int:           row[5],
      eq:            row[6],
      sov:           row[7],
      builder_level: row[8],
      builder_title: row[9],
    }));

  return jsonResponse({ history: history });
}

function serveTasks() {
  const ws      = getSheet(SHEETS.TASKS_MASTER);
  const lastRow = lastDataRow(ws);
  if (lastRow < 3) return jsonResponse({ tasks: [] });

  const data  = ws.getRange(3, 1, lastRow - 2, 16).getValues();
  const tasks = data
    .filter(row => row[0] !== "")
    .map(row => ({
      task_id:         row[0],
      domain:          row[1],
      task_name:       row[2],
      type:            row[3],
      due_date:        row[4],
      stat_primary:    row[5],
      stat_secondary:  row[6],
      points_on_time:  row[7],
      points_late:     row[8],
      decay_trigger:   row[9],
      decay_pts_day:   row[10],
      status:          row[11],
      completion_date: row[12],
      days_overdue:    row[13],
      decay_total:     row[14],
      effective_pts:   row[15],
    }));

  return jsonResponse({ tasks: tasks });
}

function serveAlcoholWeek() {
  const ws      = getSheet(SHEETS.ALCOHOL_SESSIONS);
  const lastRow = lastDataRow(ws);
  if (lastRow < 3) return jsonResponse({ sessions: [] });

  const data   = ws.getRange(3, 1, lastRow - 2, 17).getValues();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  const sessions = data
    .filter(row => row[0] !== "" && new Date(row[1]) >= cutoff)
    .map(row => ({
      session_id:     row[0],
      date:           row[1],
      drink_ts:       row[2],
      session_open:   row[3],
      session_close:  row[4],
      drink_type:     row[5],
      volume_ml:      row[6],
      abv_pct:        row[7],
      pure_alcohol_g: row[8],
      units:          row[9],
      hours_since:    row[10],
      running_units:  row[11],
      bac_at_log:     row[12],
      peak_bac:       row[13],
      session_units:  row[14],
      rec_penalty:    row[15],
      notes:          row[16],
    }));

  return jsonResponse({ sessions: sessions });
}

function servePendingCheckin() {
  const ws    = getSheet(SHEETS.DAILY_HEALTH);
  const today = todayISO();
  const row   = findRow(ws, 1, today);

  if (row === -1) return jsonResponse({ checkin_complete: false, shortcut_done: false });

  const status = String(ws.getRange(row, COL.DAILY_HEALTH.CHECK_IN_COMPLETE).getValue());
  return jsonResponse({
    checkin_complete: status === "YES",
    shortcut_done:    status === "YES" || status === "SHORTCUT_DONE",
  });
}

// action=stat_trend&days=30
// Returns the last N rows of STAT_HISTORY as a flat array for
// client-side sparkline rendering.
function handleStatTrend(e) {
  var days = (e.parameter.days) ? parseInt(e.parameter.days, 10) : 30;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName('STAT_HISTORY');
  var data = sh.getDataRange().getValues();

  // Row 1 = headers. Columns per the sheet reference:
  // A DATE, B CALCULATED_AT, C STR, D END, E REC, F INT, G EQ, H SOV
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var rawDate = data[i][0];
    if (!rawDate) continue;
    rows.push({
      date: Utilities.formatDate(new Date(rawDate), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      str: data[i][2],
      end: data[i][3],
      rec: data[i][4],
      int: data[i][5],
      eq:  data[i][6],
      sov: data[i][7]
    });
  }

  rows = rows.slice(-days);

  return ContentService.createTextOutput(JSON.stringify({ history: rows }))
    .setMimeType(ContentService.MimeType.JSON);
}

// action=completions_heatmap&days=56
// Returns raw {date, domain} pairs from GOAL_COMPLETIONS for the
// last N days. Aggregation into the domain x day grid happens
// client-side, so this stays a thin, cacheable read.
function handleCompletionsHeatmap(e) {
  var days = (e.parameter.days) ? parseInt(e.parameter.days, 10) : 56;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName('GOAL_COMPLETIONS');
  var data = sh.getDataRange().getValues();

  // Row 1 = headers. Columns per the sheet reference:
  // A LOG_ID, B DATE, C COMPLETION_TS, D DOMAIN, ...
  var cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var rawDate = data[i][1];
    if (!rawDate) continue;
    var dateObj = new Date(rawDate);
    if (dateObj < cutoff) continue;
    rows.push({
      date: Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      domain: data[i][3]
    });
  }

  return ContentService.createTextOutput(JSON.stringify({ completions: rows }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── SCHEDULED FUNCTIONS ───────────────────────────────────────

function dailyRecalc() {
  const today = todayISO();
  const now   = nowISO();

  closeOpenSessions(today, now);

  const ws4      = getSheet(SHEETS.STAT_HISTORY);
  const existing = findRow(ws4, 1, today);
  if (existing === -1) {
    const newRow = lastDataRow(ws4) + 1;
    // PATCH v6.1: real Date, not string — this is the column MAXIFS/DAYS
    // and the DAILY_HEALTH VLOOKUP both key off.
    ws4.getRange(newRow, 1).setValue(toSheetDate(today));
    ws4.getRange(newRow, 1).setNumberFormat('yyyy-mm-dd');
    ws4.getRange(newRow, 2).setValue(new Date());
    ws4.getRange(newRow, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');

    // PATCH v6.1: propagate the full calculated block (STR..DECAY_FLAGS,
    // columns C:Z) from the row above. Without this, every new daily
    // snapshot was blank except DATE and CALCULATED_AT.
    copyFormulaRowDown(ws4, newRow, [
      'C','D','E','F','G','H','I','J','K','L','M',
      'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
      // v6.4: per-task weekly decay columns (Option B) — no-ops
      // harmlessly until installPerTaskWeeklyDecayColumns_() runs.
      'AA','AB'
    ]);

    SpreadsheetApp.flush();
    Logger.log("STAT_HISTORY row appended: " + today + " at row " + newRow);
  } else {
    ws4.getRange(existing, 2).setValue(new Date());
    ws4.getRange(existing, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    SpreadsheetApp.flush();
    Logger.log("STAT_HISTORY row updated: " + today + " at row " + existing);
  }

  Logger.log("dailyRecalc complete: " + now);
}

function closeOpenSessions(date, closeTime) {
  const ws      = getSheet(SHEETS.ALCOHOL_SESSIONS);
  const lastRow = lastDataRow(ws);
  if (lastRow < 3) return;

  const closeCol = COL.ALCOHOL_SESSIONS.SESSION_CLOSE;
  const data     = ws.getRange(3, 1, lastRow - 2, 17).getValues();

  let closed = 0;
  data.forEach((row, i) => {
    if (String(row[closeCol - 1]) === "OPEN") {
      ws.getRange(i + 3, closeCol).setValue(closeTime);
      closed++;
    }
  });

  Logger.log("Closed " + closed + " open alcohol session rows at " + closeTime);
}

function midnightCleanup() {
  dailyRecalc();
  Logger.log("midnightCleanup run as backup.");
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("dailyRecalc")
    .timeBased().atHour(11).everyDays(1)
    .inTimezone("Africa/Johannesburg").create();

  ScriptApp.newTrigger("midnightCleanup")
    .timeBased().atHour(23).everyDays(1)
    .inTimezone("Africa/Johannesburg").create();

  Logger.log("Triggers installed: dailyRecalc @ 11:00, midnightCleanup @ 23:00 SAST");
}


// ── TEST FUNCTIONS ────────────────────────────────────────────

function testPing() {
  const url = 'https://script.google.com/macros/s/AKfycbwZKD79oImowJl0swveHiba5VYWxzPUBHWg1wvzd48dhoWxqnT0npKaM6koHsm_KkSfyA/exec';
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ action: 'ping' }),
    followRedirects: true,
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  Logger.log('Status: ' + response.getResponseCode());
  Logger.log('Body: ' + response.getContentText());
}

function testHAELocal() {
  const fakePayload = {
    data: {
      metrics: [
        { name: 'step_count', units: 'count', data: [
          { date: '2026-06-29 08:00:00 +0200', qty: 500, source: "Kampamba's SE3" },
          { date: '2026-06-29 09:00:00 +0200', qty: 300, source: "Kampamba's SE3" }
        ]},
        { name: 'resting_heart_rate', units: 'count/min', data: [
          { date: '2026-06-29 00:04:00 +0200', qty: 69, source: "Kampamba's SE3" }
        ]},
        { name: 'sleep_analysis', units: 'hr', data: [
          { date: '2026-06-29 00:00:00 +0200',
            totalSleep: 8.24,
            sleepStart: '2026-06-28 21:02:00 +0200',
            sleepEnd:   '2026-06-29 07:34:28 +0200' }
        ]},
        { name: 'active_energy', units: 'kJ', data: [
          { date: '2026-06-29 10:00:00 +0200', qty: 1800, source: "Kampamba's SE3" }
        ]},
        { name: 'apple_stand_hour', units: 'count', data: [
          { date: '2026-06-29 08:00:00 +0200', qty: 1, source: "" },
          { date: '2026-06-29 09:00:00 +0200', qty: 1, source: "" },
          { date: '2026-06-29 10:00:00 +0200', qty: 1, source: "" }
        ]},
        { name: 'apple_exercise_time', units: 'min', data: [
          { date: '2026-06-29 09:02:00 +0200', qty: 1, source: "Kampamba's SE3" },
          { date: '2026-06-29 09:03:00 +0200', qty: 1, source: "Kampamba's SE3" }
        ]}
      ]
    }
  };

  const result = handleHealthAutoExport(fakePayload);
  Logger.log(JSON.stringify(result));
}

function testPost() {
  const fakeBody = {
    action:           "shortcut_health",
    date:             todayISO(),
    pull_timestamp:   nowISO(),
    sleep_start:      todayISO() + " 22:45:00",
    sleep_end:        todayISO() + " 06:00:00",
    hrv:              61,
    resting_hr:       53,
    resp_rate:        14,
    blood_ox:         99,
    cardio_recovery:  45,
    steps:            9300,
    flights:          15,
    active_energy:    480,
    mets:             4.8,
    workout_detected: false,
    workout_type:     "",
    workout_start:    "",
    workout_end:      "",
    stand_hours:      11,
    vo2_max:          null,
    body_weight:      null,
    body_fat:         null,
    bmi:              null,
  };
  const result = handleShortcutHealth(fakeBody);
  Logger.log("testPost result: " + JSON.stringify(result));
}

function testCheckin() {
  const fakeBody = {
    action:         "checkin",
    date:           todayISO(),
    athlytic_score: 74,
    sleep_quality:  4,
    mood:           7,
    water:          2.8,
    notes:          "Test check-in",
    completions: {
      msc_session:       true,
      ntcsa_deliverable: false,
      journaling:        true,
      mentoring:         false,
      financial_move:    false,
      maz_time:          true,
      hustle_session:    false,
      reading:           false,
    }
  };
  const result = handleCheckin(fakeBody);
  Logger.log("testCheckin result: " + JSON.stringify(result));
}

function testWorkoutLocal() {
  const fakePayload = {
    data: {
      workouts: [
        {
          name: "Functional Strength Training",
          start: todayISO() + " 17:23:25 +0200",
          end:   todayISO() + " 17:53:06 +0200",
          duration: 1781.2,
          intensity: { qty: 6.057949197174629, units: "kcal/hr·kg" },
          activeEnergy: [
            { date: todayISO() + " 17:23:25 +0200", qty: 21.85, units: "kJ", source: "Kampamba's SE3" },
            { date: todayISO() + " 17:24:25 +0200", qty: 21.28, units: "kJ", source: "Kampamba's SE3" },
            { date: todayISO() + " 17:25:25 +0200", qty: 14.66, units: "kJ", source: "Kampamba's SE3" }
          ],
          activeEnergyBurned: { qty: 800.7, units: "kJ" },
          heartRate: { avg: { qty: 129.3, units: "count/min" }, min: { qty: 89 }, max: { qty: 166 } }
        }
      ]
    }
  };
  const result = handleHealthAutoExport(fakePayload);
  Logger.log(JSON.stringify(result));
}

function testSleepOnlyPayload() {
  // Simulates the 09:00 sleep automation firing the morning after a sleep session.
  // Sleep started 22nd night → Apple assigns date "2026-06-23" → sleepStart is "2026-06-22"
  // Expected: finds existing 2026-06-22 row and writes only sleep columns into it.
  const yesterday = todayISO(); // use today for testing — adjust date manually if needed
  const fakePayload = {
    data: {
      metrics: [
        {
          name: 'sleep_analysis',
          units: 'hr',
          data: [
            {
              date: yesterday + ' 00:00:00 +0200', // Apple assigns "today" as the date
              sleepStart: new Date(new Date().setDate(new Date().getDate() - 1))
                .toISOString().substring(0, 10) + ' 22:45:00 +0200', // started yesterday night
              sleepEnd:   yesterday + ' 06:30:00 +0200',
              totalSleep: 7.25,
              deep: 0.9, rem: 1.8, core: 4.5, awake: 0.8,
              source: "Kampamba's SE3"
            }
          ]
        }
      ]
    }
  };
  const result = handleHealthAutoExport(fakePayload);
  Logger.log('testSleepOnlyPayload: ' + JSON.stringify(result));
}

function readDebugPayload() {
  const ss      = SpreadsheetApp.openById(SHEET_ID);
  const debug   = ss.getSheetByName('Debug');
  const lastRow = debug.getLastRow();
  const ts      = debug.getRange(lastRow, 1).getValue();
  const raw     = debug.getRange(lastRow, 2).getValue();
  Logger.log('Timestamp: ' + ts);
  Logger.log('Payload: ' + raw);
}


// ── ONE-TIME REPAIR FUNCTIONS ─────────────────────────────────
// These three are diagnostic/repair tools, not part of normal request
// routing — run them manually from the Apps Script editor (select the
// function in the dropdown, click Run), not via doGet/doPost.

// PART 1: seed row 3 with the correct J:M formula pattern. The live
// sheet had no working formula anywhere in J:M — every row from 3 down
// was plain values. This writes the original design pattern (recovered
// from the xlsx backup) into row 3 only, giving
// repairGoalCompletionFormulas() a real anchor to propagate from.
function seedAndRepairGoalCompletionFormulas() {
  const ws = getSheet(SHEETS.GOAL_COMPLETIONS);
  const lastRow = lastDataRow(ws);
  if (lastRow < 3) {
    Logger.log('No data rows present — nothing to seed.');
    return;
  }

  ws.getRange('J3').setFormula(
    '=IF(E3<>"",IF(ISNUMBER(MATCH(E3,TASKS_MASTER!$A:$A,0)),IF(B3<=INDEX(TASKS_MASTER!$E:$E,MATCH(E3,TASKS_MASTER!$A:$A,0)),"YES","NO"),"N/A"),"")'
  );
  ws.getRange('K3').setFormula(
    '=IF(E3<>"",IF(ISNUMBER(MATCH(E3,TASKS_MASTER!$A:$A,0)),IF(J3="YES",INDEX(TASKS_MASTER!$H:$H,MATCH(E3,TASKS_MASTER!$A:$A,0)),INDEX(TASKS_MASTER!$I:$I,MATCH(E3,TASKS_MASTER!$A:$A,0))),0),0)'
  );
  ws.getRange('L3').setFormula(
    '=IF(AND(I3<>"",E3<>""),IF(J3="YES",10,8),0)'
  );
  ws.getRange('M3').setFormula(
    '=IF(G3="RECURRING","YES","NO")'
  );

  SpreadsheetApp.flush();
  Logger.log('Row 3 seeded with J:M formulas.');

  // Now propagate row 3's formulas forward through every subsequent row.
  repairGoalCompletionFormulas();
}

function repairGoalCompletionFormulas() {
  const ws = getSheet(SHEETS.GOAL_COMPLETIONS);
  const lastRow = lastDataRow(ws);
  if (lastRow < 3) {
    Logger.log('No data rows to repair.');
    return;
  }

  let anchorRow = -1;
  for (let r = 3; r <= lastRow; r++) {
    if (ws.getRange('J' + r).getFormula()) anchorRow = r;
  }
  if (anchorRow === -1) {
    Logger.log('No anchor row with a working formula found — run seedAndRepairGoalCompletionFormulas() instead.');
    return;
  }

  const cols = ['J', 'K', 'L', 'M'];
  const anchorFormulas = {};
  cols.forEach(col => { anchorFormulas[col] = ws.getRange(col + anchorRow).getFormula(); });

  let repaired = 0;
  for (let r = anchorRow + 1; r <= lastRow; r++) {
    cols.forEach(col => {
      if (!ws.getRange(col + r).getFormula()) {
        ws.getRange(col + r).setFormula(anchorFormulas[col]);
      }
    });
    repaired++;
  }

  SpreadsheetApp.flush();
  Logger.log('Repaired ' + repaired + ' rows (rows ' + (anchorRow + 1) + '–' + lastRow + ') using anchor row ' + anchorRow + '.');
}

// Same pattern as repairGoalCompletionFormulas(), but deliberately does
// NOT seed a formula if no anchor is found — the BAC/units calculation
// chain (pure_alcohol_g, units, hours_since, running_units, bac_at_log,
// peak_bac, session_units, rec_penalty) is too specific to guess at
// safely. If this logs "no anchor found", you'll need to manually
// restore I3:P3 (or whichever row last had working formulas) from a
// backup, then re-run this. STILL UNRUN as of this handoff — status
// of ALCOHOL_SESSIONS' formula chain is unconfirmed.
function repairAlcoholSessionFormulas() {
  const ws = getSheet(SHEETS.ALCOHOL_SESSIONS);
  const lastRow = lastDataRow(ws);
  if (lastRow < 3) {
    Logger.log('No data rows to repair.');
    return;
  }

  let anchorRow = -1;
  for (let r = 3; r <= lastRow; r++) {
    if (ws.getRange('I' + r).getFormula()) anchorRow = r;
  }
  if (anchorRow === -1) {
    Logger.log('No anchor row with a working formula found in ALCOHOL_SESSIONS I:P. ' +
      'These columns need to be restored manually (from a backup or by rewriting ' +
      'the BAC/units formulas) before this can propagate anything.');
    return;
  }

  const cols = ['I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'];
  const anchorFormulas = {};
  cols.forEach(col => { anchorFormulas[col] = ws.getRange(col + anchorRow).getFormula(); });

  let repaired = 0;
  for (let r = anchorRow + 1; r <= lastRow; r++) {
    cols.forEach(col => {
      if (!ws.getRange(col + r).getFormula()) {
        ws.getRange(col + r).setFormula(anchorFormulas[col]);
      }
    });
    repaired++;
  }

  SpreadsheetApp.flush();
  Logger.log('Repaired ' + repaired + ' rows (rows ' + (anchorRow + 1) + '–' + lastRow + ') using anchor row ' + anchorRow + '.');
}


// ── v6.4 ONE-TIME TOOLS — run manually from the Apps Script editor,
// read the execution log, then leave them alone. Each is idempotent.
// ─────────────────────────────────────────────────────────────

// BUG 3 repair: every task added since deploy has a frozen static
// points_late. Re-link rows whose static value equals exactly
// ROUND(H*0.75,0) — value-preserving, zero risk. Rows where the static
// value DIFFERS from 75% are treated as intentional overrides: logged,
// never touched. Run once, read the log, done.
function repairPointsLateFormulas_() {
  var ws = getSheet(SHEETS.TASKS_MASTER);
  var last = lastDataRow(ws);
  if (last < 3) { Logger.log('No task rows.'); return; }
  var relinked = 0, overrides = [], skippedFormula = 0, skippedEmpty = 0;
  for (var r = 3; r <= last; r++) {
    if (String(ws.getRange(r, 1).getValue()).trim() === '') continue;
    var iCell = ws.getRange(r, 9);
    if (iCell.getFormula()) { skippedFormula++; continue; }   // already live
    var h = Number(ws.getRange(r, 8).getValue());
    var iVal = iCell.getValue();
    if (iVal === '' || iVal === null) { // blank → safe to install formula
      iCell.setFormula(pointsLateFormula_(r));
      relinked++;
      continue;
    }
    if (!isNaN(h) && Number(iVal) === Math.round(h * 0.75)) {
      iCell.setFormula(pointsLateFormula_(r));
      relinked++;
    } else {
      overrides.push(ws.getRange(r, 1).getValue() + ' (row ' + r + '): I=' + iVal + ' vs 75% of H=' + h);
    }
  }
  SpreadsheetApp.flush();
  Logger.log('repairPointsLateFormulas_: relinked=' + relinked +
    ', already-formula=' + skippedFormula +
    ', intentional overrides left untouched=' + overrides.length +
    (overrides.length ? '\n  ' + overrides.join('\n  ') : ''));
}

// §1 item 5 — HG3 split (Option B, migration half). Adds HG3.1–3.4
// with the boss-confirmed point economy (4/4/4/3 on-time, 3/3/3/3
// weekly decay — DO NOT rebalance), points_late as live formula, and
// retires the old HG3 bucket (status CANCELLED — the convention both
// frontends already filter out of pending lists). Idempotent: existing
// IDs are skipped.
function migrateHG3Split_() {
  var SPLIT = [
    { task_id: 'HG3.1', task_name: 'Push Day',                 stat_primary: 'STR', points_on_time: 4, decay_pts_day: 3 },
    { task_id: 'HG3.2', task_name: 'Pull Day',                 stat_primary: 'STR', points_on_time: 4, decay_pts_day: 3 },
    { task_id: 'HG3.3', task_name: 'Leg Day',                  stat_primary: 'STR', points_on_time: 4, decay_pts_day: 3 },
    { task_id: 'HG3.4', task_name: 'Run 5K',                   stat_primary: 'END', points_on_time: 3, decay_pts_day: 3 },
  ];
  var ws = getSheet(SHEETS.TASKS_MASTER);
  SPLIT.forEach(function (t) {
    if (findTaskRow_(ws, t.task_id) !== -1) {
      Logger.log(t.task_id + ' already exists — skipped.');
      return;
    }
    var res = handleAddTask({
      task_id: t.task_id,
      domain: 'HEALTH',
      task_name: t.task_name,
      type: 'RECURRING',
      due_date: 'WEEKLY',
      stat_primary: t.stat_primary,
      points_on_time: t.points_on_time,
      // points_late intentionally omitted → live 75% formula (BUG 3)
      decay_trigger: 'Not completed this calendar week (Mon–Sun)',
      decay_pts_day: t.decay_pts_day,
      status: 'PENDING',
    });
    Logger.log(t.task_id + ': ' + JSON.stringify(res));
  });
  var hg3 = findTaskRow_(ws, 'HG3');
  if (hg3 !== -1) {
    var cur = String(ws.getRange(hg3, 12).getValue()).toUpperCase();
    if (cur !== 'CANCELLED' && cur !== 'COMPLETE') {
      ws.getRange(hg3, 12).setValue('CANCELLED');
      Logger.log('HG3 retired (status → CANCELLED).');
    } else {
      Logger.log('HG3 already ' + cur + ' — left as-is.');
    }
  } else {
    Logger.log('HG3 not found — nothing to retire.');
  }
  SpreadsheetApp.flush();
}

// §1 item 5 — Option B, decay half. Adds two STAT_HISTORY columns:
//   AA (27) STR_TASK_DECAY_WKLY — Monday close-out of the just-ended
//           Mon–Sun week: −3 for EACH of HG3.1/3.2/3.3 with zero
//           GOAL_COMPLETIONS entries in that week.
//   AB (28) END_TASK_DECAY_WKLY — same, HG3.4 only.
// N3's stat-wide inactivity net is deliberately UNCHANGED — it stays
// as the safety net for STR work outside the split, and historical
// decay rows are untouched (the new columns are additive).
//
// The installer also tries to wire the new terms into C3 (STR) and
// D3 (END) by exact-suffix replacement of the trailing decay term
// ("+N3))" → "+N3+AA3))", "+O3))" → "+O3+AB3))"). If the live formulas
// have drifted from that shape, it does NOT guess — it logs the manual
// one-line edit instead (same discipline as the v6.1 N:R note).
// After row 3 is correct, dailyRecalc's C:AB propagation carries both
// columns forward automatically.
function installPerTaskWeeklyDecayColumns_() {
  var ws = getSheet(SHEETS.STAT_HISTORY);
  var last = lastDataRow(ws);

  ws.getRange(2, 27).setValue('STR_TASK_DECAY_WKLY');
  ws.getRange(2, 28).setValue('END_TASK_DECAY_WKLY');

  function weeklyMissTerm(row, taskId, pts) {
    return 'IF(COUNTIFS(GOAL_COMPLETIONS!$E:$E,"' + taskId + '",' +
      'GOAL_COMPLETIONS!$B:$B,">="&A' + row + '-7,' +
      'GOAL_COMPLETIONS!$B:$B,"<"&A' + row + ')=0,-' + pts + ',0)';
  }
  function aaFormula(row) {
    return '=IF(A' + row + '="","",IF(WEEKDAY(A' + row + ',2)<>1,0,' +
      weeklyMissTerm(row, 'HG3.1', 3) + '+' +
      weeklyMissTerm(row, 'HG3.2', 3) + '+' +
      weeklyMissTerm(row, 'HG3.3', 3) + '))';
  }
  function abFormula(row) {
    return '=IF(A' + row + '="","",IF(WEEKDAY(A' + row + ',2)<>1,0,' +
      weeklyMissTerm(row, 'HG3.4', 3) + '))';
  }

  for (var r = 3; r <= Math.max(3, last); r++) {
    ws.getRange(r, 27).setFormula(aaFormula(r));
    ws.getRange(r, 28).setFormula(abFormula(r));
  }
  Logger.log('AA/AB formulas installed rows 3..' + Math.max(3, last));

  // Wire into the stat columns — exact-suffix surgery only.
  var c3 = ws.getRange(3, 3).getFormula();
  if (c3.indexOf('AA3') !== -1) {
    Logger.log('C3 already references AA3 — skipped.');
  } else if (c3.slice(-6) === '+N3))') {
    ws.getRange(3, 3).setFormula(c3.slice(0, -6) + '+N3+AA3))');
    Logger.log('C3 patched: +N3)) → +N3+AA3))');
  } else {
    Logger.log('MANUAL STEP — C3 shape unexpected. Append "+AA3" inside ' +
      'the MIN(100,...) sum of STAT_HISTORY!C3, next to the +N3 term.');
  }
  var d3 = ws.getRange(3, 4).getFormula();
  if (d3.indexOf('AB3') !== -1) {
    Logger.log('D3 already references AB3 — skipped.');
  } else if (d3.slice(-6) === '+O3))') {
    ws.getRange(3, 4).setFormula(d3.slice(0, -6) + '+O3+AB3))');
    Logger.log('D3 patched: +O3)) → +O3+AB3))');
  } else {
    Logger.log('MANUAL STEP — D3 shape unexpected. Append "+AB3" inside ' +
      'the MIN(100,...) sum of STAT_HISTORY!D3, next to the +O3 term.');
  }

  // Rows below 3 inherit whatever row 3 now has on the next dailyRecalc
  // append; existing historical rows are deliberately NOT rewritten.
  SpreadsheetApp.flush();
}


// ── v6.4 TEST FUNCTIONS — run against the LIVE sheet from the Apps
// Script editor. They create then delete their own fixtures; each logs
// PASS/FAIL per Definition-of-Done step. Ground truth = direct sheet
// reads, never the API response alone.
// ─────────────────────────────────────────────────────────────

function assert_(cond, label) {
  Logger.log((cond ? 'PASS — ' : 'FAIL — ') + label);
  return !!cond;
}

// DoD 1 — auto-ID generation, dotted-ID immunity, verified against the
// sheet's column A directly.
function testAddTaskIdGen() {
  var ws = getSheet(SHEETS.TASKS_MASTER);
  var expected = nextTaskId_(ws, 'HEALTH');
  assert_(/^HG\d+$/.test(expected) && expected.indexOf('.') === -1,
    'predicted next HEALTH ID is integer-form: ' + expected);

  var res = handleAddTask({ domain: 'HEALTH', task_name: '__TEST idgen', type: 'MILESTONE' });
  assert_(res.task_id === expected, 'response ID matches prediction: ' + res.task_id);

  var row = findTaskRow_(ws, expected);
  assert_(row !== -1, 'ID exists in TASKS_MASTER!A (direct read), row ' + row);

  // case/whitespace collision must be caught
  var dup = handleAddTask({ task_id: ' ' + expected.toLowerCase() + ' ', domain: 'HEALTH', task_name: '__TEST dup' });
  assert_(dup.status === 'error', 'case/whitespace duplicate rejected: ' + JSON.stringify(dup));

  handleDeleteTask({ task_id: expected }); // cleanup
  Logger.log('testAddTaskIdGen done (fixture deleted).');
}

// DoD 1 concurrency — two back-to-back adds must yield distinct IDs.
// True simultaneity needs two external callers (curl x2); this is the
// closest single-runtime approximation and still exercises the lock
// acquire/release path twice.
function testAddTaskIdGenSequential() {
  var ws = getSheet(SHEETS.TASKS_MASTER);
  var a = handleAddTask({ domain: 'HEALTH', task_name: '__TEST seq A', type: 'MILESTONE' });
  var b = handleAddTask({ domain: 'HEALTH', task_name: '__TEST seq B', type: 'MILESTONE' });
  assert_(a.task_id && b.task_id && a.task_id !== b.task_id,
    'distinct IDs: ' + a.task_id + ' / ' + b.task_id);
  assert_(findTaskRow_(ws, a.task_id) !== -1 && findTaskRow_(ws, b.task_id) !== -1,
    'both rows exist in the sheet');
  handleDeleteTask({ task_id: b.task_id });
  handleDeleteTask({ task_id: a.task_id });
  Logger.log('testAddTaskIdGenSequential done (fixtures deleted). ' +
    'For the true two-tab race, fire two curl add_task calls in parallel.');
}

// DoD 2 — cadence guard: RECURRING keeps its cadence STRING in col E,
// mismatches are rejected, no partial writes.
function testCadenceGuard() {
  var ws = getSheet(SHEETS.TASKS_MASTER);
  var res = handleAddTask({ domain: 'HEALTH', task_name: '__TEST cadence',
    type: 'RECURRING', due_date: 'weekly' });
  var id = res.task_id;
  var row = findTaskRow_(ws, id);
  var e = ws.getRange(row, 5).getValue();
  assert_(e === 'WEEKLY' && typeof e === 'string',
    'E stores literal string WEEKLY (got ' + typeof e + ' "' + e + '")');

  // no-change save must not mutate E
  handleUpdateTask({ task_id: id, task_name: '__TEST cadence renamed' });
  e = ws.getRange(row, 5).getValue();
  assert_(e === 'WEEKLY', 'E unchanged after unrelated update: "' + e + '"');

  // date on RECURRING → reject
  var bad1 = handleUpdateTask({ task_id: id, due_date: '2026-08-01' });
  assert_(bad1.status === 'error', 'date on RECURRING rejected: ' + JSON.stringify(bad1));
  assert_(ws.getRange(row, 5).getValue() === 'WEEKLY', 'E survived the rejected write');

  // cadence on MILESTONE → reject
  var bad2 = handleAddTask({ domain: 'HEALTH', task_name: '__TEST bad',
    type: 'MILESTONE', due_date: 'WEEKLY' });
  assert_(bad2.status === 'error', 'cadence on MILESTONE rejected: ' + JSON.stringify(bad2));

  // type flip RECURRING → MILESTONE with a proper date → accepted, real date
  handleUpdateTask({ task_id: id, type: 'MILESTONE', due_date: '2026-08-01' });
  e = ws.getRange(row, 5).getValue();
  assert_(e instanceof Date, 'after flip to MILESTONE, E is a real Date: ' + e);

  handleDeleteTask({ task_id: id });
  Logger.log('testCadenceGuard done (fixture deleted).');
}

// DoD 3 — points_late formula inheritance vs static override.
function testPointsLateFormula() {
  var ws = getSheet(SHEETS.TASKS_MASTER);

  // untouched → live formula
  var a = handleAddTask({ domain: 'HEALTH', task_name: '__TEST plate A',
    type: 'MILESTONE', points_on_time: 8 });
  var rowA = findTaskRow_(ws, a.task_id);
  var fA = ws.getRange(rowA, 9).getFormula();
  assert_(fA === '=ROUND(H' + rowA + '*0.75,0)', 'col I is live formula: ' + fA);
  handleUpdateTask({ task_id: a.task_id, points_on_time: 12 });
  assert_(Number(ws.getRange(rowA, 9).getValue()) === 9,
    'formula recalculated after H edit (12*0.75=9): ' + ws.getRange(rowA, 9).getValue());

  // explicit override → static, immune to later H edits
  var b = handleAddTask({ domain: 'HEALTH', task_name: '__TEST plate B',
    type: 'MILESTONE', points_on_time: 10, points_late: 5, points_late_override: true });
  var rowB = findTaskRow_(ws, b.task_id);
  assert_(ws.getRange(rowB, 9).getFormula() === '' && Number(ws.getRange(rowB, 9).getValue()) === 5,
    'override wrote static 5, no formula');
  handleUpdateTask({ task_id: b.task_id, points_on_time: 20 });
  assert_(Number(ws.getRange(rowB, 9).getValue()) === 5, 'static survives H edit');

  // explicit clear → formula restored
  handleUpdateTask({ task_id: b.task_id, points_late: '' });
  assert_(ws.getRange(rowB, 9).getFormula() === '=ROUND(H' + rowB + '*0.75,0)',
    'blank points_late restored the 75% auto-link');

  handleDeleteTask({ task_id: b.task_id });
  handleDeleteTask({ task_id: a.task_id });
  Logger.log('testPointsLateFormula done (fixtures deleted).');
}

// DoD 4 — decay columns J:K persist through a serveTasks round-trip.
function testDecayColumnsRoundTrip() {
  var ws = getSheet(SHEETS.TASKS_MASTER);
  var a = handleAddTask({ domain: 'HEALTH', task_name: '__TEST decay',
    type: 'MILESTONE' });
  handleUpdateTask({ task_id: a.task_id,
    decay_trigger: 'No session 5+ days', decay_pts_day: 2 });
  var row = findTaskRow_(ws, a.task_id);
  assert_(ws.getRange(row, 10).getValue() === 'No session 5+ days', 'J persisted (direct read)');
  assert_(Number(ws.getRange(row, 11).getValue()) === 2, 'K persisted (direct read)');

  var served = JSON.parse(serveTasks().getContent());
  var t = (served.tasks || []).filter(function (x) { return x.task_id === a.task_id; })[0];
  assert_(t && t.decay_trigger === 'No session 5+ days' && Number(t.decay_pts_day) === 2,
    'serveTasks round-trip returns both values');

  handleDeleteTask({ task_id: a.task_id });
  Logger.log('testDecayColumnsRoundTrip done (fixture deleted).');
}

// Convenience: DoD steps 1–4 in order, stop-on-first-failure is manual
// (read the log top to bottom). Step 5 (regression) = run testPing,
// testHAELocal, testWorkoutLocal after this, then the sheet-rename
// degradation check from the spec.
function testStage1CloseOut() {
  testAddTaskIdGen();
  testAddTaskIdGenSequential();
  testCadenceGuard();
  testPointsLateFormula();
  testDecayColumnsRoundTrip();
}
