# Platform Operations — Observability Investigation & Roadmap (FX incident follow-on)

**Status:** INVESTIGATION ONLY — no code, no schema, no runtime change, no commit. Design, not implementation.
**Date:** 2026-07-16 · working tree `feature/v2.5-spaces-completion` (post-OPS-4, post-SD-2E)
**Trigger:** a real incident — after a local DB rebuild the `FxRate` archive was empty; the currency selector still swapped symbols but conversion silently defaulted, and **Platform Operations gave no indication the sync had never run.** The problem was discovered through product behavior, not through operations.
**Relationship to prior art:** supersedes the current-state audit in `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md` (dated 2026-07-06). That document's §1 rows — *"no job-run ledger of any kind," "startScheduler never invoked," "2 crons"* — are **now stale**: OPS-4 (S1–S5) shipped the ledger, dispatcher, registry, and dead-job detector, and SD-2E converged the Platform Space onto SpaceShell. The strategic doctrine of PLATOPS (capture-first telemetry, tenancy boundary, single-definition-site) still stands and is inherited here.

---

## 0. Executive summary

The incident is **not** an FX bug and **not** a missing-infrastructure problem. Fourth Meridian already has more operational plumbing than the old roadmap credits it with:

- **One cron** (`/api/jobs/dispatch`) fans out to a **typed registry** of 9 jobs, each run through `runJob()` which writes a **`JobRun` ledger** row (start + single completion write, `succeeded`/`failed`, duration, summary, error).
- A **dead-job detector** (`lib/jobs/health.ts`) classifies every registered job as `healthy` / `overdue` / `failing` / `never-ran` over that ledger.
- The **Platform Operations Space is live** and converged onto `SpaceShell` (SD-2E), rendering **five real, read-only widgets**: Job Health, Rate Limits, Environment, API Usage (`ApiUsageCounter` — OpenAI + Plaid call/token counts), Connection Health.

So why did the operator learn about FX from the product? Because of **three gaps that the incident exposes precisely**:

1. **Everything is pull-only. There is no alerting of any kind.** No email, no notification, no scheduled health evaluation. If the dispatcher cron dies, or `CRON_SECRET` is misconfigured (→ every dispatch 401s), *nothing tells anyone*. You must open a widget or run a CLI to find out.
2. **"Job succeeded" ≠ "data is fresh."** `fetch-fx-rates` returns `source:"none"` **without throwing** when every provider fails → a *succeeded* `JobRun`. `fetch-security-prices` reports `succeeded` daily while fetching nothing (vendor-gated no-op). Health keys on `JobRun.status`, which is **decoupled from the actual contents** of `FxRate` / `PriceObservation`. An empty archive is invisible to the health surface.
3. **FX freshness and provider quota are surfaced nowhere.** There is no "newest FX date / staleness / archive empty" signal, and no provider-health panel (usage / remaining / reset). The OXR free-tier quota (~1,000/mo, ~600–700 already consumed) is not tracked at all — it exists only as a comment in a backfill script.

The fix is **surfacing + semantics + one alerting seam**, not a ground-up build. Most of it attaches to the Platform Space that already exists, and the highest-value first slice is small.

---

## 1. Current Platform Operations capabilities (census)

### 1.1 The Space and its render path
- **Route:** `app/(shell)/dashboard/platform/[area]/page.tsx` — the single server-component render path for all four platform areas. Gate order: known `PlatformArea` → session → **ACTIVE `PlatformGrant`** (`hasPlatformAccess(area,"READ")`, orthogonal to `SpaceMemberRole`); ungranted → `redirect("/dashboard/spaces")` (no existence disclosure). `SYSTEM_ADMIN` never reaches this page — grant administration is a separate `app/api/admin/*` surface.
- **Surface:** `components/platform/PlatformSpaceDashboard.tsx` renders the **shared `SpaceShell` frame** (SD-2E), currently as a **single "Overview" workspace** with a one-entry rail and a no-op `onSelectTab`. Sections render as cards in a CSS grid; each card is a self-fetching widget (`useWidgetFetch` in `widget-kit.tsx`).
- **Area/section registry:** `lib/platform/policy.ts` `PLATFORM_AREAS`. `PLATFORM_OPS` sections (ordered): `ops_job_health`, `ops_rate_limits`, `ops_env_status`, `ops_api_usage`, `ops_connection_health`.

### 1.2 The five Platform Operations widgets — all REAL, all read-only

| Section / widget | Displays | Source | Status |
|---|---|---|---|
| **Job Health** `OpsJobHealthWidget` | healthy/unhealthy/never-ran counts + unhealthy job names & status | `GET /platform-ops/job-health` → `checkScheduledJobHealth()` over `JobRun` | Real |
| **Rate Limits** `OpsRateLimitsWidget` | requests this window, tracked keys, top endpoint buckets | `GET /platform-ops/rate-limits` → `db.rateLimit` (1h) | Real |
| **Environment** `OpsEnvStatusWidget` | pass/warn/fail counts + non-passing var **names** (never values) | `GET /platform-ops/env-status` → `getEnvReport()` | Real (config introspection) |
| **API Usage** `OpsApiUsageWidget` | calls today/7d/30d per provider, tokens per model, optional est. spend | `GET /platform-ops/api-usage` → `db.apiUsageCounter` | Real for volume; **spend dormant** (`lib/usage/pricing.ts` ships empty → `estimatedSpendUsd: null`) |
| **Connection Health** `OpsConnectionHealthWidget` | healthy/unhealthy/total + worst-first unhealthy connections | `GET /platform-ops/connection-health` → `getConnectionHealth()` | Real |

**No PLATFORM_OPS widget performs any mutation.** (Across all areas, the only actioned widget is Growth's beta-request Approve/Deny.)

### 1.3 What exists but is under-surfaced (APIs richer than the widgets)
The read APIs already return data the widgets throw away — "have an API, not exposed":
- **Job Health** returns per-job `lastStartedAt`, `lastRunStatus`, `consecutiveFailures`, `expectedEveryHours`; the widget shows only counts + names. **Last-ran / failure-streak / cadence is available today, unused.**
- **Connection Health** returns per-row `errorCode` + `lastSyncedAt`; widget renders only `healthState` + "since".
- **Rate Limits** carries per-bucket distinct-subject `keys`; widget shows only hits.
- **API Usage** cost pipeline (`estimateUnitSpendUsd`, `isPricingConfigured`) is wired end-to-end but dormant — **populating `UNIT_PRICES_USD` lights up spend with zero code change.**
- **Dead-job detector** is also exposed as an operator CLI: `scripts/check-job-health.ts` (exits non-zero when unhealthy) — usable in CI/pre-deploy today.

### 1.4 Stale artifact to note
`PlatformSpaceDashboard`'s `PLATFORM_SECTION_REGISTRY` still carries "Lands in PO1.2…" placeholder notes; every PLATFORM_OPS section now has a live widget, so those notes never render but misread as "still stubbed."

---

## 2. FX synchronization lifecycle (the concrete example)

```
Open Exchange Rates (primary, OXR_APP_ID)  ──┐
Frankfurter (fallback, keyless, no SAR/AED) ─┴─► failover registry (lib/fx/registry.ts)
        │
        ▼
Vercel Cron  "0,30 0,6,7,12,18 * * *"  →  /api/jobs/dispatch  →  dispatcher selects 06:30 slot
        │
        ▼
runJob("fetch-fx-rates", …)  →  jobs/fetch-fx-rates.ts  →  fetchDay()  →  parse (complete-or-throw)
        │                                    └── writes JobRun row (start + completion)
        ▼
fxArchive.writeBatch → db.fxRate.createMany({ skipDuplicates })   (insert-only, closed dates only)
        │
        ▼
lib/fx/service.ts (USD cross-rate, ≤7-day walk-back) → lib/money/context.ts → convert.ts
```

| Question | Answer |
|---|---|
| **What starts the sync** | (a) daily cron via dispatcher (06:30 UTC); (b) manual `GET /api/jobs/fetch-fx-rates` (CRON_SECRET); (c) opportunistic SWR (`lib/money/fx-freshness.ts`) fired on a user conversion when yesterday's rate is missing; (d) `scripts/backfill-fx-rates.ts` / `scripts/copy-fx-rates.ts`. |
| **How often it should run** | Once daily (06:30 UTC). Fetches **only the previous closed UTC day** — one day per run; it does **not** backfill history. No `expectedEveryHours`, so health cadence defaults to daily. |
| **What success looks like** | `JobRun.status = succeeded`, `summary.source = "openexchangerates"|"frankfurter"`, `inserted > 0` (or `"skipped"` when already covered). |
| **What failure looks like** | Two shapes. Real throw (parse/HTTP) → `JobRun.status = failed`. **But** all-providers-empty returns `source:"none"` **without throwing** → recorded as **`succeeded`** with `inserted:0`. The latter is the dangerous shape. |
| **Retries** | None beyond provider failover. Self-heal = tomorrow's run or a manual backfill. No backoff, no queue. |
| **Where failures are logged** | Console only (`[fx-cron]`, `[fx-swr]`, per-adapter `notes`). Plus the `JobRun` row for throw-failures. |
| **Usage / quota known** | **No.** OXR quota is neither read nor persisted; the only mention is a comment in `backfill-fx-rates.ts`. |
| **Current status persisted** | Job execution: **yes** (`JobRun`). Data freshness: **no** — `FxRate.fetchedAt` records per-row insert time, but nothing computes/persists "archive is empty/stale," and nothing in the conversion contract consults it. |

**Empty-table behavior (the incident core):** With `FxRate` empty, every non-USD leg is a `RateMiss`; `convertMoney` passes the **native amount through unchanged, relabeled to the target currency, `estimated:true`, no error** — €100 renders as "$100 (estimated)". The SWR gate **refuses to act on a cold archive** by design (`revalidateFxIfStale` → `"cold"` → no trigger), so a user request does not even self-heal an empty table. `prisma/seed.ts` writes **zero** `FxRate` rows, so every `db:reset` starts cold. Recovery is manual: `scripts/backfill-fx-rates.ts --apply` or `scripts/copy-fx-rates.ts`.

---

## 3. Platform visibility audit — "if a process stopped, how would I know?"

| Process | Automatic? | Persisted | Visible today | Verdict |
|---|---|---|---|---|
| **FX sync** (`fetch-fx-rates`) | cron 06:30 + SWR + manual | `JobRun` (job), **not** archive freshness | Job Health widget shows never-ran/overdue/failing — **decoupled from rate emptiness**; no freshness surface | **Partially visible (misleading)** |
| **Plaid sync** (`sync-banks`) | cron 06:00 + webhook + manual | `JobRun` (cron path only) + `PlaidItem` state + `SyncIssue` | Job Health + Connection Health widgets | **Visible** (cron path); webhook/connect-time `after()` paths write **no `JobRun`** → **invisible in aggregate** |
| **Crypto sync** (`sync-crypto`) | cron every 6h + manual | `JobRun` (aggregate) + `SyncIssue` (per-wallet) | Job Health (cadence-aware via `expectedEveryHours:6`) | **Visible** (aggregate); per-wallet detail only in `SyncIssue`/console |
| **Security prices** (`fetch-security-prices`) | cron 06:30 | `JobRun` | Job Health — but **`succeeded` forever while no-op** (vendor-gated) | **False-green** |
| **Background jobs** (deletions, purge-trash, notif cleanup/retry, rate-limit sweep) | cron 07:00/07:30 | `JobRun` | Job Health | **Visible** |
| **Cron execution itself / dispatcher** | Vercel | Vercel dashboard (500 on failed slot) | No in-app signal; **`CRON_SECRET` misconfig → all 401 → all jobs silently stop** | **Invisible in-app** |
| **API refreshes / SWR FX** (`fx-freshness`) | on user request | **none** (bypasses `runJob`) | Console warnings only | **Invisible** |
| **Cleanup / backfills / regenerations** (manual scripts) | manual | **none** (no run ledger) | Console output only | **Invisible** |
| **Queue processors** | — | — | — | **N/A** (no queue exists; jobs run synchronously per slot) |

**Completely invisible today:** cron/dispatcher liveness in-app, off-ledger automatic work (SWR, Plaid webhook/connect-time), manual-script runs, **data-freshness of any archive** (FX, prices), and **any provider quota/usage for FX**. **No alerting exists for anything.**

---

## 4. Desired Platform Operations experience (design)

The emphasis, stated as doctrine: **"I should know there is a problem before I open the customer product — and ideally before I open Operations at all."** Two shifts:

**(a) Every "health" signal must be content-aware, not just execution-aware.** A job card should read the freshness of what it produces, not just whether it exited 0. Target shape for FX:

```
Sync Jobs › FX Rates
  Status            Healthy
  Last Run          4 minutes ago            (JobRun.completedAt)
  Next Scheduled    in 56 minutes            (registry slot)
  Rows Updated      178                      (JobRun.summary.inserted)
  Archive Fresh To  2026-07-15  (yesterday)  ← NEW: newest FxRate.date, the content check
  Duration          2.3s                     (JobRun.durationMs)
  API Calls Today   712 / 1000               ← NEW: provider usage
  Remaining         288
  Last Error        none                     (JobRun.errorSummary)
```

Unhealthy — driven by **content OR execution**, whichever is worse:

```
  Status            FAILED
  Last Successful   3 days ago
  Archive Fresh To  2026-07-12  (stale 4d)   ← catches source:"none" succeeded runs
  Reason            Quota exhausted (OXR 1000/1000)
  Action            [ Run manually ]         ← §5
```

The load-bearing new field is **"Archive Fresh To"** — the one signal that would have caught this incident. It closes the `source:"none"`-succeeded and vendor-gated-no-op false-greens in one move, because it asserts on the *data*, not the *exit code*.

**(b) Push, don't pull.** A once-daily health evaluation (rides the dispatcher) emails the operator on any `overdue`/`failing`/**stale-archive**/quota-breach. Five rules maximum, ruthlessly tuned (alert-fatigue is the failure mode). The email seam is OPS-1's dependency — see §9.

---

## 5. Manual operational controls ("Run Now")

**What already exists to build on:** every job has an idempotent, re-runnable body (house discipline) and most have a `CRON_SECRET`-guarded fallback route (`/api/jobs/{sync-banks,fetch-fx-rates,fetch-security-prices,process-deletions}`). `runJob()` already accepts `trigger: "manual"` in its vocabulary — a manual run is a first-class ledger citizen today, just never invoked from the UI.

**Permissions:** the Platform Space already has a `WRITE` access level (`PlatformGrant`, `requireFreshPlatformAccess`) — the exact gate Growth's Approve/Deny uses. A "Run Now" button is a WRITE action behind that same fresh-grant check, landing an `AuditLog` row with `performedByAdminId`.

**Safety requirements for a safe "Run Now":** (1) idempotent + safe-to-re-run body (already true for the candidates); (2) WRITE grant + fresh re-auth; (3) an **in-flight lock** so double-click can't double-run (Plaid already has `sync-lock`; FX is naturally idempotent via skip-duplicates); (4) `AuditLog` entry; (5) `runJob(trigger:"manual")` so the manual run is ledgered distinctly from cron.

| Job | Run-Now candidate? | Notes |
|---|---|---|
| **FX refresh** | ✅ **Yes — first candidate** | idempotent, network-light, insert-only; the incident's direct remedy. A "Run Now" that fetches yesterday + **a bootstrap-if-empty** would have resolved the incident in one click. |
| Security prices | ✅ Yes | idempotent; no-op until vendor keyed |
| Crypto sync | ✅ Yes (per-account already exists, rate-limited) | fleet-wide manual sweep is the new bit |
| Plaid sync | ⚠️ Yes but exists per-item ("Sync Now", 60-min cooldown) | fleet-wide manual = respect per-item cooldowns/locks |
| purge-trash / process-deletions | ⚠️ Automatic-only preferred | destructive; if exposed, require WRITE + explicit confirm; never a casual button |
| notification cleanup/retry, rate-limit sweep | ➖ Automatic only | low operator value, no reason to expose |

**Recommendation:** ship "Run Now" for **FX first** (highest incident relevance, safest profile), then security-prices and crypto. Keep deletion/purge automatic-only.

---

## 6. API / provider health

**What the FX providers actually expose:**
- **Open Exchange Rates:** the historical endpoint response body carries **no** quota info; the app's adapter discards the envelope and only surfaces HTTP status on failure (429 on exhaustion). OXR **does** expose usage via a **separate** `GET /api/usage.json` (plan, `requests_quota`, `requests_remaining`, `days_elapsed`, `days_remaining`) — a capability that exists but is **never called**. So *usage/remaining/reset is realistically reportable, but only with one additional call the app does not currently make.*
- **Frankfurter:** keyless, no quota concept — nothing to report.

**What's reportable today vs. with minimal work:**

| Field | FX (OXR) | Notes |
|---|---|---|
| Status / availability | ✅ derivable now | from `JobRun` fail rows + adapter `notes` |
| Last request / success / failure | ✅ now | `JobRun` (`fetch-fx-rates`) startedAt/status |
| Error rate | ✅ now | `JobRun` status over window |
| Usage / remaining quota / reset window | ⚠️ one new call | `GET /api/usage.json` — cheap, gated, cache daily |
| Average latency | ⚠️ partial | `JobRun.durationMs` is whole-job; per-provider latency needs a telemetry emission |

**Generalization:** the same "Provider" panel shape (status · last request/success/failure · quota · remaining · reset · latency · error rate) applies to **every** external provider — Plaid, OXR, Tiingo, CoinGecko, mempool, OpenAI, Resend. `ApiUsageCounter` **already** captures call volume + tokens for OpenAI and Plaid; extending emission to the FX/price/crypto providers is the natural convergence. **Note: FX providers are currently NOT in `ApiUsageCounter`** — they should be, so provider health is uniform.

Per the brief: no additional live API calls were made during this investigation; the OXR usage endpoint is documented capability, quoted, not exercised.

---

## 7. Relationship to the new Platform Space architecture

Ground truth (SD-2E, doctrine `SPACE_CONTRACT_DOCTRINE.md`): **Platform has converged onto the `SpaceShell` frame but not yet onto the registry/composition layer.** It renders a single "Overview" workspace with a no-op rail; its identity/composition live platform-locally (`PLATFORM_AREAS` + local widget registry), not in `WORKSPACE_REGISTRY`.

This is exactly the right substrate. New operational capabilities attach as **additional Standard Workspaces** — rail tabs in `PlatformSpaceDashboard`, each a self-fetching body in the shell's `children` slot (the customer `SpaceDashboard` multi-tab pattern). Because HQ workspaces self-fetch (`dataNeeds: []`), this needs **zero contract change today**. The natural organization:

```
Platform Operations  (SpaceShell)
├─ Overview     the since-last-visit ops delta (job health, freshness, quota, alerts)  ← standard
├─ Jobs         run ledger, per-job last-run/streak/cadence, Run-Now levers            ← standard
├─ Providers    per-provider status/quota/latency/error-rate (FX, Plaid, Tiingo, …)    ← standard
├─ API Usage    ApiUsageCounter volume + tokens + (dormant) spend                      ← standard
├─ Activity     recent JobRun + AuditLog stream (what ran / who acted)                 ← standard
└─ (future Perspectives — §8)
```

The current five Overview cards decompose cleanly: Job Health → **Jobs**, Connection Health → **Providers**, API Usage → **API Usage**, Rate Limits/Env → **Overview** (or a small **Health** card). **Registering these in `WORKSPACE_REGISTRY` is the deliberate SD-3 trigger** to segregate the finance-scoped unions (`WorkspaceDataNeed`, `RoutedWorkspaceTab`, envelope sources) off the universal base onto a Personal-Finance specialization — anticipated by the doctrine (§E), not blocked by it. Until then, the workspaces attach locally and self-fetch. **Do not build a standalone ops dashboard** — this is the whole point of SD-2E.

---

## 8. Future operational Perspectives

The doctrine (Addendum II, ratified 2026-07-16) **explicitly sanctions non-financial Perspectives** and names "reliability over time, provider health over time, security posture over time" as valid operational/security Perspectives. A Perspective is temporal + comparative by *purpose*, domain-set by its Space. So yes — these are justified, **once time-series telemetry exists to back them** (today's widgets are current-window only; a Perspective needs history):

- **Reliability** — job success-rate and punctuality trends; deploy-correlated error trend.
- **Provider Health** — quota consumption curves, error-rate and latency over time per provider.
- **API Consumption** — token/cost curves by surface (chat vs brief vs future ambient); the dormant spend pipeline becomes a trend once priced.
- **Job Success Trends / Error Trends** — `JobRun`/error rollups over weeks.

**Hard caveat (doctrine invariant):** an operational Perspective must **not** reuse the finance `preset/asOf/compareTo` reducer verbatim — it needs its own (non-finance) time model. That is the real design work, and it hard-gates on a rollup/history substrate that does **not** exist yet (current telemetry is snapshots, not dated facts). So Perspectives are **after** SpaceShell convergence and after a rollup layer — not now.

---

## 9. Final roadmap

### Current capabilities (recap)
One-cron dispatcher + typed registry + `JobRun` ledger + dead-job detector; a live Platform Ops Space on `SpaceShell` with 5 real read-only widgets; `ApiUsageCounter` telemetry (OpenAI/Plaid); `SyncIssue`, `RateLimit`, `AuditLog`, `FxRate`, env-report as existing fact sources.

### Operational blind spots (recap)
No alerting (pull-only); execution-visible but **content-blind** (empty/stale archives invisible; `source:"none"` and vendor-gated no-ops show false-green); no FX-freshness surface; no provider quota/usage for FX (OXR usage endpoint uncalled); off-ledger automatic work invisible (SWR, Plaid webhook/connect-time); manual scripts unledgered; no time-series/history; widgets under-render available API data; seed leaves `FxRate` empty.

### Recommended Workspace organization
Overview · Jobs · Providers · API Usage · Activity (§7); operational Perspectives (Reliability, Provider Health, …) later (§8).

### Recommended widgets / telemetry / monitoring
- **Freshness assertions** per archive (FX, prices): newest-date vs expected → the single highest-value addition.
- **Provider panel** (status/quota/remaining/reset/latency/error-rate); extend `ApiUsageCounter` emission to FX/price/crypto providers so it is uniform; add one daily OXR `/usage.json` read.
- **Richer Job cards** using data the API already returns (last-run, failure-streak, cadence, next-scheduled).
- **Dispatcher/cron liveness** signal (external uptime check on the dispatcher endpoint — it is the single point of failure).
- **Manual "Run Now"** (FX first) behind WRITE + fresh-auth + lock + audit (§5).
- **Alerting** (≤5 rules) over freshness/health/quota → email.

### Priority order & slices

**Before Platform SpaceShell (registry) convergence — surfacing on today's single-Overview Space, zero architecture change:**
- **S1 — FX freshness signal (highest leverage, smallest).** Add "Archive Fresh To" to the FX job card by having `job-health` (or the FX card) read `MAX(FxRate.date)` and compare to expected. Directly closes the incident's blind spot; catches `source:"none"` false-green. *Also seed `FxRate` in `prisma/seed.ts` (or document `copy-fx-rates`) so `db:reset` is never silently cold.*
- **S2 — Surface the data the widgets already drop.** Per-job last-run/streak/cadence/next-scheduled; connection `errorCode`/`lastSyncedAt`. No new API, no schema.
- **S3 — FX provider quota.** One gated daily `GET /api/usage.json`, cached; render "API Calls Today / Remaining / Reset". Extend `ApiUsageCounter` to FX providers.
- **S4 — "Run Now" for FX** (WRITE + fresh-auth + lock + audit + `runJob(trigger:"manual")`), with a bootstrap-if-empty variant.
- **S5 — Alerting seam (≤5 rules)** — *depends on OPS-1 email.* Daily health+freshness+quota evaluation rides the dispatcher → email. Add an external uptime check on `/api/jobs/dispatch`.

**After Platform SpaceShell (registry) convergence (SD-3+):**
- **S6 — Decompose Overview into Standard Workspaces** (Jobs / Providers / API Usage / Activity) as rail tabs; register in `WORKSPACE_REGISTRY` (the trigger to segregate finance-scoped unions).
- **S7 — Rollup/history substrate** (dated ops facts from `JobRun`/`ApiUsageCounter`/errors — the PLATOPS Phase 3 idiom). Enables trends.
- **S8 — Operational Perspectives** (Reliability, Provider Health, …) with their own non-finance time model — hard-gated on S7.
- **S9 — Ledger the off-ledger paths** (SWR FX, Plaid webhook/connect-time via `runJob` or a lightweight emission) and give manual scripts a run record.
- **S10 — Light up dormant spend** (populate `UNIT_PRICES_USD`) and per-provider latency emission.

### Dependencies
- **S1–S4 depend on nothing** (surfacing over existing data on the existing Space) — do these now.
- **S5 (alerting) depends on OPS-1 email** (the only real external blocker) — this is the one true prerequisite for the "know before opening the product" goal.
- **S6 depends on the SD-3 union-segregation** decision (anticipated, not blocked).
- **S8 (Perspectives) depends on S7 (history)** — Perspectives without time-series would be hollow.

### What happens before vs. after Platform SpaceShell convergence
- **Before (now):** S1–S5 — content-aware freshness, quota, richer cards, Run-Now, and (once email lands) alerting. All attach to the current single-Overview Space. **This is where the incident is actually solved.**
- **After (SD-3+):** S6–S10 — workspace decomposition, rollup history, operational Perspectives, off-ledger convergence, spend/latency. This is the "operations as a Space with lenses over time" endgame — valuable, but not what the incident demanded.

---

## Appendix — key files
`vercel.json` · `app/api/jobs/dispatch/route.ts` · `lib/jobs/{dispatch,registry,run,health}.ts` · `jobs/fetch-fx-rates.ts` · `lib/fx/{registry,fetch,archive,service}.ts` + `providers/{openExchangeRates,frankfurter}.ts` · `lib/money/{fx-freshness,convert,context,server-context}.ts` · `prisma/schema.prisma` (`FxRate`, `JobRun`, `SyncIssue`, `RateLimit`, `ApiUsageCounter`) · `prisma/seed.ts` (no FxRate) · `components/platform/PlatformSpaceDashboard.tsx` + `widgets/Ops*.tsx` + `widget-kit.tsx` · `app/api/platform/platform-ops/*` · `lib/platform/policy.ts` · `lib/usage/{record,pricing}.ts` · `docs/architecture/SPACE_CONTRACT_DOCTRINE.md` · `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md` (superseded §1) · `scripts/{check-job-health,backfill-fx-rates,copy-fx-rates}.ts`.

*Investigation only — no runtime behavior was modified and no external APIs were called.*
