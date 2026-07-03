# Space Dashboard — Future Direction Investigation

**Status:** Investigation only — no code, schema, migrations, or UI changes.
**Date:** 2026-07-03
**Baseline:** v2.4.x, `feature/phase-2-architecture` lineage; defers to `STATUS.md` for current state and `PHASE_2_DECISION_MATRIX.md` for D1–D14.
**Evidence base:** `components/dashboard/SpaceDashboard.tsx` (2,287 lines), `components/dashboard/DashboardClient.tsx` (1,446 lines), `components/dashboard/widgets/*` (KpiRow, OverviewBriefPanel, PerspectivesWidget, SpaceTimelineWidget, SpaceComingSoonPanel, GlassModal), `lib/space-nav.ts`, `lib/perspectives.ts`, `lib/space-presets.ts`, `lib/widget-registry.ts`, `lib/timeline-placeholder.ts`, `fourth-meridian-product-language.md`, `docs/investigations/V25_PRODUCT_POLISH_INVESTIGATION.md`, `STATUS.md`.

---

## 0. Where the dashboard actually is today

Before deciding what it should become, an honest inventory of what it is:

- **Two implementations of one concept.** Personal Spaces render through `DashboardClient`; every other Space through `SpaceDashboard`. They share the fixed nine-tab rail (`lib/space-nav.ts`) but carry divergent internal tab vocabularies ("credit" vs "DEBT") and duplicate KPI/empty-state/gating logic.
- **A section-template engine underneath.** `SpaceDashboardSection` rows drive which widgets render; `SectionRegistry` maps keys to render functions; `lib/widget-registry.ts` holds metadata and data contracts (`meta.requires`, `dataTier`). The code itself documents a three-phase plan ending in "SpaceDashboard becomes a pure compositor."
- **A partially executed IA redesign.** The fixed rail (Overview / Perspectives / Timeline / Finances / Accounts / Transactions / Members / Documents / Settings) is live, with Goals/Debt/Investments/Retirement demoted to Perspective cards opening `GlassModal`s. Three of nine tabs on a shared Space render `SpaceComingSoonPanel`; the Timeline is padded with eight badged `FUTURE_TIMELINE_EVENTS` preview rows.
- **A voice that is ahead of the surface.** The product-language guide ("Calm, not urgent"; "Specific, not numerous"; honest trends only, per KpiRow's own doc comment) is unusually disciplined. The current dashboard's utilitarian feel is not a voice problem — it's that the voice hasn't yet been given anything to say beyond static balances.
- **Space-wide, not per-member, configuration.** `SettingsTab` toggles sections "for all members." There is no per-user view state.

"Works but feels utilitarian" is accurate, and the diagnosis matters: the dashboard is utilitarian because it is an **inventory** — a grid of stocks (balances, totals) with almost no flow (what changed), no attention (what needs me), and no narrative (what does this mean). Restyling the inventory will not fix that.

---

## 1. Challenging the paradigm: is "dashboard" the right mental model?

### 1.1 The case against the dashboard

The dashboard metaphor comes from machines the operator watches continuously. Personal finance is the opposite: the correct amount of daily attention for a healthy financial life is *near zero*. A grid of always-on gauges optimizes for a behavior — daily balance-staring — that the product's own voice guide says it doesn't want to encourage, and that behavioral research says is actively harmful (see §3.5).

Every widget-grid personal-finance dashboard converges on the same failure: the user opens it, scans fifteen numbers, finds that fourteen are unchanged, and learns nothing. The cost of finding the one meaningful change is paid by the user's eyes on every visit. Mint, Personal Capital, and every bank portal shipped this; none of them ever felt modern for long, because a static inventory can't.

### 1.2 The case for keeping (some of) it

The counterargument is trust. Money surfaces earn trust through **stable, verifiable numbers in stable places**. A fully generated, AI-narrated front page — the fashionable alternative — fails the ten-year test in the other direction: if the layout reorganizes itself around what the model thinks matters, the user can never build spatial memory, and a single confidently wrong sentence in the hero position poisons the entire product. `STATUS.md` is explicit that deterministic assessment exists but validation and test coverage are still maturing. The front door cannot be more confident than the data layer beneath it.

The fixed-rail comment in `lib/space-nav.ts` ("Accounts is always third across 50+ Spaces") is groping toward the right principle: **the skeleton must be boring so the content can be alive.**

### 1.3 Proposed mental model: the dashboard answers three questions

Replace "a grid of widgets" with "a surface that answers, in order, the only three questions a person has when they open a financial context":

1. **Am I okay?** — the state layer. A small, fixed set of headline numbers with honest trends. This exists today: `KpiRow` is exactly right in spirit (five tiles, real trends only, tap-through to provenance via GlassModal).
2. **What changed?** — the change layer. Everything that happened *since this member last looked*, ranked by materiality, not recency. This barely exists: the Timeline is a tab, padded with previews, with no per-member read marker and no materiality ranking.
3. **What needs me?** — the attention layer. Zero to three items, each with a reason and an action (stale connection, goal off-pace, unusual transaction, member request). Zero is a valid and *desirable* state — "Nothing needs your attention" is the calmest sentence a finance product can say. `OverviewBriefPanel` is the embryo of this layer.

Everything else — Perspectives, Accounts, Transactions, Documents — is the **study layer**: lenses you open deliberately, not gauges that watch you back. The current Perspectives concept already models this correctly; it's the right idea currently used as a routing shim to legacy tabs.

This is not a demolition of the current IA. It is a re-weighting: the current Overview is ~80% state / ~15% study / ~5% change. It should be ~30% state / ~40% change / ~15% attention / ~15% doorways to study. The paradigm shift is from **stock to flow**.

### 1.4 Self-disagreement, recorded

The change layer presumes changes worth surfacing. A user with two checking accounts and no sync events has quiet weeks — a change-dominant Overview would feel dead. Mitigation: the layers are proportional, not absolute; when the change layer is empty, the state layer expands, and the empty change layer says so in one calm line rather than padding itself (the `FUTURE_TIMELINE_EVENTS` padding is the anti-pattern already in the codebase — honest, badged, but synthetic; it should be treated as scaffolding to remove, not a pattern to extend).

---

## 2. Topic-by-topic evaluation

### 2.1 Information hierarchy & above-the-fold priorities

Above the fold, in order: identity strip (which Space, freshness of data), state layer (KPI strip — keep at 3–5 tiles, never more), attention layer (0–3 items), change layer preview ("since you last looked: 4 events, 1 material"). Below the fold: Perspectives doorway, study previews.

Two corrections to today's surface:

- **Data freshness must be first-class.** No KPI is trustworthy without an as-of timestamp. Balances synced 9 days ago presented next to today's date is the single most common correctness failure of aggregation dashboards (see advisor review, §3.3). The tile pattern should carry `as of` metadata visibly on staleness, invisibly when fresh.
- **The greeting + brief occupies hero position but is fed by a stubbed job.** `OverviewBriefPanel` parses the latest `AiAdvice` record; `run-ai-advice.ts` is a stub (STATUS.md D5). Until the advice pipeline is real and validated, the brief should degrade to deterministic content (assessment-engine facts) rather than hold prime real estate for a stale or absent LLM artifact.

### 2.2 Widget philosophy

The registry-with-data-contracts direction (`meta.requires`, `dataTier`, fallback to `ContextualCard`) is correct and should be finished — Phase 3 "pure compositor" is the right end state. Three philosophy commitments worth writing down:

1. **Widgets are answers, not charts.** Every widget must state the question it answers ("Can I cover 6 months of expenses?") and render nothing it can't defend with provenance. The empty-state discipline already in `ProgressWidget`/`SummaryWidget` (headline + subline + what-to-do) is the house standard; keep it.
2. **Config must grow a spine.** Widget config today is `Record<string, unknown>` coerced through `cfgNum`/`cfgStr` at render time. Ten-year widgets need versioned, typed config schemas validated at write time, or the compositor becomes a museum of defensive coercion.
3. **Kill the name-regex heuristics before they ship to strangers.** `property_value` matching `/home|house|condo/i` and `vehicle_value` matching `/cr-v|camry|f-150|tesla/i` against account names is a demo-era shortcut. It will misfire in public ("Tesla" the stock position vs the car) and the failure is silent — a widget confidently showing the wrong asset. Explicit account pinning (`config.accountId`, already supported) should be the only path; the heuristic should become a one-time *suggestion* in setup UI, never a render-time fallback.

### 2.3 Mobile vs desktop

They are different products sharing a data layer. Mobile is the **glance client**: state + change + attention only — the three questions, one screen, no tab rail. Desktop is the **study client**: lenses, tables, comparisons. The current nine-tab rail on a phone is a horizontal-scroll of mostly-empty tabs; that is not a responsive-design problem, it's a product-definition problem. Decide now, cheaply: the mobile Overview *is* the app; everything else is reachable but not chrome.

### 2.4 Personal vs Shared vs Business Spaces

The skeleton-is-identical rule (`space-nav.ts`) is right for muscle memory but wrong as a content strategy. The three types answer different core questions:

- **Personal:** "Am I okay?" — state-dominant, as designed.
- **Shared:** "What changed, and who did it?" — change-dominant. A shared Space is a *coordination* surface; the change layer with actor attribution ("Sam linked a savings account") is the product. Today shared Spaces are the *weakest* surface (Transactions renders the coming-soon panel; Members is read-only), inverted from where the differentiation lives.
- **Business:** "Do we have runway?" — cash-flow-dominant. Current BUSINESS presets (`business_cash_flow`, `business_accounts`) render generic account cards. A credible business dashboard needs cash position, burn/net flow, and obligations-ahead — but per D10, billing/marketplace scope is banned until v3.0, and a half-credible business surface is worse than an honest "Business Spaces are basic today." Recommendation: keep Business thin and labeled as such until after launch; do not let it drive dashboard architecture yet.

One correctness question to resolve during v2.5 seam work: graduated sharing (FULL / BALANCE_ONLY / SUMMARY_ONLY with read-time redaction) must be verified against **widget aggregates** — a `net_worth` widget that sums redacted balances into a visible total is a privacy leak through arithmetic. Whatever the answer is today, it should be pinned by a test before the dashboard grows more aggregates.

### 2.5 Empty states & the first-run problem

Per-widget empty states are already strong. The unsolved empty state is the **day-zero dashboard**: a new Space with no accounts is currently a stack of "share accounts to see X" cards — ten ways of saying the same thing. Day zero should render a single narrative setup surface (connect → see your first snapshot → set one goal), not the normal dashboard with all widgets in begging mode. The badged-preview pattern used by the Timeline is acceptable *only* here, at day zero, clearly labeled, and it must disappear permanently once real data exists.

### 2.6 Progressive disclosure

The KPI-tile → GlassModal pattern ("full picture behind this number, reusing existing logic, never a new computation") is the best idea in the current dashboard and should become a universal invariant: **every number on the dashboard answers "why?" in one tap** — decomposition, history, and provenance (which accounts, as of when, computed how). This is the UI expression of the provenance-first principle the AI layer already follows, and it is rare enough in consumer finance to be a durable differentiator. Ten-year framing: numbers users can interrogate age well; numbers users must trust blindly age into churn.

### 2.7 Customization & density

Argue against customization as commonly meant. User-arranged widget grids are a graveyard pattern: <5% of users ever rearrange, the feature freezes the layout engine, and it outsources the product's hardest decision (what matters) to the user. What Fourth Meridian should offer instead:

- **Curation by template** (D9 SpaceTemplate, parked): the template decides the widget set; the section enable/disable toggle (already shipped) is the escape hatch.
- **Per-member view state on shared Spaces** — the real gap. Section toggles currently bind all members; an OWNER's layout choice shouldn't dictate a VIEWER grandparent's reading experience. Per-member collapsed/expanded and density belongs to the member; *which sections exist* belongs to the Space.
- **Density:** one global comfortable/compact preference at most, applied through the design system rather than per-widget. The current 10–11px label scale is already at the compact limit; the future direction is *fewer elements*, not smaller ones.

### 2.8 Timeline placement & KPIs

The Timeline is currently a destination tab; it should become the **spine**. The change layer on Overview is the Timeline filtered by (a) since this member's last visit and (b) materiality, with the tab remaining as the full archive. This requires two primitives that don't exist: a per-member read marker, and real event producers (the `ALLOWED_ACTIONS` allowlist currently has no producers for transaction/document/account-linked/AI events — the V2.5 polish investigation already flags this). Timeline producers are therefore a prerequisite for the entire paradigm shift, which is why they rank high in §4.

KPIs: keep the five-tile discipline, vary the vocabulary by Space type (Personal: net worth / assets / liabilities / cash flow MTD / credit; Shared: shared net position / cash flow / goal pace / last activity; Business: cash / net flow / obligations ahead). Never show a daily delta on volatile assets by default (see §3.5); month-over-month is the default trend window, with the honest-trend rule (no baseline → no delta) kept as law.

### 2.9 Navigation & long-term scalability

Nine fixed tabs with three placeholders violates the product's own honesty ethos more than a shorter rail would violate muscle memory. Recommendation: rail earns tabs by having real content — Overview / Perspectives / Timeline / Accounts / Settings now; Transactions joins when real on shared Spaces; Finances and Documents join when they exist. Fixed *order* stays law; fixed *presence* should not be.

The ten-year scalability question is not within a Space — it's **across** Spaces. The HNW review (§3.4) argues the multi-entity user's daily surface is a portfolio-of-Spaces rollup that doesn't exist yet. The per-Space dashboard should be designed as a component that can be embedded/summarized by that future surface: every Space needs a canonical one-line summary contract (headline number + delta + attention count) — which is exactly the state+attention layers, reused. Design the three-question Overview and the cross-Space rollup falls out of it nearly for free.

### 2.10 Daily workflows

Design for three visit types, in frequency order: the **glance** (10 seconds, mobile, questions 1–3 — must require zero navigation), the **check** (2 minutes, follows a brief item or timeline event one tap deep), the **session** (20 minutes, monthly, study layer on desktop). The current dashboard serves the session tolerably, the check poorly (modals reached through tabs), and the glance not at all. Invert the investment.

---

## 3. Perspective reviews

### 3.1 End User

The fixed rail and calm voice are already better than category norms. But the daily-use loop is broken: opening a Space tells you what you *have*, not what *happened*, so there is no reason to come back tomorrow. Discoverability of the demoted tabs (Goals/Debt behind Perspectives) is a real regression risk — a modal behind a card behind a tab is three layers of indirection for a feature users previously had one tap away; watch this in usage data before deepening the pattern. Cognitive load favors the three-question model strongly: it gives the user a *reading order*, which grids never have. Delight, in this product's register, is not confetti — it's the dashboard saying "Nothing needs your attention" and being right.

**Conflict with §3.3:** users want fewer numbers; advisors want more. Resolved by disclosure depth, not density: few numbers on the surface, every number interrogable.

### 3.2 Principal Engineer

Four positions:

1. **No redesign lands on two implementations.** DashboardClient/SpaceDashboard convergence into the registry-driven compositor is the gating refactor; redesigning first doubles every change. The V2.5 polish investigation notes this as the largest inconsistency source; this investigation promotes it to a hard prerequisite.
2. **The section/widget registry is the right architecture and is already half-built.** Finishing Phase 3 (compositor reads registry, dispatches generically) plus typed/versioned widget config is what makes the ten-year dashboard cheap to evolve. The alternative — one-off widgets fetching in components, coordinating through `window` events (`SPACE_GOALS_CHANGED_EVENT`) — is already showing strain at 2,287 lines.
3. **The change layer is an event-sourcing commitment.** Per-member read markers, materiality scoring, and event producers touch API routes and jobs (D5 scheduler substrate), not just UI. Scope it honestly: it is a v2.6-class investment, not a polish item.
4. **Technical debt watchlist:** untyped config blobs, render-time regex heuristics, fetch-per-widget waterfalls (sections + goals + activity + accounts as separate client fetches), and no route-level `loading.tsx`. All are cheap now, expensive after the compositor ships.

### 3.3 Professional Wealth Manager / Financial Advisor

The dashboard's numbers are honestly labeled ("Net worth across all shared accounts") — good. But professional-grade correctness needs three things the surface lacks: **as-of dates on every figure** (an aggregation dashboard without freshness indicators would fail any advisory-tool evaluation); **stated assumptions on projections** (the retirement FV uses simplified annual compounding at a config'd return — fine, but the assumption set must be visible at the point of display, not buried in Settings); and **clear scope framing** (a Space's "net worth" is the net of *shared accounts in this Space*, which is a view, not a balance sheet — the moment Spaces multiply, users will misread partial views as totals; the future cross-Space rollup is where "total net worth" may appear, nowhere else). Workflow realism: the debt payoff summary ("debt-free in approximately X years at minimums") is the most advisor-like sentence in the product — more of that, always with the assumption trail. Client usefulness of the change layer is high: "what changed since last review" is literally the structure of an advisory meeting.

### 3.4 High-Net-Worth Individual

This user has an LLC, two trusts, a household, and a brokerage relationship — i.e., six Spaces — and their first question is never inside a Space; it's **across** them. Today each Space is an island and the cross-entity view doesn't exist. For this segment: the portfolio-of-Spaces rollup (one row per Space: headline, delta, attention count, freshness) is the actual dashboard; per-Space surfaces are drill-downs. Privacy is structural, not preferential — graduated sharing and the aggregate-redaction question (§2.4) are make-or-break; a family-office assistant with VIEWER access must be *provably* unable to reconstruct redacted balances from widget math. Time efficiency: this user will not click nine tabs across six Spaces; the glance workflow (§2.10) times six is their entire usage. The Spaces primitive is the product's structural advantage for this segment over every single-ledger competitor; the dashboard roadmap should treat multi-Space stewardship as a first-class scenario, not an edge case.

**Conflict with §3.1:** the mainstream user has one Space and needs depth inside it; the HNW user has many and needs breadth across them. These are different home pages. The three-question contract resolves it only if the Space summary contract (§2.9) is built — then breadth is composition of depth.

### 3.5 Wildcard: Behavioral Economist

Chosen because a finance dashboard is fundamentally an *attention allocation device*, and the failure modes of this product category are behavioral, not technical.

- **Myopic loss aversion:** the more often people check volatile portfolios, the more losses they experience psychologically and the worse their decisions get. A dashboard that rewards daily checking of investment balances is a harm engine. Design consequences: default trend windows of a month or more; no daily deltas on volatile assets; never badge or notify on market movement alone. The product-language guide already believes this; the dashboard must enforce it structurally.
- **The ostrich effect:** people avoid looking at finances when they fear bad news — the users who most need the product open it least. The change layer is the counter-measure: "3 events, nothing needs your attention" makes opening the app *safe*. The attention layer's ceiling (max 3 items) is not a style choice; it's what keeps the anxious user coming back.
- **Salience beats intention:** whatever is above the fold *is* the product's advice, whether intended or not. Putting net worth first tells users net worth is what to optimize. Worth an explicit decision per Space type (§2.8) rather than an inherited default.
- **Peak-end rule:** sessions are remembered by their most intense moment and their end. End every Overview visit with a stable, calm closing element (the "all clear" line), not an infinite feed. Feeds are the attention economy's pattern; a finance product that feels like a feed in 2036 will feel predatory.

**Conflict with growth instincts:** engagement-maximizing dashboards monetize better short-term. This product's stated identity (calm, trustworthy) is a bet that *trust compounds better than engagement*. The behavioral view says: hold that line even when metrics tempt otherwise — it is also the only posture that still looks modern in ten years.

---

## 4. Sequenced direction (for later approval — not a work order)

1. **v2.5 (during already-chartered seam/design work):** dashboard implementation convergence groundwork (registry compositor), rail-earns-tabs (hide placeholder tabs), aggregate-redaction verification test, kill regex asset-matching fallback, day-zero setup narrative.
2. **v2.5.5 (financial-intelligence milestone):** as-of freshness on all KPIs, assumption disclosure on projections, typed widget config, per-Space-type KPI vocabularies.
3. **v2.6 (advisor/ambient milestones):** the paradigm shift proper — timeline producers + per-member read markers + materiality ranking → "since you last looked" change layer; attention layer fed by the deterministic assessment engine first, LLM narration only after D5/AI-4 validation is proven; mobile glance surface.
4. **v3.0/later:** cross-Space portfolio rollup (HNW surface), Business Space credibility pass, per-member view state, Documents/Finances tabs re-earning their rail slots.

---

## 5. Concluding answers

**1. What would make this genuinely differentiated from every other personal finance app?**
Two things no incumbent structurally has. First, **multi-entity stewardship**: Spaces are the only primitive in the category built for the person who manages a household *and* an LLC *and* a parent's finances — and the dashboard direction that exploits it is the three-question contract per Space composed into a cross-Space rollup. Second, **interrogable numbers**: every figure one tap from its provenance (which accounts, as of when, computed how, assuming what). Competitors show numbers; a fiduciary-grade surface lets you *audit* them. Calm + auditable + multi-entity is a position nobody in consumer fintech occupies.

**2. What is the biggest risk or downside?**
Shipping the narrative front door before the data layer deserves it. The change/attention layers put generated and derived statements in hero position; today the advice job is a stub, timeline events are preview-padded, validation coverage is still maturing, and the redaction-in-aggregates question is open. A calm dashboard that is confidently wrong once — a stale balance presented as fresh, a leaked redacted total, an off-base "attention" item — burns exactly the trust the whole strategy is built on. Secondary risk: performing the redesign atop two divergent dashboard implementations, paying for everything twice.

**3. Should this ship in v2.5, v2.6, v3.0, or later?**
Staged, per §4 — but the paradigm shift itself (change layer + attention layer as the Overview's center of gravity) is **v2.6**. It depends on scheduler substrate (D5), timeline producers, and validated advice output, all of which are v2.6-era by the existing ladder. v2.5 should be limited to convergence, honesty (hide placeholders), and correctness groundwork; pulling the mental-model change into v2.5 would repeat the over-scoping failure the V2.5 polish investigation already warned about. The cross-Space rollup is v3.0 or later.

**4. If you could only keep one idea, which and why?**
**"Since you last looked" — the per-member change layer as the dashboard's center of gravity.** It is the one idea that simultaneously: converts the dashboard from stock to flow (the paradigm fix), gives users a daily reason to return without engagement-bait (the behavioral fix), is the coordination surface shared Spaces are missing (the differentiation fix), works on a phone in ten seconds (the mobile fix), and composes upward into the HNW cross-Space rollup (the scalability fix). Every other recommendation in this document either supports it or survives without it; nothing replaces it.

---

*End of investigation. No implementation performed.*
