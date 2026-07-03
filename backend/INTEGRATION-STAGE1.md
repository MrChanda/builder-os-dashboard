# Stage 1 Integration — Critical fixes

Four new `.gs` files go into the Apps Script project **alongside** your existing
`Code.gs` (File → New → Script file, paste each). Apps Script shares global
scope across files — no imports needed. Then five insertions into existing code.

## 1. Insertions into Code.gs

### doGet — top of function, before the action switch
```javascript
var auth = requireAuth_(e, null);
if (!auth.ok) return authJson_({ error: 'AUTH', detail: auth.detail });
```

### doPost — immediately AFTER you parse the JSON body
```javascript
var auth = requireAuth_(e, body);   // 'body' = your parsed JSON variable name
if (!auth.ok) return authJson_({ error: 'AUTH', detail: auth.detail });
```

### doGet switch — new case
```javascript
case 'config': return authJson_(handleGetConfig());
```

### handleUpdateTask — after the completion row is written to GOAL_COMPLETIONS
```javascript
if (String(newStatus).toUpperCase() === 'COMPLETE')
  result.awarded = getAwardedDelta_(taskId);   // adapt var names to yours
```

### handleHealthAutoExport — two changes
```javascript
// a) wherever the upsert key date is derived:
var key = normalizeDateKey_(rawDate);
if (!key) { quarantine_('DAILY_HEALTH', payload, ['DATE unparseable']); return; }
// use `key` for BOTH the row lookup and the DATE cell value.

// b) before writing a metrics row:
var v = validateHealthPayload_(rowObj);
if (!v.ok) { quarantine_('DAILY_HEALTH', rowObj, v.issues); return; }
```
Check `HAE_ACTIONS` at the top of `auth.gs` matches your router's actual
action name(s) for HAE ingestion.

## 2. Script Properties (Project Settings → Script Properties)

| Key | Value |
|---|---|
| `ALLOWED_EMAIL` | your Google account email |
| `GIS_CLIENT_ID` | OAuth client id (step 3) |
| `HAE_SECRET` | long random string — then append `&key=<it>` to the URL inside the HAE app's export config |
| `AUTH_ENABLED` | leave **unset** until step 5 |

## 3. Create the GIS OAuth client (~5 min)

console.cloud.google.com → APIs & Services → Credentials → Create Credentials
→ OAuth client ID → **Web application**.
- Authorized JavaScript origins: `https://mrchanda.github.io`
- No redirect URIs needed (GIS One Tap / button flow).
Copy the client id into **both** Script Properties and `config.js`
(`GIS_CLIENT_ID`).

## 4. Run the data repair (one-time)

In the Apps Script editor:
1. Run `testNormalizeDateKey()` — sanity-check parser output in Logs.
2. Run `repairDailyHealthKeys(true)` — dry run; read the duplicate-day report.
3. If the report looks right, run `repairDailyHealthKeys(false)` — floors all
   DATE keys, merges duplicate days (non-empty wins), deletes dup rows.
4. Run `testGetConfig()` and `testGetAwardedDelta()`.

## 5. Flip enforcement — ORDER MATTERS

1. Deploy backend: **Manage deployments → pencil → New version** (never
   "New deployment" — that rotates the /exec URL).
2. Push the frontend repo (config.js has the client id).
3. Verify sign-in works end-to-end with `AUTH_ENABLED` still unset.
4. Set Script Property `AUTH_ENABLED = true`.
5. Verify: dashboard still works signed in; an incognito `curl` of the /exec
   URL with `?action=tasks` returns `{"error":"AUTH"...}`; the next 23:59
   HAE trigger still lands (checks the `&key=` param).

## Rollback

Delete Script Property `AUTH_ENABLED` → endpoint is open again, frontend
token is ignored, everything behaves as v1. No code revert needed.

## What the frontend now does differently

- Reads `APPS_SCRIPT_URL` + `GIS_CLIENT_ID` from `config.js` (per-fork file;
  upstream template ships `config.example.js` only).
- Shows a sign-in overlay when auth is enabled; attaches `id_token` to every
  call; auto re-prompts on `{error:'AUTH'}` (token expiry ≈ 60 min).
- Tier ladder unified in `api.js` with the REAL CONFIG breakpoints
  (0/30/50/70/85/95) as fallback, live-hydrated from `getConfig` — a CONFIG
  sheet edit now propagates to both frontends with zero code changes.
- Avatar stages derive from tier floors (stage 5 unlocks at Master Builder 85;
  Sovereign keeps stage 5 — flag if you want a different mapping).
- Reward toasts display the true `GOAL_COMPLETIONS` award (primary +
  secondary points, late flag) with graceful fallback to `points_on_time`
  until the backend insert is live.
