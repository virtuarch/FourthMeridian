> **DOCTRINE — RATIFIED.** This is FI0: the foundational architectural doctrine for Financial Intelligence inside Fourth Meridian. It defines how the platform thinks, how future systems must be designed, how new ideas are classified, and how architectural drift is prevented. It is not an investigation, a roadmap, or implementation guidance. No code, schema, or STATUS.md changes accompany it. For current project state see `STATUS.md` at the repository root.

# FI0 — The Financial Intelligence Doctrine

**Designation:** FI0 · Foundational architectural doctrine · North-star reference
**Status:** Ratified. Supersedes ambiguous predecessor language where it conflicts (recorded in-line).
**Ratifies and synthesizes:** the Financial Intelligence umbrella-architecture investigation, the Intelligence Boundary Definition investigation, the Transaction Location Metadata investigation, the Transaction Intelligence fact-layer investigation (including the 7A Metadata Capture Doctrine), the Merchant Intelligence product architecture, the Multi-Currency (MC1) doctrine, Coverage conclusions, and the applicable KD-register rulings.
**Standing:** Future architectural proposals are measured against this document. Where a stronger long-term rule was found during ratification, the previous assumption was challenged and replaced; those points are marked **[refines]**.
**Test of durability:** every rule here is written to still be correct five years from now, at a scale this platform does not yet have.

---

## 0. How to read this document

FI0 is doctrine, not description. It states what must be true, not what happens to be true today. Where the shipped code is already the doctrine (FlowType, Merchant Intelligence, `computeAssessment`, the Perspective lenses, SpaceSnapshot), FI0 *names and freezes* the pattern. Where investigations disagreed, FI0 reconciles them into the single strongest long-term rule and records the reconciliation so the decision is auditable, not silent.

Three reconciliations are load-bearing and stated up front:

1. **Coverage is a first-class Intelligence module, not shared infrastructure.** The umbrella investigation hedged it as "shared Tier-3 infrastructure"; the boundary investigation promoted it. **FI0 ratifies the promotion** — Coverage makes fallible epistemic claims, needs the honesty valve, and has more consumers than any other module (§6, §7).
2. **"Compute once" means one *definition site*, not one *execution*.** Persistence is an engineering decision made per fact, not a defining property of Intelligence. The read-time relationship resolver proves real Intelligence need not persist (§5.10).
3. **Location is a Records-tier attribute, never a module.** The three inconsistent predecessor statements are resolved by the three-band taxonomy and the use-level inference ban (§13).

A naming note ratified here to end an ambiguity: **"Financial Intelligence" is the name of the platform architecture** described by this document. The former bounded milestone that reused that name is renamed **"Transaction Semantics Closeout"** so that one name never denotes both a point release and the platform's constitution.

---

## 1. Vision

**Fourth Meridian is building a Financial Intelligence Platform.** That sentence is an architectural commitment, not marketing. It means the durable asset the company builds is not a chat product and not a set of screens — it is a body of *deterministic financial knowledge*, computed once, owned by exactly one authority each, carrying its own provenance, and reused by every surface that needs it.

**Financial Intelligence is not AI.** This is the inversion the whole platform rests on. The mainstream AI-PFM failure mode is LLM-over-raw-data: pour transactions into a prompt, let the model do the arithmetic, and accept that the figures drift between answers. Fourth Meridian refuses that shape. Deterministic modules compute; the model narrates; a validator enforces; every fact carries version and provenance; and when signal is insufficient the system says UNKNOWN rather than guessing.

The relationship between the two layers is fixed and directional:

- **Financial Intelligence is deterministic knowledge.** It is computed by pure, versioned code from stored records. It can be wrong only in the specific, honest sense that its inputs were incomplete or its inference was fallible — and when it is, it says so.
- **AI consumes Financial Intelligence.** The LLM is a *consumer* of serialized facts. It phrases, explains, and arranges. It reasons over numbers it was handed; it does not invent them.
- **LLMs narrate. They never become canonical.** No figure, relationship, category, or claim is ever authoritative because a model produced it. The moment a model's output would become a fact other code reads, the architecture has failed. Canonical knowledge has one home, and that home is never a prompt.

Why this is a moat and not merely a preference: cross-surface figure consistency, answerable "why is this number what it is," the honesty valve as visible product behavior, and — eventually — provenance-validated model output are properties a prompt-engineering competitor cannot match without rebuilding their data layer. The differentiation compounds with user trust over months; it is a long-term bet, and it must be funded as one. Doctrine now; modules on demand.

The vision is deliberately long-horizon. Deterministic-with-caveats loses a demo to confident-and-wrong. FI0 accepts that trade knowingly: Fourth Meridian would rather tell a user less than tell them wrong, and it builds the architecture that makes "less but true" cheaper than "more but drifting."

---

## 2. Core Philosophy

These principles are the platform's constitution. Every module, every consumer, and every future proposal inherits them. They are stated as laws, not preferences.

**Compute once.** A fact is computed in exactly one place — its definition site. Not once per surface, not once per request path, not once per redesign. The re-derivation defect class (KD-10's two competing monthly-expense figures, KD-11's drifting keyword heuristics, KD-17's sign asymmetry, the four `FLOW_COST` copies) is the same bug wearing different clothes every time: a fact computed in more than one place. "Compute once" makes that a review-time rule instead of a recurring incident. **[refines]** Compute once governs the *definition*, not the *execution*: a fact may be recomputed at read time on every request and still obey it, provided there is one place that defines how it is computed (§5.10).

**Reuse everywhere.** Once a fact exists, every consumer reads it. No consumer re-derives a fact it could have read. A second computation of an existing fact is not an optimization or a convenience — it is a defect, because two computations drift and the platform's whole value is that they cannot.

**Facts have one authority.** Every named claim about a user's finances has exactly one owner, forever. Not one owner per feature, per table, or per release — one owner, period (§15). This is the strongest single rule in the document.

**Every claim has provenance.** No fact travels without its lineage: which inputs produced it, at what freshness, under which visibility tiers, and at which version of the computation. Provenance is what makes "why did my number change" answerable, what powers the "Why this category?" explainer, and what the output validator will eventually check against.

**Honesty is a feature.** The honesty valve is product behavior, not an engineering nicety. Insufficient signal yields UNKNOWN, null, or absence — never a fabricated value dressed as fact. Estimates are always labeled. This applies with *more* force to composite scores and forecasts, not less, because those are where false confidence is most tempting and most damaging.

**Determinism first.** Same inputs plus an injected clock yield byte-identical output. Determinism is the platform's constitution, not any one module's badge — the validator, the lenses, and even brief composition are deterministic. An LLM-computed "fact" is banned everywhere, not merely discouraged in modules.

**Consumers never invent facts.** A surface may select, arrange, filter, threshold for display, and present. It may never define a fact, an aggregation, or a membership predicate. The instant a dashboard or a brief computes a figure, KD-10 is reborn.

**LLMs explain. They do not compute.** The model receives serialized, pre-computed facts and turns them into language. It never performs the arithmetic, never resolves the identity, never classifies the flow. Facts reach it as aggregates and stored labels it phrases — never as raw per-row dumps to reason over.

---

## 3. Architectural Taxonomy

Fourth Meridian recognizes exactly **six categories plus one substrate**. Every component, initiative, and proposed idea belongs to exactly one of them. The categories are not organizational conveniences; they are contracts, each with a distinct discipline, a distinct failure mode, and a distinct set of things it must *never* own. The taxonomy exists so that classification is objective — decided by the Wrongness Test (§4), not by whether "Intelligence" sounds good in a name.

| Category | One-line contract | Canonical examples |
|---|---|---|
| **Records** (substrate) | Immutable / append-only stored reality; asserts nothing beyond "this was captured." | Transaction rows (native amounts), FinancialAccount, Holding, FxRate archive, SpaceSnapshot (once written), captured provider metadata |
| **Intelligence** | The sole, versioned, deterministic authority for a named family of *fallible derived financial claims*. | Transaction, Merchant, Financial Health, Coverage |
| **Infrastructure** | Correct-or-buggy supporting computation and plumbing; no semantic claims, no confidence, code-versioned only. | period math, currency conversion, normalization, parsers, provider adapters, registries/engines, visibility predicates |
| **Context** | Declared or operational state that computation consumes but never derives; told, not inferred. | user profile, age band, employment, household, risk tolerance (declared), provider capabilities, session, preferences, flags, conversation state |
| **Consumers** | Select, arrange, filter, and present owned facts; assert nothing new about the finances. | Dashboard, Briefs, Advisor serializer, Search, Notifications content, Platform Operations |
| **Delivery** | Move finished outputs across time and channels; compute nothing. | scheduler, jobs, automation, notifications transport, Ambient |
| **Enforcement** | Deterministically police artifacts and boundaries; own judgments about *outputs*, never about finances. | output validator, guardrails, policies, consistency/invariant checks, rate limiting, visibility gates |

### 3.1 Records — the substrate

**Responsibility:** hold captured reality, immutably. A Record asserts only that something was observed and stored: this transaction was seen, this balance was reported, this rate was archived on this date. **Must never own:** any derived claim. A Record is never restated. `SpaceSnapshot` is the deliberate hinge — its *computation* is Intelligence-adjacent (an aggregate with provenance and an `isEstimated` flag), but the *instant it is written it becomes a Record*: frozen, dated, never edited (the MC1 "history is never rewritten" law). Classify the snapshot *table* as Records; classify its *computation* as owned by the relevant aggregate module.

### 3.2 Context — the environment

**Responsibility:** describe the environment the computation runs in — who the user is, what the provider can supply, what the session scope is, which flags are set. **Context describes; it computes nothing.** The defining property is the *direction of truth*: Context is told to the system and changed by re-declaration; Intelligence is derived by the system and changed by re-computation. Asking "what version of the classifier produced your employment status?" is absurd, and that absurdity is the category boundary (§8).

### 3.3 Intelligence — derived knowledge

**Responsibility:** be the one authority for a named family of claims the records do not state. **Must never own:** anything declared (that is Context), anything that cannot be wrong about the finances (that is Infrastructure), any presentation choice (that is a Consumer's), or a claim family another module already owns (that is a facet, or a duplicate to be killed). Defined rigorously in §5.

### 3.4 Consumers — assembly and presentation

**Responsibility:** assemble Intelligence into experiences — dashboards, briefs, the advisor's serialized context, search results, notification bodies, platform-ops views. Consumers **assemble intelligence and own zero canonical financial claims.** They may own view logic (tone, ordering, visit-state greeting, section priority), display thresholds ("show the alert when runway < 2 months"), scope selection, and composition. They may never own a fact definition, an aggregation, or a membership predicate (§9).

### 3.5 Delivery — distribution

**Responsibility:** move finished outputs across time and channels — scheduling, jobs, automation, notification transport, the Ambient cadence. **Delivery distributes information; it never computes intelligence.** Its disciplines are operational (idempotence, retry, opt-out, audit), not epistemic. If Delivery ever computed a figure, it could fail the validator on its own — which is exactly why the Ambient exit criterion is *zero validator failures* (§10).

### 3.6 Enforcement — the referee

**Responsibility:** police artifacts and boundaries deterministically — the output validator, guardrails, policies, consistency and invariant checks, rate limiting, visibility gating. **Enforcement is the referee, not a player** (§11). Its judgments are about *outputs* ("this reply contains an unreconciled figure"), never about finances. A validator that owned a financial fact would validate itself.

Two subtleties are doctrine, because they recur:

- **Engines are Infrastructure; their content is Intelligence.** The Perspective Engine (registry, shaping, `validateLensResult`) is Infrastructure — it cannot be wrong about finances. Each lens *core* is Intelligence, owned by a domain module. The same split governs the assembler registry vs the assemblers, and the notification machinery vs the facts notifications carry.
- **Initiative names and registry membership are different namespaces.** An initiative may be called anything — "Advisor Intelligence," "Ambient Intelligence." The registry (§7) admits only components that pass the Wrongness Test. Say this explicitly or the initiative ledger silently becomes the registry.

---

## 4. The Wrongness Test

**This is the first question asked before any new architecture is created.** Before naming a module, writing a schema, or filing an initiative, the proposal is run through the Wrongness Test. It is the official classification test of Fourth Meridian, and the entire taxonomy falls out of it.

### 4.1 The test, stated

> **Could this component's output be *wrong about the user's finances* while the code is bug-free?**

- **If YES → it is Intelligence.** It makes a fallible claim about financial reality, and it must carry the full apparatus: single authority, deterministic core, honesty valve, machine-readable explanation, provenance, versioning, and (where the inference is fallible) confidence.
- **If NO → it is something else, and it must not be called Intelligence.** Naming it Intelligence only dilutes the doctrine.

The discriminating property is **fallible semantic derivation**: Intelligence *asserts* something the records do not say — "this row is one leg of a transfer," "your runway is 3.2 months," "these two merchants are the same brand," "this month's income is complete enough to state a savings rate." Because the assertion could be wrong even with perfect code, the module needs the honesty apparatus.

### 4.2 The follow-on branches

When the answer is NO, three quick questions place the component:

- **Is its content *declared* by a user, operator, or provider rather than computed?** → **Context.** (Wrong only if the user misspoke — the remedy is re-asking, not re-deriving.)
- **Does it *select / arrange / present* facts owned elsewhere?** → **Consumer.**
- **Does it *move or schedule* finished outputs?** → **Delivery.** Does it *police* outputs or boundaries? → **Enforcement.** Otherwise → **Infrastructure** (correct-or-buggy supporting code).

When the answer is YES, two questions decide whether it is a *new* module:

- **Does another module already own this family of claims?** → It is a **facet** of that module (extend it), or a **duplicate** definition site (kill it). Not a new module.
- **Will at least two consumers read these claims through a typed contract?** If not, it is **consumer-internal logic** for now — record it, and promote it (by *moving* the code, never copying) when the second consumer appears.

### 4.3 Fast litmus forms

- **The Wrongness Test:** wrong about finances with bug-free code → Intelligence. Wrong only via a bug → Infrastructure. Wrong only if the *user* misspoke → Context.
- **The Second-Consumer Test:** would a second consumer need this logic byte-identical? If yes and it lives inside a surface today, it is Intelligence trapped in a Consumer — the KD-10 birth defect.
- **The Confidence Smell:** if you feel the urge to add a `confidence` field to a utility, it has become Intelligence and must be promoted — or the urge is wrong and must be resisted. Infrastructure with confidence is a category error in either direction.

### 4.4 Why "could be wrong" and not "computes something" or "reads many sources"

Two intuitive-but-wrong criteria are explicitly rejected, because the shipped code disproves them:

- **"Derives from multiple sources" is not a signal.** `flowType` derives substantially from one row plus its payload — and is the kernel of the whole architecture. The Daily Brief reads *everything* and owns nothing. Source count measures plumbing, not intelligence.
- **"Is deterministic" is not distinguishing.** Everything in Fourth Meridian is deterministic. Determinism is the constitution, not Intelligence's badge.

### 4.5 The test applied to common future ideas

Run the test the way a future proposal will be run:

| Proposed idea | Wrongness Test | Classification |
|---|---|---|
| "Time Intelligence" (fiscal periods, quarters, seasonality) | "What is Q3" cannot be wrong about finances, only buggy | **Infrastructure** — extract `lib/periods`; never a module |
| "Location Intelligence" (travel, home radius, commute) | Would be fallible inference — but its inputs are on the Never-Captured deny-list | **Never exists** (§13); coarse locality is a Records attribute |
| "Behavior Intelligence" (what kind of spender you are) | Every concrete claim already has an owner; the residue is unfalsifiable psychography | **Never exists** — cannot pass the honesty valve |
| "Subscription Intelligence" | The claim family (recurrence, cadence, price increase) belongs to recurrence facts | **Facet** of Transaction/Merchant recurrence + a Consumer surface |
| "User Intelligence" (age, employment, household) | Declared at onboarding, not derived — fails the first question | **Context** |
| "Crypto Intelligence" | Same claim family as portfolio (exposure, concentration, yield) with a crypto key | **Dimension** (facet) of Investment; not a module |
| "Weekly Brief Intelligence" | Selects and composes owned facts; period is a parameter | **Consumer** (one brief engine, parameterized) |
| "Cash Intelligence" (runway, paycheck cadence, volatility) | Runway is a fallible derived claim | **Intelligence** (aggregate) — legitimate, gated on recurrence facts |
| "Coverage" (data sufficiency, completeness) | "Income is complete enough to state a savings rate" can be wrong | **Intelligence** (epistemic module) — first-class (§6) |

The pattern the table teaches: most "X Intelligence" ideas are Infrastructure, Context, Consumers, Delivery, or facets in disguise. A healthy registry rejects far more than it admits.

---

## 5. Intelligence — the precise definition

### 5.1 The official definition

> **An Intelligence module is the sole, versioned, deterministic authority for a named family of derived financial claims — statements about financial reality that are not present in the raw records, that could therefore be wrong, and that consequently must carry provenance, an honesty valve, and (where inference is fallible) confidence — exposed as typed, reusable outputs.**

### 5.2 The seven requirements (all required at birth)

A component is an Intelligence module only if it satisfies **all seven**:

1. **Fallible semantic derivation** — produces claims about financial reality not present in the records, which could be wrong even with bug-free code.
2. **Canonical ownership** — the sole authority for that named family of claims; no second definition site anywhere (§15).
3. **Deterministic pure core** — same inputs plus injected clock yield identical output; no LLM, no I/O in the core.
4. **Honesty valve** — insufficient signal degrades to UNKNOWN / null / absence, never a fabricated claim; estimates always labeled.
5. **Explainability** — machine reasons (stable enums, not prose) for every claim.
6. **Provenance** — inputs, freshness, visibility tiers, and consumed fact-versions carried with every output.
7. **Reusable typed contract** — published outputs designed for more than one consumer.

**Conditional:** *confidence* is required wherever the derivation is fallible inference, and replaced by *completeness* where the risk is missing inputs. A module that needs neither confidence nor completeness is probably Infrastructure.

**Explicitly insufficient** (each alone proves nothing): computing something (Infrastructure computes); reading many sources (Consumers do); being deterministic (everything is); being important (the Brief is important and still a Consumer); having "Intelligence" in an initiative name.

### 5.3 Versioning

Versioning is what makes claims correctable at scale. Two flavors, one discipline:

- **Fact modules version rows** (`FLOW_CLASSIFIER_VERSION`, `tiFactsVersion`): a version stamp per row enables selective backfill (`WHERE version < N`) and makes "why did my number change" answerable.
- **Aggregate modules version math** (`lensVersion`): a bump on any math change makes outputs comparable across time.

A Tier-3 output records the versions of the facts it consumed in its provenance, so a backfill at v(N+1) *explains* any downstream shift instead of mystifying it.

### 5.4 Confidence and completeness

**Confidence where the module might be wrong; completeness where the inputs might be missing.** A classifier choosing between a PFC hint and a sign-default has genuine confidence to report. A lens summing FULL-visibility balances is not "confident" — it is *complete or incomplete*. Never stamp `HIGH` reflexively; a confidence field that is always `HIGH` is confidence theater, and the propagation tests exist to catch it.

### 5.5 Provenance

Provenance subsumes the data half of explainability: which inputs, which visibility tiers, what freshness (`dataAsOf`), and which fact versions. It is also the precondition for upgrading Enforcement from *membership* validation ("this figure appears somewhere in context") to *provenance* validation ("this figure is `assessment.cashFlow.estimatedMonthlyExpenses` v3"). That upgrade is the architectural payoff that retires the KD-2 caveat.

### 5.6 Deterministic outputs

The core is pure over typed inputs with an injected clock, producing byte-identical output for identical inputs. No Prisma import, no LLM import — enforced by import-graph tripwire tests, not by good intentions. Fail closed and *fail shaped*: a computation failure yields a typed `COMPUTE_FAILED`, never raw error text and never a guessed value.

### 5.7 Honesty valves

The honesty valve is non-negotiable and applies with extra force to composite scores and forecasts. A single "financial health score" invites false precision; the anti-fabrication doctrine binds composite indices too. Insufficient signal produces absence, not an approximation presented as fact.

### 5.8 Single ownership

One authority per claim family, no second definition site anywhere — module, consumer, script, or prompt. A component that computes facts another module owns "is not a module; it is a bug with a roadmap." Detailed in §15.

### 5.9 Fallible financial claims — the heart of it

The defining content of Intelligence is a claim that *could be wrong about the finances*. This is why Coverage is Intelligence (its completeness judgments can be wrong), why the relationship resolver is Intelligence (a transfer pairing can be wrong), and why period math is *not* (Q3 cannot be wrong, only miscoded). The apparatus exists to make fallibility honest, not to eliminate it.

### 5.10 Persistence is not required

**Persistence is an engineering decision made per fact, never a defining property of Intelligence.** The read-time relationship resolver is dispositive proof: it computes real Intelligence (pending↔posted identity, duplicate identity) at read time, pure and unpersisted, because those facts are cheap-to-recompute explanation context. FlowType persists because write-path stamping and backfill economics demand it. **"Compute once" means one definition site — not necessarily one execution.** Decide persistence per fact: persist when recompute cost is high, or write-path stamping enables backfill economics, or consumers need cross-time comparability; otherwise recompute at read. Persisting cheap aggregates only manufactures staleness and invalidation machinery for no benefit.

---

## 6. Registry

The registry is the doctrine's ledger of Intelligence modules. **Everything else lives in the taxonomy, not the registry.** Registry entries drop the "Intelligence" suffix — it is the category name, not a per-module honorific; a ledger of nine entries all ending in "Intelligence" is noise.

### 6.1 The core registry (exists or justified today — four members)

| Entry | Kind | Owned claim family | Status |
|---|---|---|---|
| **Transaction** | Fact module (row facts + read-time relationships) | what happened: flow/direction, method, settlement, transfer/duplicate/refund groupings | Exists: FlowType kernel + fact builder + relationship resolver; remaining slices sequenced |
| **Merchant** | Fact module (identity, category provenance) | who: merchant identity, aliases, category + source/provenance | Exists (M0–M6); merge review planned |
| **Financial Health** | Aggregate module | cross-domain assessments, risks, opportunities | Exists as `computeAssessment`; absorbs the opportunity engine; decompose gradually |
| **Coverage** | Epistemic module | what the data can support: depth, freshness, estimation, completeness, structural gaps | Promoted to first-class (§7 rationale); mostly adoption of shipped flags |

### 6.2 The gated future (each earns its existence, in dependency order)

**Cash** (gated on recurrence facts) · **Investment** (gated on demand + securities reference data; absorbs crypto as a dimension) · **Forecast** (gated on recurrence + Cash) · **Receipt** (gated on Transaction relational facets + demand; a new Records substrate) · **Tax** (gated on counsel review + a lot model + post-launch demand). One capability is pre-assigned but not registered: **recurrence** — a fact family whose owner is fixed at the Transaction/Merchant boundary; "Subscriptions" is its Consumer surface, not a module.

### 6.3 Why the registry stays small — and why modules must earn their existence

**Naming a module creates gravitational pull to build it.** A registry is not a wish list; it is a governance instrument for a solo maintainer whose future self is the second engineer. The discipline is explicit:

- **New modules must earn their existence individually.** A module exists only when it owns a named family of fallible claims no existing module owns, at least two consumers need those claims through a typed contract, and it can satisfy all seven §5.2 requirements *at birth*. Otherwise it is a facet, consumer-internal logic, or a wish.
- **New claims default into existing modules.** The bar for a new module is higher than the bar for a new facet. When in doubt, extend.
- **The registry is append-justified and prune-eager.** Every entry cites its claim family, its consumers, and its gate. An entry whose gate never clears is removed, not pitied.
- **Steady state is roughly six members; ten is a warning.** A registry that grows past ~10 entries is a signal the definition is being diluted, not that the platform got smarter. Completeness-driven design — chartering sixteen modules because sixteen were imagined — is the exact failure the small registry prevents.

**Folded elsewhere, by ruling:** Opportunity → Financial Health · Subscription → recurrence facts + Consumer surface · Benchmark → Records (reference datasets) + Context (cohort key) + Financial Health (the comparison claim) · User → Context · Advisor → Context (conversation state) + Consumer discipline · Ambient → Delivery · Platform Operations → its own parallel plane running this same taxonomy over telemetry. **Never (recorded so they stay dead):** Location, Behavior, Time, Crypto-as-module, and any per-surface "Search/Brief/Dashboard Intelligence."

---

## 7. Infrastructure

Infrastructure is **supporting computation whose correctness is binary** — correct or buggy, never "low confidence." Canonical members: time and period math, currency conversion (MC1's `buildConversionContext` — the rates are Records, the conversion is arithmetic), normalization (`normalizeMerchantKey`), parsers (CSV and provider payloads), provider adapters, shared libraries, registries and engines (the lens engine, the assembler registry, notification machinery), and visibility predicates.

**Infrastructure owns zero financial knowledge.** The boundary is hard in both directions, and the reasons are doctrine:

1. **Infrastructure with Intelligence trappings is false precision.** A `confidence` on a period calculation or an UNKNOWN valve on a currency conversion would launder arithmetic into "judgment" and teach consumers to hedge against things that cannot be uncertain. If a conversion cannot be performed, that is a *missing Record* (no rate) surfaced as a **Coverage fact** — not low-confidence Infrastructure.
2. **Intelligence hiding in Infrastructure is unaccountable.** The CSV `mapCategory` keyword table is the cautionary tale: semantic inference (fallible — it disagrees with the Plaid dialect by construction) living in a parser, with no version, no confidence, no owner. That is Intelligence smuggled into Infrastructure, and it became a named cross-dialect defect. The fix is always to pull the semantic decision *up* into the owning module and leave the parser parsing.
3. **Different change disciplines.** Infrastructure changes are refactors — a test proves equivalence, or the behavior change is a bug fix. Intelligence changes are *re-derivations* — version bump, backfill decision, output-shift explanation. Conflating them means either paralyzed utilities or unaudited fact drift.

**Rule of thumb:** Infrastructure is allowed to be wrong only in ways a unit test can catch. The moment detecting its wrongness requires a human judgment about finances ("that's not really a transfer"), it has crossed into Intelligence and must be promoted with the full apparatus.

---

## 8. Context

Context is **canonical, declared or operational state that computation consumes but never derives.** Members: user profile, age bucket, employment, household, risk tolerance (when declared), provider capabilities, session, view preferences, feature flags, and conversation state.

**Context describes the environment. Context computes nothing.** The defining property is the direction of truth: Context is *told* to the system — by a user, an operator, or a provider — and changed by re-declaration, not by backfill.

| Item | Why it is Context | Governing rule |
|---|---|---|
| User profile / employment / age bucket / household | Declared at onboarding, not derived | Coarse enums only leave the user record; raw DOB never does — age *band* is a degenerate, non-fallible projection at one chokepoint |
| Risk tolerance | A questionnaire answer is declared | Context **iff declared**; *inferred* risk tolerance would be a (rejected) Behavior claim. A column is either declared or derived — never a blend |
| Provider capabilities | The provider catalog asserts nothing fallible | Coverage *interprets* it; the catalog itself is Context |
| Session / "View as" scope | Operational viewer state | Read-only; writers never consult an ephemeral override (the MC1 display-currency precedent) |
| View preferences | Display currency, dashboard arrangement | Governance-light; the only rule is a single definition site |
| Feature flags | Operational levers | One definition site; governed by the platform-ops lever doctrine |
| Conversation state (Advisor) | Declared by the conversation's own history via deterministic update rules | Session-scoped Context, consumed by Consumer-side serialization; owns zero financial claims |

**Why these are not Intelligence:** they cannot be *wrong about the finances* — only stale, missing, or misdeclared, and the remedy is re-asking, not re-deriving. They need no honesty valve, no confidence, no backfill semantics. **Why they still need governance:** Context has its own failure modes — duplication (two homes for "display currency" is KD-10 for Context), privacy (user Context is the most sensitive data outside ciphertext — the coarse-enum / never-raw-DOB rule is Context doctrine), and provenance-lite (declared-when, declared-by). Context gets a doctrine section, never module machinery.

---

## 9. Consumers

Consumers **select, arrange, filter, threshold-for-display, and present facts owned elsewhere, asserting nothing new about the finances.** Members: the Dashboard, all Briefs (daily/weekly/monthly are one engine parameterized by period), the Advisor serializer, Search, Notifications content, exports, and Platform Operations views.

**Consumers assemble intelligence. Consumers own zero canonical financial claims.**

What a Consumer *may* own: view logic (tone, ordering, visit-state greeting, section priority), display thresholds (presentation policy over an owned fact), scope selection (which Space, which window — via shared Infrastructure), and composition (which facts appear together). What a Consumer may *never* own: fact definitions, aggregation math, membership predicates, classification rules.

**Why Consumers must never own canonical knowledge — the platform's own history is the argument:**

1. **Consumer multiplicity guarantees divergence.** Facts computed in surfaces get computed per surface. `FLOW_COST` existed in four places because three consumers each "just needed" spend membership. KD-10's two monthly-expense figures were two consumers disagreeing inside one prompt.
2. **Consumer-owned facts are invisible to Enforcement.** The validator reconciles against owned, serialized facts; a figure a Brief computes privately is the unverifiable-figure class — structural, not incidental.
3. **Consumer-owned facts cannot be versioned or backfilled.** When a definition changes, an owned fact re-runs with a version bump and an explanation; a consumer-embedded formula changes silently between deploys — history restated without record, exactly what the MC1 rule forbids.
4. **Consumers churn fastest.** Presentation is the highest-turnover layer. Facts embedded in churning code die or fork in redesigns. Authority belongs in the slowest-changing layer that can host it.

**Enforcement mechanism:** the same import-graph tripwire the lens engine uses. A Consumer may import module contracts and Infrastructure; a Consumer defining an aggregation over raw Records is a review-blocking defect.

---

## 10. Delivery

Delivery **moves finished outputs across time and channels.** Members: the scheduler, jobs, automation, notification transport, and Ambient. **Ambient belongs here** — it is scheduling, the advice write path, brief cadence, and notification dispatch. It composes Tier-3/4 outputs on a clock.

**Delivery distributes information. It never computes intelligence.** Its disciplines are idempotence, retry, opt-out, and audit — operational, not epistemic. The proof that Delivery adds no claims is its own exit criterion: briefs delivered with *zero validator failures*. If Delivery computed anything, it could fail the validator on its own. Calling a scheduler an "intelligence module" would license it to compute — precisely what must never happen.

---

## 11. Enforcement

Enforcement **deterministically polices artifacts and boundaries.** Members: the output validator, guardrails, policies, consistency checking, invariant checks (e.g. the spending-category invariant, the flow-desync audit), rate limiting, and visibility gates.

**Enforcement is the referee, not a player.** It is named as its own category for one reason: the validator is the most important component in the system that is neither Intelligence nor Infrastructure, and leaving it unclassified invites someone to "improve" it into computing financial facts. Enforcement shares Intelligence's determinism and explainability, but it owns judgments about *artifacts* ("this reply contains an unreconciled figure"), never about finances. The referee cannot also be a player: a validator that owned facts would validate itself, and the honesty guarantee would collapse into a tautology. The validator's trajectory — from membership checking to provenance checking (§5.5) — makes it stronger *as a referee*, never as a computer of facts.

---

## 12. Provider Philosophy

**Providers adapt into Fourth Meridian. Fourth Meridian never adapts its canonical model around providers.** This is the direction of the arrow, and it never reverses. Plaid, Lean, Tarabut Gateway, future bank APIs, CSV imports, and wallets are all *sources* that must be marshaled into the canonical model at the boundary. The canonical model does not bend to match the shape of whatever the newest aggregator returns.

**Canonical normalization** is the mechanism. At the provider adapter (Infrastructure, §7), each source's payload is captured and translated into canonical Records and the inputs that Intelligence modules consume. What "captured" means is governed by the Metadata Capture Doctrine (§13.1) — capture-or-never, three classes, no speculative hoarding. The adapter's job is translation and marshaling; it is correct-or-buggy Infrastructure and it owns no financial knowledge. Semantic decisions (what a category *means*, whether a row is a transfer) are pulled *up* into the owning module, never left in the parser — the CSV `mapCategory` defect is the standing warning (§7).

Provider-specific consequences, as doctrine:

- **Plaid** is currently the one live provider. That is exactly why provider-generic abstraction is *not* built ahead of a second provider: a "provider-neutral" interface with one implementation is Plaid-shaped columns with aspirations. Record the neutral *shape* so a second provider maps into it; do not build the abstraction until the second provider is real.
- **Lean and Tarabut (GCC open banking)** will surface fields unevenly — descriptors, merchant fields, and location vary across open-banking regimes. Their differences resolve at the adapter into the same canonical model; they never fork it. Regional facts (e.g. MI catalog releases) are locale-tagged, not globally imposed.
- **Future providers** map into the canonical model at their own capture slice. A field a provider does not supply is a **Coverage fact** ("this provider cannot supply investment transactions, so absence is not absence of activity"), not a gap in the model.
- **CSV / manual imports** have no reliable dialect for most metadata; they gain a new dialect only when a real file format demands one, never speculatively.
- **Wallets / crypto** have no venue or merchant-identity concept in the card sense; an exchange's jurisdiction is account-level Context, not transaction data.

**Provider capability metadata is Context (§8); Coverage interprets it.** The catalog of what an institution *can* supply asserts nothing fallible; the interpretation of "what does absence mean here" is a Coverage claim. Provider capability never becomes an excuse to reshape canonical facts around a provider's limitations.

The MC1 precedent anchors the whole philosophy: Plaid sends a transaction currency; the sync path historically dropped it; the canonical model's answer is to capture the original and freeze a normalized reporting value — **originals are never discarded, history is never rewritten, and reporting currency stays free.** The canonical model absorbed the provider's data on the model's own terms.

---

## 13. Location

**Location is a Records-tier transaction attribute. It is not, and must never become, Location Intelligence.** Coarse, provider-supplied merchant locality is *declared by the provider, not derived by the system* — it fails the Wrongness Test in the right way (Fourth Meridian asserts nothing when storing it; it can be missing or dirty, but it is not a fallible claim the platform makes). It is a captured dimension consumers may group and filter by, and that Intelligence may someday read as *input* — never a module.

This section resolves three inconsistent predecessor statements (a pre-doctrine proposal to store coordinates; the 7A prose deny-listing only "precise" location; the shipped code deny-listing *all* location). **FI0 ratifies the boundary below and marks the coordinate proposal superseded by name.** FI0 ratifies the boundary; it does **not** recommend implementation. No column is added here. The shipped stricter posture ("all location never read") remains operative until a ratified consumer exists.

### 13.1 The privacy boundary

The governing security model is **"if it is never stored, it can never leak."** The honest privacy fact is that *row-coarse is not stream-coarse*: no single city-stamped card-present row is sensitive, but a corpus of them reconstructs travel history, routine, and effectively a home city. Therefore any future coarse-locality capture is conditioned on: **FULL-visibility gating**, **exclusion from AI context by default** (a specific row's city may appear only in explicit single-transaction drilldown, if ever), **exclusion from telemetry always** (a city string in a telemetry row is a KD-1-class defect), and **exclusion from any benchmark/cohort computation** (geography as a cohort key is re-identification fuel). Only provider-supplied values may ever be stored; nothing location-like is ever inferred.

### 13.2 The three-band taxonomy (amends 7A)

The single "precise location" deny-list entry is replaced by three bands plus a use-level rule:

- **L1 — Coarse venue locality (`city`, `region`, `country`): conditionally capturable.** Becomes a durable fact only when a ratified consumer names it. Provider-supplied only; forward-only; FULL-gated; excluded from AI context, telemetry, and cohort computation by default. Country normalizes to ISO-3166-1 alpha-2 at capture; city/region are stored as received (no normalization layer — that is a gazetteer rat-hole).
- **L2 — Fine locality (`postal_code`): default-deny.** Admissible only by a dedicated privacy review proving a consumer that city/region cannot serve. It is a classic quasi-identifier and its grouping value is dominated by city/region.
- **L3 — Precise venue (`address`, `store_number`, `lat`, `lon`): never captured.** Unchanged. No product surface in a deterministic finance platform needs a map pin of a user's physical movements.

### 13.3 The inference ban (use-level, L4)

**No stored location value may feed home/work/commute/travel/routine inference, behavioral geofencing, or any LLM-derived location claim.** This rule binds *consumers*, not just capture: a compliant `merchantLocationCity` column that some later heuristic reads to infer "the user's home city" violates this doctrine. Inference is where an attribute becomes a behavioral claim — the exact content of the rejected Location module. A Location module with the bans applied owns an *empty* claim family, which is the definition of a module that must not exist. The rejection is recorded with its promotion bar (a distinct reusable family of location claims, two ratified consumers, computable without the banned inferences, and not fitting as a Transaction facet) so that it is an auditable decision, not a taboo — a bar realistically never met, and that is fine.

---

## 14. Module Lifecycle

**Start broad. Split only when responsibilities naturally diverge. Avoid premature specialization.** A module is born owning a broad claim family and is subdivided only when the sub-families acquire genuinely different owners, privacy boundaries, or change disciplines. Specializing early manufactures the duplication the platform exists to prevent, because two thin modules re-derive the shared substrate with slightly different keys.

**The canonical example — Crypto inside Investment.** Crypto exposure, staking yield, and stablecoin allocation are *asset-class dimensions of the portfolio*, not a separate intelligence domain: the questions (concentration, exposure, yield) are the same lens math with a crypto taxonomy. Standing up a separate Crypto module would duplicate every allocation computation under slightly different grouping keys. Crypto therefore lives as a *dimension* inside Investment, and is unparked into its own module only if crypto-specific facts (protocol risk, staking mechanics) ever demonstrably fail to fit the portfolio lens shape — and only once a crypto data substrate actually exists.

Other applications of the same law:

- **Subscriptions inside recurrence.** "Subscription Intelligence" is not a peer module; it is the recurrence relational fact plus consumers. Build the recurrence pass once; ship "subscriptions" as its first Consumer surface. The price-increase comparator and renewal-window calculator are a read predicate and an Infrastructure date calc, not a new authority.
- **Income inside Cash.** Income completeness and paycheck cadence are Cash's first-class half, named explicitly in Cash's charter so income is not a perpetually-implicit dependency — not a separate Income module.
- **Financial Health decomposition, in the right direction.** The one place splitting is correct is *maturity-driven*: as Cash and Investment mature, Financial Health *consumes their cores* instead of keeping private copies. That is responsibilities diverging after they were proven, decomposed section-by-section with byte-comparison harnesses — never a big-bang, never speculative.
- **The three-layer Merchant.** Merchant is one module whose internal layers (global identity, the user's private relationship, per-Space context) have three owners and three privacy boundaries — a split that was *earned* by real divergence, not imposed up front. Category is a property of the user's *relationship* with a merchant, not of the merchant; that distinction emerged from the correction experience, and the module structure followed it.

The lifecycle rule and the registry rule (§6.3) are the same instinct from two directions: extend before you split, and split only on proven divergence.

---

## 15. Ownership

**One authority per claim. Forever.** This is the strongest principle in the doctrine, and it is deliberately stated more strongly than the intuitive alternatives.

**Why "one authority per claim" beats ownership by feature, module, or table:**

- **Ownership by *feature* drifts** because features multiply and each new feature "just needs" the fact, so it recomputes it — the `FLOW_COST`-in-four-places mechanism. Claims outlive features.
- **Ownership by *module* is close but too coarse** — it permits a module to hold two definition sites for the same claim internally, or two modules to each hold "their own" copy of a shared claim. The unit of ownership is the *claim*, not the module that happens to host it.
- **Ownership by *table* confuses storage with authority** — a fact may be persisted in one table, recomputed at read from another, or not persisted at all; the authority is the single *definition site*, independent of where (or whether) the value lands in a database.

The rule, precisely: **every named claim has exactly one definition site, named in the registry, forever; a second computation site for an existing claim is a review-blocking defect regardless of where it appears — module, consumer, script, or prompt.**

How it binds the concrete systems:

- **FlowType** is the sole `flowType` authority. Transaction Intelligence generalizes it but never forks it; nothing else classifies flow.
- **Merchant Intelligence** owns merchant identity and category provenance; Transaction Intelligence never writes `category` or `merchantId`, and Merchant never writes `flowType`. The shared row is governed by one rewrite helper: a category change re-stamps every category-dependent fact through a single path, so category, flow, and dependent facts can never desync.
- **Coverage** owns every data-sufficiency judgment — completeness, month reliability, estimation provenance — so that "confidence" fields elsewhere have one honest source rather than a dozen scattered flags.
- **Financial Health** owns cross-domain assessment only; as sibling modules mature it consumes their cores rather than keeping private copies (§14).
- **The Validator** owns judgments about artifacts and *no financial claim at all* (§11) — ownership discipline is what lets it stay a referee.

Single ownership is what makes cross-surface consistency structural rather than aspirational: chat, brief, and dashboard agree because they all read the one authority, not because three code paths were carefully kept in sync.

---

## 16. Anti-patterns

Named so they are recognizable in a pull request. Each is a violation of a principle above; each has drawn blood in this codebase or in the class of products Fourth Meridian refuses to be.

- **Duplicate computations.** The same fact computed in more than one place. The entire re-derivation defect class (KD-10, KD-11, KD-17, the four `FLOW_COST` copies). Violates Compute Once and Single Ownership.
- **Consumers owning facts.** A dashboard, brief, or serializer computing a figure instead of reading one. Invisible to Enforcement, un-versionable, and guaranteed to diverge across surfaces (§9).
- **Infrastructure owning intelligence.** A semantic decision (a category map, a transfer guess) hiding in a parser or utility with no version, no confidence, no owner — the CSV `mapCategory` cautionary tale (§7).
- **Too many intelligence modules.** Completeness-driven chartering — naming sixteen modules because sixteen were imagined. A registry past ~10 entries signals dilution, not sophistication (§6.3).
- **LLMs becoming canonical.** Any design where a model's output becomes a fact other code reads. The model narrates; it never becomes the authority (§1).
- **Speculative schema.** Adding columns or tables because they *might* be useful someday. Violates the capture-or-never rule; the coarse-location HOLD (§13) is the worked example of resisting it.
- **Provider-driven architecture.** Reshaping the canonical model around whatever a provider returns, or building a generic provider abstraction before a second provider exists. Providers adapt to Fourth Meridian, never the reverse (§12).
- **Behavior inference without doctrine.** Minting unfalsifiable psychographic labels ("what kind of spender you are") that no fact backs and no honesty valve can gate. The rejected Behavior module (§4.5).
- **Location tracking.** Storing precise location, or inferring home/work/commute/travel from any location value. Violates the L3 never-band and the L4 use-level inference ban (§13).
- **Premature specialization.** Splitting a module before responsibilities diverge — two thin modules re-deriving a shared substrate. Extend before you split (§14).
- **Architectural drift.** The slow accumulation of all of the above: a second figure here, a consumer-owned aggregate there, a confidence field on a utility, a provider field captured "just in case." Drift is prevented by running every proposal through the Wrongness Test (§4) *before* it is built, not by cleanup after.
- **Confidence theater.** A `confidence` field reflexively stamped `HIGH`, or added to Infrastructure that cannot be uncertain. Confidence must mean something or it must not exist (§5.4).
- **Persistence creep.** Persisting cheap, read-time-computable aggregates and inheriting staleness and invalidation machinery for no benefit. Persist per fact, for a named reason (§5.10).

---

## 17. North-Star Principles

The doctrine, compressed to what a future proposal is measured against. If a proposal violates one of these, it is wrong until proven otherwise.

1. **Financial Intelligence is deterministic knowledge; AI consumes it.** The model narrates and never becomes canonical.
2. **Compute once — one definition site.** Not one per surface, per request, or per redesign. Not necessarily one execution.
3. **Reuse everywhere.** No consumer re-derives a fact it could read. A second computation is a defect.
4. **One authority per claim. Forever.** Stronger than ownership by feature, module, or table.
5. **Every claim carries provenance and a version.** "Why is this number what it is" and "why did it change" are always answerable.
6. **Honesty is a feature.** Insufficient signal yields UNKNOWN, null, or absence — never a fabricated fact. Hardest on scores and forecasts, not softest.
7. **Determinism first.** Same inputs plus injected clock yield byte-identical output. No LLM computes a fact, anywhere.
8. **The Wrongness Test is the first question.** Could it be wrong about the finances with bug-free code? Yes → Intelligence, with the full apparatus. No → it is Records, Context, a Consumer, Delivery, Enforcement, or Infrastructure — and must not be called Intelligence.
9. **Six categories, one substrate.** Records, Intelligence, Infrastructure, Context, Consumers, Delivery, Enforcement. Every component belongs to exactly one.
10. **Intelligence needs seven properties at birth.** Fallible derivation, single authority, deterministic pure core, honesty valve, machine-readable explanation, provenance, reusable typed contract — plus confidence or completeness. Missing one means it is not a module.
11. **Persistence is a per-fact decision, never a definition of Intelligence.** Persist for backfill economics, expensive recompute, or cross-time comparability; otherwise recompute at read.
12. **Modules earn their existence; the registry stays small and prune-eager.** New claims default into existing modules. Extend before you split. Roughly six members; ten is a warning.
13. **Infrastructure owns zero financial knowledge; it may be wrong only where a unit test can catch it.** A missing capability is a Coverage fact, never a hedge.
14. **Context is declared, never derived; Consumers present, never compute; Delivery moves, never computes; Enforcement referees, never plays.**
15. **Providers adapt into Fourth Meridian; the canonical model never bends to a provider.** Originals are never discarded; history is never rewritten.
16. **Location is a Records attribute, never a module; nothing is ever inferred from it.** Capture-or-never governs all metadata: never store because it *might* be useful someday.
17. **Initiative names and registry membership are separate namespaces.** A track may be called anything; the registry admits only what passes the Wrongness Test.

---

*End of FI0. This is doctrine. Future Financial Intelligence work references it; future proposals are measured against §17. No code, schema, or STATUS.md was modified in its ratification.*
