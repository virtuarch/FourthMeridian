# Sentry Production Health Investigation

**Date:** 2026-07-27
**Project:** `fourth-meridian / javascript-nextjs` (org `o4511780012425216`, project `4511780026056704`)
**Branch context:** `v2.6` @ `50b4cba`; production serving `001e7bb` (v2.5.0)
**Method:** Sentry Web API via authenticated session, cross-referenced against git history, Vercel env/deployments, and live production endpoints.

---

## Executive Summary

**Production is healthy.** Of 15 issue groups, **13 are production, and all 13 are already fixed** — 11 by one commit, 2 by a migration deploy. Production has emitted **zero events in the last ~30 hours** (last production event 2026-07-26 11:41:53Z).

The Sentry issue list is not a defect backlog. It is an **un-triaged echo of two already-resolved incidents**. Nothing has been resolved, ignored, or assigned in Sentry — so fixed work still reads as open.

There is exactly **one active defect**, and it is not in production.

### Scope answers (settled by evidence, not assumption)

| Scope item | Finding |
|---|---|
| Performance | **Not enabled.** `tracesSampleRate: 0` (`lib/monitoring/sentry-options.ts:91`) — a deliberate ops-gate non-goal. |
| Recently Resolved | **None.** 0 resolved, 0 ignored, 0 assigned, 0 commented across all 15 groups. |
| Environments | Exactly two: `production` (13 groups) and `preview` (1 group). 1 group has no environment. |
| Releases | Production issues span `4750249c` and `4cb62159`. Every release after `8d7bdbf` has `newGroups: 0`. |
| Issue Trends | 74 events total, all-time. **Coverage begins 2026-07-22** — see the baseline caveat below. |

### Top five issues requiring attention

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | **`JAVASCRIPT-NEXTJS-F`** — preview boot failure; `isProd` conflates Vercel preview with production | **P1** | **ACTIVE** — only live defect |
| 2 | **No user attribution anywhere** — every production issue reads "0 affected users" | **P1** (instrumentation) | Open gap |
| 3 | **No source maps** — client stack traces are unreadable minified frames | **P2** (instrumentation) | Open gap |
| 4 | **`JAVASCRIPT-NEXTJS-E`** — mobile Safari React unmount crash | **P2** | Monitor — attribution unresolved |
| 5 | **Sentry hygiene** — 13 fixed issues still open; sample event never deleted; no inbound filters | **P3** | Cleanup |

> **Note on #2 and #3:** the highest-value findings are *instrumentation gaps*, not application bugs. The application is in better shape than the tooling used to observe it.

---

## Phase 1 — Inventory

All 15 groups, all-time. **Assignee: `null` for all 15. Status: `unresolved` for all 15.**

| Short | Issue ID | Title | First seen | Last seen | Events | Users | Env | Release |
|---|---|---|---|---|---|---|---|---|
| **F** | 7636130208 | `Error: instrumentation hook — PLAID_ENV is "sandbox"` | 07-27 15:41:51 | **07-27 17:17:54** | **24** | 0 | preview | `50b4cba` |
| A | 7632755817 | `Error: pre-login rate-limit store unavailable` | 07-25 14:59:17 | 07-26 11:41:53 | 4 | 0 | production | `4cb6215` |
| 4 | 7628555950 | `Error: Not authenticated — no active session` | 07-23 09:02:14 | 07-26 11:40:53 | 5 | 0 | production | `4cb6215` |
| 3 | 7628461568 | `PrismaClientKnownRequestError` — `spaceMember.findFirst()` | 07-23 07:52:17 | 07-26 11:40:46 | 7 | 0 | production | `4cb6215` |
| E | 7633993516 | `TypeError: null is not an object … parentNode.removeChild` | 07-26 11:40:35 | 07-26 11:40:35 | 1 | 0 | production | `4cb6215` |
| 2 | 7628461465 | `Error: Server Components render` (generic) | 07-23 07:52:17 | 07-26 11:40:28 | 5 | 0 | production | `4cb6215` |
| D | 7633993278 | `PrismaClientKnownRequestError` — `platformGrant.findUnique()` | 07-26 11:40:18 | 07-26 11:40:28 | 3 | 0 | production | `4cb6215` |
| 7 | 7630526568 | `PrismaClientKnownRequestError` — `notification.count()` | 07-24 08:20:03 | 07-26 11:40:18 | 6 | 0 | production | `4cb6215` |
| B | 7633483208 | `PrismaClientKnownRequestError` — `RefreshExecution` does not exist | 07-26 02:28:11 | 07-26 11:34:13 | 7 | 0 | production | `4cb6215` |
| C | 7633486575 | `PrismaClientKnownRequestError` — `SyncIssueOccurrence` does not exist | 07-26 02:31:31 | 07-26 02:31:31 | 1 | 0 | production | `4cb6215` |
| 9 | 7632754659 | `PrismaClientKnownRequestError` — `spaceInvite.findMany()` | 07-25 14:58:18 | 07-25 14:58:18 | 1 | 0 | production | `4750249` |
| 5 | 7628562479 | `PrismaClientKnownRequestError` — `spaceMember.findUnique()` | 07-23 09:00:35 | 07-25 14:58:16 | 6 | 0 | production | `4750249` |
| 8 | 7632754470 | `PrismaClientKnownRequestError` — `spaceInvite.count()` | 07-25 14:58:10 | 07-25 14:58:10 | 1 | 0 | production | `4750249` |
| 6 | 7628562522 | `PrismaClientKnownRequestError` — `user.findUnique()` | 07-23 09:00:35 | 07-25 14:57:48 | 2 | 0 | production | `4750249` |
| 1 | 7627259892 | `TypeError: … has no method 'updateFrom'` | 07-22 17:10:51 | 07-22 17:10:51 | 1 | 1 | *(none)* | — |

**Totals:** 74 events — production 49, preview 24, untagged 1.

### Baseline caveat (affects the whole report)

`NEXT_PUBLIC_SENTRY_DSN` was added to Vercel on **2026-07-22**, and the project's `firstEvent` is **2026-07-23 07:52:17Z**. **There is no v2.5 Sentry baseline to compare against** — monitoring was switched on during v2.5 closeout. Any "healthier / worse than v2.5" claim would be fabricated. The honest comparison available is *pre-fix vs post-fix within the 5-day window*, which is what this report uses.

---

## Phase 2 — Grouping

Sentry has these as 15 independent groups. Conceptually they are **five**.

### Cluster 1 — Database / Prisma / Authentication → `PROD-POOLER-AUTH-INCIDENT-1`
**10 groups · 40 events · 82% of all production events**
`3`, `4`, `5`, `6`, `7`, `8`, `9`, `A`, `D`, `2`

Seven are literal P2024 pool timeouts. Three are downstream masks of the same cause:
- `4` "Not authenticated — no active session" — the session-destruction symptom, **not** an auth defect
- `A` "pre-login rate-limit store unavailable" — `rateLimit.upsert` hitting the same P2024, failing closed to 503
- `2` "Server Components render" — the client-side mirror of the server 500s

The timestamps are conclusive. Every group in this cluster last fired inside one of exactly two windows:
- **2026-07-25 14:57:48 – 14:59:17**
- **2026-07-26 11:40:18 – 11:41:53**

Those are precisely the two incidents named in the fix commit.

### Cluster 2 — Infrastructure / migration lag
**2 groups · 8 events** — `B`, `C`
Production code querying tables absent from the production database.

### Cluster 3 — React rendering / Browser compatibility
**1 group · 1 event** — `E` (Mobile Safari 26.5.2 / iOS 18.7)

### Cluster 4 — Scheduler / Configuration (preview)
**1 group · 24 events** — `F`

### Cluster 5 — Noise
**1 group · 1 event** — `1`

---

## Phase 3 — Root Cause Analysis

### 3.1 Cluster 1 — `connection_limit=1` (HISTORICAL — fixed in `8d7bdbf`)

**Root cause.** A local troubleshooting leftover, `connection_limit=1`, reached the Production and Preview `DATABASE_URL`. Under Vercel Fluid Compute — where concurrent requests share one process and one Prisma client — every concurrent request serialised onto a single connection, producing P2024 pool timeouts under trivial load.

**Causal chain (from the commit, corroborated by Vercel logs):**
```
P2024 (connection_limit 1, timeout 10)
  -> throws from db.userSession.findFirst() in the NextAuth session() callback
  -> NextAuth catches, logs JWT_SESSION_ERROR, calls sessionStore.clean()
  -> Set-Cookie: next-auth.session-token=; Max-Age=0   (cookie DELETED)
  -> user retries login; rateLimit.upsert also P2024 -> fail-closed 503
  -> user bounced to /forgot-password and /register, three 503s
```
This is a **P0-severity chain**: real users were logged out and then blocked from logging back in. It matches the previously documented masking defect (pool exhaustion surfacing as "Not authenticated").

**Reproducible.** Yes — reproduced locally; a 14-way authenticated burst previously issued 14 queued queries.

**Fix — `8d7bdbf`, "fix(auth): stop a transient pool timeout from destroying a live session":**
1. Pool sizing moved out of the env var into `lib/db/connection-url.ts`; `RUNTIME_CONNECTION_LIMIT = 5` (`connection-url.ts:79`), normalised at runtime by `runtimeDatasourceUrl()` (`lib/db.ts`). Sized from measured baseline: Supavisor pool 15, peak 19 instances → worst case 19 × 5 = 95, under half the ceiling.
2. `resolveRevocation()` never throws, so NextAuth's cookie-clearing catch is unreachable. Degrades to bounded-stale (30s TTL + 120s grace), then INDETERMINATE → **503 + Retry-After, cookie preserved** — deliberately not 401.
3. Concurrent cache misses coalesced into one query (14-way burst → 1 live query).

**Still present on latest?** **No.**
- Deployed 2026-07-26 21:46Z; production now serves `001e7bb`.
- Live production `RefreshExecution` rows confirm `deploymentSha` `8d7bdbf` then `001e7bb`.
- Zero events in this cluster since 2026-07-26 11:41:53Z — ~30 hours silent.

> **Verdict: Historical — fixed in `8d7bdbf` (v2.5.0).** Awaiting age-out.

### 3.2 Cluster 2 — migration lag (HISTORICAL — resolved, verified live)

**Root cause.** Code referencing `RefreshExecution` and `SyncIssueOccurrence` was deployed to production before the corresponding migrations were applied. Both migrations exist in the repo — `20260724_df2a_refresh_execution` and `20260726_ops2d5a1_sync_incident_lifecycle` — so this was a **deploy-ordering failure, not missing code**.

**Verified directly against production** (rather than inferred from Sentry silence, which would be weak evidence on operator-only routes):
- `GET /api/platform/platform-ops/refresh/executions` → **200**, table exists and is populating
- `GET /api/platform/customer-success/sync-issues` → **200**, `activeTotal: 0`

> **Verdict: Historical — resolved by migration deploy. Confirmed live.**

### 3.3 Issue F — preview boot failure (**ACTIVE**)

**Stack:** `Module.s [as register]` → `lib_env_ts` — thrown from `validateEnv()` inside the `register()` instrumentation hook, i.e. **the server never boots**.

**Root cause.** `lib/env.ts:263` defines:
```ts
const isProd = _e.NODE_ENV === "production";
```
**Vercel preview builds also run with `NODE_ENV=production`.** So preview trips every production-only gate. At `lib/env.ts:286`:
```ts
if (isProd && _e.PLAID_CLIENT_ID && _e.PLAID_SECRET && _e.PLAID_ENV !== "production") { throw ... }
```
Preview legitimately has `PLAID_CLIENT_ID`, `PLAID_SECRET` (set 41d ago) and `PLAID_ENV="sandbox"` — which is **correct for preview** — so the guard fires and refuses to start.

**The code comments assert the opposite, and are wrong:**
- `lib/env.ts:284` — *"Dev/preview/test never reach this branch (isProd gate) and keep using sandbox freely."*
- `lib/env.ts:170` — *"Dev/test/preview do not require it (SDK simply stays disabled)."*

The second explains a side effect already paid for: preview was forced to carry `NEXT_PUBLIC_SENTRY_DSN` (added 5 days ago) purely to satisfy `PROD_REQUIRED_KEYS` — a production-only secret pushed into preview to work around a misclassification.

**Introduced by** `f8ad187` (2026-07-22, V25-FINAL-2) — the same change that added the DSN requirement.

**Still present?** **Yes — actively failing.** 24 events, escalating, surviving three consecutive redeploys today (`23552d9` 15:41 → `f7ad4d5` 15:48 → `50b4cba` 17:17). The "refreshed env" attempts cannot succeed, because the value is already correct; the *classifier* is wrong.

**Production risk.** The guard behaves correctly in production. But the same `NODE_ENV` conflation has a second consequence — see §6.1.

**⚠️ Fixing F will not, on its own, restore preview.** A separate prior diagnosis (same day, independent of this investigation) reports that preview's `DATABASE_URL` **credentials are invalid** — while the preview database itself is fine (88 migrations applied, 0 pending). Sentry cannot show this: the `validateEnv()` boot crash happens *first*, so the app never reaches a database call. Expect a second failure mode once the env guard is corrected. That credential claim is **carried over, not verified by this investigation** — confirm it before scheduling the work.

### 3.4 Issue E — mobile Safari React unmount (attribution unresolved)

**Stack (unreadable — no source maps):**
```
app:///_next/static/chunks/0juoxoaz_g1ol.js:19  l7
app:///_next/static/chunks/0juoxoaz_g1ol.js:19  l9   (alternating, recursive)
```
`mechanism: auto.browser.global_handlers.onerror`, `handled: false`. Mobile Safari 26.5.2 / iOS 18.7.

**Two candidate causes, not separable from one event:**
1. **Secondary fallout** — it fired at 11:40:35, inside the second pooler incident window (11:40:08–11:41:53), on `/dashboard/spaces`, whose server render was failing at that moment (issue `9`). React attempting to unmount a failed tree fits the recursive commit-phase frames.
2. **Independent mobile bug** — release `4cb6215` is *"fix(ops): close mobile platform surface ergonomics gaps"*, and this is a mobile-only crash on that release.

(1) is the stronger explanation, but this is **correlation, not proof**. Stated as low confidence deliberately.

**Reproducible:** not attempted — one event, mobile-only, no source maps.

### 3.5 Issue 1 — Sentry sample event (NOISE)

`url = example.com/foo`, `culprit = ../../sentry/scripts/views.js in poll`, no environment, fired 2026-07-22 17:10:51 — project creation. This is Sentry's **onboarding demo event**. Not our code. It is also the only issue with a non-zero user count, which distorts the one user metric available.

---

## Phase 4 — Severity

| Issue | Severity | Rationale |
|---|---|---|
| **F** | **P1** | Blocks all v2.6 preview validation. Not customer-facing (preview only), so not P0. |
| Cluster 1 (`3,4,5,6,7,8,9,A,D,2`) | **P0 — historical** | Broken authentication: users logged out and blocked from re-login. Fixed in `8d7bdbf`. |
| B, C | **P1 — historical** | Broken operator workflows. Resolved; verified live. |
| E | **P2** | Single occurrence, degraded UX, mobile-only, unconfirmed attribution. |
| 1 | **P3** | Noise / false positive. |

**Active P0 count: 0. Active P1 count: 1 (preview-only).**

---

## Phase 5 — Noise Reduction

**Duplicates / over-reporting.** One pool incident produced **ten separate issue groups** because grouping keys on the Prisma call site (`spaceMember.findFirst`, `notification.count`, …) rather than the error code. A single infrastructure fault fanned out into ten alerts. Fingerprint all P2024s to one group (§6.3).

**Errors that should be warnings.** `Not authenticated — no active session` (issue `4`) is *expected* for a genuinely anonymous request to `/dashboard`. Here it was pool-induced, but as a permanent `error`-level capture it will generate recurring false positives. Post-fix it should be `warning`, or not captured when no session cookie was presented.

**Errors that should be breadcrumbs.** The generic Server Components render error (issue `2`) carries no actionable content — the real cause is always the underlying server throw. It should attach as context to the originating error, not stand alone.

**Should be ignored permanently.** Issue `1` (Sentry sample event).

**Inbound filters — currently none configured.** Enable at minimum: browser extensions, legacy browsers, localhost.

**Alerting.** Only the default rule exists (*"Send a notification for high priority issues"*). During the 07-26 incident this would have fired ~10 times for one fault. Recommend an event-rate metric alert plus issue ownership rules.

---

## Phase 6 — Operational Gaps

### 6.1 Environment mislabelling on the client (latent, same root cause as F)
`lib/monitoring/sentry-options.ts:44`:
```ts
const ENVIRONMENT = process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
```
`NEXT_PUBLIC_VERCEL_ENV` is **not set in Vercel**. Next.js only inlines `NEXT_PUBLIC_*` into client bundles, so in the browser `VERCEL_ENV` is `undefined` and this falls through to `NODE_ENV = "production"`.

**Consequence: browser errors from *preview* deploys are tagged `environment: production`.** Server events are unaffected (`VERCEL_ENV` resolves correctly — issue F is correctly tagged `preview`).

This did not corrupt the present report — every production issue was independently verified to carry a `url` of `fourthmeridian.com` — but that check was only possible by hand. **Fix: set `NEXT_PUBLIC_VERCEL_ENV` in Vercel.**

### 6.2 No user metadata — the single biggest gap
There are **zero** `Sentry.setUser` calls in the codebase. Every production issue reports **0 affected users**. During an incident that logged real users out, Sentry could not say whether one user or every user was affected — blast radius was unknowable from the tool built to report it.

`scrubEvent` (`sentry-options.ts:74`) already reduces `event.user` to `{ id }`, so **the safe path is already built** — nothing is populating it. Set the opaque user id after session resolution.

### 6.3 No fingerprinting
Issue `2` is a mixed bucket: its `culprit` says `/dashboard/connections`, but its latest event's URL is `/dashboard/platform/PLATFORM`. Distinct failures share one group, and the group's identity is misleading.

Recommended fingerprints: P2024 → `["db-pool-timeout"]` (collapses ten groups to one); Server Components render → `["rsc-render", route, digest]`.

### 6.4 No source maps
`next.config.ts` does not use `withSentryConfig`. Client stack traces are unusable (§3.4) — the only reason issue E cannot be diagnosed.

### 6.5 Tags not used
No `setTag` anywhere. Recommended: `route`, `vercel_env`, `db_error_code`, `pool_timeout`. Note `lib/monitoring/capture.ts` **already implements** `classifyDbError()` and `isPoolTimeoutCode()` — the classification exists and is simply not attached to general DB failures.

### 6.6 Release metadata
Releases are auto-created from the `release` tag (via `currentDeploymentSha()`), so there is no commit association, no suspect-commit detection, and no deploy markers. `withSentryConfig` would supply all three.

---

## Phase 7 — Action Plan

### Fix immediately
| Action | Effort | Risk | Customer impact |
|---|---|---|---|
| **F** — gate on `VERCEL_ENV === "production"` (fall back to `NODE_ENV` when absent) in `lib/env.ts`; correct the two false comments at lines 170 and 284 | ~1h | Low — narrows an over-broad guard; production behaviour unchanged | None directly; unblocks v2.6 |
| Set `NEXT_PUBLIC_VERCEL_ENV` in Vercel (§6.1) | ~5m | None | None — restores triage integrity |
| Verify/repair preview `DATABASE_URL` credentials — expected next failure once F is fixed (§3.3) | ~30m | Low | None; preview only |

### Schedule for v2.6
| Action | Effort | Risk | Customer impact |
|---|---|---|---|
| `Sentry.setUser({ id })` after session resolution (§6.2) | ~2h | Low — scrubber already constrains the payload | High diagnostic value |
| Adopt `withSentryConfig` for source maps + commit association (§6.4, §6.6) | ~2h | Low | Readable client traces |
| Fingerprint P2024 + RSC render errors (§6.3) | ~2h | Low | Ten alerts → one |
| Attach `classifyDbError` / `pool_timeout` tags to general DB failures (§6.5) | ~2h | Low | Faster incident ID |
| Deploy-ordering guard so migrations precede code (§3.2) | ~4h | Medium | Prevents recurrence of B/C |
| Downgrade anonymous `Not authenticated` to `warning` (§5) | ~1h | Low | Removes false positives |

### Monitor only
- **E** — reassess once source maps land. If it recurs *outside* an incident window, it is an independent mobile Safari bug and should be re-scoped.

### Close as expected behaviour
- **B, C** — resolved; verified live against production.

### Ignore permanently
- **1** — Sentry sample event. Delete or ignore forever.

---

## Cleanup Recommendations

1. **Resolve in next release:** all 10 Cluster 1 groups (`2,3,4,5,6,7,8,9,A,D`) — fixed in `8d7bdbf`. Sentry will auto-regress them if the fault returns, which is the correct safety net.
2. **Resolve:** `B`, `C` — verified fixed in production.
3. **Delete or ignore forever:** `1`.
4. **Merge conceptually:** the seven P2024 groups under one fingerprint before the next incident.
5. **Assign owners** — all 15 groups are unassigned and 14 are unread; nothing is being triaged.
6. **Leave open:** `F` (active), `E` (monitoring).

Post-cleanup, the board should read **1 open issue**, not 15.

---

## Overall Assessment

**Production today is healthy, and materially healthier than at any point in the observable window.**

- Last production event: **2026-07-26 11:41:53Z** (~30 hours silent).
- Every release after `8d7bdbf` — `001e7bb`, `62aa5fe`, `23552d9`, `f7ad4d5`, `50b4cba` — has **`newGroups: 0`**.
- Live production checks pass: refresh executions all `SUCCEEDED`; **zero** active sync issues.
- Active P0s: **0**. Active production defects: **0**.

**On the v2.5 comparison:** a direct comparison is **not possible**, and I will not manufacture one. Monitoring was enabled 2026-07-22, *after* v2.5 development and during its closeout — there is no v2.5 Sentry baseline. What the data supports is a *within-window* comparison: two acute incidents on 07-25 and 07-26 under `connection_limit=1`, then a clean ~30-hour post-fix window. That is a real improvement, but 30 hours of low-traffic beta is a thin sample and should not yet be read as proven stability.

**The honest caveat:** production's clean bill of health rests partly on **low traffic and absent instrumentation**. With 0 affected users recorded on every issue and no source maps, we would struggle to size or diagnose the next incident. The v2.6 instrumentation work in Phase 7 matters more than any application fix in this report — the application is currently in better shape than our ability to observe it.

**The one thing to fix today** is issue `F`. It is not a production defect, but it blocks v2.6 validation entirely, and three redeploys have already been spent against a misdiagnosis — the env value is correct; the environment classifier is wrong.
