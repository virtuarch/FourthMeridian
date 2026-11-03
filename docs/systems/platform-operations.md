# Platform Operations

> **Status markers** (ADR-008, [docs/decisions/ADR-008-documentation-lifecycle.md](../decisions/ADR-008-documentation-lifecycle.md)):
> **IMPLEMENTED**: on `develop`, code path or PR cited, checked against the tree on 2026-11-03.
> **IN PROGRESS**: an open PR exists; nothing in it is on `develop` yet.
> **PLANNED**: decided by the owner (ADR-008 "decided but not implemented") or proposed in an active plan. No code yet.
>
> **Active plans (Session 1 owns them; this doc links, never copies):**
> [PB1-INCIDENT-LIFECYCLE](../plans/PB1-INCIDENT-LIFECYCLE.md) ·
> [PLATFORM-INTELLIGENCE](../plans/PLATFORM-INTELLIGENCE.md). Cost and pricing:
> [billing-and-provider-costs](billing-and-provider-costs.md).

## Purpose

The Platform Space is how operators run Fourth Meridian itself. It is not a customer
feature. It has five **areas**. Each area is backed by one system-singleton Space
(`Space.platformArea`) and holds **workspaces**, which can contain **views**. Underneath
sit a typed background-job runtime, an append-only run ledger, three separate health
authorities, an alert engine and the sync-incident lifecycle.

## Authority

| Concern | Authority | Status |
|---|---|---|
| Areas, sections, seed | `PlatformArea` enum (`prisma/schema.prisma`), `PLATFORM_AREAS` (`lib/platform/policy.ts`), idempotent seed `lib/platform/seed.ts` | IMPLEMENTED |
| Workspace identity | `PLATFORM_WORKSPACES` (`lib/platform/workspaces.ts`), unioned into the universal `WORKSPACE_REGISTRY` (`lib/perspectives.ts`) | IMPLEMENTED |
| Workspace composition (the only owner) | `PLATFORM_AREA_WORKSPACES`, `PLATFORM_WORKSPACE_ALIASES`, `PLATFORM_SECTION_REPRESENTATION` (`lib/platform/workspaces.ts`) | IMPLEMENTED |
| Section → widget, view leads | `components/platform/PlatformSpaceDashboard.tsx`, `components/platform/leads/*` | IMPLEMENTED |
| Authorization | pure `hasPlatformAccess` (`lib/platform/policy.ts`); session adapter `requirePlatformAccess` / `requireFreshPlatformAccess` (`lib/platform/authorize.ts`) | IMPLEMENTED |
| Job execution health | `lib/jobs/health.ts` | IMPLEMENTED |
| Resource freshness | `lib/platform/resource-freshness.ts` | IMPLEMENTED |
| Provider health | `lib/platform/provider-health.ts` | IMPLEMENTED |
| Alerts | `lib/alerts/evaluate.ts`, `lib/alerts/run.ts` | IMPLEMENTED |
| Incident lifecycle (the only writer) | `lib/platform/incidents/lifecycle.ts` plus the classifier `lib/platform/sync-issue-semantics.ts` | IMPLEMENTED |
| Incident intelligence (shared reader) | `lib/platform/incidents/intelligence/*` (PRs #264, #287); parity gate `lib/platform/incidents/parity/*` (PR #263). R1/R2 (CS incidents panel + CS detail loader) cut over, PR #288; R3–R6b pending | IMPLEMENTED (module, R1/R2); cutover R3–R6b PLANNED |
| Scheduler presence (env-aware verdicts) | `lib/jobs/scheduler-presence.ts`, `scheduler-presence.core.ts` (PR #282) | IMPLEMENTED |
| Provider verdict rules | `provider-outcome@1` `lib/platform/verdicts/provider-outcome.ts` (PR #282); `provider-connection@1` `lib/platform/verdicts/provider-connection.ts` (PRs #285, #286) | IMPLEMENTED |
| Fleet AI spend status | `fleetSpendStatus` (`lib/platform/ai/fleet-spend-status.ts`, PR #281) | IMPLEMENTED |
| Opaque customer reference (PRIV-ref) | `lib/platform/opaque-user-ref.ts`, `opaque-user-ref-format.ts` (PR #284) | IMPLEMENTED |
| Operational policy (Policies workspace) | `lib/platform/policies/*` | IMPLEMENTED |

## Areas and workspaces (as registered)

Five areas: `PLATFORM_OPS`, `SECURITY_OPS`, `GROWTH_REVENUE`, `CUSTOMER_SUCCESS` and
`MERCHANT_OPS` (`prisma/schema.prisma` `enum PlatformArea`). Each one opens on the
shared `platform-overview` identity, and an area can relabel it. Every row below is
IMPLEMENTED in `lib/platform/workspaces.ts` (`PLATFORM_AREA_WORKSPACES`).

| Area (label) | Workspaces → views | Lead component |
|---|---|---|
| Platform Operations | **Operations**: Overview · Jobs · Pipeline (drill-down, no second tab row) · **Providers** (one view) · **Economics**: Overview · AI & Costs · **Policies**: Policy groups · Platform defaults · Alerts · Emergency controls (drill-down) · **Incidents** | `OperationsLead`, `PipelineLead`, `ProvidersLead`, `EconomicsOverviewLead`, `AiCostsLead`, `PoliciesLead` |
| Security Operations | **Security** (posture dashboard) · **Audit** · **Operator actions** | `SecurityLead` |
| Growth | **Growth** (acquisition dashboard; hosts the beta signup list) | `GrowthLead` |
| Customer Success | **Customers** · **Incidents** · **Communications**: Library · Automations · Delivery & History · Preferences | `CustomerSuccessLead`, `components/platform/comms/*` |
| Merchant Operations | **Merchant identity** (the merge review page itself stays at `/merchant-ops`) | `MerchantLead` |

Composition rules (IMPLEMENTED, pinned by `lib/platform/workspaces.test.ts`):

- **Views are composition only.** A view selects which section keys render (inline or
  `hosted` inside a lead's drawers). It never adds a section key or a DB row.
- **Retired ids still resolve.** `platform-trends` and `platform-costs` map to their new
  workspace, and `platform-jobs` / `platform-refresh` map to Operations › Jobs / Pipeline
  (`PLATFORM_WORKSPACE_ALIASES`), so old `?workspace=` links still land.
- **Absorption is declared.** When one widget replaces others (for example
  `ops_platform_health` absorbing alerts, provider health, freshness, rate limits and env
  status, or `ops_job_health` absorbing `ops_manual_operations`), the mapping is recorded
  in `PLATFORM_SECTION_REPRESENTATION`. The reachability guard follows it transitively,
  so a section is never dropped silently.
- **A key in only some registries renders nothing.** A section must exist in
  `PLATFORM_AREAS`, the composition and the widget registry. A new section also needs the
  seed re-run on every environment (`lib/platform/seed.ts`).
- **One request per workspace resource.** Widgets in a workspace that read the same route
  share one fetch (`components/platform/workspace-session.tsx`). Inspection reads, such as
  the execution timeline, stay independent.

## Authorization: a separate plane

IMPLEMENTED. Platform access is decided from `PlatformGrant` rows only, one per
`(userId, area)`, and revoking one flips its status to `REVOKED`, never deletes it.
`PlatformAccessLevel` is ranked **CONTROL ≥ WRITE ≥ READ** (`LEVEL_RANK`,
`lib/platform/policy.ts`). WRITE does **not** satisfy CONTROL, so changing how the
platform itself behaves has to be granted on purpose. Only `ACTIVE` grants count.
`lib/platform/policy.ts` knows nothing about `SpaceMemberRole`: operating the product is
not a tenant capability, and mixing the two would be a confused-deputy risk. The
`SYSTEM_ADMIN` break-glass bypass sits in the adapter (`lib/platform/authorize.ts`), not
in the pure policy. Platform refusals are recorded as one bounded anomaly row per user,
area and window (`lib/platform/ops/access-denied.ts`). Server routes live under
`app/api/platform/{platform-ops,security-ops,growth-revenue,customer-success,merchant-ops}/`
and gate through `requirePlatformAccess` / `requireFreshPlatformAccess`.

## Execution and observability

All IMPLEMENTED.

- **One dispatcher, one ledger.** A single Vercel cron wakes `POST /api/jobs/dispatch`
  every 15 minutes (`vercel.json`). `lib/jobs/dispatch.ts` decides from the `JobRun`
  ledger and the cadence policy which `SCHEDULED_JOBS` (`lib/jobs/registry.ts`) are due:
  never ran, or the newest run is older than cadence minus tolerance, with an overlap
  guard. `runJob` (`lib/jobs/run.ts`) is the **only** writer of `JobRun`. Manual
  operations (`lib/platform/operations/execute.ts`, registry
  `lib/platform/operations/registry.ts`) run the same body through
  `runJob(trigger:"manual")`, now from the Jobs rows, with fleet runs behind CONTROL plus
  a reason and a confirmation.
- **Three authorities, never conflated.** Job health (`lib/jobs/health.ts`), resource
  freshness (content-derived `MAX(date)`, `lib/platform/resource-freshness.ts`) and
  provider health (a worst-wins synthesis over the other two plus connection health,
  `lib/platform/provider-health.ts`). **False-green invariant:** a succeeded job over a
  stale archive still reads stale. The job success is shown beside the content state and
  never used to derive it. Downstream layers consume these outputs and never recompute
  them.
- **Alerts** classify over the authorities' output. The alert store is the `JobRun`
  ledger itself: `evaluate-alerts` runs record what fired in their `summary`, which drives
  suppression. There is no alert table. `never-ran` is not alertable.
- **Ledger writes are best-effort.** A failed observability write is logged and
  swallowed, so observing a job never breaks it.

### Environment-aware verdicts: scheduler presence

IMPLEMENTED, PR #282 (resource-freshness half extended in PR #285).

- **Where it is decided.** `deploymentSchedulerPresence()` (`lib/jobs/scheduler-presence.ts`)
  reads `deploymentEnvironment()` (`lib/env.ts`) on the server only, never a client value,
  query parameter or header. The pure mapping `schedulerPresenceFor`
  (`lib/jobs/scheduler-presence.core.ts`): `production` and `development` are `present`,
  `preview` is `absent` (Vercel fires the `vercel.json` crons on Production only).
- **Job health** (`classifyJobHealth`, `lib/jobs/health.ts`). With `present`, the
  classification is unchanged. With `absent`, only the age-based states (`never-ran`,
  `overdue`, `dead`) are re-read: a recorded failure at the head of the ledger stays
  `failing`; otherwise the job is `not-scheduled` ("Not scheduled in this environment").
  `not-scheduled` is neutral: not failed, not healthy, no attention severity, no alert, and
  excluded from the overview failure verdict. `running`, `skipped`, `failing` and a recent
  `healthy` are untouched.
- **Resource freshness** (`classifyResourceFreshness`, `lib/platform/resource-freshness.ts`).
  When the producing job is not scheduled on the deployment, a `stale` or `empty` source
  with no refresh attempt inside its stale window becomes `not-refreshed` ("Not refreshed
  in this environment", trust `unknown`), neutral like `not-scheduled`. A source that was
  attempted inside the window (even manually) and is still behind stays `stale` / `empty`.
  A blocked pipeline keeps its own words.

### Provider verdict rules

IMPLEMENTED. Both rules are pure, client-safe, versioned, and stamp their definition id on
the verdict so a verdict on screen traces to the rule and to the counted rows. They share
one failing share, `PROVIDER_FAILING_SHARE = 0.5`
(`lib/platform/verdicts/provider-outcome.ts`), so they cannot drift apart. Provider health
(`lib/platform/provider-health.ts`) still combines them worst-wins with freshness.

**`provider-outcome@1`** (PR #282, `assessOutcomes`). One rule turns outcome counts into a
verdict for both the server read-model (producing-job runs, `provider-health.ts`) and the
Providers dashboard (ProviderCall attempts, `components/platform/leads/providers-model.ts`).
Thresholds: minimum sample 3 runs or 20 calls; failing ratio 0.5; a run of 3 consecutive
failures. Evaluation order, first match decides:

1. **Recency** (ordered evidence, job runs only): the last 3 outcomes all failed ⇒ FAILING.
2. **All failed** (unordered evidence, calls): at least 3 decided outcomes, every one
   failed ⇒ FAILING.
3. **Small sample with a failure**: below the minimum sample, at least one failed ⇒
   DEGRADED ("small sample").
4. **Sample**: below the minimum sample, none failed ⇒ NOT_ENOUGH_DATA (never HEALTHY).
5. **Ratio**: failed / decided ≥ 0.5 ⇒ FAILING.
6. **Isolated**: any failure below that ratio ⇒ DEGRADED.
7. **None**: no failure in a sufficient sample ⇒ HEALTHY.

The failure checks run before the sample floor, so the floor can only withhold HEALTHY; it
never turns a failure into "Not enough data". In-flight rows are not decided outcomes.

**`provider-connection@1`** (PR #285, follow-ups PR #286; `connectionTrustState`,
`tallyConnections`, `assessConnections`). Before it, one customer's connection in ERROR,
REVOKED or NEEDS_REAUTH failed the whole provider. A customer who must reconnect is a
per-customer state, surfaced by Customer Success and attention, not a provider verdict.

- **Step 1, code→state mapping (pinned by test).** The principle: only provider- or
  institution-side codes (`PROVIDER_SIDE_ERROR_CODES`) count as ERROR; customer-actionable
  codes (`CUSTOMER_REAUTH_CODES`) count as NEEDS_REAUTH whatever status was written; any
  other or missing code is UNCLASSIFIED, which can degrade a provider but never fail it. So
  a new code can never silently become a provider-wide outage. REVOKED is neutral;
  STALE / HEALTHY contribute nothing (recency belongs to the freshness authority).
- **Step 2, verdict, first match decides.** The denominator `active` is the live
  population: every connection except REVOKED and those whose owner is inactive or pending
  deletion (`lib/connections/health.ts`).
  1. **Error share**: error ≥ 0.5 × active, with active ≥ 2 ⇒ FAILING.
  2. **Any error**: error > 0 (including a lone 1 of 1) ⇒ DEGRADED.
  3. **Reauth wave**: reauth ≥ 0.5 × active, with active ≥ 4 ⇒ DEGRADED ("possible
     provider-side reauth wave"). Reauth never fails a provider.
  4. **Unclassified**: any unclassified connection ⇒ DEGRADED. PR #286: the basis names the
     codes, sorted and capped at 3 ("+N more"); only code-shaped values are echoed, anything
     else reads "non-code value".
  5. **None** ⇒ no connection verdict; customers who must reconnect and REVOKED connections
     are reported as neutral facts.
- **Unknown population** (PR #286): without the per-source tally, no share is computed and
  the basis says "connection population unavailable — share not computed".
- **Open follow-up:** a per-institution concentration rule is out of scope for v1.

## AI & Costs: fleet spend status and call drilldown

Rates, attribution and the cost freeze: [billing-and-provider-costs](billing-and-provider-costs.md).
Every dollar here is a rate-card estimate, never a bill.

**One spend status** (IMPLEMENTED, PR #281). `fleetSpendStatus()`
(`lib/platform/ai/fleet-spend-status.ts`) is the single authority for the fleet's
rolling-window AI spend and its share of the fleet alert threshold. The AI & Costs "Budget
used" KPI and "Budget utilisation" card (`components/platform/leads/ai-costs-model.ts`,
`AiCostsLead.tsx`) and the AI Budget widget (`components/platform/widgets/ai-budget-view.ts`)
all derive from it, so no two tiles disagree about the same window. The status it returns:

| Status | Meaning |
|---|---|
| `ESTIMATED` | Every customer call in the window was priced by the rate card. Utilisation = estimated spend ÷ threshold. |
| `PARTIAL` | Some calls priced, some not. The priced figure is a lower bound ("at least"), and the unpriced calls are counted. |
| `UNAVAILABLE` | Nothing priced (no calls, or none could be priced). No dollar figure and no percentage, never $0, with the reason. |

`MEASURED` (billed cost from a provider invoice) is in the `SpendStatus` vocabulary but is
**never produced**: the return type excludes it, because no invoice is read anywhere. A
threshold of 0 or unset is "No threshold set" (utilisation null), never "0% of $0". The
function is pure and display-only; the alert rule (`lib/platform/ai/spend-health.ts`) and
the allowance are untouched.

**24 h per-call drilldown** (IMPLEMENTED, PR #283; lookback PR #284). The budget KPI opens
the customer calls in its exact rolling window.

- **API:** `GET /api/platform/platform-ops/ai-budget/calls?until=&page=`
  (`app/api/platform/platform-ops/ai-budget/calls/route.ts`), `PLATFORM_OPS` READ, never
  cached. The loader (`lib/platform/ai/budget-calls.ts`) uses the same grouped read and the
  same fold as the KPI, so the drilldown summary is the KPI. Pages of 25.
- **Rows** (`lib/platform/ai/budget-calls-core.ts`): customer surfaces only. Each cost cell
  is `PRICED`, `UNPRICED`, `NO_TOKENS` or `NOT_COUNTED` (failure facts such as FAILED,
  TIMEOUT, RATE_LIMITED, QUOTA); only a priced call shows a dollar figure. Rows carry an
  opaque customer reference (below), a provider error code but never a message, and no
  prompt, conversation or request id.
- **Deep link** (`components/platform/leads/ai-budget-calls-url.ts`): `?aicalls=budget`
  opens the drawer, `&aiuntil=<epoch ms>` pins the window end to the KPI's `checkedAt` so a
  refresh reopens the same 24 h, and `&aipage=` pages. Written with REPLACE intent through
  the Space URL seam and parsed with the route's own parser (`parseBudgetCallsQuery`), so an
  unknown value is dropped.
- **Lookback:** `BUDGET_CALLS_MAX_LOOKBACK_MS` is 48 h (PR #284). An `until` older than that,
  or more than a minute in the future, falls back to now.

## Operator privacy: opaque customer references (PRIV-ref)

IMPLEMENTED, PR #284.

- **One definition.** `opaqueUserRef()` (`lib/platform/opaque-user-ref.ts`, server-only)
  produces the `user #xxxxxxxx` reference every Platform Ops surface shows instead of a raw
  identity: AI spend and the budget-calls drilldown, cost controls, policy-assignment
  health, connection diagnostics, removed connections, provider cleanup, and the spend and
  assignment alerts. The client-safe shape (prefix, 8 hex characters, parser) lives in
  `lib/platform/opaque-user-ref-format.ts`.
- **Mechanism.** The 8 hex characters are a truncated HMAC-SHA256 of the user id under a
  key derived from the server's `NEXTAUTH_SECRET` with a fixed, versioned
  domain-separation label. It replaced the old literal id-tail. It is stable across
  surfaces and instances, so rows still correlate, but it cannot be computed or reversed
  without the server key. Rotating the secret, or bumping the label, rotates every
  reference. With no secret it fails closed to the word `customer`.
- **Dedupe tokens.** Alert dedupe keys and Attention row ids use `opaqueDedupeToken()`: the
  same 8 hex with the secret, otherwise a random per-process key, so a missing secret can
  cause a duplicate notification but never suppress another customer's alert.
- **Customer Success reverse lookup.** Only Customer Success may resolve identity. Pasting a
  reference (or its bare 8 hex) into the CS customer search
  (`app/api/platform/customer-success/customers/route.ts`, `CUSTOMER_SUCCESS` READ) calls
  `resolveOpaqueRef` (`lib/platform/customer/customers.ts`): the newest
  `REF_SEARCH_SCAN_CAP` (5,000) account ids are digested server-side and every match is
  returned, since 32 bits can collide. The list says when nothing matched, and when the cap
  was hit that an older account may hold the reference. No audit row (a read, like the
  list).
- **Rate limits.** The CS customer list is limited to 60 requests per minute per operator;
  a reference search additionally spends a 20 per minute per-operator bucket.

## Incident lifecycle (PB-1 Phase 1)

IMPLEMENTED in PR #255 (merged 2026-11-03) unless marked otherwise. Design and open
phases: [PB1-INCIDENT-LIFECYCLE](../plans/PB1-INCIDENT-LIFECYCLE.md).

**Model** (`prisma/schema.prisma`):

| Table | Role |
|---|---|
| `SyncIssue` | One **episode** per `incidentKey` (`v1::provider::scope::domain::operation`, `lib/platform/incidents/identity.ts`). A partial unique index allows only one open episode per key. Carries `lifecycleState`, the resolution fields, `subjectUserId` and the cause fields. |
| `SyncIssueOccurrence` | Each observation, with structured soft references (account, security, `jobRunId`). |
| `SyncIssueEvent` | **Append-only** event history. The database stamps `at`, and the column-level INSERT excludes it, so events cannot be backdated. No UPDATE grant. fm_system's DELETE on events is used only by retention and account purge. |
| `SyncIssueRelation` | Soft-reference links between incidents. They can point at an archived incident. |
| `SyncIssueArchive` | A summary-only record of a pruned incident: ids, registry codes, timestamps, counts, and a code-only event timeline of at most 8 KB. |

The three new tables have FORCE RLS: fm_system reads and writes, fm_backup has SELECT only,
and fm_app and fm_auth get nothing. fm_app's existing column grant on `SyncIssue` (id, kind,
resolved, createdAt, financialAccountId, plaidTransactionId) is unchanged, so it cannot read
the new lifecycle or subject columns. Proven by rls:accept cases 42–48.

**States** (`LIFECYCLE_STATES`, `lib/platform/incidents/invariant.ts`, enforced by a DB
CHECK): `ACTIVE · ACKNOWLEDGED · RECOVERING · STALE · RESOLVED`. `RESOLVED` must move
together with `resolved`, and a resolved incident carries `resolvedAt` and a reason code.
**Resolution kinds:** `AUTOMATIC_RECOVERY · OPERATOR_RESOLVED · SUBJECT_REMOVED`.
`OPERATOR_RESOLVED` requires the operator and an audit id. Every code column holds a
registry code (`^[A-Z0-9_]{2,64}$`, `lib/platform/incidents/codes.ts`), never free text.

**Transitions written today:**

- **Open / recur.** `recordIncidentObservation` (`lifecycle.ts`, reached through
  `recordSyncIssue` in `lib/plaid/syncIssues.ts`) converges on the open episode or opens a
  new one. A recurrence is a **new** episode linked by `previousIncidentId`. A resolved
  row is never reopened. `OBSERVED` is written once, when the episode opens.
  `nature === "event"` rows are evidence, stored as already closed, and can never be
  resolved.
- **Automatic recovery.** Evidence comes only from the typed builders
  (`lib/platform/incidents/evidence.ts`). A skipped or unattempted step is never proof of
  recovery.
- **Subject removed.** `resolveIncidentsForRemovedSubjects` is called from
  `lib/accounts/disconnect.ts`, `lib/plaid/disconnect.ts` and
  `lib/account-deletion/purge.ts`. It closes with `SUBJECT_DELETED`, `SUBJECT_REVOKED`
  or `SUBJECT_MISSING`, each in one transaction: a compare-and-set on the state it read,
  which throws on 0 rows, then a `STATE_CHANGED` event. Restoring the account does not
  reopen the episode.
- **Event vocabulary** (`EVENT_TYPES`): `OBSERVED · STATE_CHANGED · CAUSE_HYPOTHESIZED ·
  CAUSE_CONFIRMED · CAUSE_RETRACTED · ACTION_TAKEN · ACTION_OUTCOME · NOTE_CODE`. The
  schema and codes exist for operator acknowledge, resolve, reopen and cause actions, but
  their **writers are PLANNED** (PB-1 Phase 2+). So are persisting `ACKNOWLEDGED`,
  `RECOVERING` and the read-time `STALE` predicate.

**Retention** (`jobs/data-retention.ts` → `lib/platform/incidents/retention.ts`): a
`SyncIssue` resolved more than 90 days ago is archived and deleted in the same
transaction. The summary goes into `SyncIssueArchive`, the events are folded into its
timeline, and then the events and the row are deleted. The rule fails closed if no
archiver is wired. `SyncIssueArchive` and `SyncIssueRelation` are kept **13 months**
(`INCIDENT_ARCHIVE_RETENTION_DAYS = 396`).

**Purge on account deletion** (`lib/platform/incidents/purge.ts`): removes every
incident row about the customer, including live episodes, occurrences, events, relations
(either end) and archive rows. Rows are matched by `subjectUserId`, or for legacy rows by
the customer's Items and accounts. The set is resolved before the account tail deletes
those rows, and deleted inside the same destructive transaction. Provider-wide history
with no customer subject is kept.

## Platform intelligence (PB-1 Phase 2 and after)

Module and R1/R2 cutover IMPLEMENTED; remaining reader cutovers and the rest PLANNED / PROPOSED. Plans:
[PLATFORM-INTELLIGENCE](../plans/PLATFORM-INTELLIGENCE.md),
[PB1-INCIDENT-LIFECYCLE](../plans/PB1-INCIDENT-LIFECYCLE.md) (§3, §12, §13).

- **Order (owner, fixed):** data model first (Phase 1, above), deterministic
  intelligence second, conversation and navigation last.
- **IMPLEMENTED: incident-intelligence module** (PR #264; PR #287). Read-only, no
  migration, no writes, no LLM.
  - **Pure core** `deriveIncidentVerdicts` (`lib/platform/incidents/intelligence/core.ts`)
    is the one place an incident verdict is decided: row class, state, freshness, closure,
    `brokenNow`, `alertable`, severity, spread (widespread at 2 or more live subjects per
    provider/domain/operation), recurrence, recovery and operator actions. It applies the
    canonical rules D1–D10 (`types.ts` header) and combines the existing authorities
    (`classifySyncIssue`, `subjectVerdict`) rather than re-deriving them. Output never
    carries `detail`, `plaidTransactionId` or raw evidence.
  - **Read-time STALE rule** (`staleness.ts`): `current` inside the operation's window;
    `unverified` outside it but attempted or skipped since (or evidence unreadable), visible
    at lower severity; `stale` outside it and neither attempted nor skipped, which leaves
    "broken now" and never fires the critical alert but is **not** resolved. Time alone
    never resolves an incident. Windows are one constant set, `STALE_WINDOWS_MS`
    (Plaid item, wallet, member-triggered). **Still open:** the values are proposed
    defaults awaiting owner confirmation (Q2), and persisting `staleSince` is a later slice.
  - **Audience tokens** (`audience.ts`): accessors take a minted, branded token, never a
    string. `incidentAudienceFor(auth)` mints from the route's own
    `requirePlatformAccess` / `requireFreshPlatformAccess` result (CUSTOMER_SUCCESS grant or
    SYSTEM_ADMIN break-glass → CS tier; PLATFORM_OPS → Ops tier);
    `systemIncidentAudience()` is for the alert engine only (statically pinned to
    `lib/alerts/`). Only the CS tier carries `subjectUserId`; Ops and System verdicts have
    no such key. An unminted or wrong-tier token is refused, never downgraded.
  - **Loader and accessors** (`index.ts`): batched reads through `systemDb`, then the pure
    core. Accessors: `brokenNow`, `needsVerification`, `history`, `forCustomer` (CS only),
    `alertable` (System only), `detail`. Scan caps are reported, never silent; hitting the
    attempt-evidence cap makes every row's evidence unknown rather than hiding rows.
  - **PR #287:** an unattributed subject is `null`, never `""`, at every attribution rung,
    and `forCustomer(token, "")` returns an empty list without scanning.
- **IMPLEMENTED: parity harness** (PR #263, `lib/platform/incidents/parity/*`, test-only).
  It reproduces every PB-1 §13.2 divergence from today's reader logic on a shared world,
  then compares the module (through `module-adapter.ts`) with each legacy reader in that
  reader's own sense of "open". An unlisted divergence fails, and each listed correction
  must actually hold. This is the cutover gate.
- **IMPLEMENTED: R1/R2 reader cutover** (PR #288): the CS incidents panel and the CS detail
  loader read the module's verdicts.
- **PLANNED: reader cutover R3–R6b.** The other readers still compete over incident state; each cutover is its own PR, after the parity gate is green
  for that reader (PB-1 §13.3).
- **PROPOSED (plan):** one versioned metric-definition registry in code, modelled on
  `lib/usage/pricing.ts`. The Platform UI, alerts and any future AI all read the same
  definitions and permissioned readers. There is no AI-only pipeline and no second alert
  engine. Permissions are enforced where the data is read. The layer is read-only first
  (observe, then navigate). Acting needs separate authorization, confirmation and audit.
  It also proposes a navigation registry derived from the workspace registry and
  `lib/space/space-url.ts`.
- **Conversation layer: PLANNED.** `/dashboard/platform/ai` is a placeholder today
  (`components/platform/PlatformAiPlaceholder.tsx`).

## Shipped operator surfaces

| Surface | What it does | Where | Status |
|---|---|---|---|
| **Who needs help** (PB-4) | The Customer Success dashboard ranks customers needing attention by reason: broken connections, open incidents, policy-assignment problems including `unassigned` under fail-closed enforce. Fleet reads are capped, and the UI shows "≥N" when a cap is hit. The incident trend uses canonical episodes. | `lib/platform/customer/attention-core.ts`, `attention.ts`, `components/platform/leads/CustomerSuccessLead.tsx`, `app/api/platform/customer-success/customers/route.ts` | IMPLEMENTED, PR #224 |
| **Beta Access request review** (PB-6) | Server-paged views `PENDING · APPROVED · DENIED · REDEEMED · ALL`, a `SUSPICIOUS` verdict filter, recordable risk verdicts, and separate actions for **Deny** and **Deny and block**. A plain deny never blocks. A failed blocklist read never fails the list (PR #230). | `app/api/platform/growth-revenue/requests/route.ts`, `lib/platform/growth/beta-request-list.ts`, `beta-risk-review.ts`, `beta-blocklist.ts`, `components/platform/growth/BetaRequestReview.tsx` | IMPLEMENTED, PRs #226, #230 |
| **Onboarding timeline** (PB-7) | A per-customer CS onboarding timeline, a "recently joined" panel, and a Platform Ops new-connection import tile. An import that the resume job finished now reads RECOVERED instead of FAILED (fixed in the readers; ledger rows untouched). | `components/platform/widgets/CsOnboardingTimeline.tsx`, `lib/platform/customer/onboarding-core.ts`, `app/api/platform/customer-success/recently-joined/route.ts`, `app/api/platform/platform-ops/new-connection-imports/route.ts` | IMPLEMENTED, PRs #227, #231 |
| **Merchant KPI drilldowns** (PB-9) | Each Merchant identity KPI (Merchants, Without a merchant, Merged, Dismissed) opens a permissioned, searchable, paginated table. The KPI and the table total come from one count function. Merchant detail is included, and Reconsider (WRITE, rate-limited) is available on dismissed pairs. | `lib/platform/merchant/records-query.ts`, `records.ts`, `reconsider.ts`, `components/platform/leads/MerchantRecords.tsx`, `app/api/platform/merchant-ops/records/route.ts`, `app/api/platform/merchant-ops/merchants/[id]/route.ts`, `app/api/merchant-ops/reconsider/route.ts` | IMPLEMENTED, PRs #262, #265 |

## Presence, session and engagement (PB-10)

**IMPLEMENTED: #274 (`ae85c16`) + follow-ups #276 (`c62e824`), develop / Preview. Follow-ups F3/F4 IMPLEMENTED (#278).** "Last active"
used to be `UserSession.lastActiveAt`, which any authenticated request bumps, so an idle open
tab looked active. PB-10 defines six facts once, in `lib/presence/definitions.ts`; every
threshold lives in its exported `PRESENCE_CONFIG`:

| Fact | Meaning | Source |
|---|---|---|
| **Last login** | Newest LOGIN audit row | `AuditLog` |
| **Authenticated session** | A valid, unrevoked session row inside the SEC-010 window. It does not prove a browser is open; `lastActiveAt` means *session last used* | `UserSession` |
| **Online presence** | A visible-tab heartbeat within the presence window, stamped with the server clock | `UserSession.lastPresenceAt` |
| **Active now** | Fresh presence plus an interaction reported within the interaction window | `lastPresenceAt` + `lastInteractionAt` |
| **Last active** | The last client-reported interaction. **Low trust** (client-asserted); it drives only the presence buckets and the Customer Success "last active ~" display | `UserSession.lastInteractionAt` |
| **Meaningful engagement** | The server-side engagement predicate (engagement audit actions plus AI customer surfaces). Heartbeats, polling, cron, webhooks and the daily session marker never count | `loadEngagedUserIdsSince` |

- **Heartbeat:** `POST /api/user/presence` (`app/api/user/presence/route.ts`). The body is
  `{ "interacted": boolean }` only; anything else returns 400. It runs under the normal user
  guard without touching session activity, has its own per-session rate limit keyed on a
  token digest, and reads or stores no IP, user agent or page path.
- **Client:** `components/presence/PresenceHeartbeat.tsx` (dashboard layout). It beats only
  while the tab is visible, and stops on 401/403. A 429 or network failure keeps a real
  interaction for the next beat (F1).
- **IMPLEMENTED (#278):** F3: background polls and the session focus refetch no longer extend
  the SEC-010 idle deadline (a server-confined allowlist). F4: visibility is presence, never
  an interaction. Consequence: a tab left open but unused for 30 days now signs out
  (intended SEC-010 policy).
- **Schema:** migration `20261103130000_pb10_session_presence` adds two nullable columns to
  `UserSession` (last value only, no history). They go with the session row through the
  reaper, account purge and data export. Applied on Preview; **Production follows the
  release process.**
- **Readers:** Customer Success shows Active now / Online, idle / Offline / Unknown, a coarse
  last-active bucket, Last login and Signed-in sessions. Growth's returning-user and
  active-7 counts use the engagement predicate.
- **Still open:** the platform intelligence plan's consolidation of the remaining competing
  "active" definitions (see [PLATFORM-INTELLIGENCE](../plans/PLATFORM-INTELLIGENCE.md)).

## Economics

**Overview and the AI & Costs move: IMPLEMENTED (PR A, draft).** Providers (cost
attribution, quotas) and Entitlements (cost by policy group, read-only scenarios) are
**PLANNED** as PR B; the distinct Platform AI category is **PLANNED** as PR C.

- **Navigation.** `platform-economics` is a Platform Operations workspace in the place
  AI & Costs had (Operations · Providers · Economics · Policies · Incidents), with views
  **Overview** (`economics-overview` lead) and **AI & Costs** (`ai`, the unchanged
  `AiCostsLead` and its six hosted keys). Same `PLATFORM_OPS` grant; no new role.
- **Deep links.** `platform-ai` and `platform-costs` are aliases of
  `platform-economics` carrying the `ai` view, so `?workspace=platform-ai` (and the
  `aicalls` / `aiuntil` / `aipage` drilldown) still opens AI & Costs, canonicalized in
  place. Pinned in `components/space/shell/space-history.test.ts` (E1–E5) and
  `lib/platform/workspaces.test.ts`.
- **One reader.** `GET /api/platform/platform-ops/economics` (`PLATFORM_OPS` READ,
  never cached) returns the `EconomicsSnapshot` from `lib/platform/economics/snapshot.ts`,
  which composes the existing readers: `readSpendGroups` (AI ledger, all surfaces),
  the Plaid census (`buildPlaidUsage`, present-during-cycle reading),
  `loadEngagedUserIdsSince` (PB-10 engagement, never sessions) and `opaqueUserRef`.
  The pure fold is `lib/platform/economics/snapshot-core.ts`.
- **Figures** (current billing cycle = calendar month to date): operating cost; its AI,
  providers and infrastructure split; active customers; cost per active customer
  (operating cost ÷ engaged customers); revenue; margin. Plus AI cost over 7 / 30 / 90
  UTC days with a daily series. Plaid is billed per Item-month, so it is never allocated
  to days and the daily trend is AI only.
- **Status per figure:** `MEASURED` only for counts (active customers); `ESTIMATED`
  when every part was priced; `PARTIAL` when some part is unpriced or unmetered (a lower
  bound, with the missing parts listed); `UNAVAILABLE` with a reason and a null value,
  never $0. Operating cost is always `PARTIAL` today because infrastructure and other
  providers are not metered. Revenue and margin are always `UNAVAILABLE`: "no billing
  source".
- **Drilldowns.** Each figure with records carries `drill.href` →
  `GET /api/platform/platform-ops/economics/drill?figure=&window=&until=`. The figure's
  value is defined as the sum of its drill rows (a count: the row count), computed from
  the same inputs at the same window end, so a KPI and its list cannot disagree. The open
  drill is in the URL (`?econ=<figure>.<window>&econuntil=`, workspace-scoped, REPLACE).
- **Provider health stays in Platform Operations › Providers.** Configuration stays in
  Policies; Economics reads it and never edits it.
- All money shown stays an estimate, not a bill. See
  [billing-and-provider-costs](billing-and-provider-costs.md) for the rate card,
  attribution and the cost freeze. No billing or revenue data source exists.

## Known limitations

All verified on develop.

- **`resume-stale-imports` is outside the registry.** It has its own `*/5` cron in
  `vercel.json` and is absent from `SCHEDULED_JOBS`, so it gets no job-health report and
  no alert coverage.
- **Dispatcher wakes are not recorded.** A wake with no due jobs writes nothing, so a
  silent dispatcher surfaces only as overdue jobs.
- **Provider quota is honestly `null`.** No provider exposes a pollable quota this app
  stores, and the `quota-low` alert rule is dormant.
- **Two currently stale Production incidents stay as they are** until the Phase-2 shared
  reader is cut over and shows them as stale, and an owner-approved closure runs (PR #255
  description). The module exists (PR #264); R1/R2 are cut over (PR #288), R3–R6b pending.
- **Opaque references are 32 bits** and the CS reverse lookup scans only the newest
  5,000 accounts; collisions are listed, not hidden, and a capped miss says so.

## Extension points

- **Add a job:** one `SCHEDULED_JOBS` entry with an idempotent body. Cadence comes from
  the cadence policy, not from `vercel.json`.
- **Add a section:** a `PLATFORM_AREAS` entry, a composition entry in
  `PLATFORM_AREA_WORKSPACES` and a widget registration, then re-run the seed on every
  environment.
- **Add a workspace or view:** identity in `PLATFORM_WORKSPACES`, composition in
  `PLATFORM_AREA_WORKSPACES`. A retired id gets an alias.
- **Add an incident producer:** call `recordSyncIssue` with typed facts. Never write
  `SyncIssue*` directly (pinned by `lib/platform/incidents/incident-boundary.test.ts`).

## Why it is built this way

The design started from one incident: the platform reported a green FX job while the FX
archive was cold. Since then, separating authorities has been structural. Health is
computed at read time from facts that already exist, every classifier is a pure function
with an injected client, and operator actions go through the same execution path as
cron runs. The incident work applies the same rule: one writer, append-only evidence,
registry codes instead of free text, and no data presented as proof of recovery unless
it is.
