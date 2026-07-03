/**
 * BUILDER OS — auth.gs (Stage 1)
 * Two trust boundaries:
 *  1. Human requests (dashboard) → Google Identity Services ID token,
 *     verified server-side against tokeninfo, email allowlist.
 *  2. Machine requests (Health Auto Export) → static HAE_SECRET,
 *     because HAE cannot do OAuth.
 *
 * SCRIPT PROPERTIES REQUIRED (File → Project Settings → Script Properties):
 *   ALLOWED_EMAIL  = your Google account email
 *   GIS_CLIENT_ID  = the OAuth client id (must match config.js)
 *   HAE_SECRET     = long random string; add to HAE export URL as &key=...
 *   AUTH_ENABLED   = 'true' to enforce; anything else = pass-through
 *                    (lets you deploy code first, flip enforcement second)
 */

var AUTH_EXEMPT_ACTIONS = { }; // none — everything is gated
var HAE_ACTIONS = { 'healthAutoExport': true, 'hae': true }; // adjust to your router's action names

function requireAuth_(e, parsedBody) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('AUTH_ENABLED') !== 'true') return { ok: true, mode: 'disabled' };

  var action = (e && e.parameter && e.parameter.action) ||
               (parsedBody && parsedBody.action) || '';

  // Machine lane: HAE
  if (HAE_ACTIONS[action]) {
    var key = (e.parameter && e.parameter.key) || (parsedBody && parsedBody.key) || '';
    if (key && key === props.getProperty('HAE_SECRET')) return { ok: true, mode: 'hae' };
    return { ok: false, error: 'AUTH', detail: 'bad HAE key' };
  }

  // Human lane: GIS ID token
  var token = (e.parameter && e.parameter.id_token) || (parsedBody && parsedBody.id_token) || '';
  if (!token) return { ok: false, error: 'AUTH', detail: 'no token' };

  // Cache verified tokens (hash → email) to avoid a tokeninfo round trip
  // on every request. TTL 10 min; tokens themselves live ~60 min.
  var cache = CacheService.getScriptCache();
  var hash = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).substring(0, 40);
  var cached = cache.get('tok_' + hash);
  var allowed = props.getProperty('ALLOWED_EMAIL');
  if (cached && cached === allowed) return { ok: true, mode: 'gis', email: cached };

  var resp = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { ok: false, error: 'AUTH', detail: 'token invalid' };
  var info = JSON.parse(resp.getContentText());

  if (info.aud !== props.getProperty('GIS_CLIENT_ID'))
    return { ok: false, error: 'AUTH', detail: 'aud mismatch' };
  if (String(info.email_verified) !== 'true' || info.email !== allowed)
    return { ok: false, error: 'AUTH', detail: 'email not allowed' };

  cache.put('tok_' + hash, info.email, 600);
  return { ok: true, mode: 'gis', email: info.email };
}

/** Standard JSON response helper (safe to use if your Code.gs
 *  already has one under a different name). */
function authJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
