/**
 * ============================================================
 * BUILDER OS — Shared API layer
 * Used by both builder_os_dashboard.html (desktop) and
 * builder_os_mobile.html (mobile). One file, one URL to update
 * if you ever redeploy to a brand new Apps Script URL.
 * ============================================================
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwZKD79oImowJl0swveHiba5VYWxzPUBHWg1wvzd48dhoWxqnT0npKaM6koHsm_KkSfyA/exec';

async function apiGet(action, params) {
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  if (params) Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  const res = await fetch(url.toString());
  return res.json();
}

// text/plain content-type avoids a CORS preflight against the Apps
// Script endpoint — doPost still parses the body as JSON regardless.
async function apiPost(action, body) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
}

// ── Shared stat config — same six keys, same decay flag names,
// used by both gauges (desktop) and stat chips (mobile).
const STAT_KEYS = [
  { key: 'str', label: 'STR', decayKey: 'STR-DECAY' },
  { key: 'end', label: 'END', decayKey: 'END-DECAY' },
  { key: 'rec', label: 'REC', decayKey: null },
  { key: 'int', label: 'INT', decayKey: 'INT-DECAY' },
  { key: 'eq',  label: 'EQ',  decayKey: 'EQ-DECAY'  },
  { key: 'sov', label: 'SOV', decayKey: 'SOV-DECAY' },
];

// ── Shared avatar stage config — same breakpoints/files on both
// screens so the character reads identically everywhere.
// Edit minLevel thresholds to match your real tier system.
const AVATAR_STAGES = [
  { minLevel: 0,  file: 'assets/avatars/stage1.png' },
  { minLevel: 20, file: 'assets/avatars/stage2.png' },
  { minLevel: 40, file: 'assets/avatars/stage3.png' },
  { minLevel: 60, file: 'assets/avatars/stage4.png' },
  { minLevel: 80, file: 'assets/avatars/stage5.png' },
];

function getAvatarStage(level) {
  const lvl = Number(level) || 0;
  let chosen = AVATAR_STAGES[0];
  for (const s of AVATAR_STAGES) { if (lvl >= s.minLevel) chosen = s; }
  return chosen;
}
