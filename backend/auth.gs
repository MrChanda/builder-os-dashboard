/**
 * BUILDER OS — auth.gs (Stage 1)
 * Two trust boundaries:
 *  1. Human requests (dashboard) → Google Identity Services ID token,
 *     verified server-side against tokeninfo, email allowlist.
 *  2. HAE automation requests → shared secret key, no Google account.
 *
 * Kill-switch: Script Property AUTH_ENABLED unset/false = pass-through
 * (everything behaves like v1, zero enforcement). Set to "true" only
 * after Script Properties + OAuth client are in place and verified.
 */

function authJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Actions that use the HAE shared-secret lane instead of GIS.
// Adjust this list if your HAE action name differs.
var HAE_ACTIONS = ['shortcut_health'];

function requireAuth_(e, body) {
  var props = PropertiesService.getScriptProperties();
  var authEnabled = props.getProperty('AUTH_ENABLED') === 'true';

  if (!authEnabled) return { ok: true, mode: 'disabled' };

  var params = (e && e.parameter) || {};
  var action = (body && body.action) || params.action || '';

  // Lane 2: HAE shared-secret
  if (HAE_ACTIONS.indexOf(action) !== -1 || (body && body.data)) {
    var haeSecret = props.getProperty('HAE_SECRET');
    var providedKey = params.key || (body && body.key);
    if (haeSecret && providedKey === haeSecret) {
      return { ok: true, mode: 'hae_secret' };
    }
    return { ok: false, detail: 'HAE key missing or invalid' };
  }

  // Lane 1: GIS ID token
  var idToken = params.id_token || (body && body.id_token);
  if (!idToken) return { ok: false, detail: 'Missing id_token' };

  var cache = CacheService.getScriptCache();
  var cacheKey = 'tokeninfo_' + idToken.substring(0, 40);
  var cached = cache.get(cacheKey);
  var tokenInfo;

  if (cached) {
    tokenInfo = JSON.parse(cached);
  } else {
    var resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) {
      return { ok: false, detail: 'Token verification failed' };
    }
    tokenInfo = JSON.parse(resp.getContentText());
    cache.put(cacheKey, JSON.stringify(tokenInfo), 300); // 5 min cache
  }

  var allowedEmail = props.getProperty('ALLOWED_EMAIL');
  if (!allowedEmail || tokenInfo.email !== allowedEmail) {
    return { ok: false, detail: 'Email not authorized' };
  }
  if (!tokenInfo.email_verified || tokenInfo.email_verified === 'false') {
    return { ok: false, detail: 'Email not verified' };
  }

  return { ok: true, mode: 'gis', email: tokenInfo.email };
}