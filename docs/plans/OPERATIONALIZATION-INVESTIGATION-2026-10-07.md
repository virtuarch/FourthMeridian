# Project OPERATIONALIZATION — investigation / architecture recon

**Date:** 2026-10-07 · **Branch:** `v2.6` @ `f541133` · **Mode:** read-only archaeology. Nothing was implemented, migrated, committed or mutated. Production evidence is quoted only from the read-only census already recorded in `docs/operations/production-cutover-plan.md` §1 (2026-10-06); development-database counts are labelled **[DEV DB]**.

Tags on findings: **FACT** (read in code/schema/config) or **INFERENCE** (reasoned, not executed). Classification vocabulary: DEFECT · DESIGN DEBT · MISSING CAPABILITY · PRESENTATION GAP · OPERATIONAL GAP · INTENTIONAL BOUNDARY.

Prior investigations this report builds on rather than repeats: `docs/architecture/OPERATIONAL_TRUTH_SPINE.md` (§J IA, §K gap analysis, §L roadmap), `docs/plans/PLATFORM-OPS-CONTROL-PLANE-INVESTIGATION.md` (2026-09-21), `docs/plans/PLATFORM-OPS-COST-ACCOUNTING-INVESTIGATION.md` (2026-09-09), `docs/plans/AI-BETA-COST-ECONOMICS-INVESTIGATION.md` (2026-09-08), `docs/plans/Platform-Ops-Prototype-Production-Migration.md` (2026-07-27).

---

## 1. Executive assessment

### How operable is 4M today without engineering tools?

**Much more than the brief assumes, and much less than it looks.** The product already contains a grant-gated internal control plane built on the universal Space architecture: five Platform areas, eight PLATFORM_OPS workspaces, roughly sixty read routes, thirteen audited write-action families, a six-domain operations cockpit, an immutable refresh ledger with row-level inspection, an alert engine, a complete beta-admission loop, and cost estimates computed from versioned rate cards over immutable facts. Production already carries four ACTIVE WRITE grants on a non-admin account and four Platform Spaces (cutover plan §1).

What breaks the "random Thursday" test is not missing dashboards. It is six structural facts:

1. **The role wall.** `proxy.ts:146-147` redirects every `SYSTEM_ADMIN` request under `/dashboard/*` to `/admin`, and grants can only be issued to `role === USER` (`app/api/admin/platform-grants/route.ts:110-117`). The founder's admin account cannot open any Platform Space; Platform Spaces cannot see owner emails or Plaid `item_id`s; `/admin` cannot see health, incidents, executions or the beta queue. Two accounts, two halves of the picture. (FACT — INTENTIONAL BOUNDARY producing an OPERATIONAL GAP; `docs/operations/admin-operations.md:16-18` describes a break-glass path to HQ areas that the proxy makes unreachable.)
2. **The drill-down stops at "which user".** Connection health rows carry no owner by design (`lib/connections/health.ts:41-58`); diagnostics carry `ownerRef` = last six characters of the user id; the Users widget never renders ids; incidents name institution and account only. No entity detail page exists for a User, Space or PlaidItem on either surface. Scan-enforced (`lib/platform/observability-privacy.test.ts`).
3. **The owner hears about breakage last.** Alerts evaluate once a day at 07:30 UTC with a 20-hour re-notify window, go to email only, and the destination (`PLATFORM_ALERTS_EMAIL`) is optional in production. AI provider failure writes no fact at all (`AiInvocation` records successes only), so the Oct 4 "Couldn't update" Brief outage (OpenAI credits) was discovered by a user. Job failures do not reach Sentry (`lib/jobs/dispatch.ts:99-105`).
4. **Alert noise from day one.** REVOKED items are counted as acutely unhealthy forever (`lib/alerts/evaluate.ts:42-46`; `lib/platform/ops/overview-core.ts:138`), and production has three REVOKED Items. The `provider-unhealthy` critical email will fire daily and the Overview "Sources" verdict is permanently DEGRADED, with no in-product way to mute a rule.
5. **Cost telemetry is shaped right but blind to people.** `AiInvocation` captures provider, model, prompt/cached/completion/reasoning tokens, tool calls, latency and environment per request, priced at read time from a versioned rate card. But it has no user or Space dimension by a recorded privacy decision, its conversation key collides, failures and retries are not persisted, and non-handled Plaid webhooks leave no trace.
6. **Operator intent is nowhere.** No route reads a reason; `AuditLog` has no reason or target column; append-only is a code convention (`fm_system` and the owner hold UPDATE/DELETE); the destructive and corrective actions that exist only as scripts write no audit row.

### Biggest operational gaps (ranked)

| # | Gap | Class |
|---|---|---|
| 1 | No path from an abnormal signal to the affected user and back to an action (identity redaction + no entity pages + role wall) | OPERATIONAL GAP |
| 2 | AI failure/quota is unobservable; alerts daily, email-only, optional destination; REVOKED/deactivated inflate health | DEFECT + OPERATIONAL GAP |
| 3 | Cost ledger lacks user/Space/conversation dimensions and failure rows; webhooks unrecorded (none of these can be backfilled) | MISSING CAPABILITY |
| 4 | Beta intake captures only email + note; no attribution, no re-request evidence, invitation email delivery invisible | MISSING CAPABILITY |
| 5 | Operator reason absent; audit target keys ad hoc; script-only destructive actions unaudited; append-only by convention | DESIGN DEBT |
| 6 | Two admission kill switches (`maintenance_mode`, `ingestion_paused`) and alert-rule toggles are SQL-only despite CONTROL descriptors | MISSING CAPABILITY |
| 7 | Documentation drift is severe: `STATUS.md`, `platform-operations.md`, `admin-operations.md`, `background-jobs.md`, `incident-response.md` all describe a product that no longer exists | PRESENTATION GAP |

### What is surprisingly already built

- A three-rank grant model (READ/WRITE/CONTROL) with fresh-session gating on every write, transactional grant administration, a source-scanned axis boundary against customer membership, and an operator-actions feed.
- Per-connection **Resync** and **Request reauth** with confirm dialogs, cooldown, admission gating, execution ledger rows and audit, from inside a widget. **Provider cleanup** detection that refuses to infer upstream removal from product status, with an in-UI retry.
- The full beta loop: public intake → queue → approve/deny/cold-invite/resend/revoke → registration-mode and product-status switches → user search → deactivate/reactivate. Redemption is transactional and non-enumerating.
- A six-domain cockpit (`lib/platform/ops/overview-core.ts`) whose roll-up never lets UNKNOWN outrank a real verdict, each domain carrying a doorway to its workspace.
- Cost doctrine already codified: "VERSIONED PRICES IN CODE. IMMUTABLE FACTS ELSEWHERE. COST IS A READ-TIME REDUCTION, NEVER A STORED COLUMN" (`lib/usage/pricing.ts:3-5`), with Plaid priced at Item-month grain from a real invoice (`docs/invoices/Plaid-2026-08-Invoice.pdf`) and Plaid call counters deliberately never priced.
- Policy editing (bank/wallet cadence) with scheduler-honourability validation and optimistic concurrency, behind CONTROL.
- Scripts governance: every script is classified in `scripts/audit-registry.ts` and CI fails on an ungoverned one, so "which scripts are operator tools" is already an answered question.

---

## 2. Existing operational architecture

### 2.1 Platform Spaces

**FACT.** Five areas, not four: `PLATFORM_OPS`, `SECURITY_OPS`, `GROWTH_REVENUE`, `CUSTOMER_SUCCESS`, `MERCHANT_OPS` (`prisma/schema.prisma:260-271`; `lib/platform/policy.ts:57-212`). Each is one system-singleton `Space` rendered through the shared `SpaceShell`; workspaces are universal `WorkspaceDefinition`s (`lib/platform/workspaces.ts:118-171`). Only PLATFORM_OPS is decomposed (Overview · Jobs · Policies · Pipeline · Providers · History · AI · Economics); the other four have a single Overview. Section→widget map: `components/platform/PlatformSpaceDashboard.tsx:117-163`.

Entry: `/dashboard/spaces` renders a "Fourth Meridian HQ" card group per granted area (`components/dashboard/SpacesClient.tsx:867-920`) and the sidebar `PlatformNav` lists the same (`ContextualNavbar.tsx:99-215`). `/admin` is a separate shell with six nav items and no path to Platform Spaces.

Seeding: Platform Spaces exist only if `scripts/seed-platform-spaces.ts` (or dev `prisma/seed.ts`) has run; no runtime path calls `ensurePlatformSpaces`/`ensurePlatformSections` (`lib/platform/seed.ts:30-57,117-165`). Adding a section to `PLATFORM_AREAS` requires re-running the script (`enabled`/`order` are create-only). **FACT — OPERATIONAL GAP** (bootstrap-by-script; a named cutover step, acceptable once).

### 2.2 Route and widget inventory (PLATFORM_OPS)

| Workspace | Section | Route | Authority |
|---|---|---|---|
| Overview | `ops_overview` | `platform-ops/overview` | `lib/platform/ops/overview.ts` (pipeline, sources, jobs, Brief, AI, Plaid verdicts) |
| Overview | `ops_platform_health` | `alerts`, `provider-health`, `resource-freshness`, `rate-limits`, `env-status` | alert runs, provider health, freshness, `RateLimit`, `getEnvReport` |
| Jobs | `ops_scheduler`, `ops_job_health`, `ops_manual_operations` | `scheduler`, `job-health`, `operations` GET/POST | `lib/platform/scheduler/observation.ts`, `lib/jobs/health.ts` over `JobRun`, `lib/platform/operations/*` |
| Policies | `ops_policies`, `ops_alerts` | `policies` GET/PATCH/DELETE, `alerts` | `PlatformSetting` via `lib/platform/policies/mutate.ts`; `lib/alerts/*` |
| Pipeline | `ops_refresh_executions`, `ops_refresh_summary`, `ops_refresh_coverage`, `ops_connection_health` | `refresh/executions[/id[/timeline]]`, `refresh/summary`, `refresh/coverage`, `connection-health`, `connections/[id]/{resync,request-reauth}` | `RefreshExecution` ledger via `lib/platform/refresh/*`; `lib/connections/health.ts` |
| Providers | `ops_provider_health`, `ops_provider_operations`, `ops_connection_diagnostics`, `ops_provider_cleanup`, `ops_api_usage`, `ops_resource_freshness`, `ops_email_delivery` | `provider-health`, `refresh/provider-operations`, `connection-diagnostics`, `provider-cleanup` GET/POST, `api-usage`, `resource-freshness`, `email-health` | `ProviderCall`, PlaidItem+Connection, revocation audit markers, `ApiUsageCounter`, archives, `NotificationDelivery` |
| History | `ops_history`, `ops_convergence`, `ops_timeline` | `history`, `convergence` | `lib/platform/{history,convergence}` |
| AI | `ops_ai_invocations`, `ops_brief_ops`, `ops_ai_trend` | `ai-invocations`, `brief-ops`, `ai-usage-trend` | `AiInvocation`, `DailyBrief`, `ApiUsageCounter` |
| Economics | `ops_plaid_usage`, `ops_cost` | `plaid-usage`, `cost` | `PlaidItem` census ⨝ status-transition audit rows; `cost` = **latency/runtime over JobRun, not dollars** |
| — | (no widget) | `db-authority` | `lib/platform/db-authority.ts` — **route with no reader** |

Other areas: SECURITY_OPS (`auth-posture`, `operator-actions`, `audit`, `sessions`, `anomalies`; all READ over `AuditLog`/`UserSession`/`User`); GROWTH_REVENUE (`signups`, `requests` + `[id]/{approve,deny,resend,revoke}`, `invitations`, `beta-status`, `registration-mode`, `product-status`, `users` + `[userId]`, `activity`, `growth`); CUSTOMER_SUCCESS (`sync-issues` over `SyncIssue`/`SyncIssueOccurrence`); MERCHANT_OPS (a doorway to the standalone `/merchant-ops` page + `POST /api/merchant-ops/decide`).

`/admin` (SYSTEM_ADMIN only): Users, Spaces, Providers, Audit, Security, Platform Access. `/admin/providers` is the **only** surface joining owner email ↔ institution ↔ `externalItemId` ↔ status ↔ last sync (`app/admin/providers/page.tsx:25-66,98-134`), plus the Expand-History relink flow. `/admin/users` and `/admin/spaces` are lists with no detail pages and no actions. Admin pages were last touched 2026-06-22/07-02.

### 2.3 Operator actions that exist (writes)

| # | Action | Gate | Audit | Notes |
|---|---|---|---|---|
| A1 | Resync connection | PLATFORM_OPS WRITE, fresh | `CONNECTION_RESYNC_TRIGGERED` | confirm dialog; 409 NEEDS_REAUTH/REVOKED; 60-min cooldown; admission gate; `RefreshExecution` trigger OPERATOR (no operator id) |
| A2 | Request reauth | same | `CONNECTION_REAUTH_REQUESTED` | flips NEEDS_REAUTH via CH-2 chokepoint, notifies owner |
| A3 | Retry provider cleanup | same (`systemDb`) | `PLAID_ITEM_REVOCATION_RETRY_REQUESTED` | only when a marker says owed |
| A4 | Run Now / Dry Run | same + 30/min | `PLATFORM_OPERATION_EXECUTED/_DRY_RUN` | targets fx-rates, security-prices, sync-crypto, sync-banks; `refresh/retry/backfill/invalidate` kinds reserved; `process-deletions` excluded |
| A5 | Edit/reset refresh cadence | PLATFORM_OPS **CONTROL**, fresh | `PLATFORM_POLICY_CHANGED/_RESET` | the one writer using `buildAuditData`, before/after, one transaction, optimistic token |
| A6–A8 | Beta approve/deny/resend/revoke, direct invite, registration-mode, product-status | GROWTH_REVENUE WRITE, fresh | `BETA_*`, `PRODUCT_STATUS_CHANGED` | mode/status rows carry `{previous,new}` |
| A9 | Deactivate/reactivate user | same | `ACCOUNT_DEACTIVATED/REACTIVATED` | refuses SYSTEM_ADMIN/self; revokes sessions |
| A10 | Merchant merge/dismiss | MERCHANT_OPS WRITE, fresh (`systemDb`) | `MERCHANT_MERGE_APPLIED/DISMISSED` | irreversible; no `performedByAdminId` ⇒ absent from operator feed |
| A11 | Issue/revoke PlatformGrant | SYSTEM_ADMIN fresh | `PLATFORM_GRANT_*` | one transaction, before-state |
| A12 | Expand history / retire superseded item | SYSTEM_ADMIN (expand-token uses **cached** `requireSystemAdmin`) | `ADMIN_PLAID_*` | multi-step drawer |
| A13 | 2FA reset / recovery regen / revoke sessions | SYSTEM_ADMIN fresh | `TWO_FACTOR_RESET`, etc. | typed tokens; admin-TOTP step-up commented out as "future" |

**Reserved/stubbed:** admission kill switches `maintenance_mode`/`ingestion_paused` have CONTROL descriptors (`lib/platform-settings.ts:145-154`) but **no writer anywhere** (`mutate.ts` accepts only cadences; admin settings PATCH excludes them; `scripts/set-platform-setting.ts:40-43` allows only two keys). Alert-rule enable/disable keys are read by prefix (`lib/alerts/run.ts:84-90`) and are not in the descriptor registry. Three UI stubs promise actions that do not exist: "Force Sync", "Disconnect" (`components/admin/ProviderActionsButton.tsx:200-222`), "Force password reset" (`AdminSecurityConsole.tsx:737`).

### 2.4 Authorities, data flows and the privacy fence

The spine is already documented and holds: job health (`lib/jobs/health.ts`), resource freshness (`lib/platform/resource-freshness.ts`), provider health (`lib/platform/provider-health.ts`), connection health (`lib/connections/health.ts`), refresh ledger (`RefreshExecution` → `RefreshEndpointResult` → `ProviderCall` → `RefreshEndpointAccountCoverage`), incidents (`SyncIssue`/`SyncIssueOccurrence`), alert engine, admission facts. Every operator surface is forbidden from reading balances, transaction amounts, emails, tokens or `process.env` by source scans (`lib/platform/observability-privacy.test.ts`, `lib/platform-surface.test.ts`, `connection-ops-guards.test.ts`, `capability-control.test.ts`).

**FACT — INTENTIONAL BOUNDARY (documented) with a consequence:** every admin and platform route except three imports the legacy `db` client, which is the BYPASSRLS migration principal (`lib/db.ts:30`; 37 route files; ratchet baseline 163 files in `scripts/lib/db-authority-baseline.json`). Operator reads today are owner reads; the RLS cutover runbook declares this out of scope. Related: `app/api/access-request` and `register` also import `db`, while migration `20261002000600` describes `fm_auth` as their authority — a doc/code drift the RLS lane should settle (flag only).

### 2.5 Jobs and provider integrations (summary; detail in §5)

Eleven registry jobs via one dispatcher cron (`0,30 0,6,7,12,18 UTC`) plus `resume-stale-imports` every 5 minutes outside the registry. A normal day writes 17 registry `JobRun` rows plus ~288 resume rows (docs still say 10 jobs / 13 rows). Plaid: `transactionsSync`, `accountsGet`, `investmentsHoldingsGet`, `investmentsTransactionsGet`, `itemRemove`, `linkTokenCreate`, `itemPublicTokenExchange`, `webhookVerificationKeyGet`; every call is proxied into `ApiUsageCounter`, and into `ProviderCall` when a refresh context is active. OpenAI: one seam (`lib/ai/provider.ts`), three non-streaming paths, `gpt-5.1` for chat and Brief. Email: Resend via `lib/email/send.ts`; only the notification pipeline writes `NotificationDelivery`.

---

## 3. Beta lifecycle map

### 3.1 Existing state (FACT)

The lifecycle is spread across four authorities, none of which is a lifecycle table:

| Stage | Authority | Evidence |
|---|---|---|
| REQUESTED | `BetaAccessRequest` PENDING (`email @unique`, `note?`, `createdAt`) | `prisma/schema.prisma:3219-3239`; `app/api/access-request/route.ts:68-89` |
| REVIEWED | `decidedAt`, `decidedById` (soft ref) | approve/deny routes |
| INVITED | APPROVED + `inviteTokenHash`, `inviteExpiresAt` (14d; direct invites 1–30d, default 7), `invitedAt` | `requests/[id]/approve/route.ts:49-87`; `invitations/route.ts:30-84` |
| SIGNED UP | REDEEMED + `redeemedAt`, `redeemedUserId` (soft ref, no FK); registration consumes the token in the same transaction, count≠1 aborts | `lib/registration-policy.ts:96-136`; `app/api/auth/register/route.ts:148-175,309-318` |
| ONBOARDED | nothing persisted beyond `User.acceptedTermsAt`, `employmentStatus`, `useCase`, auto-created Personal Space; invited users skip email verification | `register/route.ts:202-287` |
| PLAID CONNECTED | `PlaidItem.createdAt` + `AuditLog ACCOUNT_ADD {institution, accountCount}` — authoritative, **explicitly unmeasured** | `lib/plaid/exchangeToken.ts:650-668`; `docs/design-studies/growth-revenue-v1.md:9` |
| ACTIVATED | defined everywhere as **≥1 `UserSession` row ever** | `lib/platform/growth/growth.ts:32,106-109` |
| ACTIVE/INACTIVE | `UserSession.lastActiveAt` (60s granularity), `AuditLog LOGIN/SPACE_SWITCH`; DAU/WAU/MAU computed, complement list not | `lib/auth/session-activity.ts:57,80-86`; `activity.ts` |

Expiry is lazy (computed at read); an APPROVED row with a lapsed token stays "Approved" in counts and the approve-rate denominator (`growth.ts:67-75,151`). Denial is silent; revoke ≡ deny-with-token-null; approve-after-deny is allowed.

### 3.2 The 5 Ws capture matrix

| W | Captured | Where | Shown to operator |
|---|---|---|---|
| WHO | email only; **no name** | `BetaAccessRequest.email` | yes |
| WHAT | implicit ("beta access") | — | — |
| WHEN | `createdAt`, `decidedAt`, `invitedAt`, `inviteExpiresAt`, `redeemedAt` | row | `createdAt`, invite/expiry; `decidedAt` served but never rendered; `redeemedAt`/`decidedById` never served |
| WHERE/HOW | IP + user agent → **AuditLog only**; `cf-ipcountry`/colo read by `getRequestMeta` and **dropped** (`lib/api.ts:83-91` vs `access-request/route.ts:92-99`); **no referrer, UTM, landing path, campaign anywhere** (site or app) | `AuditLog BETA_ACCESS_REQUESTED` | no |
| WHY | optional `note` ≤1000 chars | row | detail panel only |

The public site captures nothing: `site/` is a static export with CSP `form-action 'none'; connect-src 'self'`; its request-access page is a plain link to `{appOrigin}/request-access`. The real form lives on the app origin and posts same-origin; the proxy's write-origin boundary 403s cross-origin writes (`proxy.ts:77-92`). The "404 ⇒ queued" trap is closed (`lib/marketing/request-access.ts:15-20`).

### 3.3 Duplicates, bots, triage

- Duplicate email: `createMany({skipDuplicates:true})`, count discarded, identical 200 — a deliberate non-enumeration property (**INTENTIONAL BOUNDARY**, keep). Consequence: a re-request after DENIED is swallowed forever; no `lastRequestedAt`/`requestCount`.
- Bot: `limitByIp` 5/15 min; Turnstile fail-open and a no-op without `TURNSTILE_SECRET_KEY` (`lib/captcha.ts:52-55`); production readiness records both keys **absent in Production**. No honeypot, no per-email limit.
- Triage: no SPAM/SUSPICIOUS class, no bulk deny, 100-row take. Rows are never deleted (correct) but cannot be classified either.
- **FACT — DEFECT (minor):** approve does not check for an existing `User` with that email while direct-invite does (`invitations/route.ts:50-52` vs `approve/route.ts:41-51`); approving a live user's re-request mints and emails an unredeemable invite.

### 3.4 Email evidence

`beta-invite`, `beta-request` (operator intake to `BETA_REQUESTS_EMAIL`), verification, reset and platform-alert mails all call `sendEmail` directly and **never reach `NotificationDelivery`** (`lib/platform/email-health.ts:10-16`). The only per-send evidence is `AuditLog.metadata.emailStatus ∈ sent|captured|error`, which no widget renders; the approve/resend responses return it and the widget ignores it (`GrowthBetaRequestsWidget.tsx:113-129`). No Resend webhook consumer exists, so bounces are invisible. The `beta-invite` template hard-codes "expires in 14 days" (`lib/email/templates/beta-invite.ts:22`), wrong for every direct invite. **FACT — OPERATIONAL GAP** (the most likely beta support question, "did my invite arrive?", is a Resend-console question today).

### 3.5 Cohort derivability

| Cohort | Status | How |
|---|---|---|
| Invited, never registered | **DERIVABLE NOW, served** | APPROVED (+ lapsed expiry) — the Invitations list |
| Registered, never connected | NEW QUERY | `User` ⟕ `PlaidItem`/`Connection` IS NULL, or no `ACCOUNT_ADD` |
| Connected, never "activated" | NEW QUERY + **needs a definition** (empty under today's ≥1-session definition) | `PlaidItem.createdAt` vs later `LOGIN` |
| Inactive N days | NEW QUERY | `MAX(UserSession.lastActiveAt) < now−N`, excluding `deactivatedAt` |
| Reauth required, per user | NEW QUERY | `PlaidItem.status=NEEDS_REAUTH` grouped by `userId` (fleet counts exist in Platform Ops; no per-user view) |
| High-engagement | NEW QUERY for login-based; **NEEDS NEW PERSISTED STATE** for AI/Brief-based (`AiInvocation` opaque; `lastBriefViewedAt` has **no writer**) | |
| Requested but already a user | NEW QUERY | `BetaAccessRequest.email = User.email` |
| Re-requested / request count | **NEEDS NEW PERSISTED STATE** | only unindexed `AuditLog.metadata.email` |
| Referral / acquisition source | **NEEDS NEW PERSISTED STATE** | nothing captured; `SpaceInvite` is Space membership between existing users, unrelated |

**FACT — PRESENTATION GAP (vocabulary):** the Beta Access widget labels `counts.redeemed` **"Activated"** (`GrowthBetaRequestsWidget.tsx:230`) while every authority defines activated as ≥1 session. Two stats called "Activated" on the same Space mean different things.

### 3.6 Recommended lifecycle model (RECOMMENDATION)

Do **not** add a single lifecycle enum. Keep `BetaAccessRequest.status` as the pre-account state machine, `User`/`PlaidItem`/`UserSession`/`AuditLog` as the post-account facts, and add only what cannot be derived:

- **Persisted, additive, small:** on `BetaAccessRequest`: `lastRequestedAt`, `requestCount` (INSERT … ON CONFLICT DO UPDATE on those two columns only, count still discarded, non-enumeration preserved), `source Json?` (referrer host, `utm_*`, landing path, `cf-ipcountry`), optional `triage ∈ {NONE, SUSPECTED_SPAM}` to classify without destroying. Have the site forward its query string on the "Continue" link (zero cost). Give `lastBriefViewedAt` a writer or delete its schema comment.
- **Derived (new projections in `lib/platform/growth`, pure core + injected readers like `growth.ts`):** ONBOARDED := verified ∧ ≥1 LOGIN; PLAID CONNECTED := ∃ PlaidItem; REAUTH_REQUIRED := ∃ NEEDS_REAUTH; ACTIVATED := PLAID CONNECTED ∧ ≥1 LOGIN after first `ACCOUNT_ADD` (rename the widget's "Activated" to "Redeemed"); ACTIVE/INACTIVE := last activity within N days. One per-user operator row (`User` ⋈ `BetaAccessRequest` on `redeemedUserId`/email ⋈ PlaidItem aggregate ⋈ last session ⋈ last `ACCOUNT_ADD`) answers every cohort above except AI engagement.
- **Email evidence:** render `emailStatus` beside each invitation now (zero schema); route the direct sends through a thin delivery-row writer later; pass `expiresDays` into the template.
- **Guard:** approve should refuse when a `User` with that email exists (mirror the direct-invite check).

---

## 4. Cost observability

### 4.1 AI telemetry today (FACT)

Every model call goes through one seam (`lib/ai/provider.ts`) and writes two ledgers fire-and-forget: the day-grain `ApiUsageCounter` and the per-request `AiInvocation` (`lib/ai/invocation.ts:59`).

| Dimension | Status | Evidence |
|---|---|---|
| provider, model | YES | `schema.prisma:3293-3295` |
| input / cached input / output / reasoning tokens | YES, provider-reported verbatim | `:3300-3303`; `invocation.ts:75-78` (`prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`) |
| tool calls, latency, finish reason | YES | `:3306-3310`; `provider.ts:151-161,269-283` |
| environment | YES (`production`/`preview`/`development`; one OpenAI key spans all) | `:3312-3315`; `lib/env.ts:232-239` |
| feature (`surface`) | YES: `chat`, `brief`, `harness`, …; Brief reason in id prefix | `app/api/ai/chat/route.ts:199`; `lib/ai/brief/generate.ts:216` |
| conversation | **PARTIAL — DEFECTIVE**: `correlationId = sha256(userId + opening message)[:16]` | `route.ts:269-271`; **[DEV DB]** 51 chat rows → 2 distinct keys |
| request | YES: one row per request, `(correlationId, turnIndex)` groups a tool loop | `:3320-3322` |
| user, Space | **NO — by recorded privacy decision** ("never resolvable to a person", table revoked from `fm_app`) | `:3317-3319`; `invocation.ts:62-65`; reader refuses a user filter `lib/platform/ai/invocations.ts:14-17` |
| success/failure | **PARTIAL**: only *returned* calls write a row; a throw writes nothing | `invocation.ts:7-13` |
| retries | in-memory only (`TurnRecord.retries`); `insufficient_quota` detected and not retried, not persisted | `lib/ai/rate-limit-retry.ts:60-105`; `turn.ts:164` |
| provider request id | NO (Plaid's `request_id` is stored on `ProviderCall`; OpenAI's never read) | `provider-call.ts:58-60` |
| estimated cost | YES, read-time only, from `AI_RATES` (hand-transcribed 2026-09-08, `effectiveFrom` = evidence date) | `lib/usage/pricing.ts:53-82,206-249` |
| provider-reported cost | **NO** (no invoice or billing pull in repo) | widgets say "estimate" |
| streaming | N/A — all three paths non-streaming | `provider.ts:152,270,409` |

Readers: `ai-invocations` (by provider/model/surface/environment/day, usd estimate, `unpricedTokens`), `ai-usage-trend`, `api-usage`, `brief-ops` (DailyBrief ⨝ AiInvocation 1:1 on `correlationId`; "a failed attempt's cost is unknown"). Per-correlation economics exist as a pure module (`lib/platform/ai/invocation-economics.ts`) with no route consumer. The guidance labeller is a **second invocation per turn** with the same correlation/turn index, indistinguishable except `toolCallCount=0` (`engine.ts:374-379`). **[DEV DB]** `reasoningTokens` sums to 0 across all 443 rows — pricing unaffected (reasoning ⊆ completion) but the explanatory split is dead until verified live. **[DEV DB]** 372/443 rows are harness traffic; chat prompt-cache hit rate 93%.

### 4.2 Plaid telemetry today (FACT)

| Dimension | Status | Evidence |
|---|---|---|
| Items (status, institution, owner, created, last sync, consent, environment) | YES; `environment` nullable and never backfilled (**[DEV DB]** 13/13 null) | `schema.prisma:842-937` |
| products | **PARTIAL**: not persisted; Investments evidenced only by current `investmentsConsent` (no timestamp) | `lib/platform/plaid/item-months.ts:131-133` |
| syncs/refreshes | YES: `RefreshExecution` with trigger MANUAL/CRON/RECONNECT/WEBHOOK/ADMIN/OPERATOR/RESUME, stages, per-account coverage, `deploymentSha` | `:3768-3806` |
| webhooks | **PARTIAL**: only `TRANSACTIONS/SYNC_UPDATES_AVAILABLE` and `HOLDINGS/DEFAULT_UPDATE` produce an execution; every other type (ITEM: ERROR, PENDING_EXPIRATION, USER_PERMISSION_REVOKED, PENDING_DISCONNECT, NEW_ACCOUNTS_AVAILABLE) is `console.log`ged and acked `handled:false` | `app/api/plaid/webhook/route.ts:65,80` |
| revoked items | YES: `PLAID_ITEM_STATUS_CHANGED {from,to}` + `PLAID_ITEM_REVOCATION_{CONFIRMED,UNCONFIRMED}` markers | `lib/plaid/disconnect.ts:124-142` |
| provider calls | YES inside a refresh (`ProviderCall` with Plaid `request_id`, http status, error code); call count only outside one | `lib/plaid/client.ts:76-100`; `provider-call-context.ts:14-17` |
| estimated cost | YES at Item-month grain under both invoice readings (`during`/`atEnd`), null before 2026-07-01 | `lib/platform/plaid/usage.ts`, `item-months.ts` |
| provider-reported cost | **One invoice PDF** (`S-J7Y5657ZK0-2607`, July 2026, $13.40: Transactions $0.30×40, Investments $0.35×4) | `docs/invoices/Plaid-2026-08-Invoice.pdf`; `pricing.ts:126-131` |

**FACT (static) — DEFECT candidate:** the webhook receiver looks up the item by `externalItemId` with no status filter (`webhook/route.ts:83-87`); `syncPlaidItemFromWebhook` checks only platform-wide admission (`lib/plaid/webhook-sync.ts:99`); the lock claim and `runDeferredHistorySync` never read `status`; REVOKED keeps its `encryptedToken`. The cron and resume paths filter on `status: ACTIVE` and `user.deactivatedAt: null` (`jobs/sync-banks.ts:165`). So a webhook for a REVOKED item whose upstream removal failed runs the full pipeline against Plaid. The CH-2 chokepoint refuses to flip REVOKED back to ACTIVE (`lib/connections/health-transitions.ts:84-99`), so the harm is provider calls, writes and noise, not resurrection. Runtime unconfirmed.

### 4.3 What can and cannot be answered today

| Question | Today |
|---|---|
| What does a particular user cost us? | **NO (AI, by construction)**; Plaid derivable from `PlaidItem.userId` × Item-months but `usage.ts` deliberately reads no user column |
| Cost per activated beta user | NO (no user dimension; no shared "activated" definition) |
| Which AI feature costs the most? | YES, estimated (`bySurface`); labeller folded into chat |
| Expensive conversations/requests | PARTIAL, unreliable (key collision) |
| Active Plaid Items; products enabled | YES; PARTIAL (Investments current-only) |
| Revoked items still generating activity | PARTIAL: join `RefreshExecution.plaidItemId ∈ REVOKED` exists, no reader; non-handled webhooks invisible |
| AI vs Plaid vs other infra | two estimates and a blank (**zero** infra telemetry) |
| Cost-to-serve per active user | NO |

### 4.4 Provider truth vs estimated cost boundary (RECOMMENDATION)

Keep the boundary where the code already draws it: facts (`AiInvocation`, `PlaidItem` + transitions) × versioned rates = **estimate**, always labelled. Add one place for **truth**: a `ProviderInvoice` record (provider, period, total, line items, source file) entered monthly from the Plaid PDF / dashboard and the OpenAI invoice, so each economics card can show estimate vs invoiced for closed periods. **INFERENCE to verify:** the repo's claim that OpenAI exposes no billing endpoint may be stale (an admin-scoped Usage/Costs API exists); if confirmed, a daily puller writes the same record with `source: 'openai-costs-api'`. Plaid has no billing API; the PDF stays the truth. Infra (Vercel, Supabase, Sentry, Resend): one manual monthly entry per vendor is sufficient for beta; no automation.

### 4.5 Proposed attribution model (RECOMMENDATION)

Reuse the two fact tables; add dimensions, not tables.

1. `AiInvocation`: nullable `userId`, `spaceId`, `conversationId`, `subSurface` (`chat:answer` / `chat:guidance`), `providerRequestId`. This **reverses a recorded privacy decision** (`invocation.ts:62-65`, cost plan Slice 7 / OPS-6H) and is therefore a product decision the owner must make before user #1 — a day counter cannot be retrofitted. Keep the RLS posture (operator-only read, no tenant path). `conversationId` = random id minted on the first turn and carried in the existing sealed cookie, replacing the colliding hash.
2. `AiInvocation`: a failure row kind (`outcome: RETURNED|FAILED|TIMEOUT|RATE_LIMITED|QUOTA`, zero tokens, `errorCode`), written from the catch paths in `provider.ts` and `rate-limit-retry.ts.onRetry`. Unpriced by construction.
3. Plaid: `PlaidItem.billedProducts String[]` + `productsObservedAt` (persist what `accountsGet` already returns) and `retiredAt` stamped by the CH-2 chokepoint.
4. Plaid: persist every verified webhook as a small append-only row (`externalItemId`, `type`, `code`, `handled`, `itemStatusAtReceipt`). "Revoked items still producing activity" then becomes one query.
5. Confirm `environment` is populated as `production` on both ledgers at the production deploy (one provider account for all environments).

### 4.6 Is cost telemetry P0, and what is the minimum?

**Yes, a write-path minimum is P0; every reader can wait.** The P0 set is exactly the facts that cannot be reconstructed later: the user/Space decision (and columns if yes), a collision-free conversation id, failure/quota rows, webhook persistence, environment stamping. None requires a new table except the webhook row; none requires a widget. Everything read-side (per-user cost cards, estimate-vs-invoice, sub-surface split, relabelling the misnamed `cost` route) is P1/P2.

---

## 5. Platform health model

### 5.1 Jobs and workflows inventory (FACT)

| Job / workflow | Trigger | Last-run evidence | Retry | User impact on failure | Observability | Remediation |
|---|---|---|---|---|---|---|
| `sync-banks` 06:00 | dispatcher | `JobRun` + per-item `RefreshExecution` CRON | none job-level; `withPlaidRetry` 2 attempts transient | item → NEEDS_REAUTH/ERROR + `SYNC_FAILED` notification; transient 429 **silent until tomorrow** | Jobs, Pipeline, Overview | Run Now (fleet), per-item Resync |
| `fetch-fx-rates` 06:30 | dispatcher | `JobRun`; truth = `MAX(FxRate.date)` | failover chain; `source:"none"` is a *succeeded* run | stale conversions (SWR masks) | Providers, `resource-stale` alert | Run Now; `backfill-fx-rates.ts` |
| `fetch-security-prices` 06:30 | dispatcher | `JobRun` | vendor-gated no-op forever | none | — | — |
| `sync-crypto` ×4 + `-continuation` ×4 | dispatcher | `JobRun`, `RefreshExecution` WALLET_SYNC, `SyncIssue` | per-wallet never-throws | DEGRADED card, **no user notification for wallets** | Jobs, Pipeline, CS incidents | Run Now; member Sync |
| `process-deletions` 07:00 | dispatcher | `JobRun` counts only; **no per-user row** | cron is the retry; Plaid failure holds purge ≤3 days | user silently not deleted | Jobs (counts) | **none in UI**; legacy route curl-able |
| `notification-cleanup/-retry`, `purge-trash` (no-op), `rate-limit-sweep` 07:30 | dispatcher | `JobRun`; `NotificationDelivery` rows | retry: 3 attempts then **dead-letter** | missing emails | `ops_email_delivery` (counts + last 10 errors) | **SQL only** for dead-letter |
| `evaluate-alerts` 07:30 (last) | dispatcher | its `JobRun.summary` IS the alert store | failed delivery not recorded as fired ⇒ retries next day | — | `ops_alerts` (Policies workspace) | rule toggles SQL-only |
| `resume-stale-imports` */5 | **own cron, outside registry** | `JobRun` rows, **no health classification, no alert** | every 5 min | import stuck "importing" | Scheduler widget as external cron | curl |
| Plaid webhook | Plaid POST, JWT-verified | `RefreshExecution` WEBHOOK (two codes only) | — | — | Pipeline | — |
| Daily Brief | **lazy** on page view; 90s lease; 3-min failure cooldown | `DailyBrief.generatedAt/lastFailedAt/lastFailureReason` ⨝ `AiInvocation` | — | "Couldn't update" | `ops_brief_ops`, Overview Brief | **no re-generate lever** |
| AI conversations | user | `AiInvocation` successes only | 429-only bounded | turn fails | Overview AI = **UNKNOWN always** (`overview-core.ts:185-187`) | none |
| Account deletion hold | grace → purge | only `skipped` count in JobRun | ≤3 attempt-days then UNCONFIRMED marker | silent | `ops_provider_cleanup` after day 3 | cleanup retry |
| Auth/beta/alert emails | direct `sendEmail` | **not recorded anywhere** | — | reset/invite flow dead | `env-status` only | Resend console |
| Session cleanup | **no job**: expired `UserSession` rows never deleted | — | — | growth | — | — |

### 5.2 Confirmed disclosed gaps at HEAD

Dispatcher ticks unobservable (`dispatch.ts:87-90`) — TRUE. `resume-stale-imports` outside registry — TRUE. Four legacy per-job routes callable with `CRON_SECRET`, recording `trigger:"cron"` and bypassing confirm/audit/lock; `process-deletions` excluded as destructive yet reachable — TRUE. `quota-low` dormant — TRUE. "Refresh ledger empty in dev" — likely stale (wallet and cron executions now write).

### 5.3 Findings on health and alerting

- **FACT — DEFECT (alert fatigue):** `getConnectionHealth` reads every `PlaidItem` with no status filter (`lib/connections/health.ts:153-155`); REVOKED ∈ `CRITICAL_CONNECTION_STATES` (`lib/alerts/evaluate.ts:42-46`); `deriveSources` counts REVOKED as broken (`overview-core.ts:138`). Production holds 3 REVOKED Items ⇒ a critical `provider-unhealthy` email every ~20h and a permanently DEGRADED Sources verdict, until rows are deleted. REVOKED is a terminal product state; the operational question ("is cleanup owed?") is answered elsewhere.
- **INFERENCE — DEFECT:** items of deactivated users are skipped by `sync-banks` but included in health ⇒ STALE forever, same mismatch.
- **FACT — OPERATIONAL GAP:** `PLATFORM_ALERTS_EMAIL` is not in `PROD_REQUIRED_KEYS` (`lib/env.ts:285-299`); unset ⇒ alerts record `deliveryStatus:"skipped"` silently. Alerts are email-only; the widget lives under Policies, not Overview.
- **FACT — OPERATIONAL GAP:** alert cadence once daily, 20h re-notify (`evaluate.ts:38`); a Thursday 08:00 breakage is first emailed Friday 07:30.
- **FACT — MISSING CAPABILITY:** AI provider failure/quota writes no fact and no Sentry event; Brief failures persist `lastFailureReason` but only after a user asks; no alert rule reads either.
- **FACT — OPERATIONAL GAP:** a failed job is a `console.error` and a 500 *response*, never a thrown error ⇒ not a Sentry event (`dispatch.ts:99-105`; `lib/api.ts:128-131`). Fast signal today = Vercel Crons dashboard.
- **FACT — MISSING CAPABILITY:** no in-UI lever to mute a rule; `alert_rule_enabled:*` keys are not descriptors so the validated setters refuse them.
- **FACT — INTENTIONAL BOUNDARY:** admission pause (`maintenance_mode`/`ingestion_paused`) makes `sync-banks` return `notAdmitted` as a succeeded run; no "platform paused since X" fact on Overview.
- **FACT — PRESENTATION GAP:** `SyncIssue` is a platform-wide incident registry in the *Customer Success* area, only `AUTOMATIC_RECOVERY` can resolve, no operator ack; not in Overview.
- **FACT — DESIGN DEBT:** no retention for `JobRun` (~305 rows/day) or expired sessions.

### 5.4 Smallest signal set (RECOMMENDATION)

Keep the Overview's per-domain `worst` with UNKNOWN demoted; extend it with four domains rather than adding a top-level light. Eight signals, each on an existing authority; two need one new fact each.

| # | Signal | Abnormal states | Authority | New fact |
|---|---|---|---|---|
| S1 | Scheduler alive | `scheduler-silent`, `scheduler-dead` | `checkScheduledJobHealth` | register `resume-stale-imports` with its own expectation |
| S2 | Jobs working | `job-failing`, `job-crashed` | same | none |
| S3 | Bank connections | `item-needs-reauth`, `item-error`, `sync-stalled`, `import-stuck` | connection health + diagnostics | exclude REVOKED and deactivated owners from the population; add `syncIncompleteAt` age |
| S4 | Wallets / archives | `resource-stale`, `resource-empty`, `wallet-degraded` | freshness, connection health | none |
| S5 | Provider debt | `plaid-cleanup-owed`, `deletion-held` | cleanup markers; purge summary | project held deletions from latest `process-deletions` summary (or persist) |
| S6 | Email | `email-dead-letter`, `email-captured-in-prod` | `getEmailDeliveryHealth` | none for notification mail; direct sends remain blind until recorded |
| S7 | AI provider | `ai-provider-failing`, `ai-quota-exhausted`, `brief-failing` | `getBriefOps` | **a failure fact for AI calls** (the Oct 4 incident is the proof) |
| S8 | Control plane | `alerts-undeliverable`, `platform-paused`, `env-missing` | alert runs, admission facts, `getEnvReport` | promote `PLATFORM_ALERTS_EMAIL` to required; add `PLAID_*`, `OPENAI_API_KEY`, alert/beta emails to the env report |

Drill-down: S1/S2 → job → `JobRun` rows → Run Now. S3 → item → owner (needs §6/§8 fix) → execution timeline, transition `since`, incident episodes → Resync / Request reauth / cleanup. S5 → item or user → marker / purge summary → retry. S6 → delivery row → error → (needed) retry/mark obsolete. S7 → Space → `lastFailureReason` → fix credits; (needed) re-generate lever. S8 → setting/env → Policies / Vercel.

Cadence: run `evaluate-alerts` on every dispatcher slot (read-only, cheap) so detection latency drops from ~24h to ≤6h with no new infrastructure.

---

## 6. Operator authority / audit model

### 6.1 Existing controls (FACT)

- Two axes: `UserRole.SYSTEM_ADMIN` (emergency; `requireSystemAdmin`/`requireFreshSystemAdmin`, forced TOTP enrolment, `DISABLE_SYSTEM_ADMIN` kill switch) and `PlatformGrant(userId, area, level, status)` (`requirePlatformAccess`/`requireFreshPlatformAccess` over pure `hasPlatformAccess`, rank READ<WRITE<CONTROL). SYSTEM_ADMIN break-glass bypass exists on the API only.
- "Fresh" = live session-revocation re-check (`lib/session.ts:289-316`), **not** recent TOTP. Admin-TOTP step-up on 2FA reset is commented out as "future".
- Grants: SYSTEM_ADMIN-only, target must be `USER`, upsert + audit in one transaction, revoke is a status flip (`platform-grants/route.ts:66-182`).
- The 34e592c "god mode" closure holds: settings PATCH is descriptor-bound and validated; cadences only via `mutate.ts` behind CONTROL with optimistic concurrency.

### 6.2 Audit architecture (FACT)

`AuditLog(id, userId?, spaceId?, action String, metadata Json?, ipAddress?, userAgent?, performedByAdminId? soft, createdAt)` (`schema.prisma:3179-3195`). No `reason`, no `targetType/targetId`, no `actorType` column; shape folded into metadata by `buildAuditData` (`lib/audit.ts:91-115`), which **one** operator writer uses. 96 direct `auditLog.create|auditInsert` sites. `action` is a free string: `PLATFORM_SETTINGS_UPDATED`, `PROFILE_UPDATE`, `MANUAL_ASSET_*` are written outside the `AuditAction` vocabulary.

**Append-only is a convention.** Grants: `fm_app` SELECT+INSERT, `fm_system` SELECT+INSERT+UPDATE+DELETE (`prisma/migrations/20261002000100_rls_roles_and_policies/migration.sql:583-598`); no trigger, no rule, no REVOKE. `scripts/scrub-activity-account-names.ts:141` legitimately `update`s rows; two test scripts `deleteMany`. Docs claim append-only (`admin-operations.md:46`, `SECURITY_MODEL.md:114`) and describe a removed `recordAuditEvent` adapter.

### 6.3 Coverage of operator actions

Gated: every operator write (13 families) requires a fresh session and the right grant/role. Audited: all but the free-string settings PATCH write a typed action. Before/after present on 6 of ~22 families (grants, settings, policies, registration-mode, product-status, 2FA-reset partial). Reason: **none**. Target correlation: five spellings for "the PlaidItem" (`connectionId | plaidItemId | oldPlaidItemId | newPlaidItemId | itemId`). Operator feed omits settings PATCH, merchant merges, admin-Plaid, sessions (no `performedByAdminId` or not in `OPERATOR_ACTION_FEED_ACTIONS`). PII in metadata: `targetEmail` (2FA reset), `email` (five beta routes). Merchant-merge APPLIED rows embed a full recovery snapshot (merchant/alias/rule columns, transaction ids), in tension with the "never user content" rule.

**Per-entity reconstruction:** `/admin/audit` filters by action, space, date, email/username, admin-only, and `userId` only when the search string looks like a cuid; it cannot filter by operator, by metadata key, or by target. Security Ops feeds show 15–20 rows, no filters, metadata dropped. **A per-PlaidItem audit trail is SQL-only** (`metadata->>'plaidItemId'` across five spellings).

**Script layer:** `purge-plaid-connection.ts` (hard cascade delete), `remove-plaid-connection.ts`, `set-platform-setting.ts` (bypasses both validated surfaces' audit), `merge-merchants.ts`, `recover-plaid-item-transactions.ts`, `regenerate-wealth-history.ts`, `repair-*`, `backfill-*`: dry-run by default, **no audit row**, run as the BYPASSRLS owner. `admin-promote.ts` and `cleanup-orphaned-plaid-items.ts` do audit. Script-only operator actions: SYSTEM_ADMIN promotion, hard purge, provider-first item removal, cursor reset, wealth-history regeneration, arbitrary validated setting write.

**Work ledgers have no actor:** `JobRun.trigger` and `RefreshExecution.trigger="OPERATOR"` carry no operator id (`schema.prisma:3716,3789`); attribution is a time-join to AuditLog.

### 6.4 Recommended safe-action architecture (RECOMMENDATION)

Keep `AuditLog` as the single forensic record. Do **not** build a second operational database. A complementary event model is not warranted for audit; the merchant recovery snapshot is the one case of operational data wrongly placed in the audit table and should move to the decision record.

1. **Make append-only a database property.** `REVOKE UPDATE, DELETE ON "AuditLog" FROM fm_system`; a `BEFORE UPDATE OR DELETE` trigger that raises, with a single named exception for the privacy scrub (session setting set only by an itself-audited scripted run). Triggers bind the owner too. One migration, no schema change.
2. **One operator write chokepoint** `runOperatorAction({area, level, action, target:{type,id}, reason, before?, mutate(tx)})` in `lib/platform/`: calls the existing guard, **requires a non-empty `reason` and a `target`**, runs the mutation and the `buildAuditData` row in one transaction (the `mutate.ts:148-181` pattern), always sets `actorType`/`performedByAdminId`/ip/UA, enforces the vocabulary at the type level, and standardises `target.type ∈ user|space|plaid-item|wallet-connection|beta-request|platform-setting|grant|merchant-pair`. Ratchet by source scan that operator routes import it. Migrate the 22 writers.
3. **Before/after carry state facts, never values or content:** enums, statuses, booleans, counts, timestamps, ids. Drop `targetEmail`/`email` from operator rows (resolve at read time).
4. **Actor on work ledgers:** nullable `actorUserId` on `JobRun` and `RefreshExecution`, set for manual/OPERATOR/ADMIN triggers.
5. **Read side:** `?target=<type>:<id>&operator=<userId>&since=` on the admin audit route and a Security Ops equivalent over `metadata->'target'` (expression index); add the missing families to `OPERATOR_ACTION_FEED_ACTIONS` and `AUDIT_ACTION_GROUPS`; run operator readers on `systemDb`.
6. **Founder access:** keep the 07-07 ruling. Use the second USER account with explicit grants (already the production pattern; zero code; every row attributable to a grant). The alternative (let `/dashboard/platform/*` through the proxy for SYSTEM_ADMIN with a BREAK-GLASS banner and mandatory reason) is viable but not recommended for beta.
7. **Scripts:** register the safe idempotent ones (`recover-plaid-item-transactions`, `backfill-*`) in the operations registry so they inherit dry-run/lock/JobRun/audit; make the destructive ones write an audit row via the helper with a mandatory `--reason` and honour `FM_DB_GUARD`.
8. **Retention:** a registered sweep for SYSTEM-actor PLAID_SYNC/REFRESH rows older than N months, never operator/security rows.

---

## 7. External-console dependency matrix

Legend: **A** appropriate external administration · **B** surface read-only in 4M · **C** bounded operator action in 4M · **D** intentionally outside.

| Routine operation | Tool today | Evidence | Class | Destination |
|---|---|---|---|---|
| Apply migrations | terminal `prisma migrate deploy`; deploy never migrates | `package.json:10`; `vercel.json`; cutover plan §5 | **A** | stays (fix-forward doctrine) |
| Know if prod schema is behind code | `npm run db:drift` by hand; discovered via Sentry ledger-write failures; 10h/8-migration silent drift on 2026-07-26 | `scripts/check-schema-drift.ts:12-34` | **B** | pending-migration count in `db-authority`/Overview from a build-time manifest of migration names |
| Verify RLS/role posture | SQL in runbook; route exists with **no widget** | `db-authority/route.ts`; `rls-preview-cutover.md:183-199` | **B** | mount `db-authority` in Platform health; zero backend |
| Backup / PITR / restore drill (never performed) | `db:backup` to laptop; Supabase | `scripts/db-wipe.ts:33-34`; `production-readiness.md:23,73` | **A** | stays; the drill is the open item |
| Role passwords, pool size, PostgREST exposure, kill backends | Supabase | `rls-preview-cutover.md:87-108` | **A/D** | stays |
| "Did the jobs run?" | docs: SQL on `JobRun` + Vercel Crons + morning `check-job-health.ts` | `background-jobs.md:31-33,43,60` | **B — exists** | `ops_job_health`, `ops_scheduler`, alerts; **fix the docs** |
| Did the dispatcher tick fire? | Vercel Crons only | `scheduler/route.ts:9-11` | **B** | record a dispatch tick fact |
| Run a job now | `curl … CRON_SECRET` | `background-jobs.md:49`; `incident-response.md:175` | **C — partly exists** | Operations covers 4 jobs; extend registry to the rest (incl. `resume-stale-imports`, `evaluate-alerts`) |
| Pause ingestion / maintenance | **SQL**, or pull `CRON_SECRET` from Vercel | `lib/platform-settings.ts:145-154`; no writer | **C** | CONTROL toggles in Policies via `mutate.ts` (design already declared) |
| Mute an alert rule | **SQL** | `lib/alerts/run.ts:84-90` | **C** | register keys as descriptors; toggle in `ops_alerts` |
| Alert destination | env | `lib/env.ts:80` | **A** | stays env; make it required in prod |
| Admit/deny/invite/resend/revoke; registration mode | **in-product** | growth-revenue routes | — | non-finding |
| Deactivate/reactivate; 2FA reset; recovery codes; sessions | **in-product** | G&R widget; admin console | — | non-finding (split across two surfaces) |
| Promote to SYSTEM_ADMIN | `admin:promote` script | `scripts/admin-promote.ts` | **D** | keep script-only for beta |
| Force password reset; operator resend-verification | disabled stub; SQL | `AdminSecurityConsole.tsx:737`; `incident-response.md:395-397` | **C (low)** | wire resend-verification; remove or wire the stub |
| Kill all admin access | `DISABLE_SYSTEM_ADMIN` env | `lib/session.ts:344` | **D** | correct as is |
| Plaid keys, redirect URIs, production approval, invoices, support tickets | Plaid dashboard | `deployment.md:112-151`; `plaid-support-ticket-orphaned-items.md` | **A/D** | stays |
| Item health, diagnostics, usage cost; resync; reauth; cleanup retry | **in-product** | §2 | — | non-finding; note no route ever calls `itemGet` (Plaid's live view never fetched) |
| Operator remove/disconnect an item | disabled stubs; `plaid:remove-connection` script | `ProviderActionsButton.tsx:200-222` | **C** | wire "Disconnect" to a Plaid-first removal (the script's ordering) |
| Hard-purge a connection | `plaid:purge-connection` | header | **D** | never in-product |
| Cursor-reset recovery | `plaid:recover-transactions` | header | **C (small)** | `resetCursor` option on operator resync |
| Re-point webhook URL on existing Items | **nothing** (`itemWebhookUpdate` has zero call sites) | `domain-split-preview.md:197` | **C (one-time)/A** | a dry-run script for the cutover |
| ITEM webhooks (ERROR, PENDING_EXPIRATION, USER_PERMISSION_REVOKED) | acked and ignored | `webhook/route.ts:74-80` | **B** | persist; drive health from Plaid's own signal |
| Did the invite / verification / reset email send? Bounces? | **Resend console**; no webhook route | `lib/platform/email-health.ts:10-15`; `schema.prisma:3643-3646` | **B** | record direct sends; Resend webhook consumer |
| Preview sends real mail to anyone | no allowlist | `environment-separation.md:44` | gap | recipient allowlist / sink on non-prod |
| Domain/DKIM, Resend key rotation | Resend → Vercel env | `key-rotation.md:19-24` | **A** | stays |
| Production errors | Sentry (never read back; no 5xx rule; job failures not captured) | `lib/monitoring/capture.ts`; `dispatch.ts:99-105` | **A** + **B** (capture coverage) | Sentry stays; capture job failures and AI quota |
| Raw logs | Vercel logs (~4.8k `console.*`, no structured logger) | `capture.ts:65-69` | **A** | stays |
| Env changes, redeploy, promote, rollback | Vercel | `key-rotation.md`; cutover plan §5 | **A/D** | stays; extend `env-status` with `PLAID_*`, `OPENAI_API_KEY`, alert/beta emails (names + pass/fail only) |
| OpenAI credits exhausted | OpenAI dashboard (Oct 4) | memory `db1950b` | **B** | quota failure fact → `brief-ops`, `quota-low` rule, Overview AI |
| Uptime | external monitor (not yet set up) | `production-readiness.md:22,72` | **A** | stays |

---

## 8. Proposed Platform information architecture

### 8.1 What exists and what the doctrine already says

`OPERATIONAL_TRUTH_SPINE.md` §J already rules: a Platform workspace exists when it answers a distinct operational question with a distinct action on failure; decomposition is demand-pulled; "Customers" belongs in **Customer Success**, not Platform Ops; "Diagnostics" is a drill-down surface, not a workspace. This report agrees and does not propose reorganising PLATFORM_OPS for aesthetics.

The IA today is organised by **subsystem** (jobs, pipeline, providers, AI, economics) and by **area grant**. For an invite-only beta the dominant question is about a **customer** ("is user X's data right, and if not, why, and what do I do?"), and that question has no home. Operator user actions are split: `/admin` (security, grants, read-only lists) vs Growth & Revenue (deactivate, beta queue) vs Customer Success (incidents by institution).

### 8.2 Proposed structure (RECOMMENDATION — reuse, not redesign)

**OVERVIEW** (exists): keep `ops_overview`; add S5–S8 domains (provider debt, email, AI provider, control plane); mount `db-authority`; move the alert-destination/last-delivery fact here.

**ATTENTION REQUIRED** (mostly exists as the unhealthy-first Connection Health list and the Customer Success incident preview): make it one list across sources with the standard abnormal-state vocabulary (§5.4), each row carrying its entity id and a doorway.

**ENTITY** (the real gap — one new surface): a **Customer view in CUSTOMER_SUCCESS** (grant-gated, operator-only, `systemDb`), rendering the per-user row from §3.6: beta request → account facts → Plaid Items (status, last sync, environment, incidents) → wallets → last activity → audit trail for this user. This requires an **explicit ruling change** to the observability privacy fence: today it forbids emails and resolvable owner ids in Platform Spaces by design. The ruling can stay strict for PLATFORM_OPS (fleet-level) and permit identity in CUSTOMER_SUCCESS only, since that is the area whose grant *means* "may see which customer". `ownerRef` in diagnostics should become a link into that view. No PlaidItem or Space detail page is needed beyond this; the item's execution timeline already exists (`refresh/executions/[id]/timeline`) and only needs `plaidItemId` scoping wired in the Pipeline widget (API supports it, UI does not).

**EVIDENCE** (exists): execution timeline, transition `since`, incident episodes, Brief failure reason, email delivery rows.

**ACTION** (exists for Plaid; extend): Resync (+cursor reset), Request reauth, Cleanup retry, Disconnect (new, Plaid-first), Deactivate, Resend invite/verification, Run Now for all jobs, Policies incl. maintenance/ingestion/alert toggles. Every action through the operator chokepoint with a reason.

**AUDIT/HISTORY** (exists; add filter): target-scoped audit query from the Customer view and from each entity row.

**/admin**: keep as the SYSTEM_ADMIN emergency console (grants, security, Expand History). Retire or wire the three stubs. Do not grow it; the beta is operated from Platform Spaces by the grant-holding account.

---

## 9. Public-site factual findings

**Shipped and accurately claimed:** bank/brokerage connections (read-only, Transactions + consented Investments), holdings, liabilities, cash flow, Daily Brief, Spaces (Personal/Family/Business), bcrypt passwords, AES-256-GCM token encryption, TOTP + recovery codes, audit of sign-ins/connections/exports, rate-limited auth endpoints, full export, deletion, closed beta.

**Stale or questionable:**
- `content/marketing/legal-ai.md:7` (== `site/content/legal/legal-ai.md`, unchanged since 2026-07-14): "not a chat window you have to prompt" — false since Conversations shipped (`app/api/ai/chat/route.ts`, `dashboard/analyze`). `:19` names no provider (OpenAI) and no retention window; `provider.ts` sets no `store`/ZDR flag so retention is a vendor-terms decision. Already an OPS-1 blocker in `production-readiness.md:20,74`; `STATUS.md:21,45` still claims `503 AWAITING_REDESIGN`.
- No published support address anywhere user-facing; `support@fourthmeridian.com` exists only as a sender identity (`lib/email/senders.ts:35-51`); legal docs defer to the beta form.
- Landing "Goals" Space card maps to a legacy `SpaceCategory.GOAL`; goals are a feature inside Spaces (`app/(public)/page.tsx`).
- Deletion copy omits the reversible grace window; "export at any time" is 3/day.
- Positioning: the site self-describes as "an intelligent financial ecosystem"; "AI-native wealth management" appears nowhere on any page (once in docs as an open question); `product-language.md:140` still lists "calm operating system" as a tagline candidate (docs only); `public/manifest.json` says "Personal finance dashboard".
- HSTS declared in `site/vercel.json` but not observed on Preview (`domain-split-preview.md:153`); verify on Production.
- OpenGraph/Twitter metadata has no image (`site/app/layout.tsx:18-19`).

**Screenshots/demo dependencies:** none — the site has no product screenshots; the "Intelligence" card and hero signals are illustrative prose. Assets: `site/public/hero/earth-mena.jpg`, `brand/fm-mark-dark-128.png`, icons. Untracked `app/prototype/landing` is contained by `lib/prototype-containment.test.ts`.

**Beta-lifecycle integration points:** static hand-off to `{appOrigin}/request-access` and `/login`; no analytics/UTM anywhere (the surface test forbids `fetch`/`sendBeacon`); `APP_LINKS` do not forward the query string, so attribution dies at the click unless the link forwards `?utm_*`. The login page has no request-access link.

**Later polish requirements:** rewrite `legal-ai.md` (provider, retention, conversational surface) and bump "Last updated"; publish a support address; fix Goals card; disclose grace window; decide whether to claim crypto wallets, FX and PWA (shipped, unadvertised); add an OG image; verify HSTS; align positioning vocabulary.

---

## 10. Recommended implementation slices

Ordered by dependency and value. Skeptical about P0: P0 means *cannot be backfilled* or *the owner would not learn about user-facing breakage in week one*.

### P0 — before inviting beta users

| Slice | Content | Why P0 | Authority reused |
|---|---|---|---|
| **P0-1 AI ledger dimensions** | Owner decision on per-user/Space attribution; if yes, nullable `userId`/`spaceId` on `AiInvocation` (fm_system read only); random `conversationId` in the sealed cookie replacing the colliding hash; `subSurface` for the labeller | not reconstructable from day counters | `AiInvocation`, `lib/ai/provider.ts`, sealed cookie |
| **P0-2 AI failure facts** | failure/quota/timeout row on `AiInvocation` (zero tokens) from `provider.ts` catch paths and `rate-limit-retry.ts.onRetry`; Sentry capture at the quota branch; Overview AI domain reads it | the next outage must be visible in the product before a user reports it | same + `overview-core.ts` |
| **P0-3 Plaid webhook + environment facts** | append-only verified-webhook row (`externalItemId`, type, code, handled, statusAtReceipt); guard the webhook path on `status`/owner `deactivatedAt` like cron does; confirm `environment` stamps `production` on both ledgers | the beta's first `USER_PERMISSION_REVOKED` is otherwise lost; one provider account spans all envs | `webhook/route.ts`, `webhook-sync.ts` |
| **P0-4 Alerting floor** | `PLATFORM_ALERTS_EMAIL` → `PROD_REQUIRED_KEYS` and set; exclude REVOKED and deactivated-owner items from the health population; `evaluate-alerts` on every dispatcher slot; job failures captured to Sentry | day-one critical noise (3 REVOKED prod Items) + 24h detection latency + no AI/job capture | `lib/env.ts`, `health.ts`, `evaluate.ts`, registry slots |
| **P0-5 Beta intake capture** | `source Json?` (referrer host, `utm_*`, landing path, country), `lastRequestedAt`, `requestCount` on `BetaAccessRequest` (non-enumerating upsert); site forwards query string; render `emailStatus` beside each invitation; approve refuses existing users; template takes `expiresDays` | attribution and re-request evidence cannot be backfilled; invite-delivery is the first support loop | `access-request/route.ts`, `getRequestMeta`, widget |
| **P0-6 Operate from one grant-holding account (no code)** | verify the production USER account holds ACTIVE grants on all five areas (incl. MERCHANT_OPS, added 10-06); Turnstile keys in production (known config act); replace the SQL/Vercel steps in `background-jobs.md` and `production-readiness-checklist.md` with the product surfaces | the role wall is by design; the mitigation already exists in prod | `PlatformGrant` |

### P1 — during early invite-only beta

- **P1-1 Customer view** in CUSTOMER_SUCCESS (per-user row of §3.6; explicit privacy-fence ruling for that area only); `ownerRef` → link; `plaidItemId` scoping in the Pipeline widget; cohort projections (invited-never-registered, registered-never-connected, inactive N days, reauth-required per user); rename "Activated" → "Redeemed" and redefine activation as first-connection-based.
- **P1-2 Operator chokepoint + reason** (`runOperatorAction`), migrate the 22 writers, typed vocabulary, standard target keys, actor on `JobRun`/`RefreshExecution`, target-scoped audit query, feed/group coverage, operator readers on `systemDb`, drop PII from operator metadata, move the merge recovery snapshot out of `AuditLog`.
- **P1-3 Control-plane levers**: `maintenance_mode`/`ingestion_paused` and alert-rule toggles as CONTROL descriptors in Policies; "platform paused since X" on Overview; Run Now for the remaining jobs; register `resume-stale-imports`; retire the legacy per-job routes or make them write `trigger:"manual"` with audit.
- **P1-4 Health domains S5–S8**: held deletions, email dead-letter (+ retry/mark-obsolete action), alerts-undeliverable, env-report coverage (`PLAID_*`, `OPENAI_API_KEY`, alert/beta emails), mount `db-authority`; Brief re-generate lever.
- **P1-5 Direct-email delivery rows** (beta/verification/reset/alerts) + non-prod recipient allowlist; Plaid `billedProducts`/`productsObservedAt`/`retiredAt`; `ProviderInvoice` manual record and estimate-vs-invoice card; relabel the `cost` route.
- **P1-6 Plaid operator actions**: Disconnect (Plaid-first ordering from `remove-plaid-connection.ts`), `resetCursor` on resync, resend-verification; remove or wire the three stubs.
- **P1-7 Docs reset**: `STATUS.md` (8th drift cycle), `platform-operations.md`, `admin-operations.md`, `background-jobs.md`, `incident-response.md`, `app/api/platform/README.md`, `legal-ai.md` + support address (the latter two are already OPS-1 blockers, not this initiative's).

### P2 — operational maturity

- DB-level append-only (`REVOKE` + trigger with scrub exception); retention sweeps for `JobRun`, SYSTEM-actor audit rows, expired sessions.
- Scripts into the operations registry (safe ones) or mandatory `--reason` + audit (destructive ones).
- Resend webhook consumer (bounces/complaints); Plaid ITEM-webhook-driven health; dispatcher tick fact; pending-migration readback from a build manifest.
- OpenAI Costs API puller (if confirmed) into `ProviderInvoice`; per-user cost cards once P0-1 dimensions have data; sub-surface split; verify `reasoningTokens` capture; delete `generateChatReply`.
- Recent-TOTP step-up for CONTROL and 2FA-reset.

### DEFER — explicitly not part of launch

Infra cost automation (Vercel/Supabase/Sentry telemetry); Slack/pager channels; SYSTEM_ADMIN break-glass UI into Platform Spaces; a Deployments workspace (deployment is a dimension already); public-site analytics (would break the no-`fetch` proof); multi-operator role design; webhook URL re-pointing tooling beyond the one-time cutover script; a generic operational-event table (forbidden by doctrine §K).

---

## 11. Risks / unresolved architectural questions

1. **Per-user cost attribution reverses a recorded privacy decision.** The cost plan's own security note warns ops surfaces aggregate "exactly the metadata an attacker wants"; adding `userId` to `AiInvocation` is safe only with fm_system-only read and no tenant path. Owner decision required before user #1.
2. **The observability privacy fence vs the Customer view.** Relaxing identity redaction for CUSTOMER_SUCCESS only is coherent with the grant model but is a ruling, not a refactor; the source-scan tests will need an area-scoped exemption rather than deletion.
3. **Which Plaid cycle reading is billed** (any-Item-during-cycle vs Items-at-cycle-end) remains unsettled; one invoice with a mid-cycle removal settles it. Pre-July cycles are unpriced by design.
4. **One Plaid client id and one OpenAI key span dev/preview/prod**; `environment` stamping is the only separator and legacy Items are null. Development churn mints real billable Items (~97% of the July bill).
5. **`db` as BYPASSRLS principal in every operator route** is documented as out of scope for the RLS cutover; it also means the `fm_auth` grants on `BetaAccessRequest` are unreachable from the routes that import `db`. Settle in the RLS lane, not here.
6. **Alert cadence vs 60s `maxDuration`-style budgets**: running `evaluate-alerts` on every slot is cheap but changes the alert history store's row count; the JobRun-as-alert-store design should be checked for read cost at 5×/day.
7. **No restore drill has ever been performed**, and `ENCRYPTION_KEY` rotation is blocked on it. Outside this initiative, but every operational guarantee above sits on top of it.
8. **Webhook-on-REVOKED pipeline run** is static evidence only; confirm at runtime in Sandbox before classifying as a shipped defect.
9. **`reasoningTokens` = 0 on every dev row** — either a model default or a missing response field; verify live before any reasoning-cost explanation ships.

---

## 12. Explicit non-findings (investigated, no change required)

- The grant model, fresh-session gating, transactional grant admin, SYSTEM_ADMIN-only issuance, and the pure/impure authorize split.
- The beta redemption invariant (token-only lookup, email-bound, consumed in-transaction, count≠1 aborts) and the non-enumerating intake.
- The same-origin request-access design and the write-origin boundary; the "404 ⇒ queued" trap is closed; the site is static with no form by proof.
- Cost doctrine: no stored dollars, versioned rates in code, Plaid call counters never priced, Item-month grain from a real invoice.
- The 34e592c admin settings closure; `DISABLE_SYSTEM_ADMIN` env-only; SYSTEM_ADMIN promotion script-only; migrations and backups outside the product; `db:wipe` and hard purge never in-product.
- The Overview's per-domain verdict shape with UNKNOWN demoted — correct; extend, don't replace.
- Platform Ops IA for PLATFORM_OPS (8 workspaces) — no reorganisation warranted; the doctrine's "Customers belong in Customer Success" ruling stands.
- Prototype trees are untracked and contained (`lib/prototype-containment.test.ts`); the admin mock-up PNG is superseded design evidence.
- Scripts governance (`audit-registry.ts` tiers) already answers "which scripts are operator tools".
- `/api/health` deliberately process+DB only; correct for uptime pings.

---

## Final question

> If Chris invited the first five real beta users tomorrow, what would he still be forced to use Claude Code, SQL, Supabase, Vercel, Plaid, OpenAI, Resend, or other external consoles to understand or operate — and which of those dependencies should Project OPERATIONALIZATION eliminate before he does so?

**Forced today:**

| Need | Forced tool | Eliminate before inviting? |
|---|---|---|
| "Did user X's invite / verification email arrive?" | Resend console | **Yes** (P0-5 minimal: render `emailStatus`; P1-5 rows) |
| "Where did these five requests come from?" | nowhere — not captured | **Yes** (P0-5; cannot be backfilled) |
| "Is the AI down / out of credits?" | OpenAI dashboard, or a user's report | **Yes** (P0-2) |
| "Did anything break overnight?" | wait for the 07:30 email, if `PLATFORM_ALERTS_EMAIL` is set; otherwise Vercel Crons | **Yes** (P0-4) |
| Daily critical `provider-unhealthy` noise from 3 REVOKED prod Items; muting a rule | SQL | **Yes** (P0-4 population fix; P1-3 toggles) |
| "Which user does this broken connection belong to?" | second account's `/admin/providers`, or SQL | Mitigated by the two-account pattern (P0-6); properly solved by P1-1 |
| "What has this user cost us?" | nowhere (AI by design); SQL for Plaid Item-months | **Decide** now (P0-1); readers P1/P2 |
| Pause ingestion / maintenance mode | SQL, or pull `CRON_SECRET` in Vercel | P1-3 (rare; acceptable to defer past day one) |
| Per-item audit trail; who did what and why | SQL across five metadata spellings; reason never recorded | P1-2 |
| Re-run `process-deletions`, `evaluate-alerts`, `resume-stale-imports` | curl with `CRON_SECRET` | P1-3 |
| Remove an item, reset a cursor, hard-purge | scripts (`plaid:remove-connection`, `plaid:recover-transactions`, `plaid:purge-connection`) | P1-6 for the first two; purge stays D |
| Is prod schema behind the deploy? RLS posture? | `db:drift` script; SQL (route exists, no widget) | P1-4 / P2 |
| Deploy, env vars, secret rotation, migrations, backups, restore, Plaid keys/URIs/billing, Resend domain, Sentry triage, raw logs | Vercel / Supabase / Plaid / Resend / Sentry | **No — appropriate external administration (A/D)**; only readbacks move in-product |

**Should be eliminated before the first five invitations:** the write-path telemetry that cannot be recovered later (P0-1, P0-2, P0-3, P0-5) and the alerting floor that lets the owner hear about breakage from the product rather than from a user (P0-4). Everything else is either already inside the product under the grant-holding account, or belongs outside it on purpose.
