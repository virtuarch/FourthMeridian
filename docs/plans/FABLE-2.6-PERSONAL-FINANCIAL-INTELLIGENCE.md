# FABLE-2.6 — The Personal Financial Intelligence System

*Product-architecture report. Builds directly on `FABLE-2.6-CONTEXT-ARCHITECTURE.md` (the frame thesis) and `V26-FOUNDATION-1-FINANCIAL-CONTEXT-FRAME.md` (the engineering plan). Where this report and V26-FOUNDATION-1 touch the same ground, this report adopts its modifications as binding: contract before schema (M1), narration outside the sealed frame (M2), semantic memory decomposed into its own lifecycles (M3), four clocks never collapsed (M4). This document is the layer above that plan: what the machine should be *for*, how it should decide what to say, and what it must refuse to become.*

---

## 1. The North-Star Experience

The product is not answers. The product is **a standing understanding** — the feeling, on opening Fourth Meridian, that something has been paying attention on your behalf: it knows what you own and owe, remembers what changed and why, has already decided what matters today, and can defend every word of that with evidence.

The benchmark interaction from the prompt is exactly right, and worth decomposing, because every clause of it is a system requirement:

> *"Overall, you're in a strong position* [**verdict first — the system commits to a judgment**]*. Your liquid reserves cover about 13 months of current spending* [**the correct safety measure, expenses-denominated, not a metric dump**]*, cash flow has remained positive for four consecutive months* [**longitudinal, not point-in-time — requires frame history**]*, and your debt burden is manageable* [**cross-domain: affordability, not balance**]*. The main item worth reviewing is the balance on your high-interest card — it is affordable relative to your assets, but expensive to carry* [**the one thing worth attention, with the tension stated honestly: affordable AND expensive are both true**]*. Would you rather look at your monthly spending or compare payoff options?"* [**the next question is chosen by the system, and it offers agency rather than prescribing**]

Three sentences of verdict, one item of attention, one invitation. Behind them: a sealed frame, an attention policy, a cross-domain rule set, and a conversation state. Nothing in that answer is generated freely — every claim is a rendering of something the platform decided deterministically and can show its work for. That is the north star: **conclusions, few and defensible; everything else one question away.**

## 2. The Advisor's Mental Model

The platform must maintain an explicit **epistemic ladder** — every piece of what it "knows" carries a status, and the statuses have different rights:

| Status | What it is | Who writes it | Rights |
|---|---|---|---|
| **Truth** | Canonical ledger fact ("$17 at X-cite on Jan 7") | Providers, imports, corrections | May be asserted flatly. Never forgotten silently (tombstones, not erasure) |
| **Derivation** | Deterministic judgment over truth (runway = 13.3 months) | The compiler | May be asserted with its confidence attached; recomputed, never remembered as fact |
| **Observation** | Detected pattern (spending shifted after March; salary arrives on the 25th) | Delta/pattern engines over frame history | May be *described* ("we noticed…") but not asserted as the user's reality until confirmed |
| **Testimony** | What the user explicitly stated ("rent is 800 KWD"; "I hate carrying debt") | The user, via confirmed capture | Asserted as the user's statement, effective-dated, always attributed ("you told us in March") |
| **Hypothesis** | An unconfirmed inference (spending shift + KWD merchants → "did you relocate?") | Pattern engines, LLM proposals | May only ever be phrased as a question. **A hypothesis that is never confirmed never influences advice.** |
| **Unknown** | An explicit gap with a known impact (no APR on one card → payoff advice degraded) | Gap ledger | Must be disclosed when it degrades a conclusion; is the fuel for context acquisition (§7) |

Two distinctions in the prompt deserve sharpening. *What is financially true* vs *what the platform understands*: truth is rows; understanding is the frame — versioned, dated, and revisable without rewriting truth. *What has changed* is not a seventh status but a first-class product object: the FrameDelta, which is the only legitimate source of "news." And *what remains uncertain* is not an apology appended to answers — it is structure (the confidence clock), which the attention policy consumes: **low confidence caps severity** (V26-FOUNDATION-1 §7 already encodes this: a low-confidence conclusion may never produce an urgent insight).

The cardinal rule of the ladder: **items may only move up it through explicit events** — a hypothesis becomes testimony through a confirmed answer; an observation becomes a pattern through repetition thresholds; nothing drifts upward by being repeated in prompts. The failure mode this prevents is the one that destroys trust in every "AI finance" product: the system confusing what it guessed with what it was told.

## 3. The Hierarchy of Attention

Attention is the scarcest resource in the product — the user grants roughly one headline, two or three supporting facts, and one question per session. The system therefore runs an explicit **attention auction** over the frame's candidate findings, deterministic and inspectable.

Every candidate finding is scored on five axes: **consequence** (money at stake per month, or risk magnitude — computed, not vibes), **actionability** (does a concrete user action change it?), **urgency** (does delay cost money or foreclose options?), **novelty** (has this already been surfaced? — read from the insight ledger, which is why persistence is prerequisite to taste), and **confidence** (the cap). Intent (§10) then applies an emphasis vector. The result maps to five placements:

- **Headline** — the single highest-scoring finding, *stated as a verdict*.
- **Supporting context** — findings that explain or qualify the headline. Never more than three.
- **Optional exploration** — offered as the closing question ("payoff options or spending?"), not narrated.
- **Mention-when-asked** — true, computed, sitting in the frame, surfaced only under the intent where it is decision-relevant.
- **Suppressed-as-misleading** — true facts withheld *with a recorded reason*, because stating them in this context would cause a wrong belief.

The last category is the one that separates an advisor from a dashboard, so it deserves its own doctrine: **a fact is worth surfacing only when a reasonable person, hearing it in this context, would update toward a more correct decision.** Case 1 is the canonical example: "liquid assets are 2% of net worth" is true, and in a *safety* conversation it implies fragility — which is false; the user has 13 months of runway. The ratio is not deleted; it is *routed*: suppressed under the safety intent (recorded reason: `WRONG_DENOMINATOR_FOR_INTENT` — safety is expenses-denominated, composition is portfolio-denominated) and surfaced under the portfolio intent, where the same number legitimately raises accessibility and rebalancing questions. Suppression reasons are inspectable in the "why am I seeing this?" surface (§9) — the system may bite its tongue, but never secretly.

The novelty axis carries the second half of taste: **repetition decay**. An unacknowledged insight decays in placement (headline → supporting → mention-when-asked) rather than repeating at full volume; an insight the user dismissed is silenced with a recorded dismissal unless its severity class *changes*. The advisor that says the same thing every morning is a nag; the ledger is what lets the system know it already spoke.

## 4. Cross-Domain Reasoning

The reasoning layer is a deterministic **assessment graph**: normalized domain measures as nodes, explicit interaction rules as edges, all computed at frame-compile time. The LLM narrates its output; it never runs it. The normalized measures matter more than any individual rule — each converts a raw quantity into the *decision-relevant* denomination:

| Measure | Definition | Why this denomination |
|---|---|---|
| Runway | liquid ÷ monthly expenses (coverage months) | Safety is time, not percentage. **This resolves V26-FOUNDATION-1's D1: coverage-months is canonical.** Percent-of-net-worth is dimensionally wrong for safety (Case 1 proves it) and lives on as a *portfolio* measure only |
| Carry cost | Σ(balance × APR) ÷ 12, per debt and total | Debt hurts as a monthly flow, not a balance |
| Carry spread | APR − expected risk-adjusted return proxy | Whether carrying debt is economically rational (Case 2) |
| Debt affordability | carry cost ÷ monthly income | Whether debt threatens, independent of whether it wastes |
| Income durability | stability class from inflow history + testimony (contract type, single vs multiple sources) | Runway means little if income is fragile; 13 months with volatile income ≠ 13 months on salary |
| Accessibility | liquid vs encumbered vs illiquid asset tiers, with time-to-cash | "Net worth" answers solvency; accessibility answers emergencies |
| Concentration | largest position/asset-class share | Portfolio intent's headline measure |
| Obligation load | known future obligations (testimony + recurring detection) vs runway window | Converts "13 months" into "13 months *minus the tuition you told us about*" |

The prompt's cases, run through the graph:

**Case 1** (2M net worth, 40k liquid, 3k expenses, no debt): runway 13.3 → SAFE; carry cost 0; headline is positive. Liquid-to-NW 2% fires only the *composition* node → mention-when-asked under portfolio intent. The system's answer leads with strength, not with the scariest-sounding ratio.

**Case 2** (same, +100k at 4%, strong cash flow): carry cost ≈ $333/mo; affordability high; **carry spread ≈ negative** (4% is likely below portfolio return expectations). The rule fires: *rational leverage — do not recommend payoff by default*. The system may note the optionality question (fixed vs callable, rate environment) but the verdict is "affordable and cheap; no action required." A payoff recommendation here would be moralizing, not advising — unless testimony says the user is debt-averse, in which case preference legitimately reorders the options (preference changes *ranking*, never the *economics*, which are stated either way).

**Case 3** (1M net worth, 40k liquid, 100k revolving at 22%, positive cash flow): carry cost ≈ $1,833/mo — destructive; but full payoff from cash would take runway to zero → the **runway floor constraint** binds (never recommend an action that takes runway below the floor — default 3 months, adjustable by testimony). The graph's output is not one answer but a *ranked option set with stated trade-offs*: staged paydown from cash flow keeping runway ≥ floor; asset-aware restructuring (borrow against or liquidate the lowest-cost, least-tax-encumbered asset tier to retire 22% debt — flagged as involving decisions the platform cannot make for the user); balance-transfer awareness if data supports it. The honest headline: "your debt is affordable but expensive — about $1,800/month in interest — and there are three reasonable ways to attack it." **Advice preserves optionality** (principle §15): where no dominant strategy exists, the product's job is to make the trade-off legible, not to fake certainty.

**Case 4** (same user, "is my portfolio healthy?"): the frame does not recompile — the *emphasis vector* changes (§10). Concentration, accessibility, and the 2% liquid allocation move from mention-when-asked to supporting/headline; runway drops to background. Same understanding, different lens — this is the structural guarantee that intent changes emphasis, never facts.

**Case 5** (Riyadh → Kuwait): a LifeEvent (§8) with an effective date. Baselines fork: spending comparisons across the boundary are annotated, not silently computed ("dining is up 40% — note: this compares your Kuwait period against Riyadh; cost environments differ"); currency context switches prospectively; recurring-pattern detection restarts its confidence clocks; the *pre-move history is never rewritten* — it is contextualized. The platform holds effective-dated context, not one timeless profile.

## 5. The Personal-Context Taxonomy

Following M3, personal context is not one blob but four ledgers with different lifecycles:

**StatedFacts** (testimony): effective-dated, provenance-stamped (which conversation, which sentence), editable, deletable, with a verification state and a scope (financial constraint, preference, obligation, household composition). **ObservedPatterns**: detected regularities (salary cadence, recurring merchants, seasonal shapes) with confidence accrued over repetitions and decay on contradiction — machine-owned but user-visible. **LifeEvents** (§8): effective-dated markers that re-baseline interpretation. **Insights**: the platform's own outputs with lifecycle (detected → surfaced → acknowledged/dismissed/accepted → resolved/expired) — the system's memory of what it already said, which powers novelty decay and "decision history" (§14).

What deliberately does *not* exist: a free-text "notes about the user" blob (unauditable, unforgettable, the profiling slippery-slope), and inferred demographic attributes of any kind (§12).

## 6. The Progressive-Personalization Ladder

The ladder's law: **each rung adds relevance; no rung unlocks correctness.** A user who shares nothing beyond linked accounts gets a complete, honest advisor — because runway, cash-flow trend, carry cost, affordability, and concentration are all derivable from ledger truth alone. That is the v2.5 inheritance and it is the baseline product, not a teaser.

- **L0 — linked finances only:** full assessment graph, generic expense baseline, confidence honestly capped where testimony would help (income durability = "observed only").
- **L1 — basic profile** (household size, employment shape, home currency): denominators sharpen; income durability gains a class; nothing else changes.
- **L2 — goals & obligations:** the alignment sections activate; runway becomes obligation-adjusted; "should I invest more?" gains a real answer shape.
- **L3 — life context** (events, constraints, preferences): advice ranking personalizes (debt-aversion, religious financing constraints, family support obligations — all stored as *constraints*, §12); questions get smarter and rarer.
- **L4 — longitudinal history** (earned, not asked): seasonal baselines, drift detection, decision outcomes, the memoir (§14). This rung cannot be bought or imported — it accrues, which is why it is the moat.

The dangerous anti-pattern is the inversion: making L0 feel broken to coerce disclosure. Every "add context" prompt must name its concrete benefit and be declinable forever (§7).

## 7. Context Acquisition

The system already has the right primitive: the knowledge-gap machinery (gap → impact statement) that debt advice uses today. v2.6 generalizes it into a **question budget with a gap ledger**, replacing any notion of an intake form.

The rules: questions are **triggered by materiality, not curiosity** — a question may be asked only when its answer would change a live conclusion by more than a threshold, and the ask must state that benefit in the same breath ("Do you expect any large expenses in the next six months? — it changes how much of your cash I'd consider truly free"). **One question per surface per day**; chat may ask at natural moments, the Brief carries at most one, notifications never ask. Every answer is **confirmed before it becomes testimony** ("Got it — I'll treat 800 KWD/month as rent from March onward. Correct?") and its effect is **shown immediately** ("runway recalculated: 11.2 months") — the payoff loop that makes answering feel like investing rather than being surveyed. Every question, answer, deferral, and refusal is recorded in the gap ledger: **a refused question is never re-asked** unless its materiality class changes, and the refusal itself is a respected, visible entry ("You preferred not to share income details — 2 insights run at reduced confidence"). Observations trigger *hypothesis questions* under the same budget ("Your spending pattern changed after March — did something in your living situation change?"), and an unanswered hypothesis simply remains a hypothesis: annotated internally, never asserted.

## 8. Life-Event Intelligence

A **LifeEvent** is: type (relocation, marriage, child, job change, income change, home purchase, business start, retirement, caregiving, education), effective date, provenance (stated | confirmed-from-hypothesis), affected assumptions (currency context, expense baseline, obligation set, income durability, comparison windows), and optional notes. Its semantics follow the platform's existing append-only instincts: **events apply prospectively; the past is preserved and annotated, never rewritten.** Detection is conservative: changepoint signals (spending level shifts, currency mix shifts, income cadence breaks, geographic merchant drift) generate *hypotheses* that spend a question-budget slot; only confirmation mints the event. Every longitudinal comparison that crosses an event boundary carries the boundary in its rendering — the Case 5 requirement — and seasonal/drift models restart their confidence accrual at the boundary rather than blending incompatible regimes. Retroactive dating is allowed ("actually I moved in January") and triggers re-annotation of the affected window — annotation, not recomputation of truth.

## 9. The Personal-Context Ledger ("What does Fourth Meridian know about me?")

A single user-facing surface listing every item of the §5 taxonomy, each with: the claim; its epistemic status in plain language (*you told us · we observed · we assumed · we asked and you declined*); where it came from (linked to the source conversation or the pattern evidence); its effective dates; **which insights it currently affects** ("used by: runway, payoff plan") — resolvable because insights carry evidence pointers to stated-fact IDs; and edit/expire/delete controls. Deletion semantics are honest: the item stops influencing all future frames immediately, a tombstone records *that something was deleted* (not what), and past sealed frames are not rewritten — the same doctrine as financial tombstones. The ledger is also where suppression reasons and dismissals live, making "why am I seeing this?" and "why did you stop telling me this?" both answerable. This surface is the trust product: the difference between an advisor with a memory and a company with a file on you is that you can read the memory.

## 10. Intent-Aware Interaction

Intent is a *lens selection*, implemented as an emphasis vector over the frame's sections — mechanically, this is the context-priority planner's existing importance × affinity machinery, promoted from shadow to the presentation layer. The taxonomy and each intent's headline measure:

| Intent | Headline measure | Rises | Falls/suppressed |
|---|---|---|---|
| Overall health | composite verdict | top priority item | everything else |
| Safety/resilience | runway (coverage months) + income durability | obligation load, accessibility | liquid-to-NW ratio (suppressed: wrong denominator) |
| Spending | trend vs baseline, category movers | recurring/subscriptions | portfolio |
| Debt | carry cost + affordability + spread | payoff options, runway floor | concentration |
| Portfolio | concentration, allocation, accessibility | liquid-to-NW (legitimately!) | day-to-day spending |
| Investing readiness | runway floor test + debt spread test | obligation window | — |
| Goals | funding trajectory vs stated goals | trade-offs against other intents | — |
| Major purchase | post-purchase runway simulation | accessibility, obligation load | — |
| Relocation | dual-currency context, baseline reset plan | cost-environment deltas | pre-move comparisons unannotated |
| Retirement | duration-denominated runway (years), income replacement | accessibility ladder | short-term spending noise |
| "What changed?" | FrameDelta, materiality-filtered | confidence changes | anything already known |
| "What should I do?" | insight inbox, ranked by the attention auction | one action per item | analysis without action |

The invariant, worth stating as product law: **all intents read the same sealed frame.** The safety answer and the portfolio answer about the same 40k of liquid assets differ in emphasis and are *both derivable from one object* — which is what makes cross-intent contradiction structurally impossible rather than editorially avoided.

## 11. Benchmarks and Peer Context

Percentile claims are the highest-risk feature in this document: they create false confidence ("top 20% for runway" among *whom*, measured *how*?), and at beta scale internal cohorts are simultaneously statistically meaningless and privacy-hostile (a cohort of 30 users is both). Policy, in phases: **v2.6 — no peer percentiles at all.** Comparisons are *guidance-relative*, which is honest and already useful: "13 months of runway is well above the 3–6 months commonly recommended." **Later — broad directional bands** from public datasets where genuinely relevant cohorts exist (household size, income band, cost environment — *never* age alone), phrased as ranges with sources, not ranks. **Only at scale — internal cohort statistics**, and only when every published statistic clears a k-anonymity floor (cohort n ≥ 500, suppression of small cells), opt-in for contribution, and framed as descriptive ("households like yours typically hold…") never normative ("you should"). The test any comparison must pass: *would this sentence change a decision correctly, or just make the user feel ranked?* Ranking feelings are engagement candy with a false-confidence cost; Fourth Meridian's brand is that it does not serve candy.

## 12. Sensitive Traits

Default, absolute: **race, ethnicity, religion, gender, disability, sexual orientation, and political identity are not collected, not inferred, and not used.** The subtle risk is not collection but *inference*: transaction data is a demographic X-ray (pharmacies, places of worship, remittance corridors). Hence a standing non-inference commitment, enforced structurally: the classifier taxonomy contains no protected-class features; pattern detectors operate on financial semantics (amounts, cadences, categories) and are guard-tested against emitting demographic labels; and no model input includes merchant-derived proxies for protected classes.

Where a sensitive circumstance has a genuine, user-directed financial consequence, the rule is: **model the constraint, never the class.** A user who wants Sharia-compliant, interest-free financing gets a stated *constraint* ("exclude interest-bearing recommendations") — not a religion field. A user with recurring medical costs gets an *obligation* ("fixed monthly medical obligation, 320 KWD") — not a disability flag. The constraint achieves the entire personalization benefit, is inspectable and deletable in the ledger like any testimony, and carries no demographic assertion. Personalization asks "what should I do differently for you, because you told me?"; profiling asks "what are you?" — the first is the product, the second is banned.

## 13. The Role of the LLM

The proposed philosophy — *platform owns memory, evidence, assessment, priorities, confidence, policy; LLM owns language, conversation, interpretation, exploration* — is correct in shape and needs three refinements rather than revision.

First, **interpretation is a proposal pipeline, not a write path.** The LLM legitimately parses "my rent's going up to 900 next month" into a candidate StatedFact — but the candidate enters the ledger only through deterministic confirmation (the §7 loop). The LLM proposes; the ledger disposes. Same for hypotheses: the LLM is an excellent hypothesis generator ("this cluster looks like a home renovation"), and hypotheses are quarantined by the epistemic ladder until confirmed.

Second, **exploration gets a sandbox with hard walls.** Open-ended "what if" conversation is where an LLM shines and where hallucinated numbers kill trust. The wall is already built: the validator. Exploration may recombine and narrate; every numeric claim must reconcile against frame-supplied figures or carry the unverified notice; counterfactuals ("what if I paid the card off?") are computed by the deterministic engine (a re-fold with modified inputs) and *then* narrated — the LLM never arithmetics.

Third, **the LLM never allocates attention.** Which insight headlines, which question gets asked, what is suppressed — these are policy outputs of the auction (§3), because they must be consistent across surfaces, inspectable, and stable across model swaps. The narrator reads the running order; it does not set it. The deeper reason for all three: model upgrades then change *fluency* without changing *judgment* — Fourth Meridian can swap models the way it swaps deployment SHAs, with the frame history as the invariant. One challenge to the philosophy worth accepting: "conversation" ownership is genuinely shared — dialog *state* (window, entities, goals) is platform-owned (AI-5 WS-1), while dialog *flow* is the LLM's. Splitting that hair correctly is what AI-5 already designs; keep it.

## 14. The Daily Experience

**Home/dashboard:** the frame's verdict line and headline insight sit above the widgets — the dashboards become the *evidence view* for a conclusion, not the user's interpretive burden. **Daily Brief:** renders the latest frame + material deltas since last view + at most one question. On a quiet day it says so — *"Nothing needs your attention. Cash flow on track; next likely event: your card autopay on the 2nd."* Quiet confidence is a feature; a brief that must always find news becomes a tabloid. **General chat:** the §1 benchmark answer — verdict, one item, invitation — with drill-down on demand. **Deep question** ("should I pay off the card?"): the option set from the assessment graph with trade-offs and a runway-floor check, narrated; every figure validator-reconciled; closing with the *decision recorded if taken* ("want me to track the staged plan?" → an accepted insight with a follow-up horizon). **Proactive insight (ambient):** fired only by material deltas crossing per-kind thresholds — *"Your card balance fell below 1,000 KWD for the first time in 14 months — carry cost is down to about 18/month from 110."* Celebration is allowed; it is a delta like any other. **Notification:** the severity-gated subset only (URGENT class, or the user's chosen kinds), always deep-linking to the insight and its evidence, never asking questions. **Monthly reflection:** a rendered frame-pair comparison — what changed, what you did, what it cost or saved, one theme — the first artifact users will screenshot and share. **Annual reflection:** the memoir chapter (§15's moat made visible): the year's trajectory, the decisions taken and their measured outcomes, the events that re-based the story, and one honest look forward.

## 15. The Long-Term Moat (stated as records, not vibes)

**After one year** the platform holds: ~365 sealed frames per Space, a full seasonal cycle, a populated insight ledger with acceptance/dismissal history, and a gap ledger of what the user will and won't share. That makes possible: seasonal baselines ("December runs +34% for you"), drift detection with statistical footing, novelty decay that actually works, and the first annual memoir. **After three years:** decision history with outcomes — the platform can say *"in 2027 you considered full payoff and chose the staged plan; it saved ~2,100 KWD in interest versus carrying, and your runway never dropped below 4 months"* — which transforms coaching from generic advice into evidence about *this user's own past choices*; life-event-aware comparisons ("your second year in Kuwait vs your first"); behavior-change attribution (did the subscription purge stick?). **After five years:** a queryable personal financial history that no institution holds — banks have your transactions; nobody has your *understanding trajectory*; counterfactual replay against real history ("what if I'd started the payoff two years earlier?" — a deterministic re-fold over recorded truth); coaching with a memory of what advice this user accepts, ignores, and regrets. None of this requires smarter models. All of it requires **records that exist only if v2.6 starts writing them**: sealed frames, the insight lifecycle, effective-dated testimony, and event boundaries. The moat is a ledger discipline, not an algorithm.

## 16. v2.6 Product Foundation

**Essential (the future is impossible without it):** the frame contract + Brief convergence (V26-F1-A, exactly as Claude Code's plan sequences it — contract first, persistence after proof); frame persistence + sealing + delta (V26-F1-B/WP-5..8); the **Insight ledger with lifecycle** (the attention auction is blind without novelty memory); the **gap ledger** generalization (question budget, refusal memory); ConversationState (AI-5 WS-1/2/4); the four clocks rendered honestly; the personal-context ledger *read* surface (even nearly empty — the trust contract starts at day one); baseline cost instrumentation (OPS-6H — per V26-FOUNDATION-1's reservation, the 60–85% figure is unproven until measurable).

**Valuable but deferrable:** StatedFacts *write* path (D3 — agree with deferral to v2.6b, but ship the reference slot and the ledger surface in v2.6a so the contract is proven empty before it is filled); LifeEvents as *manual* entries (detection later); monthly reflection; guidance-relative comparisons; the intent emphasis vectors beyond the first four intents.

**Dangerous to build too early:** peer percentiles (§11 — wrong at beta scale in two ways at once); life-event *auto-detection* acting without confirmation (wrong-hypothesis harm at the moment of lowest data); embeddings/semantic search (nothing to embed until the ledgers exist — retrieval infrastructure before memory is inverted priorities); LLM-written ledger entries (the proposal pipeline must exist first); any advice-execution automation (moving money is a different product with a different risk envelope); household-frame composition (V26-FOUNDATION-1 §10.3 is right — a separate compiler, after the single-Space contract survives contact).

## 17. v2.7+ Roadmap (product view)

v2.7: StatedFacts + question budget live; LifeEvents with confirmed detection; monthly reflections; voice as a frame renderer; intent vector completion; guidance bands. v2.8: decision-outcome tracking (accepted insights grow follow-up horizons and measured results); seasonal models (first full cycle in hand); counterfactual engine as a product surface; household frames. v3.0+: annual memoir as a flagship artifact; cohort statistics if and only if scale clears the §11 floors; coaching programs built on decision history. Provider expansion runs beneath this on its own track (per the context-architecture report) — more truth in, same understanding layer.

## 18. Product Risks

The ones that could kill it: **one wrong number** (mitigated: validator + evidence pointers — but the first publicized hallucinated balance erases years of trust; the validator's block mode should be beta-default for figures, not annotate); **creepiness inversion** (the same memory that delights when asked feels like surveillance when volunteered — mitigation: proactive surfaces only speak from material deltas, never from "we noticed something personal"; the ledger makes all memory legible); **wrong-hypothesis harm** (a confidently wrong "did you lose your job?" is worse than silence — hypotheses are questions, budgeted, and conservative); **advice liability** (Case-3-class recommendations approach regulated advice in some jurisdictions — see D-1 below); **sycophancy drift** (LLM tone bending verdicts — the frame's verdict is computed before narration; "truth never changes with tone" is enforceable because tone is applied *to* a sealed verdict); **question fatigue** (budget + refusal memory); **the quiet-product problem** (an honest advisor is often silent; retention pressure will push toward manufactured insights — the materiality rules are the defense, and leadership has to hold that line when engagement metrics complain); **privacy regression via evidence** (frames referencing purged rows — V26-FOUNDATION-1 §10.5's dangling-pointer honesty, plus purge-cascades over frames, D2).

## 19. Decisions the Founder Must Make

**D-1 · Advice posture:** is Fourth Meridian financial *education with personal context*, or personal financial *advice*? This decides copy ("options" vs "recommendations"), disclaimers, jurisdictional review (Kuwait/GCC + wherever beta users sit), and how far Case-3 option-ranking may go. Everything in this report works under either posture, but the copy layer must know. **D-2 · Retention and erasure:** frame/ledger retention spans, purge cascades, and the export story (the memoir argues for "your data is genuinely yours — take all of it"). **D-3 · StatedFacts timing** (V26-FOUNDATION-1's D3): this report says defer writes to v2.6b but ship the ledger surface in v2.6a. **D-4 · Liquidity semantics** (their D1): coverage-months — this report treats it as decided by Case 1; confirm it as product law. **D-5 · Validator posture for beta:** annotate vs block for unreconciled figures (this report: block). **D-6 · Benchmark sourcing:** none → guidance bands → cohorts; confirm the phase gates. **D-7 · The engagement line:** explicit agreement that quiet days are acceptable product outcomes, so the materiality thresholds don't erode under growth pressure. **D-8 · Monetization stance:** whether user financial data is ever monetized in any aggregate form — recommend a public "never" as a brand asset that compounds with the trust products in this report.

## 20. One Recommended First Product Slice

**"One Honest Answer" — ship the §1 benchmark interaction end-to-end for the single question "How are my finances?"**, on top of V26-F1-A. Concretely: the in-memory frame (already the first engineering ticket) + the attention auction over its assessment (headline/supporting/suppressed with recorded reasons) + the cross-domain rules needed for Cases 1–3 (runway floor, carry cost/spread, affordability) + verdict-first rendering in chat and the Brief's insight slot + the "why?" expansion showing evidence and suppression reasons. No new personal data, no persistence dependency beyond what F1-A already lands, and it is *testable against the three cases as fixtures* — Case 1 must praise, Case 2 must not moralize, Case 3 must offer options. This slice is the product thesis made falsifiable in one interaction: if the platform can answer its most common question with verdict, taste, honesty, and evidence, everything else in this report is elaboration. If it can't, no amount of memory infrastructure will save it.

---

## Final Answer

**What must v2.6 build so that, years from now, users honestly feel Fourth Meridian understands their financial lives better than they do themselves?**

It must build the things that only exist if you start writing them now: **sealed frames** (so understanding has a history), the **insight lifecycle** (so the system remembers what it said and what you did about it), the **effective-dated context ledgers** — testimony, events, gaps, refusals — (so your circumstances have a timeline instead of a profile), and the **epistemic discipline** that keeps truth, observation, testimony, and hypothesis from ever blurring (so everything it remembers, it can defend). Understanding-better-than-you-do is not a model capability — models forget everything and improve annually. It is an *archival* capability: the accumulation of honest, versioned, inspectable understanding that no later competitor can backfill and no model swap invalidates. v2.6's job is to open the archive. The feeling — "it knows my finances better than I do" — arrives roughly a year later, on the day the platform says *"this December will be expensive — yours always are — and unlike last year, you can afford it"*, and can show its work for every clause. That sentence cannot be built in the year it is spoken. It is built now, or never.
