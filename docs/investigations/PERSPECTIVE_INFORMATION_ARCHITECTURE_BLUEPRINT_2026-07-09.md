# Perspective Information Architecture Blueprint

**Date:** 2026-07-09
**Type:** Design investigation. No code, no schema, no implementation.
**Frames:** UX-PER-2/3 (Perspective Workspaces), Unified Space Widget Layout, Overview-as-executive-dashboard.

---

## 0. The reframe: from dashboard to lens

The right instinct is already in the brief: stop asking "what widgets go in each Perspective" and start asking "what question does each Perspective answer." I'd push it one step further and make it the organizing principle for the whole product:

> **Fourth Meridian is one financial graph. A Perspective is a saved query over that graph, rendered as an answer to a single question.**

The financial graph is the set of entities you already model or will soon: **accounts → institutions → asset classes → holdings → transactions → merchants → flows → goals → time**. Overview is the *reduction* of that graph to a handful of scalars ("how am I doing?"). Every other Perspective is a *projection* of the same graph along one axis ("where are my assets?", "where does my money go?", "how accessible is it?").

This framing does three things:
1. It makes "Perspectives shouldn't repeat Overview" a **structural rule**, not a taste call: a widget belongs on a Perspective only if it *decomposes* something Overview *summarizes*. Overview shows the number; the Perspective shows the *shape behind the number*.
2. It gives every future data source (holdings, real estate, businesses, merchant intelligence, crypto) an obvious home: it's a new node type in the graph, and it lights up wherever a Perspective's query touches it.
3. It's the differentiator (§8). Almost every competitor is **dashboard-first** (a fixed set of cards). FM becomes **question-first** (a small set of lenses, each answering one thing better than a general dashboard ever could).

**The one-sentence test for any widget:** *"Does this help answer THIS Perspective's question in a way Overview's summary can't?"* If it just restates an Overview scalar, it's repetition. If it reveals the distribution, concentration, movement, or decomposition behind that scalar, it belongs.

---

## 1. What Overview owns (the anti-repetition contract)

Before the per-Perspective blueprint, pin what Overview keeps, because it defines what everyone else must *not* do. Overview = the executive summary, one scalar per domain:

- Net worth (the number) + net-worth trend (the one lede chart).
- Top-line allocation donut (assets at a glance).
- A change/attention strip (what moved, what needs you).
- Doorways into the Perspectives and Activity.

**Rule for all Perspectives:** you may reference a domain's headline number for orientation, but your *content* must be the decomposition Overview omits. No Perspective re-renders the net-worth line. No Perspective is "Overview filtered."

Data you already have to build on: per-account `type/institution/balance/currency/APR/minPayment/creditLimit`; classifier buckets (liquid / investments / digitalAssets / realAssets / liabilities); daily `SpaceSnapshot` series with **per-class** history (stocks, crypto, cash, savings, debt, netWorth); `Holding` rows (symbol/value/quantity/price/24h); flow-classified `Transaction`s with merchant + category; and the emerging merchant-intelligence layer.

---

## 2. Perspective-by-Perspective blueprint

Each Perspective below gets: **primary question**, **what must NOT appear**, **ideal first version** (buildable now), and **the multi-year version** (where it goes).

### Overview — "How am I doing overall?"
*Executive dashboard. Keep as-is.* Its job is orientation and triage, not analysis. The only evolution I'd make over time: turn the change/attention strip into a genuine **"what changed and why"** feed powered by merchant intelligence + AI verdicts (see §5, "Narrative"), so Overview becomes the place that *notices* things, and Perspectives become the place you *go to understand* them.

---

### Wealth — "Where is my money?"
**Endorsed strongly: assets-only. Remove Net Worth and Net Worth History — those are Overview scalars.** Wealth is not "net worth with detail," it's the **anatomy of your asset base**. Liabilities, spending, and debt are explicitly banished; their presence would collapse Wealth back into Overview.

**Must NOT appear:** net worth (number or line), any liability, debt payoff, spending, cash flow, budgets.

**Ideal first version (all buildable from accounts + classifier + snapshots today):**
- **Wealth by Account — horizontal ranked bars.** The single best "where is my money" visual: every asset account ranked by balance (Brokerage ██████████, 401k ██████, Savings ███ …). Instantly answers the question and exposes concentration by construction. This should be the hero, not a donut.
- **Asset Allocation — donut/bar** across the five asset classes (liquid, investments, crypto, real assets). Reuse the existing allocation math, assets-only (drop the debt segment that the Overview donut may show).
- **Institution Allocation — ranked bars or treemap.** "How much sits at each institution." This is the seed of the *institution-risk* idea (FDIC/SIPC coverage, single-institution concentration) that no consumer app frames well.
- **Asset Composition over time — stacked area (NOT a single "assets" line).** This is my one **challenge to the brief**: "Assets Over Time" as one line is just the net-worth line minus debt — still a scalar-in-disguise. The *insight* of the Wealth lens is **compositional drift**: the stacked area of stocks/crypto/cash/savings over time shows your asset *mix* migrating (e.g., cash → investments as you deploy). You already persist all four series in `SpaceSnapshot`, so this is free and far more revealing than a total line.

**Multi-year version:** holdings roll up so allocation becomes *look-through* (your VTI + 401k target-date fund resolve into true sector/geography/asset-type exposure, not "investments: $X"). Real estate and business equity become first-class asset nodes. A **wealth treemap** (institution → account → holding) becomes the map of your entire asset base in one frame. **Concentration/diversification scoring** (HHI on accounts, institutions, and — via look-through — individual securities) turns Wealth into a genuine risk lens, which is where it stops being a prettier Mint and starts being an advisor.

---

### Cash Flow — "Where does my money go?"
**Must NOT appear:** net worth, allocation, balances, holdings, debt payoff schedules. Cash Flow is about *movement*, not *stocks*. If it shows a balance, it's leaking Overview/Wealth.

**Ideal first version (transactions are flow-classified + merchant-tagged today):**
- **Income → Spending Sankey.** The definitive "where does it go" visual: income sources flow into category buckets flow into merchants. A Sankey is the honest shape of cash flow; a set of category cards is not. This is the Perspective's hero.
- **Monthly cash-flow waterfall.** Start-of-month → +income → −each category → end-of-month. A waterfall makes *net* cash flow and its drivers legible in a way a bar chart never does.
- **Category distribution over time — stacked bars**, so seasonality and lifestyle creep are visible.
- **Recurring vs discretionary split** (merchant intelligence can flag recurring merchants). "How much of my spend is committed vs choices" is a question people can't answer today.

**Multi-year version:** merchant intelligence powers **subscription/recurring detection** (the "you're paying for 3 streaming services" moment), **merchant-level contribution analysis** ("Amazon is 18% of discretionary; here's the trend"), and **anomaly detection** ("dining is 2.3σ above your baseline this month"). AI turns the Sankey into a *narrated* cash-flow story. This is where Cash Flow overtakes Copilot's spending intelligence — because it's operating over the same graph as Wealth and Debt, so it can say "your rising dining spend is why your savings-rate deployment into investments stalled."

---

### Liquidity — "How accessible is my money?"
This is the most under-served question in personal finance and a real chance to differentiate. No mainstream app frames liquidity as its own lens; they show "cash" and stop.

**Must NOT appear:** net worth, total assets, long-horizon investment performance, debt. Liquidity is about *time-to-cash and access*, not *how much you have*.

**Ideal first version:**
- **Liquidity ladder — horizontal stacked bar by access horizon.** Buckets: **now** (checking/savings), **days** (brokerage settlement), **penalty/locked** (401k, retirement), **illiquid** (real estate, private). One bar that says "of your money, this much is reachable today, this much this week, this much only with penalty." Nothing on the market shows this cleanly.
- **Runway / months-of-expenses gauge**, computed against Cash Flow's expense baseline (cross-Perspective reuse of the graph). "You have 7.2 months of runway in reachable cash."
- **Emergency-fund adequacy** — target vs reachable liquid, honest about what counts.

**Multi-year version:** model **credit lines and HELOCs as contingent liquidity** (access without selling), **penalty/tax cost of accessing locked funds** (what a 401k withdrawal actually nets), and **AI stress-testing** ("if income stopped today, here's your glide path across 3/6/12 months"). Liquidity becomes the "can I handle a shock?" lens — the thing people actually lie awake about.

---

### Investments — "How are my investments performing?"
**Must NOT appear:** total net worth, cash, spending, debt. Also resist making it "Wealth for the investment slice" — Wealth answers *where*, Investments answers *how well*.

**Ideal first version (needs holdings; you have the `Holding` model):**
- **Holdings treemap** sized by value, colored by day/period return — the canonical "portfolio at a glance," and far denser than a table.
- **Contribution-to-return decomposition** — which positions drove gains/losses (bar or waterfall). "Your +$4.2k this quarter was NVDA +$6k, everything else −$1.8k."
- **Allocation vs target drift** — if/when target allocations exist, the classic rebalancing view.
- **Time-weighted vs money-weighted return** done honestly (most apps quietly show the flattering one). Performance you can *trust* is a differentiator.

**Multi-year version:** **look-through exposure** (funds → underlying sectors/geographies/factors), **fee/expense-ratio drag analysis** (Empower's one genuinely great feature — quantify the lifetime cost of your fund fees), **dividend/income timeline**, **tax-lot / unrealized-gain map** for tax-loss-harvesting, and eventually **factor decomposition**. This is a multi-year climb, but the treemap + contribution analysis is a strong, honest v1.

---

### Debt — "What do I owe?"
**Must NOT appear:** assets, net worth, spending (except debt *payments*), allocation. Debt is a liabilities-only lens, the mirror of Wealth.

**Ideal first version (accounts carry APR, minPayment, creditLimit today):**
- **Debt by account — ranked bars, annotated with APR.** Same "ranked bars" pattern as Wealth, but the sort/insight axis is **rate**, not just balance. High-APR small balances should visually scream.
- **Payoff simulator with an interest waterfall.** Avalanche vs snowball, showing *total interest paid* and *debt-free date* — and a waterfall of where each payment goes (principal vs interest) over time. You already have a payoff calculator; this is its natural home and full expression.
- **Credit utilization gauge** (balance/limit per revolving account) — a real credit-health signal, not just a number.
- **Cost-of-debt timeline** — interest accruing over time; "this debt costs you $X/month in interest."

**Multi-year version:** **refinance/consolidation what-ifs**, **credit-score integration**, **debt-to-income and debt-service ratios** (cross-linking Cash Flow's income), and **AI payoff coaching** ("redirect your $300 dining overspend and you're debt-free 14 months sooner"). Debt becomes a *strategy* lens, not a *list*.

---

### Goals — "Am I on track?"
**Must NOT appear:** raw account balances, full allocation, spending detail. Goals is about *trajectory vs target*, not current state.

**Ideal first version:**
- **Goal progress with projected completion** — not just "62% funded" but "at your current contribution rate, funded by March 2027 (target: Jan 2027) — 2 months behind." A projected-vs-target timeline beats a progress bar.
- **Contribution attribution** — where the funding is coming from and whether the pace is sufficient. "You need $420/mo; you're averaging $310."
- **Scenario slider** — "add $150/mo → 4 months early." The one interactive element that makes goals *actionable*.

**Multi-year version:** goals become **claims on the graph** — a house-down-payment goal knows which accounts fund it, competes with other goals for cash flow, and AI arbitrates ("funding the car goal delays the house goal by 5 months — proceed?"). Monte-Carlo confidence bands for market-dependent goals. This is Origin-style planning, but *live* against real accounts rather than a wizard.

---

## 3. Visualization palette (beyond KPI cards)

Mapping the requested vocabulary to where each earns its place — none of these are cards:

| Visualization | Answers | Home |
|---|---|---|
| **Horizontal ranked bars** | "what's biggest / most concentrated" | Wealth (by account/institution), Debt (by APR) |
| **Sankey** | "where does flow originate and end" | Cash Flow (income→category→merchant), Liquidity (source→access horizon) |
| **Waterfall** | "how did we get from A to B, step by step" | Cash Flow (monthly), Debt (principal vs interest), Investments (contribution) |
| **Treemap** | "the whole thing in one frame, by size" | Investments (holdings), Wealth (institution→account→holding) |
| **Stacked area over time** | "how did the *mix* drift" | Wealth (asset composition), Cash Flow (category over time) |
| **Concentration / HHI** | "how exposed am I to one thing" | Wealth, Investments, Institution risk |
| **Ladder / stacked horizon bar** | "how accessible / when" | Liquidity |
| **Gauge with context** | "am I inside a safe band" | Liquidity (runway), Debt (utilization), Goals (pace) |
| **Heatmap** | "patterns across time × category" | Cash Flow (spending calendar), Activity |
| **Contribution/decomposition bars** | "what drove the change" | Investments, Cash Flow, Debt |

**Rule of thumb:** a KPI card answers "what's the number." Perspectives exist to answer "what's the *shape*." Default to shape.

---

## 4. New widgets Overview should never have

These justify Perspectives' existence — they're too dense, too specific, or too interactive for an executive summary:

- **Liquidity ladder** (Liquidity) — nuanced, needs explanation; wrong for a glance.
- **Income→spend Sankey** (Cash Flow) — analytical, not summary.
- **Holdings treemap** (Investments) — dense, interactive.
- **Payoff simulator + interest waterfall** (Debt) — interactive what-if.
- **Institution-risk / concentration (HHI)** (Wealth) — a computed risk score, not a balance.
- **Recurring/subscription inventory** (Cash Flow) — a working list you act on.
- **Fee-drag analysis** (Investments) — a specific, opinionated calculation.
- **Scenario sliders** (Goals, Debt, Liquidity) — interactivity that has no place on a triage screen.

Each is a reason to *leave* Overview and *enter* a lens — which is exactly the behavior you want.

---

## 5. Challenging assumptions & better arrangements

- **"Assets Over Time" → "Asset composition over time."** (Detailed in Wealth.) A single assets line is a scalar in disguise; the stacked mix is the actual Wealth insight, and you already store the series.
- **Cash Flow vs Spending are different questions.** "Where does my money go" (Cash Flow, includes income and the *net* picture) is not the same as "what did I spend on" (Spending). I'd keep Cash Flow as the flow/Sankey lens and consider **Spending** as a distinct later lens focused on categories/merchants/discretion. Merging them muddies both. (See §7 for the split.)
- **Liquidity is the sleeper.** It's the most differentiated lens and the cheapest to build a strong v1 (you have account types + balances). I'd sequence it *earlier* than its "boring" name suggests.
- **Investments needs holdings; don't fake it.** Until holdings ingestion is solid, an honest Investments v1 is the treemap + contribution over the holdings you have, with a clear empty state — not KPI cards pretending to be analysis.
- **The narrative layer is the real product.** The highest-leverage "widget" isn't a chart — it's a **one-sentence AI verdict at the top of each Perspective** ("Your assets are 68% concentrated in one brokerage" / "Dining is your fastest-growing category"). The lens engine you already started (LensResult verdicts) should headline every workspace. Charts answer "what"; the verdict answers "so what."
- **Perspectives should be able to *reach across* the graph.** Liquidity's runway needs Cash Flow's expense baseline; Debt's coaching needs Cash Flow's discretionary slack; Goals compete for the same dollars. Because it's one graph, a Perspective can borrow another's computed facts. That cross-referencing is the thing a bolted-together dashboard app cannot do.

---

## 6. Several years ahead

Design the lenses so new data sources *light them up* rather than requiring new lenses:

- **Merchant intelligence:** powers Cash Flow (recurring detection, merchant contribution, anomalies) and the Overview "what changed" feed. It's the substrate for narrative.
- **Historical imports:** deepen every time-series (composition drift, seasonality, long-run return) and unlock **baselines** ("vs your 3-year normal"), which is what makes anomalies meaningful.
- **Holdings:** unlock Investments (treemap, look-through, fees) and upgrade Wealth allocation from account-class to true exposure.
- **Real estate / businesses:** new asset nodes → appear automatically in Wealth (composition, concentration) and, for businesses, seed a **Business** lens (runway, AR/AP, payroll) and a **Property** lens (equity, LTV, value trend).
- **Crypto:** already an asset class; look-through (stablecoins as cash-like, staked as locked) enriches both Wealth and Liquidity.
- **AI / ambient intelligence:** the endgame is that Perspectives stop being places you *visit* and become things that *speak up* — "your liquidity dropped below 3 months," "a new recurring charge appeared," "you drifted 8% from target allocation." The Perspective is the *explanation surface* for an ambient alert. Build every lens so its verdict is machine-generated and subscribable, and ambient intelligence is a re-packaging of work you've already done, not a new system.

**Architectural implication:** keep Perspectives as **declarative queries + a verdict + a set of visualizations over the shared graph**. New data = new graph edges = existing lenses get richer for free. Avoid hard-coding widgets to today's tables.

---

## 7. Where the market stops, and where FM can be different

Framed at the level of durable product philosophy (specific features shift release to release):

- **Mint (RIP) / Empower (Personal Capital):** aggregation + net worth + a genuinely good **investment fee analyzer** and retirement planner. Stops at: a fixed dashboard; spending is shallow; no "lens" model; investment tools are siloed from cash flow.
- **Monarch:** collaborative budgeting, net-worth tracking, solid reports (including flow/Sankey-style). Stops at: it's fundamentally a **budgeting** app with net-worth on the side; assets/liquidity/debt aren't first-class analytical lenses; single "household" context.
- **Copilot:** best-in-class **spending intelligence** and categorization, beautiful, Apple-native. Stops at: spending-centric; light on wealth/liquidity/debt strategy; single context.
- **Origin:** planning + investing + estate, advice-forward. Stops at: planning is somewhat **wizard/one-shot** rather than a live lens over real accounts; less about ongoing "shape of my money."
- **Quicken:** comprehensive but **legacy, desktop, everything-at-once**; power without a point of view.

**The gap they all share:** they are **dashboard-first and single-context**. You get *the* dashboard (maybe rearrangeable), and one financial life. None treat "your money" as **one graph queried through distinct questions**, and none make **multiple Spaces** (personal / household / business / a specific goal / a merchant operation) first-class.

**Where Fourth Meridian can be materially different:**
1. **Question-first, not widget-first.** Each Perspective is the *best possible answer to one question*, not a rearrangement of the same cards. That's a fundamentally different mental model and the whole reason this investigation exists.
2. **One graph, many lenses, cross-referencing.** Because Liquidity can use Cash Flow's baseline and Goals compete for real dollars, FM can say things no siloed app can.
3. **Spaces.** The same lens engine over *different scopes* (personal, household, a business, a single goal) is a category no consumer app occupies well. Wealth-of-my-business and Cash-Flow-of-my-household are the same lenses, different graphs.
4. **Verdict-led, ambient-ready.** Every lens headlines with a computed sentence, so the product can eventually *notice and speak* rather than wait to be opened. Most apps show you charts; FM tells you what they mean.
5. **Honesty as a feature.** Time-weighted *and* money-weighted returns, true liquidity (not "cash"), real cost-of-debt, fee drag, look-through exposure. The lens model makes rigor natural instead of intimidating.

The durable moat isn't any single chart — it's the **graph + lens + Spaces + verdict** stack. Ship the lenses so they're thin projections over that stack, and the competitive distance compounds with every new data source.

---

## 8. Missing / additional Perspectives to consider

Some belong soon; some are multi-year. Offered as candidates, not commitments:

- **Spending** (split from Cash Flow). "What did I spend on, and how much was a choice?" Category/merchant/discretion focus, driven by merchant intelligence. Cash Flow = the *flow/Sankey*; Spending = the *habits*. Two real questions.
- **Income.** "Where does my money come from, and how stable is it?" Underserved; matters enormously for gig/variable earners. Sources, stability, concentration (single-employer risk is the income analog of institution risk).
- **Fees & Costs.** "What is my money costing me?" Fund expense ratios, account fees, interest paid, subscription creep — the total drag on wealth. Empower proved people love the fee analyzer; generalize it.
- **Taxes.** "What will I owe, and what can I do before year-end?" Tax-relevant activity, unrealized gains/lots, harvesting opportunities. Multi-year, but a magnet once holdings + imports exist.
- **Property / Real Estate.** Equity, LTV, value trend, cost of ownership. Springs to life the moment real-estate nodes exist.
- **Business.** Runway, AR/AP, payroll, cash position — the Space-scoped lens for a business Space. Reuses Cash Flow/Liquidity math on a business graph.
- **Recurring / Subscriptions.** Arguably a sub-view of Cash Flow, but it tests so well as a standalone ("cancel these three") that it may deserve its own lens.
- **Time Machine / Projections.** "Where is this all heading?" A forward lens: net-worth trajectory, goal confidence bands, retirement glide path — the synthesis lens that turns every backward-looking Perspective into a forecast. This is the natural *capstone* and a strong long-term wedge against planning apps.
- **People / Household** (Spaces-native). "Who contributes what, who owes whom, whose goals are on track" — a lens that only exists because Spaces are shared. No competitor can copy it without your Spaces model.

**My opinionated shortlist to build after the current six:** **Liquidity** (cheap, differentiated), then **Spending** and **Income** (merchant-intelligence-powered, high daily value), then **Fees** and **Time Machine** (the two that make people say "no other app does this").

---

## 9. Recommendation & sequencing

**Adopt the graph/lens framing as doctrine.** Every Perspective = *a question + a verdict + shape-revealing visualizations over the shared graph*, never a re-skinned Overview.

**Build order (opinionated), gated by data readiness:**
1. **Wealth** (assets-only) — ranked bars + assets-only allocation + institution allocation + **composition-over-time stacked area**. All buildable now; also the proof that "no repetition" works.
2. **Cash Flow** — Sankey + monthly waterfall + category-over-time; recurring/discretionary once merchant intelligence is ready.
3. **Liquidity** — the ladder + runway. Cheap, differentiated, buildable now.
4. **Debt** — ranked-by-APR bars + payoff simulator/interest waterfall + utilization.
5. **Goals** — projected completion + contribution attribution + scenario slider.
6. **Investments** — treemap + contribution decomposition, gated on holdings quality (honest empty state until then).

**Cross-cutting, in parallel:** make the **LensResult verdict headline every workspace** (the narrative layer), and design each lens as a query so **new data sources light up existing lenses** rather than spawning new ones.

**What to resist:** porting Overview widgets into Perspectives; KPI-card-ifying analysis; building Investments on fake data; and treating each lens as an independent app instead of a projection of one graph.

The north star: a user should be able to say *"go to Wealth"* and mean *"answer where my money is,"* not *"show me another dashboard."* When each Perspective is unmistakably the best answer to its one question — and quietly borrows from the others because it's all one graph — Fourth Meridian stops being a nicer Mint and becomes a different category.
