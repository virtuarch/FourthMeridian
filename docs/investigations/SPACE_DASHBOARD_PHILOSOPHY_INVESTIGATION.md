# Space Dashboard Philosophy — Investigation

**Status:** Investigation only — no code, schema, migrations, or UI changes.
**Date:** 2026-07-03
**Predecessor:** `SPACE_DASHBOARD_FUTURE_INVESTIGATION.md` (the three-question model, honesty findings). This document does not re-argue what that one settled; it goes one level deeper — to the design philosophy — and one level more concrete — to the chart.
**Evidence base:** `prisma/schema.prisma` (SpaceSnapshot), `lib/snapshots/regenerate.ts`, `lib/data/snapshots.ts` (getRecentSnapshots, getSpaceNetWorthSummaries), `components/charts/*` (NetWorthChart, NetWorthChartModal, ChartFirstDayPlaceholder, CashChart, InvestmentsChart, AllocationChart), `components/dashboard/{DashboardClient,SpaceDashboard}.tsx` post-honesty-slices, `lib/space-presets.ts`, `lib/widget-registry.ts`, `fourth-meridian-product-language.md`.
**Constraint compliance:** no assumed AI capabilities, Perspective Engine completion, Financial Story, or "since you last looked." Every recommendation below runs on deterministic data that exists today, and states explicitly where it would later hand off to that future architecture.

---

## 0. The question behind the question

"What should every Space feel like when a user opens it?" has a one-sentence answer this document will defend and then stress-test:

> **Opening a Space should feel like opening a ledger that has been kept faithfully in your absence — the story of this entity's money, already up to date, with today as the latest entry.**

Three words in that sentence carry the philosophy. *Ledger*: the surface is a record, not a control panel — trustworthy, chronological, complete. *Faithfully*: nothing on it is performed, padded, or projected without saying so (the honesty work made this a shipped value, not an aspiration). *Story*: the organizing spine is time. Which is exactly why the chart question is the right question.

---

## 1. The chart: evidence before philosophy

The strongest fact discovered in this investigation: **the chart philosophy is already three-quarters built, and the missing quarter is presentation, not architecture.**

- `SpaceSnapshot` belongs to the **Space**, not the user — every Space, shared or personal, accrues daily rows with pre-computed `netWorth`, `totalAssets`, `debt`, `cash`, `savings`, `stocks`, `crypto`, `netLiquid`.
- `lib/snapshots/regenerate.ts` upserts today's row on every balance-changing operation and share change, resolving membership through SpaceAccountLink — the seam-closure work made snapshots correct for shared Spaces by construction.
- `getSpaceNetWorthSummaries` already draws **per-Space sparklines on the Spaces landing page**. The platform already believes every Space has a trend — it just whispers it on a card instead of saying it inside the Space.
- `ChartFirstDayPlaceholder` already solves the day-one problem honestly (one snapshot can't draw a line; show the real number and say history starts today).
- And yet: `SpaceDashboard.tsx` — every non-personal Space — renders **no historical chart of any kind**. The Personal Space has NetWorthChart at its center; a Household or Debt Space, backed by the same snapshot table, opens onto a stack of current-balance cards with no memory.

So the question is not "should we build history into Spaces?" — history is already being recorded for all of them. The question is whether to make it the face of the Space. The data layer has already voted yes.

### 1.1 Q1 — Should every Space have a primary chart?

**Yes, as an earned default, not a mandate.** The principle worth adopting:

> **Every Space has a primary trend; the trend earns pixels only when it can tell the truth.**

Two qualifiers do the work. *Primary trend* (not "chart"): the commitment is that each Space has one canonical historical series that defines it — the thing this Space is *about*, moving through time. *Earns pixels*: rendering rules follow data honesty — zero snapshots → setup state; one snapshot → ChartFirstDayPlaceholder's pattern (real number, "your history starts today"); a short flat series → headline number with a quiet sparkline, not a dead horizontal line pretending to be information; a real series → the full hero chart.

Data-availability tiers for the proposed per-type metrics, against the actual SpaceSnapshot columns:

| Space type | Primary trend | Backed today? |
|---|---|---|
| Personal | Net worth | ✓ shipped (NetWorthChart) |
| Household / Family | Net worth of shared accounts | ✓ same query, surface unbuilt |
| Investment | Portfolio value (`stocks + crypto`) | ✓ column exists (`total`) |
| Debt payoff | Remaining balance (`debt`), inverted framing: progress down | ✓ column exists |
| Emergency fund / Trip | Savings balance vs target line | ✓ (`savings`; target from section config) |
| Business | Cash position today; revenue/runway later | ◐ `cash` ✓; revenue/burn need transaction-derived series — deterministic but not snapshot-backed yet |
| Property | Value and equity | ✗ real assets fold into `totalAssets` with no own column; equity needs the value−mortgage pairing. Honest gap. |
| Goal | Progress toward completion | ✗ no goal history table; progress bar today, trend later |

The recommendation writes itself: **ship Tier 1 (✓ rows) as the shared-Space hero; render Tier ◐/✗ Spaces with the headline number and an honest "history for this metric isn't tracked yet" rather than a wrong chart.** Business runway and property equity are the two places where an eager chart would *lie* — runway requires a defensible burn definition, equity requires liability linkage — and a wrong trend on the front door of a Space is worse than no trend (see advisor review, §3.3). When Perspective Engine and richer snapshot semantics arrive, those tiers upgrade without the philosophy changing.

**Self-disagreement, recorded.** The counterargument: some Spaces are genuinely *stock-like*, not *flow-like*. A Space holding one manually-updated vehicle has a step function for a history — charting it is ceremony. This is correct, and it's why the principle says *earned*. The failure mode to refuse is the one incumbents ship: a chart frame drawn on every page because the template has a chart slot, displaying a flat line or thirty days of noise. The variance-aware rendering rules above are the enforcement mechanism.

### 1.2 Q2 — Should the chart always be the visual centerpiece?

**Centerpiece by default; never alone; demoted gracefully.** Three refinements to the strong version of the philosophy:

1. **The hero is a fused unit, not a chart.** Headline number + delta + trend, one composition — the number answers "where am I?", the line answers "how did I get here?" A chart without its number forces reading an axis; a number without its trend is the inventory problem the predecessor investigation diagnosed. The KpiRow → chart-modal pairing on Personal already discovered this unit; the philosophy names it.
2. **Mobile inverts the ratio, not the order.** On a phone the hero is the number with a sparkline; the full chart is one tap deep. Same unit, responsive emphasis.
3. **The chart yields to attention when attention exists.** The one legitimate thing that may ever sit above the hero is a true attention item (broken connection, goal off-pace). A trend is the resting state of the Space; a problem is an interruption of it. This ranking — interruptions above state, state above everything else — is what makes the dashboard feel *kept* rather than *displayed*.

### 1.3 Q3 — Where am I → What changed → What needs attention: in that order?

Endorse the three questions; **reorder the presentation: attention (when present) → state → change.** The predecessor investigation put state first and this investigation keeps that for the *default* visit — but "what needs attention" cannot be third *positionally* when it exists, or the dashboard buries the lede below two sections of calm. The resolution: attention is capped (0–3 items) and usually empty, so the *typical* open is exactly state → change; the *exceptional* open leads with the exception. Both orderings are the same policy: **the dashboard is sorted by how much the user's action matters, and on a good day nothing does.** Without "since you last looked" (excluded by constraint), "what changed" is served deterministically by the existing timeline preview and the hero chart's delta — adequate now, upgraded later without rework.

---

## 2. The remaining questions

### 2.1 Q4 — Widget grid vs curated narrative

Neither. The long-term direction is a **curated composition on a widget substrate**:

- **Substrate (keep):** the section/widget registry with data contracts (`meta.requires`, `dataTier`) is the right architecture and survives the decade. Widgets remain the unit of implementation, testing, and data honesty.
- **Composition (change):** the *Overview* stops being "whichever enabled sections stack up in order" and becomes a fixed, named composition with slots: hero (primary trend unit) → attention (0–3) → change preview → the Space type's two or three signature modules → doorways. Slots are curated per Space type by the template (the existing `space-presets` mechanism, matured); users toggle modules, never rearrange slots.
- **Narrative (defer, explicitly):** prose that *tells* the story is Financial Story's job, which this investigation is barred from assuming. The correct present-tense move is to make the dashboard *narratable* — chronological spine, provenance everywhere — so that when narrative arrives it describes the surface rather than replacing it.

The argument against user-arranged grids stands from the predecessor investigation and hardens here: a grid is a confession that the product doesn't know what matters. A ledger knows its own layout.

### 2.2 Q5 — Overview vs Perspectives vs Meridian Analyst

One verb each: **Overview shows. Perspectives explore. Analyst explains.**

- Overview holds only what can be *read in ten seconds without interpretation*: the hero unit, attention, recent change, doorways. If an element requires scrolling to understand the state of the Space, it belongs elsewhere.
- Perspectives hold everything a user *chooses* to study: allocations, holdings, payoff planning, category depth. Deliberate, sessional, desktop-weighted. (No assumption of the Perspective Engine — today's routed-modal Perspectives already satisfy the *placement* rule; the engine will satisfy the *depth* rule later.)
- Analyst (future) owns *why* and *what if*. The boundary discipline that matters now: **nothing on the Overview should ever need a conversation to be trusted** — that's what keeps the dashboard deterministic as AI surfaces grow around it.

### 2.3 Q6 & Q7 — Day zero, and how empty should feel

Day zero is now decent (the consolidated setup card shipped in the honesty slice). The philosophy adds a *sequence*: **day zero → day one → trend is the product teaching its own mental model.** Day zero: one setup card, one promise — "everything here will be computed from real data." Day one (first snapshot): the ChartFirstDayPlaceholder pattern promoted to the hero slot — a real number and the sentence *"Your history starts today."* That sentence is the whole philosophy in four words, delivered in the first session. Days after: the line begins.

Empty Spaces should feel **prepared, not barren** — an empty ledger book rather than a broken screen: the structure visible, the first entry invited, zero synthetic content. The distinction to enforce in copy: *empty* ("nothing yet — here's how it starts") is a state; *broken* ("something should be here") is a bug. Every empty state should be unambiguous about which it is.

### 2.4 Q8 — Differentiation by Space type without fracturing the product

**Same skeleton, same slots, different protagonist.** The rail order stays fixed (shipped law). The Overview composition slots stay fixed. What varies per type is (a) the hero metric — the table in §1.1, (b) the two or three signature modules the template enables, and (c) the vocabulary of the KPI strip. A Debt Space and an Investment Space should feel like the same product telling different stories, the way two chapters of one book share a typeface. This is also the cheapest possible differentiation to maintain: it's configuration over the same components, which the presets system already expresses.

One deliberate inversion per type is worth specifying: **the Debt Space's hero trend should be framed as progress, not balance** — the same `debt` series, plotted as distance traveled from the starting balance. Identical data, inverted emotional valence; the single cheapest "delight" in the entire roadmap.

### 2.5 Q9 — What should become secondary or disappear

- **The Perspectives row on Overview** — demote below the hero/change layers or remove from Overview entirely; it duplicates a rail tab one tap away and is doorway-chrome occupying story space. (Keep the tab.)
- **AllocationChart vs HoldingsDonutChart on Personal** — two donuts of overlapping meaning on one surface; consolidate to one with a scope toggle. Secondary.
- **OverviewBriefPanel in hero-adjacent position** — its pipeline is a stub (D5); until real, it should not hold prime slots in the new composition. Returns when the data deserves it (the honesty rule, applied to AI).
- **Name-regex asset widgets** (`/camry|f-150|tesla/i`) — restated from the predecessor investigation: pinned config only; the heuristic dies before strangers use it.
- **The five-tile KpiRow, partially** — Total Assets and Total Liabilities tiles become chart-series toggles on the hero (they already open the same modal with different series); the strip slims to the per-type vocabulary. The *discipline* of the KpiRow is preserved; the redundancy is not.

### 2.6 Q10 — What is strongest and must be preserved

In priority order: (1) **the honest-trend rule** — no baseline, no delta; nothing fabricated (KpiRow's doc comment is the constitution of the product; the honesty slices extended it platform-wide); (2) **number → provenance in one tap** (tile → GlassModal reusing real chart/logic — the pattern that should become a universal invariant); (3) **the empty-state discipline** (emptyHeadline/subline/action triple, ChartFirstDayPlaceholder); (4) **SpaceSnapshot as pre-computed, Space-owned history** — the architectural decision this whole philosophy stands on, made years before it was needed; (5) **the fixed rail + rail-earns-tabs**; (6) **the Atlas Glass token system** and the calm voice. Notably, everything on this list is an *honesty mechanism*. The product's strongest asset is that its best patterns all point the same direction.

---

## 3. Perspective reviews

### 3.1 End User

The hero-trend unit is the single highest-delight, lowest-cognitive-load proposal available: a line going the right direction is understood pre-verbally, faster than any number. Discoverability improves because the composition gives the page a reading order (today's section stack has none). Daily usefulness: honest concern — a net-worth line moves slowly; the *daily* reason to open remains the change layer, and on quiet weeks the hero is pleasant but static. That's acceptable (calm product) but should temper expectations: the chart is the *identity* of the Space, not its retention engine. Watch one regression risk: slimming the KPI strip must not hide Total Liabilities from users who orient by it — series toggles must be visible, not buried in a menu.

### 3.2 Principal Engineer

Strongly in favor, with three conditions. (1) **One hero component, config-driven** — `SpaceTrendHero` consuming a series key + framing (up-is-good/down-is-good) + target line, fed by the existing `getRecentSnapshots`; per-type variation is data, not forks. The two-host problem (DashboardClient vs SpaceDashboard, still unconverged) means the hero should be built once as a shared widget and mounted in both, *ahead of* full host convergence — it then becomes the anchor around which convergence happens rather than another thing to converge. (2) **Snapshot semantics are the real long-term liability**: SpaceSnapshot's columns encode a 2024 taxonomy (stocks/crypto/cash/savings/debt); business revenue, property equity, and goal progress don't fit. Resist stuffing them in as more Float columns ad hoc — when Tier ◐/✗ metrics ship, that's a deliberate schema evolution (future, approved separately), not a quick add. The comment drift already found in `regenerate.ts` (realAssets included in totals while schema comments say otherwise) is the early-warning form of this rot; fix the comments when next touching the file. (3) **Backfill honesty**: snapshots regenerate on activity — sparse activity means sparse series; the chart must render gaps as gaps (the existing charts already handle this; keep it a tested invariant, not an accident).

### 3.3 Professional Wealth Manager / Financial Advisor

The trend-first philosophy matches how professionals actually present: every client review opens with the portfolio line. Three correctness demands, all hard requirements: (1) **scope labeling on the hero** — a Household Space's line is "net worth of accounts shared with this Space," and the hero must say so; partial views presented as totals are the classic aggregation-dashboard malpractice; (2) **as-of discipline** — the header freshness line (shipped) must bind to the chart: a line whose last point is nine days old needs that visible at the chart, not just in the header; (3) **refuse the Tier ✗ charts** — a runway number without a defensible burn definition, or an equity line without liability linkage, would be *professionally embarrassing*; the tiering in §1.1 is not conservatism, it is table stakes. One enthusiastic addition: the debt-as-progress inversion (§2.4) is precisely how advisors reframe payoff psychology with clients; it is behaviorally literate finance, rare in software.

### 3.4 High-Net-Worth Individual

Per-Space hero trends are necessary but not sufficient for this segment: six entities means six lines, and the daily question is "which of my Spaces moved?" The philosophy scales correctly *because* the hero unit doubles as the Space's summary contract — the Spaces landing page's sparkline cards (already shipped!) are the embryonic cross-entity rollup, and the hero standardization makes every Space export the same headline+trend+attention triple. Privacy note that becomes sharper with charts: **a trend can leak what a redacted balance hides** — a BALANCE_ONLY or SUMMARY_ONLY member seeing a Space-level line that steps when a hidden account updates is an inference channel. The hero must be computed against the viewer's visibility tier, not the Space's full holdings; this must be pinned by a test before the shared-Space hero ships. Time efficiency: strongly favors chart-first — a line is scanned in under a second per Space; six numbers with deltas are not.

### 3.5 Wildcard: Information Designer (Tufte school)

Chosen because this investigation's central proposal is a *visualization* mandate, and the strongest available critique is the one that takes charts seriously enough to oppose bad ones.

The critique: **most dashboard charts are dead ink** — decoration wearing the costume of information. The hero mandate will fail in either of two ways if enforced naively: flat lines (low-variance Spaces: a line that says nothing, daily) and noise (30-day windows on lumpy series: salary spikes read as trends). The design consequences: (1) **default windows must match each metric's natural frequency** — net worth is a quarterly story, cash flow monthly, debt payoff the full payoff arc since inception; a single default "1M" window across all Spaces (the current Personal default) is wrong for most of them; (2) **honest axes** — starting the y-axis at the data minimum exaggerates change; for *identity* charts (what this Space is), context beats drama: include zero or the starting balance as an anchor where the metric allows; (3) **the sparkline is not a lesser chart** — for low-variance Spaces it's the *correct* chart: word-sized, in the hero, no axes to lie with; the variance-aware rendering ladder in §1.1 should be understood as choosing the right graphic, not degrading gracefully; (4) **one line, not four** — the hero plots the primary series only; assets/liabilities/cash as toggles, never simultaneous spaghetti. Where this perspective *conflicts with the End User's* desire for a big beautiful chart on every Space: the tradeoff is real and should resolve toward truth — a Space whose story is "nothing is happening" should look calm, not instrumented. That, too, is the ledger feeling.

---

## 4. Conclusions

**1. What would make Fourth Meridian's Space dashboards genuinely differentiated?**
Every other finance product draws one chart of one person's money. Fourth Meridian's structural bet — Spaces — lets it be the platform where **every entity you steward keeps its own faithful, interrogable history**: a household with a memory, a debt with a visible arc toward zero, a business with a line you'd show a partner — each scoped-labeled, provenance-backed, computed against your visibility tier, and composing upward into a portfolio of stories on the landing page. Chart-first is common; *ledger-faithful, multi-entity, trend-per-context* is unoccupied ground. The honesty discipline already shipped is what makes it defensible: anyone can draw lines; the differentiation is lines you never have to doubt.

**2. What is the biggest risk in redesigning them?**
**A hero chart that lies politely.** The mandate creates pressure to fill the slot for every Space type, and the two failure modes — fabricated smoothness over sparse snapshots, and confidently wrong Tier ✗ metrics (runway without a burn definition, equity without liability linkage) — would each spend the trust the honesty slices just earned, in the most prominent pixel of the product. The mitigations are the tier gate (§1.1), the variance-aware rendering ladder, and the visibility-tier computation test (§3.4). The secondary risk is unchanged from the predecessor investigation: redesigning atop two unconverged dashboard hosts and paying for everything twice — mitigated by building the hero once as a shared widget (§3.2).

**3. Should this redesign begin in v2.5, v2.6, v3.0, or evolve incrementally?**
**Incrementally, starting now — because it isn't a redesign.** The substrate (per-Space snapshots, chart components, day-one placeholder, sparkline summaries) exists; the philosophy is a sequencing of surfaces: Tier-1 shared-Space hero (Household/Investment/Debt/Savings trends) fits v2.5's polish charter as composition of shipped parts; KPI-slimming, Overview slot composition, and the debt-progress inversion in v2.5.5; attention-slot and host convergence around the hero in v2.6; Tier ◐/✗ metrics (business, property, goals) only when their data semantics arrive, likely v3.0-era. A big-bang v3.0 redesign is the one option to refuse — it would defer cheap, ready value and then ship it with maximum risk.

**4. If you could preserve only one design principle for the next decade?**
> **Nothing appears on a Space dashboard that the data cannot defend.**
No fabricated trend, no padded timeline, no dead control, no metric without provenance, scope, and freshness. Every strong pattern the product has shipped — honest deltas, earned tabs, preview-free timelines, day-one placeholders — is an application of this one rule, and every future capability (Perspective Engine, Meridian Analyst, Financial Story) can be evaluated against it with a yes or no. The chart philosophy is this principle's most visible expression: a Space's history, kept faithfully, is the most defensible thing a financial product can show — which is exactly why it deserves the center.

---

*End of investigation. No implementation performed.*
