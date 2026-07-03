/**
 * BUILDER OS — per-fork configuration.
 * Copy this file to config.js and fill in your own values.
 * config.js IS committed in your fork (GitHub Pages must serve it),
 * but the upstream template only ships this example.
 * NOTE: the URL being public is fine — auth (Stage 1) is what protects
 * the endpoint, not secrecy.
 */
window.BUILDER_CONFIG = {
  // Your Apps Script web app /exec URL.
  // IMPORTANT: when redeploying, EDIT the existing deployment to a new
  // version (Deploy → Manage deployments → pencil icon → New version).
  // Never "New deployment" — that rotates this URL.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwZKD79oImowJl0swveHiba5VYWxzPUBHWg1wvzd48dhoWxqnT0npKaM6koHsm_KkSfyA/exec',

  // Google Identity Services OAuth Client ID (Web application type).
  // Create at console.cloud.google.com → APIs & Services → Credentials.
  // Authorized JavaScript origin: https://<you>.github.io
  // Leave as '' to run with auth DISABLED (pre-backend-deploy mode).
  GIS_CLIENT_ID: '',
};
