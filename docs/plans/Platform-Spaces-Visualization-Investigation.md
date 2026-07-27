# Platform Spaces — Visualization and Surface Investigation

**Slice:** FABLE-PLATFORM-VIZ-1
**Date:** 2026-07-26
**Status:** INVESTIGATION ONLY — no production code, no mockups, no UI changes.
**Verified against:** the working tree as connected this session (post-PM-1, post-OPS-2C/2D read paths, post-GROWTH-1, post-OPS-2D-5D-1 incident preview). All file citations were read from source this session. Claims that could not be verified are marked UNVERIFIED.

**Evidence discipline used throughout:**
- Production code = runtime/data evidence.
- `prototype/prototype-ops-control-plane/` = visual/workflow evidence only (gitignored fixtures; every number fabricated; `lib/prototype-containment.test.ts` enforces the boundary).
- Planning docs (`docs/plans/Platform-Ops-Prototype-Production-Migration.md`, `platform-ops-roadmap.md`, `OPS-2D-5-Roadmap.md`) = evidence, not authority. Where a doc and code disagree, the delta is stated (the migration doc is stale on PM-1, which has shipped).

---

## 1. Executive findings

**1.1 The architecture is far more visualization-ready than the current surfaces show — but the readiness is lopsided.** Platform Operations has ~24 canonical read authorities behind 26 routes, several of which are *route-available but never rendered* (`/refresh/failures` has no widget at all; `history` and `cost` accept `asOf`/`compareTo` that no widget ever sends; the refresh routes accept `from`/`to`/`plaidItemId` scoping no widget uses). The other three Spaces are thin: Security is five flat cards over three ledgers, Growth is five cards plus one canonical funnel surface, Customer Success is a single six-row preview. The highest-value near-term work is not inventing new data — it is **rendering data the platform already serves honestly**.

**1.2 The dominant-surface pattern stopped at Platform Operations, and the migration plan for extending it (PM-2/PM-3/PM-4) is already written and still unbuilt.** Exactly 3 of 33 registered platform widgets use the page-grain `SectionSurface` grammar (`ops_scheduler`, `ops_job_health`, `ops_platform_health`); the other ~30 — every `sec_*`, every `growth_*`, and the incident preview — still render in the older card grain. This is the single largest visual inconsistency in the platform surface, and closing it is mostly presentation work over existing authorities.

**1.3 Almost nothing operational is persisted as a verdict — and that is the design.** Five append-only ledgers (`JobRun`, `RefreshExecution`+children, `SyncIssue`/`SyncIssueOccurrence`, `ApiUsageCounter`, `AuditLog`, plus `RateLimit`/`NotificationDelivery`) carry facts; every health state, severity, freshness verdict, trust tier, and alert state is derived at read time by exactly one named authority, with structural tests banning second derivations. Any visualization proposal that implies a stored status history (e.g., "provider trust over time") is therefore a **backend prerequisite**, not a chart choice. Conversely, anything derived from the ledgers' own timestamps (daily signup counts, daily AI usage, per-run job history) is honest *event-time* data that only lacks a bounded projection.

**1.4 Two visualization primitives already exist for a chart nobody can draw.** `ExecutionStrip` and `RuntimeTrend` (with `RUNTIME_TREND_MIN_POINTS = 5`) shipped in `components/platform/platform-surface.tsx` for the job-detail panel, but have **zero production consumers** — because no route exposes per-run `JobRun` rows (`NO_RUN_SERIES_NOTE` in `jobs-view.ts` states this verbatim). The rows are persisted. One narrow per-job run-page projection unlocks two already-built, already-tested charts. This is the cleanest Tier 2 item in the catalogue.

**1.5 Assumption changed: there is no platform-wide "posture score" to build, and there should not be one.** The scheduler authority explicitly refuses a scheduler-health verdict ("inventing a green verdict over a subsystem nobody measures is the false-green defect that created Platform Ops"); provider trust, job health, freshness, and connection health use four different status vocabularies with different unknown semantics; and the Security and Growth domains have no verdict vocabulary at all (guard-enforced in Growth). A single aggregated score would launder UNKNOWN into a number. The honest posture surface is the one production already has — `ops_platform_health`'s four independent sources, each with its own four fetch states — extended with an explicit unknown-versus-healthy split (§6.1).

**1.6 Assumption changed: "Growth & Revenue" can render zero revenue concepts, and this is enforced, not accidental.** No billing/subscription/plan model exists anywhere in the schema; `growth-funnel.test.ts` asserts that no absent-capability word (revenue, cohort, attribution, churn, MRR, forecast) is ever followed by a digit or `%` on any growth surface. The Space description itself says "Revenue has no data source until billing (v3.0)." Every revenue visualization in this investigation is REJECT or Tier 3.

**1.7 The Customer Success dominant surface is blocked on one column and one policy decision.** `SyncIssue` has no `userId`; the item→user join exists in the schema graph but no shipped route performs it, and the migration doc marks "what may an operator see of customer identity" as an open **policy** question, not a design one. Until both land, Customer Success surfaces must stay incident-shaped (episodes, severities, subjects as institution·account labels), not customer-shaped. The prototype's customer portfolio is Tier 3.

**1.8 Several shipped numbers fail the honesty audit in the reassuring direction and should be fixed before or alongside any new mockups.** The security widget's "fails · 15m" pulse counts a different population than the anomaly detector (unverified-email failures inflate it; rate-limited attempts are invisible to both); the audit feed filter includes `PASSWORD_RESET` (an action nothing writes) while excluding the two password-reset actions that are written — so password-reset activity is silently invisible; MFA adoption % is diluted by deactivated users; anomaly trips render without their `key`, so an operator sees "Failed-login burst (IP)" without the IP. These are catalogued in §14 and folded into the Tier 1 briefs they touch.

**1.9 The reusable interaction spine is proven and should be treated as law for new surfaces:** self-fetching widgets over static URLs (`useWidgetFetch`, keyed-remount escape for per-object reads), three-condition render gate (registry ∧ composition ∧ enabled DB row — with the R-5 hazard that a forgotten seed row ships an invisible surface), widget-owns-its-panel `RightPanel` drills (no `PanelHost` exists; do not invent one), doorways that render nothing when unwired, DB-owned labels, and Preview → Browser → Detail with the browser built only after the preview has been used.

---

## 2. Current architecture census

### 2.1 The universal model, as shipped

```
Space (Space row, platformArea marker, zero SpaceMember rows)
→ Workspace (PLATFORM_WORKSPACES identity ∪ universal WORKSPACE_REGISTRY;
             PLATFORM_AREA_WORKSPACES composition)
→ Surface (section keys → SpaceDashboardSection rows → PLATFORM_WIDGET_REGISTRY components)
→ contextual drill (widget-owned RightPanel; bottom sheet on mobile)
```

- **Render path (the only one):** `app/(shell)/dashboard/platform/[area]/page.tsx` → `PlatformSpaceDashboard` → `SpaceShell` (shared with customer Spaces and Connections/Settings) → `PlatformWorkspaceBody` → per-section widget mount + `Explore` doorway grid. Gate order: known area → session → ACTIVE `PlatformGrant` ≥ READ → Space + enabled sections; every failure redirects, never 404s.
- **Access:** `PlatformGrant(userId, area, level READ|WRITE|CONTROL, status)` is the sole authority (`hasPlatformAccess`, pure). CONTROL is canonical but not mintable (`ISSUABLE_LEVELS = ["READ","WRITE"]`). SYSTEM_ADMIN break-glass exists on API routes only; the page redirects admins to `/admin`. The Platform switcher (`PlatformNav` in `ContextualNavbar`) is a server projection of ACTIVE grants — renders nothing for zero grants.
- **Workspaces:** PLATFORM_OPS is decomposed into 9 workspaces (Overview · Jobs · Refresh · Providers · Operations · Alerts · History · AI · Costs) with 8 doorways on Overview. SECURITY_OPS, GROWTH_REVENUE, CUSTOMER_SUCCESS each remain one flat `platform-overview` workspace. Consolidation is declared (`PLATFORM_SECTION_REPRESENTATION`: 5 ops keys absorbed into `ops_platform_health`), so an absorbed key is distinguishable from an accidentally dropped one.
- **The three-condition render gate:** a widget renders only if its key is (a) in `PLATFORM_WIDGET_REGISTRY` (33 entries), (b) composed into a workspace (31 of 33; `ops_rate_limits` and `ops_env_status` reachable only via absorption), and (c) backed by an **enabled `SpaceDashboardSection` DB row**. Seeding is `ensurePlatformSections` (label converges, operator-owned fields create-only). **R-5 hazard:** a registered widget with no seeded row renders nothing, silently — every new section in this investigation carries a seed-row requirement.
- **Fetching:** widgets self-fetch (`useWidgetFetch` — static-URL contract, test-pinned; `useSharedWidgetFetch` dedupes within a `WorkspaceSessionProvider` keyed by workspace, discarded on rail switch so an operational read never has a staleness window). Per-object drills use the keyed-remount reader precedent (`ExecutionTimelinePanel`).
- **Panels:** Atlas `RightPanel` (sm 400 / md 480 / lg 600 / xl 720; bottom sheet below `sm`, one component, no fork). Convention: widget owns its panel, panel stays mounted with `open` toggling, no second fetch unless keyed-remounted. **No `LeftPanel` is used anywhere in `components/platform/`** — the prototype's customer-as-subject left panel is unadopted. No `PanelHost`/drill registry exists; do not plan against one.
- **Mobile:** class-only responsive (`useNarrowViewport` deliberately not ported). Sidebar and `PlatformNav` disappear below `lg` (the cross-area switcher is therefore **absent on mobile** — a real gap, UNVERIFIED whether intentional); Space identity relocates into `SpaceShell`'s mobile row; the Jobs table drops four columns below `md` and re-presents them inside the row expansion ("a phone loses layout and never loses a fact"); panels become bottom sheets.

### 2.2 Visualization primitive census (fresh)

**Page grain — `components/platform/platform-surface.tsx` (the PM-1 grammar; the prototype's `parts.tsx` is its UI authority):**

| Primitive | Status | Consumers | Notes |
|---|---|---|---|
| `SectionSurface` | shipped | Scheduler, Jobs, Platform Health (3 widgets) | The one bordered frame per surface (FRAME RULE). `<section id>` scroll target, `<h2>` title, actions + footnote slots. |
| `BigStat` | shipped | Scheduler only | label → figure → qualifier → **derivation** (the honesty line). |
| `TwoLine` | shipped | Platform Health, Jobs | value-over-qualifier table-cell grammar; never truncates. |
| `GroupLabel` | shipped | Scheduler, Platform Health | 10px eyebrow with accessible hint (`role="img"`, not hover-only). |
| `StatusBadge` | shipped | Jobs, JobDetailPanel | dot+word; tone union is currently jobs-shaped (`JobHealthStatus`). |
| `StatusWord` | shipped | Platform Health only | verdict word + colour; cannot spend colour without a word by signature. |
| `Unavailable` | shipped | Scheduler, Jobs, JobDetailPanel | em-dash + reason; **the** unknown-state primitive. |
| `Provenance` / `NO_AUTHORITY` | shipped | Scheduler, Platform Health, Jobs, JobDetailPanel | mono chip naming the system of record; "no authority" renders neutral. |
| `KeyRow`, `PanelSection` | shipped | JobDetailPanel | panel-plane grammar; `PanelSection` is the sanctioned frame-rule exception. |
| `VRule` | shipped | Scheduler | column separator, `hidden md:block`, prop-less by test. |
| `PolicyChip` | shipped, **orphaned** | none | declared-axis pill awaiting a job-policy authority. |
| `ExecutionStrip` | shipped, **orphaned** | none | per-run marks + deployment boundary; blocked on a per-run route (§16). |
| `RuntimeTrend` | shipped, **orphaned** | none | duration polyline; refuses < 5 points and says why. |

**Card grain — `components/platform/widget-kit.tsx`:** `PlatformWidgetCard` (Atlas `Block` eyebrow + `Surface`; ~25+ consumers), `WidgetStat` (deliberately tone-less: "a number's colour is a claim"), `WidgetMessage` (loading/error/empty — **no live-region roles**; the rigorous `role="status"`/`role="alert"` handling exists only in the hand-rolled variants in Platform Health, Scheduler, and IncidentPreview), `timeAgo`, `useWidgetFetch`/`useSharedWidgetFetch`.

**Atlas base:** `Surface`/`Block`/`Figure`/`Delta` (no brand tone on figures — Design Language Law 7), `SegmentedControl`, `RightPanel`/`LeftPanel`/`PanelHeader`/`PanelContent`/`PanelFooter`/`PanelStack`, `GlassButton`, `ConfirmDialog`, `InlineFilter` and `Chips` (both unused by platform widgets), `EmptyState` (orphaned — two local `EmptyState`s exist instead). Atlas Liquid is doctrinally banned from Platform Ops (`ATLAS_LIQUID_PLATFORM_DOCTRINE.md`).

**Domain surfaces:** `FunnelStages` (+ `growth-funnel-view.ts`, `GrowthStagePanel`) — canonical, colour-less, explicitly declared **non-promotable** to a shared primitive; `IncidentPreview` (+ `incident-preview-view.ts`) — the canonical four-states-kept-apart preview; `JobsTable`/`Toolbar`/`JobRow`/`JobRowDetail` — the canonical dominant-table pattern; `ExecutionTimelinePanel` — the keyed-remount drill precedent; `CalendarHeatmapGrid`, `Sparkline` (orphaned), `DeltaBadge` — customer-Space side, not platform.

**Expected primitives that DO NOT exist in production** (prototype-claude only, or never built): `Stat`, `DistributionBar`, `MiniBars`, `Funnel` (as a primitive), `HealthDot` (four independent hand-rolled dot implementations exist), `StatusList`, `Meter`, shared `GroupHeading` (three unrelated local definitions, one with a written justification for staying local), shared `ActivityTimeline` (the space-side one is Activity-workspace-specific). §10 decides which of these earn promotion.

### 2.3 Naming and consistency debt worth noting for the mockup phase

- `growth_users`/`growth_activity`/`growth_funnel` map to components named `OpsUsersWidget`/`OpsActivityWidget`/`OpsGrowthWidget`.
- Two card grains coexist by documented design, but 30 of 33 widgets are still on the old grain.
- `ops_rate_limits` and `ops_env_status` widget files are effectively dead render paths (their data reaches operators through `ops_platform_health`'s own fetches).
- A11y is uneven: the `platform-surface` consumers are rigorous; the ~29 `WidgetMessage` widgets announce nothing on loading→error transitions.

---

## 3. Current data-authority census

Full per-Space detail is in §§6–9; this section is the cross-Space inventory of what exists at each tier.

### 3.1 Persisted (the ledgers)

| Ledger | Grain | Key time/status fields | Retention |
|---|---|---|---|
| `JobRun` | one background-job execution | `startedAt` (observation=event), `completedAt`, `durationMs`, `status` running/succeeded/failed, `deploymentSha`, `errorSummary` (500-char cap) | unbounded (R2 deferred) |
| `RefreshExecution` + `RefreshEndpointResult` + `ProviderCall` + `RefreshEndpointAccountCoverage` | per-item refresh → per-stage → per-provider-call → per-(endpoint,account) | `startedAt/completedAt/durationMs` at every level; `overallStatus` RUNNING/SUCCEEDED/PARTIAL/FAILED/SKIPPED; `admissionReason`; `freshnessAdvanced` | unbounded |
| `SyncIssue` + `SyncIssueOccurrence` | incident **episode** + observed manifestation | `incidentKey` (identity as constraint: one active episode per key), `firstOccurredAt`/`lastOccurredAt`/`resolvedAt`, `resolutionKind` (only `AUTOMATIC_RECOVERY` is ever produced), `previousIncidentId` (recurrence chain), occurrence `observedAt` | unbounded; no severity/domain/state columns — derived only |
| `ApiUsageCounter` | (provider, metric, unit, UTC day) | daily buckets; PLAID + OPENAI; **no user/space dimension** | unbounded |
| `AuditLog` | one event | `action` (free String — canon drift is real, §14), `createdAt`, `userId?`, `performedByAdminId?`, `ipAddress`, `metadata` | unbounded, no retention |
| `UserSession` | one session | `lastActiveAt` (bumped at most every 30s, cache-miss only), `revokedAt/revokedById`, raw UA, IP | revoked rows never deleted |
| `RateLimit` | (key, window) | `windowStart`, `count`; key subject is PII | swept by `rate-limit-sweep` |
| `NotificationDelivery` | one delivery | channel/status/provider/attempts/`deliveredAt`; **auth emails bypass it** | — |
| `BetaAccessRequest`, `User`, `PlatformGrant`, `PlatformSetting` | growth/access/control state | statuses, invite lifecycle timestamps, registration_mode/product_status, alert-rule enablement, admission facts | — |

### 3.2 Derived canonically (one authority each, never stored)

Job health (`healthy|never-ran|running|overdue|dead|failing`, precedence-ordered, window = last 50 runs) · scheduler observation (Observed/Expected/Notes; **no tick record, no scheduler verdict — refused**) · provider trust (`OPERATIONAL|DEGRADED|STALE|FAILING|UNKNOWN`, unknown outranks soft verdicts) · resource freshness (`fresh|stale|empty|idle` + trust `high|medium|low|unknown`, false-green flags when a successful run coexists with a stale archive) · connection health (`HEALTHY|STALE|DEGRADED|NEEDS_REAUTH|ERROR|REVOKED`; `lastSyncedAt == null` is STALE, not unknown) · incident semantics (domain/severity/nature/state/recovery/wording — `sync-issue-semantics.ts`, guard-enforced sole authority) · refresh projections (summary/coverage/provider-operations/failures/timeline, each in a `ProjectionEnvelope` with `deterministic` + `indeterminacyReason` + `checkedAt`; `tierFor` → observed/derived/unknown) · convergence episodes (semantic-first correlation, 14d window, narrative trust ≥ derived) · operational history (4 sources, as-of/compare-to mirroring Financial time; provider evolution deliberately NOT a source) · cost metrics (consumes only S7+S9; `spend-usd` permanently `unknown, not zero`) · alert signals (5 rules, 2 severities, dedupe via JobRun summaries — the ledger IS the alert store) · growth funnels (two populations, `ratio()` null on zero denominator) · user activity (DAU/WAU/MAU from LOGIN events) · admission verdicts (ADMIT/DENY + reasons; no route exposes them) · env report (names+status only) · email delivery health · audit-action classifications (`OPERATOR_ACTION_FEED_ACTIONS`, `ADMIN_SECURITY_FILTER_ACTIONS`) · anomaly detection (4 fixed-threshold rules over LOGIN_FAILED, no severity, no baselining).

### 3.3 Projected but NOT route-available (free candidate fuel)

`getHistoricalIncidents(limit)` · `getIncidentDetail(id)` · `getRefreshExecutionDetail(...)` · `lib/platform/stall-projection.ts` (fully orphaned) · admission/control-plane facts (readable via `PlatformSetting`, no read surface).

### 3.4 Route-available but NOT rendered (the cheapest new surfaces)

`GET /platform-ops/refresh/failures` (`FailureSummary`: execution/endpoint/provider-call failure groupings — **no widget exists**) · `history` and `cost` `asOf`/`compareTo` params (routes accept; widgets fetch static URLs) · `refresh/*` `from`/`to`/`plaidItemId` scoping (accepted, never sent) · execution seam filters `status`/`trigger`/`since`/`until`/`cursor` (widget sends only `limit=20`) · anomaly `key`/`threshold`/`message` (fetched, never rendered) · session `os` (fetched, dropped) · `AiUsageTrend.days[]` daily series (rendered only as totals — UNVERIFIED how much of the series the current widget paints) · incident `previousIncidentId`/`correlatedOccurrenceCount` (in projections, absent from preview DTO).

### 3.5 Authorization boundary consequences for visualization design

Routes are gated per-area (`requirePlatformAccess(area, "READ")`). **A widget composed into one Space cannot call another area's routes** — a Customer Success surface wanting connection-health facts cannot reuse `/platform-ops/connection-health`; it needs a CS-gated projection with CS-appropriate scope (and the operator-identity policy applies). All WRITE routes use fresh re-auth; CONTROL routes do not exist. Emergency controls: only `DISABLE_SYSTEM_ADMIN` (env), with no read surface — an "emergency controls active" widget is a **backend prerequisite**.

---

## 4. Operator question inventory

Grading: **ANSWERABLE NOW** (authority + route exist) · **PARTIAL** (some of the question answered, gap stated) · **PROJECTION GAP** (fact persisted, bounded read missing) · **AUTHORITY GAP** (no canonical fact exists) · **REFUSED** (the architecture deliberately declines the question).

### 4.1 Platform Operations

| Question | Grade | Grounding |
|---|---|---|
| Is the platform operating normally? | ANSWERABLE NOW (as four verdicts, not one) | `ops_platform_health` — alerts + provider trust + freshness + configuration; each source keeps its own loading/failed/empty/answered state; no aggregate score exists and none should (§1.5). |
| What is failing right now? | ANSWERABLE NOW | job-health counts (failing/dead/overdue), provider `FAILING`, connection unhealthy rows (cap 20, true totals), active incidents (severity-ranked floor), alert history. |
| Which failures are getting worse? | PARTIAL | `consecutiveFailures` per job; convergence episodes narrate recurrence within 14d; incident `occurrenceCount` shows depth. **No per-run series crosses the API** and no period comparison is rendered — worsening is currently inferable only from counts, not trends. |
| Which providers or endpoints are stale? | ANSWERABLE NOW (2 resources + connections) | resource-freshness (fx-rates, security-prices; completeness ratios; false-green flags), provider freshness state, connection STALE (48h Plaid / 12h wallet). Per-*endpoint* staleness for refresh coverage is REFUSED — "'stale now' needs a per-endpoint cadence authority that does not exist." |
| Which scheduled jobs are late or failing? | ANSWERABLE NOW | job-health `overdue`/`dead`/`failing` + scheduler `observed.overdue`. |
| What has not run when expected? | ANSWERABLE NOW, with a stated epistemic limit | scheduler Observed vs Expected; a silent dispatcher surfaces as overdue work; **ticks are unobservable** (refused, notes say so on-surface). |
| Which incidents are recurring? | PROJECTION GAP | `previousIncidentId` chains are persisted and projected (`IncidentView`) but no route/UI renders them. |
| Where is operational uncertainty highest? | ANSWERABLE NOW | UNKNOWN provider trust, freshness trust `low|unknown`, projection `tier` fields, `deterministic:false` envelopes, `occurrenceCountKnown:false`, `scanTruncated`. The material exists; no surface aggregates it (§6.1 candidate). |
| What changed since the previous period? | PARTIAL → presentation work | `history`/`cost` accept `compareTo` and return `compareStates`; **no widget sends it**. Refresh projections accept windows. Everything else is point-in-time. |
| Which systems have no trustworthy health verdict? | ANSWERABLE NOW | provider UNKNOWN; scheduler (verdict refused by doctrine); job `never-ran`; freshness trust unknown; admission facts unreadable (no route). |

### 4.2 Security Operations

| Question | Grade | Grounding |
|---|---|---|
| Who accessed privileged surfaces? | PARTIAL | `sec_operator_actions`: 17 privileged actions ∧ `performedByAdminId != null`, last 20. **Page/route *views* are not audited** — only mutations; "accessed" is answerable only as "acted." |
| What sensitive actions occurred? | PARTIAL | audit feed (15-action filter, last 15, 8 rendered). Known holes: password-reset actions invisible (filter lists an action nothing writes), member-role changes unaudited, admin recovery-code regeneration attributed to the user (§14). |
| Are there abnormal authorization patterns? | PARTIAL, narrow by design | 4 fixed-threshold login-failure rules only. No detection on grants, exports, operator bursts, resets. Widget must not imply broader coverage. |
| Which sessions or operators present the highest concern? | AUTHORITY GAP | No per-session or per-operator risk concept. Sessions surface is deliberately PII-free (browser·device only). REFUSED as scoring; PARTIAL as "recent activity." |
| Are emergency controls active? | AUTHORITY GAP (read surface) | `DISABLE_SYSTEM_ADMIN` env is the only control; no route reports its state. |
| Are security controls configured as intended? | PARTIAL | auth posture counts (TOTP enrolment, forced resets, recovery-code coverage, active sessions). No target thresholds exist (prototype's `totpTargetPct: 75` was never adopted); `totalUsers` includes deactivated accounts. `REQUIRE_TOTP_ALL_USERS` setting exists but is not exposed on a security route. |
| Which security events remain unresolved? | AUTHORITY GAP | No finding/investigation-state model. The prototype renders this as read-only with the gap named; production renders nothing. |
| What changed recently? | PARTIAL | the three feeds, fixed depths (15/20/8), no time-range control, no comparison. |
| Where is audit coverage incomplete? | ANSWERABLE as a *statement*, not a metric | The gaps are code facts (unaudited paths, vocabulary drift), not runtime data. A data-confidence callout can state them; a "coverage %" would be fabricated. |

### 4.3 Growth & Revenue

| Question | Grade | Grounding |
|---|---|---|
| Where are users entering the funnel? | ANSWERABLE NOW | beta funnel `requested` (+ signups counts). Entry *channel* is AUTHORITY GAP (no attribution field). |
| Where are they dropping? | ANSWERABLE NOW | stage counts + siblings (Denied/Pending) + three-state rates; activation gap derivable from existing DTOs (`redeemed − redeemedActivated`, approved-unredeemed from `/requests` counts). |
| Which acquisition sources convert? | AUTHORITY GAP → REJECT | no attribution/referral field anywhere; guard-enforced absent. |
| How is activation progressing? | PARTIAL | activation funnel is point-in-time; "progressing" needs history that doesn't exist. Signup-per-day IS derivable from `User.createdAt` (PROJECTION GAP, honest event time). |
| Which cohorts retain? | AUTHORITY GAP | no cohort model; only `returning7`. |
| Revenue recurring/new/expanded/contracted/lost? | AUTHORITY GAP → REJECT | no billing model (v3.0); enforcement test bans rendering it. |
| Forecast versus realized? | AUTHORITY GAP → REJECT | nothing forecasts. |
| Which segments improve or deteriorate? | AUTHORITY GAP | no segments, no history. |
| What data is incomplete or delayed? | ANSWERABLE NOW | `checkedAt` on every projection; the named-absent list (revenue/cohorts/attribution) is already rendered as prose in `OpsGrowthWidget`; the prototype's Unobserved column formalizes it. |

### 4.4 Customer Success

| Question | Grade | Grounding |
|---|---|---|
| Which customers are currently affected? | AUTHORITY GAP (blocked) | no `SyncIssue.userId`, no item→user route, open identity policy. Tier 3. |
| What operational problems are customer-visible? | ANSWERABLE NOW | `customerActionable` classification (affirmative-signal rule), severity/domain/nature, operation phrases ("Storing bank transactions", …). |
| Which institutions/accounts/connections are unhealthy? | PARTIAL | incident subjects (institution · account, never an id); connection health lives behind PLATFORM_OPS gates — a CS-scoped projection is required to show it here (§3.5). |
| Which customers have recurring incidents? | PROJECTION GAP (and identity-blocked at the customer grain) | recurrence chain persisted; renderable at the *subject* grain (institution/connection) without the userId join. |
| Who may need outreach? | AUTHORITY GAP → REJECT | no outreach/ticket/owner model; migration doc: not even greyed out. |
| What has recovered automatically? | PROJECTION GAP | `state === "recovered"` + `resolutionKind AUTOMATIC_RECOVERY` + `resolvingExecutionId` all persisted/projected via `getHistoricalIncidents` — **no route**. |
| What remains unresolved? | ANSWERABLE NOW | active incidents (floor semantics honest: `activeTotal`, `moreCount`, `truncated`). |
| Where are customer labels unavailable? | ANSWERABLE NOW | null-subject handling is canonical ("Affected account unavailable", same visual weight as known). |
| Which customers experience stale or incomplete data? | AUTHORITY GAP at customer grain; PARTIAL at connection grain | diagnostics exist but are PLATFORM_OPS-gated and expose owner email (a deliberate, grant-gated PII deviation that must NOT leak into CS). |

---

## 5. Visualization candidate catalogue

Readiness categories used exactly as specified: **READY NOW** · **READY WITH PRESENTATION WORK** · **READY WITH NARROW PROJECTION** · **BACKEND PREREQUISITE** · **DESIGN EXPLORATION ONLY** · **REJECT**.

Shared state doctrine applying to every candidate below (stated once, referenced as "std. states"): loading = explicit `role="status"` line, never the empty state; error = `role="alert"` naming that the platform could not be asked ("this is not a report of zero"); empty = a sentence scoped to what emptiness means for *this* authority, never generalized health; unknown = `Unavailable(reason)` / `Provenance("no authority")`, rendered at full weight; truncation = floor language ("count is a floor"). Mobile default: single-column stack; tables collapse columns into row expansion (Jobs precedent); panels become bottom sheets. Accessibility default: status words beside colours, no hover-only facts, `tabular-nums`, focus-visible rings.

### 5.1 Platform Operations candidates

| # | Candidate | Workspace | Operator question | Form | Authority / route | Readiness |
|---|---|---|---|---|---|---|
| P1 | **Refresh Execution Browser** (upgrade `ops_refresh_executions` from 20-row list to a real browser: status/trigger filters, since/until, keyset "load older", timeline drill) | Refresh | "What did refresh do, and which executions failed?" | dense table + filter bar + RightPanel timeline | execution query seam (`ExecutionPageDTO`, cursor, filters — all shipped); `/refresh/executions` + `/[id]/timeline` | **READY NOW** |
| P2 | **Failure Composition surface** (new widget over the widget-less route: failures by execution status, by endpoint, by provider error code/category) | Refresh (also doorwayed from Providers) | "What is failing, in which stage, with which provider error?" | segmented distribution bars + ranked table | `getFailureSummary` / `/refresh/failures` (`NON_SUCCESS_STATUSES = FAILED, PARTIAL`; free-text never grouped) | **READY NOW** |
| P3 | **Period comparison header** for History/Costs (as-of + compare-to controls; render `compareStates` deltas) | History, Costs | "What changed since the previous period?" | period/comparison header + paired as-of states | `getOperationalHistory(asOf, compareTo)` — route accepts params today | **READY WITH PRESENTATION WORK** (param-carrying fetch = keyed-remount or widened fetch contract) |
| P4 | **Outcome composition strips** for refresh summary (byStatus/byTrigger/byProfile as segmented bars instead of stat rows) | Refresh | "How did the window's executions distribute?" | compact distribution (counts labelled, no colour-as-verdict for trigger/profile; status may use tone words) | `RefreshSummary` (shipped, rendered as stats today) | **READY WITH PRESENTATION WORK** |
| P5 | **Endpoint pipeline table** (EndpointRollup as a dense table: attempted/succeeded/failed/skipped + skip reasons + `freshnessAdvanced` + `recordsChanged` with null ≠ 0) | Refresh | "Which pipeline stage is losing work?" | dense table, rows = endpoints (stable, enum-backed) | `RefreshSummary.endpoints` | **READY WITH PRESENTATION WORK** |
| P6 | **Provider operation ledger** (provider × operation rows; attempt distribution; `paginationConfounded` flag rendered; explicitly NO retry rate) | Providers | "Which provider operations are failing or rate-limited?" | dense table + per-row attempt mini-distribution | `ProviderOperationSummary` (rendered today as simpler list) | **READY WITH PRESENTATION WORK** |
| P7 | **Unknown-vs-healthy split** in Platform Health (surface UNKNOWN counts and trust tiers as a first-class group: "N systems have no verdict") | Overview | "Where is uncertainty highest? / What has no trustworthy verdict?" | posture group: stat + status list of unknowns with reasons | provider counts (UNKNOWN), freshness trust, scheduler's refused verdict, admission unreadability | **READY WITH PRESENTATION WORK** |
| P8 | **AI usage daily trend** (render `AiUsageTrend.days[]` as day-bucket bars: calls + tokens; spend only when `pricingConfigured`) | AI, Costs | "How is AI usage trending?" | mini bar series over UTC days, missing days as gaps | `getAiUsageTrend` (30 daily buckets, real event-time series) | **READY NOW** |
| P9 | **Per-job run series** (light up orphaned `ExecutionStrip` + `RuntimeTrend` in JobDetailPanel) | Jobs | "Is this job's runtime drifting? Which recent runs failed, and did a deploy change behavior?" | execution strip + runtime polyline (≥5 points or refusal) in the existing panel | `JobRun` rows persisted; **no per-job run route** | **READY WITH NARROW PROJECTION** (bounded per-job run page, e.g. last 20) |
| P10 | **Job failure heatmap** (hour × day × failures) | Jobs | — | heatmap | ~10 runs/day fleet-wide; density nowhere near supporting it (prototype rejected throughput charts at this scale) | **REJECT** (small population) |
| P11 | **Scheduler tick timeline** | Jobs | "Did the dispatcher fire?" | timeline | ticks are unobservable by design; no fact exists | **REJECT** (would fabricate; the refusal is itself rendered) |
| P12 | **Admission / control-plane read surface** (maintenance mode, ingestion paused, fact states ON/OFF/MISSING/INVALID/UNAVAILABLE) | Operations | "Is any operational hold active?" | status list (declared axis — quiet, no health colour) + provenance `PlatformSetting` | `readControlPlaneFacts` exists; **no route** | **READY WITH NARROW PROJECTION** |
| P13 | **Incident occurrence time series** (occurrences/day) | — (Ops or CS) | "Is incident pressure rising?" | trend | `SyncIssueOccurrence.observedAt` persisted; no projection; must be labelled occurrences, never incidents | **READY WITH NARROW PROJECTION**, Tier 3 priority (interpretation risk) |
| P14 | **Rate-limit pressure history** | Providers | — | trend | rows are swept; 1h window is current-pressure by design | **REJECT** (history would require a new rollup store — backend prerequisite if ever wanted) |
| P15 | **Provider trust over time** | History | "Is Plaid getting healthier?" | trend | explicitly refused in `history/sources.ts` — needs connection-state history that doesn't exist | **BACKEND PREREQUISITE** |
| P16 | **Convergence episode browser refinements** (episode cards with narrative trust chips; timeline cap surfaced) | History | "What happened, and did it recover?" | activity timeline + episode cards | `ConvergenceResult` (rendered today) | **READY WITH PRESENTATION WORK** (polish, not new data) |
| P17 | **Coverage staleness matrix** (account × endpoint "stale now") | Refresh | — | matrix | coverage authority explicitly refuses a staleness verdict (no per-endpoint cadence) | **REJECT** until a cadence authority exists (BACKEND PREREQUISITE) |
| P18 | **Email delivery split** (sent/captured/error/skipped + recent errors; "captured ≠ sent" and the auth-email hole stated) | Providers | "Is mail actually going out?" | stat row + distribution + error list + data-confidence callout | `getEmailDeliveryHealth` (rendered today; hole documented in header) | **READY WITH PRESENTATION WORK** |

### 5.2 Security Operations candidates

| # | Candidate | Workspace | Operator question | Form | Authority / route | Readiness |
|---|---|---|---|---|---|---|
| S1 | **Security posture surface** (PM-2's contextual block: Detections \| Coverage \| Notes; provenance chips `AuditLog`/`UserSession`; explicit absence note: no score, no threat feed, no remediation) | Overview | "Are controls configured as intended? What fired?" | three-column epistemic surface (Scheduler grammar) | the five shipped sec routes | **READY WITH PRESENTATION WORK** |
| S2 | **Consolidated security activity surface** (merge audit feed + operator actions + sessions into one `SectionSurface` with three groups, per prototype) | Overview | "What happened recently, by whom?" | grouped activity stream + provenance | `/audit`, `/operator-actions`, `/sessions` | **READY WITH PRESENTATION WORK** |
| S3 | **Anomaly trips with identity and threshold** (render `key`, `count`/`threshold`, `windowMinutes`, and split the pulse population honestly) | Overview | "Which anomaly fired, against what?" | status list with per-trip detail; caveat line on empty state ("no detector fired ≠ nothing wrong") | `/anomalies` (key/threshold already in DTO, unrendered) | **READY NOW** (population split of `failedLoginsWindow` needs a route change → that part READY WITH NARROW PROJECTION) |
| S4 | **MFA coverage meter with honest denominator** (exclude deactivated users; render the exclusion) | Overview | "Is TOTP enrolment where it should be?" | stat + proportion bar; no target line until a target authority exists | `/auth-posture` (denominator fix = route change) | **READY WITH NARROW PROJECTION** |
| S5 | **Security event volume trend** (daily counts of security-filtered audit actions) | Overview | "Is security event volume abnormal this week?" | trend with stated caveats (rate-limited attempts invisible; vocabulary drift) | `AuditLog` persisted, `(action, createdAt)` indexed; no projection | **READY WITH NARROW PROJECTION** |
| S6 | **Security findings table** (clustered, severity-ranked dominant surface) | Overview | "What needs investigation?" | dominant table + investigation RightPanel | no `SecurityFinding` model, no clustering rule, no investigation state | **BACKEND PREREQUISITE** (prototype documents the shape; `state` needs a mutable authority + decision log) |
| S7 | **Emergency-controls status** | Overview | "Is the admin kill switch active?" | declared-axis status word | env flag; no route | **READY WITH NARROW PROJECTION** (read-only env fact exposure; trivially bounded) |
| S8 | **Session browser with revoke** | Overview | "Whose sessions are these?" | table + row action | deliberate PII boundary on this surface (no userId/IP by design); revocation lives on SYSTEM_ADMIN surfaces | **REJECT for SECURITY_OPS as scoped today** (would breach the route's documented privacy boundary; revisit only with a policy decision) |
| S9 | **Role × privileged action matrix** | Overview | — | matrix | only 17 operator actions, tiny operator population; `performedByAdminId` soft ref | **REJECT** (cardinality too small; a grouped list answers it) |
| S10 | **Audit coverage callout** (static data-confidence note naming unaudited mutation families) | Overview | "Where is audit coverage incomplete?" | data-confidence callout (prose, no fabricated %) | code-level facts; goes stale silently | **DESIGN EXPLORATION ONLY** (pair with a source-scan test if ever shipped) |

### 5.3 Growth & Revenue candidates

| # | Candidate | Workspace | Operator question | Form | Authority / route | Readiness |
|---|---|---|---|---|---|---|
| G1 | **Window & coverage surface** (PM-3: Observed \| Unobserved \| Notes; Unobserved renders revenue/cohorts/attribution via `Unavailable` at full weight) | Overview | "What does growth observe, and what does it not?" | three-column epistemic surface | `/signups`, `/requests`, `/growth` + the enforced absence list | **READY WITH PRESENTATION WORK** |
| G2 | **Canonical funnels** (existing `FunnelStages` × 2 + stage panel) | Overview | "Where are users entering and dropping?" | funnel (the only two defensible ones: shared population per funnel, never chained across funnels) | GROWTH-1 trio (shipped) | **READY NOW** (already rendered; mockups must not alter semantics) |
| G3 | **Activation gap card** (approved-unredeemed, redeemed-never-signed-in = `redeemed − redeemedActivated`, verified-never-signed-in) | Overview | "Who got in but never arrived?" | stat group with derivations | `/growth` + `/requests` counts (first two derivable now; verified∩never-signed-in overlap needs a query) | **READY WITH PRESENTATION WORK** (overlap stat: READY WITH NARROW PROJECTION) |
| G4 | **Approval queue age** (oldest pending, FIFO depth) | Overview | "Is the beta queue rotting?" | stat + ranked pending list (already row-available) | `/requests` pending rows carry `createdAt` (FIFO, take 100) | **READY WITH PRESENTATION WORK** |
| G5 | **Signups per day trend** | Overview | "Are signups accelerating?" | day-bucket bars, missing days as gaps, UTC noted | `User.createdAt` persisted; no projection (docs call growth "point-in-time only" — a createdAt histogram is honest event-time data, but it is NEW semantics and needs its own authority) | **READY WITH NARROW PROJECTION** |
| G6 | **DAU/WAU/MAU trend** | Overview | "Is activity growing?" | trend | LOGIN events persisted; daily-distinct projection missing | **READY WITH NARROW PROJECTION** |
| G7 | **Beta invitation lifecycle strip** (sent/accepted/expired/revoked) | Overview | "Are invitations converting?" | compact distribution, labelled counts, no rates beyond authority's | `getBetaInvitationLifecycle` → `/beta-status` | **READY WITH PRESENTATION WORK** |
| G8 | **Acquisition source breakdown** | — | — | — | no attribution field | **REJECT** (guard-enforced absent) |
| G9 | **Revenue movement / MRR waterfall / forecast** | — | — | — | no billing model until v3.0 | **REJECT** |
| G10 | **Cohort retention curves** | — | — | — | no cohort model; only `returning7` | **BACKEND PREREQUISITE** (Tier 3; needs cohort semantics minted deliberately, not by a chart) |
| G11 | **Segment comparison** | — | — | — | no segments | **REJECT** |

### 5.4 Customer Success candidates

| # | Candidate | Workspace | Operator question | Form | Authority / route | Readiness |
|---|---|---|---|---|---|---|
| C1 | **Impact composition header** (severity distribution + `activeTotal`/`moreCount`/floor language above the preview) | Overview | "How bad is it right now, in one honest line?" | compact severity distribution + summary sentence | `IncidentPreview.severityCounts` (counted over the full active set — already in the DTO) | **READY NOW** |
| C2 | **Incident preview** (existing canonical surface) | Overview | "What is open, against whom?" | incident preview (severity word+colour, subjects, occurrence depth, recovery text) | shipped (OPS-2D-5D-1) | **READY NOW** (mockups coordinate with, never rebuild, its wording) |
| C3 | **Incident Browser** (Preview → Browser: full active set + filters severity/domain/state, floor semantics) | Overview (future `platform-incidents` workspace — conceptual only) | "Show me everything open, ranked" | dense table; row → detail | `getActiveIncidents`/`getActiveIncidentPage` exist; **no route** (OPS-2D-5D-2 not built; roadmap sequencing: preview first, observe, then browser) | **READY WITH NARROW PROJECTION** |
| C4 | **Incident Detail panel** (occurrences, correlation, recurrence chain) | Overview | "How deep and how old is this episode?" | RightPanel: lifecycle facts + occurrence timeline (`correlationUnavailable` stated, never "no execution failed") | `getIncidentDetail` exists; **no route**; migration doc reserves detail for UI-2 — must be coordinated, not independently minted | **READY WITH NARROW PROJECTION** (sequencing-gated) |
| C5 | **Recurrence chain view** ("this episode recurred; previous episode resolved N days before") | Overview (inside C4) | "Which incidents are recurring?" | linked-entities panel section (relationship as a list, not a graph) | `previousIncidentId` persisted + projected, zero UI | **READY WITH NARROW PROJECTION** |
| C6 | **Recovery ledger** (recently recovered episodes: `resolvedAt`, `AUTOMATIC_RECOVERY`, resolving execution when proven) | Overview | "What healed on its own?" | status list / table over historical incidents | `getHistoricalIncidents` exists; **no route** | **READY WITH NARROW PROJECTION** |
| C7 | **Domain backlog composition** (active incidents by domain: transactions/investments/imports/wallet/reconciliation/unknown) | Overview | "Which operation families are hurting?" | compact distribution over the same 200-row scan (floor language mandatory) | derivable in `preview-core` from classifications already computed | **READY WITH PRESENTATION WORK** (extend the preview DTO — same scan, no new query) |
| C8 | **Customer portfolio** (dominant table: customer · health · concern · data state · latest observation) | future | "Which customers are affected?" | dominant table + LeftPanel subject | **blocked**: no `SyncIssue.userId`, no item→user route, open identity policy; customer health = no authority | **BACKEND PREREQUISITE** (Tier 3; the prototype documents the target shape and its masking rules) |
| C9 | **Customer × impacted capability matrix** | future | — | matrix | needs C8's prerequisites plus capability mapping | **BACKEND PREREQUISITE** |
| C10 | **Customer-visible connection staleness (CS-scoped)** | Overview | "Which institutions have stale data right now?" | status list at institution grain, CS-gated, no owner identity | needs a CS-gated narrow projection over connection health, respecting the identity boundary (cannot reuse the PLATFORM_OPS route) | **READY WITH NARROW PROJECTION** (policy-reviewed) |
| C11 | **Support-resolution funnel / outreach tracking** | — | — | — | no ticket/outreach model | **REJECT** |

### 5.5 Candidate counts (the opportunity map)

By readiness: READY NOW **7** (P1, P2, P8, S3*, G2, C1, C2 — *S3's pulse-split portion excepted) · READY WITH PRESENTATION WORK **13** (P3–P7, P16, P18, S1, S2, G1, G3, G4, G7, C7 → 14 counting G3 once) · READY WITH NARROW PROJECTION **12** (P9, P12, P13, S4, S5, S7, G5, G6, C3, C4, C5, C6, C10) · BACKEND PREREQUISITE **6** (P15, S6, G10, C8, C9, + P17's cadence authority) · DESIGN EXPLORATION **1** (S10) · REJECT **9** (P10, P11, P14, S8, S9, G8, G9, G11, C11).

By family: posture surfaces 4 · time series 6 (2 ready, 4 projection-gated) · distribution/composition 8 · dense tables 6 · timelines/activity 4 · funnels 2 (both existing; all new funnel proposals rejected) · heatmaps/matrices 0 accepted (3 rejected/blocked) · comparisons 2 · relationship views 1 (list-form only).

---

## 6. Platform Operations concepts

**Primary operator job:** run Fourth Meridian with the same epistemic standards it applies to users' money ("Fourth Meridian operating Fourth Meridian").

Workspace-by-workspace (conceptual recommendations; no production renames proposed):

- **Overview** — keep the three-movement composition (Scheduler → Jobs → Platform Health) + doorways. Add: the **unknown-vs-healthy split** (P7) as a fourth Platform Health group or a group extension — the one posture question the surface doesn't yet answer explicitly. What belongs in Overview: verdicts and doorways only; no dense tables.
- **Scheduler** (section, composed in Overview/Jobs) — complete as shipped: Observed | Expected | Notes is the epistemic layout other Spaces should copy. No changes proposed.
- **Jobs** — the dominant table is canonical. Concept: light the **run-series drill** (P9) inside `JobDetailPanel` once a per-job run page exists — the panel's Runtime/Recent-executions sections currently render absence sentences while both charts sit built and orphaned. The Policy column keeps stating absence until a job-policy authority exists (PM-5 scope, not this investigation's).
- **Refresh** — the deepest underexploited ledger. Concepts: **Execution Browser** (P1 — filters, keyset paging, timeline drill; the seam was built for exactly this and no UI uses it), **Failure Composition** (P2 — a shipped route with no widget), composition strips (P4), endpoint pipeline table (P5). This workspace can become the reference implementation of "Browser" in Preview → Browser → Detail.
- **Providers** — provider operation ledger (P6) upgraded with attempt distributions and the `paginationConfounded` flag rendered as text; email delivery split (P18) with the auth-email hole stated as a data-confidence callout. Provider trust stays point-in-time (P15 blocked).
- **Operations** — manual operations stays the only WRITE surface. Add the **admission/control-plane read surface** (P12) here: declared-axis, quiet, provenance `PlatformSetting`; today an active maintenance hold is invisible to the operator UI even though producers obey it.
- **Alerts** — as shipped (rules + last-10-runs history with depth honesty). No new visualization earns its place until an alert lifecycle exists (explicitly absent).
- **History** — the **period comparison header** (P3) is the workspace's missing half: the route computes `compareStates` no one renders. Convergence episode polish (P16).
- **AI / Costs** — render the daily series (P8); spend stays "unknown, not zero" until `UNIT_PRICES_USD` is populated.
- **Freshness** (evaluated as a possible workspace) — REJECT as a workspace: two registered resources; the question is answered by Platform Health's freshness group and the Providers section. A workspace needs a distinct question and action; this one has neither yet.
- **Incidents** (evaluated) — incidents are customer-impact-shaped and live in Customer Success; Platform Ops sees their operational shadow through convergence. Recommend against a Platform Ops incidents workspace to avoid a second incident surface with drifting semantics.

Default filters: Refresh browser defaults to `status=FAILED,PARTIAL` cleared by one tap ("All"); Jobs defaults to All with the attention filter one tap away (as shipped). Mobile hierarchy: Overview stacks verdict groups first, doorways last; browsers collapse per the Jobs column-reappearance pattern.

---

## 7. Security Operations concepts

**Primary operator job:** notice abnormal auth behavior, verify control posture, and account for operator actions — with zero remediation capability, honestly disclosed.

**Recommended dominant visual model (grounded only in shipped authorities):** Security has no findings model, so it cannot have a findings-dominant surface yet. The honest dominant object is **the activity record itself**. Adopt the PM-2 composition:

1. **Posture** (contextual, Scheduler grammar): Detections (anomaly trips ·24h, failed-login pulse **split by population** — credential-guess reasons vs blocked-but-correct-password), Coverage (TOTP enrolment with deactivated-excluded denominator, forced resets, recovery-code coverage, active sessions + distinct accounts), Notes (absence statements: no security score, no threat feed, no remediation, no investigation state; provenance chips `AuditLog` · `UserSession` · `User`).
2. **Security activity** (dominant): one `SectionSurface`, three groups — End-user auth · Operator actions · Sessions — each with its provenance chip and fixed-depth honesty ("last 15 events" stated, not implied).
3. **Anomalies** (supporting): trips with `key`, `count/threshold`, window; empty state carries the "no detector fired ≠ nothing wrong" caveat the prototype specifies and production omits.

The prototype's findings table, investigation panel, and state chips are the *target* shape once a `SecurityFinding` clustering authority and an investigation-state authority (mutable row + decision log, the OPS-2C shape) exist — Tier 3, explicitly not mocked as if real.

Interaction: read-only throughout; any future row-drill panels carry Close-only footers (the prototype's rule: a control that does not exist gets no button). Authorization: everything behind `SECURITY_OPS/READ`; no fresh-auth surfaces needed until a WRITE exists.

---

## 8. Growth & Revenue concepts

**Primary operator job:** run the beta gate (a real WRITE surface today) and read entry/activation honestly.

Coordinate with GROWTH-1; its semantics are load-bearing and frozen for this investigation: two funnels with separate populations (never chained); activation = ≥1 UserSession (not first-connection); three-state rates (`undefined` renders nothing, `null` renders —, `0` renders 0%); no verdict vocabulary or status colour anywhere on growth surfaces (guard-enforced); every fact on the surface (no hover-only).

Composition concept (PM-3 shape):

1. **Window & coverage** (contextual): Observed (accounts, verified, signed-in; access requests with status splits) | **Unobserved** (Revenue · Cohort retention · Acquisition source via `Unavailable`, same weight as Observed — "a zero would be a claim") | Notes (provenance `BetaAccessRequest` · `User` · `UserSession`, `checkedAt` read line).
2. **Funnels** (dominant): as shipped.
3. **Growth context** (supporting): approval queue age (G4), activation gap (G3), invitation lifecycle strip (G7).

The beta-requests write surface stays its own operational card/flow — it is queue management, not visualization, and already has panels, confirms, and audit writes.

Trend work (G5 signups/day, G6 activity trend) is deliberately **narrow-projection-gated**: the counts are derivable from persisted event time, but "growth history" was named absent in the migration doc, so the projection must be minted as a real authority (window semantics, UTC bucketing, missing-day handling) rather than an inline route query — the `/signups` route computing inline is already the least-guarded read in the area; don't compound it.

---

## 9. Customer Success concepts

**Primary operator job:** know what customer-visible harm is open, how deep, and what recovered — at the subject grain the identity policy currently allows (institution · account · connection, never a person).

Composition concept (PM-4-compatible, incident-shaped until C8's prerequisites land):

1. **Impact header** (contextual): C1 — severity distribution + "N active incidents · 2 critical · 1 error" + floor language when truncated.
2. **Incident preview → Browser** (dominant): the shipped preview now; the Browser (C3) when its route lands, reusing preview wording (`incidentLabel`, `OPERATION_PHRASE`, recovery text) — never re-deriving. Filters: severity, domain, state; default = active, severity-ranked (the canonical `sortIncidentsForOperator` order — the UI must not re-sort).
3. **Recovery ledger** (supporting): C6 — what healed automatically, with `resolvingExecutionId` shown only when a real execution proved it.
4. **Detail** (drill): C4/C5 — occurrence timeline (correlation absence stated as "correlation unavailable", never "nothing ran") + recurrence chain as a linked-entities list.

Boundary rules binding all CS mockups: `SyncIssue.detail` is structurally unreachable and stays so; subjects render institution·account labels or "Affected account unavailable" at full weight; ids never render; wallets currently have no subject-resolution path (renders unavailable — acceptable, stated); operator emails (present on the PLATFORM_OPS diagnostics surface as a documented deviation) must not appear in CS; occurrence counts are never phrased as incident counts or failed-attempt counts (`occurrenceText` is the authority).

---

## 10. Shared visualization grammar

Verdicts: **SHARED PRIMITIVE** (SP) · **SHARED COMPOSITION PATTERN** (SCP) · **SPACE-SPECIFIC** (SS) · **NOT JUSTIFIED** (NJ).

| Pattern | Verdict | Rationale / action |
|---|---|---|
| Posture header (hero + contextual epistemic surface) | SCP | `PlatformAreaHero` + Observed\|Expected/Unobserved\|Notes. Three Spaces need it (Ops has it; Security S1; Growth G1). A pattern, not a component — column titles are epistemic claims that differ per Space. |
| Provenance chip | SP (exists) | Already shared; extend usage to Security/Growth surfaces as they migrate to page grain. |
| Unknown-state treatment (`Unavailable` + `NO_AUTHORITY` + full-weight rendering) | SP (exists) | The house signature. Every new surface uses it; no new unknown idioms. |
| Dominant table (COLS grid + TwoLine cells + row expansion + toolbar + row→panel) | SCP | Jobs is the reference. Refresh browser (P1), incident browser (C3), and the future findings/portfolio tables reuse the shape. Do NOT extract a generic `<DataTable>` — the pattern's value is its discipline (stable row identity, columns that collapse into expansions), not shared code. |
| Compact status distribution (`DistributionBar`) | **SP — promote (new)** | The one genuinely missing primitive with multi-domain evidence: refresh byStatus (P4), incident severityCounts (C1), connection-health counts, freshness counts, email delivery split (P18), invitation lifecycle (G7). Contract: labelled segments (word+count always visible), tone only where a status vocabulary owns colour, never percentages without totals, floor-aware caption slot. |
| Ranked issue list | SCP | severity/attention-ranked lists with canonical sort authorities (incidents, unhealthy connections, anomaly trips). The sort is the authority's; the UI never re-sorts. |
| Activity timeline | SCP | Convergence timeline + security activity + execution timeline share a grammar (banded events, tone dots aria-hidden, absence sentences), not a component — event vocabularies differ. Revisit promotion after PM-2 ships a second implementation. |
| Contextual right panel (widget-owned, always-mounted, keyed remount for per-object fetch) | SCP (exists) | Codified; no `PanelHost`. |
| Workspace doorway | SP (exists, needs export) | `WorkspaceDoorway` is module-private; export it from the dashboard module (or a sibling) when Security/Growth decompose. Both doorway variants keep the render-nothing-when-unwired rule. |
| Period/comparison header | SCP — new | as-of · compare-to · window, mirroring Financial time. First consumer History (P3); Costs second. Not universal: point-in-time surfaces must not grow a compareTo they can't honor (§11). |
| Filter bar (pills + search + inert-with-reason controls) | SCP (exists via Jobs Toolbar) | Reuse shape; counts on pills; absent capabilities render inert with the reason in `aria-label`, never hidden. |
| Scope indicator (platform-wide vs item-scoped reads) | SCP — new, small | Refresh routes accept `plaidItemId` scoping; when a browser exposes it, the active scope must be stated on the surface ("Scoped to <institution>"), because a scoped floor looks identical to a platform-wide floor otherwise. |
| Data-confidence callout | SCP — new | The formalization of footnote honesty: tier/determinism (`ProjectionEnvelope`), truncation floors, known coverage holes (auth emails, rate-limited invisibility). One visual shape, per-surface copy. |
| `HealthDot` | SP — consolidate | Four hand-rolled implementations. Promote one dot (aria-hidden, tone-token prop) only as the partner of a word (`StatusBadge` generalization below). |
| `StatusBadge` tone generalization | SP — widen carefully | Currently jobs-shaped. Generalize the tone union to the closed set of status vocabularies (job health, provider trust, freshness, connection health, incident severity) WITHOUT merging the vocabularies themselves — the words stay domain-owned; only dot+word rendering is shared. |
| `Meter` / progress bar | NJ | Two consumers with different semantics (availability %, funnel fraction), both fine hand-rolled; a shared Meter invites targets where no target authority exists (S4). |
| `StatusList` (generic) | NJ | Every list so far needs domain wording; a generic list primitive would just be `<ul>` with opinions. |
| `Stat` (another one) | NJ | Three stat forms already exist with distinct grains (`WidgetStat`, `BigStat`, `Figure`); a fourth is drift. |
| `MiniBars` (day-bucket series) | SP — promote *when P8 and one more series ship* | One consumer today isn't evidence; G5/G6/S5 would make three. Build for P8, promote at the second consumer (the `GroupHeading` rule: one consumer, stay local). |
| WidgetMessage live-region upgrade | SP fix | Add `role="status"`/`role="alert"` to the shared three-state line so ~29 widgets stop being silent to screen readers. |

---

## 11. Chart-selection doctrine (Fourth Meridian-specific)

**Use a line/series chart when** the points are persisted event-time observations (ledger timestamps or dated buckets), there are ≥ 5 observed points (`RUNTIME_TREND_MIN_POINTS` is house law — below it, refuse and say why), the interval is declared (UTC day buckets for `ApiUsageCounter`; run-grain for JobRun), and missing periods can render as gaps. Never chart an as-of *reconstruction* in the same visual voice as observed points — tier every series (`observed`/`derived`/`estimated`) and let the caption say which.

**Use a distribution bar when** the composition is over a closed status vocabulary with a knowable total in the window, every segment renders word+count (never colour-only, never percent-only), and the total is a true total — if the underlying scan is a floor (`scanTruncated`), the bar's caption carries floor language or the bar isn't drawn.

**Use a ranked table when** rows are stable entities (enum- or id-backed: jobs, endpoints, provider operations, incidents, connections), cardinality is roughly ≤ 50 in view with honest paging beyond, a canonical sort authority exists (severity rank, attention order, keyset recency) — and the UI never re-sorts what an authority ordered.

**Use a timeline when** entries are persisted events or canonically derived transitions with real timestamps (execution timelines, convergence events, audit rows). Inferred events never render as facts; an incomplete timeline says it is incomplete ("still running — this timeline is incomplete"); correlation absence renders as "correlation unavailable," never as "nothing happened."

**Use a funnel only when** stages share one population and a defensible progression, stage semantics come from a named authority (today: the two GROWTH-1 funnels, full stop), unmeasured stages render nothing (not 0%), and rates follow the three-state contract. A sequence of counts from different populations is a list, not a funnel.

**Use a heatmap/matrix only when** both dimensions are stable and bounded, cell density is real (dozens of observations per cell, not ~10/day fleet-wide), and a cell's emptiness is distinguishable from "not observed." Nothing in the platform currently qualifies; every heatmap proposal in §5 was rejected or blocked.

**Do not use a chart when:** the population is ~a dozen entities (eleven jobs — the row IS the visualization); the number is a floor pretending to be a total; unknown dominates the window (an "unknown" segment bigger than the data is a caption, not a chart); the metric mixes two time authorities (event time and observation time never share an axis — `JobRun.startedAt` is both by construction and says so); the value exists to justify the chart rather than answer a question; or the chart would imply causality an authority didn't compute (convergence narratives carry their own trust tier; nothing else may draw an arrow between cause and effect).

**A number stays a stat or table cell when** it is a point-in-time count with no stored history (all of Growth today), a single-entity property, or a config fact. Charting a snapshot fabricates a trend axis.

**Floors versus totals:** every count on a platform surface is one or the other, and the census (§3.4, and the truncation table in the Platform Ops authority census) says which. A floor never feeds a percentage. `activeTotal` + `moreCount` + `truncated` is the reference pattern.

**High-cardinality labels** (free-text `errorSummary`, institution names at scale): never become chart axes; they live in tables and detail panels. The failures projection deliberately refuses to group free text — the UI must not undo that upstream refusal with client-side grouping.

**Stale observations:** `checkedAt` renders wherever data could be mistaken for live; `timeAgo` for row recency; a last-seen timestamp is labelled "last recorded …" — never "fresh" (freshness is a verdict owned by the freshness authority alone).

---

## 12. Tables and browser patterns

The canonical dense table is `OpsJobHealthWidget`'s: one shared COLS grid for header and rows; ~56px two-line rows; hairline separators only; full-row hover; row click = inline expansion (mobile parity: dropped columns reappear there); `⋯` menu reserved for commands (issues, never merely navigates — inert with reason when no command authority exists); toolbar = filter pills with counts + search + fleet-scope actions; four fetch states provable via a presentational split (`JobsSurface`).

Applying it:

| Table | Row entity (stable?) | Columns | Sort | Filters | Pagination | Detail |
|---|---|---|---|---|---|---|
| Refresh executions (P1) | `RefreshExecution.runId` ✓ | started · trigger/profile · status · duration · endpoints touched · error? | keyset `(startedAt DESC, id DESC)` — the seam's order, no COUNT ever shown | status, trigger, since/until | "Load older" cursor; never a page count (deliberately unknowable) | `ExecutionTimelinePanel` (exists) |
| Incidents (C3) | `SyncIssue.id` episode ✓ | subject · severity(word+tone) · operation phrase · state · first/last occurred · depth | `sortIncidentsForOperator` verbatim | severity, domain, state | floor-aware ("N of ≥M") | C4 panel when routed |
| Provider operations (P6) | (provider, operation) ✓ | calls · succeeded/failed/rate-limited · durations · max attempt · confounded flag | failures desc | provider | none needed (small) | row expansion |
| Endpoint pipeline (P5) | `RefreshEndpoint` enum ✓ | attempted/succeeded/failed/skipped · skip reasons · freshness advanced · records changed (null ≠ 0) | fixed pipeline order | window | none | row expansion |
| Security activity (S2) | AuditLog id ✓ (but see caveat) | when · actor · action label · target | recency | group tabs (auth/operator/sessions) | fixed depth, stated | none until a detail authority exists |
| Users (existing growth) | User id ✓ | as shipped | as shipped | search | limit 100 stated | existing |

Tables NOT to build: anything whose row entity is semantically unstable — "anomaly" rows are trip *records* keyed by dedupe key with suppress-while-open semantics (a list, fine; a browsable table implying an entity lifecycle, no); alert "rows" are delivered records inside job summaries with 10-run depth (a history list, not a browser); rate-limit buckets are 1-hour aggregates with PII subjects deliberately dropped.

---

## 13. Timeline and relationship patterns

**Timelines that render facts:** execution timeline (persisted stage/call/coverage entries; complete flag honest) · convergence events/episodes (canonically derived, trust-tiered, semantic-first correlation) · security/audit feeds (persisted rows) · incident occurrence history (persisted `observedAt`; needs C4's route). **Derived transitions that may render as facts:** connection "broken since" (joined from persisted status-change audit rows — a truncation floor, caption it). **Inferred events that must not render:** scheduler ticks; "recovery in progress" (deliberately unmodeled); any causal arrow not carried by a convergence narrative's own trust field.

**Relationships the architecture can truthfully draw** (always as linked-entity lists/panels — every decorative node graph was rejected): incident → occurrences → refresh execution (`refreshExecutionId`, absence = "correlation unavailable") · incident → previous episode chain (C5) · refresh execution → parent job run (`parentJobRunId`) · provider call → execution → endpoint · manual operation → audit row → job run (operator action provenance) · connection → institution/accounts (subject labels). The item→user edge exists in the schema but is policy-gated and unbuilt (C8). Convergence episodes are themselves the "compact network" — participants + events + narrative — and are the ceiling of relationship rendering until new authorities exist.

---

## 14. Production honesty risks (audit results)

Failure-mode sweep over every accepted candidate, plus defects found in shipped surfaces:

1. **Missing data looking healthy** — guarded by house primitives, but two shipped gaps: `SecAnomaliesWidget` empty state says "No anomalies detected." with no "detector coverage is four rules" caveat (fix in S3); freshness-from-connections reports `fresh` with `asOf: null` (documented approximation; render the null as "time unknown", never a timestamp).
2. **Truncated results looking complete** — floors are well-marked in DTOs (`scanTruncated`, `moreCount`, caps); the audit feed renders 8 of 15 fetched with no "more exist" line; operator actions renders 20 with no depth statement. All S1/S2 mockups must state depth.
3. **Occurrence counts looking like incident counts** — `occurrenceText` is the authority; C3/C6/C7 must reuse it. P13 (occurrence series) carries the highest risk here and is deprioritized to Tier 3 for exactly this reason.
4. **Snapshots looking historical** — all Growth counts are point-in-time; G1's `checkedAt` read-line is mandatory; G5/G6 must be real projections before any trend renders.
5. **Last-seen looking like freshness** — `lastSyncedAt == null` → STALE (a deliberate authority choice); session `lastActiveAt` is 30s-granular and cache-miss-gated — S2 renders it as "last recorded activity", never "active now".
6. **Absence of errors looking like proven health** — provider trust's UNKNOWN-before-soft-verdicts precedence and the false-green flags are the model; P7 exists to surface them, not smooth them.
7. **Customer label fallback exposing identifiers** — canonical: null subject → "Affected account unavailable", never an id; CS mockups inherit; C10 must be designed against the identity policy, and the diagnostics owner-email deviation stays quarantined in PLATFORM_OPS.
8. **Severity colour without text** — guarded (`StatusWord` signature, severity word-first, coral-saturation doctrine, `--coral-600` ban). All new distributions inherit word+count segments.
9. **Charts implying causality** — convergence narratives only, trust-tiered; P3 comparisons render deltas without arrows of blame; S5 renders volume with its caveats, not "attack detected."
10. **Aggregation hiding distinct problems** — the provider-unhealthy alert is one aggregate signal by design (documented); P2's composition must keep endpoint and provider-call groupings separate rather than one "failures" number; P4's byStatus strip keeps PARTIAL distinct from FAILED (`RUNNING is not a failure`).
11. **Population mismatches** (found shipped): the anomalies pulse counts all `LOGIN_FAILED` while the detector counts `CREDENTIAL_GUESS_REASONS` only — S3 splits or relabels it; MFA % denominator includes deactivated users — S4; rate-limited login attempts write no audit rows, so the exact traffic a brute-force pulse should count is invisible — stated as a data-confidence callout, not fixable by presentation.
12. **Vocabulary drift as an honesty hazard**: `AuditLog.action` is a free string; the security feed's filter misses real actions (password reset) and lists phantom ones. Any new audit-derived surface must state its filter's action list or consume a fixed classification authority — and the password-reset filter fix is a one-line backend prerequisite worth doing before S2 mocks ship.

Candidates rejected or modified by this audit: P13 deprioritized (risk 3) · P10/P11 rejected (fabrication) · S8 rejected (privacy boundary) · S10 demoted to design exploration (would go stale silently) · G5/G6 gated on real projections (risk 4) · C7 required to carry floor language (risk 2) · S3/S4 reshaped to fix shipped defects (risk 11).

---

## 15. Mockup shortlist

### Tier 1 — mock up next (8 surfaces)

Chosen for operator value × existing authority × visual opportunity × low semantic risk × cross-Space reuse. Briefs in §15.1.

1. **Security Posture + Consolidated Activity** (S1+S2, one screen) — SECURITY_OPS · Overview
2. **Growth Window & Coverage** (G1, with G4 queue-age line) — GROWTH_REVENUE · Overview
3. **CS Impact Composition header** (C1, atop the existing preview, + C7 domain strip) — CUSTOMER_SUCCESS · Overview
4. **Refresh Execution Browser** (P1) — PLATFORM_OPS · Refresh
5. **Failure Composition surface** (P2) — PLATFORM_OPS · Refresh
6. **Period Comparison header for History** (P3) — PLATFORM_OPS · History
7. **AI Usage Daily Trend** (P8) — PLATFORM_OPS · AI/Costs
8. **Unknown-vs-Healthy split** (P7) — PLATFORM_OPS · Overview
   (+ S3's render-the-key fix and G3's two READY-NOW gap stats ride along inside briefs 1 and 2.)

### Tier 2 — mock after narrow backend work

| Concept | The narrow work |
|---|---|
| Per-job run series in JobDetailPanel (P9) | bounded per-job `JobRun` page route (~last 20); charts already built |
| Incident Browser + Detail + recurrence + recovery ledger (C3–C6) | routes over existing projections (`getActiveIncidentPage`, `getHistoricalIncidents`, `getIncidentDetail`), sequenced per OPS-2D-5 (preview observed first) |
| Admission/control-plane read surface (P12) | one read route over `readControlPlaneFacts` |
| Anomaly pulse population split + MFA denominator fix (S3b, S4) | two route amendments |
| Emergency-controls status (S7) | env-fact read exposure |
| Signups/day + activity trend (G5, G6) | minted growth-history projections (UTC day buckets, gap semantics) |
| Security event volume trend (S5) | daily-count projection over the security action classification + filter vocabulary fix |
| CS-scoped institution staleness (C10) | CS-gated connection-health projection + identity-policy review |

### Tier 3 — future exploration

Security findings cluster + investigation state (needs `SecurityFinding`-equivalent derivation rule + mutable state authority w/ decision log) · Customer portfolio + customer×capability matrix (needs `SyncIssue→user` join + operator-identity policy) · cohort retention (needs cohort semantics) · revenue surfaces (needs billing, v3.0) · provider trust history (needs connection-state history) · job policy/control axis + maintenance mode UI (PM-5 + control authorities; CONTROL level currently unmintable) · occurrence-pressure series (P13) · MERCHANT_OPERATIONS space (out of scope until its authorities exist).

### 15.1 Tier 1 mockup briefs

**Brief 1 — Security Posture + Consolidated Activity** (SECURITY_OPS · `platform-overview`)
Operator question: "Are auth controls holding, what fired, and what have operators done?"
Form: page-grain recomposition — `SectionSurface` "Security posture" (three columns: Detections | Coverage | Notes, Scheduler grammar, `VRule` separators) above `SectionSurface` "Security activity" (three groups: End-user auth · Operator actions · Sessions) with an Anomalies group rendering trip rows.
Data (all shipped routes): `/anomalies` (trips w/ `key`, `count×threshold`, window; pulse relabelled "login failures · all reasons · 15m" until the split lands), `/auth-posture` (TOTP %, forced resets, recovery coverage — derivation lines under each `BigStat`), `/audit` (15-action filter, depth stated), `/operator-actions` (17-verb labels, operator → target), `/sessions` (browser · device · last recorded activity).
Interaction: read-only; no row drills (no detail authority); doorways none (single workspace).
Desktop: two stacked surfaces, posture 3-col. Mobile: columns stack Observed-first; groups accordion never hide counts.
Truth/unknown: Notes column carries the absence block (no score, no threat feed, no remediation, no investigation state — `Provenance "no authority"`); empty anomaly state carries the coverage caveat; every feed states its depth.
Authority: five SECURITY_OPS routes, `requirePlatformAccess("SECURITY_OPS","READ")`.

**Brief 2 — Growth Window & Coverage** (GROWTH_REVENUE · `platform-overview`)
Operator question: "What does growth observe right now — and what does it not observe at all?"
Form: `SectionSurface`, three columns: Observed (`BigStat` accounts w/ "verified · signed in" qualifier + derivation "User + UserSession, counted now"; access requests w/ status splits; oldest-pending age from `/requests` FIFO rows; activation-gap stats: approved-unredeemed, redeemed-never-signed-in = `redeemed − redeemedActivated`) | Unobserved (Revenue · Cohort retention · Acquisition source, each `Unavailable(reason)`, full weight, closing line "none of these render as 0, 0%, or 'Other'") | Notes (`Provenance` chips `BetaAccessRequest`/`User`/`UserSession`, "Read <checkedAt>").
Sits above the shipped funnels; alters no GROWTH-1 semantics.
Interaction: none (the write surface stays in the beta-requests card).
Desktop 3-col / mobile stacked. Truth: three-state rate contract untouched; no verdict colour anywhere (guard).
Authority: `/growth`, `/requests`, `/signups`, `/beta-status` — GROWTH_REVENUE/READ.

**Brief 3 — CS Impact Composition header** (CUSTOMER_SUCCESS · `platform-overview`)
Operator question: "How bad is it right now, in one honest line?"
Form: compact severity distribution bar (segments = word+count: critical/error/warning/info, tones from `SEVERITY_TOKEN`) + summary sentence (`summaryText`) + optional domain strip (C7, requires the small DTO extension) + floor caption when `truncated`. Rendered above the existing `IncidentPreview` in the same card/surface.
Data: `IncidentPreview.severityCounts` (full active set), `activeTotal`, `moreCount`, `truncated` — all in the shipped DTO.
Interaction: none until C3's browser lands (then the bar's segments become filters — noted for the future, not mocked as live).
Desktop: single row above preview; mobile: bar wraps to two lines, words never dropped.
Truth: counts are over a 200-row scan — floor language mandatory; empty state defers to the preview's canonical wording.
Authority: `/customer-success/sync-issues` — CUSTOMER_SUCCESS/READ.

**Brief 4 — Refresh Execution Browser** (PLATFORM_OPS · `platform-refresh`)
Operator question: "Which refresh executions ran, which failed, and what exactly happened inside one?"
Form: dominant table (Jobs grammar): started · trigger/profile (TwoLine) · status (word+tone) · duration · error presence (`hasError`, free text only in the drill) — toolbar: status pills (All / Failed+Partial / Running), trigger filter, since/until; "Load older" keyset cursor; **no total count ever** (the seam refuses COUNT — the UI must not fake one).
Drill: existing `ExecutionTimelinePanel` (keyed remount).
Data: `/refresh/executions` (`ExecutionPageDTO`: rows, nextCursor, audience operator) + `/refresh/executions/[id]/timeline`.
Desktop: full-width table in the Refresh workspace, below summary. Mobile: rows collapse to identity+status+time; dropped columns reappear in expansion.
Truth: `RUNNING` rows render "still running"; timeline incompleteness stated; scope indicator if `plaidItemId` scoping is exposed ("Scoped to <institution>" — else "Platform-wide").
Authority: execution query seam — PLATFORM_OPS/READ; `errorSummary` operator-visible per audience rules.

**Brief 5 — Failure Composition** (PLATFORM_OPS · `platform-refresh`)
Operator question: "What is failing — at execution, endpoint, or provider-call level — and with which provider errors?"
Form: three grouped compositions in one `SectionSurface`: executions by non-success status (FAILED vs PARTIAL kept distinct) · endpoint failures ranked · provider-call failures grouped by (provider, operation, status, errorCode, errorCategory) as a ranked table. Free-text `errorSummary` never grouped (upstream refusal honored).
Data: `/refresh/failures` (`FailureSummary` — shipped route, currently zero consumers) with its `ProjectionEnvelope` (window, deterministic flag, `indeterminacyReason` rendered when false).
Interaction: rows doorway conceptually to the Execution Browser filtered view (Brief 4).
Desktop: distribution strips + table; mobile: stacked. Truth: `tier` rendered; zero-failure state = "No non-success executions in this window" (window stated), never "healthy".
Authority: refresh projections — PLATFORM_OPS/READ.

**Brief 6 — Period Comparison header for History** (PLATFORM_OPS · `platform-trends`)
Operator question: "What changed since the previous period?"
Form: period header (asOf date control · compareTo control · window line) + paired as-of state rows per source (jobs/operations/alerts/freshness): current verdict vs compare verdict, delta stated in words ("healthy → 2 unhealthy"), tier chips per side. No sparkline of derived states.
Data: `/history?asOf&compareTo` — `states` + `compareStates` (shipped, unrendered).
Interaction: date controls (keyed-remount fetch — the sanctioned escape from the static-URL contract).
Desktop: header + 4 source rows; mobile: stacked pairs. Truth: comparison semantics mirror Financial time; a source degrading to `unknown` renders unknown, never a delta; `checkedAt` on-surface.
Authority: `getOperationalHistory` — PLATFORM_OPS/READ.

**Brief 7 — AI Usage Daily Trend** (PLATFORM_OPS · `platform-ai` / `platform-costs`)
Operator question: "How is AI usage (and estimated cost) trending day over day?"
Form: 30-day mini bar series (calls; token toggle), UTC day buckets, missing days as gaps; totals row; spend line rendered only when `pricingConfigured`, labelled "estimate, not a bill"; models list.
Data: `/ai-usage-trend` (`AiUsageTrend.days[]` — persisted daily buckets; real event-time series).
Interaction: none required (hover/focus reveals day values with text equivalents).
Desktop: series + totals; mobile: same, horizontally scrollable with visible axis. Truth: `tier` estimated-vs-observed rendered; aggregate-only stated ("no per-user attribution exists").
Authority: `getAiUsageTrend` — PLATFORM_OPS/READ.

**Brief 8 — Unknown-vs-Healthy split** (PLATFORM_OPS · `platform-overview`)
Operator question: "Where do we not actually know?"
Form: a Platform Health group (or fourth movement): headline stat "N systems without a verdict" + status list naming each unknown with its reason (provider UNKNOWN "no execution signal, freshness unknown"; freshness trust unknown/blocked "no price vendor configured"; scheduler "verdict refused — ticks unobservable"; admission "no read surface"). Quiet tones — unknown is never coral, never green.
Data: `/provider-health` counts, `/resource-freshness` trust fields, scheduler notes — all shipped; admission line is static absence until P12.
Interaction: `GroupDoorway`s to Providers/Operations.
Desktop: fourth group in the health grid; mobile: stacks last (verdicts first, uncertainty summary after). Truth: this surface renders *absence of verdicts*, so its own empty state ("all sources returned verdicts") must state the source count it checked.
Authority: existing PLATFORM_OPS routes.

---

## 16. Backend prerequisites (consolidated)

Narrow (Tier-2 enablers): per-job `JobRun` page route · incident browser/detail/historical routes (OPS-2D-5D-2, sequencing-gated) · admission-facts read route · anomaly pulse population split · MFA denominator fix · audit filter vocabulary fix (`PASSWORD_RESET_*`) · emergency-control state exposure · growth history projections (signups/day, activity/day) · security event volume projection · CS-scoped connection staleness projection (+ identity-policy review) · seed rows (`ensurePlatformSections`) for every new section key — the R-5 invisible-surface hazard applies to all of the above.

Structural (Tier-3 enablers): `SyncIssue→user` linkage + operator-visible-identity policy · security finding clustering + investigation-state authority (mutable row + decision log) · cohort semantics · billing (v3.0) · connection-state history (provider trust as-of) · job policy/control authorities (PM-5; CONTROL issuability) · per-endpoint cadence authority (coverage staleness) · alert lifecycle entity (ack/resolve) · `UNIT_PRICES_USD` population for real spend estimates.

---

## 17. Rejected concepts

| Concept | Why rejected |
|---|---|
| Single platform posture score | Domains not meaningfully aggregatable; would launder UNKNOWN; scheduler verdict explicitly refused by its authority. |
| Scheduler tick timeline / dispatcher health | Ticks unobservable by design; the refusal is itself the rendered fact. |
| Job failure heatmap (hour×day), execution throughput charts, queue depth, runtime distributions | ~10 runs/day, n≈11 jobs — populations too small; prototype rejected the same family with reasons; a row is the visualization. |
| Rate-limit history trend | 1-hour current-pressure window by design; rows swept; history would need a new store. |
| Provider-vs-provider comparison chart | Two providers with structurally different signals (usage counter coverage differs; FX unmeasured); a table row per provider already carries it. |
| Universal `compareTo` across all surfaces | Only History/Cost own comparison semantics; retrofitting it elsewhere invents time authorities. |
| Security session browser w/ revoke (in SECURITY_OPS) | Deliberate PII boundary (no userId/IP on this surface); revocation is a SYSTEM_ADMIN capability elsewhere; needs a policy decision, not a mockup. |
| Role × privileged-action matrix | Tiny cardinality; a grouped feed answers it. |
| Security risk scoring / threat feed / geo anomaly maps | No severity, no geo, no baselining exists; would fabricate a detection capability. |
| Acquisition-source breakdown, revenue/MRR anything, forecast vs realized, segment trends, cohort curves (as mockups now) | Authorities absent and absence is guard-enforced; "drawing them greyed-out would still imply they are coming." |
| Funnel chaining beta→activation into one funnel | Different populations; explicitly "siblings, not stages" semantics. |
| Customer health score / portfolio (now) | No health authority; identity join + policy missing; prototype itself marks it PLANNED. |
| Outreach/ticket/owner/NPS surfaces | No models; named-absent doctrine: not even greyed out. |
| Endpoint × freshness heatmap, account staleness matrix | Coverage authority refuses a staleness verdict (no cadence authority). |
| Decorative relationship/node graphs | No operator action supported; linked-entity lists and convergence episodes already carry the truthful relationships. |
| Occurrence-pressure series as a near-term mock | Highest occurrence≠incident misread risk; deferred to Tier 3 with wording guardrails. |

---

## 18. Recommended mockup sequence

Rationale: ship the cross-Space grammar first (posture + epistemic columns) where authorities are fully ready and the visual delta is largest; then the two widget-less-data Platform Ops surfaces; then comparison/time work; Tier 2 follows its backend enablers.

1. **Security Posture + Consolidated Activity** (Brief 1) — biggest visual gap, five ready routes, establishes the page-grain migration pattern for a second Space; includes the S3 anomaly-key fix.
2. **Growth Window & Coverage** (Brief 2) — same grammar, second proof; the Unobserved column becomes the house pattern for named absence.
3. **CS Impact Composition header** (Brief 3) — smallest brief; debuts `DistributionBar` with shipped data.
4. **Refresh Execution Browser** (Brief 4) — debuts the Browser pattern on the seam built for it.
5. **Failure Composition** (Brief 5) — pairs with 4; a shipped route gets its first consumer.
6. **Unknown-vs-Healthy split** (Brief 8) — extends Platform Health; leans on 1–3's absence vocabulary.
7. **Period Comparison header** (Brief 6) — introduces the comparison pattern once static surfaces are settled.
8. **AI Usage Daily Trend** (Brief 7) — first real time series; sets the series/tier caption rules G5/G6/S5 will inherit.
9. Then Tier 2 in enabler order: P9 run series (charts pre-built) → C3–C6 incident browser suite (after 5D-2 routes, respecting preview-first sequencing) → P12 admission surface → S4/S5/G5/G6 projection-backed metrics.

Every mockup in 1–8 requires zero schema changes and zero new routes; items 1–3 require only new view-models over shipped DTOs (plus seed rows if any new section keys are introduced rather than recomposed).

---

*End of investigation. No production code was written; no production UI was altered; no mockups were produced. This document is uncommitted.*
