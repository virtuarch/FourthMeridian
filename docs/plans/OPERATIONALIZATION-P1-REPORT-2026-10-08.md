# PROJECT OPERATIONALIZATION — P1 HUMAN OPERABILITY

**Date:** 2026-10-08 · **Branch:** `v2.6` · **Base:** `cc790cd` (P0 closed) · **Implementation commits:** _filled in §L_
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

_Sections K–O follow the gate results._
