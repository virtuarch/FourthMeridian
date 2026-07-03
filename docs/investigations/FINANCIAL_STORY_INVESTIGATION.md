# Financial Story — Product Investigation

**Status:** Investigation only — no implementation, no schema, no migrations, no UI work.
**Date:** 2026-07-03
**Author context:** Written against STATUS.md (verified 2026-07-02, commit `23a6387`), the approved 2026-07 roadmap revision, the AI-5 Advisor Intelligence charter, and the KD-17/KD-18 financial-honesty doctrine.
**Question under investigation:** Should Fourth Meridian reconstruct a user's financial narrative — not just *what* happened, but *why* — covering career changes, income growth, debt payoff, marriage, children, businesses, home purchases, investing milestones, behavioral changes, lifestyle inflation, and risk-tolerance evolution?

---

## 0. Executive summary

Financial Story is the most seductive idea in the product's future and the most dangerous one relative to its founding doctrine. The doctrine — deterministic-first, the LLM narrates but never calculates, no claim the validator cannot check — was built to prevent exactly the failure mode this feature invites: **confident fabrication of causality**. KD-18 proved the model will invent a per-card attribution when the dimension is missing; a narrative engine is that failure class promoted from a table cell to a life story.

The investigation's core finding is that "Financial Story" is actually three separable products, and they deserve opposite verdicts:

1. **A deterministic financial event ledger** — detected, evidence-linked, user-ratified events ("mortgage originated 2027-03", "recurring income changed +38% in June", "Card X reached $0"). Doctrine-compatible, feasible, and the substrate everything else composes from. **Worth committing to, with the schema-facing prerequisite riding v2.5.5's flowType work.**
2. **A narrated timeline** — the LLM turning ratified events into prose ("2027 was the year you became debt-free"). Safe *only* as narration over ratified events. Genuinely delightful, genuinely deferrable.
3. **Inferred life narrative** — the system asserting *why*: "you got married", "lifestyle inflation after your promotion", "your risk tolerance dropped after the 2028 correction". **This is where the feature dies if built naively.** Causal claims are structurally unverifiable by the membership validator, privacy-explosive in shared Spaces, and — per the behavioral-economics review in §6.5 — epistemically suspect even when the data pattern is real.

Recommendation in one line: build the event ledger, let the story accrue, never let the machine assert a "why" the user hasn't ratified.

---

## 1. What the feature would actually have to do

Reconstruction of a financial narrative decomposes into a pipeline, and each stage has a different risk profile:

**Signals → Events → Arcs → Narrative → Influence.**

*Signals* are things the system can already compute or nearly compute deterministically: a recurring income stream's amount changed; a new liability appeared; a liability balance reached zero; a new recurring merchant category appeared (childcare, tuition); savings-rate trend broke; portfolio allocation shifted. The v2.5.5 flowType initiative (with destination attribution, per the KD-18 ratification) is precisely the machinery that makes several of these computable — debt payoff, transfer patterns, income-stream identity.

*Events* are signals promoted to statements about the user's life: "income increased 38% in 2026-06" is still a fact; "you changed employers" is already an inference (payroll processor name changed ≠ new job — same employer switching from ADP to Gusto produces the identical signal). *Arcs* connect events across time ("three years of accelerating debt paydown"). *Narrative* attaches causality and meaning. *Influence* feeds the story back into recommendations.

The honest observation: **every stage past "events" leaves the territory the validator can police.** The AI-4 validator checks that a figure exists in context. It cannot check that "because you had a child" is true. KD-16 documented the model narrating context-selection artifacts as capability limits; a narrative engine invites narrating coincidences as life decisions.

### 1.1 The data-availability elephant

Most of the example stories (career changes, marriage, home purchase) will have happened *before* the user installed the product. Plaid history depth is bounded (the expand-history workflow exists precisely because default pulls are shallow; KD-7 documents a 5,000-row fetch cap), CSV import is MVP-grade, and SpaceSnapshots only accrue from onboarding forward. For a new user, Fourth Meridian can reconstruct at best ~24 months of story, with the oldest months least reliable.

This cuts two ways. It's an argument against shipping a story *surface* early — a timeline with one visible chapter is an empty trophy case, and empty-state disappointment is worse than absence. But it's the strongest argument for landing the event *substrate* early: stories are the one feature that compounds with tenure. Every month the ledger exists before the surface ships is a month of story the surface launches with. Snapshots already embody this bet; events are the same bet at higher semantic resolution.

### 1.2 What already exists to build on

More than expected. The deterministic assessment engine already computes spending trends, cash-flow quality, and debt strategy with confidence gating. Knowledge-gap capture already gives the analyst a channel to ask the user for missing facts — which is exactly the propose-confirm loop a story needs. AI-5's ConversationState substrate (v2.6a) introduces persisted, deterministic state consumed by the prompt pipeline — an event ledger is architecturally a sibling: persisted deterministic facts with provenance, serialized into context. And KD-10's `null` doctrine (no reliable input → no figure, rather than an approximation) is the exact template for how story confidence should behave.

---

## 2. The design questions, answered

### 2.1 How should stories be discovered?

Three channels, in strict trust order:

**User-declared.** The user says — in chat or a lightweight form — "I bought this house in 2019", "we had our second child in March". Knowledge-gap capture already harvests these opportunistically; the analyst asking "I noticed your income changed in June — new job, raise, or something else?" is both the best discovery UX and the best trust posture. The user does the causal attribution; the machine does the remembering.

**Deterministically detected, user-ratified.** Signal detectors (income delta, liability origination/extinction, new recurring category, allocation shift) produce *event candidates* with evidence attached. Candidates are proposed, never asserted: "It looks like a loan was paid off in April — want me to remember this as a milestone?" Ratified candidates enter the ledger at full trust; dismissed ones teach the detectors. This is the DuplicateAccountCandidate pattern (D1) applied to life events — the codebase already has the propose/audit idiom.

**LLM-suggested — narrative framing only.** The LLM may connect ratified events into arcs and propose phrasings. It may not originate events, and it may never originate causality. This is the KD-18 ATTRIBUTION_RULE extended one level up: as the model may not invent a per-card split, it may not invent a *reason*.

The tempting fourth channel — silent inference of sensitive life events (marriage, children, divorce, health) from transaction patterns — should be **ruled out as a matter of doctrine**, not merely deferred. §6.1 and §6.5 give the user-trust and epistemic cases; the one-line version is that the Target-pregnancy-detection story is a cautionary tale, not a product spec. The system may notice *financial* facts (a new recurring childcare-category merchant) and ask; it may not conclude *life* facts and tell.

### 2.2 How should confidence work?

Discrete tiers, not percentages. Percentages imply a calibration the system doesn't have and invite exactly the false precision the product's voice avoids. Proposed tiers:

| Tier | Meaning | Example |
|---|---|---|
| **Confirmed** | User declared or ratified | "New job at Acme, June 2026" — user said so |
| **Observed** | Deterministic fact, no interpretation | "Recurring deposit amount changed +38% on 2026-06-15" |
| **Suggested** | Detected pattern awaiting ratification | "Possible loan payoff — balance reached $0" |

Only **Confirmed** events may appear in narrative or influence recommendations. **Observed** facts may appear in analyst answers (they're just data). **Suggested** candidates appear only in a review queue and in analyst *questions*, never in analyst *statements*. Confidence is therefore not a number the user reads — it's a gate on what the system is allowed to say. This mirrors AI-5 WS-3 (completeness propagation: caveat or suppress, decided deterministically in code, not by prompt exhortation).

### 2.3 How should uncertainty be communicated?

By showing evidence, not adjectives. "Probably a job change (72%)" is worse in every way than "Your recurring deposit from ADP ended June 10; a new deposit from Gusto began June 24, 38% larger. Was this a job change?" Evidence-first communication is already the product's provenance doctrine, it makes the user the arbiter (which they enjoy — see §6.1), and it degrades gracefully: when evidence is thin, the question visibly rests on less, and the user calibrates themselves. Where an event's underlying data was flagged (truncated months, incomplete income), the KD-7 honesty pattern applies unchanged: the caveat rides the event or the event is withheld.

### 2.4 Should users edit stories?

Yes — and stronger: **the user is the editor-in-chief; the system is a research assistant.** Users must be able to confirm, reject, rename, re-date, annotate, and delete events, and mark events private (see §6.4 — critical in shared Spaces). Two design consequences follow. First, user edits are the *top* trust tier, so an edit is not vandalism of machine truth — it's the arrival of ground truth; detectors should treat contradicted candidates as training signal for suppression, not re-propose them. Second, deletion must be real for the narrative layer (a deleted event never re-surfaces in prose) even though the underlying transactions obviously remain. The one exception worth flagging: user-declared events that contradict observed data ("I paid that card off" while the balance is $4,000) should be stored but not silently believed — the analyst carries both and says so, which is exactly the answer-first-then-disclose shape KD-18's refinement established.

### 2.5 Should the AI explain its reasoning?

For event *detection*, there is no reasoning to explain — detection is deterministic and the explanation is the evidence list (§2.3). This is a feature: "explainable AI" hand-waving is unnecessary when the pipeline is deterministic by construction. For narrative *phrasing*, the LLM's contribution is stylistic, and explaining style is noise. So: yes, always, and cheaply — because the architecture makes explanation identical to provenance display. If explanation ever becomes *hard*, that is the signal that inference has crept above the deterministic layer, and the correct response is to remove the inference, not to build an explanation UI.

### 2.6 Should stories become part of Meridian Analyst?

Yes — first, and possibly *only*, for a long time. The single highest-value, lowest-risk integration is a **story assembler**: Confirmed events serialized into the analyst's context like any other assembler output, subject to the same agentScope and visibility filters. The payoff is immediate and compounding: "Your savings rate dropped in March" becomes "Your savings rate dropped in March — that's when the renovation started" *because the user told it about the renovation once, ever*. Today that context evaporates at conversation end; ConversationState (AI-5) persists it per-conversation; the event ledger persists it per-*life*. This is the cheapest possible version of the feature and it requires no new surface at all.

### 2.7 Should they become a timeline?

Eventually, and the roadmap already suspects this — "Timeline/Activity" sits in v2.5 as a stretch item marked *cut first*. A timeline is the natural read-surface for a ledger and the natural home for the ratification queue. But a timeline of three system-generated entries is an empty trophy case; the surface should wait until (a) the ledger exists, (b) typical tenured users have enough Confirmed events that the first render feels like a story, not a form. Ship the memory before the museum.

### 2.8 Should they influence future recommendations?

The most dangerous question, deserving the most conservative answer: **Confirmed events only, disclosed inline, never compounded.** "Given the home purchase you confirmed in March, your liquidity target changed" — visible premise, user-auditable, revocable by editing the event. What must not happen is inference stacked on inference: a Suggested job change feeding a Suggested lifestyle-inflation arc feeding an actual recommendation is three unvalidated hops, and the parked-ideas table already states the governing principle — *an assistant must first never misstate a number when asked before it acts unprompted*. Substitute "life event" for "number." Risk-tolerance evolution in particular should never be silently inferred and acted on: inferring risk appetite from behavior and then adjusting advice to match is (a) circular — behavior during a panic is not a preference, and (b) adjacent to the suitability judgments the v3.0 legal review is specifically scrubbing ("remove financial-advisor framing"). The analyst may *observe* ("you sold equities in the March drawdown — worth discussing whether your allocation matches your actual comfort") but the observation must be a conversation opener, not an input to advice.

---

## 3. Perspective review — End User

**Daily usefulness is real but indirect.** Nobody opens a finance app daily to reread their biography. The daily payoff is §2.6 — an analyst that remembers. That the analyst never asks "what renovation?" twice is felt as intelligence every single session, without any new screen. The timeline itself is an occasionally-visited, high-emotion surface: milestone moments (debt-free day, first $100k), year-in-review, and — underrated — *onboarding a spouse into a shared Space*, where the story is the fastest way to communicate financial history.

**Discoverability favors the conversational channel.** Event candidates surfacing as analyst questions and Daily Brief cards ("Looks like a milestone — mark it?") require zero new navigation. A review-queue-as-inbox works because the product already plans an AI Inbox (v2.6b).

**Cognitive load is the design battleground.** The ratification model's failure mode is nagging — a Plaid reshuffle producing five spurious "did something change?" prompts turns delight into chore and teaches users to dismiss without reading (banner blindness applied to their own life). Detectors must be *conservative by default*: high-precision, low-recall, hard-capped proposal frequency. A missed milestone costs little (the user can add it); a stream of false candidates costs the feature.

**Delight is the genuine upside — with a dark-mirror caveat.** "Spotify Wrapped for your money" is the obvious analogy and mostly the right one: people share Wrapped because it's identity-flattering. Financial stories are not reliably flattering. "2027: the year of lifestyle inflation" is accurate and demoralizing, and demoralized users churn (see §6.5 for the framing science). The narrative voice must be the product's established calm-and-factual register, celebration-forward for milestones, strictly neutral-descriptive for adverse arcs, and *never* moralizing.

**End-user verdict:** wants this, but wants it as memory-in-the-analyst first and pretty-timeline second, and will punish false inferences far more than they'll reward true ones. An app being wrong about your bank balance is a bug; an app being wrong about your marriage is a betrayal.

---

## 4. Perspective review — Principal Engineer

**Architecturally, the good news: this is a ledger, and the codebase likes ledgers.** Append-only audit log, DuplicateAccountCandidate-as-merge-ledger (D1), snapshots, soft-delete lifecycle (D8) — an event ledger with candidate/ratified states is idiomatically at home. The pipeline shape (deterministic detectors → candidate store → ratification → assembler → prompt) reuses the exact seams AI-1..AI-4 established. No second reasoning LLM appears anywhere above the validator, so AI-5's non-negotiable doctrine survives intact.

**The critical dependency is data semantics, and the sequencing already exists.** Event detection over pre-KD-17 category data would have manufactured false stories from sign asymmetries ("your 'Other' spending exploded" — no, four card-payment credits were miscategorized). The KD-17 lesson generalizes: **detectors may consume only test-enforced semantic contracts.** v2.5.5 (flowType with destination attribution, transaction-semantics doctrine, metadata depth) is precisely the contract layer detectors need — income-stream identity, transfer vs. spend, debt-payment destination. Building detection before v2.5.5 exits would repeat the KD-17 mistake at higher stakes. Corollary worth stating during v2.5.5 design (as a *requirements input*, not scope creep): flowType should be expressive enough that an event detector can later consume it without re-deriving semantics — largely what the KD-18 ratification already demands.

**Maintainability risks, in order of concern.** (1) *Detector sprawl* — each life-event type is its own heuristic with its own false-positive profile; ten mediocre detectors are worse than three excellent ones; a detector registry mirroring the assembler/signal registries keeps this bounded, but the discipline is editorial, not architectural. (2) *Event identity under re-sync* — Plaid reissues IDs; the reconcile engine survives this for accounts, but events derived from transactions need stable identity when their evidence is re-fingerprinted, or users watch ratified milestones vanish. Evidence should reference the merge-stable identities the reconcile engine already maintains. This is the hardest unglamorous problem in the feature. (3) *Retroactive semantics* — when v2.5.5 recategorization or KD-6 re-encryption-era backfills change historical rows, do detected events recompute? Recommendation: candidates recompute freely; **ratified events are immutable user statements** and never silently change — at most they gain an "evidence changed" annotation. (4) *Version churn* — narrative templates will iterate rapidly; keep prose generation stateless over the ledger (narrative is a *view*, never stored truth) so template churn never touches data.

**Scalability is a non-issue.** Events are O(dozens per user-year), evidence is references not copies, detection runs incrementally post-sync on the v2.6b scheduler substrate. The prompt-budget cost of a story assembler is real but small (events are terse), and the context-priority planner (v2.6b) exists to arbitrate exactly this.

**Engineer's dissent from the product enthusiasm:** the substrate is cheap only if scope discipline holds. The moment "story" means free-text LLM inference persisted as data, you've built a second, unvalidatable source of truth about the user, and every downstream consumer inherits its errors. The ledger must store only: deterministic facts, user statements, and *references* between them. Prose is always regenerated, never stored as ground truth.

---

## 5. Perspective review — Professional Wealth Manager / Financial Advisor

**This is the most workflow-realistic idea in the product's backlog.** The first hour of every real advisory relationship is story reconstruction — advisors keep exactly this artifact by hand (CRM notes: "sold business 2019; second home 2021; risk-averse since 2008"). Life events *are* the planning triggers: marriage → beneficiaries and filing status; child → 529 and insurance; home → liquidity and coverage; business sale → tax planning window. An event ledger the analyst consults is a digitized version of the advisor's actual working memory, and its absence is why robo-advice feels generic. Strong endorsement of §2.6: the ledger's professional value is as *context for advice*, not as a keepsake.

**Financial correctness demands the confirmed-only gate.** An advisor who *guesses* a client's divorce and adjusts the plan is committing malpractice; an advisor who *asks* is doing the job. The propose-confirm model is not a UX nicety — it's how the profession actually handles exactly this information asymmetry. And misattributed causality produces materially wrong advice: "lifestyle inflation" (behavioral, coach it) vs. a year of medical bills (circumstantial, plan around it) demand opposite responses, and the transaction pattern can be identical. The machine cannot distinguish these; only the user can.

**Where this perspective pushes back on the others:** the engineer's "conservative, high-precision detectors" and the user's "don't nag me" both underweight the *cost of silence* in an advisory frame. A human advisor who notices income stopped and says nothing for three months has failed. Some signals — income cessation, minimum-payment-only patterns, large unexplained outflows — carry enough planning weight that timely *asking* matters more than precision. Resolution: precision thresholds should vary by planning-criticality, not be uniform; and the venue for time-sensitive candidates is the Daily Brief (v2.6b's ambient channel), which exists for exactly this.

**Professional-expectation caveats.** Risk-tolerance "evolution" tracked as inferred fact drifts toward suitability assessment — regulated territory the v3.0 legal scrub is deliberately avoiding; keep it conversational (§2.8). And if shared-Space advisory relationships are a future market (the README names "advisory relationships" as a Space use case), the event ledger becomes a *client-permissioned disclosure artifact* — genuinely valuable, but it makes §6.4's privacy model load-bearing for a B2B story, not just an ethical nicety.

---

## 6. Perspective review — High-Net-Worth Individual

**§6.1 The trust asymmetry is sharpest here.** An HNW user's transaction graph is dense with patterns that *look* like life events and aren't: entity-to-entity transfers reading as income collapse, a capital call reading as a spending spree, a trust distribution reading as a windfall. Naive inference will be wrong *more often* for exactly the users with the most at stake, and this population's tolerance for being profiled by software is approximately zero. They will accept "I noticed X, is it worth remembering?"; they will terminate the relationship over "we've detected a divorce."

**§6.2 Multi-entity is where stories get structurally interesting — and hard.** A business sale is an event in the business Space *and* the personal Space *and* possibly a family Space, with different appropriate detail at each site. The natural model: events belong to a home Space and are *shareable into* others — which is precisely the SpaceAccountLink pattern (D3) applied to a new noun. That the architecture already has a first-class idiom for "one fact, multiple contexts, graduated visibility" is a strong signal the feature fits this product rather than fighting it. But it also means event sharing must wait for the sharing substrate to finish hardening (v2.5's SAL cutover and two-user privacy proofs).

**§6.3 Time efficiency reframes the value.** This user *knows* their story; a timeline telling them about it is decorative. What they lack is *everyone else knowing it*: the analyst not needing the K-1 situation re-explained per conversation, a family-office bookkeeper seeing context on the entity Space, a spouse seeing the household arc, eventually an advisor onboarding from the ledger instead of a two-hour interview. For this segment the feature is a **context-portability** product, and §2.6 (analyst memory) is nearly the entire value.

**§6.4 Privacy is the make-or-break requirement — stated precisely:** *an inferred or narrated event must never leak information that the underlying visibility tier would redact.* A BALANCE_ONLY share exposes no transactions; a story event *derived from* transactions ("large recurring transfers to X began in May") surfacing in that Space reconstructs redacted data — KD-1/KD-15/KD-19's defect class, at higher semantic density and worse: narrative is *summarized* leakage, the kind read-time redaction can't claw back. Requirements that fall out: events carry the visibility level of their evidence and are filtered by the same canonical predicate family (`lib/ai/visibility.ts`) as everything else; per-event privacy overrides (visible to me only, even in shared Spaces); and the two-user privacy proof extends to the story assembler *before* stories ever enter a shared context. Family dynamics make this concrete: "spending pattern change in the household Space" can expose one spouse's private account activity to the other. The product's redaction discipline is currently its proudest muscle — this feature is the heaviest weight it will ever lift.

---

## 7. Perspective review — Wildcard: Behavioral Economist

Chosen because the feature's entire premise — reconstructing *why* — sits on top of two well-documented human biases, and a system can either correct for them or industrialize them. No other lens interrogates the premise itself; everyone else critiques the execution.

**The narrative fallacy is the feature's foundation risk.** Humans compulsively impose causal stories on sequential data (Taleb's narrative fallacy; Kahneman's "causes trump statistics"), and *machine-generated* stories arrive with an authority gloss that self-generated ones lack. When Fourth Meridian says "your spending rose after the promotion — lifestyle inflation," it converts a correlation into an institutional fact the user will repeat about themselves. Half the example list — behavioral changes, lifestyle inflation, risk-tolerance evolution — is causal interpretation, not event detection, and for these the honest system output is a *juxtaposition* ("income rose 30% in June; discretionary spending rose 45% July–December") with the user invited to name it. The naming is the user's job not because the machine is being polite, but because the machine's causal claim would be epistemically counterfeit.

**Hindsight bias, second-order.** A curated timeline makes the past look inevitable and legible, which quietly miscalibrates confidence about the future ("I always course-correct"). Mitigation is cheap and doctrine-aligned: keep narrative descriptive rather than dispositional — "you did X" not "you are the kind of person who does X."

**Now the positive case, which is strong.** Self-relevant feedback is among the most reliable behavior-change levers in the field (the entire self-monitoring literature), and *milestone* framing specifically exploits goal-gradient and fresh-start effects: "debt-free day," "one year since the new job" are motivationally potent anchors that generic budgeting apps cannot produce because they have no memory. Peak-end effects mean a handful of well-chosen celebrated moments will dominate the user's feeling about the product. And the ratification flow itself is a behavioral win hiding in plain sight: asking the user to name what happened is a commitment device — self-authored narratives drive behavior far more than received ones. The propose-confirm design isn't just the safe option; it's the *behaviorally superior* one.

**Framing of adverse arcs decides retention.** Shame-framed financial feedback produces avoidance (people stop opening the app — the ostrich effect is robustly documented), not correction. Adverse patterns should surface as neutral observations attached to forward options, never as verdicts. This is a narrative-template concern, i.e., cheap to fix and easy to test — but it must be an explicit design requirement, not an accident of prompt wording.

**Where this perspective overrules the others:** the wealth manager wants proactive signal surfacing; the end-user perspective wants delight; both are right, but *neither justifies machine-asserted causality*, ever, at any confidence tier. The behavioral evidence says user-authored meaning is more accurate *and* more motivating. There is no tradeoff to split here — the confirm-don't-assert doctrine wins on every axis simultaneously, which is rare and worth noticing.

---

## 8. Tradeoffs the perspectives don't resolve

Per the brief, conflicts are stated, not averaged:

**Proactivity vs. quiet (advisor vs. end-user/HNW).** The advisor is right that silence on income cessation is a failure; the HNW user is right that false alarms are relationship-ending. Resolution is not a single threshold: tier detector aggressiveness by planning-criticality, and route time-sensitive candidates through the Daily Brief (already opt-in ambient) rather than interrupting. Accept that v1 will be criticized as too quiet. Too quiet is recoverable; creepy is not.

**Substrate-early vs. roadmap discipline (engineer vs. the STATUS.md doctrine).** The compounding-data argument (§1.1) genuinely favors landing the event ledger early — every pre-surface month is free story. But v2.4.5→v3.0 is a verification-gated march with "zero new product surface" stamped on two milestones, the parked-ideas table exists precisely to resist this argument, and five migration seams are already open concurrently. The resolution this investigation recommends: the *only* pre-launch commitment is a requirements input to v2.5.5 (flowType expressive enough for later event detection — largely already ratified via KD-18) plus continued snapshot accrual. The ledger itself waits. If that means the timeline launches with a thinner history for early users, that's the cost of shipping the trustworthy thing first — and Plaid-history backfill plus user declaration recovers most of it.

**Story-as-keepsake vs. story-as-context (end-user vs. HNW/advisor).** These pull toward different surfaces (emotional timeline vs. analyst memory). They're stages, not rivals — but the ordering matters and the keepsake must not ship first, or the feature gets publicly judged as a gimmick before its substance exists.

---

## 9. Concluding answers

### 9.1 What would make this genuinely differentiated from every other personal finance app?

Not the timeline — activity feeds and year-in-review recaps are commodity (Mint had feeds; Copilot and Monarch do recaps; every neobank does a Wrapped clone). The differentiation is the combination no one else can honestly ship: **a provenance-carrying, user-ratified event ledger consulted by an analyst that is architecturally forbidden from fabricating the "why."** Competitors bolting LLMs onto transaction feeds will ship confident, wrong, creepy narratives — the KD-18 failure at product scale — because they lack a validator, visibility discipline, or a deterministic-first pipeline, and the incident reports will write themselves. Fourth Meridian's story can be the one that is *right*, or silent — and "the finance app that remembers your life and never lies about it" is a moat built from the codebase's existing strengths (provenance doctrine, confidence gating, redaction discipline), not from a feature competitors can copy in a sprint. Secondarily: multi-entity story portability (§6.2) has no competitor even attempting it, because no competitor has the Spaces substrate.

### 9.2 What is the biggest risk or downside?

**Fabricated causality — the KD-18 defect class promoted to narrative, where the validator is structurally blind and the blast radius is personal.** A wrong number is a bug; a wrong story about your marriage, your job, or your discipline is a betrayal users narrate to other people. The close second, for shared Spaces specifically, is **narrative as summarized privacy leakage** (§6.4) — inferred events reconstructing transaction detail that visibility tiers redacted, one spouse's private activity surfacing as household "story." Both risks share a root cause (generating semantic conclusions above the deterministic layer) and a mitigation (confirm-don't-assert + events inherit evidence visibility), which is why this investigation treats confirm-don't-assert as doctrine rather than as a v1 conservatism to relax later. The subtler long-term downside: ratification fatigue quietly killing engagement — mitigated by precision-first detectors and hard proposal caps, and measurable (dismiss-rate) from day one.

### 9.3 Should this ship in v2.5, v2.6, or v3.0, or later?

**Later — post-v3.0 — as a surface; with exactly one pre-launch commitment.** The reasoning: v2.5/v2.5.5/v3.0 have explicit zero-new-surface or completion mandates; v2.6a/b are fully allocated to making the analyst conversationally coherent and then ambient, and both are *prerequisites* for stories (a system that changes time windows silently, KD-16, cannot be trusted with biography; candidate surfacing needs the v2.6b scheduler and Daily Brief; event sharing needs v2.5's hardened SAL substrate). The parked-ideas doctrine also applies squarely — "an assistant must first never misstate a number before it acts unprompted" extends naturally to "before it narrates your life." Recommended ledger entry: park as its own initiative with unpark conditions of *v3.0 shipped + AI-4 validator track record in production + v2.5.5 semantics test-enforced*, and a first phase (post-launch) of analyst-memory only — user-declared events, story assembler, no timeline, no detection. The single pre-launch action: ensure v2.5.5's flowType design carries the semantic depth event detection will later consume (destination attribution, income-stream identity) — already substantially ratified, so this is a design-review checkbox, not scope.

### 9.4 If you could only keep one idea from this investigation, which would it be and why?

**The user-ratified financial event ledger — confirm, don't assert.** Every other idea composes from it: the timeline is a view of it, narratives are prose over it, analyst memory is an assembler reading it, recommendations cite its Confirmed tier, multi-entity stories share it via the SAL idiom. It is the only piece that is simultaneously doctrine-compatible (deterministic facts + user statements, nothing the validator can't tolerate), behaviorally superior (self-authored narrative beats received narrative for both accuracy and motivation — §7), professionally correct (asking is the advisory standard — §5), and privacy-tractable (events inherit evidence visibility — §6.4). And it converts the product's deepest structural bet — that users stay for years — into a compounding asset no fast-follower can replicate, because the only way to have a five-year story is to have been trustworthy for five years.

---

*End of investigation. No implementation, schema, or code work performed or proposed for the current milestone.*
