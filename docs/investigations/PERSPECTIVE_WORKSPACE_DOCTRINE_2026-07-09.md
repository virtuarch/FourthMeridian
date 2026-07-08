# Perspective Workspace Doctrine

**Date:** 2026-07-09
**Type:** Design doctrine. No implementation, no code, no schema.
**Status:** Intended as the standing architectural doctrine for Perspective Workspaces.
**Companion:** `PERSPECTIVE_INFORMATION_ARCHITECTURE_BLUEPRINT_2026-07-09.md` (detailed visualization palette per Perspective).

---

## The doctrine in one screen

**A Perspective is a question, not a dashboard.** It answers exactly one question. Every visualization inside it answers a *sub-question* of that one question. If a widget doesn't help answer the Perspective's question, it does not belong there — even if it's a good widget.

The product is organized around **questions**, not **objects**. Competitors navigate by account / transaction / investment (the user assembles the answer). Fourth Meridian navigates by *"how am I doing / where's my money / where does it move / how accessible / what do I owe / am I on track"* (the product assembles the answer).

### The five laws

1. **The Scalar→Decomposition Law.** Overview owns the *scalar* (the number). A Perspective owns the *decomposition* (the shape behind the number). Overview answers **"what?"**; a Perspective answers **"why?"**. If a Perspective renders a scalar Overview already shows, it is repeating, not decomposing.
2. **The One-Question Law.** Each Perspective has a single primary question. Every widget maps to a sub-question of it. A widget that answers a *different* question belongs to a *different* Perspective (or is cut).
3. **The Verdict-First Law.** Every Perspective opens with a one-sentence **Verdict** — an AI-computed claim ("Your assets are becoming concentrated"). The widgets beneath exist to *prove the verdict*. Charts say "what"; the verdict says "so what."
4. **The Graph-Projection Law.** There is one financial graph (accounts → institutions → asset classes → holdings → transactions → merchants → flows → goals → time). A Perspective is a *projection/query* over that graph. New data sources are new graph edges; they light up existing Perspectives rather than spawning new ones.
5. **The No-Duplication Law.** No two Perspectives answer the same question. If two lenses fight over a widget, one of them has the wrong question. (Corollary: Investments must not be "Wealth for the investment slice" — see §Investments.)

Everything below is these five laws applied.

---

## The Perspective Test (how we decide what is first-class)

A candidate earns **first-class Perspective** status only if it passes all four:

1. **Real question** — a user would ask it in roughly those words ("where's my money?", "what do I owe?").
2. **Irreducible** — it is *not* answerable by re-filtering another Perspective. (Fails ⇒ it's a widget inside that other Perspective.)
3. **Own verdict** — it produces a distinct one-sentence claim Overview and the others don't.
4. **Native grammar** — it has a hero visualization the other lenses don't use (a Sankey, a ladder, a treemap, a concentration curve). If its best view is "the same chart as X, filtered," it's a sub-view of X.

Fail #2 or #4 ⇒ **widget, not Perspective.** This test decides the taxonomy in §4.

---

## Part I — The six current Perspectives (constitution)

Each gets: **question**, **forbidden content** (No-Duplication enforced), **ideal first version** (buildable against today's model), **example verdicts**, **growth path**. Data facts grounded in the real schema: accounts carry `type / institution / balance / currency / APR / minPayment / creditLimit`; the classifier buckets into liquid / investments / crypto / real-assets / liabilities; `SpaceSnapshot` stores **daily per-class series** (stocks, crypto, cash, savings, debt, netWorth); `Holding` rows carry symbol/value/quantity; transactions are merchant- and flow-classified.

### Overview — "How am I doing overall?"
Executive summary; owns every scalar (net worth + trend, top-line allocation, an attention strip, doorways). **Its verdict is the portfolio of the other Perspectives' verdicts** — the place the product *notices* ("liquidity is thin; dining is climbing; you're behind on the house goal"). Overview is where you *triage*; Perspectives are where you *understand*. Overview must stay concise: it never hosts the depth widgets in §3.

### Wealth — "Where is my money?"
**Assets only. This is doctrine, not preference.** Wealth is the anatomy of the asset base, not net worth with detail.
**Forbidden:** net worth (number or line), any liability, debt, spending, cash flow. Their presence collapses Wealth into Overview.
**Ideal first version (all buildable now):**
- *Wealth by Account* — horizontal **ranked bars** (the hero; concentration is visible by construction).
- *Asset Allocation* — donut/bar across classes, **assets-only**.
- *Institution Allocation* — ranked bars / **institution map** (seed of institution-risk).
- *Asset Composition over time* — **stacked area** of the per-class series. (Not a single "assets" line — that's net-worth-minus-debt in disguise. The Wealth insight is *compositional drift*, and you already store the four series.)
- *Concentration* — a **concentration curve / HHI** on accounts and institutions.
**Verdicts:** "Your assets are becoming concentrated." / "72% of your wealth sits at one institution." / "Cash is migrating into investments."
**Growth:** holdings enable **look-through** (funds → true exposure); real-estate & business equity become asset nodes; a **wealth treemap** (institution → account → holding) maps the whole base; concentration becomes a genuine risk score.

### Cash Flow — "Where does my money move?"
**Forbidden:** balances, net worth, allocation, holdings, debt schedules. Cash Flow is *movement*, not *stocks*. A balance here is a leak.
**Ideal first version:**
- *Income → category → merchant* **Sankey** (the hero; the honest shape of flow).
- *Monthly cash-flow* **waterfall** (open → +income → −categories → close).
- *Category over time* — **stacked distribution** (seasonality, lifestyle creep).
- *Committed vs discretionary* split (recurring detection).
**Verdicts:** "Dining is your fastest-growing discretionary expense." / "68% of your spend is committed before you make a choice."
**Growth:** merchant intelligence powers recurring/subscription detection, merchant contribution analysis, and anomaly baselines ("2.3σ above your normal"); AI narrates the Sankey.

### Liquidity — "How accessible is my money?"
The most under-served question in the market and the cheapest strong differentiator.
**Forbidden:** net worth, total assets, long-horizon returns, debt. Liquidity is *time-to-cash and access*, not *how much*.
**Ideal first version:**
- *Liquidity ladder* — horizontal **stacked-horizon bar**: **now** (checking/savings) → **days** (brokerage) → **penalty/locked** (retirement) → **illiquid** (real assets). The hero; nothing on the market shows this cleanly.
- *Runway gauge* — months of expenses in reachable cash (borrows Cash Flow's baseline — legal under the Graph-Projection Law).
- *Emergency-fund adequacy* — target vs reachable liquid.
**Verdicts:** "You have 2.7 months of accessible cash." / "Most of your money is one week or one penalty away."
**Growth:** model credit lines/HELOC as **contingent liquidity**; the tax/penalty cost of accessing locked funds; AI shock-testing ("if income stopped today…").

### Debt — "What do I owe?"
The mirror of Wealth: liabilities only.
**Forbidden:** assets, net worth, allocation, spending (except debt *payments*).
**Ideal first version (APR/minPayment/limit exist today):**
- *Debt by account* — **ranked bars sorted by APR** (rate is the insight axis; high-APR small balances should scream).
- *Payoff simulator* — avalanche vs snowball with an **interest waterfall** (principal vs interest over time; total interest; debt-free date).
- *Credit utilization* gauge (balance/limit per revolving line).
**Verdicts:** "Your highest-interest debt now costs more than your investments earned." / "You're using 78% of available credit."
**Growth:** refinance/consolidation what-ifs; debt-to-income (borrow Cash Flow's income); credit-score integration; AI payoff coaching linked to discretionary slack.

### Goals — "Am I on track?"
Trajectory vs target, not current state.
**Forbidden:** raw balances, full allocation, spending detail.
**Ideal first version:**
- *Projected completion* — timeline of projected vs target date ("2 months behind at your current pace"), not a bare progress bar.
- *Contribution attribution* + required-pace ("need $420/mo; averaging $310").
- *Scenario slider* — "+$150/mo → 4 months early" (the one interaction that makes goals actionable).
**Verdicts:** "You're on pace to miss the house goal by 3 months." / "One goal is starving the others."
**Growth:** goals become **claims on the graph** (a goal knows which accounts fund it and competes for cash flow); Monte-Carlo bands for market-dependent goals; AI arbitration across goals.

### Investments — "How are my investments performing?"
**Agree with your instinct: keep it intentionally light until holdings exist.** Without positions, the only thing Investments can show is "investment account balances," which *is* a Wealth sub-view — a direct No-Duplication violation. The distinction is strict: **Wealth = where (assets by account/class/institution); Investments = how well (returns/positions/fees/lots).** Until holdings ingestion is real, Investments should be a thin placeholder with an honest empty state, not KPI cards pretending to be analysis.
**Forbidden:** total net worth, cash, spending, debt — and "Wealth's investment slice."
**First version once holdings exist:**
- *Holdings* **treemap** (size = value, color = return) — the hero.
- *Contribution-to-return* **decomposition** (which positions drove the change).
- *Allocation vs target* drift.
- Honest **time-weighted vs money-weighted** return.
**Verdicts:** "Two positions drove 90% of this quarter's gain." / "Fees are quietly costing you 0.7%/yr."
**Growth:** look-through exposure; **fee-drag analysis** (Empower's one great feature, generalized); dividend timeline; tax-lot / unrealized-gain map for harvesting; factor decomposition.

---

## Part II — Answering the eight questions

### 1 & 2. Questions, forbidden content, first versions, and the visualizations that fit
Covered per-Perspective above and in the companion blueprint. The doctrinal point: **each Perspective has a *native grammar*** — a hero visualization no other lens uses. Wealth = ranked bars + composition area; Cash Flow = Sankey + waterfall; Liquidity = the ladder; Debt = APR-ranked bars + interest waterfall; Investments = treemap; Goals = projection timeline + scenario slider. If a proposed Perspective's best view is "someone else's chart, filtered," it fails the Perspective Test and becomes a widget.

### 3. Widgets that must NEVER appear on Overview
These are too dense, too specific, or too interactive for a triage screen — and are the *reason to leave Overview and enter a lens*: the liquidity ladder; the income→spend Sankey; the holdings treemap; the payoff simulator + interest waterfall; institution-risk / concentration (HHI); the recurring/subscription inventory; fee-drag analysis; and any **scenario slider** (Goals/Debt/Liquidity). Overview shows the number and a verdict; depth lives in the lens.

### 4. Taxonomy ruling (applying the Perspective Test)
**First-class now (the current six):** Overview, Wealth, Cash Flow, Liquidity, Debt, Goals. **Investments** is first-class *in principle* but **holdings-gated** in practice (light until then).

**Rulings on the candidates you raised:**

| Candidate | Ruling | Reasoning (against the Test) |
|---|---|---|
| **Spending** | Widget in Cash Flow now → **promote to first-class** when merchant intelligence makes discretion analysis deep. | Distinct question ("what did I spend on, how much was a choice?") vs Cash Flow ("where does money move?"), but today it shares Cash Flow's grammar. Passes #1/#3, borderline #4 until merchant data gives it its own grammar (merchant/discretion decomposition). |
| **Income** | Widget in Cash Flow now → **first-class** when income is multi-source/variable. | Real question with its own risk (source concentration = the income analog of institution risk). Gated on data that makes it non-trivial. |
| **Fees & Costs** | **First-class, mid-term.** | Distinct question ("what is my money costing me?"), a *cross-graph* decomposition (fund fees + interest + subscriptions) no single object view shows. High differentiation. Native grammar = a cost-decomposition/waterfall. |
| **Taxes** | **First-class, holdings+imports-gated.** | Distinct question and grammar (lots, brackets, harvesting). Irreducible. Waits for data. |
| **Property** | **Space-scoped / data-gated.** Widget in Wealth until real-estate nodes exist; first-class inside a Property Space. | Not irreducible at the Personal level until real-estate data exists. |
| **Business** | **Space-scoped**, not a global Personal Perspective. | It's Cash Flow/Liquidity/Debt *run over a business graph* — same lenses, different Space. Spaces, not a new lens. |
| **Risk** | **Strong future first-class (synthesis lens).** | Distinct question ("what could hurt me?") synthesizing concentration + single-institution + single-employer + liquidity-shock + leverage. Today the risk signal lives in Wealth/Liquidity/Investments verdicts; promote when there's enough to synthesize. |
| **Household / People** | **First-class within shared Spaces** (Spaces-native). | Only exists because Spaces exist ("who contributes what, who owes whom, whose goals are on track"). Uncopyable without the Spaces model. |
| **Projections / Time Machine** | **First-class capstone.** | Distinct forward question ("where is this heading?"), a synthesis lens turning every backward Perspective into a forecast. The long-term wedge against planning apps. |

**Principle behind the rulings:** promote to first-class when a question becomes *irreducible* and earns a *native grammar*. Until then it is a widget inside the Perspective whose question contains it. This keeps the lens set small and legible instead of sprawling.

### 5. Five years ahead — designing for capabilities that don't exist yet
Design every Perspective as a **query + verdict + visualizations over the shared graph**, so new data = new edges = existing lenses deepen automatically:
- **Merchant intelligence** → Cash Flow (recurring, contribution, anomalies) + Overview's "what changed" feed. Substrate for narrative and for promoting **Spending**.
- **Holdings** → unlocks **Investments** and upgrades Wealth allocation to true exposure.
- **Real estate / businesses** → new asset nodes appear in Wealth automatically; seed **Property**/**Business** (Space-scoped).
- **Crypto** → asset class today; look-through (stablecoins ≈ cash, staked ≈ locked) enriches Wealth + Liquidity.
- **Imported history** → deepens every time-series and creates the **baselines** that make anomalies meaningful.
- **AI transaction facts** → turn categories into *reasons*; power verdicts and the Overview feed.
- **Relationship graph** → **Household/People** lens; "who owes whom" across Spaces.
- **Ambient intelligence** → the endgame: Perspectives stop being places you *visit* and become things that *speak up*; the workspace is the *explanation surface* for an ambient alert. If every lens already emits a machine-generated verdict, ambient intelligence is a re-packaging of existing work, not a new system.

### 6. The Verdict — make it cross-cutting doctrine
**Yes. Adopt Verdict-First as a product law (Law #3).** Every Perspective opens with one AI-computed sentence; the widgets below are its evidence. This is the highest-leverage design decision in the whole system — it converts "here are charts, you figure it out" into "here's what's true, and here's why." It also future-proofs ambient intelligence.

**The Verdict contract** (so verdicts are consistent, honest, and buildable on the existing `LensResult` engine): a verdict is
`{ claim, magnitude, direction, so-what, confidence, drill-down }` — e.g. *claim:* "Your highest-interest debt costs more than your investments earn," *magnitude:* 22% APR vs 7% return, *direction:* worsening, *so-what:* "every dollar there is losing ~15%/yr," *drill-down:* the Debt payoff waterfall. Rules: a verdict **must be provable by a widget in the same Perspective** (no orphan claims); it degrades gracefully to a neutral description when data is thin (never fabricate); and **Overview's verdict is the ranked set of the Perspectives' verdicts** (the attention strip). This is already latent in the `LensResult` work — formalize it as the headline of every workspace.

### 7. Objects vs questions — where FM materially diverges
This is the sharpest way to see the difference. **Do the incumbents organize around financial *objects* or financial *questions*?**

- **Empower (Personal Capital), Quicken, Monarch, Copilot: objects.** Their primary navigation is *Accounts / Transactions / Budget / Investments / Net Worth* — the nouns of finance. The insight is left to the user: you open Transactions, filter, and assemble the answer to "where does my money go?" yourself. Copilot does spending *analysis* beautifully but is still spending-object-centric; Empower is net-worth-and-portfolio-object-centric; Monarch is budget-and-net-worth-object-centric; Quicken is all objects at once.
- **Origin: closer to questions** (it's planning-led), but the planning is largely **wizard/one-shot**, not a live lens continuously answering a question against real accounts.
- **Fourth Meridian: questions.** Navigation is the *questions themselves* — how am I doing / where's my money / where does it move / how accessible / what do I owe / am I on track. The **product** assembles the answer (and, with verdicts, answers before you ask).

**Where it becomes a different category — three compounding moves:**
1. **Question-navigation** shifts the analytical burden from user to product (objects → questions).
2. **Spaces** run the *same questions* over *different scopes* (personal / household / a business / a single goal / a merchant operation) — a dimension no object-centric consumer app occupies.
3. **Verdicts** make the product *notice and speak* rather than wait to be read.

Object-centric apps can add a chart; they can't easily become question-centric without re-founding their navigation, their data model as a graph, and their notion of "one financial life" as "many Spaces." That re-founding is FM's moat: **graph + lens + Spaces + verdict.**

### 8. Implementation order (dependency-driven)
Sequence by *data readiness × differentiation*, not by familiarity:

1. **Wealth** (assets-only) — buildable now; proves the No-Duplication Law; ranked bars + assets allocation + institution allocation + **composition-over-time** + concentration.
2. **Liquidity** — buildable now, most differentiated, cheapest strong v1 (the ladder + runway). *Sequence early despite its dull name.*
3. **Cash Flow** — Sankey + waterfall now; recurring/discretionary and anomalies **as merchant intelligence matures**.
4. **Debt** — APR-ranked bars + payoff/interest waterfall + utilization; buildable now.
5. **Goals** — projection + contribution + scenario slider; buildable now.
6. **Investments** — **hold until holdings exist**; thin honest placeholder until then, then treemap + contribution + fees.

**Cross-cutting, in parallel:** ship the **Verdict headline on every workspace** (formalize `LensResult` as the header) — it upgrades every Perspective at once and is the single highest-leverage item.

**Data-dependency summary:**
- *Buildable today:* Wealth, Liquidity, Debt, Goals, and Cash Flow's structural views (Sankey/waterfall).
- *Merchant-intelligence-gated (dramatically better):* Cash Flow's recurring/anomaly/contribution; promotion of **Spending**; much of the Overview "what changed" feed.
- *Holdings-gated:* **Investments** (all of it), Wealth's look-through, **Taxes**, **Fees**.
- *AI-facts-gated (transformative, not blocking):* every **Verdict**, anomaly narration, ambient alerts, goal/debt arbitration.

---

## The one rule to remember

Overview answers **"what?"** Perspectives answer **"why?"** A Perspective is a *question* with a *verdict* and the *decomposition that proves it* — a projection of one graph, never a second dashboard. Build every lens that way and each new data source makes all of them deeper for free, while the product moves from *showing you objects* to *answering your questions* — which is the category Fourth Meridian is trying to own.
