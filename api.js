/**
 * ============================================================
 * BUILDER OS — Shared API layer (Stage 1)
 * Used by index.html (desktop) and mobile.html.
 * Changes vs v1:
 *  - APPS_SCRIPT_URL now read from config.js (window.BUILDER_CONFIG)
 *  - GIS auth: every request carries an id_token when auth enabled
 *  - Single TIERS source of truth (real CONFIG ladder), shared by
 *    both frontends; hydrated live from backend getConfig
 *  - AVATAR_STAGES derived from tiers, no independent breakpoints
 * ============================================================
 */

const _CFG = window.BUILDER_CONFIG || {};
const APPS_SCRIPT_URL = _CFG.APPS_SCRIPT_URL || '';
if (!APPS_SCRIPT_URL) console.error('BUILDER OS: config.js missing or APPS_SCRIPT_URL unset.');

/* ── AUTH (Google Identity Services) ───────────────────────
   Disabled when GIS_CLIENT_ID is '' — requests go out bare,
   matching the pre-auth backend. Once auth.gs is live server-side,
   set GIS_CLIENT_ID and the overlay takes over. */
const AUTH = {
  enabled: !!_CFG.GIS_CLIENT_ID,
  token: null,
  init(onReady) {
    if (!this.enabled) { onReady && onReady(); return; }
    try { this.token = sessionStorage.getItem('builderos-idtok') || null; } catch (e) {}
    const boot = () => {
      google.accounts.id.initialize({
        client_id: _CFG.GIS_CLIENT_ID,
        callback: (resp) => {
          this.token = resp.credential;
          try { sessionStorage.setItem('builderos-idtok', this.token); } catch (e) {}
          hideAuthOverlay();
          onReady && onReady();
        },
        auto_select: true,
      });
      if (this.token) { onReady && onReady(); }
      else { showAuthOverlay(); }
    };
    if (window.google && google.accounts) boot();
    else {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = boot;
      s.onerror = () => { console.error('GIS library failed to load'); onReady && onReady(); };
      document.head.appendChild(s);
    }
  },
  expire() {
    this.token = null;
    try { sessionStorage.removeItem('builderos-idtok'); } catch (e) {}
    if (this.enabled) showAuthOverlay();
  },
};

function showAuthOverlay() {
  let ov = document.getElementById('authOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'authOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(6,10,15,0.92);backdrop-filter:blur(4px);';
    ov.innerHTML = '<div style="text-align:center;font-family:monospace;color:#cfe3f0;"><div style="font-size:13px;letter-spacing:0.15em;margin-bottom:14px;">BUILDER OS — SIGN IN</div><div id="gisBtn"></div></div>';
    document.body.appendChild(ov);
    if (window.google && google.accounts) {
      google.accounts.id.renderButton(document.getElementById('gisBtn'), { theme: 'filled_black', size: 'large', shape: 'pill' });
      google.accounts.id.prompt();
    }
  }
  ov.style.display = 'flex';
}
function hideAuthOverlay() {
  const ov = document.getElementById('authOverlay');
  if (ov) ov.style.display = 'none';
}

/* ── FETCH WRAPPERS ─────────────────────────────────────── */
/* v6.4 (backlog item): retry-once for transient Apps Script
   echo-redirect 404s / cold-start hiccups. GETs only — they're
   idempotent. POSTs are deliberately NOT retried: an add_task whose
   first attempt actually landed would duplicate the row (with a fresh
   auto-ID) on retry. If a POST fails ambiguously, refresh and read the
   sheet-backed state instead. */
async function apiGet(action, params, _retried) {
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  if (params) Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  if (AUTH.enabled && AUTH.token) url.searchParams.set('id_token', AUTH.token);
  try {
    const res = await fetch(url.toString());
    if (!res.ok && res.status >= 400 && !_retried) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data && data.error === 'AUTH') { AUTH.expire(); }
    return data;
  } catch (err) {
    if (_retried) throw err;
    await new Promise(r => setTimeout(r, 600));
    return apiGet(action, params, true);
  }
}

// text/plain content-type avoids a CORS preflight against the Apps
// Script endpoint — doPost still parses the body as JSON regardless.
async function apiPost(action, body) {
  const payload = { action, ...(body || {}) };
  if (AUTH.enabled && AUTH.token) payload.id_token = AUTH.token;
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data && data.error === 'AUTH') { AUTH.expire(); }
  return data;
}

/* ── STAT CONFIG (unchanged) ────────────────────────────── */
const STAT_KEYS = [
  { key: 'str', label: 'STR', decayKey: 'STR-DECAY' },
  { key: 'end', label: 'END', decayKey: 'END-DECAY' },
  { key: 'rec', label: 'REC', decayKey: null },
  { key: 'int', label: 'INT', decayKey: 'INT-DECAY' },
  { key: 'eq',  label: 'EQ',  decayKey: 'EQ-DECAY'  },
  { key: 'sov', label: 'SOV', decayKey: 'SOV-DECAY' },
];

/* ── TIER MODEL — single source of truth ────────────────────
   Fallback = REAL ladder from the CONFIG sheet (verified 2026-07-03):
   Apprentice 0–29 · Journeyman 30–49 · Craftsman 50–69 ·
   Architect 70–84 · Master Builder 85–94 · Sovereign 95–100.
   hydrateConfig() overwrites from the backend so a CONFIG-sheet edit
   propagates with zero frontend changes. */
let TIERS = [
  { name: 'APPRENTICE',     floor: 0  },
  { name: 'JOURNEYMAN',     floor: 30 },
  { name: 'CRAFTSMAN',      floor: 50 },
  { name: 'ARCHITECT',      floor: 70 },
  { name: 'MASTER BUILDER', floor: 85 },
  { name: 'SOVEREIGN',      floor: 95 },
];
let WEAKEST_PILLAR_CAP = 20; // any stat below this caps level at Journeyman (enforced backend-side)

function nextTierFor(index) {
  let cur = TIERS[0];
  for (const t of TIERS) if (index >= t.floor) cur = t;
  const i = TIERS.indexOf(cur);
  const nxt = TIERS[i + 1] || null;
  return { current: cur, next: nxt, ptsToNext: nxt ? Math.max(0, Math.ceil(nxt.floor - index)) : 0 };
}

/* ── AVATAR STAGES — derived from tiers, not independent ────
   5 art stages over 6 tiers: final form unlocks at MASTER BUILDER;
   Sovereign keeps stage 5 (hero-panel treatment reserved for v2). */
let AVATAR_STAGES = [];
function rebuildAvatarStages() {
  const floors = TIERS.slice(0, 5).map(t => t.floor); // first 5 tier floors
  AVATAR_STAGES = floors.map((f, i) => ({ minLevel: f, file: `assets/avatars/stage${i + 1}.png` }));
}
rebuildAvatarStages();

function getAvatarStage(level) {
  const lvl = Number(level) || 0;
  let chosen = AVATAR_STAGES[0];
  for (const s of AVATAR_STAGES) { if (lvl >= s.minLevel) chosen = s; }
  return chosen;
}

/* ── CONFIG HYDRATION ───────────────────────────────────── */
async function hydrateConfig() {
  try {
    const cfg = await apiGet('config');
    if (cfg && Array.isArray(cfg.tiers) && cfg.tiers.length) {
      TIERS = cfg.tiers.map(t => ({ name: String(t.name).toUpperCase(), floor: Number(t.floor) || 0 }));
      rebuildAvatarStages();
    }
    if (cfg && cfg.weakest_pillar_cap != null) WEAKEST_PILLAR_CAP = Number(cfg.weakest_pillar_cap);
    return cfg || null;
  } catch (e) { return null; } // fail-soft: fallback ladder stands
}
