# Platform Intelligence: governed operational and business intelligence

> **Owner:** Session 1 · **Status:** ACTIVE · **Updated:** 2026-11-04 · **PRs:** #255, #257, feat/platform-metric-registry (foundation step 1), docs/active-definitions, feat/metric-retrieval-contracts (Phase 3 slice 1), feat/navigation-registry (foundation step 3)

**Owner directives (2026-11-03).** One extensible, permissioned intelligence system for every Fourth Meridian domain. It answers questions nobody listed in advance, navigates the operator to the right record, and never acts without explicit authorization. The order is fixed: **data model → deterministic intelligence → conversation and navigation.** Incidents are the first domain ([PB1-INCIDENT-LIFECYCLE](PB1-INCIDENT-LIFECYCLE.md)). Every important KPI leads to the records behind it.

## Rules (binding)

- **One truth.** The Platform UI, alerts and the future AI read the same versioned metric definitions and the same permissioned readers. There is no AI-only pipeline, no AI-only route map, and no second alert engine.
- **Permissions are enforced where data is read,** including aggregation and historical search, with existing gates: `requirePlatformAccess(area, level)`. Platform Ops output carries no identities; customer identity appears only for an authorised Customer Success operator.
- **Read-only first.** OBSERVE and NAVIGATE come first. ACT needs separate authorization, confirmation and an audit trail. Nothing runs in the background, and there is no unrestricted SQL.
- **Honest provenance.** Answers separate observed, calculated, inferred, recommended and hypothetical. Every question is classed as one of: measured · calculable · inferable · needs instrumentation · unknowable. No fabricated telemetry. Documentation is never presented as if it were current code.
- **Metric definitions** include: window and timezone, numerator and denominator, inclusion and exclusion rules, freshness, provenance, coverage gaps and the permission boundary. Interactive customer activity is kept separate from background sync. Comparisons use the same definition, or the difference is disclosed.
- **Platform AI is observable,** with its own category in AI & Costs (spend, tokens, latency, failures, per-operator use, budget). Its configuration lives in Policies.

## Inventory of develop (3cbfa34, 2026-11-03)

| Domain | Trustworthy today | Inconsistent | Not measured |
|---|---|---|---|
| Growth | `User` lifecycle dates; beta funnel (`BetaAccessRequest`); allowlisted acquisition source (180 d) | "signup cohort" vs policy `CustomerCohort` | Geography: only a country header that is probably always null |
| Auth and sessions | `UserSession`; login/2FA/password/session audit actions | none | Login method and device class |
| Engagement | 9 server-side `PRODUCT_EVENT_ACTIONS` (interactive by construction, 13 months) | **Several definitions of "active"** (19 inventoried, 10 conflicts: see the "Definitions of active" subsection under Open owner decisions) | Feature use outside Space, Brief and Transactions |
| Onboarding | The PB-7 import-status fold | none | Anything older than 60 days (RefreshExecution retention) |
| Entitlements and billing | Policy groups, assignments, versions | none | **No billing, subscription, payment or revenue data exists** |
| Provider cost | `ProviderCall` (60 d), `ApiUsageCounter` (90 d), versioned rate estimates | none | Real invoices (no reconciliation) |
| AI | `AiInvocation` (90 d) by surface | none | A Platform-AI category (needs only a new `surface` value) |
| Jobs and infrastructure | `JobRun` (90 d), `RefreshExecution` (60 d) with trigger, which separates user actions from background work | none | **Deployment and release history** (a SHA stamp is the only trace) |
| Incidents | `SyncIssue`/occurrences; PB-1 Phase 1 model (#255) | Six competing readers (PB-1 §13, D1–D8) | Searchable history UI (Phase 2B) |
| Security | Login outcomes, 2FA, grant and role changes, anomalies, operator actions. Platform access refusals are recorded as a bounded `SECURITY_ANOMALY_DETECTED` row per user, area and window (`lib/platform/ops/access-denied.ts`), visible in Security Ops Detections | Platform access refusals reuse the generic anomaly action instead of a dedicated `PLATFORM_ACCESS_DENIED` | **Tenant-route authorization refusals (403s on customer APIs) and rate-limit blocks are not recorded.** No in-app dependency or vulnerability findings. Only `BETA_ACCESS_REQUESTED` rows are minimised at 90 days; LOGIN, LOGIN_FAILED and other security audit rows keep raw IP and user agent indefinitely, because audit deletion is excluded by decision. |
| Merchants | `Merchant`, aliases, rules, merge decisions, user category overrides | none | Drilldown records (PB-9) |
| Privacy | Deletion/purge and export jobs and audits | none | Deletion and export service-level readers |
| Docs and code | `docs/architecture`, `systems`, `decisions` | none | No in-app docs or code inspection; `/dashboard/platform/ai` is a placeholder |

**Reusable route and permission infrastructure** for the navigation registry:
- gates: `lib/platform/authorize.ts`;
- workspaces and sections: `lib/platform/workspaces.ts`, `nav.ts`, `directory.ts`, `seed.ts`, `operations/registry.ts`;
- deep links: `lib/space/space-url.ts`.

## Smallest coherent foundation (after PB-1 Phase 2)

1. **A versioned metric-definition registry in code,** following the pattern of `lib/usage/pricing.ts`. Each entry records: id, version, definition, source, reader, area and level, retention cap, and whether identifiers are allowed.
   **Status: LANDED (definitions only, no values).**
   - **Registry:** `lib/platform/intelligence/metrics/registry.ts`. Each `MetricDefinition` carries:
     - `id@version` and domain;
     - window and timezone (UTC);
     - numerator and denominator, each pointing at its code;
     - `compute` (the one function) and `path` (route → reader → function);
     - inclusion and exclusion;
     - freshness source;
     - provenance (MEASURED / ESTIMATED / UNAVAILABLE + reason);
     - coverage gaps;
     - permission entries (area, level, identity tier OPS or CUSTOMER_SUCCESS, guarded route);
     - the tiles that show it, and the drill records route.
   - **Registered:** ten existing authorities, with no new metric and no changed maths: `provider-outcome@1`, `provider-connection@1` (now `@2`, institution concentration; @1 retired), `ai-fleet-spend-status@1` (24 h), `presence-state@1` and `engaged-users@1` (PB-10), `incident-broken-now@1` and `incident-alertable@1` (PB-1), `merchant-identity-linked@1` (PB-9), `cs-needs-help@1` (PB-4) and `growth-registrations@1`.
   - **Accessor:** `lib/platform/intelligence/metrics/access.ts`. `describeMetric(token, id)` and `listMetrics(token, { domain, area })` are permission-filtered by a token minted from the caller's own `requirePlatformAccess` result (the incident audience-token idiom). A forged token is refused; an invisible metric reads like an unknown one; only the caller's own permission entry is returned.
   - **Pins:** `registry.test.ts` checks, per metric:
     - every symbol is exported where named;
     - each route → reader hop calls the next, and the compute function is the one the chain or its tile calls;
     - every tile reads the figure;
     - every permission route guards with exactly its area and level;
     - the drill route exists;
     - code-carried versions and windows agree with the registry.

     It also checks that ids are unique, versions explicit, every metric has a permission and an identity tier, and an UNAVAILABLE provenance carries a reason.
   - **Next:** Phase 3 retrieval contracts, which return values through the same readers. Then the remaining step-2 metrics, which need either a canonical definition (one "active", replacing the four) or a reader that doesn't exist yet.
   - **Phase 3 slice 1 — LANDED** (`feat/metric-retrieval-contracts`; values, no route, no UI, no AI wiring).
     - **Contract:** `retrieveMetric(surface, ctx, id, params)` in `lib/platform/intelligence/metrics/retrieve.ts` (pure core: `retrieve-core.ts`). It resolves the definition through `describeMetric`, then calls only the reader the definition's first `path` hop calls, the same function the tile's route calls. It returns one envelope: `metric` (id@version), `value` (a number, or a small fixed object of numbers; null ⇔ UNAVAILABLE), `status` (MEASURED · ESTIMATED · PARTIAL · UNAVAILABLE, the Economics vocabulary), `reason`, `window`, `freshness`, `coverage`, `basis` (the registry's code refs) and `drill` (a descriptor `{ figure, window, href, page }` to the registry's records route, never rows). The drill is given only on the surface whose area gates that route; elsewhere it is `null` with `drillReason: "no drill on this surface"` (for example, `incident-broken-now` on Customer Success, whose drill is a Platform Ops route). Per-surface drills in the registry are a later follow-up.
     - **Authority:** the caller's route builds `{ metricToken, incidentToken }` from its own guard result (`metricAccessFor` / `incidentAudienceFor`); the contract mints nothing. `surface` is a string literal at every call site (pinned by a source scan). `atSurface(surface, token, metric)` re-tiers downgrade-only, per metric: min(token tier, surface tier, the metric's identity tier for that surface). Break-glass on an Ops surface reads at OPS, and incident readers receive `atOpsTier(token)`. A forged token, an unknown or invisible id, or a metric that isn't served on the surface all return null from one branch, before any I/O.
     - **Aggregates only:** `isAggregate` refuses anything else at runtime. An identity scan (CS tier, and break-glass on an Ops surface) pins that no envelope carries a subject id, a `user #`/`operator #` ref, a cuid or an email. A failing reader gives null and a reason, never 0.
     - **Retrievable (11):** `provider-outcome@1`, `provider-connection@2` (providers by verdict, with `institutionConcentrated` ⊂ degraded), `ai-fleet-spend-status@1` (via `fleetSpendStatus`, the tile function), `engaged-users@1` (1/7/30), `growth-registrations@1` (90/30), `incident-broken-now@1` (Ops and CS), `merchant-identity-linked@1` (linked / live), `cs-needs-help@1`, `open-customers@1`, and, since #361 moved the counts into shared readers (`lib/platform/security/live-sessions.ts`), `live-sessions@1` (the Security Ops fleet count, `{ sessions, distinctUsers }`) and `accounts-with-live-session@1` (Growth).
     - **Fleet vs per-subject:** a permission entry whose route has a `[param]` segment is a per-subject figure (`isFleetEntry`), and retrieval returns null for it on that surface. So `live-sessions@1` is never served on Customer Success: its CS entry is the per-customer detail route. `accounts-with-live-session@1` is served only on Growth. Both rules are pinned.
     - **NOT_RETRIEVABLE (2, reasons in the table):**
       - `presence-state@1`: per subject.
       - `incident-alertable@1`: the search reader pages its items, and the alertable accessor is SYSTEM-only.
     - **Pins:** `retrieve.test.ts` checks registry coverage, reader binding against each registry path, parity with each tile's own function on the same fixtures, authority and tiering, honest absence for each metric, the identity scan, the drill, no mint path, literal surfaces, no writes or caching, and bounded importers.
     - **A future route** is GET with `no-store`, guarded by the metric's own permission entry for the surface. AI and chat callers use this same contract and `atSurface`, with no bypass.
   - **Cost metrics — LANDED** (`feat/platform-ai-cost-metrics`, PR A2; owner test "What's costing me the most money?"). Before this, the only cost metric was `ai-fleet-spend-status@1` (a 24 h budget check), so the Platform AI could not see the Economics figures. Five Economics / AI & Costs figures are now registered and retrievable. None depends on OD-1, and each wraps the reader its tile reads (no parallel query):

     | Metric | Windows | Reader → tile | Status semantics |
     |---|---|---|---|
     | `economics-ai-cost@1` | 30 (default) · 7 · 90 UTC days | `getEconomicsSnapshot` → Overview AI trend card (`s.trend.windows[win]`, `aiCostFigure`) | ESTIMATED; PARTIAL when a day has unpriced calls; UNAVAILABLE with no rate card, no calls or nothing priced |
     | `economics-operating-cost@1` | fixed: the current cycle | `getEconomicsSnapshot` → Overview hero + split tiles | value `{ totalUsd, aiUsd, providersUsd, infrastructureUsd }`; PARTIAL while any component is unmetered (always today: other providers and infrastructure are null, never $0) |
     | `economics-provider-cost@1` | fixed: the current cycle | `getEconomicsSnapshot` → Overview Providers tile (`f.provider_cost`) | ESTIMATED Plaid Item-months; PARTIAL while another provider is unmetered |
     | `ai-call-outcomes@1` | 7 (default) · 30 days | `getAiOperations` → AI & Costs "Calls" / "Error rate" (`aiCallStats`) | MEASURED counts; `errorRatePct` null with no calls (never 0%) |
     | `ai-cost-per-call@1` | 7 (default) · 30 days | `getAiOperations` → AI & Costs "Est. cost / call" (`aiCostPerCall`) | ESTIMATED; PARTIAL with unpriced tokens; UNAVAILABLE with no rate card / no calls / nothing priced |

     - **Permission:** every one is PLATFORM_OPS READ (the guard on `/api/platform/platform-ops/economics` and `/ai-invocations`), identity tier OPS, aggregates only. No new grant and no CS exposure. Drill pages are navigation-registry hrefs (Economics › Overview, Economics › AI & Costs), so the #408 byte-equality rule links them.
     - **Not registered (on purpose):** per-customer and cost-per-customer figures (OD-1 pending), revenue and margin (no billing source), top customers by cost, and entitlement / policy-group costs.
     - **One function per KPI:** the AI & Costs KPIs now call `lib/platform/ai/call-stats.ts` (`aiCallStats`, `aiCostPerCall`), the same functions retrieval projects through. Tile parity tests in `retrieve.test.ts` compare each envelope with its tile on the same fixture world (the real `getEconomicsSnapshot` over synthetic ledger deps; `aiKpis` / `costPerCall` over one `AiOperations` payload).
     - **Envelope additions:** `unit: "usd"` (dollars, a number or an object of dollar parts); `basis.kind` = `"estimated"` (provenance ESTIMATED, every dollar figure, PARTIAL included) or `"measured"`.
     - **Windows are declared:** `MetricWindow.days` in the registry equals the retrieval contract's `windows` (pinned for every retrievable metric), and `list_metrics` shows it as `windows`. Any other window gets an UNAVAILABLE envelope that names the declared ones, or says the window is fixed, before the reader runs.
     - **Tool guidance (prompt only; enforcement stays server-side):** `list_metrics` names domain `economics` for cost questions; the prompt says to call `basis.kind: "estimated"` figures estimated (never billed), and, when a comparison rests on PARTIAL figures or null parts, to say it is the largest of the measured categories and that a full ranking can't be verified.
     - **Provider-outcome faithfulness (owner test "How are we looking today?"):** `provider-outcome@1`'s envelope used to be MEASURED even when no provider had an evaluable verdict, as on Preview where crons don't run, so it read "0 healthy, 0 degraded, 0 failing". The verdict rule is unchanged (no version bump). The envelope-status rule, now written into the registry's coverage gaps: MEASURED only when every provider is evaluable; PARTIAL, with the counts, when some have no runs or not enough data; UNAVAILABLE ("no evaluable job runs in the window (scheduled jobs may not run in this environment)") when none is. `provider-connection@2` follows the same rule for providers with no connection population. The Providers tile's "Providers healthy" KPI now shows "—" with the same reason when no provider is assessed, instead of "0/N" (parity test in `retrieve.test.ts`).
2. **First metrics, each wrapping an existing permissioned reader:**
   - signups and verified users;
   - beta funnel conversion;
   - DAU/WAU/MAU (one canonical "active" definition, replacing the four);
   - new-connection import outcomes;
   - AI spend split by customer vs overhead surface;
   - estimated provider cost;
   - job and refresh health by trigger;
   - login failures by reason.
3. **The navigation registry derived from the existing workspace and section registry plus `space-url`** (typed targets, required permission, deep-link parameters), validated in CI against real routes.
   - **Step 3 — LANDED** (`feat/navigation-registry`; no route, no UI, no AI wiring, no schema change).
     - **Registry:** `lib/platform/intelligence/navigation/registry.ts`. The targets are generated, not written: the two Platform pages (Overview, AI) from `lib/platform/nav.ts`, and every area × workspace × view from `PLATFORM_AREA_WORKSPACES` / `PLATFORM_WORKSPACES`. That gives 31 targets: 2 pages, Platform Ops 15, Security Ops 3, Growth 1, Customer Success 9, Merchant Ops 1. Each target carries:
       - its id and kind;
       - the UI's own label and workspace label;
       - its area and the destination page's own guard (`[area]` page: `requirePlatformAccess(area, "READ")`; Overview and AI: any active grant);
       - its identity tier (CUSTOMER_SUCCESS for every Customer Success destination, OPS otherwise);
       - the deep-link keys it allows;
       - the section keys it composes;
       - the metric ids whose tile renders there.

       Sections are not targets: their labels are DB text and they have no URL of their own. Personal-Space and tenant destinations are out of scope.
     - **Params:** an allowlist per target, in five groups, each owned by its existing URL module. A group's validator is that module's own read → update round trip (`readIncidentsUrl`, `readAiBudgetCallsUrl`, `readEconomicsDrillUrl`, `readMerchantRecordsUrl`, `readAttentionParam`), so the owning parser decides and nothing is re-implemented. A value is accepted only if the parser keeps it byte-for-byte.
     - **Accessor:** `navigation/access.ts`. `listNavigationTargets(surface, token, filter)` and `resolveNavigationTarget(surface, token, id, params)` → `{ href } | null`.
       - **Token:** the caller's existing `MetricAccessToken`. Nothing is minted.
       - **Surface:** a string literal, passed as the first argument (pinned).
       - **Visibility:** a target is visible only when the token's one grant satisfies the page's own guard, and the target's tier is no higher than `tokenTierOnSurface` (the downgrade-only helper `atSurface` now shares). A Customer Success destination is therefore invisible on every other surface.
       - **Break-glass sees nothing**, because every destination refuses it: the `[area]` page redirects when the grant is null, and `proxy.ts` sends a System Admin away from `/dashboard`.
       - **One failure shape:** a forged token, an unknown or invisible id, or any bad param (unknown key, a `workspace`/`view` key, a non-canonical value, `..`, `//`, `\`, `@`, `%`, a scheme, a control character) all give the same `null`.
       - **Output:** a same-origin relative path on the target's fixed pathname, built through `buildSpaceUrl`.
       - **Future AI and chat consumers** get hrefs only from `resolveNavigationTarget` and never compose URLs.
     - **Pins:** `registry.test.ts` checks:
       - sources ⇄ targets in both directions, covering workspaces, views and retired aliases;
       - Platform deep-link params ⇄ groups, with every other `space-url` key declared personal-Space-only;
       - each group's homes are exactly the leads or widgets that read it;
       - labels match the view control, the rail (`platformMountContext`) and the nav;
       - every href resolves to its `app/**/page.tsx` route (a filesystem scan) and equals `platformWorkspaceHref`;
       - guards match each page's source;
       - permission filtering for every area × level × surface, break-glass, forged tokens, and no existence oracle;
       - param injection, plus a fuzzed `new URL(href, origin)` same-origin check;
       - metric links: ids exist, tile homes are real, and every metric drill page resolves through this registry to the same href;
       - no mint path, literal surfaces, and bounded importers.
     - **Metric ↔ target links:** all registered metrics (18 since PR A2) link to at least one target. One tile module (`customer-core.ts`, a server reader) is declared unhomed, with its reason.
     - **Follow-up (`refactor/workspace-href-single-source`):**
       - **One link builder:** `platformWorkspaceHref` now lives in the server-safe `lib/platform/workspace-href.ts`. The client navigation hook re-exports it and the registry calls the same function, pinned by identity rather than an equality test.
       - **One param list:** `econ`/`econuntil` join `SPACE_URL_PARAMS`, and `PLATFORM_WORKSPACE_SCOPED_PARAMS` moves into `space-url.ts`, typed as a subset of it. The hook and the registry's param groups both take their keys from that one list.
       - **Per-surface drills:** a metric's `drill` may be keyed by surface (`{ bySurface }`). `incident-broken-now` drills on PLATFORM_OPS to the Ops incidents route and the Incidents workspace, and on CUSTOMER_SUCCESS to the CS incidents route and the CS "Broken now" view. Its Incidents-lead tile links it to the "Broken now" view on both tiers. `retrieveMetric` keeps its null-drill rule: a drill is given only where the surface's link is gated by that surface.
4. **`AiInvocation.surface = platform_ai`**, counted as overhead.
5. **Minimal new instrumentation, each item needing owner approval:**
   - a deployment-event row;
   - an audit row for tenant-route authorization refusals and rate-limit blocks (area and code only), and promotion of platform refusals to a dedicated `PLATFORM_ACCESS_DENIED` action (a one-line canon change);
   - daily rollups so history outlives the 60/90-day windows.

## Open owner decisions

- Billing and revenue data has no source. Unit economics stay estimate-only until a billing system exists.
- Whether to record country at registration (two-letter code only).
- Minimising identifiers in security audit rows. Session 2 proposes: after 90 days, null the IP and user agent on all auth and security audit rows and keep a keyed digest (the `BETA_INTAKE_HASH_KEY` pattern, with its own versioned key). The rows themselves are kept as security evidence. **OWNER DECISION, engineering half ready (2026-11-04):** inventory, methods (keyed digest or /24·/48 truncation; UA family or null), a dry-run census behind `NETWORK_ID_MINIMISATION_MODE` (default `off`) and the proposed DB-010 policy extension are in `docs/operations/data-retention.md`, "Network identifiers". The owner decides the window, the method and enabling it.

### Definitions of "active" (inventory 2026-11-03)

Read from develop `8083b7b` (code and labels only; no database read). It unblocks foundation step 2 (DAU/WAU/MAU and unit economics). Abbreviations: `pac` = `lib/platform/growth/product-analytics-core.ts`, `pa` = `lib/platform/growth/product-analytics.ts`, `snap` = `lib/platform/economics/snapshot-core.ts`, `defs` = `lib/presence/definitions.ts`.

**Inventory — IMPLEMENTED (as the code stands).** "All users" means every `User` row: operators and deactivated or deletion-scheduled accounts are included. No surface excludes test accounts: no test-account flag exists (`UserRole` is only USER and SYSTEM_ADMIN, `prisma/schema.prisma:250`), and only seeded Plaid Items are excluded, from cost (`lib/platform/plaid/item-months.ts:72`). Pending deletion also sets `deactivatedAt` (`schema.prisma:397-402`), so "not deactivated" excludes it too.

| # | Name in code / UI | Predicate (counts) | Population | Window and constant | Signal | Shown at (label · route · registry key) |
|---|---|---|---|---|---|---|
| A1 | Engaged (DAU/WAU/MAU) | distinct users with ≥1 frozen-predicate fact: `ENGAGEMENT_AUDIT_ACTIONS` ∪ chat/brief `AiInvocation` with a userId (`pac:178`, `pac:210`) | all users with a fact; no role or deactivation filter (`pa:47-62`) | 1 / 7 / 30 **UTC days incl. today**; `PRODUCT_ANALYTICS_WINDOW_DAYS` = 30 (`pac:52`) plus literals 1 and 7 (`pac:505-507`); `ENGAGEMENT_WINDOW_DAYS` (`defs:105`) is read by no code | AuditLog product events, AiInvocation | "Engaged · 30 d" KPI (`components/platform/leads/growth-model.ts:63`); "Engaged" series and "… this week · … in 30 d" (`GrowthLead.tsx:95,103`); "Engaged per UTC day" (`GrowthProductAnalyticsWidget.tsx:185`) · `/api/platform/growth-revenue/product-analytics`, `…/activity` (`active.*`) · `engaged-users@1` (`registry.ts:250`) |
| A2 | "active this week" (`active7`) | `loadEngagedUserIdsSince` (`pa:106`), the A1 predicate | all users | **rolling** 7 × 24 h, literal (`app/api/platform/growth-revenue/signups/route.ts:37,48`) | as A1 | `GrowthSignupsWidget.tsx:42` · `/api/platform/growth-revenue/signups` · none |
| A3 | "Returning (7d)" (`returning7`) | the A1 predicate in the window **and** created before the window start | all users | rolling 7 × 24 h, literal (`lib/platform/growth/growth.ts:204,212`) | as A1 + `User.createdAt` | `growth-funnel-view.ts:176` · `/api/platform/growth-revenue/growth` · none |
| A4 | "Active customers · this cycle" | `loadEngagedUserIdsSince(cycleStart)` (`lib/platform/economics/snapshot.ts:58-63`) | all users | **UTC calendar month to date** (`snap:81`) | as A1 | label `snap:521`; drill "engaged this cycle" (`snap:481`) · `/api/platform/platform-ops/economics` (+ `/drill`) · none |
| A5 | "Cost per active customer" | operating cost this cycle (customer AI + overhead AI + Platform AI + Plaid, `snap:436`) ÷ A4 | as A4 | cycle | AiInvocation, Plaid census | label `snap:533` · economics route · none |
| A6 | "Cost per engaged user · 30 d" (A8) | (customer-surface AI over 30 d + Plaid this cycle) ÷ A1 MAU (`pac:452-485`) | as A1 | 30 UTC days (AI) **mixed with** the cycle (Plaid) | AiInvocation, Plaid census | `product-analytics-view.ts:261` · product-analytics route · none |
| A7 | Present / "Signed in" | `SESSION_ACTIVE_DAY` ∪ the UTC day a session was created (`pac:170`) | all users | 1 / 7 / 30 UTC days (as A1) | AuditLog `SESSION_ACTIVE_DAY`, `UserSession.createdAt` | "Signed in" (`GrowthLead.tsx:95`); "Present per UTC day" (`GrowthProductAnalyticsWidget.tsx:184`) · product-analytics, activity · none |
| A8 | "DAU / WAU / MAU" (sign-ins) | distinct users with an AuditLog `LOGIN` (`lib/platform/activity/activity.ts:97-103`) | all users | **rolling** 1 / 7 / 30 × 24 h, literals (`activity.ts:142-144`) | AuditLog `LOGIN` | **"DAU" "WAU" "MAU"** (`components/platform/widgets/OpsActivityWidget.tsx:33-35`) · `/api/platform/growth-revenue/activity` · none |
| A9 | "sign-ins" stratum | distinct users with `LOGIN` (`pac:187`) | all users | UTC days (as A1) | AuditLog `LOGIN` | `product-analytics-view.ts:117` · product-analytics, activity · none |
| A10 | "Active now" / "Online, idle" / "Offline" / "Unknown" | `derivePresenceState` (`defs:141`): presence beat ≤ 3 min; interaction ≤ 5 min | one customer (CS list and detail) | `PRESENCE_CONFIG` (`defs:99-101`) | `UserSession.lastPresenceAt` / `lastInteractionAt` | `CsCustomersWidget.tsx:100,402` · `/api/platform/customer-success/customers` · `presence-state@1` (`registry.ts:227`) |
| A11 | "Last active" ("active today", "this week" …) | coarse bucket of the newest interaction (`defs:169-180`) | one customer | literals 1 h / 7 d / 30 d in `lastActiveBucket` | `lastInteractionAt` (client-asserted) | `CsCustomersWidget.tsx:403` · CS customers · inside `presence-state@1` |
| A12 | "active customers" (CS) | `role USER ∧ deactivatedAt null` (`lib/platform/customer/attention.ts:73`) | customers; operators = SYSTEM_ADMIN only | point in time | `User` | "of N active customers" (`customer-success-model.ts:59`, `CustomerSuccessLead.tsx:105-167`) · `/api/platform/customer-success/overview` · `cs-needs-help@1` denominator (`registry.ts:379`) |
| A13 | "open accounts" | registrations − deactivated (`growth-model.ts:64`) | **all roles** | point in time | `User` | Growth KPI sub-line · product-analytics · none |
| A14 | unassigned *active* customers | `role USER ∧ deactivatedAt null ∧ no assignment` (`lib/platform/policy-groups-read.ts:88`; also `policy-group-detail.ts:106`, `policy-group-lifecycle-read.ts:87`, `policies/reconcile-beta.ts:66`) | as A12 | point in time | `User` | Policies "Unassigned" (`policies-model.ts:235`) · policy-groups routes · none |
| A15 | owner inactive (connections) | owner `deactivatedAt` set ⇒ connection retired (`lib/connections/health.ts:319`) | connections | point in time | `User` | provider-connection verdict · provider-health · `provider-connection@2` |
| A16 | "Signed-in sessions" / "Active sessions" / "With a live session" | `UserSession.revokedAt IS NULL`: **no SEC-010 lifetime check**, so idle- or absolute-expired rows that were never revoked still count | sessions (CS, Security) or users (Growth) | none; the lifetime lives in `SESSION_IDLE_TIMEOUT_MS` / `SESSION_ABSOLUTE_LIFETIME_MS` (`lib/auth/session-proof.ts:102-104`) but is not applied here | `UserSession` | `CsCustomersWidget.tsx:407` (`customer-detail.ts:116`); `security-posture-view.ts:247` (`security-ops/sessions/route.ts:45`, `auth-posture/route.ts:35`, `security/analytics.ts:67`); `OpsUsersWidget.tsx:41` (`growth-revenue/users/route.ts:57`, role USER) · none |
| A17 | "Active {time}" (own sessions) | `UserSession.lastActiveAt`, which any human-initiated authenticated request moves | sessions | none | `lastActiveAt` | `components/security/SessionsList.tsx:125`, `ActiveSessions.tsx:103`; "recently active sessions" (`SecSessionsWidget.tsx:32`) |
| A18 | "Returning ever" ≡ funnel "Returned" | engaged on any UTC day after the first-visit day (`pac:308`, `pac:339`) | all users | ever | as A1 + first session | `GrowthProductAnalyticsWidget.tsx:192`; funnel stage label (`pac:90`) · product-analytics, growth · none |
| A19 | "Activated" | ≥ 1 `UserSession` ever (`activity.ts:108`, `signups/route.ts:46`) | all users | ever | `UserSession` | `OpsActivityWidget.tsx:39`, `GrowthSignupsWidget.tsx:39` · activity, signups · none |

**Conflicts**

| # | Conflict | Where |
|---|---|---|
| X1 | **"DAU/WAU/MAU" means two things.** The widget labels LOGIN sign-ins (A8) with the same words the registry uses for engaged users (A1). | `OpsActivityWidget.tsx:33-35` vs `registry.ts:250` |
| X2 | **"Active customers" means two things.** CS means not deactivated (point in time, role USER); Economics means engaged this cycle (all roles, deactivated included). | `overview-core.ts:46`, `attention.ts:73` vs `snap:521` |
| X3 | **Two cost-per-customer figures disagree.** They differ in window (30 UTC days vs cycle), numerator (customer AI vs all operating cost) and name ("engaged user" vs "active customer"). | `pac:452` vs `snap:529-536` |
| X4 | **"Signed in" names three predicates:** present (A7), a non-revoked session (A16) and `LOGIN` (A9, "sign-ins"). | `GrowthLead.tsx:95`; `CsCustomersWidget.tsx:407`; `product-analytics-view.ts:117` |
| X5 | **"This week" / "7 d" uses two clocks:** rolling 7 × 24 h (A2, A3, A8) and 7 UTC days including today (A1). | `signups/route.ts:37`, `growth.ts:204`, `activity.ts:143` vs `pac:146` |
| X6 | **The same predicate has two names:** "Returning ever" and "Returned". "Returning (7d)" is a different predicate with the same root word. | `pac:308,339` vs `growth.ts:136` |
| X7 | **Populations disagree.** Engagement counts (A1–A7) include operators and since-deactivated users. CS (A12) excludes both. "open accounts" (A13) excludes deactivated users but keeps operators, and it divides an all-roles numerator. A role-USER holder of a `PlatformGrant` counts as a customer everywhere, because only SYSTEM_ADMIN is distinguished (`lib/platform/authorize.ts:98`). | `pa:47-62`, `attention.ts:73`, `growth-model.ts:64` |
| X8 | **"Live" session counts ignore the SEC-010 lifetime.** Expired, unrevoked rows read as active or signed in. **FIXED on `develop` (PR #345):** 9 sites in all (the A16 sites plus admin-status, admin security users, and the `_max(lastPresenceAt)` reads in `customer-detail.ts` / `customers.ts`) now use the shared `liveSessionWhere(now)` in `lib/auth/session-proof.ts`, which also excludes deactivated and deletion-scheduled accounts. Display-only; sign-in already enforced the limits | A16 sites vs `session-proof.ts:102-104` |
| X9 | **Window constants are duplicated.** `ENGAGEMENT_WINDOW_DAYS` is unused by code, `PRODUCT_ANALYTICS_WINDOW_DAYS` restates its 30, and literals 1/7/30 sit in four files. **DONE** (#350): `ENGAGEMENT_WINDOW_DAYS` is the only source; the rolling reads keep their clock (X5) and are marked in code. | `defs:105`, `pac:52,505-506`, `activity.ts:140-153`, `signups/route.ts:37-38`, `growth.ts:204` |
| X10 | **The "account active" predicate is inline in at least six places.** It is consistent today but not shared. **DONE** (#350): one `OPEN_ACCOUNT_WHERE` / `OPEN_CUSTOMER_WHERE` in `lib/platform/customer/population.ts` (11 readers), census-pinned by `population.test.ts`. | A14 sites, `attention.ts:73`, `security/analytics.ts:65` |

**Canonical vocabulary — PROPOSED.** No surface keeps the bare word "active" except "Active now".

Pending decisions in code: `lib/platform/customer/population.ts` names OD-1..OD-4 as policies whose only status is `UNDECIDED`; every predicate that depends on one takes it as an injected default that keeps today's behaviour, and CS / Economics captions and the registry notes say the definition is pending.

| Name | One definition | One constant | Owning module | Replaces |
|---|---|---|---|---|
| **Engaged (N d)**; DAU/WAU/MAU = Engaged 1/7/30 d | ≥ 1 frozen-predicate fact in the N UTC days ending today | `ENGAGEMENT_WINDOW_DAYS` (`defs`) | predicate: `pac` (`engagementDays`); id sets: `pa` | A1, A2, A3 (window), A4 (window per OD-1) |
| **Engaged this cycle** (only if OD-1 keeps cycles) | same predicate, since 00:00Z on the 1st of the month | economics cycle helper | `snap` | A4 |
| **Present (N d)** | `SESSION_ACTIVE_DAY` ∪ session-start day | `ENGAGEMENT_WINDOW_DAYS` | `pac` (`presenceDays`) | A7 ("Signed in") |
| **Sign-ins (N d)** | distinct users with `LOGIN` in the N UTC days ending today | `ENGAGEMENT_WINDOW_DAYS` | `pac` (`signInDays`) | A8, A9 |
| **Active now / Online, idle / Offline** | `derivePresenceState` | `PRESENCE_CONFIG` | `defs` | A10 (unchanged) |
| **Last interaction** | `lastActiveBucket` | `PRESENCE_CONFIG` + bucket literals | `defs` | A11 ("Last active", "active today") |
| **Open account** | `deactivatedAt IS NULL` (covers deletion-scheduled) | one exported `where` | new `lib/platform/customer/population.ts` | A12–A15 predicates |
| **Customer** | role USER, plus the OD-2 / OD-4 exclusions | same module | same | the population in every count above |
| **Live sessions** | `revokedAt IS NULL ∧ judgeSessionLifetime = LIVE` | `SESSION_*_MS` | `lib/auth/session-proof.ts` | A16 |
| **Returning (7 d)** / **Returned (ever)** | as A3 (UTC days) / A18 | `ENGAGEMENT_WINDOW_DAYS.wau` | `pac` | A3, A18 ("Returning ever") |
| **Cost per engaged customer** | operating cost ÷ Engaged (OD-1 window) | the OD-1 window | `snap` (one figure) | A5 and A6 (one survives, per OD-1) |

**Minimal renames — ENGINEERING (no owner input).** Status per item; copy only, populations and numbers unchanged (pinned):
- `OpsActivityWidget` DAU/WAU/MAU → "Sign-ins · 1 d / 7 d / 30 d". **DONE** (#350)
- GrowthLead "Signed in" → "Present". **DONE** (#350)
- CS "Signed-in sessions", Security "Active sessions" and Growth "With a live session" → "Live sessions" (apply the lifetime rule to their reads). **DONE** (#350) (the reads already used `liveSessionWhere` since #345; Security's stated derivation now says so). Follow-up **DONE** (#353): Growth's figure counts accounts, so it reads "Accounts with a live session" (`accounts-with-live-session@1`), and the legacy /admin "Active sessions" reads "Live sessions". The session lockout (`deletionScheduledAt` too) is the auth rule (#291), kept distinct from the Open-account population rule.
- "active this week" → "Engaged · 7 d". **DONE** (#350)
- Economics "Active customers · this cycle" → "Engaged customers · this cycle" (or · 30 d, per OD-1); "Cost per active customer" → "Cost per engaged customer". **DONE** (#350) (cycle kept; both figures' basis states the OD-1..OD-4 definition is pending).
- CS "active customers" → "open customer accounts". **DONE** (#350) (with an OD-2 / OD-4 "pending the owner's definition" caption).
- Growth "open accounts" → use the Customer ∧ Open-account population. **NOT DONE** — waits on OD-2.
- "Returning ever" → "Returned (ever)"; CS "Last active" → "Last interaction". **DONE** (#350). The bucket label "active today" → "today" (the Last-interaction words; none says "active") **DONE** (#353).
- GrowthLead "… this week" subline → "… in 7 d · … in 30 d (UTC days)". **DONE** (#353)
- Constants: `ENGAGEMENT_WINDOW_DAYS` becomes the only window source (`PRODUCT_ANALYTICS_WINDOW_DAYS = ENGAGEMENT_WINDOW_DAYS.mau`; drop the literals) — **DONE** (#350); rolling 7 × 24 h reads move to UTC days — **NOT DONE** (changes numbers: new metric versions; each read carries a `rolling — see PLATFORM-INTELLIGENCE X5` note). Changing those reads changes their numbers, so they get new metric versions, not edits.
- Registry: add `open-customers@1` and `live-sessions@1` — **DONE** (#350); `live-sessions@1` is the SESSION count and `accounts-with-live-session@1` the account count — **DONE** (#353); the economics cost figures that don't depend on OD-1 are registered (PR A2: `economics-ai-cost@1`, `economics-operating-cost@1`, `economics-provider-cost@1`, `ai-call-outcomes@1`, `ai-cost-per-call@1`); the per-customer figures wait on OD-1 (not done). `engaged-users@1` keeps its id.

**Decision split**

| Item | Class |
|---|---|
| **OD-1.** Which window defines an "active customer" for unit economics: calendar cycle to date, or trailing 30 UTC days (Engaged MAU, A8 ruling)? And does a second cost-per-customer figure survive? | **OWNER DECISION** |
| **OD-2.** Do operators count as customers: SYSTEM_ADMIN, and role-USER `PlatformGrant` holders using personal Spaces? *S2 recommendation: no; any `PlatformGrant` holder is an operator, not a customer.* | **OWNER DECISION** |
| **OD-3.** Does an account deactivated or scheduled for deletion **now** still count in a window in which it was engaged? *S2 recommendation: count it only in windows before its `deactivatedAt`.* | **OWNER DECISION** |
| **OD-4.** Should a test or internal account be marked (a new flag means schema and instrumentation), and should it be excluded? | **OWNER DECISION** |
| All labels, metric keys and versions, constant consolidation, the shared population module, and the lifetime check on live-session counts | **ENGINEERING** — done in #345 (lifetime) and #350, except the rolling→UTC moves and the Growth open-accounts population |
