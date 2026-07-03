# Space Dashboard Doctrine — Navigation, Hierarchy & Experience

**Investigation:** `SPACE_DASHBOARD_VISUAL_LANGUAGE_INVESTIGATION` (experience/interaction round)
**Status:** Investigation only — no code, schema, migrations, or UI changes. No implementation performed.
**Date:** 2026-07-03
**Baseline:** v2.4.x, `feature/v2.5-spaces-completion` lineage.

**Filename note.** The brief carries the investigation ID `SPACE_DASHBOARD_VISUAL_LANGUAGE_INVESTIGATION`. That banner has already produced two ratified doctrine artifacts — `SPACE_DASHBOARD_DOCTRINE.md` (visual *weight*: hierarchy, whitespace, premium feel) and `SPACE_DASHBOARD_COMPOSITION_DOCTRINE.md` (which *modules* exist, in what order). This round asks a different set of questions — navigation grammar, opening hierarchy, Perspectives-as-views, activity vs. milestones, a proposed Travel Space, and what a Space *is* — so it is written as the next companion under the same banner rather than overwriting either. The three are complementary: weight, composition, and now **experience**. Merge or rename on request.

**Predecessors (settled, not re-argued here):**
- `SPACE_DASHBOARD_FUTURE_INVESTIGATION.md` — the three-question model (Am I okay / What changed / What needs me); stock→flow; skeleton-boring/content-alive.
- `SPACE_DASHBOARD_PHILOSOPHY_INVESTIGATION.md` — the ledger-faithful hero-trend unit; earned pixels; the honest-trend law.
- `SPACE_TEMPLATE_REDESIGN_INVESTIGATION.md` — the five-slot contract (Hero → Attention → Signature ≤3 → Change → Doorways); one lede per Space.
- `SPACE_DASHBOARD_DOCTRINE.md` — priority-is-the-product; the earned-height hero; the ten visual laws.
- `SPACE_DASHBOARD_COMPOSITION_DOCTRINE.md` — per-template module verdicts; Perspectives-as-Doorway.
- `PERSPECTIVES_INVESTIGATION.md` — "a Perspective is a saved, scoped, answerable question"; the answer-posture.
- `PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md` — the deterministic, non-persistent lens engine (implemented 2026-07-03).
- `MERIDIAN_ANALYST_PRODUCT_INVESTIGATION.md` — Analyst explains; the deterministic-first boundary.

**Evidence base:** `lib/space-nav.ts` (`SPACE_TAB_ORDER`, rail gating), `components/dashboard/DashboardClient.tsx` (Personal host: single Overview pill + inline `PerspectiveSwitcher` + `MoreMenu`; `MORE_MENU_ITEMS`; render order), `components/dashboard/SpaceDashboard.tsx` (shared host: full fixed rail), `components/dashboard/widgets/MoreMenu.tsx`, `lib/perspectives.ts` (+ `PerspectiveSwitcher.tsx`, `COMPOSITION_SWITCHING_ENABLED` false), `lib/perspective-engine/*` (implemented lenses), `lib/space-presets.ts`, `lib/space-hero.ts`, `prisma/schema.prisma` (`SpaceCategory` incl. `TRIP`), `fourth-meridian-product-language.md`, `STATUS.md`.

**Constraint compliance:** every recommendation runs on deterministic data that exists today, or is explicitly flagged as gated on future infrastructure (event producers, host convergence, D5). Nothing here assumes AI capability the product does not already ship. This document challenges the brief's proposals rather than agreeing with them; where a proposal is rejected, the rejection is argued.

---

## 0. The one question under all seven

The brief lists seven topics that look unrelated — a dropdown, a hierarchy, a consistency question, Perspectives, an activity feed, a travel feature, and a metaphor. They are one question wearing seven costumes:

> **Is Fourth Meridian a surface you *watch and operate*, or a surface a steward *keeps and shows you*?**

Every topic resolves the moment that is answered, and the predecessor corpus has already answered it: the product is a **steward's ledger**, not a command center. Navigation should reduce, not multiply, the operator's controls. Hierarchy should lead with one judgment, not a wall of gauges. Consistency should be structural (a boring skeleton) so content can be alive. Perspectives should *answer questions*, not *rearrange a cockpit*. The change surface should show what *mattered*, not what *happened*. A Travel Space should be tested against whether it is stewardship of money or operation of a plan. And the framing question is the thesis itself, asked directly.

So the discipline of this document is to take each proposal and ask: **does it make the product more of a steward, or more of a command center?** The command-center answer is almost always the more exciting one, and almost always the wrong one — because a command center is what every finance app already is, and none of them still feel modern.

---

## 1. Personal navigation — retire the "More ▼" and unify the grammar

### 1.1 The evidence corrects the premise slightly

The brief says Personal uses "Overview / More ▼" while Shared Spaces use a horizontal tab bar. The code confirms the divergence and sharpens it. `lib/space-nav.ts` defines one canonical rail — `SPACE_TAB_ORDER = [OVERVIEW, PERSPECTIVES, TIMELINE, FINANCES, ACCOUNTS, TRANSACTIONS, MEMBERS, DOCUMENTS, SETTINGS]` — with a comment declaring it "intentionally fixed… so users can build muscle memory for 'Accounts is always third' across 50+ Spaces." Every non-personal Space (`SpaceDashboard.tsx`) renders that rail, gated by "rail earns tabs" (placeholders `FINANCES`, `DOCUMENTS` hidden).

Personal (`DashboardClient.tsx`) does **not**. A deliberate "Personal rail tab-cleanup pass" reduced its rail to a *single* Overview pill, moved Accounts/Transactions/Members into a `MoreMenu` (`MORE_MENU_ITEMS`), reached Perspectives via an inline `PerspectiveSwitcher` + an Overview "See all" link, and dropped Finances/Settings from the rail entirely. The code itself flags this as bespoke: *"This trim is Personal-only — lib/space-nav.ts's SPACE_TAB_ORDER is untouched, so every other Space category keeps its full rail."*

So the real situation is not "two tab styles." It is **one canonical rail and one hand-built exception**, and the exception is the product's single most-visited surface (Personal is every user's first Space). That is the worst possible place to keep a bespoke navigation grammar.

### 1.2 Should Personal adopt the exact same model? Yes — but unify *toward the rail*, not toward "More"

The brief asks whether Personal should "adopt the exact same navigation model as every other Space." The answer is **yes, unify** — this is a direct application of Law 5 (the skeleton is boring so the content can be alive) and Law 10 (one product, eight stories, *configuration over the same components, never a bespoke layout*). A per-host navigation fork is exactly the two-host liability (F6) leaking into the most important pixel of the product. But "unify" has a direction, and the direction matters more than the decision:

**Retire the "More ▼"; bring Personal onto the canonical rail-earns-tabs rail. Do not spread the "More" pattern to shared Spaces.**

The reasoning, against each axis the brief names:

- **Consistency.** One rail everywhere is the whole point of `space-nav.ts`. Today a user learns "Accounts is a rail tab" in their Household Space and then cannot find it in their Personal Space because it is buried in a menu. That is muscle-memory sabotage in the product's front door.
- **Discoverability.** A "More" menu is where features go to be forgotten. Everything the industry knows about overflow menus says items behind them get a fraction of the engagement of items on the rail. Accounts and Transactions are not "more" — they are core financial surfaces. Demoting them behind a dropdown on Personal (and nowhere else) is an accidental statement that they matter less for individuals than for households, which is false.
- **Scalability.** This is the decisive argument and it is about the *future*, not today. The brief itself names the two features that make a "More" bucket untenable: **Perspectives** and **Meridian Analyst**. Both need a *first-class, predictable, identical-across-Spaces* home — Perspectives because it is a candidate defining concept (per its own investigation), Analyst because "explain" is a top-level verb alongside "show" and "explore." You cannot grow a defining concept out of an overflow menu. A "More" dropdown is a confession that the rail ran out of room; the fix is rail-earns-tabs (hide what is not real yet), not hide-real-things-behind-a-menu.
- **Mobile.** Here the honest answer breaks *both* the rail and the "More" menu. Per the doctrine (§8, Future §2.3), **mobile is the glance client: the three questions on one screen, no tab rail at all.** A nine-tab horizontal rail is a horizontal-scroll of mostly-empty tabs on a phone; a "More" menu on a phone is a second tap for primary content. So the mobile decision is not "which nav model" — it is "no persistent nav model; the Overview *is* the mobile app, everything else is reachable but not chrome." Unification is a *desktop* question; on mobile both patterns lose.
- **Future Perspectives / Analyst.** Restated as the scalability point: these earn *rail slots* (Perspectives already holds slot #2), not menu items. Modeling them as first-class rail destinations, identical on Personal and Shared, is what lets them become defining rather than buried.

### 1.3 Self-disagreement, recorded

The "More" trim was not a mistake; it solved a real problem. Personal's Overview is a *rich composite* (KPI row + net-worth chart + allocation + transactions + timeline), so its designer reasonably concluded that Accounts/Transactions did not each deserve a competing pill above such a dense page. That instinct — *the Overview is the product; the rest is secondary* — is correct and worth preserving. The error is the *mechanism*: solving "the rest is secondary" with a bespoke Personal-only dropdown instead of with the rail-earns-tabs rule that already governs shared Spaces. The unification keeps the instinct (Overview-dominant, secondary tabs quiet) and discards the fork (a second navigation grammar). Concretely: Personal shows the same fixed rail, with the same placeholder-gating, and the same Overview dominance — the difference from today is that Accounts/Transactions/Members are quiet rail tabs (as they are on every other Space) rather than menu items, and Perspectives is the rail tab it already is elsewhere.

**Verdict:** One navigation language across every Space *does* make the product stronger — for consistency, discoverability, scalability, and the two named future surfaces. Retire the Personal "More ▼." Unify on the canonical rail-earns-tabs rail (desktop) and the no-rail glance Overview (mobile). This is a v2.5 change: it is deletion of a bespoke path, the cheapest and safest kind of unification.

---

## 2. Personal dashboard hierarchy — endorse chart-as-identity, reject two specifics

The brief proposes replacing "five KPI cards before the chart" with: **Greeting → Hero chart (Net Worth) → Allocation → Supporting KPI cards → Everything else.** The direction is right and already ratified in spirit; two of the specifics are wrong and worth correcting precisely, because getting them wrong reintroduces the very defects the doctrine exists to remove.

### 2.1 What is right: kill the inventory-first open

"Five KPI cards before the chart" is the inventory anti-pattern in its purest form — the user is handed a wall of numbers to sort before being told anything. The philosophy investigation diagnosed exactly this and the composition doctrine already rewrote Personal's reading order to `Attention → Net-worth hero (chart) → Allocation → Recent transactions → Timeline → Perspectives → Accounts`. So **yes: the chart-led hero should open the Space, and the raw KPI wall should not precede it.** The chart *does* become the identity of the product — that is Law 3 (the hero earns its height from the truth it can tell) and it is the single highest-delight, lowest-cognitive-load element available (a line moving the right way is understood pre-verbally).

### 2.2 Correction 1 — the KPIs do not "move lower," they get *absorbed and slimmed*

The brief frames the fix as reordering ("KPI cards move lower"). That is half right and half a trap. The philosophy is that the hero is a **fused unit — headline number + delta + trend — not a chart with a caption** (Law 3, Philosophy §1.2). So the *most important* KPI (net worth) does not move lower; it *becomes the headline of the hero itself*. The redundant tiles — Total Assets, Total Liabilities — do not move lower either; they become **series toggles on the hero chart** (they already open the same `NetWorthChartModal` with different series). What remains as a genuine "supporting KPI" strip is only the per-type vocabulary that is *not* already the hero and *not* a redundant decomposition — e.g. cash-flow MTD.

Why this matters: simply pushing five cards below the chart preserves the inventory, just relocated. The premium move is *subtraction* — the number the user came for is fused into the hero, the two decompositions become interrogation toggles, and the strip slims to one or two truly-supporting figures. "KPI cards move lower" would leave you with a chart and then still five cards; the doctrine leaves you with a fused hero and a slim strip. (End-user caution, §6.1: the Liabilities toggle must stay *visible*, not buried — some users orient by debt.)

### 2.3 Correction 2 — "Allocation always directly under the hero" is false as a universal

This is the specific to reject hardest, because the brief asks it as a leading question ("Should Allocation always remain directly under the hero? Should every charted Space share this philosophy?") and the honest answer is **no on both counts**, and the visual-language doctrine already settled it (§4): *"a lens lives near the hero only when that lens **is** the Space's identity question."*

- On **Personal**, allocation is a defensible Supporting #1 — an individual's "am I okay?" is served partly by "what is my money made of?" So under a *Personal* hero, allocation earning the next slot is fine.
- But **"always"** and **"every charted Space"** are exactly wrong. On **Household**, allocation is demoted (the story is flow and coordination; a partial-account donut is the most misreadable chart in a shared context — Composition §2.2). On **Debt**, the second element is the payoff breakdown, not allocation. On **Emergency Fund**, it is the target line, not allocation. Only on the **Investment** Space is allocation genuinely *state* rather than *study* — there composition *is* the health question a wealth manager opens with.

So the correct generalization is **not** "allocation under every hero." It is: **each Space promotes exactly one study lens to the slot under the hero — the one that defines that type** (allocation for Investment, payoff-arc for Debt, coverage-months for Emergency Fund, member-activity for Household, allocation for Personal). Pinning allocation under *every* hero is precisely how the product "manufactures the density it is now complaining about" (Doctrine §4). The brief's instinct — that *something meaningful* belongs directly under the hero — is right; the instinct that it should *always be allocation* is the density trap.

### 2.4 The greeting is a strip, not a tier

The brief lists "Greeting" as the top of the hierarchy. Keep it small. A greeting is a warmth element (identity + freshness — which Space, synced when), and it belongs at the very top as a *thin strip*, not as a hierarchy *tier* that competes with the hero for vertical weight. The stronger caution: a "greeting" must never become a re-animated `OverviewBriefPanel` — that panel was removed from `DashboardClient` precisely because its D5 advice pipeline is a stub, and a greeting that drifts into "here's what I think about your finances this morning" reintroduces an interpretive artifact in the most-trusted pixel (Doctrine §6). Greeting = "Good morning, Chris · Personal · synced 2m ago." One line. Not a paragraph, not a verdict, not an AI read.

### 2.5 Should *every charted Space* share this philosophy? Yes — the skeleton; no — the second slot

The unifying answer: **every charted Space shares the *grammar* (thin greeting/identity strip → attention-if-any → fused hero → one promoted lens → change → doorways), and differs in what fills the promoted-lens slot.** That is Law 10. "Should the chart become the identity of the product?" — yes. "Should KPI cards move lower?" — no; the headline fuses up, the decompositions become toggles, the remainder slims. "Should Allocation always remain directly under the hero?" — no; the *type's* defining lens does, which is allocation only for Personal and Investment.

---

## 3. Consistency across all Space templates — one skeleton, eight protagonists

The brief asks whether every Space should follow one universal structure (Hero → Health/Attention → Signature → Meaningful changes → Doorways) or whether each Space should intentionally feel different — and, sharply, *"How much consistency is too much?"*

### 3.1 The structure proposed *is* the ratified five-slot contract

The brief's proposed order is, almost verbatim, the template contract already ratified in `SPACE_TEMPLATE_REDESIGN_INVESTIGATION.md` §0.1 and re-ratified in the composition doctrine: **Hero → Attention → Signature (≤3) → Change → Doorways.** ("Health/Attention" is the Attention slot; "Meaningful changes" is the Change slot — see §5.) So this is not an open question; it is settled law, and the answer is **yes: one universal *structure*.** The reasons are the same ones that make the fixed rail law: muscle memory across 50+ Spaces, one composition component instead of eight layouts (maintainability), and a stable skeleton that lets content vary without the user re-learning the page (Law 5).

### 3.2 Where "intentionally different" is correct — and where it is the enemy

The tension the brief senses is real, and the resolution is a clean line: **the skeleton is identical; the protagonist is different.** Consistency governs *structure* — slot order, nav order, the 8pt rhythm, the disclosure pattern (number → provenance in one tap), empty-state grammar, the honest-trend law. Difference governs *content* — the hero metric, the one promoted lens, the density (Comfortable vs. Compact), and the KPI vocabulary. A Debt Space and an Investment Space should "feel like the same product telling different stories, the way two chapters of one book share a typeface" (Philosophy §2.4).

### 3.3 How much consistency is too much? When it forces equal *weight* on unequal *facts*

This is the question the visual-language doctrine was written to answer, so the answer is inherited and exact: **consistency becomes too much the moment it dictates that different Spaces look equally full or equally dense.** The four symptoms that started that investigation — inconsistent hierarchy, uneven whitespace, empty-vs-dense, heroes that deserve more or should disappear — are all one defect: *the same visual weight applied to facts of different importance.* So:

- **Consistent skeleton: always.** Same slots, same order, same nav, same rhythm.
- **Consistent density: never forced.** A serene Goal Space (one progress element, lots of calm) and a legitimately dense Investment Space (tabular, small multiples) are *both correct*. Forcing Compact onto the Goal Space to make it look "serious," or forcing a chart-hero onto a Space with no honest series to make it look "complete," is consistency as a costume — the exact mistake.

Stated as the boundary rule: **structure is universal; fullness is honest.** Consistency that unifies *how the product is read* is the goal; consistency that unifies *how full each page looks* is the disease. The five-slot contract delivers the first and, via the earned-height ladder, explicitly refuses the second.

---

## 4. Perspectives — bounded recomposition, not a reconfigurable cockpit

This is the most consequential proposal in the brief and the one most in tension with settled doctrine, so it gets the most scrutiny. The brief proposes that Perspectives stop being "selectable cards or modal destinations" and become **alternate views of the same Space**, where selecting a Perspective *literally reconfigures the dashboard* — hero changes, ordering changes, modules change, charts change, transactions filter, allocation changes.

### 4.1 What is true in the current implementation

`lib/perspectives.ts` today is a static library of ten lenses (four `available` = routing to a tab in a `GlassModal`, five `comingSoon`, plus `overview`). The `PerspectiveSwitcher` dropdown exists but **composition switching is disabled** (`COMPOSITION_SWITCHING_ENABLED` false) — selecting a Perspective never swaps the Overview body. Meanwhile the **Perspective Engine is implemented** (`lib/perspective-engine/`, 2026-07-03): deterministic, typed, non-persistent lenses (Liquidity, Debt) that compute a *verdict + metrics + provenance*, visibility-tier enforced. So the raw material for "a Perspective that reconfigures the page" is half-built: the *answers* exist; the *composition-switching wiring* is deliberately off.

### 4.2 The trap the brief walks toward, named

The `PERSPECTIVES_INVESTIGATION.md` evaluated eight candidate identities and **explicitly rejected "Dashboards"** as the identity for Perspectives: *"it collides directly with Overview… 'configurable dashboard builder' is also the most commoditized idea in this category… a product that should feel modern in ten years does not bet its defining concept on user-assembled widget grids."* The brief's "a Perspective reconfigures the whole dashboard" is one short step from "a Perspective *is* an alternate dashboard," which is the rejected identity. If Perspectives become "layouts you switch between," the concept reverts to the exact commodity the prior investigation ruled out, and it inherits the deepest UX hazard in the corpus: **if the layout reorganizes itself, the user can never build spatial memory** (Future §1.2; the reason the skeleton is law).

### 4.3 The synthesis: recompose the *fillings*, freeze the *skeleton*, lead with the *verdict*

There is a version of the brief's idea that is not just safe but genuinely strong, and it falls directly out of Law 5 + Law 10 + the answer-posture:

> **A Perspective may change what fills the five slots — the hero metric, the one promoted lens, which modules show, how transactions filter — but it may never move the slots, the rail, or the reading order; and it always leads with the deterministic verdict its engine computes.**

This threads the needle:

- **It is not a dashboard builder.** The recomposition is *system-authored and answer-led*, not user-arranged. Selecting "Liquidity" does not let you drag widgets; it swaps the hero to the liquidity verdict ("You can access ~$218k within 30 days") and fills the supporting slots with liquidity-relevant modules. This is the *same* mechanism that already differentiates Space *types* (a Debt Space vs. an Investment Space are the five slots filled differently) — now offered as user-selectable *lenses within one Space*. Architecturally it is one idea, not two.
- **It preserves spatial memory.** Because the skeleton, rail, and slot order never move, the page does not "rearrange." The hero is always where the hero is; only *what it says* changes. This is the difference between changing the channel and rebuilding the television.
- **It keeps the answer-posture.** Every Perspective still leads with a verdict sentence and traceable sources (the whole point of the Perspectives investigation and the reason the engine returns `verdict` + `provenance`). The recomposition *serves the answer* — it is the answer's supporting evidence, arranged — rather than being a generic re-layout.

Under those constraints, "Perspectives as alternate views" is an **upgrade over modals** on the brief's own axes:

- **Discoverability:** a persistent, legible switcher that visibly reconfigures the state layer is more discoverable than a card that opens a modal (a modal is a dead end you must back out of; a lens is a state you inhabit). The current five `comingSoon` cards actively *train disuse* (Perspectives §3.1); real, answer-led lenses reverse that.
- **Cognitive load:** *lower than modals if and only if the skeleton is frozen.* The load a modal imposes is context-switch-and-return; the load a full re-layout imposes is re-orientation. Freezing the skeleton removes the second while a switcher removes the first — so bounded recomposition can be lower-load than either. Free recomposition (the brief's literal "ordering changes") would be *higher* load and is the part to refuse.
- **Architectural fit:** excellent — it is composition-switching (already coded, currently off) fed by the Perspective Engine (already built). But note the tax: the **two-host split doubles the wiring** (Perspectives §3.2 — "each lens shipped before consolidation pays a 2× integration tax"). So enabling recomposition should follow, not precede, host convergence.
- **Relationship to Meridian Analyst:** clean and preserved — *Overview shows, Perspectives explore, Analyst explains* (Philosophy §2.2). Perspectives-as-views is the "explore" verb made spatial; Analyst sits above, narrating lens outputs, never computing them. Keeping Perspectives *deterministic* (engine-computed, not LLM) is what keeps the Overview trustworthy as AI grows around it.

### 4.4 What becomes the default Perspective? Overview — but not as a peer card

The brief asks whether the default should "simply be Overview." **Yes — but Overview is the *home composition*, not one selectable lens among equals.** The current code already trips on treating Overview as a peer: *"the overview lens can never be a card because clicking it would open the page you're standing on."* That is the tell. Model it correctly: **Overview is the Space's resting state — its identity question, always the composition you return to.** Perspectives are alternate lenses you *opt into* and then leave, snapping back to Overview. The switcher's default and resting position is Overview; the other lenses are departures, not equals. This also protects the behavioral goal: the resting state is calm and stable (the identity metric), and studying is a deliberate act, not the default posture.

### 4.5 Verdict and self-disagreement

**Verdict:** Adopt a *bounded* version of the brief's direction. A Perspective recomposes the slot *fillings* (hero, promoted lens, modules, transaction filter, allocation-in/out) within a *frozen* skeleton, and always leads with its deterministic verdict. Reject the literal proposal that "ordering changes" — moving the reading order or rail is the spatial-memory hazard the whole doctrine forbids. Reject any drift toward Perspectives-as-alternate-dashboards (the identity the Perspectives investigation ruled out). Default = Overview as the home composition, not a competing card. Sequence *after* host convergence (2× tax) and *after* the engine's lens set is broad enough that switching reveals real answers, not empty states.

**Self-disagreement, recorded.** The strongest counter to even the bounded version: maybe recomposition is *unnecessary*, and a Perspective's whole value is the *verdict card* (the answer sentence + a few metrics + provenance), reachable without rearranging the Overview at all. That is a legitimate, lower-risk position — it is essentially "keep Perspectives as focused answer surfaces, skip the composition-switching entirely." If the recomposition ever begins to feel like re-layout despite the frozen skeleton (user testing would show disorientation on switch), fall back to this: the answer-led card is the irreducible win, and composition-switching is the *enhancement* that must earn its complexity. The bounded recomposition is worth trying; it is not worth forcing if it reads as instability.

---

## 5. Activity vs. milestones — materiality over recency, but refuse the market-high

The brief challenges the role of Recent Activity: should raw activity remain a primary dashboard component, or should the dashboard emphasize *meaningful changes* (goal completed, mortgage paid, payroll received, debt milestone, investment milestone, new high, unusual event), with raw activity moved into Timeline?

### 5.1 The direction is settled: the Overview shows *what mattered*, the Timeline holds *what happened*

This is the "Change layer" from the Future investigation, already doctrine: the Overview's change surface is *"everything that happened since this member last looked, ranked by **materiality, not recency**"*; the Timeline is the full archive/spine. The composition doctrine's Change module is explicitly *"a materiality-ranked preview… not a transaction list."* So **yes:** the primary Overview surface should be meaningful changes, not a raw recency feed; the raw feed belongs in the Timeline tab. This is the single most important idea in the whole dashboard corpus — *"since you last looked"* is what converts the product from stock to flow and gives a calm reason to return (Future §5.4).

### 5.2 The correction: "milestones vs. activity" is a false binary — it is *materiality ranking*, and milestones are its top

The brief frames it as milestones *replacing* activity. The more durable model is already in the corpus: **one materiality-ranked change surface**, of which *milestones are simply the highest-materiality events*. A goal completed is a materiality-10 event; a routine coffee purchase is a materiality-0 event; the surface shows the top few and stays silent (one calm line) when nothing material occurred. This is better than a separate "milestones" concept because it degrades honestly — on a quiet week the surface says "nothing needed your attention," which is *"the calmest sentence a finance product can say"* (Future §1.3), rather than manufacturing a milestone to fill space.

### 5.3 The rejection: not every "meaningful change" the brief lists is safe to celebrate

The brief's list mixes two categories, and one of them is a behavioral hazard the doctrine explicitly guards against:

- **Keep — user-achievement and obligation events (fact-tier, behavior-driven):** goal completed, mortgage paid, debt milestone (a balance crossing a round number *downward*), an unusual/anomalous transaction that warrants a look, a missed or unusually-large payment. These reflect the user's own behavior or a real obligation, they are deterministic to detect, and surfacing them is stewardship.
- **Reject — "new high" (and any market-movement celebration):** a net-worth or portfolio "new all-time high" is driven by *market movement*, not the user's action, and celebrating it is the myopic-loss-aversion engine the Behavioral Economist review warns against (Future §3.5) and the Apple Health "refuse the streak" principle names (Doctrine §10). A "new high" badge trains the user to check for the next one — and it implies its inverse, a "new low," which is actively harmful. **Never badge or notify on market movement alone.** This is not a style preference; it is Law 8 (calm is the resting state; urgency is earned, never manufactured) and the product's stated bet that *trust compounds better than engagement*.
- **Handle with care — recurring events (e.g., "payroll received"):** recurring income is *routine*, not a milestone. Surfacing "payroll received" every two weeks is inventory, not signal. The material version is the *exception*: payroll *missed*, payroll *unusually large/small*, or the *first* time a new income source appears. Routine recurrence should flow into the Timeline, not the milestone surface.

### 5.4 The honest prerequisite

The change/milestone surface is not free: it requires **real event producers and a per-member read marker**, neither of which exists yet (Future §2.8, §3.2; the `ALLOWED_ACTIONS` allowlist has no producers for transaction/document/account/AI events, and the Timeline is currently padded with badged `FUTURE_TIMELINE_EVENTS` previews). Milestone detection additionally needs deterministic threshold logic. So this is **v2.6-class work**, gated on the scheduler substrate (D5) and timeline producers — *not* a v2.5 polish item, and absolutely not something to fake with the preview-padding anti-pattern (that scaffolding is to be removed, never extended).

**Verdict:** Replace raw recency-activity as the *primary* Overview surface with a single materiality-ranked change preview whose top tier is genuine, fact-driven milestones (goals, debt, obligations, anomalies); move the raw feed to the Timeline. Reject market-driven "new high" celebration outright. Route routine recurrence to the Timeline unless it is anomalous. Gate on real event producers + read markers (v2.6).

---

## 6. Travel Space — reject the planning product; keep the financial core

The brief describes a "Travel Space" bundling destination voting, moderation, lodging/rental proposals, itineraries, booking comparison, collaborative budgeting, savings milestones, planning deadlines, documents, passports, checklists, plus ambient intelligence (cost estimation, provider comparison, per-person contribution, private budget-conflict detection, savings suggestions, booking-window recommendations). It asks whether this is genuinely differentiated, whether voting is the right primitive, whether it should be a first-class template, and whether it belongs in Fourth Meridian at all. The critique is blunt because the concept, as bundled, is two products wearing one name.

### 6.1 The concept conflates a financial Space with a trip-planning app

Split the feature list by what it actually is:

- **Financial stewardship (on-brand, differentiated, mostly already modeled):** collaborative budgeting, savings milestones, per-person contribution, private budget-conflict detection, savings-adjustment suggestions. This is a *shared savings goal for a trip* — which already exists in the schema as the **`TRIP` category, a Goal-template variant** (`SPACE_TEMPLATE_REDESIGN` §1.8 / Composition §2.9: "TRIP = budget/savings pair"). Fourth Meridian is exactly the right home for this, and it is *already the design*.
- **Trip planning (off-brand, undifferentiated, crowded market):** destination proposals, voting, voting deadlines, admin moderation, lodging proposals, rental-car proposals, shared itineraries, booking comparison, passports, checklists. This is a *travel-planning and group-coordination product* — the space occupied by TripIt, Wanderlog, Troupe, and (for splitting) Splitwise. Fourth Meridian has *no structural advantage* here, and building it would import an entire social/coordination surface (proposals, voting, moderation, deadlines) that has nothing to do with money and everything to do with becoming a mini social platform — the precise direction the project instructions defer (messaging, full notifications) and the doctrine's calm-not-a-feed identity resists.

### 6.2 Is voting the right primitive? No

Voting is a *group-decision* primitive borrowed from social/planning apps, and adopting it drags in its entire retinue: proposals, anonymity, deadlines, moderation, admin authority, and the notification machinery to drive it. None of that is financial. It converts a calm stewardship surface into a low-retention polling app with a moderation burden. Worse, it is a **weak primitive even for its own job** — group travel decisions are messy, and a voting UI rarely resolves them (people negotiate in the group chat they already have). Fourth Meridian's genuine primitive is **money with a visibility model**; voting is not that, and bolting it on borrows a stranger's weakness. Reject voting as a first-class primitive.

### 6.3 What *is* genuinely differentiated — and it is exactly one thing

The one capability in the entire list that *only Fourth Meridian can do*, because it requires the graduated-visibility architecture the product already paid for, is **private, per-person affordability / budget-conflict detection**: "each member has committed to $1,500 for this trip; the system can privately tell each member whether their own committed share is realistic against their own means — without exposing anyone's balances to anyone else." That is the visibility-tier + aggregation-inference discipline (KD-15, `SUMMARY_ONLY`) applied to a warm, human problem, and *no travel app can build it* because none of them hold your accounts under a permission model. A shared `TRIP` Space could even link to members' Personal Spaces at `SUMMARY_ONLY` depth to answer "is everyone on track for their share?" without leaking a single balance. **This is the differentiated core, and it is financial, not logistical.**

### 6.4 The ambient-intelligence ideas, sorted by the honesty law

- **Keep (deterministic, on-brand):** estimate per-person contribution (arithmetic over a shared target), identify budget conflicts privately (visibility-tier math), suggest savings adjustments (deterministic pacing against a deadline).
- **Reject (violate the honesty law):** estimate trip cost by destination/dates, compare lodging providers, compare rental providers, recommend booking windows. Every one of these requires *external travel-pricing feeds Fourth Meridian does not have and should not build*, and each would produce a *confidently-wrong estimate on the front of a Space* — the "Tier ✗ chart" failure (a runway number without a burn definition) translated to travel. A trip-cost estimate without a defensible data source is exactly the politely-lying hero the doctrine bans. These are commodity travel-search features; the product has no advantage and real trust exposure.

### 6.5 Verdict and emergent ideas

**Verdict:** **Reject "Travel Space" as a first-class collaborative *planning* template.** It does not belong in Fourth Meridian; the planning superstructure is a different product (or, at most, a future *integration* with a travel app — not a native build). **Endorse enriching the existing `TRIP` Goal-variant** with collaborative savings, per-person contribution tracking, and private affordability/budget-conflict detection — the on-brand, differentiated, privacy-native slice, and the one thing here nobody else can ship. Voting, moderation, itineraries, booking/provider comparison, and passport/checklist vaults are rejected: undifferentiated, off-identity, and scope-creep into deferred territory.

**Ideas that naturally emerge (and are on-brand):** (1) a *shared savings goal that reads member readiness at `SUMMARY_ONLY` depth* — the affordability check generalized; (2) *contribution attribution* on the change layer ("Sam contributed $200 toward Italy") — coordination via the existing member-attributed activity, not a new voting surface; (3) a *goal-completion milestone* ("fully funded — you can book") flowing through the §5 milestone surface. All three reuse existing primitives (Goal template, visibility tiers, change layer) and add zero new social machinery. **What should be rejected** is anything that turns a money Space into a planning or polling app.

---

## 7. Dashboard philosophy — it is a steward's ledger, not a command center

The brief asks which framing best supports the product vision: dashboard, workspace, command center, control room, operating system, or something else.

### 7.1 The rejected framings, and why each is a specific trap

- **Dashboard** — *reject as the governing metaphor.* It comes from machines an operator watches continuously; personal finance is the opposite (correct daily attention ≈ zero). The metaphor optimizes for daily balance-staring, which the product's own voice guide and behavioral research both say is harmful (Future §1.1, §3.5). We may keep the *word* colloquially, but not the *mental model*.
- **Command center / control room** — *reject, and this is the most dangerous option.* Both imply real-time operation and active control — that you *do* a lot from here, continuously, under some urgency. That framing *justifies* exactly the features the doctrine spends its energy refusing: live gauges, alert badges, market-movement notifications, engagement feeds, "new high" celebration. A command center is an engagement-maximizing metaphor, and engagement-maximizing finance is the harm engine (myopic loss aversion, the ostrich effect). Choosing "command center" would be choosing to fight the product's own identity.
- **Operating system** — *reject at the per-Space level; it overpromises.* An OS is a substrate you build *on*, not a surface you read. At most, the *platform* (Spaces as the organizing layer for a financial life) has an OS-flavored ambition, but as a framing for what opening a Space *feels like*, "operating system" is grandiose and cold — the opposite of the calm, human read the product wants.
- **Workspace** — *reject; it is retired terminology and the wrong verb.* The product deliberately renamed Workspace → Space at v2.3.0. Reviving "workspace" as the framing collides with retired vocabulary and implies *active production* ("work"), when the product's stance is *stewardship* — mostly reading, occasional action, near-zero required attention.

### 7.2 The framing that best supports the vision: the steward's ledger

The predecessor corpus already found the right "something else," twice, from two angles: the Philosophy investigation's *"a ledger that has been kept faithfully in your absence"* and the visual-language doctrine's *"a trusted steward turning to you and saying, in a calm voice, one true thing about this entity's money — and then waiting."* Fuse them:

> **A Fourth Meridian Space is a faithfully-kept ledger with a point of view — a steward's record, not an operator's console.**

This framing best supports the vision on every axis the product cares about, and each rejected framing fails exactly where this one succeeds:

- **It matches the honest attention model.** A ledger is consulted, not monitored; a steward reports, it does not demand. This *designs for* near-zero correct daily attention instead of fighting it.
- **It centers the differentiator.** A ledger's whole value is *trust* — provenance, scope, freshness, faithfulness. The steward framing makes "every number interrogable in one tap" the product's core promise rather than a nice-to-have. Command center centers *control*; ledger centers *trust*, and trust is the moat.
- **It resists the feed.** A steward "says its piece, then waits" — the anti-pattern to the infinite feed. This is Law 8 (calm is the resting state) expressed as identity.
- **It scales to the actual differentiator — multi-entity.** *Every entity you steward keeps its own faithful ledger, kept the same way.* The framing is inherently plural: a household ledger, a business ledger, a debt's ledger, each stewarded identically and composing into a portfolio of stewarded entities. No incumbent has this because none has the Space primitive. "Command center" does not pluralize gracefully; "a portfolio of faithfully-kept ledgers" does.

The platform-level framing, distinct from the per-Space one, is therefore **a steward's book of ledgers** — closer in spirit to a family office than to an OS or a cockpit: one invariant, discreet, trustworthy record per entity, kept the same way across all of them.

**Verdict:** Reject dashboard-as-metaphor, command center, control room, operating system, and workspace. The framing is the **steward's ledger** (per Space) and the **steward's book of ledgers** (platform). This is the only framing that simultaneously honors the honest-attention reality, centers trust as the moat, resists engagement-bait, and scales to multi-entity stewardship — i.e., the only one that still looks modern in ten years.

---

## 8. Perspective reviews

Five vantage points, allowed to disagree, applied across the seven topics. Not averaged — conflicts are resolved explicitly in §9.

### 8.1 End User

Nav unification is a clear win: one place to find Accounts in every Space beats hunting a menu on Personal only. The chart-led open is the highest-delight change available — being *told* one true thing beats being handed five cards to sort. Two cautions. First, on **Perspectives-as-views**, the end user's benefit depends entirely on the frozen skeleton: if switching a Perspective makes the page *rearrange*, the delight curdles into "where did everything go?" — the switcher must feel like changing the topic, not rebuilding the room. Second, on **milestones**, celebration is delightful *until it isn't* — a "goal funded" moment is joy; a "new all-time high" badge is a slot-machine pull, and users will not consciously notice the difference while it quietly makes them check more and feel worse. The end user *wants* the market-high badge and should not get it; this is a case where the product protects the user from their own dopamine. On **Travel**, the voting/planning features *sound* fun and would demo well, but the end user's real unmet need is the awkward money conversation ("can everyone actually afford this?"), and the private affordability check is the only feature here that solves a problem the group chat can't.

### 8.2 Principal Engineer

Strongly in favor of the parts that are *deletion or configuration*, wary of the parts that are *new surface*. **Nav unification (§1)** is a pure win — it removes a bespoke Personal-only host path and folds Personal onto `space-nav.ts`, reducing the two-host divergence rather than deepening it; ship it in v2.5. **Hierarchy (§2)** is a shared `SpaceTrendHero` + preset fields (promoted-lens, density) — configuration, not architecture. **Consistency (§3)** is the five-slot contract already spec'd. **Perspectives-as-views (§4)** is where the engineer plants a flag: it is *technically* just enabling `COMPOSITION_SWITCHING_ENABLED` fed by the already-built Perspective Engine — but doing it before `DashboardClient`/`SpaceDashboard` convergence means **every lens pays the 2× integration tax** (Perspectives §3.2), and composition-switching wired twice across two divergent hosts is a maintenance trap. Hard sequencing: converge the hosts around the shared hero *first*, then enable bounded recomposition. **Milestones (§5)** are an event-sourcing commitment (producers + per-member read markers + threshold detection) — v2.6-class, not polish. **Travel (§6)**: the planning surface is a *huge* new build (proposals, voting, moderation, notifications) with its own data model and abuse surface; reject on cost alone, independent of strategy — the `TRIP` Goal-variant enrichment is a fraction of the work and reuses the visibility predicates that are already tested. **Framing (§7)** is philosophy, not code, but it correctly predicts which features to *never* build, which saves the most engineering of all.

### 8.3 Professional Wealth Manager / Financial Advisor

The steward-ledger framing is precisely how professionals present: a client review opens with one line and the portfolio arc, not a console of blinking figures — "command center" is how *no* competent advisor presents. On **hierarchy**, the correction that allocation is *not* universally the second slot is exactly right: allocation is the health question for a *portfolio*, not for a household or a debt payoff, and pinning it everywhere is amateur. On **Perspectives-as-views**, the bounded, answer-led version *is the review agenda* — net worth, liquidity, debt, allocation as standing lenses that each open with a verdict is how a plan review is structured; the demand is non-negotiable that each lens **shows its assumptions and sources** (a Liquidity verdict that says "$218k in 30 days" must caveat penalties/taxes as ranges, not promises). On **milestones**, the advisor is emphatic: **kill the market-high badge.** Celebrating a market-driven high teaches clients to conflate market movement with progress, which is the root misconception advisors spend careers correcting; surface *funded goals* and *debt paid down* (behavior), never *new highs* (noise). On **Travel**, this is out of scope for a fiduciary-grade tool — the one defensible piece is the private affordability check, which is genuinely a *planning-for-goals* competence advisors respect; the rest is not finance.

### 8.4 High-Net-Worth Individual

Judged from six entities, not one. **Nav unification** must hold not just across Space types but *up into the portfolio view* — the same rail grammar per Space is what makes six Spaces scannable; a Personal-only exception is exactly the kind of inconsistency that wastes this user's scarcest resource (attention across entities). **Perspectives-as-views** is necessary but the *real* prize is the one this round correctly defers: **cross-entity** Perspectives ("consolidated liquidity across personal, trust, and business") — per-Space recomposition is good software, cross-Space is the family-office capability nobody else has, and it depends on `PublishedAccountView` + visibility enforcement in every lens (later, gated). The sharpest note is on **Travel and privacy**: the private affordability check is the *only* proposal in the brief that speaks this user's native language — *disclose an answer without disclosing the balances behind it* — and it is a small, elegant instance of the aggregation-inference discipline that is make-or-break for this segment; a shared "can everyone afford their share?" that leaks a member's means by arithmetic would be a catastrophe, so it must be defined over `SUMMARY_ONLY` scopes only. On **framing**: for this user, "steward" means *discretion* — a ledger kept quietly, not a console broadcasting activity. Command center is the opposite of discretion.

### 8.5 Wildcard — Product Strategist

Chosen over the Information Designer and Behavioral Economist (who owned the prior rounds) because this brief's center of gravity is not visualization or attention — it is **scope and identity**. Four of the seven topics (Perspectives-as-cockpit, Travel-as-planning-app, command-center framing, and implicitly "add more") are the same strategic pressure: *the pull to become a broader, busier product than the one that is actually differentiated.* The strategist's single lens: **every proposal is scored by whether it deepens the moat or chases undifferentiated surface.** The moat is precisely three things nobody else has combined — **the Space primitive (multi-entity), the honesty discipline (interrogable, provenance-first numbers), and the visibility model (graduated, aggregation-safe sharing).** Score the brief against it: nav unification *deepens* the moat (consistency across entities is the multi-entity story); chart-as-identity + one-lede *deepens* it (honesty made visible); bounded answer-led Perspectives *deepens* it (interrogable lenses); the private affordability check *deepens* it (the visibility model applied to a human problem, the only Travel feature that scores). Everything the strategist flags for rejection — voting, moderation, itineraries, provider/booking AI, market-high badges, command-center framing, free recomposition — *chases surface*: features that are undifferentiated (every planning app has voting), off-identity (a feed is not a steward), or trust-eroding (a confidently-wrong estimate spends the one asset that is hard to rebuild). The strategist's warning conflicts productively with the End User's appetite for fun (§8.1) and with growth instincts generally: **the product's competitive position is a bet that a narrow, trustworthy, multi-entity steward beats a broad, busy, undifferentiated console — and that bet is only won by what the product refuses to build.** The strategist notes the cognitive-science point where it is decisive: freezing the skeleton under Perspective-switching is not just a UX nicety, it is what keeps the *interrogable* moat legible — spatial memory is part of trust.

---

## 9. Conflicts, resolved explicitly (not averaged)

- **End User (fun) vs. Strategist/Advisor (identity) on Travel voting.** Resolved toward identity: voting demos well and retains poorly, imports a social surface, and scores zero on the moat. Keep the one feature the End User *actually* needs and only FM can build — private affordability. Reject the planning app.
- **End User (wants the market-high badge) vs. Advisor/Behavioral (harm).** Resolved toward the user's long-term interest over their short-term dopamine: no market-movement celebration. Milestones are behavior/obligation events only. This is the product protecting the user, consistent with "trust compounds better than engagement."
- **Engineer (converge first) vs. the appeal of shipping Perspectives-as-views now.** Resolved toward the engineer: bounded recomposition follows host convergence, because wiring composition-switching twice across divergent hosts is a trap and the answer-led card is the irreducible win in the meantime.
- **HNW (cross-entity is the real prize) vs. this round's per-Space scope.** Resolved by sequencing, not compromise: per-Space bounded recomposition now (post-convergence); cross-entity Perspectives on `PublishedAccountView` later. The per-Space design is built so the cross-entity view composes from it.
- **Brief's literal "ordering changes" (Topic 4) vs. Law 5 (frozen skeleton).** Resolved toward the law: fillings recompose, the skeleton never moves. Spatial memory is non-negotiable; it is part of the trust moat, not just ergonomics.

---

## 10. Conclusions

**1. What would make opening a Fourth Meridian Space instantly recognizable compared to every other finance platform?**
Not a color, not a chart, not a nav pattern — those are copyable in an afternoon. What is structurally un-copyable is **the consistency of stewardship across a portfolio of entities**: every Space, whatever it holds, opens the same invariant way — a thin identity strip, then *one earned judgment* about that entity's money, computed against your visibility tier, provenance one tap beneath it, under a skeleton that never moves — and those single judgments compose upward into a book of stewarded ledgers no incumbent can assemble because none has the Space primitive. The recognizability is that Fourth Meridian *has a point of view and the same one everywhere*: it always leads with the one true thing and waits, whether you opened your household, your debt, or your business. Every other platform hands you a console; Fourth Meridian hands you a steward's report. That is the frame in the first second, and it is unoccupied ground.

**2. What visual or interaction mistake would permanently weaken the product if shipped?**
The lethal class is **turning the steward into a command center** — and it has three concrete forms, any one of which spends the trust the honesty work earned:
- *A surface that rearranges itself* — Perspectives (or anything) that moves the skeleton, rail, or reading order when state changes, destroying the spatial memory that makes numbers interrogable. Freeze the skeleton; recompose only the fillings.
- *Manufactured urgency* — market-movement celebration ("new high"), alert badges, engagement feeds. One "new all-time high" badge quietly converts a calm steward into a slot machine and teaches the user that market noise is progress.
- *The politely-lying hero* (inherited from the prior rounds) — a drawn-but-empty chart frame, a sparse-snapshot smoothing, or a confidently-wrong estimate (trip cost, runway, equity) in the most prominent pixel.
All three are *additions* that look like progress and subtract trust. The permanent mistake is mistaking a busier product for a better one. Premium is subtraction; the steward is defined by what it declines to say.

**3. Which ideas belong in v2.5 / v2.6 / v3.x / Never?**

- **v2.5** (composition of shipped parts / deletion): retire the Personal "More ▼" and unify onto the canonical rail-earns-tabs rail; fuse the net-worth headline into the hero and demote Total Assets/Total Liabilities to series-toggles; adopt the hero-led Personal reading order with allocation as the *Personal-only* promoted lens; slim the KPI strip; keep the greeting a thin identity strip; empty-vs-broken disambiguation.
- **v2.6** (needs infrastructure): complete `DashboardClient`/`SpaceDashboard` convergence around the shared hero; the materiality-ranked change/milestone preview (needs event producers + per-member read markers + deterministic milestone thresholds); enable **bounded, answer-led Perspective recomposition** (frozen skeleton, verdict-first, Overview as home) once hosts are converged.
- **v3.x**: cross-entity Perspectives on `PublishedAccountView` with visibility enforcement in every lens; enrich the `TRIP` Goal-variant with collaborative savings + per-person contribution + **private affordability/budget-conflict detection** (`SUMMARY_ONLY`-scoped); the Briefing band gated on a real D5 pipeline; the cross-Space portfolio "book of ledgers" rollup.
- **Never**: the Travel Space as a planning/coordination product; voting, moderation, itineraries, and passport/checklist vaults as native features; provider-comparison and booking-window ambient AI (no defensible data source); market-driven "new high" celebration badges; command-center / control-room engagement framing; a user-arranged dashboard builder; any Perspective that moves the skeleton, rail, or reading order.

**4. If you could keep only one product philosophy from this investigation for the next decade, what would it be and why?**

> **Fourth Meridian is a steward, not a command center: it keeps one invariant, faithful surface per entity and says one true thing — and its strength comes from what it refuses to become.**

Every recommendation in this document is that sentence applied to a different surface. *Retire the "More" and unify the rail* — a steward keeps one consistent book, not a bespoke exception for its favorite entity. *Lead with the fused hero, not a wall of KPIs* — a steward reports a judgment, a console dispenses gauges. *One skeleton, eight protagonists* — the record is kept the same way; only the subject differs. *Perspectives recompose the fillings, never the skeleton* — a steward changes the topic without rebuilding the room. *Milestones over activity, but never the market-high* — a steward reports what you did, not what the market did to you. *Reject the Travel planning app, keep the private affordability check* — a steward manages money under discretion, it does not run a poll. *The ledger framing over the command-center one* — because the whole thing is a bet that trust compounds longer than engagement.

It is also the one philosophy that answers the brief's own recurring worry — *will this still feel modern in ten years?* Every finance product that dated fast dated *because* it was a command center: a busy console of gauges and feeds optimizing for a daily check-in that finance does not reward. The steward's ledger is the only posture that ages well, because trust does not go out of style and discretion never looked cheap. Keep that, and every future feature — every new Space type, lens, intelligence surface, or collaboration idea — can be admitted or refused by asking one question: *does a faithful steward do this?*

---

*End of investigation. No implementation performed — no schema, migration, route, or UI changes proposed or authorized. This is the experience/interaction companion to `SPACE_DASHBOARD_DOCTRINE.md` (visual weight) and `SPACE_DASHBOARD_COMPOSITION_DOCTRINE.md` (module composition), under the `SPACE_DASHBOARD_VISUAL_LANGUAGE_INVESTIGATION` banner. Sequencing references are to existing frozen plans and introduce no new Phase 2 decisions.*
