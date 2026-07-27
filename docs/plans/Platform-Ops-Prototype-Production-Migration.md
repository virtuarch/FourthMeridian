# Platform Ops — Prototype → Production Migration Plan

> **Implementation is intentionally blocked until UI-1 lands.**
> This document prepares the migration but does not begin it.
> No production code or test was modified to produce it. Audit slice: **OPS-PROTOTYPE-MIGRATION-0**.

Audited at `7719f48`, with UI-1 (`OPS-2D-5D-1`) and a Growth session (`GROWTH-1`) both live in the working tree.

---

## 1 · Executive decision

**The headline finding inverts the brief's framing.** The brief describes "moving the existing Platform Operations prototype into the real production product". That migration is **already ~70% done**. The prototype's own slicing plan (`README.md` §10) named two slices — OPS-2C (read) and OPS-2D (write) — and **both have shipped**. `PLATFORM_OPS` is decomposed into nine production workspaces; `PlatformAreaHero`, the Scheduler surface, the Jobs dominant surface, the execution strip and the job-detail panel are all live.

What has *not* migrated is a different thing, and naming it correctly is the point of this audit:

> The **dominant-surface pattern** (`README.md` §13) reached Platform Operations and stopped.
> `SECURITY_OPS`, `GROWTH_REVENUE` and `CUSTOMER_SUCCESS` each still expose **one flat `platform-overview` workspace rendering N widgets in a grid** — the pre-decomposition shape.

Two of those three Spaces already have a parallel session inside them (UI-1 in Customer Success, GROWTH-1 in Growth & Revenue). So the migration program is **not** "port the prototype"; it is:

1. finish the one Space that is nearly complete (`PLATFORM_OPS` — one missing consolidation);
2. extract the prototype's shared presentation primitives **once**, as a by-product of (1);
3. let the two in-flight Spaces land, then complete them to the pattern;
4. treat Security Operations as a **backend-prerequisite** Space, not a UI slice.

**Recommended first slice after UI-1: PM-1 — `ops_platform_health` consolidation.** It is the only fully-backed, zero-new-authority, zero-collision slice available, and it is the natural carrier for the shared primitives every later slice needs.

### Truthfulness ledger for this document

| Tier | Meaning |
|---|---|
| **verified** | read in the repository at `7719f48` during this audit |
| **in-flight** | present in the working tree, owned by another session, read-only here |
| **prototype-only** | exists solely under a gitignored prototype tree |
| **unverified** | inferred, not confirmed by running the product |

Nothing in this document was runtime-verified. This was a static audit; no dev server was started and no browser session was opened.

---

## 2 · Current prototype map

### 2.1 Census — every prototype tree (verified)

`app/prototype/page.tsx` indexes **twelve** experiments. Only one is a Platform Ops surface:

| Tree | Route | Relevance |
|---|---|---|
| `prototype/prototype-ops-control-plane/` | `/prototype/ops-control-plane#{space}` | **THE Platform Ops prototype** — 5,435 LOC, 4 Spaces, 1 host |
| `prototype/prototype-claude/`, `prototype/prototype-codex/` | `/prototype/claude`, `/prototype/codex` | customer-product design labs — **out of scope** |
| `app/prototype/{landing,daily-brief-liquid,timeline*}` | various | customer-product — **out of scope** |
| `Admin Dash Mock Up.png` (repo root, untracked) | — | **superseded** — see §2.4 |

Both prototype trees are gitignored (`.gitignore:94`) and guarded by `lib/prototype-containment.test.ts`, which asserts prototype source is never typechecked as production.

### 2.2 The ops-control-plane prototype (verified)

One host (`page.tsx`, 451 LOC) renders four Spaces through one shell, one rail and one panel family — deliberately mirroring how `PlatformSpaceDashboard` already works in production.

| File | LOC | Contents |
|---|---|---|
| `page.tsx` | 451 | host, Space rail, mobile frames |
| `parts.tsx` | 693 | **21 shared presentation pieces** — the migration payload |
| `Jobs.tsx` + `JobDetail.tsx` | 923 | Platform Ops dominant surface + panel |
| `Scheduler.tsx` + `PlatformHealth.tsx` | 276 | Platform Ops contextual + supporting surfaces |
| `Security.tsx` | 479 | Security Ops Space |
| `Growth.tsx` | 322 | Growth & Revenue Space |
| `Customers.tsx` | 490 | Customer Success Space |
| `data.ts` + `hq-data.ts` | 1,074 | **all fixtures — mock-only, no exceptions** |
| `README.md` | 727 | design rationale, truthfulness classification, honest gaps |

### 2.3 The five-part structure (prototype `README.md` §13)

Every Space follows the same shape, and the differences between Spaces are domain-driven, not template drift:

```
PlatformAreaHero            the area's operating question
  ↓
contextual surface          a small posture read — what is true now, and how we know
  ↓
DOMINANT OPERATING SURFACE  one working object, listed and inspectable
  ↓
supporting surface          everything else, consolidated into ONE surface, never N cards
  ↓
contextual panel            the object's evidence, without leaving the Space
```

| Space | Operating question | Contextual | **Dominant** | Supporting | Panel edge |
|---|---|---|---|---|---|
| Platform Operations | What is the health of Fourth Meridian? | Scheduler | **Jobs** | Platform health | right, 3 tabs |
| Security Operations | Is Fourth Meridian secure? | Posture | **Security findings** | Security activity | right, 3 tabs, no action footer |
| Growth & Revenue | How is the platform growing? | Window & coverage | **Funnel** | Growth context | right, no tabs |
| Customer Success | How are customers doing? | Attention | **Customer portfolio** | Support context | **left**, 3 tabs |

**The two-axis rule.** OBSERVED owns colour and renders as dot-plus-word; DECLARED is a quiet neutral pill that **renders nothing** when nobody has declared anything. This is what makes the pattern evolutionary: with an empty declaration table every screen is byte-identical to what ships today.

**Why Customer Success docks left.** Semantic, not decorative: right is "tell me more about the thing I selected"; left is "this is the thing you are operating in". A job/finding/stage is a detail of a system; a customer is a subject.

### 2.4 The PNG is superseded design evidence (verified)

`Admin Dash Mock Up.png` shows a **light-theme first pass** of Platform Operations. It contradicts the README's second pass on two decisions the README explicitly reversed:

| PNG shows | README §"Columns" / §"Health vs Policy" ruling |
|---|---|
| a `Schedule` column | **rejected** — cadence is configuration, rides as the job's second identity line |
| an `Enabled` policy pill on **every** row | **rejected** — "three marks instead of eleven Enabled pills"; undeclared policy renders nothing |

Its left rail does confirm the nine-workspace `PLATFORM_OPS` decomposition that production shipped.

> ⚠️ **Do not treat the PNG as the target.** Following it reintroduces two decisions the design process deliberately reversed. The README is the authority.

### 2.5 Prototype element classification

| Element | Status | Reason |
|---|---|---|
| Five-part Space structure | **PRESERVE** | the whole thesis; already validated by `PLATFORM_OPS` in production |
| Two-axis OBSERVED/DECLARED rule | **PRESERVE** | absence-renders-nothing is what makes it non-breaking |
| `PlatformAreaHero` opening | **PRESERVE** | already production; already rendered |
| Left panel for Customer Success | **PRESERVE** | semantic; `LeftPanel` already exists in `components/atlas/panels` |
| `SectionSurface`, `GroupLabel`, `BigStat`, `TwoLine`, `KeyRow`, `PanelSection`, `VRule` | **ADAPT** | rebuild on `Surface`/`Figure` tokens; production-bound, not copied |
| `Provenance` | **ADAPT** | strong idea (names the system of record); prototype's union type is prototype-shaped |
| `StatusBadge`, `SeverityBadge` | **ADAPT** | `StatusBadge` was lifted verbatim *from* `OpsJobHealthWidget` — return it to a shared home |
| `ExecutionStrip`, `RuntimeTrend` | **PRESERVE** | already migrated (OPS-2C-3) |
| `FunnelStages` | **PRESERVE** | **already migrated in-flight** by GROWTH-1 |
| `useNarrowViewport` | **REPLACE** | prototype finding §8.5 says the `hidden md:grid` cascade bug is prototype-only ("in production the tree is scanned, the variant works and the hook is unnecessary") |
| `DecisionDialog` | **REPLACE** | prototype finding §8.1 — the real fix is widening `ConfirmDialog`'s `<p>` to `<div>` in production |
| Inline styles for 15 utility classes | **REJECT** | prototype finding §8.8 — a Tailwind/gitignore artefact, meaningless in production |
| `data.ts`, `hq-data.ts` (1,074 LOC) | **REJECT** | 100% fixtures; must never reach production |
| Security **findings cluster** | **DEFER** | no `SecurityFinding` authority — §14.1 |
| Investigation state, remediation controls | **DEFER** | no authority — §14.2, §14.3 |
| Customer **portfolio** object | **DEFER** | `SyncIssue` has no `userId` — §14.7 |
| Revenue, cohort retention, attribution | **REJECT** | no model exists; "Growth & Revenue" is half-named — §14.4–14.6 |
| Owner / tickets / notes / outreach / NPS | **REJECT** | drawing them greyed-out would still imply they are coming — §14.9 |

---

## 3 · Current production map

### 3.1 The real route (verified)

```
HQ launcher
  → Space (platformArea = PLATFORM_OPS | SECURITY_OPS | GROWTH_REVENUE | CUSTOMER_SUCCESS)
  → PlatformSpaceDashboard.tsx                (312 LOC — the composition root)
      → PlatformAreaHero  (line 293)          ✅ the prototype's opening lede, already live
      → getPlatformAreaWorkspaces(area)       lib/platform/workspaces.ts
      → PLATFORM_WIDGET_REGISTRY  (line 86)   section key → widget component
      → enabled SpaceDashboardSection rows    ← DB-gated (line 195)
      → widget                                components/platform/widgets/*.tsx
      → useWidgetFetch(static url)            → /api/platform/{area}/{resource}
```

**The DB gate is the migration's most important constraint.** A widget renders only if (a) it is in `PLATFORM_WIDGET_REGISTRY`, (b) it is listed in `PLATFORM_AREA_WORKSPACES`, **and** (c) an enabled `SpaceDashboardSection` row exists. New section keys must be added to `PLATFORM_AREAS` (`lib/platform/policy.ts`) and materialized by `lib/platform/seed.ts`'s create-only backfill. A slice that adds a section and forgets the seed ships an invisible surface.

### 3.2 Workspace decomposition (verified — `lib/platform/workspaces.ts:118`)

| Area | Workspaces | Shape |
|---|---|---|
| `PLATFORM_OPS` | **9** — overview, jobs, refresh, providers, operations, alerts, trends, ai, costs | **decomposed** ✅ |
| `SECURITY_OPS` | **1** — `platform-overview`, 5 sections in a grid | **flat** ❌ |
| `GROWTH_REVENUE` | **1** — `platform-overview`, 5 sections in a grid | **flat** ❌ (GROWTH-1 in flight) |
| `CUSTOMER_SUCCESS` | **1** — `platform-overview`, 1 section | **flat** ❌ (UI-1 in flight) |

The file's own header concedes it: *"Only PLATFORM_OPS is decomposed in Wave A; the other areas expose one Overview workspace that renders all their sections (the pre-S6 single grid, behavior-preserving)."*

### 3.3 Production primitives (verified)

| Primitive | Location | Suitable as-is? |
|---|---|---|
| `Surface`, `Block`, `Figure`, `Delta` | `components/atlas/Surface.tsx` | ✅ — the material `SectionSurface`/`BigStat` are built from |
| `RightPanel`, `LeftPanel`, `PanelHeader/Content/Footer`, `PanelStack` | `components/atlas/panels/` | ✅ — handles mobile bottom-sheet with no fork (README §8.3) |
| `SegmentedControl` | `components/atlas/SegmentedControl.tsx` | ✅ — panel tabs |
| `Dialog`, `GlassButton`, `EmptyState`, `InlineBanner`, `InlineFilter`, `Chips` | `components/atlas/` | ✅ |
| `ConfirmDialog` | `components/atlas/ConfirmDialog.tsx` | ⚠️ — renders `message` in a `<p>`; needs the one-line `<div>` widening (README §8.1) |
| `PlatformWidgetCard`, `WidgetMessage`, `WidgetStat`, `useWidgetFetch`, `timeAgo` | `components/platform/widget-kit.tsx` | ✅ for widgets; **wrong grain** for surfaces |
| `PlatformAreaHero` | `components/platform/PlatformAreaHero.tsx` | ✅ — already rendered |
| **`PanelHost` / drill-kind registry** | — | ❌ **DOES NOT EXIST** in the platform tree |

> ⚠️ **Brief-assumption correction.** The brief lists "shared contextual PanelHost architecture" and "shared operational visualization primitives" as things production already has. **Neither exists as a shared platform abstraction.** A repo-wide search for `PanelHost` / `drillKind` in `components/platform/` and `lib/platform/` returns nothing. What exists is a **convention**: each widget owns its own panel (`ExecutionTimelinePanel.tsx`, and in-flight `GrowthStagePanel.tsx`). Do not plan against an abstraction that is not there — and do not build one speculatively (see R-3).

`useWidgetFetch` is contractually **static-URL only**, pinned by `widget-fetch-static-url.test.ts`, because it does not reset loading/error between URLs (stale data shown as current). `ExecutionTimelinePanel` documents the sanctioned escape: a small keyed reader remounted via React `key`, so a second URL is structurally unobservable. **Any per-object drill panel must follow that precedent, not widen the shared hook.**

### 3.4 The established migration pattern (verified from in-flight work)

Both parallel sessions independently converged on the same vertical. **This is the pattern PM slices must match.**

| Layer | Growth (GROWTH-1) | Customer Success (UI-1) |
|---|---|---|
| server read | *(existing `growth.ts`)* | `lib/platform/incidents/preview.ts` |
| pure core | — | `lib/platform/incidents/preview-core.ts` + `.test.ts` |
| presentation model | `components/platform/widgets/growth-funnel-view.ts` | `components/platform/widgets/incident-preview-view.ts` |
| pure test | `growth-funnel.test.ts` | `incident-preview.test.ts` |
| surface | `FunnelStages.tsx` | `IncidentPreview.tsx` |
| drill panel | `GrowthStagePanel.tsx` | *(in the widget)* |
| reshelled widget | `OpsGrowthWidget.tsx` | `CsSyncIssuesWidget.tsx` |
| runtime proof | — | `scripts/test-incident-preview-path.ts` |

The shared doctrine, quoted from both: *"This file computes nothing"* / *"there is deliberately no function here whose name ends in `Rate`, and the guard asserts it — the moment this module computes a conversion figure, the authority has been forked."*

---

## 4 · Canonical authority map

| Concept | Authority | Projection / route | Status | Gap |
|---|---|---|---|---|
| Job health, cadence, slots | `lib/jobs/registry.ts`, `lib/jobs/health.ts`, `vercel.json` | `/platform-ops/job-health`, `/scheduler` | **rendered** | — |
| Refresh executions, coverage, timeline | `lib/platform/refresh/` | `/platform-ops/refresh/*` | **rendered** | — |
| Deployment identity | `currentDeploymentSha()` (OPS-2B′) | on `JobRun` + `RefreshExecution` | **rendered** | — |
| Alerts | — | `/platform-ops/alerts` | **rendered** | — |
| Provider health | `lib/platform/provider-health.ts` | `/platform-ops/provider-health` | **rendered** | — |
| Resource freshness | `lib/platform/resource-freshness.ts` | `/platform-ops/resource-freshness` | **rendered** | — |
| Rate limits · environment | — | `/platform-ops/rate-limits`, `/env-status` | **rendered** | — |
| Connection health · diagnostics | `lib/platform/connection-diagnostics.ts` | `/platform-ops/connection-*` | **rendered** | — |
| **Incident episodes + occurrences** | `lib/platform/incidents/lifecycle.ts` | `projections.ts` → `getActiveIncidents()` | **rendered** | — |
| Incident severity/domain/nature/state | `lib/platform/sync-issue-semantics.ts` | derived, never stored | **rendered** | — |
| Incident operation identity | `lib/platform/incidents/operation-key.ts` | `incidentKey` | **projected** | no UI consumer yet |
| **Incident preview + subject labels** | `preview.ts` / `preview-core.ts` | `/customer-success/sync-issues` | **in-flight (UI-1)** | — |
| Growth funnel stages, counts, ratios | `lib/platform/growth/growth.ts` | `/growth/*` | **in-flight (GROWTH-1)** | — |
| Failed sign-ins, rate-limit trips | — | `/security-ops/anomalies` | **rendered** | — |
| TOTP coverage, forced resets | — | `/security-ops/auth-posture` | **rendered** | — |
| Sessions · audit · operator actions | — | `/security-ops/{sessions,audit,operator-actions}` | **rendered** | — |
| **Security finding (cluster)** | — | — | ❌ **No production authority found** | needs a clustering rule; §14.1 |
| **Investigation state** | — | — | ❌ **No production authority found** | mutable state + decision log; §14.2 |
| Security remediation (block/revoke/lock) | — | — | ❌ **No production authority found** | §14.3 |
| **Customer identity (item → user)** | — | — | ❌ **No production authority found** | `SyncIssue` has no `userId`; §14.7 |
| Operator-visible customer identity policy | — | — | ❌ **Policy decision, not a design one** | §14.8 |
| Revenue · cohort retention · attribution | — | — | ❌ **No production authority found** | §14.4–14.6 |
| Growth history / trend | — | — | ❌ point-in-time projection only | §14.5 |
| `JobControlState` + policy resolver | — | — | ⚠️ shipped by OPS-2D as the *admission* authority; the prototype's **job policy** axis is a different concept | verify before reuse |

---

## 5 · Widget-by-widget migration matrix

| # | Prototype element | Operator purpose | Prototype source | Production equivalent | Canonical authority | Primitive | Class | UI-1 collision | Target slice |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Platform Ops hero | area lede | production import | `PlatformAreaHero` | `PLATFORM_AREAS` | shipped | **PRESERVE — done** | none | ✅ shipped |
| 2 | Scheduler (Observed\|Expected\|Notes) | is the dispatcher alive? | `Scheduler.tsx` | `ops_scheduler` | `/scheduler` | shipped | **PRESERVE — done** | none | ✅ shipped |
| 3 | Jobs dominant surface | which job is failing/held? | `Jobs.tsx` | `ops_job_health` | `/job-health` | shipped | **PRESERVE — done** | none | ✅ shipped |
| 4 | Job detail panel (3 tabs) | job evidence | `JobDetail.tsx` | job-health panel | `/job-health` | `RightPanel` | **PRESERVE — done** | none | ✅ shipped |
| 5 | Execution strip · runtime trend | recent runs, deploy boundary | `parts.tsx` | `ExecutionTimelinePanel` | `refresh/` | `RightPanel` | **PRESERVE — done** | none | ✅ shipped |
| 6 | **Platform health (4 groups → 1 surface)** | everything else, consolidated | `PlatformHealth.tsx` | ❌ **5 separate sections** | alerts, provider-health, resource-freshness, rate-limits, env-status — **all live** | `SectionSurface`+`GroupLabel` (new) | **ADAPT** | **none** | **PM-1** |
| 7 | `SectionSurface`/`GroupLabel`/`BigStat`/`TwoLine`/`VRule` | the surface grammar | `parts.tsx` | ❌ none | n/a (presentation) | on `Surface`/`Figure` | **ADAPT** | none | **PM-1** |
| 8 | `Provenance` | names the system of record | `parts.tsx` | ❌ none | n/a | new, tiny | **ADAPT** | none | **PM-1** |
| 9 | Growth funnel dominant surface | where does growth stop? | `Growth.tsx` | `FunnelStages.tsx` | `growth.ts` | in-flight | **PRESERVE** | **GROWTH-1 owns** | ✅ in-flight |
| 10 | Growth stage panel | stage evidence | `Growth.tsx` | `GrowthStagePanel.tsx` | `growth.ts` | in-flight | **PRESERVE** | **GROWTH-1 owns** | ✅ in-flight |
| 11 | Growth "Window & coverage" contextual | what is unobserved? | `Growth.tsx` | ❌ none | partial — "Unobserved" names gaps that have no authority | `SectionSurface` | **ADAPT** | GROWTH-1 adjacent | **PM-3** |
| 12 | Growth "Growth context" supporting | queue, activation gap | `Growth.tsx` | 4 flat sections | `/growth/*` | `SectionSurface` | **ADAPT** | GROWTH-1 adjacent | **PM-3** |
| 13 | Incident preview | which incidents matter? | `Customers.tsx` | `IncidentPreview.tsx` | `preview.ts` | in-flight | **PRESERVE** | **UI-1 OWNS** | ✅ in-flight |
| 14 | CS "Attention" contextual | posture read | `Customers.tsx` | ❌ none | derivable from `getActiveIncidents()` | `SectionSurface` | **ADAPT** | **HIGH — after UI-1** | **PM-4** |
| 15 | **CS "Customer portfolio" dominant** | which customers need attention? | `Customers.tsx` | ❌ none | ❌ **no item→user join** | — | **DEFER** | n/a | **backend prerequisite** |
| 16 | CS left panel (3 tabs) | customer mini-workspace | `Customers.tsx` | ❌ none | blocked by #15 | `LeftPanel` | **DEFER** | n/a | after #15 |
| 17 | CS "Support context" supporting | backlog by domain | `Customers.tsx` | ❌ none | `getActiveIncidents()` + semantics | `SectionSurface` | **ADAPT** | **after UI-1** | **PM-4** |
| 18 | Security "Posture" contextual | detections \| coverage \| notes | `Security.tsx` | ❌ none | anomalies + auth-posture — **both live** | `SectionSurface` | **ADAPT** | none | **PM-2** |
| 19 | Security "Security activity" supporting | auth · operator · sessions | `Security.tsx` | 3 flat sections | audit, operator-actions, sessions — **all live** | `SectionSurface` | **ADAPT** | none | **PM-2** |
| 20 | **Security "findings" dominant surface** | what fired, how severe? | `Security.tsx` | ❌ none | ❌ **no clustering authority** | — | **DEFER** | n/a | **backend prerequisite** |
| 21 | Finding panel · investigation state | finding evidence | `Security.tsx` | ❌ none | blocked by #20 | `RightPanel` | **DEFER** | n/a | after #20 |
| 22 | Severity/state two-axis in Security | observed vs declared | `Security.tsx` | ❌ none | severity derivable; state has no authority | `SeverityBadge` | **DEFER** | n/a | after #20 |
| 23 | Job policy pill (`PolicyChip`) | what has been declared? | `parts.tsx` | ⚠️ verify vs OPS-2D admission | `JobControlState` — **confirm** | `PolicyChip` | **DEFER** | none | **PM-5** |
| 24 | Row `⋯` / Controls tab / maintenance mode | operator commands | `Jobs.tsx`, `JobDetail.tsx` | partial (`ops_manual_operations`) | admission authority | `Dialog` | **DEFER** | none | **PM-5** |
| 25 | `ScopeLine` (3-tier blast radius) | safety by consistency | `parts.tsx` | ❌ none | n/a | new | **ADAPT** | none | **PM-5** |
| 26 | `useNarrowViewport` | viewport as state | `parts.tsx` | ❌ none | n/a | **use `md:` variants** | **REPLACE** | none | — |
| 27 | `DecisionDialog` | confirmation shape | `parts.tsx` | `ConfirmDialog` | n/a | widen `<p>`→`<div>` | **REPLACE** | none | **PM-5** |
| 28 | `data.ts` / `hq-data.ts` | — | fixtures | — | — | — | **REJECT** | none | never |
| 29 | Revenue · cohorts · attribution | — | `Growth.tsx` (named only) | ❌ none | ❌ no model | — | **REJECT** | none | never (until a model exists) |
| 30 | Owner · tickets · notes · NPS | — | not drawn | ❌ none | ❌ no model | — | **REJECT** | none | never |

### Judgement summary

| Verdict | Count | Items |
|---|---|---|
| ✅ **Already migrated** | 5 | 1–5 |
| ✅ **In flight** (do not touch) | 3 | 9, 10, 13 |
| **Ready now** | 4 | 6, 7, 8, 18, 19 → PM-1, PM-2 |
| **Ready after UI-1** | 3 | 11, 12, 14, 17 → PM-3, PM-4 |
| **Backend prerequisite** | 6 | 15, 16, 20, 21, 22, and the customer-identity policy |
| **Deferred (write-path)** | 4 | 23, 24, 25, 27 → PM-5 |
| **Rejected** | 4 | 26, 28, 29, 30 |

---

## 6 · Interaction plan

Production has **no shared drill abstraction** (§3.3). The convention is: a widget owns its panel, and per-object fetching uses the keyed-remount reader, not `useWidgetFetch`.

| Prototype interaction | Verdict | Production mechanism |
|---|---|---|
| Job row → detail panel | **preserved, shipped** | widget-owned `RightPanel` |
| Funnel stage → panel | **preserved, in-flight** | `GrowthStagePanel` (GROWTH-1) |
| Incident row → detail | **preserved, in-flight** | UI-1 |
| Customer row → left panel | **deferred** | blocked on the customer join (#15) |
| Finding row → panel | **deferred** | blocked on the clustering authority (#20) |
| Health-item click inside a supporting surface | **adapt** | **non-interactive display** in PM-1/PM-2 — the groups are a consolidated read, not N objects |
| Severity/state filter chips | **adapt** | local `useState` + `InlineFilter`; **not** URL state (the Space rail owns the URL) |
| Search box (Jobs) | **preserved, shipped** | local state |
| "View all" / doorways | **preserved, shipped** | `PlatformWorkspaceComposition.doorways` |
| Row `⋯` overflow → issues a command | **deferred to PM-5** | `Dropdown` + `ConfirmDialog`; README §8.4 — the menu must *issue*, never navigate |
| Maintenance mode (fleet scope) | **deferred to PM-5** | section header `actions` slot; fleet actions never on a row |
| Hover-only information | **rejected** | GROWTH-1's rule: *"every fact is on the surface, so it reads identically to a mouse and to a finger"* |
| Mobile drill / back / close | **preserved** | `Panel` is already a bottom sheet on phone, no fork |

**Fake or unsupported in the prototype (verified from `README.md` §11, §14):** all run histories and control states; every finding, its occurrence count, evidence rows and timeline; the five customers and every chain sentence; the five growth numbers; all alert/provider/freshness values. Schedule editing "works" but deliberately does not apply — cadence is deploy-owned.

---

## 7 · Visual and responsive plan

| Breakpoint | Prototype intent | Production reality | Action |
|---|---|---|---|
| Desktop | few large surfaces; groups separated by whitespace + one hairline, never a nested box | widget grid of bordered cards | PM-1/PM-2 introduce `SectionSurface` — **one** frame level |
| Tablet | multi-column groups begin collapsing | grid reflows | use `md:` variants |
| Mobile | every multi-column region collapses; **full command parity**, nothing hidden | `Panel` → bottom sheet ✅ | keep parity; hiding a control teaches operators the phone is untrustworthy |

**Prototype assumptions that do not survive production:**

- `useNarrowViewport` — a workaround for a `hidden md:grid` cascade bug that exists **only** because gitignored trees are invisible to Tailwind v4 content detection (README §8.5, §8.8). In production the tree is scanned; use the variant.
- Inline styles for 15 utility classes — same root cause. **Reject entirely.**
- The 400px phone frame inside a 1500px viewport misrepresented `md:` (README §8.6). Collapse points must be verified at a real width.
- `PanelContent` must not be given `flex flex-col` — it is a height-bounded flex item and its children get compressed instead of scrolling (README §8.7).

**Typography.** One existing tier promoted (`text-base font-semibold` for section titles); the 10px uppercase eyebrow is demoted to labelling a group *inside* a surface. **No new tier is invented, and no second admin design system is created** — every material comes from `components/atlas/*` and existing tokens.

**Honest gap carried forward:** the true 390px viewport was never reachable (Chrome clamps at ~606px). 390px layout is **inferred, not seen** — sixth sprint with this limitation. Any PM slice claiming mobile correctness must say which widths it actually observed.

---

## 8 · Migration sequence

The brief's suggested sequence (PM-1 overview → PM-2 connections → PM-3 activity → PM-4 drills → PM-5 retirement) **is not adopted**. It assumes Platform Operations still needs migrating; it does not. The evidence-derived sequence follows the *gaps*.

### PM-1 · Platform health consolidation + shared surface primitives

- **Goal** — collapse five `PLATFORM_OPS` overview sections into one supporting surface, and extract the surface grammar every later slice needs.
- **Visible result** — Platform Operations Overview reads hero → Scheduler → Jobs → **Platform health** (Alerts · Providers · Freshness · Configuration), instead of seven equal-weight cards.
- **Files owned** — `components/platform/widgets/OpsPlatformHealthWidget.tsx` (new), `platform-surface.tsx` (new: `SectionSurface`, `GroupLabel`, `BigStat`, `TwoLine`, `VRule`, `Provenance`), `platform-surface.test.ts` (new), `lib/platform/workspaces.ts` (composition only), `lib/platform/policy.ts` (one section key), `components/platform/PlatformSpaceDashboard.tsx` (registry entry).
- **Prototype referenced** — `PlatformHealth.tsx`, `parts.tsx:291–447`.
- **Authorities consumed** — five existing routes, unchanged. **No new authority, no new route, no schema.**
- **New components permitted** — the six presentation primitives only, and only because PM-2/PM-3/PM-4 all consume them.
- **Dependencies** — UI-1 landed (for `policy.ts`).
- **Non-goals** — no new data, no drill panel, no write controls, no other Space.
- **Tests** — pure `platform-surface.test.ts`; registry↔composition parity guard.
- **Runtime proof** — Platform Operations Overview in-browser as a `USER` with a `PLATFORM_OPS READ` grant; the four groups render real values; the section row is seeded.
- **Collision risk** — **LOW**. `policy.ts` is a one-line append in a different area block than UI-1's edit.
- **Commit** — `feat(ops): consolidate platform health into one surface (PM-1)`.

### PM-2 · Security Operations composition

- **Goal** — bring the five-part structure to `SECURITY_OPS` **without** a dominant surface, and say so on the page.
- **Visible result** — hero → **Posture** (Detections | Coverage | Notes) → **Security activity** (End-user auth · Operator actions · Sessions).
- **Files owned** — `SecPostureWidget.tsx`, `SecActivityWidget.tsx`, `sec-posture-view.ts` + test (new); `workspaces.ts`, `policy.ts`, registry.
- **Authorities consumed** — all five `security-ops` routes, unchanged.
- **Dependencies** — PM-1 (primitives).
- **Non-goals** — ❌ **no findings surface, no severity, no investigation state, no remediation control.** The Notes group states plainly that findings are not recorded, so a quiet page means no detector fired — not that nothing is wrong.
- **Collision risk** — **NONE**. No session is inside Security Operations.
- **Open question** — a Space whose *dominant* surface is absent is a deliberate half-pattern. §13 says "all secondary information supports that surface"; here there is nothing to support. **Decide before PM-2 whether to ship the halves or wait for the clustering authority.** Recommendation: ship — two consolidated surfaces beat five loose cards, and the honesty note is itself operator-useful.

### PM-3 · Growth & Revenue composition *(after GROWTH-1 lands)*

- **Goal** — wrap GROWTH-1's funnel in the contextual + supporting surfaces.
- **Visible result** — hero → **Window & coverage** (Observed | **Unobserved** | Notes) → **Funnel** → **Growth context**.
- **Files owned** — `GrowthWindowWidget.tsx`, `GrowthContextWidget.tsx` (new); composition. **Never** `FunnelStages.tsx`, `growth-funnel-view.ts`, `GrowthStagePanel.tsx`, `OpsGrowthWidget.tsx`.
- **Non-goals** — ❌ **revenue, cohorts, attribution.** Revenue appears once, in *Unobserved*, **named rather than zeroed** — the single most important honesty decision in this Space.
- **Collision risk** — **HIGH until GROWTH-1 commits.** Hard-sequenced.

### PM-4 · Customer Success composition *(after UI-1 lands)*

- **Goal** — wrap UI-1's incident preview in the contextual + supporting surfaces.
- **Visible result** — hero → **Attention** → **Incidents** (UI-1's) → **Support context** (backlog by domain · onboarding · accounts without observations).
- **Files owned** — `CsAttentionWidget.tsx`, `CsSupportContextWidget.tsx` (new); composition. **Never** `IncidentPreview.tsx`, `incident-preview-view.ts`, `preview.ts`, `preview-core.ts`, `CsSyncIssuesWidget.tsx`, `projections.ts`.
- **Authorities consumed** — `getActiveIncidents()` + `sync-issue-semantics.ts`, **through UI-1's shipped contract**. Must not re-derive severity or domain.
- **Non-goals** — ❌ **the customer portfolio.** The dominant surface stays absent until the item→user join and the identity-display policy exist.
- **Collision risk** — **HIGH until UI-1 commits.** Hard-sequenced.

### PM-5 · Operator command surface *(scope-gated)*

Row `⋯`, Controls tab, `ScopeLine`, maintenance mode, `ConfirmDialog` `<p>`→`<div>`. **Blocked** until it is confirmed whether OPS-2D's admission authority is the same concept as the prototype's job-policy axis (matrix #23). Likely a separate initiative, not a migration slice.

### PM-6 · Prototype retirement

Only when: every PRESERVE/ADAPT row is shipped or explicitly reclassified; every DEFER row has a tracked authority gap; `lib/prototype-containment.test.ts` still passes; and the README's §14 gap list is transcribed somewhere durable. **The prototype must not be deleted while it is the only record of the design rationale** — §14 in particular is not reproduced anywhere in production.

---

## 9 · File ownership and parallelism

### Currently owned — do not touch

| Owner | Files |
|---|---|
| **UI-1** (`OPS-2D-5D-1`) | `app/api/platform/customer-success/sync-issues/route.ts` · `components/platform/widgets/CsSyncIssuesWidget.tsx` · `IncidentPreview.tsx` · `incident-preview-view.ts` · `incident-preview.test.ts` · `lib/platform/incidents/{projections,preview,preview-core}.ts` · `preview-core.test.ts` · `lib/platform/sync-issue-semantics.ts` · `scripts/test-incident-preview-path.ts` · **`lib/platform/policy.ts`** |
| **GROWTH-1** | `components/platform/widgets/OpsGrowthWidget.tsx` · `FunnelStages.tsx` · `GrowthStagePanel.tsx` · `growth-funnel-view.ts` · `growth-funnel.test.ts` |
| **unattributed** | `.gitignore` · `AGENTS.md` · `Admin Dash Mock Up.png` |

### Shared-file reconciliation points

| File | Hazard | Recommendation |
|---|---|---|
| `lib/platform/policy.ts` | **UI-1 holds it.** Every PM slice appends a section key. | **Sequence after UI-1.** Appends land in different area blocks — manual reconciliation, never `checkout` |
| `lib/platform/workspaces.ts` | every PM slice edits `PLATFORM_AREA_WORKSPACES` | **single-session owner per area**; PM-1 (`PLATFORM_OPS`), PM-2 (`SECURITY_OPS`), PM-3 (`GROWTH_REVENUE`), PM-4 (`CUSTOMER_SUCCESS`) touch disjoint blocks |
| `PlatformSpaceDashboard.tsx` | `PLATFORM_WIDGET_REGISTRY` gains one line per slice | **composition-only change**; disjoint lines |
| `lib/platform/seed.ts` | create-only backfill for new sections | verify per slice; a missed seed ships an invisible surface |
| `components/platform/widget-kit.tsx` | tempting to add surface primitives here | ❌ **new file `platform-surface.tsx`** — widget-kit is card-grain, surfaces are page-grain |
| `components/atlas/ConfirmDialog.tsx` | the `<p>`→`<div>` widening | **single owner: PM-5**; it is a shared customer-facing primitive |

### Future UI-2 (incident detail) boundary

UI-2 will own incident **detail** (`incidentKey`, occurrence history, `previousIncidentId` recurrence chain — all projected but unconsumed). PM-4 must not build an incident detail panel; it composes *around* the preview, never *into* it.

---

## 10 · Risks and gaps

| # | Risk | Likelihood | Impact | Mitigation | Closed by |
|---|---|---|---|---|---|
| R-1 | **Prototype mock data mistaken for production truth.** `data.ts`/`hq-data.ts` are 1,074 LOC of plausible fixtures | **High** | **Critical** — fabricated operational numbers | Neither file is ever imported. §13b of the prototype README classifies every value; treat it as the checklist | every slice |
| R-2 | **Duplicate semantic derivation** — a view model computing severity/domain instead of asking `sync-issue-semantics.ts` | **High** | **High** — a second opinion about what an incident means | Adopt GROWTH-1's guard idiom: assert no function name ends in `Rate`/`Severity` in a view module | PM-3, PM-4 |
| R-3 | **Speculative `PanelHost`.** The brief implies one exists; it does not | Medium | Medium — an abstraction with one consumer | Keep the widget-owns-its-panel convention until a third panel proves the shape | PM-4 |
| R-4 | **Duplicated primitives** — a second `SectionSurface` per Space | Medium | Medium | PM-1 extracts once; PM-2/3/4 import | PM-1 |
| R-5 | **Missing seed row** — section registered but no `SpaceDashboardSection`, so the surface silently never renders | **High** | Medium — invisible feature, green build | Every PM slice's runtime proof must load the real Space, not just the component | every slice |
| R-6 | **`useWidgetFetch` misuse for per-object drills** — stale data shown as current | Medium | **High** | Follow the `ExecutionTimelinePanel` keyed-remount precedent; `widget-fetch-static-url.test.ts` already rejects template literals | PM-4 |
| R-7 | **Cross-customer incident exposure.** The portfolio needs item→user, which runs straight into the boundary that keeps operator-visible identity out of CS routes | Medium | **Critical** | Blocked as a backend prerequisite. UI-1's subject-label approach (account/institution, not person) is the safer precedent | before #15 |
| R-8 | **Unknown rendered as healthy.** `unknown` is first-class and distinct from healthy — an account with no data produces no signal | Medium | **High** — false reassurance | Carry the prototype's three-state health; never collapse unknown into ok | PM-2, PM-4 |
| R-9 | **Write-only capability with no UI projection** — the DF-2F mistake. `operationKey`, occurrence depth and recurrence chains are projected but unconsumed | **High** | Medium | Named for UI-2; PM slices must not silently absorb it | UI-2 |
| R-10 | **Prototype copied wholesale** — inline styles, `useNarrowViewport`, fixture shapes | Medium | Medium | Classification table §2.5 marks each REPLACE/REJECT with its reason | PM-1 |
| R-11 | **Dead prototype as a second product path** | Low | Medium | `lib/prototype-containment.test.ts` already guards; PM-6 gates retirement on rationale preservation | PM-6 |
| R-12 | **Following the superseded PNG** — reintroduces the Schedule column and per-row Enabled pills | Medium | Medium | §2.4; the README is the authority | PM-1 |
| R-13 | **Security Space with no dominant surface** reads as an unfinished page | Medium | Medium | Ship the honesty note as content; revisit when the clustering authority exists | PM-2 |
| R-14 | **Workspace registry / rail collision** between parallel PM slices | Low | Medium | Disjoint area blocks; registry↔renderer parity guard already exists | §9 |

### Missing authorities (consolidated)

1. Security finding cluster (+ the clustering rule — *"clustering is where a findings surface silently becomes wrong"*)
2. Investigation state (mutable row + immutable decision log)
3. Security remediation controls — the largest gap between "an investigation surface" and "a SOC"
4. Customer identity join (`SyncIssue` → user) **and** the policy for what an operator may see
5. Revenue; cohort retention; acquisition attribution; approval→redemption latency
6. Growth history (the projection is point-in-time, so "what changed" is unanswerable)
7. First-connection activation (activation is session-based; for a financial product the real event is connecting an account)
8. Ownership / follow-up model

### Unverified assumptions

- Every "ready now" is proven by **file existence and route existence**, not by rendering. No dev server was started.
- Whether OPS-2D's admission authority is the prototype's job-policy axis (matrix #23) — **unverified**.
- Whether `SpaceDashboardSection` rows exist in any environment for new keys — **unverified**; R-5.
- 390px layout — **inferred, never observed**.

---

## 11 · Verification strategy

Each PM slice must show, in order: pure view-model tests (house `npx tsx` pattern) → registry↔composition parity → the real Space loaded in-browser as a `USER` with the area grant (`SYSTEM_ADMIN` redirects) → the section row confirmed present → mobile at an actually-observed width, stated.

## 12 · Prototype retirement criteria

See PM-6. The blocking condition is that **§14's gap list is not reproduced anywhere in production** — retire the code only after the rationale has a durable home.

## 13 · Open questions

1. Ship Security Operations without its dominant surface? *(recommendation: yes — R-13)*
2. Is OPS-2D admission the same concept as job policy? *(blocks PM-5)*
3. What may an operator see of customer identity? *(a policy decision, not a design one — blocks #15)*
4. Does `ops_platform_health` supersede the five sections or coexist? *(recommendation: supersede in Overview, keep the detail workspaces)*
5. Who owns the `ConfirmDialog` `<p>`→`<div>` widening — PM-5, or a standalone Atlas fix?
