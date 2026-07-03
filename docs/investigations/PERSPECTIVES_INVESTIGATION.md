# Perspectives — Product Investigation

**Status:** Investigation only. No implementation, no code, no schema, no migrations.
**Date:** 2026-07-03
**Branch context:** `feature/phase-2-architecture`, baseline v2.3.0. Nothing here modifies or re-litigates the Phase 2 freeze; where a recommendation touches frozen decisions (D4, D9, D3, G2), the dependency is named explicitly.

---

## 1. What Perspectives are today

Evidence: `lib/perspectives.ts`, `components/dashboard/widgets/PerspectivesWidget.tsx`, `PerspectiveSwitcher.tsx`, `lib/space-nav.ts`, `docs/investigations/V25_PRODUCT_POLISH_INVESTIGATION.md` §2.1/G7.

Perspectives currently consist of a static library of 9 lenses plus the default `overview` ("Atlas") lens, ordered per Space category via config-over-branching. Four lenses (Investments, Debt, Retirement, Goals) are "available" — meaning a card that routes to an existing tab. Five (Wealth, Cash Flow, Tax, Property, Business Health) are `comingSoon` placeholders. A `PerspectiveSwitcher` dropdown exists atop Overview but composition switching is disabled (`COMPOSITION_SWITCHING_ENABLED` false). Perspectives hold the #2 slot in the nine-tab Space rail.

The honest description: **Perspectives today are a navigation pattern wearing a concept's name.** An "available" Perspective adds a second entry point to a feature that already has one; a `comingSoon` Perspective is a promise. The code itself documents the unresolved identity — `lib/perspectives.ts` maintains two competing metaphors (composition-switching lenses that reshape the Overview canvas vs. card launchers that route elsewhere) and carefully rations "exactly one navigation path to each" to keep them from colliding. When a concept needs that much traffic control before it has any business logic, the concept is underdefined, not the routing.

That is not a criticism of the pass that built it — it was explicitly scoped as entry-points-only. But it means the definitional question is genuinely open, which is what this investigation is for.

---

## 2. The definitional question: eight candidate identities

The brief lists eight things Perspectives could represent. They are not eight competing options. They sort into three layers — **what a Perspective computes** (lens), **how it comes to exist** (authored by system, user, or AI), and **how long it lives** (ephemeral, saved, scheduled) — plus several that fail as an identity altogether.

**User-defined filters** — fails as identity. A filter is a property of a table or chart, not a product concept. If Perspectives are filters, they should be demoted into the surfaces they filter and the tab deleted.

**Dashboards** — fails as identity. It collides directly with Overview (the code already trips on this: the `overview` lens can never be a card because clicking it would open the page you're standing on). "Configurable dashboard builder" is also the most commoditized idea in this category — Empower, Kubera, and Monarch all ship variants of it — and configurable-widget systems have a well-documented graveyard problem: the median user never configures anything. A product that should feel modern in ten years does not bet its defining concept on user-assembled widget grids.

**Reports** — fails as identity, survives as an *output*. A report is a Perspective frozen at a point in time and exported. That matters (see the advisor review, §3.3) but it is a verb on the concept, not the concept.

**Behavioral analyses** — fails as identity. Spending Behavior is one lens among many (evaluated in §4), not what the whole system is.

**Financial lenses** — necessary but insufficient. This is what the code already claims ("different lenses through which the same underlying Space data is viewed"), and it is the right *presentation* answer. But a lens with no state, no scope control, no lifecycle, and no answer is indistinguishable from a tab — which is exactly the trap the current implementation is in.

**Saved analyses** and **temporary investigations** — these are the same thing at two points in a lifecycle, and together they supply what lenses lack: state and persistence. A user opens a question ("could I raise $200k in 30 days?"), the system answers it through a lens, and the user either discards it or keeps it.

**AI-generated viewpoints** — powerful as an *authorship mode*, dangerous as the identity. If Perspectives are defined as "things the AI shows you," the concept inherits every trust, cost, and non-determinism problem of the AI layer, and it inverts the codebase's own deterministic-first principle. AI should be able to *propose* and *narrate* Perspectives; it should never be what a Perspective *is*, and it must never be the thing computing the numbers.

### 2.1 Proposed identity

> **A Perspective is a saved, scoped, answerable question about a defined set of money.**

Concretely, a Perspective has four parts:

1. **A lens** — one of a small, system-authored library of typed analytic engines (Net Worth, Liquidity, Cash Flow, Debt, …). Users never author lenses; they are versioned product code with defined inputs and correctness guarantees.
2. **A scope** — which accounts, and eventually which Spaces/entities, the lens reads. This is where user definition lives, and it is the only place it needs to live.
3. **An answer posture** — every Perspective leads with a verdict: one number and one deterministic sentence ("You could raise ~$218k within 30 days; $164k of it without tax consequences"), with the supporting detail beneath. AI narrative, when it arrives, layers on top of deterministic figures and cites them — it never replaces them.
4. **A lifecycle** — instantiated ephemerally (a question asked once), promotable to saved (pinned to a Space), and eventually schedulable (a monthly snapshot) or shareable (a curated view granted to a member).

This composes all eight candidates instead of choosing among them: lenses are the engine, filters collapse into scope, temporary investigations and saved analyses are lifecycle states, reports are exports, dashboards are "the set of Perspectives pinned to a Space," AI is an authorship/narration mode, and behavioral analysis is one lens.

The one-sentence relationship to the rest of the product: **Spaces organize money; Perspectives interrogate it.** Spaces answer "where does this live and who can see it"; Perspectives answer "what is true about it."

---

## 3. Perspective reviews

### 3.1 End User

The current Perspectives tab is a net negative for cognitive load: 5 of 9 cards wear a "Soon" badge, and the 4 working ones duplicate navigation the rail already provides. A user who explores the tab twice learns to stop opening it — placeholder fatigue is real and it trains disuse of exactly the surface the product hopes to make defining.

The deeper end-user problem is that nobody wants a "lens." People wake up with *questions*: am I okay? Can I afford this? Why did my net worth drop? What do I do about my debt? The lens taxonomy is the product team's mental model, not the user's. The answer-posture requirement in §2.1 is therefore not polish; it is the whole end-user case. A Liquidity Perspective that opens with a table of accounts is a report; one that opens with "you can access $218k within 30 days" is an answer. The second is the only version a normal person uses weekly.

Discoverability follows from that: the best entry point to a Perspective is not a card grid, it's the moment the question arises — a net-worth dip on Overview should offer the "what changed" Perspective inline; tax season should surface the Tax Perspective; a big incoming expense should surface Liquidity. Cards can stay as the browsable library, but ambient, contextual entry is what makes the concept feel alive rather than filed.

Against my own proposal: the lifecycle machinery (ephemeral → saved → scheduled) is power-user furniture. Decades of configurable-software evidence say most users keep defaults. So defaults must be excellent *without any configuration*: each Space category ships with 2–4 pre-instantiated, real Perspectives, and the save/scope machinery reveals itself only when someone edits. If the v3.0 design requires a user to "create a Perspective" before getting value, it has failed the end user.

### 3.2 Principal Engineer

The existing foundation is better than the feature it currently powers. Config-over-branching, a host-agnostic library, per-category ordering mirroring `space-presets.ts` — adding the proposed model is an evolution of this file, not a rewrite. `SpaceTemplate.defaultPerspectiveConfig Json?` in the D9 freeze already reserves a slot for perspectives-as-data; the architecture anticipated this investigation's conclusion.

The single biggest engineering risk is a seductive one: generalizing the lens layer into a query engine or analysis DSL so users (or the AI) can define arbitrary analyses. Do not. A generic financial query engine is unbounded surface area, unbounded correctness liability, and the classic way products of this shape drown. The defensible architecture is a **fixed, small library of typed lens assemblers behind one interface** — each lens a versioned function from (scope, timeframe) to a typed result, individually testable, individually correct — with all flexibility concentrated in scope selection. Flexibility in *what you point the lens at*, never in *what the lens computes*. This is the same discipline the codebase already applies elsewhere (deterministic-first AI, single LLM seam).

Sequencing constraints, from the frozen plan rather than from preference: any Perspective persistence (saved scope referencing account IDs) must wait until D11/D3 land and legacy `Account` is out of read paths — a saved Perspective pinned to legacy IDs is a migration landmine. Cross-Space Perspectives depend on G2 visibility-tier enforcement in every assembler and are the natural first consumer of `PublishedAccountView`. AI narration must read exclusively through the D4 Context Builder, and lens assemblers themselves become the obvious deterministic feed *into* D4 — one assembler serving both the UI and the AI is less code and one fewer correctness surface than two parallel read paths. None of this requires new Phase 2 decisions; it requires respecting their order.

Also worth saying plainly: the two-dashboard split (`DashboardClient` vs `SpaceDashboard`, divergent tab vocabularies) doubles the wiring cost of every real Perspective. The freeze leaves that alone for v2.5, correctly — but it means each lens shipped before consolidation pays a 2× integration tax, which is an argument for shipping *few* lenses soon and *many* lenses only after decomposition.

### 3.3 Professional Wealth Manager / Financial Advisor

Read the candidate lens list again and it is, almost exactly, the agenda of an annual financial-plan review: net worth, cash flow, liquidity, debt, retirement readiness, tax posture, investment allocation, insurance coverage, estate/business interests. That is the strongest external validation the concept has — Perspectives are the review meeting, decomposed into standing views. Most consumer apps show clients *what they have*; advisors are paid largely to notice *what's missing or mispositioned*. A lens library that includes coverage-gap thinking (uninsured risk, concentration, no liquidity buffer) is doing advisor work, and that is rare in this category.

Correctness discipline is where this profession pushes hardest. Three specific warnings. First, **Retirement**: a deterministic projection with visible assumptions (return, inflation, spend rate) is defensible; a single confident "you're on track" without surfaced assumptions is malpractice-shaped. Every projection must show its assumptions and let them be adjusted. Second, **Taxes**: an inventory lens (realized gains YTD, tax-advantaged headroom, holding-period flags, document checklist) is valuable and safe; anything resembling a recommendation ("harvest this loss") crosses into advice with real liability and jurisdictional complexity — keep the v1 tax lens strictly descriptive. Third, **provenance**: an advisor will not trust — and a client should not trust — any number that can't show its sources. Every Perspective figure needs a traceable path to accounts and timestamps. This requirement happens to be exactly what the AI-narration layer needs too, so it pays twice.

On workflow realism: clients screenshot dashboards and email them to advisors today. A Perspective exported as a clean, dated, source-annotated snapshot is the artifact that actually enters a professional workflow — and it is cheap once the lens exists. This is the strongest argument for keeping "report" as a first-class verb on Perspectives.

### 3.4 High-Net-Worth Individual

For this user, per-Space Perspectives are table stakes; **cross-entity Perspectives are the product**. The questions that matter are consolidations: total exposure to a single asset or sector across personal, trust, and business entities; consolidated liquidity ("where do I find $2M in 30 days and what does each source cost me?"); entity-by-entity views of the same lens. Spaces partition; this user's real questions cut across partitions. Kubera serves entity consolidation with nested portfolios — at the $2,499/yr Black tier — but as static balance-sheet rollups, without a permission model and without a question layer. That is the gap.

Privacy is not a constraint on this feature; it *is* the feature. A Perspective is a **curated disclosure surface**: share the "Family Net Worth" Perspective with a spouse at summary depth without exposing K-1 detail; give the college-age kid a view of their 529 and nothing else; give the advisor liquidity and allocation but not transaction history. Perspective-level sharing with visibility tiers respected is family-office-grade functionality at consumer packaging, and no mainstream app offers it. It is also where the sharpest engineering danger lives — see §5.

Time efficiency cuts against configuration: this user will not build Perspectives from parts, but will happily accept proposed ones ("You now hold this position in three entities — want a consolidated exposure view?") if the numbers are trustworthy and the proposal is dismissible. And a candid product note: Spending Behavior and Opportunity Cost lenses read as retail to this audience; exposure, liquidity, tax, and entity views are what they will judge the product on.

### 3.5 Wildcard: Decision Scientist (behavioral economics / cognitive science)

Chosen because the core claim of Perspectives is *representational* — that showing the same data differently changes what people understand and do — and that claim is the home turf of framing research, not of engineering or finance. If the claim is false, Perspectives are decoration; if true, the defaults are behavioral interventions and should be designed as such.

The claim is true, and it cuts both ways. Framing and mental-accounting effects are robust: which accounts are salient changes repayment and savings behavior; a debt-forward view produces different choices than a net-worth-forward view of identical data; and net-worth framing can *license* spending ("I'm worth plenty") just as debt framing can motivate payoff. Three design consequences follow. First, **default lens assignment per Space category is a behavioral decision, not a nav decision** — putting Debt first in a DEBT_PAYOFF Space is an intervention, and probably the right one, but it should be chosen deliberately per category rather than falling out of layout. Second, **choice overload is the failure mode of the library**: fourteen lenses presented as a grid produces less engagement than four presented as questions. The library can be large; the *surface* must be small and contextual. Third, **salience should be seasonal and situational** — people ask financial questions episodically (tax season, a home purchase, a market drop, a new job), so a Perspectives system that surfaces the right lens at the right moment will outperform a static grid by a wide margin, and this "temporal relevance" behavior is itself hard for competitors to copy because it requires the lens + event infrastructure, not just UI.

One warning from this seat that conflicts with product enthusiasm elsewhere in this document: the **Opportunity Cost** lens is behaviorally hazardous. Counterfactual displays ("had you invested this in X…") induce regret, and regret induces both churn and worse decisions (performance-chasing). The benchmark choice is also arbitrary enough to be spurious precision. Recommend rejecting it as a standing lens (see §4).

---

## 4. The fourteen candidate lenses

Criteria: does it ask a distinct question of distinct data; can it be computed deterministically from data the product realistically has; what is the correctness risk; who is it for.

| Lens | Distinct question | Data feasibility | Correctness risk | Verdict |
|---|---|---|---|---|
| Net Worth | "What changed, and why?" (attribution, not the number) | High — already core | Low | **Core lens.** The Overview shows the number; the lens owns trend + attribution. |
| Cash Flow | "What comes in, goes out, and what's the trajectory?" | Medium — gated on transaction semantics (G12, v2.5.5) | Medium (pending/settled correctness) | **Core lens**, after G12. Do not ship on unsettled transaction data. |
| Liquidity | "How much cash can I raise, how fast, at what cost?" | High — derivable from account types + balances, tiered by access time | Low–medium (penalty/tax caveats must be ranges, not promises) | **Core lens and the sleeper.** Rare in consumer apps, deterministic, HNWI-critical, useful to everyone with an emergency. |
| Debt | "What does my debt cost and when am I free of it?" | High — exists as a tab | Low | **Core lens.** Upgrade from balances to payoff trajectory + blended cost of debt. |
| Retirement | "Am I on pace, under which assumptions?" | High — exists as a tab | **High** — projections | Keep, with surfaced/adjustable assumptions. Never a bare verdict. |
| Taxes | "What is my tax-relevant inventory?" | Medium | **High** if it recommends; low if descriptive | Keep, strictly descriptive v1: realized gains, contribution headroom, holding periods, documents. No advice. |
| Investments | "What am I actually exposed to, across accounts?" | High account-level; look-through concentration is hard | Medium | Keep. Account-level exposure first; fund look-through later. |
| Insurance | "What risks am I carrying uninsured?" | **Low** — mostly manual entry; no aggregation feeds | Medium | Advisor-beloved, data-starved. Later; needs a manual-entry story first. |
| Business | "Revenue, runway, payroll?" | Low — needs feeds the product lacks | Medium | Keep as BUSINESS-Space lens, later. Don't fake it with placeholders longer than necessary. |
| Real Estate | "Equity, carrying cost, concentration?" | Medium — needs valuation source or manual marks | Medium (valuation provenance) | Keep, moderate priority. Valuations must show their source. |
| Risk | "How fragile is my position?" | — | — | **Reject as a single lens.** It's an umbrella over concentration (Investments), coverage (Insurance), and buffer (Liquidity). Possibly a later composite "Resilience" view built *from* other lenses. |
| Income Stability | "How concentrated and variable is my income?" | Medium — derivable from transaction history | Low | Real and underserved (freelancers, equity-comp). Fold into Cash Flow v1; promote to its own lens if usage warrants. |
| Spending Behavior | "Where does my money go, and what patterns am I in?" | High | Low | Keep, low differentiation — every budgeting app has this. Its differentiated form is the narrative layer on Cash Flow, not a separate commodity lens. |
| Opportunity Cost | "What did this choice cost me vs. the alternative?" | Medium | High — arbitrary benchmarks, regret induction (§3.5) | **Reject as a standing lens.** At most an occasional, opt-in AI-narrative element with heavy framing care. |

Net: fourteen candidates reduce to roughly **six core lenses** (Net Worth/attribution, Cash Flow + income stability, Liquidity, Debt, Investments/exposure, Retirement) plus descriptive Taxes, with Insurance/Business/Real Estate as data-gated followers and Risk/Opportunity Cost rejected in their proposed forms. A ten-year-modern product ships six excellent lenses, not fourteen thin ones.

---

## 5. Conflicts between the reviews — stated, not averaged

**Engineer vs. HNWI: fixed lenses vs. arbitrary questions.** The HNWI wants to ask anything across any entity; the engineer refuses to build a query engine. These are truly in tension. Resolution direction (a real choice, not a compromise): fixed lens library × fully flexible scope. "Consolidated exposure across three entities" is the *Investments lens pointed at a cross-Space scope*, not a new analysis. Questions that no lens can express go to the AI conversation layer (through D4), which can *compose and narrate* lens outputs but not compute novel financial math. Some HNWI questions will remain unanswerable in-product; accept that over the DSL.

**End User vs. HNWI: opinionated defaults vs. composability.** Resolved by ordering, not balance: defaults first, and they must stand alone (§3.1); scope editing and saving exist but are never required for core value. If analytics later show meaningful save/scope usage only among a small power segment, that is success, not failure — that segment is the paying one.

**Advisor vs. AI ambition: provenance vs. generativity.** The advisor's demand (every number traceable) is a hard constraint on the AI mode: AI proposes and narrates, deterministic assemblers compute, citations point at assembler outputs. Any design where the model produces a figure directly is rejected — consistent with the codebase's deterministic-first stance, so this conflict is settled by existing principle.

**Behavioral scientist vs. delight: motivating frames vs. pleasant ones.** A Debt-forward default helps payoff behavior but feels punitive; a net-worth-forward default feels good but can license spending. No universal answer — it is a per-category decision (DEBT_PAYOFF Spaces earn the confronting frame; PERSONAL probably leads with attribution/trend). Flagged as a deliberate design decision to make per category, with the option to let users re-order.

**Privacy: the aggregation-inference problem (sharpest single hazard).** Cross-entity Perspectives and Perspective-sharing collide in a subtle way: an aggregate can leak what visibility tiers hide. A member with BALANCE_ONLY access to some accounts who sees a shared "Family Net Worth" total can subtract the accounts they *can* see and infer the hidden remainder. Perspective-level sharing therefore cannot be a simple "share this view" bit; shared aggregates must be defined over *disclosed-to-recipient* scopes only, or explicitly marked as intentional disclosures by the owner. This is a G2/PublishedAccountView-adjacent design problem and one reason sharing sits last in the sequencing below.

---

## 6. Should Perspectives become a defining concept?

**Yes — conditionally.** It is the best candidate the product has: Spaces are (correctly) an organizational concept, and organization alone doesn't differentiate; the interrogation layer can. The conditions:

1. **The redefinition happens.** As a lens-router, Perspectives will never be defining — renamed tabs are Mint. The concept earns the tab only as scoped, answer-led questions.
2. **Cross-Space scope ships eventually.** Per-Space lenses are good software; cutting across entities with the permission model intact is the part nobody else has (Kubera's nested portfolios come closest and lack both the permission model and the question layer).
3. **Concept inflation is resisted.** The product already asks users to learn Spaces, Atlas, Timeline, Perspectives. Each noun costs onboarding. If Perspectives become defining, something else should recede — the honest candidate is the Perspectives *tab* itself, whose card grid could dissolve into contextual entry points (§3.1) once lenses are real. A defining concept doesn't need a tab; it needs to be how the product thinks. Counterpoint, acknowledged: a tab gives the concept a browsable home and marketing legibility. Decide at v3.0, not now.

---

## 7. Concluding answers

**1. What would make this genuinely differentiated from every other personal finance app?**
Three things, compounding: (a) **answer-led lenses** — every Perspective opens with a deterministic verdict sentence with traceable sources, not a chart page; (b) **cross-entity scope under a real permission model** — consolidated liquidity/exposure/net-worth across Spaces with visibility tiers enforced, i.e. family-office capability without family-office staff; (c) **lifecycle** — a question asked once can become a saved view, a scheduled snapshot, or a curated disclosure to a family member or advisor. Each alone is copyable; (b) is hardest to copy because it requires the Space/visibility architecture the product already paid for. The sharpest single differentiator: **cross-entity Perspectives that respect visibility tiers.**

**2. What is the biggest risk or downside?**
Two, one strategic and one technical. Strategic: the concept dissolving — Perspectives drifting into either a second navigation system (the current trajectory if `comingSoon` cards simply become more routed tabs) or a generic dashboard/query builder (the graveyard). Technical: the **aggregation-inference privacy failure** (§5) — a shared or cross-Space Perspective leaking hidden balances by arithmetic. The strategic risk kills differentiation; the technical one, in a product whose brand is trustworthy multi-entity finance, kills the product. Both are avoidable, and both are avoided by the same discipline: small typed lens library, scope as the only flexibility, sharing defined over disclosed scopes only.

**3. Should this ship in v2.5, v2.6, v3.0, or later?**
Staged — and v2.5's existing plan should not grow. **v2.5:** exactly what the polish investigation already scoped (G7 stretch: real Wealth and Cash Flow lens content if capacity allows, cut first), plus one cheap, high-leverage change: stop showing `comingSoon` cards for lenses with no near-term path (Tax, Property, Business Health) — placeholder fatigue actively damages the concept (§3.1). **v2.6:** the answer-led core lens set within a single Space — Net Worth attribution, Liquidity, Debt trajectory, Cash Flow (post-G12) — as deterministic assemblers that D4 can also consume. No persistence yet. **v3.0:** Perspective as a persisted entity (lens + scope + lifecycle), scope editing, saved/pinned Perspectives, AI-*proposed* Perspectives through D4, and the first cross-Space read built on PublishedAccountView. **Later:** Perspective sharing/disclosure (gated on the §5 inference design), scheduled snapshots/exports, Insurance/Business/Real Estate lenses as data feeds mature. Persistence deliberately trails D11/D3 seam closure (§3.2).

**4. If you could only keep one idea, which and why?**
**The redefinition: a Perspective is a saved, scoped, answerable question — and every Perspective leads with a deterministic, source-traceable verdict.** Everything else in this document is downstream of it: the lens library is how questions get answered, scope is what they're asked about, cross-entity is scope generalized, sharing is scope disclosed, AI is questions proposed and narrated, reports are answers frozen. If only the answer-posture half survives — no persistence, no cross-Space, just lenses that open with a verdict instead of a chart — the product is already meaningfully better than the card grid, and every later ambition still has its foundation. Ideas that require abandoning this one (dashboard builder, query DSL, AI-defined analyses) are the ones this investigation recommends against.

---

*Investigation ends here per brief. No implementation, schema, or UI work proposed for action; sequencing references are to existing frozen plans (Phase 2 freeze, V2.5 polish investigation) and introduce no new decisions.*

**External source consulted:** competitor multi-entity positioning — [Kubera](https://www.kubera.com/), [Kubera review (WallStreetZen, 2026)](https://www.wallstreetzen.com/blog/kubera-app-review/), [Kubera vs. Empower (FinanceBuzz)](https://financebuzz.com/kubera-vs-personal-capital).
