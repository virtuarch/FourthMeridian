# Space Template Redesign — Investigation

**Status:** Investigation only — no code, schema, migrations, or UI changes.
**Date:** 2026-07-03
**Predecessors:** `SPACE_DASHBOARD_FUTURE_INVESTIGATION.md` (three questions, honesty), `SPACE_DASHBOARD_PHILOSOPHY_INVESTIGATION.md` (ledger philosophy, hero unit, chart tiers). This document assumes both and goes one level deeper: from "what is a Space dashboard" to "what is *this* Space's dashboard."
**Evidence base:** `lib/space-presets.ts` (PRESET_MAP, all 15 categories), `prisma/schema.prisma` (SpaceCategory, SpaceSnapshot), `components/dashboard/SpaceDashboard.tsx` (SectionRegistry — which section keys have real renderers vs `ContextualCard` fallbacks), `lib/snapshots/regenerate.ts`, `lib/data/transactions.ts` + `lib/data/transactions.privacy.test.ts` (KD-15 visibility predicate), `lib/ai/visibility.ts` semantics, `components/dashboard/widgets/{OverviewBriefPanel,SpaceTransactionsPanel}.tsx`, `fourth-meridian-product-language.md`, `STATUS.md` (D5 advice-job stub).
**Constraint compliance:** every recommendation runs on deterministic data that exists today; evolution paths to Perspective Engine / Meridian Analyst / Financial Story are noted but never assumed.

---

## 0. Two findings that reframe the exercise

Before defining templates, two pieces of evidence change what "redesign" means here.

**Finding 1 — the current presets ship permanent empty states.** Cross-referencing `PRESET_MAP` against `SectionRegistry` shows that several preset sections have *no implemented renderer* and fall through to `ContextualCard` — a styled "not available yet" card. The Personal preset ships two of them (`cash_flow`, `savings_rate`); Business ships `business_cash_flow` — its *first-listed* section is an empty card. These are template-level violations of the honesty principle the dashboard slices just enforced everywhere else: the template *promises* a story the product cannot tell. Whatever else this investigation concludes, **presets must only reference implemented, data-backed sections** — the "rail earns tabs" rule applied one level down: *the template earns its modules.*

**Finding 2 — the Space's own snapshot is more expressive than the philosophy doc assumed.** `SpaceSnapshot.netWorth` is computed per Space from that Space's linked accounts. For a well-scoped single-entity Space this changes the chart tiers: a Property Space containing the property (manual asset) and its mortgage (debt) has `netWorth` = value − mortgage = **equity, already historically tracked**. A Debt Space's `debt` column is the payoff arc. The philosophy doc's "Tier ✗: Property" was too pessimistic — the gap is not data, it's that nothing renders it. (The honest caveats stand: manual-asset histories are step functions and must be drawn as steps, and a Property Space polluted with unrelated accounts breaks the equity identity — templates should say what belongs in them.)

With those in hand, the template question becomes concrete: each template is an **editorial decision about one story**, composed from slots the infrastructure already supports.

## 0.1 The template contract (shared across all types)

Every template fills the same five slots, in the same order — differentiation is *what* fills them, never *where*:

1. **Hero** — headline metric + delta + historical trend (the fused unit; variance-aware rendering ladder from the philosophy doc).
2. **Attention** — 0–3 deterministic items (stale connection, over-limit, goal off-pace); usually empty, always capped.
3. **Signature modules** — at most three; the modules that make this Space type *itself*.
4. **Change preview** — recent activity (timeline preview; real events only).
5. **Doorways** — everything else, one tap away (Perspectives, tabs).

Rule of thumb enforced throughout: **if a module doesn't serve the hero's story, it moves to a doorway.**

---

## 1. Per-type templates

### 1.1 Personal — "How am I doing?"

**Hero:** Net Worth, trend (shipped). Correct; keep. **Chart:** the existing NetWorthChart, with the philosophy doc's window correction (net worth is a quarterly story; 1M default undersells it).
**Below hero:** attention → cash flow MTD (KPI tile until a real cash-flow module exists) → allocation → recent transactions preview → activity preview.
**Signature modules:** Allocation (yes — see §4), Recent Transactions (yes — Personal is a flow Space, §2), Daily Brief slot *only when D5 ships* (§3).
**Disappear from template:** `cash_flow` and `savings_rate` preset sections (unimplemented, permanent empty cards — Finding 1); the second donut (HoldingsDonut vs Allocation overlap — one donut, scope toggle).
**Perspectives instead:** holdings detail, debt breakdown, retirement progress, credit.

### 1.2 Household / Family — "Are *we* on track, and who did what?"

**Hero:** Household net worth (shared accounts), scope-labeled ("across accounts shared with this Space" — the advisor's non-negotiable). Backed today by SpaceSnapshot.
**Chart:** yes — the same netWorth series; this is the highest-value unshipped chart in the product (the data exists, the surface doesn't).
**Below hero:** attention → **member-attributed activity** (promoted above transactions here — coordination is the story) → shared cash flow → transactions preview (scope-labeled, FULL-shared accounts only).
**Signature modules:** member-attributed activity, shared goals (GoalsCard — already real), transactions preview.
**Allocation:** *not* signature here — contra the prompt's suggestion. A household's story is flow and obligations, not asset mix; allocation of a partial account set is also the most misreadable chart in a shared context. Available via Perspectives.
**Disappear:** `savings_rate`/`cash_flow` stubs; `debt_payoff_tracker` (renders a debt summary alias — misleading label).
**Perspectives instead:** allocation, debt breakdown, per-member views.

### 1.3 Business — "Do we have cash, and which way is it moving?"

**Hero:** Cash position (`cash + savings` of business accounts), trend. Deterministic today. **Not** revenue or runway — both need a defensible derived series (burn definition, revenue recognition from transaction classification) that doesn't exist; a wrong runway number on a business's front page is the single most professionally embarrassing failure available (philosophy doc §3.3). Runway is the *evolution path*, not the launch metric.
**Chart:** yes — cash trend. Distinct framing: the y-axis anchor should include the "months of obligations" context once monthly-rollup data is surfaced deterministically.
**Below hero:** attention → in/out this month (deterministic monthly rollups exist in the AI assembler layer; surfacing them as a widget is derivation reuse, not new intelligence) → obligations (debt summary) → transactions preview (business is the *most* flow-identified Space type).
**Signature modules:** cash in/out, obligations, transactions preview.
**Disappear:** `business_cash_flow` stub (Finding 1 — replace with the real rollup widget when built, until then nothing), `investment_summary` (present in today's Business preset; a business Space with a brokerage account is an edge case, not a signature).
**Perspectives instead:** allocation, investments, member/roles.

### 1.4 Investment — "What is the portfolio worth, and what's it made of?"

**Hero:** Portfolio value (`stocks + crypto` = snapshot `total`), trend. Backed today.
**Chart:** yes — but with the behavioral guardrail at its strongest: monthly default window, no daily-delta badge; this is the Space where myopic loss aversion does real damage.
**Below hero:** attention → allocation (signature #1 — the one Space where composition is half the story) → holdings → activity preview.
**Signature modules:** Allocation, Holdings.
**Transactions:** *not* on the dashboard — trades belong in a Perspective (§2). An investment Space's transaction list is noise (dividends, sweeps) punctuated by rare intentional events; the intentional events belong on the timeline, not in a raw row list.
**Disappear:** `net_worth` and `cash_flow` from today's Investment preset (net worth duplicates the hero with a broader, confusable scope; cash flow is a stub).

### 1.5 Debt Payoff — "How far have I come, and when am I free?"

**Hero:** Remaining balance — **plotted as progress, down-is-good, anchored at the starting balance** (the inversion from the philosophy doc; same `debt` series). Headline: remaining amount; delta: paid down this month; the payoff-date estimate (`simulatePayoff`, already real) as the hero's subline — the most motivating deterministic sentence the product can compute.
**Chart:** yes — the payoff arc since Space creation. **On the prompt's suggestion of composition *instead* of trend: keep both, ranked.** Composition (the existing debt-breakdown donut) answers "what am I fighting"; the trend answers "am I winning." A Space about *payoff* is about winning — trend is the hero, composition is signature module #1. Replacing history with composition would delete the only chart whose slope is the user's own behavior.
**Below hero:** attention (missed-payment/over-limit signals when producers exist; until then APR-weighted "minimums may not cover interest" warning — already computed) → debt breakdown → payoff planner → payments (transactions preview filtered to debt accounts).
**Signature modules:** Debt Breakdown, Payoff Planner (both real today).
**Disappear:** the legacy `cash_flow`/`savings_rate` key-override hacks (the code itself marks them TODO-migration).

### 1.6 Savings / Emergency Fund — "How long could I last?"

**Hero:** **Months covered** — not the dollar balance. The dollar balance is the input; months-of-expenses is the *meaning* (the existing `emergency_fund_progress` widget already computes it from config). Headline: "4.2 months"; trend: savings balance over time with the target line overlaid; delta: change this month.
**Chart:** yes — balance vs target line (`savings` column + config target). The target line is what makes this chart a story instead of a number going up slowly.
**Below hero:** attention ("dipped below target") → progress module (funded %) → contributions (transactions preview filtered to the linked savings accounts).
**Signature modules:** Months-covered progress, contribution stream.
**Disappear:** `monthly_expenses` stub (Finding 1 — it's config input masquerading as a module; collect it in settings, not as a dead card).
**Self-disagreement:** months-covered depends on a user-entered expense figure — a hero built on config is only as honest as the config. Mitigation: the hero sublines its assumption ("at $X/mo expenses — edit"), which is the assumption-disclosure rule from the philosophy doc applied to the humblest number in the product.

### 1.7 Property — "What is it worth, and what do we owe on it?"

**Hero:** **Equity** (snapshot `netWorth` of a well-scoped Property Space — Finding 2), headline value + mortgage as the two components. Trend backed *today* for Spaces that contain the property + its mortgage.
**Chart:** yes, drawn honestly: manual valuations are step functions — render steps, not interpolated slopes pretending to be market data. If the Space has only the asset (no mortgage), the hero degrades to Value with the same step discipline.
**Below hero:** attention → value + mortgage cards (the two components, each tappable to provenance) → cash flow *only when rental transactions actually flow through linked accounts* — a rental Property Space is a flow Space; an owner-occupied one is stock-like. Same template, module gated by data presence (the "earns pixels" rule doing type differentiation automatically).
**Signature modules:** Property Value (pinned account only — the regex heuristic dies, per both predecessor docs), Mortgage.
**Perspectives instead:** transactions, allocation (meaningless here).

### 1.8 Goal — "How close am I?"

**Hero:** Progress toward target — as a **progress composition, not a line chart**. No goal-history table exists; fabricating a trend from nothing is the exact "fake chart" the prompt names, and the answer is no. The ProgressWidget family (real, shipped) *is* this hero: current/target, funded %, deadline.
**Chart:** intentionally absent until history exists. When goal snapshots arrive (future schema work), the trend slots in without moving anything — the hero unit was designed for that evolution.
**Below hero:** attention (off-pace vs deadline — computable today from target date + progress) → check-ins/streaks (HABIT goals) → linked-account contributions.
**Note:** `GOAL` is marked legacy in the schema; long-term, goal-shaped categories (TRIP, VEHICLE purchase, EMERGENCY_FUND) are the same template with different nouns — one Goal template, parameterized, rather than four drifting ones. TRIP's budget/savings pair and VEHICLE/EQUIPMENT value trackers are Goal-template variants, not distinct philosophies.

---

## 2. Transactions: challenging the assumption

The belief under test: *"users should always be able to quickly see recent transactions inside a Space without navigating away."*

**The challenge, made properly:** three facts complicate "always."

1. **Privacy already disagrees with "always."** Transaction detail is gated to FULL-visibility shares by a single tripwire-tested predicate (KD-15). In a shared Space, a transactions panel is structurally a *partial* list — safe (fails closed) but silently incomplete. An unlabeled partial ledger is the most dangerous kind of honest: every viewer assumes they're seeing everything.
2. **Not every Space has transaction flow as its story.** Personal, Household, Business, Debt: yes — money moving *is* the plot. Investment: the flow is mostly administrative noise (sweeps, dividends); Property (owner-occupied), Goal: barely any flow at all. A transactions panel on those templates is inventory filler — the exact instinct the composition rule exists to resist.
3. **"Quickly see" ≠ "always on the Overview."** The actual user need is *no dead ends*: recent money movement reachable in at most one tap from anywhere in the Space. A doorway satisfies that; a permanent panel is one of several ways to satisfy it.

**Verdict: the belief survives, narrowed.** Transactions remain first-class **on flow-identified templates** (Personal, Household, Business, Debt — the latter filtered to payments) and move to a doorway (tab/Perspective) on stock-identified ones (Investment, Property, Goal). Wherever the panel appears in a shared Space, it carries a scope label ("from fully-shared accounts") — one line of copy that converts a silent partial view into an honest one. Note the current baseline makes this *additive*: shared Spaces have no transactions surface at all today (the tab is honesty-gated); this template work is what earns it back, correctly labeled, where it belongs.

---

## 3. Daily Brief: placement and naming

**Placement first, name second.** The per-Space brief panel's pipeline is a stub (D5: `run-ai-advice.ts` never runs; the panel renders parsed text from a possibly-stale `AiAdvice` row). Under the honesty principle, **no template gets a brief slot until the pipeline is real** — the panel currently occupies a hero-adjacent column on Personal on the strength of a placeholder sentence. Remove from templates now; reserve the slot.

**Naming, for when it returns.** The product-language guide already settled the vocabulary: *Briefing* is the canonical noun ("an AI-generated summary surfaced ambiently"), and *Daily Brief* is the platform-level surface that spans Spaces. That distinction does the work:

- **Platform page (cross-Space, morning cadence): "Daily Brief"** — keep. It's shipped, named correctly, and the "Daily" promise is credible for a single platform surface.
- **In-Space section: "Briefing."** Not "Daily Brief" — a per-Space section cannot honestly promise daily cadence (briefs regenerate on advice runs, not calendar days), and duplicating the platform surface's name creates two things claiming to be the same thing. Not "Space Brief" — the qualifier is redundant inside a Space (everything there is Space-scoped; the product never says "Space Accounts"). The rejected candidates each violate the voice guide: "Recent Intelligence" (fintech jargon, performative), "Today's Summary" (cadence promise + generic), "Latest" (vague to the point of meaninglessness), "Activity Brief" (collides with the Timeline's job), "Overview Notes" ("notes" implies user-authored content).

One word, already in the product's vocabulary, honest about cadence: **Briefing.**

---

## 4. Historical charts: the specific verdicts

- **Every chartable Space deserves one:** yes, under the "earns pixels" ladder — and Finding 2 *expands* the chartable set (Property equity is Tier 1 for well-scoped Spaces, not Tier ✗).
- **Some Spaces should intentionally not have one:** yes — Goal (no history substrate; §1.8), and any Space whose series is a flat step function below the variance threshold, which gets the sparkline/headline form instead. Intentional absence, stated honestly, is part of the philosophy — not an exception to it.
- **Allocation as signature for Personal / Household / Investment:** Personal yes, Investment emphatically yes, **Household no** (§1.2 — flow and coordination are the household story; allocation of a partial account set misleads; keep it one tap away).
- **Debt Spaces → composition instead of trend:** no — both, ranked; trend is the hero because payoff is a story about *winning over time*, composition is signature module #1 because it answers "what am I fighting" (§1.5).
- **Business → something different:** yes — cash position trend now; in/out flow module beside it; revenue/runway only when a defensible derived series exists (§1.3).
- **Goal Spaces → avoid fake charts until history exists:** agreed without reservation; the ProgressWidget composition *is* the correct hero until then (§1.8).

---

## 5. Perspective reviews

### 5.1 End User

Templates-as-stories is a major cognitive-load win: today every Space opens as an undifferentiated card stack; under this contract the first glance answers the type-specific question the user actually has ("how long could I last?" beats four cards about a savings account). The one-hero rule gives every Space a reading order. Two watch-items: (1) demoting transactions on Investment/Property will surprise the minority who used them there — the doorway must be visible, not buried; (2) the months-covered hero (§1.6) is the best *and* riskiest idea for this audience — it's the most meaningful number in the product, built on a user-entered expense figure; if the config is stale the hero is confidently wrong in the friendliest possible way. The edit-assumption subline is load-bearing, not decoration.

### 5.2 Principal Engineer

The contract is architecture-friendly: five fixed slots means one composition component, templates become *data* (which module keys fill which slots per category), and the existing preset/section/widget machinery already expresses most of it — this is preset curation plus a hero widget, not new infrastructure. Three demands: (1) **purge unimplemented section keys from presets** (Finding 1) before any new composition work — it's a data-only change with immediate honesty payoff; (2) **collapse the goal-shaped categories** (TRIP/VEHICLE/EQUIPMENT/GOAL and arguably EMERGENCY_FUND) into one parameterized template now, while there are zero production users — fifteen drifting presets is the template version of the two-dashboard-hosts problem, and it compounds; (3) the per-type transaction filtering (Debt→payments, EF→contributions) must reuse the KD-15 predicate path, never parallel queries — the privacy test's tripwires only guard the paths that exist.

### 5.3 Professional Wealth Manager / Financial Advisor

This is the first version of the product an advisor could put in front of a client per-entity, and the correctness calls are right: refusing runway without a burn definition, equity only for well-scoped Property Spaces, scope labels on every shared-context aggregate, assumption disclosure on months-covered. Two professional expectations to add: (1) the Debt hero's payoff-date subline must state its assumption set inline ("at current minimums") — an unqualified date is a promise; (2) the Business in/out module must be labeled as cash movement, not "revenue" — cash-basis flow presented with revenue vocabulary is the most common small-business software correctness failure. Workflow realism note: the per-template stories mirror how advisors already run reviews (household → flow, portfolio → allocation, debt → arc to zero); the templates are, in effect, meeting agendas — which is why they'll feel professional without any AI in them.

### 5.4 High-Net-Worth Individual

The template contract's fixed slots are what make six-entity stewardship scannable: same reading order in every Space, different protagonist — exactly how a family-office report book works (one page per entity, identical layout, different metric). The equity hero for Property Spaces and cash hero for Business Spaces match how this user already thinks (entities, not accounts). Privacy: the narrowed transactions verdict is the right call, but the scope label must appear on *every* derived module in shared contexts (cash in/out, contributions), not just transaction rows — partial-scope aggregates are subtler leaks than partial row lists, and the trend-leak test from the philosophy investigation extends to every per-template series. Time efficiency: this design's real payoff for the segment is that the hero unit doubles as the Space's row in the cross-entity rollup; the templates are secretly building the family-office summary page.

### 5.5 Wildcard: Editor-in-Chief

Chosen because a template is an editorial artifact — a front page — and newsroom discipline is the sharpest available critique of "signature modules."

The critique: **every front page has exactly one lede, and everything else on it exists to support or contrast the lede.** Judged this way: (1) the one-hero rule is correct but under-enforced — three "signature" modules is a ceiling, not a quota; Household needs member-activity and little else; a front page with three co-equal features has no lede. If everything is signature, nothing is. (2) The presets' current failure is an editorial one: they were assembled like column-inches allocated by category ("Business gets a cash flow section") rather than edited ("what does this Space's reader need first?") — Finding 1 is what running unedited wire copy looks like. (3) Headlines are claims: "Months covered: 4.2" is a headline; "Savings Rate" is a section label — templates should headline *answers*, not *topics*, and most current section labels are topics. (4) The strongest editorial test for any module: *would the page be worse without it?* Applied honestly, several template drafts above lose their third module. The conflict with the End User's desire for richness resolves editorially: richness lives one tap away (the paper has inside pages — Perspectives); the front page earns trust by what it declines to run.

---

## 6. Conclusions

**1. What would make Fourth Meridian's Space templates genuinely differentiated?**
Every finance platform has one dashboard with one story: your money went up or down. Fourth Meridian's templates make it the only product where **each entity you steward opens onto the question that entity exists to answer** — how long could I last, when am I free, do we have cash, what's it worth minus what we owe — each a deterministic, provenance-backed, scope-labeled headline over that entity's own faithfully-kept history. The differentiation is not the widgets; it's the editing: fifteen categories, five slots, one lede each, nothing unearned. No incumbent can copy this without first having the Spaces primitive, and none of them do.

**2. What is the biggest long-term risk?**
**Template drift and taxonomy calcification.** Fifteen categories, each with its own preset, edited at different times by different hands, is the composition-layer version of the two-dashboard-hosts problem — in ten years it produces fifteen slightly-inconsistent products under one brand. The schema already shows early sediment (`GOAL // legacy`, TRIP/VEHICLE/EQUIPMENT as siblings that are really one template). Mitigations: the five-slot contract as *enforced structure* (templates are data filling fixed slots, never bespoke layouts), collapsing the goal-shaped categories now while users are zero, and treating any new category as a parameterization first and a new template only with explicit justification. The secondary risk is the recurring one: heroes shipped ahead of their data (runway, goal trends) — the tier gates exist; the risk is future pressure to ignore them.

**3. Incremental evolution or all templates redesigned together?**
**Define together, ship incrementally.** The contract and all eight template definitions should be ratified as one document (this one, amended as needed) — defining templates one at a time is how drift starts on day one. Implementation then sequences by value over readiness: (0) purge unimplemented preset sections — data-only, immediate; (1) hero unit on Tier-1 Spaces (Household/Investment/Debt/EF — the philosophy doc's v2.5 slice); (2) per-template module curation + transactions narrowing (v2.5.5); (3) Business flow module and Property equity hero (v2.6-era, with their labeling rules); (4) Briefing slots when D5 is real. A simultaneous big-bang re-skin of fifteen presets is the one path that guarantees shipping unedited templates again.

**4. If you could preserve only one dashboard composition rule for the next decade?**
> **One Space, one lede: every Space opens on the single question it exists to answer, and nothing appears above or beside that answer that doesn't serve it.**
It's the composition-layer twin of the data-layer principle from the philosophy investigation ("nothing the data cannot defend"). Data honesty decides *whether* something may render; the one-lede rule decides *whether it deserves to*. Every template in this document is that rule applied eight times — and any future Space type, module, or intelligence surface can be admitted or refused by asking the same two questions in order.

---

*End of investigation. No implementation performed.*
