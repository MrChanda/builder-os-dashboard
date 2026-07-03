/**
 * BUILDER OS — config_api.gs (Stage 1)
 * Serves the CONFIG sheet to the frontend: tier ladder, pillar cap,
 * key targets. One source of truth — edit CONFIG, frontend follows.
 * Router: case 'config': return authJson_(handleGetConfig());
 */

function handleGetConfig() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('builder_config_v1');
  if (hit) return JSON.parse(hit);

  var sh = SpreadsheetApp.getActive().getSheetByName('CONFIG');
  var vals = sh.getDataRange().getValues();
  var kv = {};
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0] || '').trim();
    if (k) kv[k] = vals[i][1];
  }

  // Tier maxes from CONFIG → floors. Sovereign uses its explicit min.
  function n(x, fb) { var v = Number(x); return isNaN(v) ? fb : v; }
  var aMax = n(kv['Apprentice max'], 29), jMax = n(kv['Journeyman max'], 49),
      cMax = n(kv['Craftsman max'], 69),  arMax = n(kv['Architect max'], 84),
      mMax = n(kv['Master Builder max'], 94), sMin = n(kv['Sovereign min'], 95);

  var out = {
    tiers: [
      { name: 'Apprentice',     floor: 0 },
      { name: 'Journeyman',     floor: aMax + 1 },
      { name: 'Craftsman',      floor: jMax + 1 },
      { name: 'Architect',      floor: cMax + 1 },
      { name: 'Master Builder', floor: arMax + 1 },
      { name: 'Sovereign',      floor: sMin }
    ],
    weakest_pillar_cap: n(kv['Weakest Pillar Cap'], 20),
    pillar_scale: 100,
    targets: {
      steps: n(kv['Steps Daily Target'], 8000),
      water_l: n(kv['Water Daily Target (L)'], 1.7),
      sleep_hrs: n(kv['Sleep Duration Target (hrs)'], 7.5),
      active_kcal: n(kv['Active Energy Target (kcal)'], 500),
      stand_hours: n(kv['Stand Hours Target'], 8)
    },
    _cached_at: new Date().toISOString()
  };
  cache.put('builder_config_v1', JSON.stringify(out), 600); // 10 min
  return out;
}

function testGetConfig() { Logger.log(JSON.stringify(handleGetConfig(), null, 2)); }
