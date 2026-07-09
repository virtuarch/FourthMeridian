# FourthMeridian — Architectural Prioritization Report

*Roadmap planning. Dependency-graph reasoning, not implementation.*
*Date: 2026-07-09*

---

## 1. The controlling idea: a layered dependency graph

Every initiative on your list is a node in a stack of layers. Work is *parallelizable* when it lives on a **different layer** from what you're actively touching, and *blocking* when it shares a layer.

You are currently working in **Layer 4 (Composition & Presentation)** — Space Templates, widget polish, layout, UX. So the question "what can progress in parallel without blocking me?" reduces to: **what lives below Layer 4 and feeds it without dictating composition?**

```
Layer 5  Multi-entity / Enterprise
         Business · Property · Household · Government · Operations
         Multi-owner · Org-level intelligence · Platform Operations
              ▲  (blocked by L4 template stability + L1 multi-entity model)
              │
Layer 4  Composition & Presentation   ◀── YOU ARE HERE
         Spaces · Space Templates · Saved layouts · Widget bank · Chart bank
         Perspective customization · Workspace editing · URL nav · Mobile · Theme
              ▲  consumes facts + data; does not produce them
              │
Layer 3  Intelligence Engines
         Verdict · Opportunity · Recommendation · LensResult · Narratives · Ambient
              ▲  reasons over facts
              │
Layer 2  Facts & Memory
         AI Facts / Persistent Financial Facts · AI Memory
              ▲  derived, durable knowledge
              │
Layer 1  Canonical Data Model
         Investment Positions · Holdings · Normalized txns · Merchant Intelligence
              ▲  structured truth
              │
Layer 0  Ingestion Substrate
         Provider adapters · CSV · Historical imports · Wallets
```

**The key asymmetry:** Layers 0–2 push data *up* into widgets. They change what a widget can *say*, never how a Space is *arranged*. That is precisely the seam that lets another engineer work for months without ever touching your template surface. Layer 4 items (saved layouts, widget bank, perspective customization, workspace editing) share your surface — they are the *worst* parallel picks right now, regardless of their standalone value. Layer 5 is doubly blocked: it needs your template model to stabilize *and* a multi-entity data model that doesn't exist yet.

Two nodes are fan-out roots — the whole graph widens above them:

- **AI Facts (L2)** is the root of every intelligence initiative in Layer 3.
- **Positions/Holdings (L1)** is the root of every real wealth/investment analysis.

Investing there first is why the recommendations below skew toward substrate.

---

## 2. Group analysis

Each initiative answered on: **(1) Why now · (2) What it unlocks · (3) Immediate beneficiaries · (4) Independent of Space Template work?**

### A. Platform Foundation

**Investment Positions & Holdings** — *Layer 1, fan-out root*
1. *Why now:* Wealth ships as aggregates today; position-level granularity is the single largest gap between "a number" and "an analyzable portfolio." Every future investment feature dead-ends without it.
2. *Unlocks:* allocation analysis, cost basis, performance/return series, concentration & risk verdicts, rebalancing opportunities, tax-lot reasoning.
3. *Benefits now:* Wealth perspective gains depth; Goals can reference real holdings.
4. *Independent?* **Yes.** Pure data-model + ingestion work below the presentation cut.

**AI Facts / Persistent Financial Facts** — *Layer 2, fan-out root* (also appears in Group C)
1. *Why now:* Every AI feature you've scoped re-derives the same context. A canonical, queryable, durable facts store is the substrate that makes the entire intelligence layer cheap instead of each engine paying full cost.
2. *Unlocks:* Verdict, Opportunity, Recommendation, Narratives, Ambient notifications, AI memory — all of Layer 3.
3. *Benefits now:* any current AI/LensResult path gets a stable place to read/write instead of recomputing.
4. *Independent?* **Yes.** A backend store + write/query contract. Widgets consume it later; it dictates nothing about layout.

**Provider Adapters** — *Layer 0*
1. *Why now:* Data breadth is the cheapest way to make *every* perspective richer at once. A hardened adapter contract turns "add a source" into routine work.
2. *Unlocks:* every new institution/source; Wallets; broader Positions coverage.
3. *Benefits now:* Wealth, Liquidity, Cash Flow, Debt — all improve as coverage widens.
4. *Independent?* **Yes.** Ingestion contract, entirely below Layer 4.

**Merchant Intelligence** — *Layer 1 enrichment*
1. *Why now:* Transactions already flow (Cash Flow is done). Enrichment is a high-payoff pass over data you already have — fast win, warms up the enrichment pattern others will reuse.
2. *Unlocks:* categorization quality, spend insights, recurring-merchant detection, later Recommendation inputs.
3. *Benefits now:* Cash Flow and the emerging Activity tab immediately.
4. *Independent?* **Yes.** Enrichment layer over existing txns.

**Historical Imports / Backfill** — *Layer 0*
1. *Why now:* Time-series widgets are only as deep as their history. Backfill retroactively upgrades every trend, chart, and paydown curve without touching the widgets.
2. *Unlocks:* meaningful trend/verdict-over-time, seasonality, narrative "vs last year."
3. *Benefits now:* Cash Flow trends, Wealth history, Debt paydown history.
4. *Independent?* **Yes.** Batch ingestion; orthogonal to layout.

**CSV Improvements** — *Layer 0*
1. *Why now:* Lowest-cost coverage for anything without an adapter; long-tail unblocker.
2. *Unlocks:* import breadth, user self-service.
3. *Benefits now:* any perspective missing a source.
4. *Independent?* **Yes**, but lower impact — fold into the adapter/import track.

**Wallets** — *Layer 0/1*
1. *Why now:* Extends coverage into crypto/alt holdings.
2. *Unlocks:* fuller net-worth picture.
3. *Benefits now:* Wealth, Liquidity.
4. *Independent?* Mostly — but **depends on** the adapter contract and Positions model landing first. Sequence after them.

**Saved Layouts** — *Layer 4* ⚠️
1. *Why now:* You'll need it — but as a serialization/persistence format it sits *underneath* Space Templates.
2. *Unlocks:* template save/restore, sharing.
3. *Benefits now:* templates.
4. *Independent?* **No.** Same surface you're refining. High collision. **Keep this yours, not a parallel track.**

### B. User Experience

**URL-backed Navigation** — *Layer 4, in-flight*
1. *Why now:* Foundational plumbing for deep links, shareable Spaces, the Activity tab.
2. *Unlocks:* shareability, ambient-notification link targets, back/forward correctness.
3. *Benefits now:* every tab.
4. *Independent?* **No — you're already doing it.** Handing it off collides directly with you. Finish it yourself.

**Chart Bank** — *Layer 4, but component-shaped*
1. *Why now:* A reusable chart component library is more of a library than a composition concern.
2. *Unlocks:* consistent visualization across widgets; faster widget authoring.
3. *Benefits now:* every data widget.
4. *Independent?* **Partly.** Standalone as a component library, but its output lands in widgets that land in templates. Medium collision — safe if scoped as "components," risky if scoped as "how widgets are placed."

**Theme Improvements** — *Layer 4, styling*
1. *Why now:* Pure styling, cleanly separable.
2. *Unlocks:* polish, later white-label/enterprise theming.
3. *Benefits now:* whole app.
4. *Independent?* **Yes**, but low impact relative to substrate. A good "spare cycles" task, not a headline.

**Mobile Improvements** — *Layer 4, separate surface*
1. *Why now:* Distinct surface, parallelizable by construction.
2. *Unlocks:* mobile reach.
3. *Benefits now:* users on mobile.
4. *Independent?* **Partly** — depends on component stability. Medium.

**Widget Bank · Perspective Customization · Workspace Editing** — *Layer 4* ⚠️
All three share your exact surface. **Highest collision risk on the board. Do not parallelize these now.** They become natural *after* templates stabilize.

### C. AI / Intelligence

**Persistent Financial Facts** — *see Group A. This is the entry point to all of Layer 3.*

**LensResult Evolution** — *Layer 2/3 contract*
1. *Why now:* The contract perspectives emit and AI consumes. Hardening it early prevents rework across every engine.
2. *Unlocks:* stable interface for Verdict/Opportunity/Narratives.
3. *Benefits now:* current LensResult consumers.
4. *Independent?* **Mostly** — a schema/contract change, backend-weighted. Low-medium collision. Pairs naturally with AI Facts.

**Verdict Engine** — *Layer 3*
1. *Why now:* The first visible payoff of the Facts investment; turns data into judgment.
2. *Unlocks:* Ambient notifications, opportunity surfacing, narratives.
3. *Benefits now:* every perspective gains an assessment.
4. *Independent of templates?* **Yes.** But **depends on AI Facts** (another parallel track, not on you). Buildable against a Facts interface stub.

**Opportunity Engine** — *Layer 3*
1. *Why now:* High user value — proactive "here's what to do."
2. *Unlocks:* Recommendation engine.
3. *Benefits now:* Wealth, Debt, Cash Flow.
4. *Independent?* Yes of templates; **depends on Facts + Positions.** Sequence after both.

**Recommendation Engine · Ambient Notifications · Weekly/Monthly Narratives · AI Memory** — *Layer 3*
All depend on Facts (and some on Verdict). Genuinely high value, but they are **downstream of the substrate** — the *next wave*, not the parallel-now wave. Starting them before Facts means each pays full context cost and rewrites when Facts lands.

### D. Enterprise / Future Spaces

**Business · Property · Household · Government · Operations Spaces** — *Layer 5*
1. *Why now:* Not now. These generalize the Space abstraction across *entities*.
2. *Unlocks:* the platform's long-term TAM.
3. *Benefits now:* nothing yet.
4. *Independent?* **No — doubly blocked.** They need (a) your Space Template model stable and (b) a multi-entity data model in Layer 1 that doesn't exist. Premature parallelization here is the highest-risk mistake available.

**Multi-owner Spaces · Org-level Intelligence** — *Layer 5.* Blocked by template stability + facts/data maturity. Long horizon.

**Platform Operations** — *cross-cutting*
1. *Why now:* Observability/infra is genuinely independent and compounds as data volume grows.
2. *Unlocks:* reliability for everything above.
3. *Benefits now:* whole platform.
4. *Independent?* **Yes**, but not a product-leverage headline — background reliability track.

---

## 3. Ranking

**Impact** = breadth × depth of downstream unlock.
**Dependency load** = how much *unfinished* upstream work it needs (Low = few blockers = better).
**Parallelizability** = how cleanly it avoids your Layer-4 template surface (High = better).

| Initiative | Layer | Impact | Dependency load | Parallelizability |
|---|---|---|---|---|
| AI Facts / Persistent Financial Facts | 2 | **High** | Low | **High** |
| Investment Positions & Holdings | 1 | **High** | Low | **High** |
| Merchant Intelligence | 1 | High | Low | **High** |
| Provider Adapters | 0 | High | Low | **High** |
| Historical Imports / Backfill | 0 | Med-High | Low | **High** |
| LensResult Evolution | 2–3 | Med-High | Med | Med-High |
| CSV Improvements | 0 | Med | Low | High |
| Verdict Engine | 3 | High | **High** (needs Facts) | Med |
| Wallets | 0–1 | Med | Med (needs adapters) | Med |
| Chart Bank | 4 | Med | Low | Med |
| Theme Improvements | 4 | Low-Med | Low | High |
| Mobile Improvements | 4 | Med | Med | Med |
| Opportunity Engine | 3 | High | **High** | Med |
| Recommendation / Narratives / Ambient / AI Memory | 3 | High | **High** | Low-Med |
| URL-backed Navigation | 4 | Med-High | Med | **Low** (you own it) |
| Saved Layouts | 4 | Med | High | **Low** (collides) |
| Widget Bank / Perspective Cust. / Workspace Editing | 4 | Med | High | **Low** (collides) |
| Platform Operations | x-cut | Med | Low | High |
| Business/Property/Household/Gov Spaces | 5 | High (long-term) | **Very High** | **Low** (doubly blocked) |
| Multi-owner / Org Intelligence | 5 | Med-High | Very High | Low |

The pattern is clean: everything scoring **High impact / Low dependency / High parallelizability** lives in **Layers 0–2**. Everything scoring Low parallelizability is either your surface (L4) or blocked by it (L5).

---

## 4. The answer: 5 highest-leverage parallel initiatives

If you spend the next month refining Space Templates and polishing UX, these are the five another engineer can build without ever touching your surface. All sit in Layers 0–2 — they push data and facts *up* into widgets and dictate nothing about composition.

**1. AI Facts / Persistent Financial Facts store** *(Layer 2 — the highest-leverage single item)*
The fan-out root of your entire intelligence roadmap. Building it now makes Verdict, Opportunity, Recommendation, Narratives, and Ambient each cheap instead of each expensive. Zero template dependency; a backend store + read/write contract.

**2. Investment Positions & Holdings** *(Layer 1)*
The data-depth root for every real wealth and investment analysis. Turns Wealth from aggregates into an analyzable portfolio and unlocks allocation, performance, concentration, and rebalancing downstream. Pure model + ingestion.

**3. Merchant Intelligence** *(Layer 1)*
The fastest payoff on the list — enrichment over transactions you already have. Immediately improves Cash Flow and the emerging Activity tab, and pre-stages Recommendation inputs. Fully independent.

**4. Provider Adapter framework** *(Layer 0)*
Hardening the ingestion contract makes *every* perspective richer at once and turns "add a source" into routine work. The contract also gates Wallets and broader Positions coverage. Entirely below your surface.

**5. Historical Import / Backfill pipeline** *(Layer 0)*
Retroactively upgrades every time-series widget — Cash Flow trends, Wealth history, Debt paydown — without touching the widgets themselves. Prerequisite for any "over time" verdict or narrative later.

### Suggested build order for one engineer over the coming months

Leverage-ranked ≠ sequence. For a single parallel engineer:

1. **Merchant Intelligence** — quick win, immediate visible payoff, establishes the enrichment pattern.
2. **AI Facts store** — lay the substrate while the rest of the graph is still small.
3. **Investment Positions & Holdings** — the deep data model.
4. **Provider Adapters + Historical Import** — breadth and depth of ingestion (naturally paired).
5. **Verdict Engine** *(stretch)* — the first consumer of AI Facts. Depends on track 2, not on you; build it against the Facts interface. Proves the substrate and de-risks the rest of Layer 3.

### What to deliberately NOT parallelize now

- **Saved layouts, Widget bank, Perspective customization, Workspace editing** — same surface you're refining. Collision, not parallelism.
- **URL-backed navigation** — you're already building it.
- **Enterprise / Future Spaces (Business, Property, Household, Government)** — doubly blocked by template stability *and* an absent multi-entity data model. The single highest-risk place to start early.
- **Recommendation / Ambient / Narratives** — real value, but downstream of Facts. They're the *next* wave; starting them before Facts guarantees rework.

**The one-line thesis:** you're working at the composition layer, so the safe, high-leverage parallel work is everything that *feeds* that layer from below — data (Layers 0–1) and facts (Layer 2) — while the intelligence engines that consume facts wait one tier back, and the enterprise Spaces that consume your templates wait until the templates are done.
