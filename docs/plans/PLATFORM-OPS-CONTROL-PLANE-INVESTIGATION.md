# Platform Ops as a control plane — investigation

**Date:** 2026-09-14 · **HEAD:** `891458f` on `v2.6` · **Status:** INVESTIGATION ONLY. No code, no schema, no UI, no permissions, no scheduler or provider behaviour changed. One temporary read-only database session was used and left nothing behind.

Every claim is a repository fact (cited `file:line`), a read-only query against the local development database, or a labelled inference.

---

## 0. Verdict in one screen

**Platform Ops is already a mature read surface with no control authority under it.** Nine workspaces, 22 READ-gated routes, three WRITE mutations, zero CONTROL-gated anything. The missing piece is not a dashboard. It is a **policy authority**: a typed description of each operational setting, what the scheduler can honour, and an audited write path. Two of those three already exist in embryo (`refresh-policy.core.ts` and `AuditLog`); the third does not.

| Decision | Answer |
|---|---|
| Is PlatformSetting sufficient? | As the **place**, yes. As a **store**, not yet: no typed descriptors, no validation at the setter, provenance is write-only, INVALID is computed then discarded. No schema change is needed to fix any of that. |
| What blocks CONTROL? | One list, `ISSUABLE_LEVELS = ["READ","WRITE"]` (`lib/platform/policy.ts:250`), ratcheted by `capability-control.test.ts`. Deliberate and unfinished, not blocked by TOTP or roles. Obligations on unblocking: a third cell in the admin matrix, one real consumer. |
| Read-only first? | **Yes, but built on the control contract.** Slice 1 is a read-only Policies surface driven by the same descriptor the editor will validate against. A pretty dashboard without that authority would have to be rebuilt. |
| First control? | **Refresh cadence.** Typed, bounded, reversible, no money, no secrets, consumers already re-derive. The maintenance and ingestion flags are the second control, and they already have an unsafe write path today. |
| Can the scheduler honour every allowed cadence? | **No.** Wallets: 6h and 12h exactly, 24h effectively, **8h is accepted by the guard but delivers 12h**, 4h impossible. Banks: 24h only. |
| Unsupported values? | Show them disabled with the reason, refuse on write, one shared authority. Never hide, never accept-and-degrade. |
| Desired / effective / actual? | Yes as three named facts in one read model, not three stores. With write-time refusal, desired and effective diverge only for an INVALID row, and that is exactly the case to display. |
| Scheduler redesign before controls? | Not for wallet 6h/12h/24h. Yes before 4h/8h or any bank cadence change: the registry needs a source binding and a continuation link so capability is derived, not hand-copied. |
| Schema changes? | **None** for the next two slices. |
| Smallest next slice? | A Policies read model and workspace, plus validation at `setSetting`, plus operator health reading policy instead of hardcoded hours. |

The product principle holds up under evidence: configuration (PlatformSetting), health (JobRun-derived), execution (RefreshExecution and JobRun summaries), and cost (AiInvocation and pricing) are four separate authorities in this repo. The work is to place them side by side, not to merge them.

---

## 1. Working-tree state

- Branch `v2.6`, HEAD `891458f`. Tracked tree clean.
- Ten untracked peer files, untouched: nine `docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-*.md` and `scripts/audit-visibility-levels.ts`.
- One stash from another branch (`feature/phase-2-architecture`), not touched.
- `f54a62b` (REFRESH POLICY, 25 files) and `891458f` (INCREMENTAL ETH HISTORY, 14 files) verified as the two most recent commits; both authored by Chris on 2026-09-13.
- No stash, reset, clean, or checkout was performed. Probe queries were read-only `psql` against `localhost:5432/fintracker`.

---

## 2. Current Platform Ops architecture

### 2.1 Entry and composition

The only render path is `app/(shell)/dashboard/platform/[area]/page.tsx`. It loads the grant, checks `hasPlatformAccess(area,"READ")`, and mounts `PlatformSpaceDashboard`. `lib/platform/workspaces.ts:119-151` owns the nine PLATFORM_OPS workspaces:

| Workspace | Sections | Routes fetched |
|---|---|---|
| Overview | scheduler, job-health, platform-health | `/scheduler`, `/job-health`, plus `/alerts`, `/provider-health`, `/resource-freshness`, `/rate-limits`, `/env-status` |
| Jobs | scheduler, job-health | same two |
| Refresh | summary, executions, coverage | `/refresh/summary`, `/refresh/executions`, `/refresh/coverage`, `/refresh/executions/[id]/timeline` |
| Providers | provider-health, provider-operations, connection-health, connection-diagnostics, api-usage, resource-freshness, email-delivery | seven routes |
| Operations | manual-operations | `/operations` GET and POST |
| Alerts | alerts | `/alerts` |
| History | history, convergence, timeline, cost | `/history`, `/convergence`, `/cost` |
| AI | api-usage, ai-trend | `/api-usage`, `/ai-usage-trend` |
| Costs | cost, ai-trend | `/cost`, `/ai-usage-trend` |

Fetching is a plain `useEffect` per widget (`components/platform/widget-kit.tsx:42-70`) deduplicated per mounted workspace. **No polling, no visibility refresh, no provider call on load anywhere** (grep for `fetch(` under the platform-ops routes returns nothing; every read authority is DB-only).

### 2.2 Route census (24 files, 25 handlers)

- **22 READ GETs**: ai-usage-trend, alerts, api-usage, connection-diagnostics, connection-health, convergence, cost, email-health, env-status, history, job-health, operations (GET), provider-health, rate-limits, **refresh-policy**, refresh/coverage, refresh/executions, refresh/executions/[id]/timeline, refresh/provider-operations, refresh/summary, resource-freshness, scheduler.
- **3 WRITE mutations** (`requireFreshPlatformAccess(...,"WRITE")`): `connections/[id]/resync` (calls Plaid, may email), `connections/[id]/request-reauth` (emails), `operations` POST (runs a registered job now, transitively calls providers).
- **0 CONTROL** anything (`capability-control.test.ts:187-198` scans every route and asserts zero).

`GET /refresh-policy` (`f54a62b`) **has no UI consumer**. It is the only route that already returns origin, grace, overdue threshold, scheduler floor and honourable cadences.

### 2.3 Map: UI → route → authority → state → provider

| Surface | Route | Authority | Persisted state | Provider |
|---|---|---|---|---|
| Job health | `/job-health` | `checkScheduledJobHealth` (`lib/jobs/health.ts:318`) | `JobRun` | none |
| Scheduler | `/scheduler` | `getSchedulerObservation` | `JobRun` + registry | none |
| Refresh ledger | `/refresh/*` | `lib/platform/refresh/projections.ts` | `RefreshExecution`, `RefreshEndpointResult`, `ProviderCall`, `RefreshEndpointAccountCoverage` | none (Plaid-only data) |
| Provider health | `/provider-health` | `lib/platform/provider-health.ts` | `JobRun`, `ApiUsageCounter`, `FxRate`, connection rows | none |
| Connection health | `/connection-health` | `lib/connections/health.ts` | `PlaidItem`, `Connection`, `AuditLog` | none |
| AI usage | `/api-usage`, `/ai-usage-trend` | `lib/platform/ai/ai-usage.ts` + `lib/usage/pricing.ts` | `ApiUsageCounter` | none |
| Cost | `/cost` | `lib/platform/cost/cost.ts` | JobRun latency series | none |
| Refresh policy | `/refresh-policy` | `loadRefreshPolicies` | `PlatformSetting` | none |
| Manual ops | `/operations` POST | `lib/platform/operations/execute.ts` | `JobRun(trigger:manual)` + `AuditLog` | yes, transitively |
| Resync | `/connections/[id]/resync` | `runFullRefresh` + admission | `RefreshExecution`, `AuditLog`, `PlaidItem.lastManualRefreshAt` | Plaid, email |

### 2.4 Classification of what exists

| Category | Exists? | Evidence |
|---|---|---|
| OBSERVE | Dominant, 20 of 25 handlers | table above |
| DIAGNOSE | Real | connection-diagnostics, execution timeline, job failure summaries |
| ACCOUNT | Real, estimate-tier only | api-usage, ai-usage-trend, cost; all labelled as estimates with `unpricedTokens`/`unpricedDays` |
| CONTROL | **Conceptual only** | five CONTROL families all `PLANNED` (`lib/platform/capability-classification.ts`) |
| AUDIT | Written, **not readable inside Platform Ops** | rows go to `AuditLog`; the feed lives in SECURITY_OPS (`sec_operator_actions`) |
| RECOVER | Thin | resync, request-reauth, run-now; `backfill`/`invalidate`/`retry` kinds reserved (`operations/registry.ts:77-138`) |

---

## 3. Authorization and capability model

- **Platform-level, structurally isolated from Spaces.** `lib/platform/policy.ts:11-14` knows nothing about `SpaceMember` or `can()`; tripwired by `lib/platform-surface.test.ts`. The page reads no Space cookie.
- **Grant model:** `PlatformGrant(userId, area, level, status)` unique per (user, area). Levels `READ < WRITE < CONTROL`, and **WRITE does not satisfy CONTROL** (`policy.ts:200-216`). Capability names are derived for display only: `PLATFORM_OPS_VIEW / _MANAGE / _CONTROL`.
- **Who can access today:** any user with an ACTIVE PLATFORM_OPS grant (UI and API), plus SYSTEM_ADMIN by break-glass bypass (`lib/platform/authorize.ts:92-94`). **SYSTEM_ADMIN never sees the console**: `proxy.ts:67-69` redirects them off `/dashboard/*`.
- **Granting:** SYSTEM_ADMIN only, via `POST /api/admin/platform-grants` and the matrix at `app/admin/platform-access/page.tsx`. No seed, no env path.
- **Dev database:** one SYSTEM_ADMIN, one user holding WRITE on all four areas (granted 2026-07-20), seven other users.
- **Affordance gap:** neither the manual-operations nor the connection-health widget reads `access.canWrite`; a READ holder sees enabled Run Now and Resync buttons and gets a 403 on click.

---

## 4. Why CONTROL is unavailable

`lib/platform/policy.ts:250`:

```ts
export const ISSUABLE_LEVELS: readonly PlatformAccessLevel[] = ["READ", "WRITE"];
```

The stated reason (`policy.ts:231-248`) is truthfulness: nothing consumes CONTROL and the admin matrix renders two cells per area, so a CONTROL grant would "confer no capability anyone asks for while displaying as no grant at all". Enforced three ways (route 400, UI pre-flight, UI disabled button) and ratcheted by `lib/platform/capability-control.test.ts`, which asserts the census of WRITE routes is exactly 11, no route names CONTROL, no `canControl` flag exists, and every CONTROL family stays PLANNED.

**Not blocked by another authority.** TOTP enforcement applies to `UserRole.SYSTEM_ADMIN` at login and `security-surface.test.ts:186` asserts `authorize.ts` never mentions it. The enum already carries CONTROL in the database (migration `20260725_ops2d2_platform_control_capability`).

**Whoever unblocks it owes, in the same change:** the third matrix cell, the first consuming route, and flipping one family from PLANNED to SHIPPED (which the test explicitly says ends its negative contract).

**CONTROL implies no Space or financial authority.** Grants are per-area with no inheritance; CONTROL cannot mint grants (`capability-classification.ts:211-225`); and admission consults no capability, so a CONTROL holder is subject to the pause they declared (`lib/platform/admission/facts.ts:84-92`).

**The unresolved question the prototype migration parked** (PM-5, "is OPS-2D admission the same concept as job policy?") has an answer from this trace: **no**. Admission (`maintenance_mode`, `ingestion_paused`) decides whether operational work may begin; refresh policy decides how often it is expected. Both are `control-plane-policy` family, both belong on a Policies surface, and they are different facts with different invalid-value semantics (deny vs default-with-origin).

---

## 5. PlatformSetting authority

Schema (`prisma/schema.prisma:3325-3330`): `key @id, value String, updatedAt @updatedAt, updatedById String?`. No FK on `updatedById`, no `createdAt`, no version column, no type column.

| Property | State |
|---|---|
| Value types | string only; five different parsers (loose bool in auth, strict bool in admission, int floor, permissive enum, normalising enum) |
| Helpers | `getAllSettings`, `getSetting` (collapses MISSING into default), `setSetting` (bare upsert, **validates nothing**), three typed getters (`lib/platform-settings.ts`) |
| Keys | 11 typed keys + one **unregistered** family `alert_rule_enabled:<id>` read by `lib/alerts/run.ts:86` with no writer |
| Missing row | three contracts: default (most keys), MISSING≠default (admission, `facts.ts:16-19`), `origin:'DEFAULT'` (refresh, `refresh-policy.core.ts:114`) |
| Invalid row | four behaviours: **deny all work** (admission), default + `INVALID_SETTING` (refresh), **fail open** (`registration_mode`, `require_totp_all_users`), floor (`min_password_length`) |
| Caching | none anywhere; every read is live. This is why a policy change propagates instantly with no invalidation seam |
| Transactions | none at any write site; the admin PATCH loops upserts then writes one audit row after |
| Audit | per call site. Growth routes record `{previous,new}` under canonical actions. Admin PATCH writes bare string `"PLATFORM_SETTINGS_UPDATED"` (not in `AuditAction`, not in any feed filter) with only the request body. The CLI script audits nothing and nulls `updatedById` |
| `updatedById` | written, **never read anywhere** |

**The highest-severity finding of this investigation.** `PATCH /api/admin/security/settings` (`app/api/admin/security/settings/route.ts:13,54`) allows every `PlatformSettingKey` and validates only `registration_mode` and the TOTP lock. A SYSTEM_ADMIN can today write `refresh_cadence_wallet = "4h"` (below the scheduler floor the read route says the write path must refuse), or `maintenance_mode = "yes"` (which `policy-core.ts:146-151` treats as INVALID and **denies all refresh and connection work platform-wide**). The admission model's own safety argument (`policy-core.ts:112-114`, "an invalid value can arrive only by direct database edit") is false because of this route. The admin console does not render those keys, so the exposure is API-only, but it is live.

**Verdict:** the right place, not yet a strong enough store. Missing before CONTROL: typed key descriptors (type, allowed values, default, validator, classification, write capability), validation inside `setSetting`, an observable INVALID state, previous-value audit, and a concurrency check. All are code; none need a migration.

---

## 6. Operational-policy inventory (condensed)

The full 194-row inventory is in the investigator trace; the operationally relevant rows:

| Policy | Value | Authority | Location | Class |
|---|---|---|---|---|
| Bank cadence | 24h | PlatformSetting (absent → default) | `refresh-policy.core.ts:53` | OPERATOR CONFIGURABLE |
| Wallet cadence | 6h | PlatformSetting | `:54` | OPERATOR CONFIGURABLE |
| Cadence menu | 4h,6h,8h,12h,24h | code | `:39` | VISIBLE, CODE CONTROLLED |
| Grace | max(2h, 25%) | code | `:67-68` | VISIBLE, CODE CONTROLLED |
| Scheduler floor | BANK 24, WALLET 6 | code, hand-mirrors vercel.json | `:62-65` | DEPLOYMENT CAPABILITY (should be derived) |
| Cron slots | `0,30 0,6,7,12,18` | vercel.json | `vercel.json:5-8` | DEPLOYMENT CONFIGURATION |
| Dispatch maxDuration | 300 s | code | `app/api/jobs/dispatch/route.ts:48` | DEPLOYMENT CONFIGURATION |
| Wallet sweep budget | 90 s | code, sized against the old 157 s ETH sync | `lib/crypto/wallet-refresh.ts:56` | VISIBLE, CODE CONTROLLED |
| Job-health thresholds | grace 2h, streak 3, stale-running 2h, dead ×3 | code | `lib/jobs/health.ts:64-84` | VISIBLE, CODE CONTROLLED |
| Job expectedEveryHours | 6 for crypto, else 24 | registry literal | `lib/jobs/registry.ts:134,146` | VISIBLE (should follow policy) |
| Operator staleness | Plaid 48h, wallet 12h | code, **stale copy of policy** | `lib/connections/health.ts:60-62` | must become DERIVED |
| Manual refresh cooldown | 1h | code | `lib/plaid/refreshCooldown.ts:19` | VISIBLE (promotion candidate) |
| Plaid retries | 2 attempts, 1 s flat | code | `lib/plaid/retry.ts:29-32` | VISIBLE |
| Brief failure cooldown | 3 min | code | `lib/ai/brief/policy.ts:31` | VISIBLE |
| Alert rule enablement | per rule | PlatformSetting, unregistered, no writer | `lib/alerts/rules.ts` | OPERATOR CONFIGURABLE (orphaned) |
| Maintenance / ingestion paused | absent → off | PlatformSetting | `lib/platform-settings.ts:83-84` | OPERATOR CONFIGURABLE (unsafe writer) |
| AI model | env `AI_CHAT_MODEL`, default gpt-4o-mini | environment | `lib/ai/provider.ts:63` | DEPLOYMENT CONFIGURATION |
| AI rate card | 8 models, effective 2026-09-08 | code | `lib/usage/pricing.ts:70-86` | FINANCIAL SEMANTIC, NOT EDITABLE |
| Plaid rate card | $0.30 / $0.35 per Item-month | code, one invoice | `:129-135` | FINANCIAL SEMANTIC, NOT EDITABLE |
| Rate limits | 25 endpoints | code | `lib/rate-limit.ts` call sites | SECURITY SENSITIVE |
| `QUANTITY_AUTHORITY_MODE` | off/compare/adopt | environment | `lib/env.ts` | FINANCIAL SEMANTIC, NOT EDITABLE |
| Ingestion caps | 5000 rows, 800 days | code | `lib/ai/assemblers/transactions.ts:207,261` | FINANCIAL SEMANTIC |
| `AI_FORECAST_GUARD_MODE` | **does not exist** (removed with five siblings) | — | `lib/env.ts` | — |

PlatformSetting carries about 6% of the policy surface. That proportion is correct; most of the rest should stay code-owned.

---

## 7. Policy taxonomy

Yes, the classes are needed, and five of them belong on a Platform Ops surface:

| Class | On Platform Ops? | How |
|---|---|---|
| OPERATOR CONFIGURABLE | Yes | editable when CONTROL exists; read-only with origin until then |
| OPERATOR VISIBLE, CODE CONTROLLED | Yes, selectively | shown beside the setting they constrain (grace beside cadence, budget beside the wallet job); never a knob |
| DERIVED | Yes | the consequences panel (overdue threshold, due-after, expected slots) |
| PROVIDER FACT | Yes | as provider facts (CoinGecko 365-day window, Plaid has no quota API) |
| DEPLOYMENT CONFIGURATION / CAPABILITY | Yes, as capabilities | slot period, max duration, wake schedule; never editable from the UI |
| SECURITY SENSITIVE | No | stays in the admin security console under SYSTEM_ADMIN |
| FINANCIAL SEMANTIC, NOT EDITABLE | No | rate cards, money switches, ingestion caps stay in code |

The class must live on the descriptor, not in UI copy, so that the read surface, the write guard and the tests all read one table.

---

## 8. Refresh policy: current state

- Keys `refresh_cadence_bank` / `refresh_cadence_wallet`; defaults 24h / 6h; enum 4h–24h; grace `max(2h, 25%)` giving overdue at 30h / 8h (pinned in `refresh-policy.core.test.ts:53-58`).
- The resolver is pure and the only parser. The loader never throws and falls back to defaults on an unreadable table.
- `origin` is `DEFAULT | SETTING | INVALID_SETTING`; `version` is `kind:cadence:updatedAt|default`. `version` has exactly one consumer: stamped into the wallet sweep's `JobRun.summary`.
- **Dev database right now:** no cadence rows exist. Both policies are `origin: DEFAULT`. Bank overdue after 30h, wallet after 8h.
- **Write path:** none in the app by design (`refresh-policy/route.ts:11-18`), except the unvalidated admin PATCH in §5.
- **Tier seam:** `RefreshPolicyRequest.tier?: never` in the pure core (`:84-88`). The loader `loadRefreshPolicies()` takes no subject, so a per-tier resolve needs a subject argument threaded from three call sites. The pure seam is ready; the loader signature is not. A paid tier could not go faster than the scheduler floor without a cron change.

---

## 9. Scheduler capability

### 9.1 What the dispatcher does

Ten wakes per day at `00:00, 00:30, 06:00, 06:30, 07:00, 07:30, 12:00, 12:30, 18:00, 18:30` UTC, bucketed to half-hour slots. Jobs per wake (`lib/jobs/registry.ts`):

| Wake | Jobs |
|---|---|
| 00:00 / 12:00 / 18:00 | sync-crypto |
| 00:30 / 12:30 / 18:30 | sync-crypto-continuation |
| 06:00 | **sync-banks then sync-crypto** in one 300 s invocation |
| 06:30 | fetch-fx-rates, fetch-security-prices, sync-crypto-continuation |
| 07:00 | process-deletions |
| 07:30 | notification-cleanup, notification-retry, purge-trash, rate-limit-sweep, evaluate-alerts |

The continuation is the same body with `continuation:true` (skips capability reconciliation); it exists because the sweep stops starting wallets after a 90 s budget. `resume-stale-imports` runs on its own 5-minute cron outside the registry and is invisible to job health.

**The dispatcher reads no policy.** The only policy consumer at job time is the wallet due filter (`lib/crypto/wallet-refresh.ts:196`). `sync-banks` has no due filter at all: it syncs every ACTIVE item daily regardless (`jobs/sync-banks.ts:164-171`). The comment in `app/api/jobs/dispatch/route.ts:10-12` about two no-op slots is stale since `f54a62b`.

### 9.2 Policy resolver supports vs scheduler can honour

`isDueForScheduledRefresh` uses `dueAfter = max(1, cadence − grace)`. Attempts happen only at 6h slot multiples. The success clock lands seconds after slot start, so at the next slot the age is just under the slot spacing.

| Cadence | dueAfter | WALLET actual | BANK actual | `schedulerCanHonour` says |
|---|---|---|---|---|
| 4h | 2h | 6h | 24h | refused (correct) |
| 6h | 4h | **6h exactly** | 24h | accepted (correct) |
| 8h | 6h | **12h**: age at +6h is just under 6h, not due until +12h | 24h | **accepted (wrong)** |
| 12h | 9h | **12h exactly** | 24h | accepted (correct) |
| 24h | 18h | 24h (band 18–24h) | **24h exactly** | accepted (correct) |

**Correct honourability is "a multiple of the attempt period", not "≥ floor".** Wallets honour {6h, 12h, 24h}; banks honour {24h}. The guard should either be corrected to that rule or the due computation should tolerate slot jitter. Either fix belongs in `refresh-policy.core.ts`, the one shared authority.

### 9.3 Can capability be derived?

**Not today.** `SCHEDULER_FLOOR_HOURS` is a hand-maintained copy. The registry entry `{name, hourUTC, minuteUTC, expectedEveryHours?, run}` has **no source-kind binding** and **no continuation link**, so nothing declares that sync-crypto refreshes WALLET sources or that the :30 entry is the same work. A naive derivation from slot spacing would compute a 30-minute wallet period. The test at `refresh-policy.core.test.ts:82` compares the constant to itself, not to `SCHEDULED_JOBS`.

Needed (code only): `refreshes?: RefreshSourceKind` and `continuationOf?: string` on `ScheduledJob`; a pure `attemptPeriodHours(registry, kind)` that `schedulerCanHonour` reads; a test that the derived period matches `vercel.json`.

### 9.4 Two cadences that disagree

`expectedEveryHours` for job health is a registry literal (6 for crypto). `RefreshPolicy.expectedEveryHours` is the setting. Set wallets to 12h and job health will flag sync-crypto **overdue at 8h** while the sweep correctly no-ops at alternate slots. Job health must read the resolved policy for source-bound jobs before the editor ships.

---

## 10. Desired, effective, actual

Recommend three named facts in one read model, composed at read time, no new store:

| Fact | Source | Already exists? |
|---|---|---|
| DESIRED | the PlatformSetting row (or its absence) | yes: `origin` + raw value |
| EFFECTIVE | `resolveRefreshPolicy` output (cadence, grace, overdue) | yes |
| CAPABILITY | what the deployed scheduler attempts (§9.3) | partially (hand-copied constant) |
| ACTUAL | last sweep's `JobRun.summary.policy` + slot evidence + source clocks | yes (`wallet-refresh.ts:204` stamps the policy version) |

With write-time refusal of unsupported values, DESIRED and EFFECTIVE differ only when a row is INVALID (a legacy write or SQL edit). That is the one mismatch the UI must render as "setting unreadable, default in force", never as configured. ACTUAL differing from EFFECTIVE (the last sweep ran under an older policy version) is the second honest state and is already detectable from the stamped version.

---

## 11. Policy-change lifecycle

**Today, verified:** PlatformSetting write → `loadRefreshPolicies` (live query) → `deriveSourceHealth` → Connections page (`space-data.ts:405`) and Brief data health → Brief watermark moves (`watermark.ts:166-167`, its own md5 over the two rows) → digest compared → regenerate only if material. Commit message of `f54a62b` records the measurement: 6h→12h moved the watermark, digest equal, no model call.

**No provider refresh occurs on a policy change.** Every path from the setting to the UI is read-only by declaration (`space-data-health.ts:11-14`, `lifecycle.ts:35-36`). The only provider-calling code, `refreshScheduledWallets`, is reached only from the cron-dispatched job. A change edits the due filter that the next slot evaluates; nothing runs at write time.

**Three things the lifecycle does not do yet:** the operator-side `connection-health` keeps its hardcoded 48h/12h; job health keeps its registry literal; nothing records the change under a canonical audit action with the previous value.

**Future control lifecycle** (all code, one transaction where possible):

propose → validate against descriptor (enum, `schedulerCanHonour`) → authorize (`requireFreshPlatformAccess("PLATFORM_OPS","CONTROL")`) → read current row for previous value and concurrency token → write (or delete for reset) → audit row with previous/new value and origin → return the resolved policy. Consumers re-derive on their next read because nothing is cached. No AI call, no provider call.

---

## 12. Audit infrastructure

`AuditLog` (`schema.prisma:3102-3118`): `userId, spaceId, action String, metadata Json, ipAddress, userAgent, performedByAdminId, createdAt`. No `result`, no `target`, no correlation column. `lib/audit.ts` keeps one pure shape helper (`buildAuditData`: actorType, result, target folded into metadata) with two consumers; ~40 sites write `db.auditLog.create` directly.

For "wallet cadence 6h → 12h":

| Fact | Recordable with current columns? | Recorded by any writer today? |
|---|---|---|
| actor, timestamp | yes | yes |
| setting key, new raw value | yes (metadata) | admin PATCH: yes, as the request body |
| previous value | yes (metadata) | admin PATCH: **no**; growth routes: yes |
| previous / new origin | yes (metadata) | **no** |
| previous / new effective threshold | yes (metadata) | **no** |
| correlation id | metadata only, unindexed | **no** |
| success / failure | metadata only | **no**; failed writes leave no row |

**Sufficiency:** the row shape is sufficient; the writers are not. Needed: two canonical actions (`PLATFORM_POLICY_CHANGED`, `PLATFORM_POLICY_RESET`) added to `AuditAction` and to `OPERATOR_ACTION_FEED_ACTIONS`, metadata `{key, previous:{value,origin,effective}, next:{value,origin,effective}, result}`, written in the same transaction as the setting. The existing off-canon `"PLATFORM_SETTINGS_UPDATED"` should be retired in favour of the canonical action. No new audit infrastructure.

---

## 13. Cost authorities

| Authority | Usage | Price | Class | Wired to Platform Ops? |
|---|---|---|---|---|
| AI daily counter (`ApiUsageCounter`) | exact tokens incl. cached | `AI_RATES`, 8 models, effective 2026-09-08 | ESTIMATED, high confidence | yes (`/api-usage`, `/ai-usage-trend`) |
| AI per-invocation (`AiInvocation`) | exact per call, latency, tool calls, surface, environment | same, read-time | ESTIMATED | **no reader** |
| Plaid Item-months (`lib/platform/plaid/item-months.ts`) | derived from `PlaidItem.createdAt` + status ledger | $0.30 / $0.35, one invoice | ESTIMATED, evidence-scoped | **no reader** |
| Plaid calls | counted per method | none by design | NOT A COST SIGNAL | yes (provider-operations) |
| Crypto RPC | **nothing persisted** | none | UNAVAILABLE | — |
| Crypto sweep | attempts, outcomes, per-chain ms in `JobRun.summary` | none | KNOWN USAGE, PRICE UNKNOWN | via job-health summary only (never forwarded) |
| FX / prices | provenance per row | none | UNAVAILABLE for cost | freshness only |
| Jobs compute | `JobRun.durationMs` | no Vercel rate | KNOWN USAGE, PRICE UNKNOWN | yes (`/cost`, tiered) |

`lib/platform/cost/cost.ts:96-108` already returns `spend-usd: null, tier: "unknown"` rather than a fake total. That is the pattern to keep.

## 14. AI accounting

One chokepoint (`lib/ai/provider.ts:93-124`) writes both the daily counter and the invocation row after every SDK call; a test pins `recordAiInvocation(` to exactly one site. Both `/api/ai/chat` (surface `chat`) and the Daily Brief (surface `brief`) write rows. Cost is computed at read time from an effective-dated rate; a model outside the table is reported as unpriced, never zero. Subset-aware pricing means `(prompt − cached) × input + cached × cachedInput`; the commit `75d0eab` measured the naive form at 5.5× the truth. No `userId`/`spaceId` is stored, so per-user cost is structurally impossible and that is deliberate.

## 15. Plaid accounting

Billable unit is the Item-subscription-month per product, established from invoice `S-J7Y5657ZK0-2607`. `item-months.ts` derives the census from existing rows, excludes seeded demo items (9 of 13 locally), never treats NEEDS_REAUTH as retirement, returns both cycle readings with an `agree` flag, and reports coverage as a lower bound when evidence is incomplete. Nothing consumes it.

## 16. Crypto usage

Persisted: sweep aggregates in `JobRun.summary` (total, notDue, attempted, succeeded, failed, deferred, byChain durations, failureStages, policy version), per-wallet failures as `SyncIssue{WALLET_SYNC_FAILED, detail.stage}`, success clocks on `FinancialAccount.lastUpdated` and `Connection.lastSyncedAt`, and `PositionCoverage`. **Not persisted:** per-wallet durations, request counts, provider identity. The "18 requests / 4.7 s vs 551 / 158 s" figures exist only as source comments. No `RefreshExecution` is ever opened for a wallet, so the whole Refresh workspace is blind to crypto.

---

## 17. Job-health authority

`checkScheduledJobHealth` (`lib/jobs/health.ts`) reads 50 rows per registered job. Per job: expected cadence (registry literal), last attempted (persisted), last completed (**any status**, not last success), duration, result, consecutive failures, overdue (`> cadence + 2h`), dead (`> 3 × cadence`), next expected slot (derived from registry). Gaps: no `lastSucceededAt`; `JobRun.summary` is never forwarded to the route so a paused run and an idle run look identical; `resume-stale-imports` has no health; the dispatcher tick itself is unobservable; `dead` raises no alert (only `overdue` and `failing` do, `lib/alerts/evaluate.ts:65-90`); cron bank refreshes never set `parentJobRunId`, so executions are not correlated to their job.

**Verdict:** sufficient for a useful dashboard without a new telemetry system. The four fixes above are small and code-only.

## 18. Provider-health authority

`PROVIDER_SPECS` knows two providers: PLAID and OPEN_EXCHANGE_RATES. AI, ETH, BTC, SOL, Tiingo, CoinGecko and email have no card (email has its own route with a documented gap: auth emails bypass the delivery ledger). No route makes a live call. **A single user's NEEDS_REAUTH item flips Plaid to FAILING** (`provider-health.ts:356-361, 393-397`) with no denominator. Persisted evidence per provider is strong for Plaid (`ProviderCall` with Plaid request ids and error codes) and weak-to-absent for everything else (SyncIssue stage counts only).

## 19. Source health vs platform health

Two non-reconciled models exist: the customer one (`space-data-health.core.ts`, oldest-account clock, policy-driven threshold, viewer-relative labels) and the operator one (`lib/connections/health.ts`, connection clock, **hardcoded 48h/12h**). The seam to hold: Platform Ops must not adopt the customer vocabulary (it is viewer-relative), Connections must not adopt the operator one, and **both must share the threshold**, which means `health.ts` reads `loadRefreshPolicies()`.

Platform Ops owns: job executing normally, counts of overdue / reconnect-required / degraded sources with a capped drill-down (which `getConnectionHealth` already returns as `{total, counts, unhealthy[≤20]}`). Connections owns per-source detail. A platform-wide count is two or three grouped queries on `PlaidItem.status/lastSyncedAt` and `Connection.provider/status/errorCode/lastSyncedAt` plus one settings read; strictly cheaper than today's pull-every-row-into-JS.

---

## 20. Real-data picture (development database, read-only)

| Question | Answer now |
|---|---|
| Refresh policies | Bank 24h DEFAULT, wallet 6h DEFAULT; no rows exist |
| PlatformSetting rows | 5, all security keys, seeded 2026-07-19, `updatedById` null |
| Job states | **JobRun has 0 rows.** Crons never fire locally, so job health cannot be demonstrated from dev data at all. Production would differ; not probed |
| Grants | 4 rows: one user WRITE on all four areas |
| Bank sources | 13 PlaidItems: 12 ACTIVE (9 never synced, seeded demo), 1 NEEDS_REAUTH for 26 days, 0 overdue against 30h |
| Wallet sources | 5: 1 ETH, 1 SOL, 3 BTC; three real wallets synced minutes ago; 2 demo BTC rows 96 days stale (would count as overdue against 8h) |
| Refresh executions | 83 all-time, 67 MANUAL succeeded, 3 MANUAL failed, 1 PARTIAL; latest 2–8 s each |
| Provider calls | 209, all PLAID; 3 `accountsGet` failures, 0 rate-limited |
| Sync issues open | 8 UPSERT_ERROR, 7 REMOVED_TOMBSTONE, 2 BALANCE_TX_MISMATCH, 2 WALLET_SYNC_FAILED (last 2026-09-13) |
| AI invocations | 1,134 rows since 2026-09-08, 890 today, all `development`; 8.6M prompt tokens of which 6.87M cached; surfaces dominated by `harness`/`slicec`, 40 `chat`, 13 `brief` |
| AI cost from the repo rate table | **≈ $3.99 today, ≈ $5.11 all five days**, nearly all gpt-5.1 (uncached $1.25/M, cached $0.125/M, output $10/M) |
| Plaid usage | 41 calls in 14 days; 4 non-demo items ⇒ 4 transactions Item-months plus investments where consented |
| Crypto job status | not derivable (no JobRun rows); `PositionCoverage` COMPLETE for ETH (2017-10-16..), BTC (2023-03-18..), SOL (2022-03-26..) |
| Audit | 2,018 rows; 0 setting-change rows ever; 3 dry-runs, 4 grants, 2 resyncs; 1,565 `AI_CONTEXT_ASSEMBLED` in 30 days dominate the table |

A next dashboard would be genuinely useful in production (where JobRun and cron evidence exist) and would show mostly defaults and demo data locally. The **AI cost panel is the one surface with rich real data right now**, and its finest grain has no reader.

---

## 21. Security and privacy boundary

Verified clean: no secret values, no balances, no transaction content, no raw provider payloads on any platform-ops route; env-status returns names and pass/warn/fail only; rate-limits strips the subject segment.

Flags, ranked:

1. **Convergence leaks customer account display names** (`institution · accountName`) into episode titles and narratives (`lib/platform/convergence/convergence.ts:167-171`, `participants.ts:172`) while its type doc says no PII.
2. **Connection diagnostics puts customer emails behind PLATFORM_OPS READ**, the same grant as pure monitoring (`lib/platform/connection-diagnostics.ts:199,251`). Deliberate and documented, but it makes a monitoring grant a customer directory.
3. **Alerts returns an env value** (`PLATFORM_ALERTS_EMAIL`), contradicting the env-status doctrine.
4. Raw `errorSummary` free text reaches the operator audience via convergence and refresh executions.
5. `rate-limits` `bucketOf` returns short keys unchanged (fails open on a malformed two-segment key).

For Platform Ops the minimum financial detail is: counts, ages, statuses, error codes, institution names, opaque connection ids. Nothing else is needed for any control in this plan.

---

## 22. Read-only dashboard recommendation

Option B, modified: **first a Policies read surface built on the descriptor the editor will use, then CONTROL.** Not A (an editor on top of an unvalidated setter and a hand-copied capability constant would ship the §5 hole with a nicer face). Not C in full (the CONTROL grant change is a contract change with its own obligations and deserves its own slice). The read slice is not "a pretty dashboard": it is the authority (descriptor, capability, effective/actual composition, audit read) that the editor is one PUT away from.

## 23. Control architecture recommendation

- **Descriptor registry** (code, one file next to `lib/platform-settings.ts`): per key `{key, type, allowedValues | range, default, classification, writeCapability, area, validate(raw), honourable?(value) }`. The refresh keys' validator delegates to `parseRefreshCadence` + `schedulerCanHonour`.
- **`setSetting` validates** against the descriptor and refuses otherwise. The admin PATCH inherits the fix for free.
- **Write route** `PUT /api/platform/platform-ops/policies/[key]` and `DELETE` for reset, gated `requireFreshPlatformAccess("PLATFORM_OPS","CONTROL")`, transactional with the audit row, returning the resolved policy.
- **Read route** extends `/refresh-policy` into `/policies`: desired, effective, capability, actual, last change (from audit), consequences.
- **Unblock CONTROL**: add it to `ISSUABLE_LEVELS`, the third matrix cell, flip `control-plane-policy` to SHIPPED, revise `capability-control.test.ts` §5 as its header instructs.

## 24. Unsupported-value behaviour

Disable in the UI with the reason from the descriptor, and refuse on write with the same reason, both from `schedulerCanHonour` corrected to slot-multiple semantics. Hiding removes the roadmap signal (4h is in the enum "for the day the scheduler can"). Accepting with a degraded badge would declare sources overdue that nothing attempts, which is precisely the false state the floor exists to prevent.

## 25. Reset-to-default semantics

**DELETE the row.** The resolver already distinguishes no-row (`origin: DEFAULT`, version `…:default`) from an explicit row equal to the default, a future change to the code default then propagates, the watermark md5 changes either way, and the audit row records the reset as its own action. Writing the default value would freeze today's default into a fact and mis-report origin forever.

## 26. Concurrent-edit recommendation

Optimistic concurrency using `updatedAt` as the token; no version column needed. The client sends the token it displayed (`updatedAt` ISO or the literal `default`). The server performs a conditional `updateMany({where:{key, updatedAt: expected}})` and treats count 0 as 409; for a first write it `create`s and treats a unique violation as 409; for reset it `deleteMany` with the same predicate. Two operators racing get one success and one "policy changed since you loaded it".

## 27. Tier seam

Correct and present in the pure core. Future per-tier override goes inside `resolveRefreshPolicy` between parse and selection. Two prerequisites: `loadRefreshPolicies` gains a subject, and the tier value can never exceed the scheduler capability for that source kind.

## 28. Deployment-capability seam

Expose as **capabilities**, read from the registry and code constants, never editable: attempt period per source kind (6h wallet, 24h bank), dispatcher wake schedule, max job duration 300 s, wallet sweep budget 90 s. Show them only on the Policies surface beside the settings they constrain; keep the rest (per-route maxDuration, pool size) out.

---

## 29. Information architecture

Keep the nine workspaces. Change the Overview to answer the control-plane question in order, and add one workspace.

**Overview (≈10 seconds):**
1. Policy in force: "Banks every 24h (default) · Wallets every 6h (default)". Supportable now.
2. Jobs: healthy / overdue / failing / dead counts. Supportable in production.
3. Sources: N bank connections need reconnect · N wallets overdue against policy. Supportable with the grouped queries in §19.
4. Providers: Plaid, OXR trust with a denominator. Partially supportable (denominator fix needed).
5. AI: estimated spend today / 30 days, unpriced tokens. Supportable now.
6. Recent operational events: job failures, manual runs, resyncs, reauth requests, grant changes. Supportable now from JobRun + AuditLog; policy changes join once they have a canonical action.

**Policies (new):** financial refresh (bank, wallet) with desired / effective / capability / actual / consequences / last change; control-plane flags (maintenance, ingestion) read-only with origin; alert rule enablement listed as "set by database only" until it has a writer.

**Jobs, Refresh, Providers, Operations, Alerts, History, AI, Costs:** unchanged in shape. Costs gains the AiInvocation and Item-month readers later.

**Audit:** a section in Platform Ops filtered to `OPERATOR_ACTION_FEED_ACTIONS` plus the policy actions, so a PLATFORM_OPS holder can see their own trail without a SECURITY_OPS grant.

SHIP NOW: Policies read, Overview policy strip, source counts. NEXT: cadence editor, audit section, provider denominator. LATER: dynamic scheduler, crypto execution ledger, cost expansion.

## 30. Query and performance design

Overview cost with existing indexes: 1 settings read; 1 `JobRun` query per registered job (11; can collapse to one `DISTINCT ON (jobName)` raw query later); 1 `PlaidItem` groupBy; 1–2 `Connection` groupBys; 1 `SyncIssue` count; 1 `ApiUsageCounter` window read; 1 `AuditLog` recent read. About 17 indexed queries, no provider call, no per-Space context, no N+1. Reads stay on page load; no polling for beta. The two known expensive reads (`history` at 4 × jobs queries with `compareTo`; `space-data.ts:228` uncapped audit read on the customer page) are outside the overview.

## 31. Refresh and live-data semantics

Read persisted state on load and on workspace switch (already the behaviour). Add refresh-on-visibility-change for the Overview only. No polling in beta: jobs move on a 6h clock, policy moves when an operator moves it, costs move per invocation but are estimates. A manual "Refresh" affordance on the Jobs and Refresh panels is enough.

---

## 32. Future test matrix

**READ:** authorised READ 200; no session 401; no or revoked grant 403; SYSTEM_ADMIN bypass on the API; no secret, email, balance or env value in any policies response (source-scan test like `connection-ops-guards.test.ts`); default origin when no row; SETTING origin with an explicit row; INVALID_SETTING surfaced with the default in force; capability list equals the registry-derived attempt period; job health counts against fixtures; source counts equal grouped SQL; degraded states (settings table unreadable → defaults + flag).

**CONTROL:** WRITE holder gets 403 on PUT and DELETE; CONTROL holder 200; value outside the enum 400; cadence not honourable 400 with reason; update writes row + audit in one transaction (inject a failing audit write and assert no row change); reset deletes the row and audits; stale token 409; no provider client is imported by the route (source scan); consumers re-derive (Connections and Brief health thresholds move; watermark moves; digest unchanged ⇒ no model call, reusing `daily-brief-lifecycle.check.ts`).

**CROSS-SURFACE:** Platform Ops effective policy equals Connections policy equals Brief policy (one loader); operator `health.ts` threshold equals the policy threshold; capability equals `SCHEDULED_JOBS` (a change to `hourUTC` fails the test); AI totals on the overview equal `priceAiUsage` over the same window; Item-month totals equal `item-months.ts`.

## 33. Schema and migration needs

**None for slices 1 and 2.** Everything composes `PlatformSetting`, `JobRun`, `RefreshExecution`, `SyncIssue`, `PlaidItem`, `Connection`, `AuditLog`, `AiInvocation`. Later candidates, each with a specific reason: a nullable `sourceRef` on `RefreshExecution` (or a sibling table) if wallets are to enter the refresh ledger; an indexed correlation column on `AuditLog` only if cross-referencing policy changes to executions becomes a real operator workflow. No "PlatformOps" table.

---

## 34. Recommended implementation slices

**Slice 1 — Policy authority and read surface (no CONTROL, no schema).**
Descriptor registry; `setSetting` validates (closes the §5 hole); `schedulerCanHonour` corrected to slot multiples; registry gains `refreshes` and `continuationOf`; `attemptPeriodHours` derived and tested against `vercel.json`; job health reads policy for source-bound jobs; `lib/connections/health.ts` reads policy; `/policies` read route (desired/effective/capability/actual/consequences/last change); Policies workspace; Overview policy strip and source counts; canonical `PLATFORM_POLICY_*` audit actions defined (unused until slice 2); `read` widgets hide WRITE affordances for READ holders.

**Slice 2 — CONTROL and the cadence editor.**
CONTROL issuable with the third matrix cell; PUT/DELETE policy route with validation, fresh CONTROL, transaction, audit, optimistic concurrency; editor UI with consequences copy generated from the descriptor and resolver (overdue threshold, attempts per day as "2× / 0.5× current refresh opportunities", "does not refresh anything now"); `control-plane-policy` flipped to SHIPPED; Audit section in Platform Ops.

**Slice 3 — Maintenance and ingestion flags on the same surface.** Same route family, same descriptor, strict boolean validator, admission already enforces. Retires the only unsafe write path for them.

**Slice 4 — Cost and crypto visibility.** Wire `invocation-economics.ts` (cost by surface, environment, day) and `item-months.ts` into Costs; forward a redacted `JobRun.summary` for sync-crypto into job health so wallets attempted / succeeded / failed / deferred and per-chain durations are visible; provider-health denominator; ETH/BTC/SOL provider cards from SyncIssue stage counts.

**Slice 5 — Dynamic scheduler (only when a cadence outside {6h,12h,24h}/{24h} is wanted).** Hourly wake; `sync-banks` gains the due filter and a work budget; continuation entry retired; daily jobs guarded by last-run; capability then derives to all five cadences.

## 35. Risks and open questions

- The §5 admin PATCH hole is live now and independent of this roadmap. Fix it in slice 1 or earlier.
- `capability-control.test.ts` is a negative contract by design; slice 2 must revise it deliberately, not weaken it.
- Production JobRun evidence was not probed; the dashboard's job panels are untestable locally beyond fixtures.
- Provider health without a denominator will mislead the moment a second customer needs reauth.
- `WALLET_SWEEP_BUDGET_MS` is sized for a world before `891458f`; not a blocker, but the continuation job's reason for existing has weakened.
- Alert rule enablement is a policy family with no registry entry and no writer; decide whether it joins the descriptor or is removed.
- Whether policy versions should generalise: only two consumers exist (sweep stamp, Brief md5). Do not generalise until a third policy needs watermark participation; then replace the hand-written SQL `IN` list with a descriptor-driven one.

## Verdict

**SHIP NEXT:** Slice 1 as specified, with the `setSetting` validation and the honourability correction treated as defects rather than features.
**MODIFY:** the brief's assumption that read-only and control are alternatives; the read slice is the control authority minus the write route.
**BANK:** the dynamic scheduler, the wallet execution ledger, crypto cost, and any per-tier cadence, until a concrete cadence outside the honourable set is wanted.
