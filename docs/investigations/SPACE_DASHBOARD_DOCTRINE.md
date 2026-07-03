# Space Dashboard Doctrine — Visual Language Investigation

**Investigation:** `SPACE_DASHBOARD_VISUAL_LANGUAGE_INVESTIGATION`
**Status:** Investigation only — no code, schema, migrations, or UI changes. No implementation performed.
**Date:** 2026-07-03
**Baseline:** v2.4.x, `feature/v2.5-spaces-completion` lineage.
**Predecessors (settled, not re-argued here):**
- `SPACE_DASHBOARD_FUTURE_INVESTIGATION.md` — the three-question model (Am I okay / What changed / What needs me); stock→flow; skeleton-boring/content-alive.
- `SPACE_DASHBOARD_PHILOSOPHY_INVESTIGATION.md` — the ledger-faithful hero-trend unit; earned pixels; honest-trend law.

Those documents answered *what a Space should show and mean*. This one answers the layer beneath the complaint that started it — *why the product does not yet **feel** premium* — and converts the answer into **doctrine**: a small set of visual laws that should outlive every screen built on top of them.

**Evidence base:** `docs/design-system/Fourth-Meridian-Design-Language-v1.html` (Atlas Glass, Meridian Motion, the locked token set), `fourth-meridian-product-language.md` (voice), `lib/space-presets.ts` (the eight Space types and their edited templates), `components/dashboard/{SpaceDashboard,DashboardClient}.tsx`, `components/dashboard/widgets/*`, `components/charts/*`, `STATUS.md`.

**Method:** Five investigations were run in parallel from five vantage points (End User, Principal Engineer, Professional Wealth Manager, High-Net-Worth Individual, and a wildcard Information Designer). This document is their synthesis. Where they agreed, the agreement became a law. Where they conflicted, the conflict is recorded and adjudicated rather than averaged away.

---

## 0. The diagnosis behind the brief

The brief lists four symptoms: hierarchy feels inconsistent, whitespace feels uneven, some dashboards feel empty while others feel dense, some heroes deserve more attention and others should disappear. These are four descriptions of **one** defect, and it is worth naming precisely before prescribing, because the obvious fix is the wrong one.

> The product does not feel un-premium because it lacks polish. It feels un-premium because **the same visual weight is applied to facts of different importance.** A dense Space and an empty Space are the same bug seen from two sides: the layout allocates space by *what exists* rather than by *what matters*, so a Space rich in accounts overflows and a Space poor in accounts starves — both from the same missing decision.

This must be stated up front because the tempting remedy — more gradients, heavier glass, bigger shadows, a brass wash on everything — would make the product *look* more expensive and feel less premium, because it adds weight without adding hierarchy. **Premium is not a texture. Premium is legible priority.** Apple, Linear, and a private bank's quarterly statement share no palette, but they share this: at a glance you know what the surface wants you to look at first, and it is never everything. The Atlas Glass system already encodes this instinct — "at least 90% of any screen should be Atlas Ink; color is the exception, not the texture" — and the dashboard's felt cheapness is the gap between that written rule and the built surface.

So the doctrine is not a restyle. It is a **weighting discipline**: a fixed grammar of importance that every Space obeys, so that hierarchy stops being decided ad hoc per template and starts being a property of the system.

---

## 1. What every Space should feel like within five seconds

**One sentence, defended below:**

> Opening a Space should feel like a trusted steward turning to you and saying, in a calm voice, one true thing about this entity's money — and then waiting.

Four claims are load-bearing.

**"A steward" — the surface has a point of view.** The failure mode of every finance dashboard is the vending machine: it dispenses all the numbers and lets you sort them. A steward has already sorted them and leads with the one that matters. Within five seconds the user should have received a *judgment* (are things broadly fine or not), not an *inventory* to audit.

**"One true thing" — singular.** The five-second test is failed the instant the eye has to choose where to land. There is exactly one hero focus per Space, and everything else is quieter than it. This is the direct visual consequence of the voice guide's "Specific, not numerous."

**"Calm" — the resting state is stillness, not activity.** A premium financial surface at rest looks almost empty and completely composed. Motion is reserved for the one live thing (a number settling, an ambient sync pulse — Meridian Motion's 2400ms loop, and nothing else moving). Urgency is an interruption, never the ambient temperature.

**"And then waiting" — the surface does not beg.** No pulsing CTAs, no "complete your profile" nags competing with content, no red badges manufactured to drive engagement. The steward has said its piece; the next move is the user's. A calm product that is comfortable with silence reads as more expensive than one that fills every pixel to justify itself.

The recognition test for any Space screen: *cover everything but the top band. Can a stranger say what this Space is and whether it's okay?* If yes, the five-second job is done and the rest of the page is optional depth. If no, no amount of styling below will save it.

---

## 2. The hero and the viewport

### 2.1 Challenge the question first

The brief asks "how much of the viewport should belong to the hero?" as if the answer were a percentage. It is not — and treating it as one is part of how the product got uneven. A fixed hero fraction is exactly what produces "some heroes deserve more attention, others should disappear": the same 40% band is drawn whether the Space has a three-year net-worth story or one manually-updated car, so half the Spaces feel over-instrumented and half feel padded.

**The hero is not a fixed fraction of the viewport. It is a band whose *height is earned by the truth it can tell.*** The predecessor philosophy established the variance-aware rendering ladder (no snapshots → setup; one → real number + "history starts today"; flat series → headline + sparkline; real series → full chart). This doctrine gives that ladder its pixels.

### 2.2 The earned-height ladder (desktop, above the fold ≈ 900px)

| Hero tier | What backs it | Height it earns | Composition |
|---|---|---|---|
| **Full hero** | A real trend series with genuine variance | Top **~40%** of first viewport (~360px) | Fused unit: headline number (Data Large 32/36, tabular) + honest delta + one line chart |
| **Quiet hero** | A real number but a flat/short/step series | **~18%** (~160px) | Headline number + word-sized sparkline; no axes, no drama |
| **Setup hero** | Zero or one snapshot | **~18%** | The real number if it exists, or the single setup promise; "Your history starts today" |
| **No hero** | The Space's identity metric is genuinely un-chartable and un-trended (rare) | **0** | Lead with the state strip; do not draw an empty chart frame |

The rule that unifies them: **the hero's height is proportional to how much of a story it can honestly tell — never to the template's chart slot.** A drawn-but-empty chart frame is the single most un-premium object the product can render, and it is banned. This directly answers "some heroes should disappear": a hero that cannot fill its band with truth *shrinks to fit the truth it has* rather than stretching to fill the frame.

### 2.3 The whitespace verdict

"Whitespace feels uneven" is the same defect in negative space. The fix is not "add consistent margins" — it is: **whitespace is generated by the earned-height system, not applied on top of it.** When a hero shrinks to quiet-tier because its data is thin, the space it vacates is *not* backfilled with more widgets or larger padding; it becomes calm negative space that reads as intentional. Uneven whitespace today is the symptom of layouts trying to reach a target fullness. A steward with little to say leaves the page quiet. Enforce one rhythm — the 8pt spacing system, Comfortable mode — and let fullness vary honestly.

---

## 3. Do charts dominate or support?

**Neither, precisely — and the precision matters.** The chart *leads* the eye but *serves* the number.

The hero is a **fused unit**, not a chart with a caption: headline number + delta + trend, composed as one object. The number answers "where am I?"; the line answers "how did I get here?". Neither is subordinate in meaning, but visually the number is the protagonist and the chart is its evidence. A chart alone forces the user to read an axis to recover the number — labor a premium product should never impose. A number alone is the inventory problem the predecessors diagnosed.

Three laws follow:

1. **One line, never spaghetti.** The hero plots the single primary series. Assets, liabilities, cash become *toggles* that swap the series, never simultaneous overlays. (Atlas Glass already caps charts at six series and splits to small multiples beyond that; the hero's cap is *one*.)
2. **Charts never dominate below the fold.** Study-layer charts (allocation, category depth, payoff schedules) live inside Perspectives, opened deliberately. The Overview carries exactly one chart — the hero. A second chart on the Overview is a signal that a study lens has leaked into the state layer.
3. **The chart is honest before it is beautiful.** Where the End User wants a big dramatic line and the Information Designer wants an anchored, low-drama axis, the conflict resolves toward truth: identity charts anchor to zero or the starting balance where the metric allows, so a 1.2% month does not masquerade as a cliff. A Space whose story is "nothing much happened" should *look* calm, not instrumented into false volatility. That calm is the premium feeling, not a deficiency of it.

---

## 4. Should Allocation always live near the hero?

**No — and "always" is the tell.** Allocation is a *study* answer ("how is this composed?"), not a *state* answer ("am I okay?"). The state layer belongs above the fold; the study layer belongs behind a doorway. Pinning an allocation donut next to every hero is how the product manufactures the density it is now complaining about.

The single principled exception is **the Investment Space, where composition *is* the state.** For an investment portfolio, "how am I allocated" is not a deeper study question — it is the headline health question a wealth manager opens with. There, and only there, allocation earns a place adjacent to the hero. Everywhere else it is one tap deep in Perspectives.

Doctrine: **a lens lives near the hero only when that lens *is* the Space's identity question.** Allocation for Investment, payoff-arc for Debt, coverage-months for Emergency Fund — each Space promotes exactly one study lens to the state layer, the one that defines it, and demotes the rest. This is cheap to maintain (it is configuration over the existing preset system) and it is the mechanism that lets one skeleton produce eight distinct-feeling Spaces without eight layouts.

---

## 5. Where should Transactions live?

**Doorway plus change-preview. Never a standing ledger on the Overview.**

An always-visible transaction table is the purest form of the inventory anti-pattern: dozens of rows, mostly irrelevant on any given visit, paid for by the user's eyes every time. It is what made Mint and every bank portal feel dated within a year, and it is the opposite of a steward's judgment.

The doctrine splits the concept in two:

- **The change layer (on Overview):** not a transaction list — a *materiality-ranked* preview of what happened since this member last looked ("Since your last visit: 6 events, 1 worth a look"). This is flow, not inventory: it surfaces the few transactions that matter, ranked by materiality rather than recency, and stays silent (one calm line) when nothing material occurred. This is the daily reason to open a Space.
- **The full ledger (one tap deep):** the Transactions tab, the study surface, where the complete, filterable, tabular history lives — Compact density, tabular numerals, Bloomberg-legible.

No Space type shows the full transaction table on its Overview — not even Business. A business's Overview answers "do we have runway?"; the transaction ledger that supports that answer is a doorway away. The change preview is universal; the standing table is always behind a door.

---

## 6. Should "Briefing" exist inside Spaces?

**Yes — conditionally, quietly, and honestly. Not yet by default.**

The Briefing (AI, brass-marked, the one semantic allowed to borrow the brand accent) is the product's most premium-signaling element *when it has something specific to say* and its most trust-destroying element *when it doesn't*. The discipline is therefore about gating, not placement-for-its-own-sake.

- **Where:** a distinct band *below the attention layer and above the change preview* — never the hero. The hero is deterministic and interrogable; the Briefing is interpretive. Putting an interpretive artifact in the most prominent, most-trusted pixel is how one confidently-wrong sentence poisons the whole surface. It sits in a supporting position, brass-tinted (Thin glass, Brass tint variant), visually marked as "this is the product's read, not the ledger's fact."
- **When:** only when it has a *specific, defensible* thing to say, sourced from real data. The voice guide's law applies visually: "Explain, then suggest — never demand." A Briefing that would read "No new insights" should **not render at all** — its absence is calm; its presence-while-empty is filler, and filler is what cheapens a surface.
- **Under what conditions:** the D5 advice pipeline is a stub today (`run-ai-advice.ts`, per STATUS.md). Until it is real and validated, the Briefing band should either be absent or degrade to deterministic assessment-engine facts — never hold a prime slot for a stale or absent LLM artifact. The honesty law that governs charts governs the Briefing identically: **nothing renders that the data cannot defend.**

The Briefing is the one place the brass accent belongs on the dashboard. That scarcity is what makes it read as premium; a brass wash everywhere would spend the signal.

---

## 7. How should empty states feel?

**State the fact, invite exactly one action, educate almost never.** *Prepared, not barren* — an empty ledger book, not a broken screen.

The three registers a finance product confuses, disambiguated:

- **Empty is a state, not an error.** "Nothing needs your attention" and "No accounts linked yet" are *successes* of honesty, rendered calmly, with structure visible and one clear next step. Zero synthetic content, zero badged previews of imaginary data (the `FUTURE_TIMELINE_EVENTS` padding is scaffolding to remove, not a pattern to extend).
- **Broken is a bug.** "Something should be here" must look and read differently from "nothing yet." Copy must never let the two blur.
- **Educate sparingly.** Empty states should not deliver tutorials. They state what is true and offer one action. The *only* place a longer narrative belongs is the day-zero Space (no accounts at all), which gets a single setup surface — connect → first snapshot → set one goal — clearly labeled, and which disappears permanently the moment real data exists.

Empty-state doctrine in one line: **an empty Space should look like it is ready for its first entry, not like it failed to load one.**

---

## 8. How much scrolling should a Space require?

**The glance answer is zero-scroll. Study is opt-in scroll.**

- **Above the fold, always:** identity strip (which Space, data freshness) + hero (state) + attention (0–3) + change preview. Everything required to answer "what is this and is it okay" fits the first viewport. If it doesn't, the state layer is carrying too much.
- **Below the fold, optionally:** doorways to the study layer (Perspectives, the Space's one promoted lens, previews). A mature Space is **one to two viewport-heights** total on desktop — no more. A Space that requires three-plus screens of scrolling has confused study depth with state, and the fix is to move things behind doorways, not to shrink them.
- **Mobile is the glance client, categorically:** the three questions on one screen, no tab rail, no horizontal scroll of mostly-empty tabs. On a phone the hero *is* the number with a sparkline; the full chart is one tap deep. Scrolling on mobile reveals the change layer and nothing that pretends to be chrome.

Doctrine: **scrolling is a choice to study, never a tax to orient.** The orientation must be free.

---

## 9. Density by Space type

Density is not a per-widget decision and not a global slider users fiddle with. It is a **property of the Space type**, mapped onto the two modes the design system already ships (Comfortable / Compact). The goal is that a Debt Space and an Investment Space feel like *the same product telling different stories* — the way two chapters of one book share a typeface — not like two different apps.

| Space type | Identity question | Density | Promoted lens | Feel |
|---|---|---|---|---|
| **Personal** | "Am I okay?" | Comfortable | net-worth trend | Calm, spacious, one line, few tiles |
| **Household** | "What changed, and who did it?" | Comfortable | shared net position + actor-attributed change | Coordination surface; change-dominant, still calm |
| **Business** | "Do we have runway?" | Compact-leaning | cash position + net flow | More figures, tabular, but thin and honestly labeled until post-launch |
| **Investment** | "How am I allocated and how did it move?" | Compact | allocation + portfolio value | The one legitimately dense Space; tabular numerals, small multiples |
| **Property** | "What's it worth and what's the equity?" | Comfortable | value ↔ equity pairing | Single focal arc; refuse the equity chart until liabilities are linked |
| **Emergency Fund** | "How many months am I covered?" | Comfortable | coverage-months vs target | Sparse by design; one progress arc, lots of calm |
| **Goal** | "How close am I?" | Comfortable | progress toward target | Single progress element; the emptiest, most serene type |
| **Debt** | "How much closer to zero?" | Comfortable | payoff arc (framed as progress, not balance) | One inverted line; distance traveled, not balance owed |

Two commitments make this durable:

1. **Only Investment (and a matured Business) earn Compact.** Density is not visual sophistication — it is a response to genuine information rate. Forcing Compact density onto a Goal Space to make it look "serious" is exactly the mistake that makes the product feel inconsistent. A serene Goal Space *is* the premium expression, not a lesser one.
2. **The Debt inversion is the cheapest delight in the product.** The same `debt` series, plotted as distance traveled from the starting balance rather than balance remaining — identical data, inverted emotional valence. It is behaviorally literate finance, rare in software, and it is configuration, not new architecture.

---

## 10. Principles extracted from eight products

The brief is explicit: *do not copy them, extract principles.* Each product below is mined for the one durable idea worth internalizing and, where relevant, the trap worth refusing.

**Apple Health — the ring, not the readout.** Health's achievement is compressing a dozen metrics into one glanceable judgment (are the rings closed?) before offering any depth. *Principle:* lead with a single legible verdict; make depth reachable, never mandatory. *Refuse:* the gamification that turns stewardship into a streak — money is not a game to be won daily.

**Linear — opinionated defaults, ruthless restraint.** Linear feels premium because it decided what matters and removed everything else; there is almost no customization and the product is better for it. *Principle:* the product's hardest job is deciding what's important; outsourcing that to a user-arranged widget grid is an abdication. Curation over configuration.

**Arc Browser — identity through consistent spatial grammar.** Arc is recognizable in one frame because its structure (the sidebar, the spaces) is invariant even as content changes. *Principle:* recognizability comes from a stable skeleton, not from decoration. *Refuse:* Arc's over-animation and novelty-for-its-own-sake — the reason Arc dated quickly is the reason to keep Meridian Motion calm and physical.

**Kubera — the honest table.** Kubera's whole pitch is a clean, complete, trustworthy net-worth table across everything you own, with no editorializing. *Principle:* for the study layer, an unadorned, tabular, tabular-numeral'd table *is* the premium object; do not decorate what should be read. This is Fourth Meridian's Transactions/Accounts surface.

**Wealthfront — calm authority, no daily poking.** Wealthfront deliberately gives you little reason to check daily and presents projections with restraint. *Principle:* a wealth product's tone is "we've got this," not "look what happened today." The near-zero correct daily attention is a feature to design *for*, not against. *Refuse:* projection lines presented with false confidence — anchor and caveat.

**Copilot Money — the premium consumer bar.** Copilot is the current high-water mark for how expensive a personal-finance app can feel: tactile motion, restrained color, real typographic care, one clear thing per screen. *Principle:* premium consumer finance is achievable and the bar is set here — Meridian Motion (numbers roll, transform/opacity only) and the SF Pro/tabular type scale are how Fourth Meridian meets it. *Refuse:* Copilot's occasional cleverness-over-clarity in categorization surfaces.

**Notion — flexible substrate, invisible until summoned.** Notion's power is a block substrate that stays out of the way until you reach for it. *Principle:* the widget/section registry is the right architecture — a substrate — but the *composition* must be curated by template, not assembled by the user. Adopt Notion's substrate; refuse its blank-page tyranny, which is death for a finance product where the user does not know what belongs.

**Bloomberg Terminal — density as respect for the expert.** The Terminal is maximally dense and it is *correct* for its user, because information rate matches the professional's need and every figure is tabular and precise. *Principle:* density is legitimate exactly when information rate justifies it — the Investment Space and the study-layer tables — and never as a costume. *Refuse:* Bloomberg's density anywhere near the state layer or a consumer Space; the same density that respects a trader insults a Goal-saver.

**The synthesis of all eight:** the premium products lead with one judgment and hide depth (Health, Wealthfront, Copilot); the durable products fix their skeleton and vary only content (Arc, Linear, Notion); the trustworthy financial products present numbers without decoration (Kubera, Bloomberg). Fourth Meridian's opportunity is to be the only one that does *all three across a portfolio of entities* — a stable skeleton, a single earned judgment per Space, and un-decorated interrogable numbers underneath — which no incumbent combines because none has the Space primitive.

---

## 11. Perspective reviews

### 11.1 End User

The earned-height hero is the highest-delight, lowest-effort element available: a line moving the right way is understood pre-verbally, faster than any number. The five-second "steward" framing is what they actually want — to be told, not quizzed. Two cautions. First, the *daily* reason to open is the change layer, not the hero; a net-worth line moves slowly and on quiet weeks the hero is pleasant but static — set the expectation that the hero is the Space's *identity*, not its retention engine. Second, calm must not tip into *empty-feeling* for the sparse Space types (Goal, Emergency): the serenity is intentional, but a single confident progress element must anchor the page so "calm" never reads as "unfinished." The whitespace-from-earned-height rule is right *if* the promoted lens always fills the quiet.

### 11.2 Principal Engineer

Strongly in favor, because this doctrine is almost entirely *configuration over the existing substrate*, not new architecture. Conditions. (1) **One hero component, config-driven** — `SpaceTrendHero(seriesKey, framing, targetLine, tier)` fed by the existing `getRecentSnapshots`, mounted in both `DashboardClient` and `SpaceDashboard`; the earned-height ladder is a render decision inside it, not eight layouts. Build it once as the anchor around which the two-host convergence finally happens. (2) **The density-by-type and promoted-lens tables are preset data**, not forks — they belong in `lib/space-presets.ts` as fields, so a new Space type is a config row, not a component. (3) **The un-chartable tiers stay honestly gated**: Property equity and Business runway need liability linkage and a defensible burn definition respectively; the doctrine's "no drawn-but-empty frame" law must be enforced in the hero component itself, not left to each template to remember. (4) Watch the snapshot taxonomy liability flagged in the predecessor — do not stuff business/property/goal metrics into ad-hoc Float columns to satisfy this doctrine; those are a separate, approved schema evolution.

### 11.3 Professional Wealth Manager

The trend-first, one-judgment-per-Space philosophy matches exactly how professionals present: every client review opens with the portfolio line and one sentence. Hard requirements, all correctness not taste. (1) **Scope labeling on every hero** — a Household hero is "net worth of accounts shared with this Space," and it must *say so*; a partial view presented as a total is the classic aggregation malpractice and it destroys trust instantly. (2) **As-of discipline bound to the chart** — a line whose last point is nine days old must show that at the chart, not only in the header; the identity strip's freshness is a state-layer element, non-negotiable. (3) **Refuse the un-chartable heroes** — a runway number without a burn definition or an equity line without linked liabilities is *professionally embarrassing*; the tiering is table stakes, not conservatism. Enthusiastic endorsement of the Debt-as-progress inversion — that is precisely how advisors reframe payoff psychology, and seeing it as product default is rare.

### 11.4 High-Net-Worth Individual

Necessary but, alone, insufficient. Six entities means six Spaces, and the real daily question is "which of my Spaces moved?" — which this doctrine answers *structurally* by making every Space export the same headline + delta + attention-count contract, so the cross-Space rollup falls out nearly for free (the Spaces landing sparkline cards are its embryo). Two demands. First, **the promoted-lens/density system must scale to a portfolio view** — the same one-judgment discipline applied one level up; do not let the per-Space richness produce a cluttered rollup. Second, and sharper with charts than with numbers: **a trend can leak what a redacted balance hides.** A BALANCE_ONLY or SUMMARY_ONLY member seeing a Space-level line that steps when a hidden account updates is an inference channel; the hero must be computed against the *viewer's* visibility tier, and that must be pinned by a test before any shared-Space hero ships. Premium, for this segment, means *discretion* as much as polish.

### 11.5 Wildcard — Information Designer (Tufte school)

Chosen because the central proposal is a visualization mandate, and the strongest critique is the one that takes charts seriously enough to oppose bad ones. The endorsement is real but conditional on refusing *dead ink* — decoration wearing the costume of information. Four demands, all now embedded as doctrine. (1) **Default windows must match each metric's natural frequency** — net worth is a quarterly story, cash flow monthly, debt payoff the full arc since inception; a single "1M" default across all Spaces is wrong for most. (2) **Honest axes** — identity charts anchor to zero or the starting balance; a y-axis starting at the data minimum manufactures drama the data doesn't contain. (3) **The sparkline is not a degraded chart** — for a low-variance Space it is the *correct* graphic, word-sized, no axis to lie with; the earned-height ladder chooses the right graphic, it does not "downgrade." (4) **One line, not four.** Where this conflicts with the End User's appetite for a big beautiful chart everywhere, resolve toward truth: a Space where nothing is happening should look calm, and that calm *is* the premium signal. The premium-is-legible-priority thesis of §0 is, restated, the anti-chartjunk thesis: remove everything that does not carry meaning, and what remains reads as expensive.

---

## 12. Doctrine — the permanent visual laws

These are the decisions meant to survive the decade. They are phrased so any future screen, widget, or Space type can be checked against them with a yes or no.

1. **Priority is the product.** The surface allocates visual weight by importance, never by what exists. Density varies with information rate; whitespace varies with how much there is to say. Both are honest outputs, never targets.
2. **One judgment per Space.** Exactly one hero focus. Everything else is quieter than it. If the eye must choose where to land, the design has failed.
3. **The hero earns its height from the truth it can tell.** No fixed viewport fraction; no drawn-but-empty chart frame, ever. A hero with little to say shrinks; it never pads.
4. **Nothing renders that the data cannot defend.** Provenance, scope, and freshness on every number. This one law generates the honest-trend rule, the un-chartable-tier gate, the empty-state discipline, and the Briefing gate — they are all it, applied.
5. **The skeleton is boring so the content can be alive.** Fixed rail order, fixed composition slots, fixed 8pt rhythm. Users toggle modules; they never rearrange the skeleton. Recognizability lives in the invariants.
6. **Every number answers "why?" in one tap.** Tile → provenance (which accounts, as of when, computed how), reusing real logic, never a new computation. Interrogable numbers age well; blind-trust numbers age into churn.
7. **Color is the exception, not the texture.** ≥90% Atlas Ink. Meridian for interaction only, Emerald/Coral for real gain/loss only, Brass for AI/premium/mark only. The scarcity of the accent is what makes it read as premium.
8. **Calm is the resting state.** Motion is reserved for the one live thing. Urgency is an interruption the product earns the right to show, never the ambient temperature. The product is comfortable with silence.
9. **State above the fold; study behind a doorway.** Orientation is free (zero-scroll, one screen on mobile); depth is an opt-in choice. Transactions, allocation, and category depth are lenses, not gauges.
10. **One product, eight stories.** Every Space type is the same grammar with a different protagonist metric, promoted lens, and density — configuration over the same components, never a bespoke layout.

---

## 13. Conclusions

**1. What makes Fourth Meridian instantly recognizable?**
Not a color and not a chart — those are copyable in an afternoon. What is structurally un-copyable is **a portfolio of entities that each keep one faithful, interrogable story, told in one calm judgment, under one invariant skeleton.** Any incumbent can draw a net-worth line for one person. None can show you six stewarded Spaces — a household with a memory, a debt with a visible arc to zero, a business with a line you'd show a partner — each scope-labeled, provenance-backed, computed against your visibility tier, and composing upward into a portfolio of judgments. The recognizability is the *consistency of stewardship across contexts*, and it is unoccupied ground precisely because it requires the Space primitive no one else built.

**2. The biggest visual mistake to avoid.**
**Mistaking decoration for premium** — reaching for heavier glass, more gradient, a brass wash, a chart in every slot, to make the product look expensive, when every one of those additions spends hierarchy to buy texture and makes the product feel *cheaper*. The specific lethal form is **the hero chart that lies politely**: a drawn frame filled with a flat line, sparse-snapshot smoothing, or a confidently-wrong un-chartable metric (runway, equity) in the most prominent pixel — spending, in one glance, the trust the honesty work earned. Premium is subtraction. The mistake is always addition.

**3. What ships when.**
- **v2.5** — the earned-height `SpaceTrendHero` as a shared component across both hosts (Tier-1 Spaces: Personal, Household, Investment, Debt); the ≥90%-Ink / scarce-accent enforcement pass; the density-by-type and promoted-lens preset fields; empty-state disambiguation (empty vs broken). All composition of shipped parts; fits the v2.5 polish charter.
- **v2.6** — the change-layer preview (needs per-member read markers + real timeline producers); host convergence completed around the hero; the Debt-as-progress inversion; slimmed KPI strip; scope-labeling and visibility-tier hero computation with its pinning test.
- **v3.0** — the Briefing band (gated on a real D5 pipeline); the un-chartable tiers (Business runway, Property equity, Goal history) only once their data semantics arrive via approved schema evolution; the cross-Space portfolio rollup that the one-judgment contract makes nearly free.
- **Refuse:** a big-bang "visual redesign" release. This doctrine is a weighting discipline layered on an existing substrate; shipping it incrementally is lower-risk *and* higher-value than banking it for a v3.0 reveal.

**4. If only one visual principle survives forever.**
> **Priority is the product: the surface allocates weight by what matters, never by what exists.**
Every other law is a corollary. One judgment per Space, the earned-height hero, calm-as-resting-state, color-as-exception, state-above-study — each is this principle applied to a different axis (count, size, motion, hue, position). It is also the exact repair for all four symptoms in the brief: inconsistent hierarchy, uneven whitespace, empty-vs-dense, and heroes that deserve more or should disappear are four faces of one missing decision — *weight follows importance* — and installing that decision as doctrine is what turns a competent dashboard into a premium one that will still feel modern in ten years.

---

# Appendix A — Information-Type Importance: Ranking, Matrix, Variation, Maturity

*This appendix is the operational layer beneath the visual laws above. Sections 0–13 establish **how** the surface allocates weight (priority is the product; one judgment per Space; state above the fold, study behind a doorway). This appendix answers the adjacent brief precisely: it names the twelve information types, **ranks** them, assigns **Primary / Secondary / Tertiary / Hidden** for every template, and settles whether importance changes by **Space** and by **maturity**. It is the synthesis of five parallel investigations (A–E), grounded in the same corpus, and it re-uses — never re-litigates — Law 1 (priority is the product), Law 2 (one judgment per Space), Law 4 (nothing renders that the data cannot defend), Law 5 (the boring skeleton), Law 9 (state above study), and Law 10 (one product, eight stories).*

## A.0 The twelve information types

| # | Type | The one question it answers | Natural form |
|---|---|---|---|
| 1 | **Net Worth** | Where am I right now? | Number (large, single) |
| 2 | **Trend** | How did I get here / which way am I moving? | Chart (line + delta) |
| 3 | **Allocation** | What is my money made of? | Chart (donut / bar) |
| 4 | **Transactions** | What money moved, in detail? | List (rows) |
| 5 | **Goals** | Am I on pace for what I'm aiming at? | Card (progress bar) |
| 6 | **Debt** | How much do I owe, and am I gaining on it? | Number + progress-down chart |
| 7 | **Liquidity** | Can I cover what's coming? | Number (runway framing) |
| 8 | **Perspectives** | Where do I go to study this further? | Doorway (contextual link) |
| 9 | **Briefing** | What should I notice that I might miss? | Card / panel (prose) |
| 10 | **Timeline** | What changed since I last looked? | Feed (event rows) |
| 11 | **Members** | Who else is here, and who did what? | List (avatars / rows) |
| 12 | **Accounts** | What is this built from, and is it current? | List (account rows) |

Net Worth and Trend are treated throughout as **one fused hero unit** (Law 2, Law 3): the number says where, the line says how you got here. They rank separately only because the number is read first.

## A.1 Global baseline ranking

For a **generic, mature, single-user finance Space**, anchored to *Where am I → What changed → What needs attention* and to "specific, not numerous." On a typical open the attention set is empty, so the resting order resolves to **state → change → doorways**.

| Rank | Type | Rationale |
|---|---|---|
| 1 | **Net Worth** | The literal answer to "where am I" — the one number the voice guide asks each screen to lead with. |
| 2 | **Trend** | Inseparable from #1; read second only because the number is read first. |
| 3 | **Briefing** *(conditional)* | The "what needs attention" surface. High ceiling — a true attention item sits above the hero — but deflated now because the D5 advice pipeline is a stub; until real it degrades to deterministic content and holds no prime pixels. |
| 4 | **Timeline** | The "what changed" layer and the reason to return tomorrow. Proportional — shrinks to one calm line when nothing happened. |
| 5 | **Liquidity** | The most decision-relevant secondary number: "can I cover what's coming." |
| 6 | **Debt** | One supporting KPI in a generic Space; hero in a debt-purposed Space. |
| 7 | **Allocation** | Useful but interpretive; study material one tap deep (Law 9). |
| 8 | **Goals** | Important when present; a generic Space may carry zero or one. |
| 9 | **Perspectives** | Doorway-chrome — low as information; the row comes off the Overview, the tab stays. |
| 10 | **Transactions** | Deliberately low — the raw-inventory pattern the product is leaving; the material subset flows through Timeline. |
| 11 | **Accounts** | The provenance floor (Law 6) — reached in one tap, visible only through freshness signaling. |
| 12 | **Members** | Near-inert single-user; rises dramatically when shared. |

**Baseline tiers.** Primary = the hero (**Net Worth + Trend**). Secondary = the supporting strip and change preview (**Liquidity, Debt, Timeline**; *Briefing when real*). Tertiary = study lenses behind doorways (**Allocation, Goals, Perspectives, Transactions**). Hidden = on-demand, surfaced only when context demands (**Accounts, Members**).

## A.2 Per-template hierarchy — the master matrix

Rows = 12 info types. Columns = the eight operational templates (`lib/space-presets.ts`). **P** = defines the screen, **S** = signature below hero, **T** = a doorway/tap away, **H** = recorded in data but not surfaced by default.

| Info type | Personal | Household | Business | Investment | Debt Payoff | Savings/EF | Property | Goal |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Net Worth** | **P** | **P** | T | **P** | H | H | **P** | H |
| **Trend** | **P** | **P** | **P** | S | **P** | **P** | **P** | H |
| **Allocation** | S | T | T | **P** | H | H | H | H |
| **Transactions** | S | S | **S** | T | S | S | T | T |
| **Goals** | T | S | H | H | S | S | H | **P** |
| **Debt** | T | T | S | H | **P** | H | S | H |
| **Liquidity** | S | S | **P** | T | T | **P** | S | S |
| **Perspectives** | T | T | T | T | T | T | T | T |
| **Briefing** | H | H | H | H | H | H | H | H |
| **Timeline** | S | S | S | S | S | S | S | S |
| **Members** | H | **S** | T | H | H | H | T | H |
| **Accounts** | T | T | T | T | T | T | S | T |

**Each template's hero** (its "protagonist metric," Law 10): Personal / Household → Net Worth + Trend; Business → **Liquidity** (cash position, not net worth); Investment → the one **two-Primary** case, Net Worth + **Allocation**; Debt Payoff → **Debt** as a progress-down arc (Net Worth hidden — often negative, and surfacing it undercuts the motivating frame); Savings/EF → **Liquidity** as *months covered*, not the balance; Property → Net Worth as equity, with Accounts uniquely rising to Secondary (the value + mortgage cards *are* the signature); Goal → **Goals**, with **Trend hidden by design** (no history substrate — no line is fabricated, per Law 3–4).

**Patterns.** (1) There is no universal Primary — only Trend approaches it (6/8), yielding on Investment (guardrail) and Goal (no history). (2) Net Worth is **bimodal**, not universal — Primary where the Space is a balance sheet, Hidden/Tertiary where a more specific meaning owns the hero. (3) The four hardest-flipping types — **Debt, Members, Allocation, Liquidity** — span the full P→H range and are what actually differentiate templates. (4) Timeline (Secondary) and Perspectives (Tertiary) are structural constants. (5) Briefing is Hidden product-wide until D5 is real.

**Named product templates:** FinTracker (default) = Personal (solo) / Household (shared); Crypto inherits the Investment column. **TaxFlow** and **Heritage** fall outside the trend-hero model and are **not yet defined** against the twelve types — their likely heroes (deadline Timeline; a members/documents composition) are an explicit open gap.

## A.3 Should importance change by Space? — Yes, along three ranked axes

| Axis | Role | Governs |
|---|---|---|
| **(a) Template** | Editorial default | *Which story the Space claims to tell* |
| **(b) Type / purpose** (`SpaceType` PERSONAL↔SHARED; entity flag) | Reweights the default | *Which question dominates* |
| **(c) Composition / topology** (accounts, debts, members, flows present) | The truth gate | *Whether a slot is honest to fill* |

**Resolution order:** template *proposes* → type/purpose *reweights* → composition *gates and can override*. Stated as a rule: **template picks the story, type picks the question, composition decides what's true enough to show — and when they disagree, truth outranks question outranks story.** The clean proof is the debt-only "Personal" Space: template says net worth, purpose says "am I okay," composition says the only true story is Debt — and composition wins, promoting Debt to hero. Composition may override the hero, **but only downward-toward-truth and only on fact-tier signals** (a negative net worth is a fact); the demoted type stays one tap away. This is Law 4 governing which of the twelve types earns weight.

**Variation drivers** (deterministic predicates over topology): `>1 member` → promote Members, attributed Timeline, Perspectives; demote Net Worth, Allocation. Debt accounts present → promote Debt, Liquidity. Debt-dominant → Debt as hero. Business entity → promote Liquidity, Transactions, Timeline; demote Net Worth, Allocation, Goals. Single-goal → Goals as hero. All-liquid → promote Liquidity, Transactions; demote Allocation, Trend (flat → sparkline). Illiquid-dominant → Net Worth as equity + Debt. Material investment/crypto → promote Allocation, monthly-window Trend (no daily-delta badge on crypto). Day-zero/stale → Accounts-led setup surface. D5 live → Briefing slot returns.

**The Members question:** solo → Members demotes to a Settings doorway, Perspectives survives only as a study lens; shared/household → attribution *is* the product, Members becomes first-class and Timeline/Perspectives become member-attributed (the single highest-value per-type difference); business → Members means roles/authority, present but subordinate to Liquidity, and bound by graduated visibility (FULL / BALANCE_ONLY / SUMMARY_ONLY) — a redacted member is a node, never a transaction-level "who." Attribution honesty governs all three (never assert a "who" the data can't provenance) — a direct application of the visibility-tier hero computation demanded in §11.4.

**The guardrail (Law 5, Law 10):** variation is confined to *what fills the slots*, never to *the slots themselves*. Every Space uses one grammar — fixed nav order, fixed five-slot contract (Hero / Attention / Signature ≤3 / Change / Doorways). Types and composition reweight, promote, demote, gate, or relabel the twelve within those slots; they never invent a slot or reorder the skeleton. The three axes produce a *reweighted* dashboard, never a *different* one.

## A.4 Should the hierarchy evolve as a Space matures? — Yes, along data-availability

Hierarchy evolves along a **data-availability axis, not a novelty axis** — the honest consequence of Law 4. A fixed hierarchy would either render begging widgets in prime slots on a young Space or bury a mature Space's richest signal. **Only tier and presence evolve; the skeleton (Law 5) never moves.**

| Stage | Entry criteria | What changes |
|---|---|---|
| **0 — Empty** | Created; no accounts; no snapshots | A single narrative setup surface (connect → first snapshot → set one goal). Badged previews permitted *here only*. Everything else Hidden. |
| **1 — Seeded** | ≥1 account; 1–~30 days; <~2 snapshots | Day-one hero: real number + "Your history starts today." State layer (Net Worth, Accounts, Liquidity) Primary. No Trend line yet (a 2-point line lies). |
| **2 — Active** | Honest series (≈4+ weeks, past the noise floor); recurring Transactions | Trend graduates to full hero chart. Transactions become real. Timeline becomes meaningful ("since you last looked"). Attention layer active. |
| **3 — Mature** | Quarter+ history; ≥1 Goal set; validated advice live | Goals first-class. Briefing hero-adjacent (deterministic facts until validated). Perspectives meaningful. Multi-window Trend. |

**Evolution matrix** (tier per stage, for the types that move):

| Info type | 0 Empty | 1 Seeded | 2 Active | 3 Mature |
|---|:---:|:---:|:---:|:---:|
| **Trend** | H | T (placeholder) | **P** (hero) | **P** (multi-window) |
| **Transactions** | H | S (sparse) | **P/S** (recurring) | S (study lens) |
| **Timeline** | H (labeled previews) | T (calm, empty) | **P** ("since you last looked") | **P** (spine) |
| **Goals** | H | T (invite) | S | **P** |
| **Perspectives** | H | T (doorway) | S | **S/P** (depth) |
| **Briefing** | H | H | T (deterministic) | **S** (validated) / T until then |
| **Allocation** | H | T | S | S |
| **Debt** | H | S (balances) | S | **P** on Debt-type Spaces |

**Stable across all stages** (the skeleton): Net Worth (Primary always), Accounts (stable presence), Liquidity (Secondary, deterministic day one), Members (presence is a function of Space *type*, not age).

**Mechanics.** Evolution is **automatic (data-driven thresholds) with hysteresis**, because the triggers are facts, not preferences — a manual toggle would let a Space show a Trend hero over two points (the "chart that lies politely," §13.2). Instability is prevented structurally: the skeleton never moves (a graduating Trend fills a slot already reserved for it); transitions are one-way and monotonic with hysteresis; and **every graduation is announced as a calm one-time gain** ("Your history starts today") — a change the user was told about and welcomed does not feel unstable. This is Law 8 (calm is the resting state) applied to time.

## A.5 Recorded disagreements (adjudicated, not averaged)

- **Briefing vs Net Worth as centerpiece** → Net Worth + Trend is the resting centerpiece; Briefing is an interruption slot above it, present only with a defensible non-stubbed item. High global ceiling (#3), Hidden across templates today by the D5 stub.
- **Transactions vs Trend** → Trend wins the Overview decisively; Transactions is Primary on no template (Secondary at most), with only the material subset via Timeline.
- **Net Worth in a Debt Payoff Space** → Hidden as a headline (often negative), retained as data; the Debt arc is the story.
- **Does composition override the template hero?** → Yes, but only downward-toward-truth on fact-tier signals; the demoted type stays one tap away.
- **Is `SpaceType` a real axis or subsumed by composition?** → Keep it — a single-member Business is still a business ("do we have cash"), which composition alone would misclassify.
- **Allocation on Household** → Demote — a partial shared-account donut is the most misreadable chart in a shared context; purpose (coordination) beats a raw composition signal.
- **Automatic maturity evolution vs the two-host reality** → Cheap on one shared compositor, doubled across the two unconverged hosts; ready in substrate, should ride the convergence-first sequencing (§13.3).

## A.6 The four answers, stated plainly

1. **Rank:** Net Worth, Trend, Briefing *(conditional)*, Timeline, Liquidity, Debt, Allocation, Goals, Perspectives, Transactions, Accounts, Members — a baseline, reweighted by §A.3–A.4.
2. **Per-template P/S/T/H:** the master matrix (§A.2) — no universal Primary; Net Worth bimodal; Debt/Members/Allocation/Liquidity the differentiators; Briefing suppressed until D5.
3. **Change by Space?** Yes — template (story) → type (question) → composition (truth), truth outranking question outranking story, all within the fixed grammar so the product reweights without fracturing.
4. **Evolve with maturity?** Yes — along data availability through four stages; only tier and presence move, never the skeleton; automatic-with-hysteresis and announced as a calm gain.

---

*End of investigation. No implementation performed. Sections 0–13 are the synthesis of five parallel perspective investigations; Appendix A is the synthesis of five parallel information-importance investigations (taxonomy & ranking, per-template matrix, Space-type variation, maturity evolution, and attention/AI doctrine). Extrapolations beyond the source corpus are flagged inline; TaxFlow and Heritage remain undefined against the twelve-type model and are an explicit open gap. No schema, migration, route, or UI work is proposed or authorized.*
