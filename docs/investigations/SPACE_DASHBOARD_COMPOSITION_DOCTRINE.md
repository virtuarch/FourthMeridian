# Space Dashboard Doctrine — Composition of Every Template

**Investigation ID:** `SPACE_DASHBOARD_COMPOSITION_INVESTIGATION`
**Status:** Investigation only — no code, schema, migrations, or UI changes. Do not implement.
**Date:** 2026-07-03
**Filename note:** The brief names the deliverable `SPACE_DASHBOARD_DOCTRINE.md`. That filename was already occupied by a distinct, complete doctrine — `SPACE_DASHBOARD_VISUAL_LANGUAGE_INVESTIGATION` (visual weight, hierarchy, whitespace, premium feel). To avoid destroying it, this composition doctrine is written alongside as `SPACE_DASHBOARD_COMPOSITION_DOCTRINE.md`. The two are complementary companions: the visual-language doctrine governs *how much weight* each element gets; this one governs *which modules exist and in what order.* Rename/merge on request.
**Predecessors (governing):** `SPACE_DASHBOARD_FUTURE_INVESTIGATION.md` (three-question model, honesty gating), `SPACE_DASHBOARD_PHILOSOPHY_INVESTIGATION.md` (ledger philosophy, hero-as-fused-unit, chart tiers), `SPACE_TEMPLATE_REDESIGN_INVESTIGATION.md` (five-slot contract, per-type stories), `SPACE_DASHBOARD_DOCTRINE.md` / visual-language (weighting discipline). This document does not re-argue those; it applies a single composition lens uniformly to all ten audited templates, adds the module-level challenge, and fixes the ideal vertical reading order for each.
**Evidence base:** `lib/space-presets.ts` (`PRESET_MAP`, all 15 categories), `lib/space-hero.ts` (`SPACE_HERO_DEFS`), `lib/perspectives.ts` (`PERSPECTIVES_BY_CATEGORY`, `PERSPECTIVE_LIBRARY`), `lib/space-nav.ts` (`SPACE_TAB_ORDER`, rail gating), `components/dashboard/SpaceDashboard.tsx` (`SectionRegistry` — which keys have real renderers; `FLOW_TX_CATEGORIES`; `TX_SCOPE_NOTE`), `components/dashboard/DashboardClient.tsx` (Personal Overview render order), `prisma/schema.prisma` (`SpaceSnapshot`, `SpaceCategory`).
**Scope note:** The brief names ten templates. Two — **Debt** and **Emergency Fund** — map to the schema categories `DEBT_PAYOFF` and `EMERGENCY_FUND`. **Retirement** is audited here for the first time (the prior template redesign covered eight types and omitted it). Goal-shaped siblings (`TRIP`, `VEHICLE`, `EQUIPMENT`) are treated as variants of the Goal template, per the standing "collapse goal-shaped categories" recommendation, and are not audited as separate front pages.

---

## 0. The composition lens (module taxonomy)

Every Space Overview is composed from six kinds of element. This taxonomy is the analytic instrument used in every audit below. It refines — does not replace — the five-slot contract from the template redesign (`Hero → Attention → Signature → Change → Doorways`); "Supporting" is that contract's *Signature modules* renamed to make the challenge sharper, and "Progressive disclosure" names the depth ladder each slot uses to stay within the ten-second read.

1. **Hero** — the single fused unit that answers the one question the Space exists to answer: headline metric + delta + honest trend. One per Space, always first (except when displaced by Attention). Sourced from `SpaceSnapshot`, rendered by `SpaceTrendHero` / the Personal `KpiRow`+`NetWorthChart` pairing. A category with no defensible series has *no* hero chart — intentional absence, stated (`lib/space-hero.ts` omits GOAL/TRIP/VEHICLE/EQUIPMENT/CUSTOM/OTHER on purpose).

2. **Supporting modules** — at most **three** (usually two), the modules that make this Space type *itself* and directly serve the hero's story. This is the slot the doctrine polices hardest: *if a module doesn't serve the hero's story, it is not Supporting — it is a Doorway.* "Signature" is a ceiling, not a quota (Editor-in-Chief rule: a front page with three co-equal features has no lede).

3. **Attention modules** — 0–3 deterministic, capped items that interrupt the resting state (stale connection, over-limit, goal off-pace, "minimums may not cover interest"). Usually empty. When present, they render *above* the hero; the dashboard is sorted by how much the user's action matters, and on a good day nothing does.

4. **Change modules** — recent movement: the timeline preview and, on flow-identified Spaces, a transactions preview. Real events only, never padded. Serves "what changed since I was gone."

5. **Doorways** — one-tap entrances to everything that is real but not front-page: the fixed rail tabs (`SPACE_TAB_ORDER`) and the Perspectives cards/switcher. A Doorway satisfies the "no dead ends" need without spending front-page pixels. Demoting a module to a Doorway is not deletion — it is editing.

6. **Progressive disclosure** — the depth ladder inside each surface: number → provenance in one tap (tile → `GlassModal` reusing the real chart/logic); hero → chart modal; Perspective card → routed tab/modal; variance-aware hero rendering (setup → day-one placeholder → sparkline → full chart). Nothing on the Overview should require scrolling or a conversation to be trusted; depth lives one tap down, never inline.

**Two governing rules inherited and enforced throughout:**
- **Data honesty (whether it may render):** nothing appears that the data cannot defend — no fabricated trend, no unimplemented-key `ContextualCard` masquerading as content, no partial aggregate without a scope label.
- **One lede (whether it deserves to):** every Space opens on the single question it exists to answer; nothing above or beside that answer that doesn't serve it.

**The module challenge** applied to every module below asks four questions in order: **Should it exist?** (does the data defend it) · **Should it move?** (front page vs Doorway) · **Should it disappear?** (would the page be worse without it — the Editor's test) · **Should it merge?** (two modules of overlapping meaning become one with a toggle).

---

## 1. Cross-cutting findings (apply to all templates)

**F1 — Flow vs. stock identity decides the transactions module.** `FLOW_TX_CATEGORIES = [HOUSEHOLD, FAMILY, BUSINESS, DEBT_PAYOFF]` already encodes the split in code. On flow-identified Spaces, money moving *is* the plot → transactions preview is a front-page Change module. On stock-identified Spaces (Investment, Property, Goal, Retirement, EF value trackers) → transactions is a Doorway (the Transactions tab), because a raw row list there is administrative noise. Personal is flow-identified in practice (`RecentTransactionsPanel` on its Overview) though not in the constant.

**F2 — Every shared-context aggregate needs a scope label.** The KD-15 predicate filters transaction detail to FULL-visibility shares, so any shared-Space list is structurally partial. `TX_SCOPE_NOTE = "From fully shared accounts only"` exists for this. The doctrine extends it: the label belongs on *every* derived module in a shared context (cash in/out, contributions, member activity), not only transaction rows — partial-scope aggregates are subtler leaks than partial row lists. Heroes on shared Spaces already carry `scopeLabel` in `SPACE_HERO_DEFS`.

**F3 — The Perspectives row is over-promoted on today's Overview.** On Personal (`DashboardClient`) the render order is `KpiRow → NetWorthChart → Allocation → PerspectivesWidget(row) → Timeline → RecentTransactions` — i.e. the Perspectives doorway-chrome sits *above* the Change layer. Doctrine: Perspectives is a Doorway; it must sit **below** hero, Attention, Supporting, and Change — or move entirely to the switcher + rail. It duplicates a rail entrance one tap away and occupies story space.

**F4 — Presets must reference only implemented, data-backed section keys.** Cross-referencing `PRESET_MAP` against `SectionRegistry` is the honesty gate at the template level. The current presets have already been cleaned (the removed `cash_flow`, `savings_rate`, `monthly_expenses`, `business_cash_flow` keys are documented as deleted-until-real). The doctrine ratifies this and forbids re-adding any key without its renderer.

**F5 — The five slots are fixed; only their fillings vary.** No template gets a bespoke layout. Differentiation is the hero metric, the two-or-three Supporting modules, and the KPI vocabulary — configuration over the same components. This is what lets a user build muscle memory across 50+ Spaces.

**F6 — The two-host split is the standing structural liability.** Personal renders via `DashboardClient`; every other type via `SpaceDashboard` (section-driven). The hero unit should be one shared widget mounted in both, so it becomes the anchor of eventual convergence rather than a third thing to converge.

---

## 2. Per-template audits

Legend for module challenge verdicts: **KEEP** (exists, front page, serves hero) · **MOVE→Doorway** · **DISAPPEAR** · **MERGE** · **ADD** (missing but earned) · **GATE** (render only when its data exists).

### 2.1 Personal — "How am I doing?"

*Category:* `PERSONAL` · *Host:* `DashboardClient` · *Hero (shipped):* Net Worth trend (`KpiRow` + `NetWorthChart`).

| Slot | Contents (audited) |
|---|---|
| **Hero** | Net worth, headline + delta + trend. Correct. Window correction owed: net worth is a quarterly story; the 1M default undersells it. |
| **Supporting** | Allocation (one donut — see MERGE); Cash-flow MTD as a KPI tile (not a module — no real cash-flow module exists). Cap: two. |
| **Attention** | Broken connection / stale sync; goal off-pace. Usually empty. |
| **Change** | Recent transactions preview (Personal is flow-identified); Timeline preview. |
| **Doorways** | Perspectives: `overview, wealth, cashFlow, liquidity, investments, debt, goals`; rail tabs (Accounts, Transactions, Members). |
| **Progressive disclosure** | KPI tile → chart modal (`NetWorthChartModal`, series toggles); allocation donut → holdings depth via Perspective. |

**Module challenge**
- *Net worth hero* — **KEEP.** The reference hero.
- *AllocationChart + HoldingsDonutChart* — **MERGE.** Two donuts of overlapping meaning on one surface; consolidate to one with a scope toggle.
- *Total Assets / Total Liabilities KPI tiles* — **MERGE** into hero series-toggles (they already open the same modal with different series). Keep them *visible* as toggles, not buried — a user who orients by Liabilities must not lose it.
- *Recent transactions preview* — **KEEP** (flow Space).
- *Perspectives row* — **MOVE→Doorway** below Change (F3).
- *OverviewBrief / Briefing slot* — **DISAPPEAR** until D5 pipeline is real (already removed from `DashboardClient`); reserve the slot, name it "Briefing" when it returns.
- *`cash_flow`, `savings_rate` preset sections* — **DISAPPEAR** (already purged; unimplemented keys).

**Ideal vertical reading order:** `Attention (if any) → Net-worth hero (chart) → Allocation (single, scope-toggle) → Recent transactions → Timeline → Perspectives row → Accounts`.

---

### 2.2 Household — "Are *we* on track, and who did what?"

*Category:* `HOUSEHOLD` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.HOUSEHOLD` = Net worth, scope-labeled "Across accounts shared with this Space." *Preset today:* `DEBT_SUMMARY_SECTION` + universal (Goals/Accounts/Activity).

| Slot | Contents (audited) |
|---|---|
| **Hero** | Shared net worth, trend, scope-labeled. Highest-value currently-unshipped chart in the product (data exists, surface doesn't). |
| **Supporting** | Member-attributed activity (coordination *is* the story); shared Goals (`GoalsCard`, real); obligations (Debt Summary). Cap: keep to member-activity + goals; obligations is borderline. |
| **Attention** | Stale shared connection; shared goal off-pace. |
| **Change** | Member-attributed activity promoted (above transactions here); transactions preview, scope-labeled (F2), FULL-shared accounts only. |
| **Doorways** | Perspectives: `overview, wealth, cashFlow, liquidity, goals, debt`; Members, Accounts, Transactions tabs. |
| **Progressive disclosure** | Hero → chart; member row → that member's activity; goal → detail modal. |

**Module challenge**
- *Net-worth hero* — **KEEP**, scope label load-bearing (advisor non-negotiable).
- *Allocation* — **DISAPPEAR from front page / MOVE→Doorway.** Contra the naive prompt suggestion: a household's story is flow and coordination, not asset mix; allocation of a partial account set is the most misreadable chart in a shared context. Perspectives only.
- *Member-attributed activity* — **ADD/KEEP as Supporting #1.** The differentiator for this type.
- *Shared Goals* — **KEEP.**
- *Debt Summary* — **MOVE→Doorway (soft).** Obligations matter but are not the household lede; keep only if it doesn't push member-activity below the fold. Debt perspective is one tap away.
- *`savings_rate`/`cash_flow` stubs, `debt_payoff_tracker` alias* — **DISAPPEAR** (misleading label / unimplemented).

**Ideal vertical reading order:** `Attention → Shared-net-worth hero → Member-attributed activity → Shared goals → Transactions preview (scope-labeled) → Timeline → Perspectives`.

---

### 2.3 Family — "Are *we* on track, and who did what?"

*Category:* `FAMILY` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.FAMILY` = Net worth, scope-labeled (identical to Household). *Preset today:* `DEBT_SUMMARY_SECTION` + universal.

**Finding:** Family and Household are, at the composition layer, **the same template with a different noun.** Same hero, same scope label, same perspective set (`overview, wealth, cashFlow, liquidity, goals, debt`), same preset. The audit is therefore identical to Household §2.2.

**Module challenge (delta only)**
- *Whole template* — **MERGE (candidate) with Household.** They are one parameterized "shared-entity" template; maintaining two presets that are byte-for-byte equivalent is early template drift (the same class as the goal-shaped sprawl). Justify divergence only if Family earns a distinct module — e.g. per-child allowance/goal sub-spaces or dependent-scoped goals — which does not exist today. Until then, differentiate by copy/noun, not by a separate composition.
- *Member-attributed activity* — **KEEP as Supporting #1** (arguably even more central for Family than Household).

**Ideal vertical reading order:** identical to Household — `Attention → Shared-net-worth hero → Member activity → Shared goals → Transactions preview (scope-labeled) → Timeline → Perspectives`.

---

### 2.4 Business — "Do we have cash, and which way is it moving?"

*Category:* `BUSINESS` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.BUSINESS` = Cash position (`totalCash + totalSavings`), scope-labeled "Cash and savings across linked business accounts." *Preset today:* `BUSINESS_ACCOUNTS` + `DEBT_SUMMARY_SECTION` + universal.

| Slot | Contents (audited) |
|---|---|
| **Hero** | Cash position, trend. **Not** revenue or runway — neither has a defensible deterministic series; a wrong runway number on a business front page is the single most professionally embarrassing failure available. Runway is the evolution path, not the launch metric. |
| **Supporting** | Cash in/out this month (deterministic monthly rollups exist in the AI assembler layer — surfacing is derivation reuse, not new intelligence); Obligations (Debt Summary); Business accounts. Cap forces a choice: in/out + obligations are the two; accounts is borderline (it is also a rail tab). |
| **Attention** | Stale business connection; obligation due; low-cash signal (if a deterministic producer exists). |
| **Change** | Transactions preview — Business is the *most* flow-identified type; label cash-basis movement as "cash movement," never "revenue." |
| **Doorways** | Perspectives: `overview, businessHealth, cashFlow, liquidity, wealth`; Accounts, Transactions, Members. |
| **Progressive disclosure** | Hero → cash chart; in/out → transaction drill; obligations → debt breakdown Perspective. |

**Module challenge**
- *Cash-position hero* — **KEEP.** Correct restraint over revenue/runway.
- *Cash in/out module* — **ADD** as Supporting #1 (reuse existing monthly rollups; label as cash movement).
- *Business accounts module* — **MOVE→Doorway (soft).** `AccountsCard` duplicates the Accounts rail tab; keep on Overview only if it earns its place beside in/out + obligations. Under the three-cap it likely yields.
- *Obligations (Debt Summary)* — **KEEP** as Supporting #2.
- *`investment_summary`* (in some historical Business presets) — **DISAPPEAR.** A business with a brokerage account is an edge case, not a signature.
- *`business_cash_flow` stub* — **DISAPPEAR** until the real rollup widget exists (already purged).

**Ideal vertical reading order:** `Attention → Cash-position hero → Cash in/out (this month) → Obligations → Transactions preview (labeled cash movement) → Timeline → Perspectives / Accounts`.

---

### 2.5 Investment — "What is the portfolio worth, and what's it made of?"

*Category:* `INVESTMENT` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.INVESTMENT` = Portfolio value (`totalInvestments + totalCrypto`). *Preset today:* `INVESTMENT_SUMMARY` + `INVESTMENT_ALLOCATION` + universal.

| Slot | Contents (audited) |
|---|---|
| **Hero** | Portfolio value, trend — with the behavioral guardrail at its strongest: monthly default window, **no daily-delta badge.** This is the Space where myopic loss aversion does real damage. |
| **Supporting** | Allocation (the one Space where composition is half the story — Supporting #1); Holdings (#2). |
| **Attention** | Stale brokerage connection; (deliberately no price-movement alerts — those manufacture the anxiety the guardrail removes). |
| **Change** | Timeline preview of *intentional* events (contributions, rebalances). **Not** a raw transaction list. |
| **Doorways** | Perspectives: `overview, investments, wealth, cashFlow`; Transactions tab (for the administrative flow), Accounts. |
| **Progressive disclosure** | Hero → chart (monthly window); allocation → holdings detail; holding → position provenance. |

**Module challenge**
- *Portfolio-value hero* — **KEEP**; enforce no-daily-delta framing.
- *Allocation* — **KEEP** as Supporting #1 (emphatically the right Space for it).
- *Holdings* — **KEEP** as Supporting #2.
- *`net_worth` section* (present in older Investment presets) — **DISAPPEAR.** Duplicates the hero with a broader, confusable scope (already removed per preset comment).
- *Transactions preview* — **MOVE→Doorway.** Trades/sweeps/dividends are noise punctuated by rare intentional events; the intentional events belong on the Timeline, the raw list behind the Transactions tab.
- *`cash_flow` stub* — **DISAPPEAR** (already purged).

**Ideal vertical reading order:** `Attention → Portfolio-value hero (monthly window, no daily delta) → Allocation → Holdings → Timeline (intentional events) → Perspectives`.

---

### 2.6 Property — "What is it worth, and what do we owe on it?"

*Category:* `PROPERTY` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.PROPERTY` = Equity (`netWorth` = value − mortgage), `chartType: "stepAfter"`, scope-labeled. *Preset today:* `PROPERTY_VALUE` + `MORTGAGE_TRACKER` (both pinned to Overview, orders 0/1) + universal.

| Slot | Contents (audited) |
|---|---|
| **Hero** | Equity, drawn as **steps** — manual valuations are step functions; never interpolate a slope pretending to be market data. Degrades to Value (same step discipline) if the Space has only the asset, no mortgage. |
| **Supporting** | Property Value card and Mortgage card — the two components of the equity story, each tappable to provenance. Both correctly live on the Overview under the hero (the mortgage is half the equity story; it cannot hide behind the Debt perspective). |
| **Attention** | Stale mortgage connection; valuation stale ("value last updated N months ago" — honest for a manual asset). |
| **Change** | Cash flow / rental income — **GATE:** render only when rental transactions actually flow through linked accounts. A rental Property is a flow Space; owner-occupied is stock-like. Same template, module gated by data presence — the "earns pixels" rule doing type differentiation automatically. |
| **Doorways** | Perspectives: `overview, property, cashFlow, wealth`; Transactions (when rental flow exists), Accounts. |
| **Progressive disclosure** | Hero → equity chart (steps); value card → valuation provenance; mortgage card → amortization / debt Perspective. |

**Module challenge**
- *Equity hero* — **KEEP.** Finding-2 correction: Property equity is Tier-1 chartable for well-scoped Spaces, not the pessimistic "Tier ✗."
- *Property Value card* — **KEEP** as Supporting #1, but **pinned account only** — the name-regex heuristic (`/home|house|property|.../i` in `SectionRegistry`) **DISAPPEARS** before strangers use it.
- *Mortgage card* — **KEEP** as Supporting #2, on the Overview (not behind Debt).
- *Rental cash flow* — **GATE** (data-presence).
- *Allocation* — **DISAPPEAR** (meaningless here).
- *Vehicle/Equipment* — out of scope (goal-shaped variants).

**Ideal vertical reading order:** `Attention → Equity hero (steps) → Property Value → Mortgage → Rental cash flow (only if flow exists) → Timeline → Perspectives`.

---

### 2.7 Debt — "How far have I come, and when am I free?"

*Category:* `DEBT_PAYOFF` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.DEBT_PAYOFF` = Remaining debt, `framing: "down-good"`, scope-labeled. *Preset today:* `DEBT_BREAKDOWN_SECTION` + `DEBT_PAYOFF_CALC_SECTION` + `DEBT_SUMMARY_SECTION` + universal.

| Slot | Contents (audited) |
|---|---|
| **Hero** | Remaining balance **plotted as progress, down-is-good, anchored at the starting balance** — same `debt` series, inverted valence (the single cheapest delight in the roadmap). Headline: remaining amount; delta: paid down this month; subline: payoff-date estimate (`simulatePayoff`, already real) with its assumption inline ("at current minimums"). |
| **Supporting** | Debt Breakdown (composition — "what am I fighting", Supporting #1); Payoff Planner (`simulatePayoff`, #2). Both real today. |
| **Attention** | Missed-payment / over-limit signals when producers exist; until then the APR-weighted "minimums may not cover interest" warning — already computed. |
| **Change** | Payments — transactions preview filtered to debt accounts (reuse the KD-15 predicate path, never a parallel query). |
| **Doorways** | Perspectives: `overview, debt, cashFlow, wealth`; Transactions, Accounts. |
| **Progressive disclosure** | Hero → payoff-arc chart; breakdown donut → per-account detail; planner → strategy modal (avalanche/snowball). |

**Module challenge**
- *Payoff-arc hero* — **KEEP.** On the prompt's "composition *instead* of trend": **no — both, ranked.** Trend is the hero (payoff is a story about winning over time); composition is Supporting #1. Replacing history with composition would delete the only chart whose slope is the user's own behavior.
- *Debt Breakdown* — **KEEP** as Supporting #1.
- *Payoff Planner* — **KEEP** as Supporting #2.
- *`debt_summary` section* — **MOVE→Doorway / MERGE.** With breakdown + planner + hero already present, a flat total is redundant; fold its total into the hero headline. Under the three-cap it should not be a fourth front-page module.
- *`debt_payoff_tracker` alias* — **DISAPPEAR** (rendered a debt-summary alias under a misleading "tracker" label; already purged).
- *`cash_flow`/`savings_rate` override hacks* — **DISAPPEAR** (code marks them TODO-migration).

**Ideal vertical reading order:** `Attention (interest/over-limit) → Payoff-arc hero (down-good, payoff-date subline) → Debt Breakdown → Payoff Planner → Payments preview (debt-filtered) → Timeline → Perspectives`.

---

### 2.8 Emergency Fund — "How long could I last?"

*Category:* `EMERGENCY_FUND` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.EMERGENCY_FUND` = "Emergency fund" (title correct over both months-covered and dollar balance), scope-labeled "Savings accounts linked to this Space." *Preset today:* `EMERGENCY_FUND_PROGRESS` + universal.

| Slot | Contents (audited) |
|---|---|
| **Hero** | **Months covered** — not the dollar balance. Balance is the input; months-of-expenses is the *meaning* (`emergency_fund_progress` already computes it from config). Headline "4.2 months"; trend: savings balance with the **target line overlaid** (the line that makes it a story, not a number rising slowly); delta: change this month. Subline discloses the assumption ("at $X/mo expenses — edit"). |
| **Supporting** | Months-covered progress module (funded %). One Supporting module is enough here — this is the cleanest one-lede Space in the set. |
| **Attention** | "Dipped below target this month." |
| **Change** | Contributions — transactions preview filtered to the linked savings accounts. |
| **Doorways** | Perspectives: `overview, liquidity, wealth, goals, cashFlow` (liquidity first — an emergency fund *is* liquidity); Transactions, Accounts. |
| **Progressive disclosure** | Hero → balance-vs-target chart; progress → contribution history; assumption subline → expense-config edit. |

**Module challenge**
- *Months-covered hero* — **KEEP.** Best *and* riskiest number in the product: it is built on a user-entered expense figure, so the assumption-disclosure subline is load-bearing, not decoration. A hero built on config is only as honest as the config.
- *Progress module* — **KEEP** (Supporting; largely the hero's companion, so keep it lightweight to avoid restating the hero).
- *`monthly_expenses` stub* — **DISAPPEAR.** Config input masquerading as a module; collect it in the progress widget's settings, not as a dead card (already purged).
- *Contributions preview* — **KEEP**, scope-labeled if shared.

**Ideal vertical reading order:** `Attention (below-target) → Months-covered hero (balance-vs-target chart, assumption subline) → Funded-% progress → Contributions preview → Timeline → Perspectives (Liquidity)`.

---

### 2.9 Goal — "How close am I?"

*Category:* `GOAL` (marked `// legacy` in schema) · *Host:* `SpaceDashboard` · *Hero:* **none in `SPACE_HERO_DEFS` — intentional.** *Preset today:* Goals section pinned to the Overview (`{ ...GOALS_SECTION, tab: OVERVIEW }`).

| Slot | Contents (audited) |
|---|---|
| **Hero** | Progress toward target as a **progress composition, not a line chart.** No goal-history table exists; fabricating a trend from nothing is the exact "fake chart" to refuse. The `ProgressWidget` family (real, shipped) *is* the hero: current/target, funded %, deadline. |
| **Supporting** | For HABIT goals: check-ins / streaks. For FINANCIAL/DEBT_REDUCTION: linked-account contributions. Type-parameterized, not multiplied into separate modules. |
| **Attention** | Off-pace vs deadline — computable today from target date + progress. |
| **Change** | Linked-account contributions (the money moving toward the goal). |
| **Doorways** | Perspectives: `overview, goals, wealth, cashFlow`; Accounts. |
| **Progressive disclosure** | Progress bar → contribution history; when goal-history schema arrives, a trend slots into the hero unit *without moving anything* — the unit was designed for that evolution. |

**Module challenge**
- *Progress-composition hero* — **KEEP.** Intentional chart absence is doctrine, not an exception.
- *Trend chart* — **DISAPPEAR / defer** until a goal-history substrate exists.
- *Whole category* — **MERGE (strategic).** `GOAL`, `TRIP`, `VEHICLE`, `EQUIPMENT`, and arguably `EMERGENCY_FUND` are one parameterized template with different nouns (`TRIP` = budget/savings pair; `VEHICLE`/`EQUIPMENT` = value trackers). Collapse now while production users are zero; fifteen drifting presets is the composition-layer twin of the two-host problem.
- *Check-ins vs contributions* — **KEEP** but render the *one* that matches `goalType`; do not stack both.

**Ideal vertical reading order:** `Attention (off-pace) → Progress hero (funded %, deadline) → Streaks OR contributions (per goalType) → Timeline → Perspectives`.

---

### 2.10 Retirement — "Am I on track to stop working?"

*Category:* `RETIREMENT` · *Host:* `SpaceDashboard` · *Hero:* `SPACE_HERO_DEFS.RETIREMENT` = "Retirement portfolio" (`totalInvestments + totalCrypto`), up-good, monotone. *Preset today:* `RETIREMENT_PROGRESS` + `RETIREMENT_ACCOUNTS` + `INVESTMENT_ALLOCATION` + universal. **First audit of this template.**

| Slot | Contents (audited) |
|---|---|
| **Hero** | **Tension to resolve.** Two candidate ledes: (a) the *portfolio value trend* (what `SPACE_HERO_DEFS` ships — honest, backed today) and (b) *retirement progress* — projected balance at retirement vs target (`retirement_progress` computes `projectFV` from config: current age, retirement age, expected return, contribution). Doctrine: the **honest hero is the portfolio-value trend**; progress-to-target is Supporting #1, *not* the hero, because the projection is config-dependent and forward-looking — the same honesty caution as EF's months-covered, but with a longer, more assumption-laden horizon (a 30-year FV compounded from an expected-return guess is a confident number built on sand). Keep the projection, subline its assumptions, but let the defensible series (actual portfolio value) hold the center. Apply the Investment guardrail: monthly window, no daily-delta badge. |
| **Supporting** | Retirement progress (projected-vs-target, `projectFV`, assumptions sublined) — #1; Retirement accounts (balances) — #2; Allocation — borderline #3 (glide-path relevance is real, but three co-equal modules risk no-lede). |
| **Attention** | Off-track vs target at current contributions; stale account connection. |
| **Change** | Contributions timeline (intentional events — like Investment, not a raw transaction list). |
| **Doorways** | Perspectives: `overview, wealth, retirement, investments, cashFlow`; Accounts, Transactions. |
| **Progressive disclosure** | Hero → portfolio chart; progress module → assumption editor (age/return/contribution); allocation → holdings/glide-path detail. |

**Module challenge**
- *Portfolio-value hero* — **KEEP** as the honest lede; enforce Investment-style non-anxious framing.
- *`retirement_progress` (projected-vs-target)* — **KEEP as Supporting #1, DEMOTE from any hero ambition.** Disclose the full assumption set inline (return, ages, contribution) — an unqualified projected number is a promise. This is the retirement analogue of the EF assumption-disclosure rule.
- *`retirement_accounts`* — **KEEP** #2, though it overlaps the Accounts tab; keep only if it adds account-type framing (401k/IRA/Roth) the generic tab doesn't.
- *`investment_allocation`* — **MOVE→Doorway (soft) / MERGE.** Relevant for glide-path, but under the three-cap it competes with progress + accounts and duplicates the Investments Perspective. Prefer it as a Perspective unless the Space is retirement-*only* with no separate Investment Space.
- *Transactions preview* — **MOVE→Doorway** (stock-identified; contributions belong on the Timeline).

**Ideal vertical reading order:** `Attention (off-track) → Portfolio-value hero (monthly, no daily delta) → Retirement progress (projected-vs-target, assumptions sublined) → Retirement accounts → Contributions timeline → Perspectives (Allocation/Investments)`.

---

## 3. Consolidated module verdict matrix

| Module | Personal | Household | Family | Business | Investment | Property | Debt | Emergency Fund | Goal | Retirement |
|---|---|---|---|---|---|---|---|---|---|---|
| **Hero (trend)** | Net worth | Shared net worth | Shared net worth | Cash position | Portfolio value | Equity (steps) | Payoff arc (down-good) | Months covered | Progress (no chart) | Portfolio value |
| Net worth section | merged→hero | — | — | disappear | disappear | — | — | — | — | — |
| Allocation | merge to 1 | doorway | doorway | doorway | **KEEP #1** | disappear | — | — | — | doorway/merge |
| Holdings | doorway | — | — | — | **KEEP #2** | — | — | — | — | doorway |
| Member activity | — | **KEEP #1** | **KEEP #1** | doorway | — | — | — | — | — | — |
| Goals (shared) | doorway | **KEEP** | **KEEP** | — | — | — | — | doorway | **is hero** | — |
| Cash in/out | KPI tile | doorway | doorway | **ADD #1** | — | gate (rental) | — | — | — | — |
| Obligations/Debt summary | doorway | soft-move | soft-move | **KEEP #2** | — | — | merge→hero | — | — | — |
| Debt breakdown | doorway | doorway | doorway | doorway | — | — | **KEEP #1** | — | — | — |
| Payoff planner | — | — | — | — | — | — | **KEEP #2** | — | — | — |
| Property value | — | — | — | — | — | **KEEP #1** (pinned) | — | — | — | — |
| Mortgage | doorway | — | — | — | — | **KEEP #2** | — | — | — | — |
| Progress/months-covered | — | — | — | — | — | — | — | **KEEP #1** | **is hero** | KEEP #1 (demoted) |
| Retirement accounts | — | — | — | — | — | — | — | — | — | KEEP #2 |
| Transactions preview | **KEEP** | KEEP (scoped) | KEEP (scoped) | **KEEP** (cash-mvmt) | doorway | gate | KEEP (debt-filtered) | KEEP (contrib) | contrib | doorway |
| Timeline preview | KEEP | KEEP | KEEP | KEEP | KEEP | KEEP | KEEP | KEEP | KEEP | KEEP |
| Perspectives row | **demote** | demote | demote | demote | demote | demote | demote | demote | demote | demote |
| Briefing (D5) | reserve | reserve | reserve | reserve | reserve | reserve | reserve | reserve | reserve | reserve |
| Name-regex asset match | — | — | — | — | — | **disappear** | — | — | — | — |

---

## 4. Doctrine (the rules this investigation ratifies)

1. **One Space, one lede.** Every Space opens on the single question it exists to answer. The hero is a fused unit (number + delta + honest trend), always first except when displaced by Attention.
2. **Supporting is capped at three, usually two.** "Signature" is a ceiling, not a quota. The admission test: *would the front page be worse without this module?* If not, it is a Doorway.
3. **Data honesty decides whether a module may render; the one-lede rule decides whether it deserves to.** No unimplemented-key `ContextualCard`, no fabricated trend, no Tier-✗ chart (runway without a burn definition, goal trend without history).
4. **Flow vs. stock decides transactions.** Front-page Change module on flow Spaces (Personal, Household, Family, Business, Debt); Doorway on stock Spaces (Investment, Property, Goal, Retirement).
5. **Every partial aggregate in a shared context carries a scope label** — heroes, transaction lists, and every derived module alike.
6. **Assumption-laden heroes and modules disclose their assumptions inline** (EF months-covered "at $X/mo — edit"; Debt payoff-date "at current minimums"; Retirement projection: return + ages + contribution).
7. **Perspectives is a Doorway, not a front-page band** — below hero/Attention/Supporting/Change, or the switcher + rail only.
8. **The five slots are fixed; only their fillings vary** — configuration over the same components, so muscle memory holds across every Space.
9. **Intentional absence is part of the design** — Goal has no chart, Investment/Retirement suppress the daily-delta badge, low-variance Spaces get a sparkline; each stated, none faked.
10. **Progressive disclosure everywhere** — number → provenance in one tap; depth lives one tap down, never inline; nothing on the Overview needs scrolling or a conversation to be trusted.

### Structural recommendations (define now, implement later — not in this investigation)
- **Merge Household + Family** into one parameterized shared-entity template; differentiate by noun/copy until Family earns a distinct module (dependent-scoped goals).
- **Collapse the goal-shaped categories** (`GOAL`, `TRIP`, `VEHICLE`, `EQUIPMENT`) into one parameterized Goal template while production users are zero.
- **Resolve the Retirement hero tension** in favor of the honest portfolio-value trend, with projection demoted to an assumption-disclosed Supporting module.
- **Build the hero once** as a shared `SpaceTrendHero` mounted in both hosts, ahead of full `DashboardClient`/`SpaceDashboard` convergence (F6).
- **Kill the name-regex asset matcher**; pinned-account config only (Property/Vehicle/Equipment value widgets).

---

*End of investigation. No implementation performed — no schema, migration, API, or UI changes. Synthesis of the per-template composition passes into a single doctrine, per SPACE_DASHBOARD_COMPOSITION_INVESTIGATION.*
