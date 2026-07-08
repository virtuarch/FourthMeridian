> **INVESTIGATION ONLY — no code, no schema, no migrations, no STATUS.md changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# What Deserves to Be Called Intelligence? — Boundary Definition Investigation

**Date:** 2026-07-08
**Status:** Investigation complete — definitional/doctrinal recommendation only, no implementation.
**Predecessor:** `FINANCIAL_INTELLIGENCE_ARCHITECTURE_INVESTIGATION_2026-07-08.md` (the umbrella investigation). That document proposed the four-tier model and pruned sixteen candidates to ~six; this one derives the *definition* that makes the pruning principled and repeatable.
**Question:** What characteristics distinguish an Intelligence module from Infrastructure, Context, Consumers, Delivery, and everything else — stated precisely enough that future initiatives classify objectively, not by intuition or by whether "Intelligence" sounds good in the name.
**New evidence since the predecessor:** `lib/transactions/RelationshipResolver.ts` — per the **ratified TI4 decision**, transaction relationships (pending↔posted, duplicates) are **not persisted**; they are resolved at read time by a pure, zero-import module. This is load-bearing for the definition: it proves persistence is not what makes something intelligence.
**Sources:** `lib/transactions/{flow-classifier,transaction-facts,RelationshipResolver,merchant-resolver,merchant-corrections}.ts` · `lib/ai/intelligence/annotations.ts` · `lib/ai/{output-validator,context-builder}.ts` · `lib/perspective-engine/` (README + `types.ts`) · `lib/brief-types.ts` · `lib/notifications/` · `prisma/schema.prisma` · `docs/initiatives/{ai5,platops,mi1}/` · the predecessor investigation.

---

## 0. Executive summary

**Definition (one sentence):** *An Intelligence module is the sole, versioned, deterministic authority for a named family of derived financial claims — statements about financial reality that are not present in the raw records, that could therefore be wrong, and that consequently must carry provenance, an honesty valve, and (where inference is fallible) confidence — exposed as typed, reusable outputs.*

The discriminating property is **fallible semantic derivation**: intelligence *asserts* something the records do not say ("this row is one leg of a transfer," "your runway is 3.2 months," "these two merchants are the same brand"). Because the assertion could be wrong, the module needs the whole honesty apparatus — UNKNOWN valves, confidence, provenance, versioned re-runs. Everything else in the system either **cannot be wrong in that sense** (Infrastructure — a period calculation is correct or buggy, never "low confidence"), **is declared rather than derived** (Context — employment status is told to us, not inferred), **arranges facts without asserting new ones** (Consumers), **moves outputs on a schedule** (Delivery), or **polices outputs** (Enforcement — the validator).

The litmus test that makes the whole taxonomy fall out: **"Could this component's output be *wrong about the user's finances* while the code is bug-free?"** If yes → intelligence, with everything that entails. If no → it is something else, and giving it the Intelligence name only dilutes the doctrine.

Applying the definition to all 31 candidates (§4): **four intelligence modules exist or are justified today** (Transaction, Merchant, Financial Health, Coverage), **five are legitimate future intelligence** (Cash, Investment, Receipt, Forecast, Tax), and **the other twenty-two are Infrastructure, Context, Consumers, Delivery, Enforcement, sub-components, or should not exist.** Coverage Intelligence is confirmed and *promoted* relative to the predecessor investigation: it is a first-class module, not shared infrastructure (§5). Context is confirmed as a real architectural category (§6). The registry stays at four core + five gated-future entries (§10), and the closing rules (§11) are drafted as doctrine input.

---

## 1. The definition, derived

### 1.1 Method: test each proposed characteristic against shipped code

The nine characteristics in the brief, tested against the systems that already work (FlowType, MI, `computeAssessment`, lenses, RelationshipResolver) and the ones that failed or were rejected (KD-10's duplicated figure, Behavior, Location):

| Characteristic | Verdict | Evidence |
|---|---|---|
| Computes **durable** financial knowledge | **Required — but "durable" means canonical and reproducible, NOT persisted.** | The ratified TI4 decision is dispositive: RelationshipResolver computes real intelligence (pending↔posted identity, duplicate identity) at read time, pure, unpersisted — because the facts are "cheap to recompute" explanation context. FlowType persists because backfill economics and write-path stamping demand it. Persistence is an *engineering decision per fact* (recompute cost × consumer count × invalidation complexity); authority is the architectural requirement. |
| **Owns canonical facts** | **Required.** The single-authority rule is the whole point. | Every defect in the KD register's re-derivation class (KD-10, KD-11, KD-17, the four `FLOW_COST` copies) is a fact with two owners. `classifyFlow` as "the single classification entry point" is the corrected pattern. A module that computes facts someone else owns is not a module; it is a bug with a roadmap. |
| Derives from **multiple sources** | **Not required. Not even a good signal.** | `flowType` derives substantially from one row plus its payload — and is the kernel of the entire architecture. Meanwhile the Daily Brief reads *everything* and owns nothing. Source count measures plumbing, not intelligence. Drop this criterion entirely. |
| Exposes **reusable outputs** | **Required.** Typed contracts, ≥1 consumer beyond its own surface (or designed for it). | The house pattern: `LensResult`, `TransactionFactFields`, `FinancialAssessment` — typed shapes consumed by UI, AI serializer, Brief. A computation used by exactly one surface, forever, is that surface's private logic (Consumer-internal), not a module. |
| **Deterministic** | **Required — but not distinguishing.** | Everything in Fourth Meridian must be deterministic (lenses byte-identical under injected clock; validator pure; even Brief composition). Determinism is the platform's constitution, not intelligence's badge. An LLM-computed "fact" is banned everywhere, not just in modules. |
| **Explainable** | **Required.** Machine reason + traceable inputs. | `classificationReason` (a stable machine enum, not prose), lens provenance (contributing account ids, `dataAsOf`), assessment evidence types (`CapitalAllocationEvidence`). If "why is this number what it is" cannot be answered mechanically, the claim is not trustworthy enough to serialize to an LLM or a user. |
| **Versioned** | **Required.** | `FLOW_CLASSIFIER_VERSION`, `tiFactsVersion`, `lensVersion` — versioning is what makes claims *correctable at scale* (selective backfill; "why did my number change" answerable). Note the two flavors: fact modules version *rows* (backfill gating); aggregate modules version *math* (output comparability). Both are the same discipline. |
| Has **confidence** | **Conditionally required:** wherever the derivation is fallible inference; degenerate where it is arithmetic. | `classificationConfidence` matters (PFC hint vs sign-default produce different certainty). But a lens summing FULL-visibility balances is not "confident" — it is *complete or incomplete*, which is why lenses carry completeness/assumptions instead. Rule: **confidence where the module might be wrong; completeness where the inputs might be missing.** A module needing neither is probably infrastructure. |
| Has **provenance** | **Required.** Subsumes explainability's data half: which inputs, which visibility tiers, what freshness, which fact versions. | Lens provenance blocks; MC1's "no converted columns, snapshots stamped" doctrine; `categorySource`/`categoryRuleId`. Provenance is also the precondition for upgrading the KD-2 validator from membership to provenance checking. |

### 1.2 The definition

**Required (all seven):**

1. **Fallible semantic derivation** — produces claims about financial reality not present in the records, which could be wrong even with bug-free code.
2. **Canonical ownership** — the sole authority for that named family of claims; no second definition site anywhere.
3. **Deterministic pure core** — same inputs (+ injected clock) → identical output; no LLM, no I/O in the core.
4. **Honesty valve** — insufficient signal degrades to UNKNOWN/null/absent, never a fabricated claim; estimates always labeled.
5. **Explainability** — machine reasons, not prose, for every claim.
6. **Provenance** — inputs, freshness, visibility tiers, and consumed fact-versions carried with outputs.
7. **Reusable typed contract** — published outputs designed for multiple consumers.

**Conditional:** confidence (required iff inference is fallible; replaced by completeness where the risk is missing inputs).

**Explicitly optional:** persistence (per-fact engineering decision — the TI4/RelationshipResolver precedent); multi-source derivation; batch vs read-time computation; whether outputs are row facts or aggregates.

**Explicitly insufficient (each alone proves nothing):** computing something (infrastructure computes); reading many sources (consumers do); being deterministic (everything is); being important (the Brief is important; it is still a consumer); having "Intelligence" in an initiative name (Advisor, Ambient — see §4).

### 1.3 The litmus tests (fast form)

- **The Wrongness Test:** could it be wrong about the finances with bug-free code? → Intelligence. Only wrong via bugs? → Infrastructure. Wrong only if the *user* misspoke? → Context.
- **The Second-Consumer Test:** would a second consumer of this logic need it byte-identical? If yes and it lives inside a surface today, it is intelligence trapped in a consumer (the KD-10 birth defect).
- **The Confidence Smell:** if you feel the urge to add a `confidence` field to a utility, it has become intelligence and must be promoted — or the urge is wrong and should be resisted. Infrastructure with confidence is a category error in either direction.

---

## 2. The full taxonomy

Six categories plus the substrate, each with a one-line contract:

| Category | Contract | Canonical examples |
|---|---|---|
| **Records** (substrate) | Immutable/append-only stored reality; asserts nothing beyond "this was captured." | Transaction rows, Holding, FxRate archive, SpaceSnapshot (frozen computed facts adopt Records discipline once written), captured provider metadata |
| **Intelligence** | Sole versioned authority for fallible derived financial claims (§1.2). | TI (FlowType + facts + relationships), MI, Financial Health, Coverage |
| **Infrastructure** | Correct-or-buggy supporting computation and plumbing; no semantic claims, no confidence, code-versioned only. | period math, currency conversion context, normalization, parsing, registries/engines, visibility predicates |
| **Context** | Declared or operational state consumed by computation; told, not inferred; changed by the user/operator, not by backfill. | user profile, provider capabilities, session, preferences, flags |
| **Consumers** | Select, arrange, filter, and present owned facts; assert nothing new about the finances. | Dashboard, Briefs, search, AI serializer, admin console |
| **Delivery** | Move finished outputs across time and channels. | scheduler, notifications, email, Ambient |
| **Enforcement** | Deterministically police boundaries and outputs; owns judgments about *artifacts*, not about finances. | output validator, rate limiter, visibility gates, invariant checks |

Two deliberate subtleties. **SpaceSnapshot** sits between Records and Intelligence: its *computation* is intelligence-adjacent (an aggregate with provenance and `isEstimated`), but once written it is a Record — frozen, never restated. Classify the snapshot *table* as Records and its *computation* as owned by the relevant aggregate module. **Engines vs their content:** the Perspective Engine (registry, shaping, `validateLensResult`) is Infrastructure; each lens core is Intelligence owned by a domain module. The engine cannot be wrong about finances; a lens can. This split recurs (assembler registry vs assemblers; notification machinery vs the facts notifications carry) and should be doctrine.

---

## 3. The decision tree

```
START: a proposed component / initiative / "X Intelligence" idea
│
1. Does it produce CLAIMS about financial reality that are not
   present in the stored records — claims that could be wrong
   even if the code is bug-free?
│
├─ NO ──► 2. Is its content DECLARED by a user/operator/provider
│            rather than computed?
│         ├─ YES ──► CONTEXT  (canonical single definition site,
│         │                    coarse enums, privacy-gated)
│         └─ NO ──► 3. Does it SELECT/ARRANGE/PRESENT facts owned
│                      elsewhere?
│                   ├─ YES ──► CONSUMER  (may hold view logic;
│                   │                     may never define a fact)
│                   └─ NO ──► 4. Does it MOVE or SCHEDULE finished
│                               outputs?
│                            ├─ YES ──► DELIVERY
│                            └─ NO ──► 5. Does it POLICE outputs or
│                                        boundaries?
│                                     ├─ YES ──► ENFORCEMENT
│                                     └─ NO ──► INFRASTRUCTURE
│                                               (correct-or-buggy
│                                                supporting code)
│
└─ YES ─► 6. Does another module already own this family of claims?
          ├─ YES ──► NOT A MODULE. It is either a new FACET of the
          │          owning module (extend it) or a duplicate
          │          definition site (kill it).
          └─ NO ──► 7. Will (or should) more than one consumer read
                       these claims through a typed contract?
                    ├─ NO ──► CONSUMER-INTERNAL logic for now.
                    │         Record it; promote when the second
                    │         consumer appears (and then move the
                    │         code, don't copy it).
                    └─ YES ─► 8. Can it satisfy all seven §1.2
                                 requirements (pure core, honesty
                                 valve, machine reasons, provenance,
                                 versioning, typed contract)?
                              ├─ NO ──► NOT READY. It is a wish,
                              │         not a module. (Behavior
                              │         Intelligence dies here.)
                              └─ YES ─► INTELLIGENCE MODULE.
                                        Ratify: name, owned-claim
                                        family, tier (fact vs
                                        aggregate), persist-vs-
                                        recompute per fact, and its
                                        place in the DAG.
```

Persistence is decided *inside* step 8 per fact, never at the category level: persist when (recompute cost is high) ∨ (write-path stamping enables backfill economics) ∨ (consumers need cross-time comparability); recompute when facts are cheap, explanation-scoped, and invalidation would be harder than recomputation (the ratified TI4 posture).

---

## 4. Every candidate, classified

| # | Candidate | Classification | One-line justification |
|---|---|---|---|
| 1 | Transaction Intelligence | **Intelligence** (fact module — core) | Fallible claims ("this is a transfer," "posted," "duplicate of") with the full apparatus; the kernel. |
| 2 | Merchant Intelligence | **Intelligence** (fact module — core) | Identity resolution is fallible inference (WGU cluster proved it); owns merchant/category claims + provenance. |
| 3 | Cash Intelligence | **Intelligence** (aggregate — future) | Runway/cadence/volatility are fallible derived claims; gated on recurrence facts. |
| 4 | Investment Intelligence | **Intelligence** (aggregate — future) | Allocation/concentration claims; classification of holdings is fallible (sector/asset-class). |
| 5 | Receipt Intelligence | **Intelligence** (fact module — future, gated) | Receipt↔transaction matching is fallible inference over a new Records substrate; consumes TI/MI. |
| 6 | Financial Health | **Intelligence** (aggregate — core; = `computeAssessment`) | Exists; classifications (debt health, deficit cause) are fallible claims with confidence/completeness. |
| 7 | Coverage Intelligence | **Intelligence** (epistemic module — core; promoted) | See §5. Claims about what the data can support are themselves fallible derived claims. |
| 8 | Opportunity Intelligence | **Fold into Financial Health** | Opportunities/risks are Health's signal output (`RiskOpportunitySection` already lives there); a standalone module would co-own Health's claims. External offers: business-gated, out of scope. |
| 9 | Tax Intelligence | **Intelligence** (aggregate — future, counsel-gated) | Deductibility flagging is fallible semantic derivation; postponed per predecessor (liability, jurisdiction data, lot model). |
| 10 | Forecast Intelligence | **Intelligence** (aggregate — future) | Projections are the *most* fallible claims of all — which is why they belong under the contract (labeled assumptions, honesty bands), not outside it. Gated on recurrence + Cash. |
| 11 | Subscription Intelligence | **Facet of TI/MI recurrence + Consumers** | The claim family (recurrence groups, cadence, price increase) belongs to the recurrence fact work (ownership set at TI0); "Subscriptions" is a surface + notification consumer of it. Fails tree step 6 as a module. |
| 12 | Benchmark Intelligence | **Records + Context key + a Health input** — not a module now | External reference datasets are Records (FxRate idiom); the cohort key is Context (§6); the comparison sentence is a Financial Health claim. Internal cohort aggregation post-scale *might* justify a small module; today it fails step 7 (no consumers, no data). |
| 13 | Location Intelligence | **Should never exist** | Would be intelligence by shape, but its inputs sit on the ratified 7A Never-Captured deny-list. A module whose substrate is banned is not postponed — it is rejected. |
| 14 | Crypto Intelligence | **Dimension of Investment Intelligence** | Same claim family (exposure, concentration, yield) with a crypto grouping key; separate module = duplicate authority. Also: no substrate (`sync-crypto.ts` = `export {}`). |
| 15 | Behavior Intelligence | **Should never exist (a label, not a module)** | Every concrete claim already has an owner (trends→Health, cadence→recurrence, paycheck→Cash); the residue is unfalsifiable psychography that cannot pass step 8's honesty-valve requirement. |
| 16 | User Intelligence | **Context** | Age band, employment, household, goals are *declared*, not derived — they fail step 1. Deriving them (inferring employment from payroll rows) is possible but is a different, unratified intelligence claim; the declared tier is Context, full stop. |
| 17 | Time Intelligence | **Infrastructure** | Period math cannot be wrong about finances, only buggy. No honesty valve is coherent for "what is Q3." Extract `lib/periods`; never a module. |
| 18 | Advisor Intelligence (AI-5) | **Context (conversation state) + Consumer behavior** | Its charter says it: a deterministic conversation-state layer consumed by the context builder — active window, entities, disclosed caveats. That is session-scoped Context plus serializer (Consumer) discipline. Fine as an *initiative* name; wrong as a registry entry — it owns zero financial claims by design. |
| 19 | Ambient Intelligence | **Delivery** | Scheduler, AiAdvice write path, brief cadence, notifications. Its exit criteria depend on it computing *nothing*. Keep the milestone name; keep it out of the registry. |
| 20 | Platform Operations | **A parallel plane, not a member** | PO1 reruns this entire taxonomy against the platform itself (telemetry=Records, rollups=facts, Ops Brief=Consumer). It consumes telemetry shadows, never product facts. Same doctrine, separate data plane, separate registry. |
| 21 | Search | **Consumer** | Filters and ranks owned facts (TI facets become facet dimensions); asserts nothing. A relevance model, if ever built, would be Infrastructure serving a Consumer — still not financial claims. |
| 22 | Daily Brief | **Consumer (+ Delivery when scheduled)** | Selects/composes owned facts by visit state; tone/priority logic is view logic. The moment a Brief computes a figure, KD-10 is reborn. |
| 23 | Weekly Brief | **Consumer — same component as Daily** | Period is a parameter (Infrastructure `lib/periods`), not a product line. Do not build three briefs; build one brief engine parameterized by period and cadence-delivered by Ambient. |
| 24 | Monthly Brief | **Consumer — same component** | As above. |
| 25 | Dashboard | **Consumer** | The settled Space→Template→Sections→Widgets doctrine is pure presentation composition. |
| 26 | Notifications | **Delivery** | Channels, preferences, retry (`lib/notifications/`) move facts; the facts they carry are owned upstream. |
| 27 | Validator | **Enforcement** | Deterministic and pure, but its claims are about *artifacts* ("this reply contains an unreconciled figure"), not about finances. A distinct category worth naming — the honesty brand's police force, alongside rate limiting and visibility gates. |
| 28 | Provider adapters | **Infrastructure (+ Context)** | Capture/marshal at the boundary (`plaid-flow-input`, CSV import); correct-or-buggy. Provider *capability* metadata (what an institution can supply) is Context that Coverage consumes. |
| 29 | FlowType | **Facet of Transaction Intelligence** | Real intelligence, but not a registry entry — it is TI's kernel facet, formally adopted as such by the TI investigation. Registry lists modules, not facets. |
| 30 | RelationshipResolver | **Component of Transaction Intelligence** | Read-time resolution of TI's relational claims. Its existence settles the persistence question (§1.1); it is TI's code, not a sibling. |
| 31 | Lens Engine | **Infrastructure; lenses are Intelligence** | Registry/shaping/`validateLensResult` cannot be wrong about finances. Each lens core is an aggregate-module output — liquidity lens belongs to Cash (future), debt lens to Financial Health/debt domain. The engine is how Tier-3 intelligence is *served*, not intelligence itself. |
| 32 | `computeAssessment()` | **Intelligence — the current body of Financial Health** | A function, not a module name; the registry entry is Financial Health, currently implemented as this 2,098-line artifact (decomposition per predecessor §4.12). |

The pattern across all 32: **initiative names and registry membership are different namespaces.** AI-5 and v2.6b keep their "Intelligence" names as initiatives; the registry admits only components that pass the tree. This must be said explicitly in the doctrine or the ledger will silently become the registry.

---

## 5. Coverage Intelligence — the deep dive

### 5.1 Is it intelligence at all?

The skeptical case first: much of coverage looks like *measurement*, not interpretation. History depth is `MIN(date)`. Staleness is `now − lastSyncedAt`. Those are correct-or-buggy — Infrastructure by the Wrongness Test.

The skeptical case fails at the module's actual center of gravity. The valuable coverage outputs are **fallible epistemic claims**: *"income data is complete enough to state a savings rate"* (KD-10's `reliableMonths` — a judgment with a threshold that could be wrong); *"this month is reliable"* (complete AND non-truncated — a claim, proven by the fact KD-7 existed because the naive version of it was wrong); *"this balance history segment is estimated"* (D2.x `isEstimated` — reconstruction quality is an inference); *"an account appears to be missing from this Space"* (pure inference from transfer legs pointing at unlinked accounts); *"this provider cannot supply investment transactions, so absence of data is not absence of activity"* (interpretation of Context against Records). These can be wrong with bug-free code. Coverage is intelligence — specifically **epistemic intelligence: claims about what the data can support, rather than about the finances themselves.**

The mechanical measurements ride along not because they are intelligence individually but because consumers need **one coverage answer per scope**, and splitting "measured" from "judged" coverage across two components would recreate the scattered-flag status quo the module exists to fix.

### 5.2 What it would own

Current scattered homes, unified: `DataQualitySection` (annotations), `reliableMonths` + `truncated`/`coverageStartDate` (KD-7/KD-10), `isEstimated` (D2.x snapshots), `SyncIssue` reads, `historyPending`/sync status, lens `dataAsOf` and completeness inputs, and the D2.x-deferred "snapshot quality column, AI/Brief sync-health consumption."

Owned claim families (per account and rolled to Space): **history depth & continuity** (observed start, gaps, truncation); **freshness** (staleness class per account/snapshot, oldest-input freshness for any aggregate); **estimation provenance** (which ranges are reconstructed, at what quality); **completeness judgments** (income completeness, month reliability, category-population sufficiency); **provider capability shadowing** (Context-supplied limits interpreted into "what absence means here"); **structural gaps** (missing-account inference, partial imports via ImportBatch outcomes). Mostly Tier-3 compute-on-read from Records + Context; a small persisted portion where history is needed (estimation provenance already persists as `isEstimated`; staleness events may ride telemetry).

### 5.3 Who consumes it

Everyone — which is precisely the promotion argument: **every Tier-3 module's** completeness/confidence inputs (Cash runway must know income completeness; Health already embeds `DataQualitySection`); **AI-5 WS-3** (confidence propagation is *literally* "coverage facts reach every derived metric's prompt block or suppress it"); **the serializer** (COVERAGE LIMIT caveats, estimation disclosures — currently ad hoc per KD); **the Brief** ("Chase history may be incomplete" — the named D2.x deferral); **lenses** (`dataAsOf`, per-tier counts); **the transaction detail surface**; **the validator's future provenance mode** (a figure's trustworthiness includes its coverage); **onboarding/progressive-reveal** (D2.x's contract is a coverage state machine in disguise); **PO1** (aggregate coverage health as telemetry shadow — fleet-level "sync degrading," never per-user finances).

### 5.4 Verdict and importance

**First-class module — yes, and this investigation upgrades the predecessor's classification** (which hedged it as "shared Tier-3 infrastructure, not user-facing"). The hedge was wrong by this document's own tests: coverage makes fallible claims (Wrongness Test passes), needs the honesty valve (an over-claimed completeness is exactly a fabrication), needs versioning (reliability thresholds will be tuned; consumers must know which judgment version produced a caveat), and has a dozen consumers (Second-Consumer Test passes at maximum strength). What it is *not* is user-facing product — its surface is disclosures inside other surfaces. Intelligence does not require its own screen.

**Importance: highest of anything not yet built.** The platform's differentiation is honesty; honesty is computed; coverage is the computation. Every KD in the honesty class (KD-7, KD-10, KD-16's disclosure half, KD-17's reachability findings) was a coverage fact missing a home. It is also the cheapest core module — mostly adoption and unification of shipped flags, no new substrate. Sequencing: alongside AI-5 WS-3 (which is otherwise forced to build a private version of it), before Cash (which cannot state runway honestly without it).

Name check: "Coverage Intelligence" is acceptable; **"Coverage" alone is better in the registry** (the claims are about coverage; adding "Intelligence" to every entry is noise — see §10's naming note).

---

## 6. Context as an architectural category

**Yes — Context should become a named category**, and it is the piece the predecessor investigation under-specified. Definition: **canonical, declared or operational state that computation consumes but never derives.** The defining property is the *source of truth direction*: Context is told to the system (by user, operator, or provider) and changed by re-declaration; Intelligence is derived by the system and changed by re-computation/backfill. Asking "what version of the classifier produced this?" makes sense; asking "what version of the classifier produced your employment status?" is absurd — that absurdity is the category boundary.

| Item | Context? | Notes |
|---|---|---|
| User profile / employment / age bucket / household | **Yes — user Context** | Declared enums exist (`EmploymentStatus`, `UseCase`). Age *bucket* is a borderline case done right: a trivial, non-fallible projection of encrypted DOB at one chokepoint — derivation so degenerate it stays Context (no confidence is coherent for it). |
| Risk tolerance | **Yes, iff declared** | A questionnaire answer is Context. *Inferred* risk tolerance from behavior would be an intelligence claim — one this investigation rejects with Behavior Intelligence. Do not blur the two in one field: a column must be either declared or derived, never "whichever we had." |
| Provider metadata / capabilities | **Yes — platform Context** | `ProviderCatalog` (D6) is exactly this. Coverage *interprets* it; the catalog itself asserts nothing fallible. |
| Session | **Yes — operational Context** | Viewer identity, Space scope, "View as" override (MC1's ephemeral override is a clean precedent: read-only, writers never consult it). |
| View preferences | **Yes — but consumer-adjacent** | Display currency, dashboard arrangement. Governance-light; the only rule is single definition site. |
| Feature flags | **Yes — operational Context** | `PlatformSetting` + env flags. PO1's lever doctrine governs them. |
| Conversation state (AI-5) | **Yes — session-scoped Context** | The predecessor placed Advisor beside the serializer; this refines it: the state object is Context (declared by the conversation's own history via deterministic update rules), consumed by Consumer-side serialization. |

**Why these are not intelligence:** they cannot be *wrong about the finances* — they can only be stale, missing, or misdeclared, and the remedy is re-asking, not re-deriving. They need no honesty valve (absence is just absence), no confidence, no backfill semantics. **Why they still need governance:** Context has its own failure modes — duplication (two homes for "display currency" would be KD-10-for-context), privacy (user Context is the most sensitive data outside ciphertext; the coarse-enum/never-raw-DOB rule from the predecessor §4.4 is Context doctrine), and provenance-lite (declared-when, declared-by). Context deserves a section in the doctrine, not module machinery.

---

## 7. Infrastructure — what it is and why it must never be intelligence

Definition: **supporting computation whose correctness is binary.** Period math, currency conversion (MC1's `buildConversionContext` — rates are Records; the conversion is arithmetic), normalization (`normalizeMerchantKey`), parsing (CSV/provider payloads), serialization plumbing, registries and engines (assembler registry, lens engine, notification machinery), shared predicates (visibility — arguably Enforcement; either way, not intelligence), `lib/periods` once extracted.

Why the boundary must be hard, in both directions:

1. **Infrastructure with intelligence trappings is false precision.** A `confidence` on a period calculation, an UNKNOWN valve on a currency conversion — these would launder arithmetic into "judgment" and teach consumers to hedge against things that cannot be uncertain. If a conversion can't be performed, that is a missing Record (no rate) — a Coverage fact — not low-confidence infrastructure.
2. **Intelligence hiding in infrastructure is unaccountable.** The CSV `mapCategory` keyword table is the cautionary tale: semantic inference (fallible! it disagrees with the Plaid dialect by construction) living in a parser, with no version, no confidence, no owner — intelligence smuggled into infrastructure, and now a named cross-dialect defect. The fix direction (predecessor + MI doctrine) is to pull the semantic decision up into the owning module and leave the parser parsing.
3. **Different change disciplines.** Infrastructure changes are refactors (tests prove equivalence or the behavior change is a bug fix); intelligence changes are *re-derivations* (version bump, backfill decision, output-shift explanation). Conflating them means either paralyzed utilities or unaudited fact drift.

Rule of thumb for the doctrine: **infrastructure is allowed to be wrong only in ways a unit test can catch.** The moment a component's wrongness requires a human judgment to detect ("that's not really a transfer"), it has crossed into intelligence and must be promoted with full apparatus.

---

## 8. Consumers — rigorous definition

Definition: **components that select, arrange, filter, threshold-for-display, and present facts owned elsewhere, asserting nothing new about the finances.** Dashboard, Briefs (all cadences), search, notifications-content-selection, the AI serializer, the admin console, exports.

What consumers *may* legitimately own: view logic (tone, ordering, visit-state greeting, section priority), display thresholds ("show the alert when runway < 2 months" — presentation policy over an owned fact), scope selection (which Space, which window — via shared Infrastructure), and composition (which facts appear together). What they may never own: fact definitions, aggregation math, membership predicates, classification rules.

**Why consumers must never own canonical financial knowledge — the platform's own history is the argument:**

1. **Consumer multiplicity guarantees divergence.** Facts computed in surfaces get computed per surface: `FLOW_COST` existed in four places because three consumers each "just needed" spend membership. KD-10's two monthly-expense figures were an assessment block and a context block — two consumers — disagreeing inside *one prompt*.
2. **Consumer-owned facts are invisible to enforcement.** The validator reconciles against owned, serialized facts; a figure a Brief computes privately is exactly the unverifiable-figure class KD-2 exists to catch — except structural, not incidental.
3. **Consumer-owned facts cannot be versioned or backfilled.** When the definition changes, owned facts re-run with a version bump and an explanation; a consumer-embedded formula changes silently between deploys — history restated without record, the precise thing the MC1 "history never rewritten" rule forbids.
4. **Consumers churn fastest.** Presentation is the highest-turnover layer (DashboardClient was just deleted; briefs will be redesigned repeatedly). Facts embedded in churning code die or fork in redesigns. Authority belongs in the slowest-changing layer that can host it.

The enforcement mechanism already exists in-house: import-graph tripwires (the lens engine forbids Prisma; PO1 Phase-4 gates forbid product-table queries, grep-enforced). The doctrine should mandate the same for consumers: **a Consumer may import module contracts and Infrastructure; a Consumer defining an aggregation over raw Records is a review-blocking defect.**

---

## 9. Delivery and Enforcement (completing the taxonomy)

**Delivery** exists so that Ambient has an honest home: scheduling, channels, retries, digests, the AiAdvice write path. Delivery's discipline is operational (idempotence, retry, opt-out, audit), not epistemic. The v2.6b exit criterion — briefs with *zero validator failures* — is exactly the statement that Delivery adds no claims: if it computed anything, it could fail the validator on its own.

**Enforcement** is named as a category for one reason: the validator is the most important component in the system that is neither intelligence nor infrastructure, and leaving it unclassified invites someone to "improve" it into computing financial facts. Enforcement components judge artifacts and police boundaries (output validation, rate limiting, visibility gating, invariant checks like `checkSpendingCategoryInvariant`, the flow-desync audit). They share intelligence's determinism and explainability but own zero financial claims — and must stay that way, because the referee cannot also be a player: a validator that owned facts would validate itself.

---

## 10. The module registry (recommendation)

Registry = the FI doctrine's ledger of intelligence modules. Everything else lives in the taxonomy, not the registry. **Naming note:** registry entries drop the "Intelligence" suffix — it is the category name, not a per-module honorific ("Transaction Intelligence" reads well in an initiative; a registry of nine entries all ending in "Intelligence" is noise).

**Core (exists or justified now — 4):**

| Entry | Kind | Status |
|---|---|---|
| **Transaction** | Fact module (row facts + read-time relationships) | Exists: FlowType (kernel facet) + TI Phase 1 + TI2 builder + RelationshipResolver; TI2 wiring and remaining slices per the TI investigation |
| **Merchant** | Fact module (identity, category provenance) | Exists (MI1 M0–M6); MI2 planned |
| **Financial Health** | Aggregate module (assessments, risks/opportunities) | Exists as `computeAssessment`; absorb the opportunity engine formally; decompose gradually |
| **Coverage** | Epistemic module (data-sufficiency claims) | Promoted by §5; build alongside AI-5 WS-3 — mostly adoption of shipped flags |

**Future (each gated, in dependency order — 5):** **Cash** (gated on recurrence facts) · **Investment** (gated on demand + securities reference data; absorbs crypto as a dimension) · **Forecast** (gated on recurrence + Cash) · **Receipt** (gated on TI relational facets + demand; new Records substrate) · **Tax** (gated on counsel + lot model + post-launch demand). Plus one *capability* pre-assigned, not registered: **recurrence** — a fact family whose owner (TI per-row flag vs MI cadence spine) is fixed at TI0; "Subscriptions" is its consumer surface.

**Never (with the reason they must stay dead):** **Location** (substrate is 7A-deny-listed — a privacy decision, not a priority decision) · **Behavior** (unfalsifiable residue after its concrete claims are homed) · **Time** (infrastructure; no fallible claims) · **Crypto** (dimension, not domain) · **Search/Brief/Dashboard/Notifications "Intelligence"** (consumers and delivery; any future temptation to add per-surface "smartness" must route through owned modules).

**Folded elsewhere:** Opportunity → Financial Health · Subscription → recurrence facts + consumer surface · Benchmark → Records (reference datasets) + Context (cohort key) + Financial Health (the comparison claim); revisit module status only at internal-cohort scale · User → Context · Advisor (AI-5) → Context (conversation state) + Consumer discipline · Ambient → Delivery · Platform Operations → its own parallel plane running the same taxonomy over telemetry.

Steady state: **4 core now, at most 9 ever contemplated** — and Tax/Receipt may never clear their gates. A registry that grows past ~10 entries is a signal the definition is being diluted, not that the platform got smarter.

---

## 11. Architectural rules (doctrine input)

**On creating intelligence:**

1. A new intelligence module exists only when: it owns a *named family of fallible financial claims* no existing module owns; at least two consumers need those claims through a typed contract (or one exists and the second is ratified roadmap); and it can satisfy all seven §1.2 requirements at birth. Otherwise it is a facet of an existing module, consumer-internal logic, or a wish.
2. Never create an intelligence module for: a computation that cannot be wrong (Infrastructure); declared attributes (Context); a presentation need (Consumer); a scheduling need (Delivery); a data *dimension* of an existing claim family (facet); or a name that sounds good.
3. New claims default into existing modules. The bar for a new module is higher than the bar for a new facet — when in doubt, extend.
4. Persistence is decided per fact, not per module: persist for backfill economics, expensive recomputation, or cross-time comparability; otherwise recompute at read (the TI4/RelationshipResolver posture). "Compute once" means one definition site, not one execution.
5. Every intelligence claim carries: machine reason, provenance (inputs + freshness + consumed fact versions), version, and either confidence (fallible inference) or completeness (missing-input risk). A claim that needs neither is not a claim — reclassify the component.
6. The honesty valve is non-negotiable: insufficient signal produces UNKNOWN/null/absence, never an approximation presented as fact. This applies to composite scores and forecasts with extra force, not less.

**On the other categories:**

7. Infrastructure must be wrong only in ways a unit test catches. The moment detecting its wrongness requires human judgment about finances, promote it to a module with full apparatus. Infrastructure never carries confidence; a missing capability surfaces as a Coverage fact, not a hedge.
8. Context must be declared or operational, never silently derived; each Context item has exactly one definition site; user Context leaves its record only as coarse enums; a field is either declared or derived — never a blend.
9. Consumers may select, arrange, and present; they may never define a fact, an aggregation, or a membership predicate. Enforce by import-graph tripwire: consumers import module contracts and Infrastructure, never raw Records for computation.
10. Delivery moves finished outputs and computes nothing; its discipline is idempotence, audit, and opt-out.
11. Enforcement judges artifacts and boundaries; it owns no financial claims and never will — the referee is not a player.
12. Initiative names and registry membership are separate namespaces: an initiative may be called anything (Advisor Intelligence, Ambient Intelligence); the registry admits only components that pass the §3 tree.
13. One authority per claim, forever: a second definition site for an existing claim is a review-blocking defect regardless of where it appears (module, consumer, script, or prompt).
14. The registry is append-justified and prune-eager: every entry cites its claim family, consumers, and gate; an entry whose gate never clears is removed, not pitied.

---

## 12. Closing assessment

The question "what deserves to be called Intelligence" turns out to have a crisp answer because Fourth Meridian already built both the positive and negative examples: FlowType and the KD register are the definition's proof set. The boundary is **fallible semantic derivation under a single authority** — and its power is less in blessing the four real modules than in what it excludes: it keeps arithmetic honest (Infrastructure), keeps declared things declared (Context), keeps surfaces from minting facts (Consumers, the KD-10 lesson), keeps the scheduler dumb (Delivery, the v2.6b lesson), and keeps the referee off the field (Enforcement). The registry this yields — Transaction, Merchant, Financial Health, Coverage, with five gated futures — is small enough for one maintainer to actually govern, which is the only kind of architecture doctrine that survives contact with a solo roadmap.

---

**End of investigation. No implementation performed. No files modified; STATUS.md untouched. Recommended next action if approved: fold §1–§3 (definition, taxonomy, decision tree) and §11 (rules) into the FI0 ratification slice proposed by the predecessor investigation, with §5's Coverage promotion and §10's registry as its initial ledger.**
