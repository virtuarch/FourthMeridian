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
| Incident intelligence (shared reader) | `lib/platform/incidents/intelligence/*` (PR #264) | IN PROGRESS |
| Operational policy (Policies workspace) | `lib/platform/policies/*` | IMPLEMENTED |

## Areas and workspaces (as registered)

Five areas: `PLATFORM_OPS`, `SECURITY_OPS`, `GROWTH_REVENUE`, `CUSTOMER_SUCCESS` and
`MERCHANT_OPS` (`prisma/schema.prisma` `enum PlatformArea`). Each one opens on the
shared `platform-overview` identity, and an area can relabel it. Every row below is
IMPLEMENTED in `lib/platform/workspaces.ts` (`PLATFORM_AREA_WORKSPACES`).

| Area (label) | Workspaces → views | Lead component |
|---|---|---|
| Platform Operations | **Operations**: Overview · Jobs · Pipeline (drill-down, no second tab row) · **Providers** (one view) · **AI & Costs** (one view) · **Policies**: Policy groups · Platform defaults · Alerts · Emergency controls (drill-down) | `OperationsLead`, `PipelineLead`, `ProvidersLead`, `AiCostsLead`, `PoliciesLead` |
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

**IN PROGRESS / PROPOSED.** Plan: [PLATFORM-INTELLIGENCE](../plans/PLATFORM-INTELLIGENCE.md).

- **Order (owner, fixed):** data model first (Phase 1, above), deterministic
  intelligence second, conversation and navigation last.
- **IN PROGRESS: PR #264** (draft) publishes the incident-intelligence API first
  (`lib/platform/incidents/intelligence/types.ts`, `audience.ts`), so the Phase-2 parity
  harness (PR #263, draft) can be built against it. Session 2's canonical rules D1–D10, incl. D2b (PB-1 §13.2), are
  adopted. There is no migration, and the STALE windows are one constant set (owner
  question pending). Each later reader cutover is its own PR, gated on the harness.
  Today about six readers compete over incident state, and this layer replaces them with
  one.
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

## Economics restructure

**PLANNED** (owner-approved, not implemented; proposal history in draft PR #129):

- A new top-level **Economics** area with **Overview · AI & Costs · Providers ·
  Entitlements**. Whether it becomes a new `PlatformArea` value or a re-composition of
  existing workspaces is not yet decided in code.
- **AI & Costs moves under Economics.** Today it is a Platform Operations workspace
  (`platform-ai`), and its lead already reserves an "Economics, Phase 3" block with no
  numbers (`components/platform/leads/AiCostsLead.tsx`).
- **Provider health stays in Platform Operations › Providers** (operations). Economics
  › Providers covers provider cost only.
- **Configuration stays in Policies.** Economics reads it and never edits it.
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
  reader shows them as stale and an owner-approved closure runs (PR #255 description).

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
