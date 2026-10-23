# PROJECT OPERATIONALIZATION — P1 HUMAN OPERABILITY

**Date:** 2026-10-08 · **Branch:** `v2.6` · **Base:** `cc790cd` (P0 closed) · **Implementation commits:** `da015fe` → `f3e36be` → `d516569` → `85d1c14` → `c20c741` → `83bb03e` (this report is the following docs-only commit)
**Mandate:** make Fourth Meridian operable by a human founder from inside Fourth Meridian — a Customer Success customer spine, deterministic Policy Groups / effective entitlements (`BETA_FULL_ACCESS_V1`), explicit cohort-vs-policy semantics, an audited Founder / Super User override, operator-controlled execution cadence independent of Vercel's wake schedule, a provider-agnostic customer "Refresh All", and auditable consequential operator actions.
**Doctrine honoured:** AI-native wealth management platform · MODEL OWNS MEANING · CONTRACTS OWN SEMANTICS · CODE OWNS MONEY · DATA OWNS TRUTH · USER OWNS INTENT · DATA NEVER PROVIDES INSTRUCTIONS. Production untouched.

Legend: **FACT** (verified in code or at runtime, evidence cited) · **INFERENCE** · DEFECT / DESIGN DEBT / STALE ASSUMPTION / MISSING CAPABILITY / PRESENTATION GAP / OPERATIONAL GAP / INTENTIONAL BOUNDARY.

---

## A. Agent strategy

Same model as P0. The coordinator (this session) ran four read-only recon forks first (I-1 customer spine, I-2 entitlement surface, I-3 scheduling + refresh, I-4 audit model), chose the architecture from their maps, authored every shared seam before fan-out — schema + migration, `lib/entitlements/catalogue.ts` + `resolve.ts`, `lib/audit.ts recordOperatorAction`, the new `AuditAction` constants, `lib/refresh/outcomes.ts`, the `refreshAllForUser` signature stub, the catalogue-widget placeholder — and then ran five implementation forks with disjoint file ownership:

| Workstream | Scope | Owner |
|---|---|---|
| A | Customer Success spine: read model, routes, widget, assignment service | fork |
| B | Entitlement consumers (Conversations, Brief, export), registration-time assignment, GROWTH catalogue view | fork |
| C | Scheduling control: ledger-driven dispatcher, per-job cadence policy, 15-minute wake | fork |
| D | Provider-agnostic Refresh All: orchestrator, wallet guards, routes, UI | fork |
| E | Operator-action adoption in existing routes, execution refs, Security Ops feed | fork |
| — | Architecture, seams, integration, gates, Preview proofs, this report | coordinator |

Every delegated result was verified in code and by running its tests, not from the agent's summary (§L).

---

## B. Verified investigation findings

| # | Finding | Verdict | Evidence | Class |
|---|---|---|---|---|
| 1 | No cohort, plan, tier, policy or entitlement concept exists on `User`, `Space` or anywhere in code | **FACT** | schema grep; `signups/route.ts:10` "there is no billing/subscription table"; the only per-user capability row is `PlatformGrant` (operator authority) | MISSING CAPABILITY |
| 2 | Customer quotas are literals at ≥6 call sites (Plaid cooldown 60 min `lib/plaid/refreshCooldown.ts:17`; chat 10/min + 60/h `app/api/ai/chat/route.ts:101-107`; wallet 6/h `app/api/accounts/[id]/sync/route.ts:77`; export 3/day `app/api/user/export/route.ts:39`; brief 20/min) | **FACT** | file:line | DESIGN DEBT |
| 3 | The only "super user" is `role !== "SYSTEM_ADMIN"` at four call sites — a role conditional that exempts an account the role wall keeps out of `/dashboard`, i.e. nobody who uses the product | **FACT** | chat `:101`, brief generate `:30`, wallet sync `:76`, totp verify `:33`; `proxy.ts:146-147` | DESIGN DEBT (P1-4 target) |
| 4 | `RefreshPolicyRequest.tier` is reserved `never` as the sanctioned per-customer override seam | **FACT** | `lib/platform/refresh-policy.core.ts:97` | STALE ASSUMPTION (filled, not bypassed) |
| 5 | CUSTOMER_SUCCESS holds one fleet-wide widget and its own description says no purpose-built primitives exist; GROWTH_REVENUE already resolves identity for its user list | **FACT** | `lib/platform/policy.ts:184-196`; `growth-revenue/users/route.ts` | MISSING CAPABILITY / PRESENTATION GAP |
| 6 | Every per-customer question except cohort/policy is answerable today or by join from existing ledgers (User, UserSession.lastActiveAt, SpaceMember, PlaidItem/Connection + `deriveConnectionHealthState`, SyncIssue/RefreshExecution/PlaidWebhookEvent via item joins, AiInvocation.userId (P0), AuditLog userId+performedByAdminId) | **FACT** | I-1 map | reuse, no new store |
| 7 | Two "last active" authorities: `UserSession.lastActiveAt` (request-level, throttled 60 s) and `AuditLog LOGIN` (coarse) | **FACT** | `lib/auth/session-activity.ts:51-86`; `lib/platform/activity/activity.ts` | DESIGN DEBT (spine names which answered) |
| 8 | Due-ness is pure slot membership; no overlap guard; `nextExpectedRun` is slot arithmetic; changing Plaid/crypto frequency means editing `registry.core.ts` + `vercel.json` + redeploy | **FACT** | `lib/jobs/dispatch.ts:56-63`; `lib/jobs/run.ts:160-185`; `lib/jobs/health.ts:226-230,264-265` | OPERATIONAL GAP / DESIGN DEBT |
| 9 | The BANK refresh-cadence setting governs overdue judgement and the Brief watermark but NOT execution (`sync-banks` syncs every ACTIVE item every run); the Policies workspace implies otherwise | **FACT** | `jobs/sync-banks.ts:165`; `lib/crypto/wallet-refresh.ts:45` (wallets DO honour it) | STALE ASSUMPTION |
| 10 | `assessCadence`'s multiple-of-period rule exists only because due-ness is slot membership | **FACT** | `refresh-policy.core.ts:129-150` | DESIGN DEBT that dissolves |
| 11 | Every user refresh control posts `/api/plaid/refresh`: "Refresh" means "refresh Plaid"; wallets are never touched | **FACT** | `components/dashboard/RefreshButton.tsx:6`, `AccountRefreshButton.tsx:28`, `ConnectionMenu.tsx:69` | DEFECT vs product contract |
| 12 | Wallet manual sync has no cooldown, no DB lock and no admission check (Plaid has all three) | **FACT** | `app/api/accounts/[id]/sync/route.ts`; `lib/plaid/refreshCooldown.ts`; `lib/plaid/sync-lock.ts` | DESIGN DEBT |
| 13 | Three outcome vocabularies for one concept (`RefreshItemResult.skipped`, `WebhookSyncOutcome`, wallet sweep tally) | **FACT** | I-3 map | DESIGN DEBT |
| 14 | Zero operator writes carry a reason; `AuditLog.userId` means operator in some routes and customer in others and is null for connection actions; no audit row references a JobRun or RefreshExecution; `lib/audit.ts` has the intended envelope and no operator callers | **FACT** | I-4 table; `operations/route.ts:140-160` | DESIGN DEBT / MISSING CAPABILITY |
| 15 | Vercel fires crons on Production only; Preview jobs never run except through Run Now (P0 lever) | **FACT** (P0) | Preview `JobRun` had 0 `evaluate-alerts` rows before P0 | INTENTIONAL BOUNDARY (infra) |
| 16 | Platform ceilings that must stay above any policy: chat 60/h ("stolen admin session" bound), 16 tools / 6 round-trips per turn, export 5,000-row cap, Brief lease/cooldowns, wallet 6/h (shared-IP explorer ban), admission facts | **FACT** | I-2 inventory | INTENTIONAL BOUNDARY |

No assumption in the mandate conflicted with a stronger existing authority. One mandate example was adjusted by repo truth: a per-customer FX/market cadence has no legitimate consumer (FX is a platform archive refreshed stale-while-revalidate on read), so it is not an entitlement dimension.

---

## C. Architecture decisions and authorities

**C.1 Definitions in code, assignments as data, effective value a read-time reduction.** _FACT:_ the codebase already versions prices (`AI_RATES`), cadences (`DEFAULT_REFRESH_CADENCE`) and setting descriptors in code. _Decision:_ `lib/entitlements/catalogue.ts` holds `ENTITLEMENT_DIMENSIONS` (each with a code-owned **ceiling**), `POLICY_GROUPS` (`BETA_FULL_ACCESS_V1`), `OVERLAYS` (`FOUNDER_INTERNAL_V1`), `COHORTS` (`CLOSED_BETA_2026`); two small tables hold assignments (`CustomerPolicyAssignment` one row per user, `CustomerCohort` append-only). _Rationale:_ a `PolicyGroup` table would make definitions editable data and break review-by-commit; a PlatformSetting is platform-wide by construction. GROWTH_REVENUE "owns definitions" through a read-only catalogue view and commit provenance; CUSTOMER_SUCCESS assigns.

**C.2 Deterministic precedence, explainable per dimension.** `resolveEffectiveEntitlements(facts)` (pure): POLICY (or POLICY_DEFAULT when unassigned — reported, never hidden) → OVERLAY (only the dimensions the overlay defines) → CEILING applied last (counts capped, floors raised, booleans AND-ed); a value the ceiling changed reports `source: CEILING`. An unknown (retired) group or overlay key resolves to the default and is reported as unknown. `explainEntitlement(d)` yields the sentence an operator or a refusal shows. "Platform policy / safety constraint" (admission facts, locks, provider cooldown floors) is enforced where work executes, not in the resolver — both are explainable, neither can exceed a ceiling. "Unlimited" never appears: every count has a ceiling.

**C.3 Founder / Super User override = a named, code-owned OVERLAY assigned to one customer with a reason.** _Decision rationale:_ not a hardcoded email/id, not SYSTEM_ADMIN (the role wall keeps that account out of the product), not an undocumented flag, not free per-dimension values (abuse-prone and unreviewable). `FOUNDER_INTERNAL_V1` raises plan quotas to the ceilings (30/min Conversations, 15-minute bank cooldown, 10 exports/day) and changes nothing that IS a ceiling (60/h, 6 wallet syncs/h). Assignment is a fresh CUSTOMER_SUCCESS WRITE with a structured reason, audited with before/after.

**C.4 Cohort ≠ policy.** `CustomerCohort` rows are historical identity (why/how/when: `source INVITE|OPERATOR`, `joinedAt`), entitle nothing, and are never edited when a policy changes. Redeeming a beta invite creates `CLOSED_BETA_2026` + the default policy assignment in the registration transaction; existing users are NOT backfilled (the operator assigns from Customer Success, audited) — nothing fabricates a history that did not happen.

**C.5 RLS.** Both assignment tables: RLS enabled and forced; `fm_app` SELECT own rows only (so product routes resolve entitlements on the tenant role); `fm_auth` INSERT (registration redemption); `fm_system` all (operators through the audited service); `fm_backup` SELECT. No tenant write path exists — a customer cannot change their own policy.

**C.6 Operator actions extend `AuditLog`, no new table.** `recordOperatorAction` (lib/audit.ts): `performedByAdminId` = operator always; `userId` = the customer when the target is a USER (visible to that customer as "who acted on my account", indexed for the per-customer panel); `spaceId` for a SPACE target; fixed metadata envelope `{actorType, result, actor:{via,area}, target:{kind,id}, reason?, change?, execution?}`. Reason is REQUIRED BY TYPE for policy/overlay/cohort assignment, cadence changes and customer deactivation (`REASON_REQUIRED_ACTIONS`); a Run Now, a resync or a beta-queue decision needs none. Notes are ≤280 chars and scrubbed (no email, no 4+ digit run, no credential words). Consequential writes record inside the same transaction as the change. Doctrine §K (no generic event table) honoured.

**C.7 Wake ≠ execution policy ≠ entitlement.** Vercel wakes `/api/jobs/dispatch` every 15 minutes; Fourth Meridian decides due-ness from the JobRun ledger and a bounded, audited per-job cadence (BANK/WALLET cadences ARE the existing refresh-policy settings — no second knob; fx, prices and alerts get integer descriptors with code-owned min/max; deletions and maintenance jobs are FIXED). An in-flight claim makes overlapping wakes safe. Details §H.

**C.8 Refresh All composes, never re-implements.** One orchestrator over the existing execution primitives (`runFullRefresh` under the Plaid item lock; `syncWalletByChain` under a new wallet claim mirroring Plaid's), one outcome vocabulary (`lib/refresh/outcomes.ts`), two authorities (USER: entitlement-bounded; OPERATOR: audited `OPERATOR_REFRESH_ALL`), both under the same ceilings. Details §I.

---

## D. Customer Success spine (Workstream A)

**Read model** (`lib/platform/customer/`): `customers.ts` (bounded list ≤200, search by email/name/username), `customer-detail.ts` (one customer, every spine question), pure `customer-core.ts` projections (allowlist mappings only), all on `fm_system`. **Routes:** `GET /api/platform/customer-success/customers` and `…/customers/[userId]` (CUSTOMER_SUCCESS READ); `POST …/[userId]/policy`, `…/cohort` (fresh CUSTOMER_SUCCESS WRITE, structured reason parsed first → 400 on an invalid shape), `POST …/[userId]/refresh` (fresh WRITE; `refreshAllForUser` authority OPERATOR; audited `OPERATOR_REFRESH_ALL` with the outcome summary and execution ids; 409 for a deactivated customer). **Widget:** `CsCustomersWidget` under new section `cs_customers` (Customer Success workspace; `cs_sync_issues` kept).

| Spine question | Answered from (join, no new store) |
|---|---|
| Who | `User` identity (the ruled identity-resolving area) |
| Cohort | `CustomerCohort` + catalogue label |
| Policy / effective entitlement + why | `CustomerPolicyAssignment` → `loadEffectiveEntitlements` → per-dimension `source` + `explainEntitlement` |
| Beta lifecycle request → invite → email → redeem → connected | `BetaAccessRequest` by email, `BetaAccessRequestEvent` count/first source, invite email outcome from AuditLog `metadata.emailStatus`, `BETA_ACCESS_REDEEMED`/`User.createdAt`, first `PlaidItem`/`Connection` |
| Spaces | `SpaceMember × Space` (role/status as strings) |
| Last active | `max(UserSession.lastActiveAt)`, LOGIN audit fallback — the authority that answered is named |
| Connections + health | `PlaidItem` / non-Plaid `Connection` + `deriveConnectionHealthState` under the refresh policy; never token/credential/cursor |
| Incidents | open `SyncIssue` via item/account joins, last 20 `RefreshExecution`, last 20 `PlaidWebhookEvent` |
| AI usage / failure / cost | `AiInvocation where userId` (30 d): by outcome and surface, distinct conversations, `priceAiUsage` estimate labelled as such; never prompts |
| Operator actions | AuditLog `userId = customer AND performedByAdminId not null` ∪ connection-action rows naming the customer's items; P1 envelope projected |
| Safe actions | assign policy / overlay / cohort (reason-gated), Refresh all (operator), existing deactivate/reactivate and invite resend through their own gates |

**Privacy test:** a fake customer carrying `encryptedToken`, `cursor`, `credential`, `balance`, `passwordHash` produces none of them in the detail JSON. **Boundary decision recorded:** `lib/platform/customer/customer-detail.ts` is allowlisted in `lib/platform/refresh/read-boundary.test.ts` as a per-customer reader of the DF-2 refresh ledger (the fleet seams carry no owner by design).

## E. Policy Groups / effective entitlements (coordinator + Workstream B)

`BETA_FULL_ACCESS_V1` = conversations ✓, dailyBrief ✓, 10 turns/min, 60 turns/h, 60-min bank cooldown, 6 wallet syncs/h, 3 exports/day. **Ceilings** (never assignable): 30/min, 60/h, 15-min cooldown floor, 6 wallet syncs/h, 10 exports/day. **Consumers converted (B):** `app/api/ai/chat` (both windows from the entitlement; `conversations=false` ⇒ 403 with no model call; role exemption removed), `app/api/brief/*` (`dailyBrief` gate; role exemption on the 20/min pacing removed), `app/api/user/export` (`exportsPerDay`), and through Workstream D every manual refresh (bank cooldown minutes, wallet syncs/hour). `lib/entitlements/consume.ts` (`entitlementsForUser` via one `withTenantDb` phase; `refuseIfDisabled`; `countLimit`) is the one way product routes ask. `consume.test.ts` proves the hour window cannot exceed 60 across every group × overlay. **Registration:** every new user gets the default assignment in the registration transaction; an invite redemption adds the `CLOSED_BETA_2026` cohort. **Catalogue view:** `GET /api/platform/growth-revenue/policy-groups` + `GrowthPolicyGroupsWidget` (GROWTH_REVENUE READ; definitions, ceilings, counts of customers per group/overlay/cohort, unassigned count — no identities).

## F. Cohort semantics

`CustomerCohort` is append-only membership with `source` (`INVITE` | `OPERATOR`) and `joinedAt`; it entitles nothing; the catalogue defines `CLOSED_BETA_2026`. A policy change never edits a cohort row. Existing users carry no fabricated cohort; the operator may add one from Customer Success with a reason.

## G. Founder / Super User override

`FOUNDER_INTERNAL_V1` overlay (code-owned values: 30/min, 15-min cooldown, 10 exports/day; nothing above a ceiling), assigned per customer from Customer Success with a required reason, audited `CUSTOMER_POLICY_OVERLAY_CHANGED` with before/after. Resolved per dimension as `source: OVERLAY` (or `CEILING` if a ceiling bound it). Subject to admission facts, provider locks and cooldown floors, rate ceilings, concurrency guards — all enforced at execution. The four `role !== "SYSTEM_ADMIN"` product exemptions are gone (chat, brief, wallet sync); the TOTP-verify one is an auth control and out of scope.

## H. Scheduling control (Workstream C)

**Wake:** `vercel.json` dispatch cron → `*/15 * * * *` (wake only). **Execution policy:** `lib/jobs/cadence-policy.core.ts` resolves per job `{hours, origin, min, max, editable}`; due iff never ran or `now − lastStartedAt ≥ cadence − 5 min`; not due while the newest row is `running` and < 6 min old (overlap guard); continuation due iff the primary reported deferred work, ≥15 min ago, and not yet continued. `dueJobs` no longer reads slots; dispatch results carry `skipped[{job, reason, nextDueAt}]`.

| Job | Default | Min–Max | Origin | Editable |
|---|---|---|---|---|
| sync-banks | 24h | floor 6h | REFRESH_POLICY (`refresh_cadence_bank`) — the BANK setting now governs execution | Policies → Bank refresh (CONTROL) |
| sync-crypto | 6h | floor 4h | REFRESH_POLICY (`refresh_cadence_wallet`) | Policies → Wallet refresh (CONTROL) |
| sync-crypto-continuation | follows primary | — | FOLLOWS_PRIMARY | no |
| fetch-fx-rates, fetch-security-prices | 24h | 6–168 | `job_cadence_hours_<job>` | yes, with reason |
| evaluate-alerts | 6h | 1–168 | `job_cadence_hours_evaluate-alerts` | yes, with reason |
| process-deletions, notification-cleanup/retry, purge-trash, rate-limit-sweep | 24h | — | FIXED | no |

**Mutation:** `lib/platform/policies/job-cadence.ts` — descriptor validation (descriptors gained `max`), optimistic token, one transaction with `recordOperatorAction` (`JOB_CADENCE_CHANGED|RESET`, target JOB, reason required, before/after); route `app/api/platform/platform-ops/job-cadence` (READ / fresh CONTROL). The BANK/WALLET honourability rule became "at or above the kind's floor" (8h is now honourable; the slot-multiple rule dissolved). Health's `expectedEveryHours`/`nextExpectedAt` follow the resolved cadence. Behavioural note: daily jobs drift from fixed UTC times by their own runtime (sub-minute per day). Mail volume unchanged at any alert cadence (20 h re-notify).

## I. Provider-agnostic Refresh All (Workstream D)

`lib/refresh/refresh-all.ts`: admit once → refreshable (non-ACTIVE Item / unsupported chain ⇒ REFUSED NOT_REFRESHABLE) → entitlement → cooldown (`manualBankRefreshCooldownMinutes`, one window for banks AND wallets, `retryAfterSeconds` reported) → wallet per-user rate (`manualWalletRefreshPerHour` ⇒ REFUSED RATE_LIMITED, never a thrown 429) → lock (Plaid inside the canonical fan-out; wallets via the new `Connection.syncLockedAt` claim, TTL 360 s) → execute (STARTED with `executionId`; FAILED/ERROR isolated per authority). Plaid executes only through `refreshAllActiveItemsForUser`, wallets only through `syncWalletByChain`; wallets run sequentially under a 90 s budget (`BUDGET` skips, nothing dropped). **Operators obey the same cooldown; only the ledger trigger differs** (MANUAL vs OPERATOR). No database client is imported in `lib/refresh/` — the caller passes the client it is entitled to (`tenantRefreshDeps` for the customer, `clientRefreshDeps(systemDb)` for an operator). **Routes:** `POST /api/refresh/all` (requireUser, 6/h backstop, audit `REFRESH_ALL_REQUESTED` with counts only); `/api/plaid/refresh` bulk branch is a thin Plaid-only caller; the wallet sync route gained admission (503), the entitled cooldown (429), the entitled hourly ceiling (no role exemption) and the claim (409). **UI:** the header Refresh calls `/api/refresh/all`; the banner reads the structured outcomes ("3 refreshed · 1 on cooldown (42m) · 1 not refreshable") and says "Synced" only when every authority STARTED.

## J. Operator action / audit model (coordinator + Workstream E)

`recordOperatorAction` (§C.6) adopted in: Run Now (`execution.{commandId, jobRunId}`, target JOB; result from outcome), connection resync (target PLAID_ITEM, `execution.refreshExecutionId` from `runFullRefresh`'s run id), request-reauth, provider-cleanup (owner no longer written as `userId`), customer deactivate/reactivate (reason REQUIRED; deactivation written then every session revoked — the order `session-token-exposure.test.ts` pins), plus every P1 route (policy/overlay/cohort assignment, cadence change, operator refresh). `operatorActorFrom(auth, area)` derives `via` (PLATFORM_GRANT vs SYSTEM_ADMIN). The Security Ops feed (`lib/platform/security/operator-actions-core.ts`) projects target as `<kind> …<last6>`, reason code, result and opaque execution handles — never the note, never email — with legacy rows falling back. The five beta-queue routes keep their current shape in P1 (a `BETA_REQUEST` target kind now exists for their adoption, P2). `/admin` break-glass routes (grants, 2FA reset, sessions) stay on their existing audit shape — P2.

## K. Data / migrations / RLS

- **Migration** `20261008000000_p1_customer_policy_cohort` (additive, no backfill, old client compatible): `CustomerPolicyAssignment` (userId @unique, policyGroup, overlay?, assignedById?, assignedAt, updatedAt; FK → User cascade), `CustomerCohort` (userId, cohort, joinedAt, source, assignedById?; @@unique(userId, cohort); FK cascade), `Connection.syncLockedAt` / `lastManualRefreshAt`. RLS on both tables: ENABLE + FORCE; `fm_app` SELECT own (`"userId" = current_fm_user_id()`), `fm_auth` INSERT (registration redemption), `fm_system` all, `fm_backup` SELECT. No tenant write path. No other schema change (job cadences are `PlatformSetting` rows under new integer descriptors).
- **Dev DB:** applied via `db:migrate:safe`; `migrate diff` shows no difference beyond the pre-existing truncated index name on `ProviderCapabilityObservation`.
- **Preview:** applied 2026-10-08 via the guarded `db:migrate:safe` (exactly this migration pending; status "Database schema is up to date!"); `scripts/seed-platform-spaces.ts` run once (idempotent) so `cs_customers` and `growth_policy_groups` reached the existing Customer Success / Growth & Revenue Spaces (verified: both rows enabled). `CustomerPolicyAssignment` and `CustomerCohort` hold **0 rows** on Preview — nothing was fabricated for existing users.
- **Production: UNTOUCHED.** Pending on Production is now 35 migrations including P0's and this one.
- **Ratchets honoured:** `audit-db-authority` (one correction: `job-cadence.ts` moved to `fm_system`, caught by the clean-copy run), `read-boundary` and the Plaid RLS acceptance both now NAME `lib/platform/customer/customer-detail.ts` as the fourth read seam over the refresh ledger (a recorded doctrine decision, not a loosened count).

## L. Tests / clean-copy CI / exact-SHA GitHub evidence

- **New tests:** `lib/entitlements/resolve.test.ts`, `consume.test.ts`, `consumers.test.ts`; `lib/operator-action.test.ts`; `lib/platform/customer/{customer-core,assign,customer-success-routes}.test.ts`; `lib/platform/operator-action-adoption.test.ts`; `lib/platform/security/*` projection test; `lib/jobs/cadence-policy.test.ts`; `lib/platform/policies/job-cadence.test.ts`; `lib/refresh/{refresh-all,wallet-lock,refresh-routes}.test.ts`; `lib/plaid/refreshCooldown.test.ts`. **Rewritten/updated pins (each with a rationale comment, no assertion loosened):** `lib/jobs/dispatch.test.ts` (ledger-driven due table), `cadence.test`, `job-health.test`, `scheduler-capability.test`, `policies/*.test`, `capability-control.test` (second CONTROL route), `platform-settings.test` (floor semantics; Platform Ops key set + 3), `refresh-policy.core.test`, `admission-boundary.test` (census 10 → 12), `refresh-fanout.test`, `accounts-spine-s1.authority.test`, five wallet-route scans (route + extracted post-sync module), `hardening.test` (entitlement windows, no role exemption), `chat/route.test` (`\bConversation\b`), `session-token-exposure.test` (deactivate-then-revoke order restored in the route), `beta-ops-guards`, `connection-ops-guards`, `read-boundary.test`, `scripts/rls-plaid-acceptance.ts` check 18.
- **Working tree gates:** `run-tests: 691/691 passed`; `tsc --noEmit` clean on committed trees; lint: no errors in tracked files; `audit-db-authority` all passed; site 45/45; `rls:accept:foreground` 67/67 locally.
- **Clean-copy CI (`npm run ci`, Node 24.21.0, throwaway `postgres:16`):** first run on `da015fe` FAILED (db-authority: one new `db` importer, three `= db` defaults in `job-cadence.ts`) → fixed in `f3e36be`; second run FAILED (Plaid RLS acceptance check 18 pinned the ledger read seams by count) → repinned by name in `d516569`; third run on **`d516569a4cae`: `[ci] PASSED — every CI job green on a clean copy of HEAD`** (test job incl. 691/691; architecture job incl. 25 REQUIRED audits and all five RLS acceptance suites; site job).
- **GitHub exact-SHA run on `d516569`:** run 37683808588 — `completed success`; `test`, `Architecture audits`, `Public site (zero-authority boundary)` all `success`. Pushed `cc790cd..d516569` after confirming the remote had not moved.
- **Preview deployment:** `fintracker1` Preview Ready on `d516569`; `vercel curl …/api/health` → `{"status":"ok","db":"ok","commit":"d516569"}`.
- **Follow-up commits after the owner's first Preview proofs:** `85d1c14` (operator Refresh All feedback beside the button via the shared describer; reason kept between actions; username-first operator lists) — clean-copy CI PASSED, GitHub run 37690914189 `success`, **but its Vercel Preview build FAILED**: two `"use client"` widgets imported `operatorDisplayName` from `customer-core.ts`, whose chain reaches the `server-only` refresh-policy loader, and Turbopack refused the browser bundle. _Lesson recorded:_ the local CI contract (`scripts/lib/ci-contract.ts`) runs tests, typecheck, lint, audits and the RLS suites but **no `next build`**, so a server-only/client-boundary violation is invisible to every gate before Vercel; a production build step belongs in the contract (deferred, §N). Fixed in the next commit (pure, import-free `identity-label.ts`; pinned so no client widget imports `customer-core`; verified with a local `npm run build`: "Compiled successfully").

## M. Preview runtime proofs

All evidence below is read-only from Preview's database (identities truncated to six characters; addresses masked). Production untouched.

**M.1 Operator grants (owner, `/admin`, 21:08 UTC 2026-10-07):** the operator USER account was raised from WRITE to CONTROL on PLATFORM_OPS, SECURITY_OPS, GROWTH_REVENUE and CUSTOMER_SUCCESS and granted CONTROL on MERCHANT_OPS — five `PLATFORM_GRANT_*` audit rows by the SYSTEM_ADMIN account. _Classification:_ expected break-glass administration; CONTROL is what the cadence editor requires.

**M.2 Policy assignment (Customer Success, 21:13–21:14 UTC):** target = the Sandbox lane customer. Two `CUSTOMER_POLICY_ASSIGNED` envelopes by the operator (`actor.via PLATFORM_GRANT`, `area CUSTOMER_SUCCESS`): the first `change.before = null → after {policyGroup BETA_FULL_ACCESS_V1, overlay FOUNDER_INTERNAL_V1}` with `reason {code BETA_ONBOARDING, note "DOGFOOD"}`; the second a no-change re-apply with `reason {code DOGFOOD}`. `CustomerPolicyAssignment` holds exactly one row for that customer (`BETA_FULL_ACCESS_V1 + FOUNDER_INTERNAL_V1`, `assignedById` = operator). The detail view showed per-dimension sources. _Note:_ the owner applied the overlay to the Sandbox customer rather than their own account; the UI did what was asked, and a no-change re-apply writes an idempotent audit row (acceptable).

**M.3 Cohort:** `CustomerCohort` holds 0 rows and no `CUSTOMER_COHORT_ASSIGNED` audit exists. _Root cause (FACT, code):_ the widget cleared the shared reason after the policy action succeeded, which left "Add cohort" silently disabled — a presentation defect, fixed in `85d1c14` (the reason is kept between consecutive actions and a hint names the requirement). Re-proof pending (§M.7).

**M.4 Execution cadence (Platform Ops → Policies, 21:15 UTC):** `JOB_CADENCE_CHANGED` by the operator, `target {kind JOB, id evaluate-alerts}`, `change {before {hours null, origin DEFAULT} → after {hours 1, origin SETTING}}`, `reason {code TESTING}`, `settingKey job_cadence_hours_evaluate-alerts`; `PlatformSetting` row present with value `1`. _Operational note:_ Preview receives no cron, so the cadence has no effect there; the recommendation is to RESET it through the same Policies editor after the proof (which also proves `JOB_CADENCE_RESET`), restoring the 6 h baseline rather than leaving a test value in a shared environment.

**M.5 Customer Refresh All (Sandbox customer, header Refresh, 21:17 UTC):** UI showed **"1 refreshed · 1 not refreshable"**. Ledger: `REFRESH_ALL_REQUESTED` (`actorType USER`, `policyGroup BETA_FULL_ACCESS_V1`, `summary {considered 2, started 1, refused 1, byReason {NOT_REFRESHABLE 1}}` — the REVOKED U.S. Bank item refused, the ACTIVE First Platypus Bank item started); one `RefreshExecution` `PLAID_ITEM / MANUAL / FULL_REFRESH / SUCCEEDED` at 21:17:27; the legacy per-item `PLAID_REFRESH` row (14 accounts updated) beside it. **Proven end to end.**

**M.6 Operator Refresh All (Customer Success, 21:18 UTC, pressed twice):** two `OPERATOR_REFRESH_ALL` envelopes by the operator on the same customer, `summary {considered 2, started 0, skipped 1, refused 1, byReason {COOLDOWN 1, NOT_REFRESHABLE 1}}`, `executionIds []` — the Plaid item was correctly on the customer's cooldown (refreshed 50 s earlier), the revoked item correctly not refreshable, no provider call made. **The backend behaved exactly as designed; the UI gave no acknowledgement** — the outcomes rendered at the foot of a long detail body while the button sits in the footer. _Classification:_ PRESENTATION / OPERABILITY DEFECT (P1 scope), fixed in `85d1c14`: the same one-sentence description the customer's button shows now renders beside the operator button, from the single describer that moved into `lib/refresh/outcomes.ts` (no operator-only semantics). Re-proof pending (§M.7).

**M.7 Second-round attempt after `c20c741` — RESOLVED: the two actions never reached a handler; the UI showed stale state.** The owner clarified: the cohort step was never attempted (its absence is expected); the operator Refresh All "showed the cooldown banner"; the cadence Reset was clicked, and after a hard reload the cadence still read 1 h. Evidence (Preview database, read-only):
- The cadence DELETE route calls `limitByUser("platform-policy")` through the generic principal **before any other work**; `RateLimit` holds exactly one `user:platform-policy` window — `21:15:00` (the first-round change) — and **no 22:xx window**. The DELETE therefore never executed in any Fourth Meridian function (an edge or session refusal, not a handler outcome).
- The operator refresh route writes `OPERATOR_REFRESH_ALL` unconditionally after a 2xx-worthy run (proven by the two 21:18 rows from the same route on the same database); no row exists after 21:18:51, so that request did not execute either.
- `UserSession.lastActiveAt` advanced to 22:35 (page loads after the hard reload), `n_tup_ins` on `CustomerCohort` is 0 (no attempt), `PlatformSetting` `n_tup_del` is 0.
- Vercel CLI runtime logs do not contain the first-round POSTs either, so they were not used as evidence.
_Root cause (FACT for the server side, INFERENCE for the client side):_ the tab from the first round still held the previous "cooldown" outcomes in state; the second-round requests failed before reaching a handler (consistent with a stale client after two deployments — the alias moved twice in the window — or a lapsed deployment-protection/app session); the widget rendered the failure text at the TOP of a long detail panel, out of view of the footer button, and did not clear the previous report, so the stale outcomes read as the new result. _Fixed in `OPERATIONALIZATION-P1-STALE-RESULT`:_ a new refresh clears the previous report before the request; a failed action is announced beside the footer buttons as an alert; a non-JSON refusal is named with its HTTP status ("did not reach Fourth Meridian (HTTP n) — reload and try again"). The Policies editor already surfaces its refusal beside the Reset control. **Re-proof (§M.8).**

**M.8 Fresh-tab re-proof on `83bb03e` (23:10–23:13 UTC) — ALL THREE PERSISTED.** Read-only from Preview:
- **Operator Refresh All:** UI "1 refreshed · 1 not refreshable" beside the button. Ledger: `OPERATOR_REFRESH_ALL` 23:10:50 by the operator (`via PLATFORM_GRANT`, `area CUSTOMER_SUCCESS`), `summary {considered 2, started 1, refused 1, byReason {NOT_REFRESHABLE 1}}`, **`executionIds [bf0d5ba4-…]`**; `RefreshExecution` 23:10:48 `PLAID_ITEM / OPERATOR / FULL_REFRESH / SUCCEEDED` on the Sandbox item (the customer's 21:17 cooldown had lapsed, so the operator's attempt genuinely refreshed — trigger `OPERATOR`, distinct from the customer's `MANUAL`); legacy `PLAID_REFRESH` row (14 accounts) beside it. The audit row now carries the execution reference end to end.
- **Cadence:** `JOB_CADENCE_RESET` 23:12:47, `change {before {hours 1, origin SETTING} → after {hours null, origin DEFAULT}}`, `reason TESTING`; `PlatformSetting` `n_tup_del` went 0 → 1 — **the override was removed.** Five seconds later `JOB_CADENCE_CHANGED` 23:12:52 `{DEFAULT → 1 h, SETTING}`, `reason TESTING` — the editor's Save was pressed after the reset (the owner's quoted confirmation, "Saved. The next wake applies the new cadence.", is the Save notice; the Reset notice reads "Reset. The platform default is in force"). Final state: `job_cadence_hours_evaluate-alerts = 1` on Preview. Both actions are real, reasoned, before/after-audited, and the ledger reads exactly what happened — which is the P1 property under proof. _Observation (PRESENTATION, minor):_ after a confirmed reset the editor can be re-saved with its previous value in one click; a post-reset return to view mode would prevent an accidental re-apply (P2). The owner may reset once more to leave Preview at the 6 h baseline; Preview receives no cron, so the value has no operational effect there.
- **Cohort:** `CUSTOMER_COHORT_ASSIGNED` 23:13:36, `change {before null → after {cohort CLOSED_BETA_2026, source OPERATOR}}`, `reason DOGFOOD`; `CustomerCohort` row present (`source OPERATOR`, `assignedById` = operator, `n_tup_ins` 0 → 1). Cohort and policy remain separate rows, as designed.

**Verdict on §M:** policy assignment with provenance, cohort assignment, cadence change AND reset, customer Refresh All, operator Refresh All with execution reference, and the Security-relevant audit envelope (actor, target, reason, before/after, execution) are all proven end to end on Preview against real Sandbox state. Nothing was manufactured; the one refusal observed (`NOT_REFRESHABLE`, a revoked item) is a genuine condition.

## N. Deferred items (explicitly classified)

**P2 (engineering, post first-five):**
- Beta-queue routes (approve/deny/resend/revoke/direct invite) onto the operator envelope with the `BETA_REQUEST` target kind, dropping `email` from their metadata.
- `/admin` break-glass actions (grants, 2FA reset, session revoke) carry a structured reason; AuditLog DB-level append-only trigger.
- A reason on the BANK/WALLET `updateRefreshCadence` path (it now governs execution, not only expectation).
- `next build` added to the local CI contract (`scripts/lib/ci-contract.ts`) so a server-only/client-boundary violation fails before Vercel.
- Per-dimension entitlement overrides (free values) only if a real need appears; today every override is a catalogue overlay by design.
- A `manualRefresh` boolean dimension once a policy that disables manual refresh exists; `maxSpaces` once a Space-count limit has a consumer; a per-user AI daily allowance reader over `AiInvocation`.
- Readers/retention for `PlaidWebhookEvent`, `BetaAccessRequestEvent`; `AiInvocation.userId` scrub on purge; Customer Success per-customer resolution of PLAID_ITEM-target audit rows into the customer's panel (today joined by item id).
- Scheduling: operator "pause this job" lever (the FIXED jobs stay fixed); surfacing `dispatch.skipped` reasons in the Jobs workspace.
- Wallet connections on Preview (none exist) for an end-to-end wallet Refresh All proof; the wallet path is proven by `lib/refresh/refresh-all.test.ts` and `wallet-lock.test.ts`.

**Counsel / owner decisions:** none new in P1 (P0's remain: OpenAI retention window, sub-processor naming, guidance posture sufficiency).

**External administration (remain external by design):** Production cutover, Production migrations (now 35 pending incl. P0 and P1), Vercel env and secrets, Supabase backups/PITR, Plaid console for upstream Item removal, Resend delivery truth, Sentry triage.

**Post-beta:** paid tiers / billing (explicitly out of scope); Goals V2; CRM-style customer features beyond the spine.

## O. First-five beta operational verdict

**"With five real beta users in Fourth Meridian, can Chris understand each customer's state, understand what they are entitled to, safely change those entitlements, understand provider/sync health, change platform execution cadence, invoke appropriate operational actions, and let a customer refresh all eligible financial authorities without requiring Claude Code, SQL, Supabase, Vercel or provider-console archaeology for routine operation?"**

| Routine operation | Where it lives now | Proven |
|---|---|---|
| Understand a customer's state (identity, cohort, policy and why, lifecycle, Spaces, last active, connections and health, incidents, AI usage and cost, operator actions) | Customer Success → Customers | §D, §M.2/M.8 |
| Understand entitlements and their provenance | Customer Success detail (per-dimension source chips) · Growth & Revenue catalogue view | §E, §M.2 |
| Safely change entitlements (policy group, founder overlay, cohort) | Customer Success, reason-gated, audited with before/after | §M.2, §M.8 |
| Understand provider / sync health | Platform Operations (fleet, identity-minimised) · Customer Success (per customer) | P0 + §D |
| Change platform execution cadence | Platform Operations → Policies → Execution cadence (CONTROL, reason, bounded, audited, reset) | §H, §M.4/M.8 |
| Invoke operational actions | Run Now (with JobRun reference), connection resync/reauth, operator Refresh All, deactivate/reactivate (reasoned) | §J, §M.8 |
| Let a customer refresh every eligible authority | Header Refresh → `/api/refresh/all`, structured outcomes | §I, §M.5 |

**What still requires an external console, and why that is acceptable:** Production cutover, migrations, env and secrets (Vercel/Supabase — external administration by design); upstream Plaid Item removal (Plaid console); email delivery truth (Resend); error triage (Sentry, complementary). No routine business or product operation for five beta users requires Claude Code, SQL or console archaeology.

**Honest limits:** wallet Refresh All is proven by tests, not on Preview (Preview has no wallet connection); the cadence editor can re-apply a value right after a reset (minor, P2); beta-queue and `/admin` break-glass actions keep their pre-P1 audit shape (P2); the local CI contract lacks a production build step, which let one client-boundary defect reach a Preview build before it was caught (P2).

**Production readiness (report only; no cutover performed or authorised):** the candidate for Production is `83bb03e` on `v2.6`: clean-copy CI and exact-SHA GitHub CI green on every commit in the series (`da015fe`, `f3e36be`, `d516569`, `85d1c14`, `c20c741`, `83bb03e`); Preview healthy on it; 35 migrations pending on Production (additive, old-client compatible per the cutover plan's analysis, now including P0's and P1's); the cutover plan's config acts (`PLATFORM_ALERTS_EMAIL` is already set) and its §5 sequence remain the owner's to authorise.

**PROJECT OPERATIONALIZATION P1 — HUMAN OPERABILITY: CLEARED.**
**FIRST-FIVE BETA OPERATIONAL VERDICT: GO** — routine understanding and operation of five beta customers is possible from inside Fourth Meridian; the remaining external dependencies are infrastructure administration.

## Gate results addendum (final)

| Commit | Clean-copy CI | GitHub exact-SHA run | Preview |
|---|---|---|---|
| `da015fe` P1 slice | FAILED (db-authority: `job-cadence.ts` on the migration principal) | — | — |
| `f3e36be` fm_system fix | FAILED (Plaid RLS acceptance check 18 counted ledger read seams) | — | — |
| `d516569` named seams | **PASSED** | 37683808588 `success` | migration applied (guarded), sections seeded, health `d516569` |
| `85d1c14` operability + username | **PASSED** | 37690914189 `success` | **Vercel build FAILED** (server-only in a client bundle) |
| `c20c741` client boundary | **PASSED** | 37693674448 `success` | health `c20c741` |
| `83bb03e` stale result | **PASSED** | 37699926892 `success` | health `83bb03e`; §M.8 proofs |

Working-tree gates at `83bb03e`: 692/692 unit files; typecheck clean on committed trees; lint no errors in tracked files; db-authority, read-boundary, platform-surface, observability-privacy, security-surface ratchets green; site 45/45; `rls:accept:foreground` 67/67 locally and all five RLS suites green in the clean copy. **Production untouched throughout.**
