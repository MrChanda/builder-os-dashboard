# BUILDER OS — CONTEXT.md
**Last updated:** 2026-07-06 · Stage 1 close-out build (Code.gs v6.4)
**Rule:** this file tracks what is ACTUALLY DEPLOYED AND VERIFIED, not what exists in the repo. If code lands here before it's confirmed against the live Sheet, it's marked UNVERIFIED.

---

## Deployment state

| Component | Repo state | Live state |
|---|---|---|
| `backend/Code.gs` | **v6.4** (this build) | **v6.3 — v6.4 NOT YET DEPLOYED.** Deploy via *edit existing deployment* (Deploy → Manage deployments → pencil → New version). Never create a new deployment — it rotates the `/exec` URL in `config.js`. |
| `backend/config_api.gs` | v6.4 (water-target fix, cache key v2) | Not yet deployed |
| `backend/auth.gs`, `ingest_guard.gs`, `points_delta.gs` | Unchanged this build | Live, verified (prior session) |
| `index.html`, `mobile.html`, `api.js` | Patched this build | Not yet pushed to GitHub Pages |
| `config.js` | Unchanged | Live |

## Spec §1 item outcomes (2026-07-06 session)

| # | Item | Outcome |
|---|---|---|
| 1 | Due-date landmine (date picker on RECURRING) | **DONE (code), UNVERIFIED (live sheet).** Frontend: due cell is a cadence `<select>` for RECURRING (preselected from stored value, default WEEKLY on type-flip, never converts date↔cadence), date picker for MILESTONE. Backend: `normalizeDueDateForType_()` rejects mismatches in both `handleAddTask`/`handleUpdateTask` before any write; cadences written as text with `'@'` format. Verified via 8 DOM assertions (jsdom) + offline unit tests. Live test: `testCadenceGuard()`. |
| 2 | task_id manual entry / collisions | **DONE (code), UNVERIFIED (live sheet).** `DOMAIN_PREFIX` map + `nextTaskId_()` (dotted sub-IDs count toward integer parent — verified HG8, not HG3.5, against the real ID population offline) + `LockService` atomic assignment. Collision check is now case/whitespace-insensitive (`findTaskRow_`). Frontend add-row has no ID input ("auto" badge); Domain is the required field. Live tests: `testAddTaskIdGen()`, `testAddTaskIdGenSequential()`, plus a true two-curl race per DoD 1. |
| 3 | points_late frozen static | **DONE (code), UNVERIFIED (live sheet).** Default = live `=ROUND(H{row}*0.75,0)` formula; static only on explicit user edit (`points_late_override`); clearing the field restores the formula. Frontend transmits points_late ONLY when user-edited this session. One-time repair for existing frozen rows: `repairPointsLateFormulas_()` — value-preserving relink at exactly 75%, logs (never touches) intentional overrides. Live test: `testPointsLateFormula()`. |
| 4 | decay_trigger / decay_pts_day no UI | **DONE (code), UNVERIFIED (live sheet).** Two desktop table columns added (colspan 11→13), numeric coercion on decay_pts_day. Live test: `testDecayColumnsRoundTrip()`. |
| 5 | HG3 split / STR decay fork (A vs B) | **DECIDED: Option B** (autonomous-session authority — boss review invited). N3's stat-wide inactivity net UNCHANGED; new STAT_HISTORY cols AA (`STR_TASK_DECAY_WKLY`, HG3.1–3.3) and AB (`END_TASK_DECAY_WKLY`, HG3.4) apply −3 per task per missed Mon–Sun week at Monday close-out, immune to unrelated STR/END activity. Rationale: additive (historical rows untouched), keeps the safety net for STR work outside the split, decouples the two failure modes; A would have destroyed both properties to buy nothing but formula count. Point economy exactly as specified: 4/4/4/3 on-time, 3/3/3/3 decay — not rebalanced. Tools: `migrateHG3Split_()` (adds HG3.1–3.4, retires HG3 → CANCELLED), `installPerTaskWeeklyDecayColumns_()` (AA/AB formulas + exact-suffix wiring of `+AA3`/`+AB3` into C3/D3; logs a manual one-liner if the live formula shape has drifted). `dailyRecalc` propagation extended C:Z → C:AB. **NOT RUN against the live sheet.** |
| 6 | Water target ambiguity | **RESOLVED — not actually a design fork.** `Water Daily Target (L)` on CONFIG is `=B9`: it reads HEIGHT (1.7 m) as litres. A broken cell ref, not a target model. `config_api.gs` now prefers the weight-calculated `Water Target (L)` (`=B8*0.033` ≈ 2.74 L @ 83 kg), old key kept as fallback; cache key bumped v1→v2. Both frontends hydrate the goal from config (hardcoded 2.5 is now only the offline fallback); mobile's goal label updates too. Optional sheet cleanup: delete or repoint the `Water Daily Target (L)` row. |

## Backlog movements

- **api.js retry-once** — BUILT (GET-only; POSTs deliberately not retried — a retried add_task after an ambiguous failure could double-write). Verified offline (throw-then-succeed → 2 calls, data returned).
- **Reward-toast end-to-end** — still OUTSTANDING (needs a live completion; last remaining Stage 1 verification item).
- **`repairAlcoholSessionFormulas_()`** — still NEVER CONFIRMED RUN; ALCOHOL_SESSIONS I:P chain status unknown.
- **Found & fixed en route:** POST task handlers returned `errorResponse()` (TextOutput) which the router's `jsonResponse()` wrap spread into `{"status":"ok"}` — task-handler errors were being silently swallowed. Handlers now return `errObj_()` plain objects; frontends also check `result.status==='error'`.

## Next-session runbook (in order, stop at first failure)

1. Push repo → GitHub Pages; deploy Apps Script v6.4 (**edit existing deployment**).
2. Run `testStage1CloseOut()` from the editor; read the log top to bottom. Then the two-curl `add_task` race for true DoD-1 concurrency.
3. Run `repairPointsLateFormulas_()`; review the override log.
4. Run `migrateHG3Split_()`, then `installPerTaskWeeklyDecayColumns_()`; check the log for MANUAL STEP lines on C3/D3.
5. Regression: `testPing`, `testHAELocal`, `testWorkoutLocal`; sheet-rename degradation check; revert.
6. Reward-toast: complete a real task from the dashboard, confirm the toast shows the awarded value.
7. Visual check both themes/viewports (Playwright screenshots were NOT possible in the build container — see handoff note).
