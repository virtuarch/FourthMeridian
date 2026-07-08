> **INVESTIGATION ONLY — no code, no schema, no migrations, no STATUS.md changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Financial Intelligence — Umbrella Architecture Investigation

**Date:** 2026-07-08
**Status:** Investigation complete — architecture recommendation only, no implementation.
**Question:** Should the organically grown intelligence systems (Transaction, Merchant, Receipt, Advisor, Ambient, and ~12 proposed others) be formalized as members of one architectural concept — **Financial Intelligence** — where deterministic modules compute durable financial knowledge once and every consumer reuses it?
**Baseline:** branch `feature/v2.5-spaces-completion`. FlowType P5 complete. TI Phase 1 complete; TI2 fact builder (`lib/transactions/transaction-facts.ts`) written but not wired; TI2 enums (`PaymentChannel`/`PaymentMethod`/`SettlementState`/`CounterpartyType`) present in schema. MI1 M0–M6 complete; MI2 planned. Assessment engine (`lib/ai/intelligence/annotations.ts`, 2,098 lines, 11 sections) live. Perspective Engine (2 lenses) live. Daily Brief live. Output validator live-enforcing. AI-5 approved (v2.6a). Ambient scoped (v2.6b). PO1 platform-ops roadmap written; `JobRun` model in schema.
**Sources:** `lib/transactions/{flow-classifier,transaction-facts,merchant-*}.ts` · `lib/ai/{context-builder,intelligence/annotations,output-validator}.ts` · `lib/perspective-engine/` · `lib/brief-types.ts`, `app/api/brief/` · `prisma/schema.prisma` · `docs/investigations/TRANSACTION_INTELLIGENCE_FACT_LAYER_INVESTIGATION_2026-07-07.md` · `docs/initiatives/{mi1,ai5,platops}/` · `docs/ROADMAP_REVISION_PROPOSAL_2026-07.md` · STATUS.md §§3–8.

---

## 0. Executive summary

**Fourth Meridian already *is* a Financial Intelligence platform — it just hasn't said so in one place.** The pattern the umbrella proposes ("deterministic modules compute durable knowledge once; persist or expose canonical facts; every consumer reuses them") is not a new architecture. It is the literal, repeatedly-proven house pattern: `classifyFlow` (versioned, pure, honest-UNKNOWN, write-once, read-everywhere), Merchant Intelligence M0–M6 (persisted identity + provenance + read cutover), the assessment engine (pre-computed deterministic assessments the LLM narrates but never computes), the Perspective Engine (pure lens cores with verdict/provenance/version contracts), and SpaceSnapshot/FxRate (append-only frozen facts). The TI fact-layer investigation (2026-07-07) already generalized the pattern for one domain; this investigation confirms the generalization holds platform-wide.

**Recommendation: formalize the *doctrine and the contracts*, not a framework.** Adopt "Financial Intelligence" as a named architectural tier with (a) a four-tier layering model (§2), (b) two standardized contracts that already exist — the **fact-module contract** (FlowType/TI/MI shape) and the **aggregate-module contract** (lens/assessment shape) — rather than one universal `compute()` interface (§3), and (c) strict DAG dependency rules (§6). Do **not** charter fifteen modules. Of the sixteen proposed areas, six should exist (four of them by adopting code already shipped), four should be folded into others, three postponed with explicit unpark conditions, and three rejected (§4, §8, §9).

**One blocking housekeeping item:** the name "Financial Intelligence" is already taken — STATUS.md §5 names **v2.5.5 "Financial Intelligence"** as a bounded, pure-data-semantics point milestone with the explicit warning *"growth beyond that is scope creep — cut it back."* Using the same name for a platform-wide umbrella guarantees the exact muddle TI's §0.1 name collision produced. Resolve at ratification: either rename the milestone (it is mostly shipped early anyway — FlowType landed in v2.5) or name the umbrella track distinctly (recommended: **`FI-x` track, "Financial Intelligence Architecture"**, with v2.5.5 renamed "Transaction Semantics Closeout").

Overall concept rating: **7/10** — correct as doctrine, differentiating as positioning, dangerous as a pre-beta buildout program (§9).

---

## 1. Q1 — Should a formal Intelligence architecture be introduced?

**Yes — formalize it. But be precise about what "formalize" means, because one version of it improves the platform and the other damages it.**

### 1.1 What formalization buys (real, evidenced)

1. **The pattern is already converged; naming it is cheap.** FlowType, MI, TI, the assessment engine, and the lens engine independently arrived at the same six properties: pure/deterministic cores · versioned computation (`classifierVersion`/`lensVersion`) · honesty valves (UNKNOWN/null, never fabricate) · additive nullable persistence · provenance carried with every fact · LLM narrates, never computes. Five systems converging unguided on one shape is the strongest possible evidence the shape is right. Formalizing turns convergence-by-taste into convergence-by-contract, which matters for a solo maintainer whose future self is the second engineer.
2. **It prevents the re-derivation defect class by construction.** KD-10 (two competing monthly-expense figures), KD-11 (drifting keyword heuristics), KD-17 (sign asymmetry), the four-copy `FLOW_COST` set — every one is the same defect: a fact computed in more than one place. "One authority per fact, consumers read it" as ratified doctrine makes that a review-time rule rather than a recurring incident.
3. **It gives future initiatives an entry template.** MI and TI each spent an investigation re-deriving the same slice grammar (decision gate → zero-schema consolidation → additive schema → backfill → reconciliation → read cutover). A ratified FI doctrine makes that grammar reusable: a new module's charter becomes a one-page instantiation instead of a 300-line rediscovery.
4. **It is the pre-condition for provenance-based output validation.** KD-2's accepted caveat is that the validator is membership-based, not provenance-based. Canonical, identified facts (each with an owner module, version, and ID) are exactly what a provenance validator needs to say "this figure is assessment.cashFlow.estimatedMonthlyExpenses v3" rather than "this figure appears somewhere in context." The umbrella is the path to closing the validator's class boundary.

### 1.2 What formalization must not become

1. **A runtime framework.** No `IntelligenceModule` base class, no generic orchestrator, no plugin loader. The house style is chokepoint seams and pure modules; the existing registries (`assembler-registry`, `registerLens()`) are 30-line idioms, not frameworks. The Perspective Engine README already carries the right warning: *"Do not generalize this into a query engine."*
2. **A charter for fifteen modules.** Naming a module creates gravitational pull to build it. The evaluation in §4 rejects or folds seven of the sixteen. The umbrella should ratify the *tier model and contracts* plus the modules already justified — everything else needs its own future ratification against real demand.
3. **A reason to precompute everything.** The lens engine is deliberately non-persistent; assessments are deliberately per-request. "Compute once" does not mean "persist everything" — it means *one definition site* (§2.4 decides persist-vs-derive per fact class). Persisting cheap aggregates creates staleness/invalidation machinery for no benefit.

**Verdict:** introduce the formal architecture as (i) a ratified doctrine document, (ii) two named contracts, (iii) a module registry *in documentation* (STATUS-ledger style, not code), and (iv) DAG dependency rules. Complexity added: near zero — the code largely exists. Complexity prevented: the KD-10/11/17 class, ownership drift (the TI§8 risk), and N future one-off architectures.

---

## 2. Q2 — The recommended layering

The proposed linear stack (Transactions → Merchant Identity → FI Modules → Advisor → Ambient → LLM) has the right instinct but three wrong placements: Merchant Identity is not *below* the fact modules (it is one of them, sharing the row with TI); Advisor Intelligence is not a data layer (it is deterministic *conversation state*, a consumer-side substrate); Ambient Intelligence is not intelligence at all (it is *delivery* — scheduling, briefs, notifications). Intelligence is a DAG with tiers, not a pipeline.

### 2.1 Recommended architecture

```
┌─ TIER 0 · CANONICAL RECORDS (raw, immutable) ─────────────────────────────────┐
│  Transaction rows (native amounts) · FinancialAccount · Holding · SpaceSnapshot│
│  FxRate archive · captured provider metadata (7A doctrine: capture-or-never)   │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼
┌─ TIER 1 · DURABLE ROW FACTS (write-time, pure, versioned, persisted) ─────────┐
│  Transaction Intelligence  flowType/direction · paymentMethod · settlement …   │
│  Merchant Intelligence     merchantId · aliases · category + provenance        │
│  (shared row, shared rewrite contract: category change → re-stamp dependents)  │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼
┌─ TIER 2 · RELATIONAL / RECONCILED FACTS (batch pass, persisted group ids) ────┐
│  transferGroupId · pending→posted · duplicateGroupId · refundLinkId            │
│  recurrence/cadence (the Subscription capability — ownership set at TI0)       │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼
┌─ TIER 3 · DETERMINISTIC AGGREGATES & ASSESSMENTS (read-time or snapshot) ─────┐
│  Financial Health (computeAssessment — exists) · Cash Intelligence             │
│  Investment Intelligence · Opportunity engine · Perspective lenses             │
│  All: pure cores · injected clock · confidence/completeness · provenance       │
│  Shared infrastructure (libraries, not modules): period/Time math ·            │
│  money/FX context (MC1) · visibility predicates · data-quality/coverage flags  │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼
┌─ TIER 4 · CONSUMERS (read facts; never re-derive) ────────────────────────────┐
│  Dashboards/widgets · Daily Brief · search/export · notifications              │
│  AI context builder + serializer  ←  Advisor Intelligence (conversation state) │
│  Platform Operations (PO1 — reads telemetry shadows, never product facts)      │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼
                      LLM (narrates serialized facts)
                               ▼
                      Output validator (authoritative, unchanged position)
                               ▼
              Delivery: chat reply · Ambient (scheduler → brief/notification)
```

### 2.2 Corrections to the proposed stack

- **TI and MI are siblings on the same row**, ordered only by the rewrite contract (category is MI's output; flow derives from it). Neither is "below" the module family — they *are* the Tier-1 module family.
- **Advisor Intelligence (AI-5) is orthogonal to the data tiers.** Its own charter says so: a deterministic conversation-state layer consumed by the context builder. It sits beside the serializer in Tier 4, consuming Tiers 1–3. Placing it in the data stack would invite it to own facts, which it must never do.
- **Ambient Intelligence is a delivery substrate** (scheduler, AiAdvice write path, notifications, brief generation cadence). It composes Tier 3/4 outputs on a clock. Calling it an intelligence *module* would give it license to compute — the v2.6b exit criteria ("zero validator failures") depend on it computing nothing.
- **Time is infrastructure, not a tier member** (§4.9).
- **The LLM is above the whole stack and below the validator**, exactly as today. Nothing in this proposal moves it.

---

## 3. Q3 — A common contract?

**Yes to standardized contracts; no to a single universal one.** The proposed field list (`compute() · facts · metrics · signals · confidence · version · lastComputed · consumer APIs`) conflates two genuinely different kinds of module the repo has already separated. Forcing one interface over both would be a lie in the type system: row facts have no `lastComputed` staleness semantics distinct from their version stamp, and read-time lenses have no persistence to be "last computed" at all.

### 3.1 Contract A — Fact modules (Tier 1–2). *Already exists; ratify it.*

The FlowType/TI/MI shape:

| Element | Existing precedent |
|---|---|
| Pure builder: `input → facts` (no IO, no clock, never throws) | `classifyFlow`, `buildTransactionFacts`, `resolveMerchant` |
| Honesty valve: insufficient signal → `UNKNOWN`/`null`, never fabricated | `FlowClassificationReason`, `NULL_TRANSACTION_FACTS` |
| Version stamp per row: `WHERE version < N` selective backfill | `classifierVersion`, `tiFactsVersion` |
| Confidence + machine reason persisted with the fact | `classificationConfidence/Reason` |
| Additive nullable columns; `null` = "not yet computed" | MC1 Phase-0 doctrine, MI §3.5 |
| Write-path stamping + rewrite-invalidation contract | `merchant-corrections.ts` re-runs `classifyFlow` |
| Backfill grammar: dry-run → apply → idempotence proof | MI M3, FlowType P4 |

### 3.2 Contract B — Aggregate modules (Tier 3). *Already exists; ratify it.*

The LensResult/FinancialAssessment shape: pure core over typed inputs · injected clock (`ComputeOptions.now` — byte-identical output for same inputs) · verdict/metrics as typed values, never free text · **assumptions and estimates always labeled** · completeness/confidence levels (`CompletenessLevel`, `ConfidenceLevel` in `annotations.ts`) · provenance (contributing account ids, `dataAsOf`, visibility-tier counts, name-free redaction) · fail closed, fail *shaped* (`COMPUTE_FAILED`, never raw error text) · `lensVersion`-style version bump on math changes · no Prisma, no LLM imports (tripwire-tested).

### 3.3 Mapping the proposed fields

`compute()` → the pure builder/core (both contracts). `facts` → Tier 1–2 persisted columns (Contract A only). `metrics`/`signals` → Tier 3 typed sections (Contract B; "signals" are the existing `AssessmentRisk`/`AssessmentOpportunity`/heuristics). `confidence` → both, already present. `version` → both, already present. `lastComputed` → meaningful only for persisted artifacts (snapshot `computedAt`, fact version stamps); for lenses it is `dataAsOf` (input freshness), a better concept. `consumer APIs` → each module exports functions + registers with the relevant registry (`registerLens`, assembler registry); no generic gateway.

**Would standardization improve maintainability? Yes, materially** — but the improvement comes from *ratifying and naming* the two contracts and adding the missing tripwires (an import-graph test per module, like `engine.test.ts`), not from new abstraction. The single highest-value addition: a shared `Provenance`/`Confidence` type module so Tier-3 outputs compose (AI-5 WS-3's confidence propagation needs exactly this).

---

## 4. Q4 — Module-by-module evaluation

Each evaluated independently. "Exists" means shipped code adopted under the umbrella, not new work. Ratings are for *the module as proposed, in this codebase, at this stage*.

### 4.1 Transaction Intelligence — exists · **10/10**

**Purpose:** durable "what happened" per row (kind, direction, method, settlement, relational groupings). **Ownership:** Tier 1 (single-row) + Tier 2 (reconciliation). **Facts:** flowType/flowDirection (shipped), paymentChannel/Method, settlementState, authorizedAt, counterpartyType, fxApplied (TI2, builder written), transferGroupId/duplicateGroupId/refundLinkId (TI4). **Overlap:** none — it is the kernel the whole umbrella generalizes. **Difficulty:** low-medium; TI0–TI5 already sequenced by the 2026-07-07 investigation. **User value:** high (honest spend math, transfer/refund clarity, detail view content). **AI value:** very high (retires four spend-membership copies; per-request `classifyFlow` re-derivations disappear). **Platform value:** high (classifier-confidence telemetry per PO1 Part 7). **Should it exist:** it already does; the umbrella's first act is adopting it.

### 4.2 Merchant Intelligence — exists · **9/10**

**Purpose:** the "who" — persisted counterparty identity, aliases, rules, category provenance, sanctioned merges. **Ownership:** Tier 1, sharing the Transaction row with TI under the ratified split (TI never writes category/merchantId; MI never writes flowType). **Facts:** merchantId, aliases, category + categorySource/RuleId, enrichment columns. **Overlap:** the recurrence/cadence boundary with TI is the one open seam — must be settled at TI0, before either side builds (§4.11). **Difficulty:** shipped; MI2 (merge review) is planned and correctly bounded. **User/AI/platform value:** all high and demonstrated (M6 read cutover, WGU merge). **Should it exist:** yes — already does. One point off only because the cadence boundary and the two category-inference dialects (Plaid vs CSV) remain open debts inside its domain.

### 4.3 Receipt Intelligence — planned · **5/10, postpone**

**Purpose:** document ingestion (OCR/parse) + deterministic matching of receipts to transactions; line-item facts. **Ownership:** a Tier 1–2 module over a *new* raw substrate (documents), consuming TI (settlementState, paymentMethod, amount) + MI (merchant identity) for matching — the TI investigation already ruled it must consume, not re-derive. **Overlap:** none today; high overlap risk if built before TI4. **Difficulty:** high — first document pipeline, first OCR dependency, storage + PII surface (receipts contain addresses, partial PANs, names — a 7A-doctrine review of its own), and per-receipt processing cost (PO1 flags it as "must be born instrumented"). **User value:** medium-high for a subset (expense tracking, returns, warranties); **AI value:** medium; **platform value:** low, cost-heavy. **Should it exist:** eventually yes, as the third fact module — but strictly after TI4 supplies its matching dimensions, and not before beta demand confirms it. Postpone with unpark condition: TI4 shipped + real user demand.

### 4.4 User Intelligence — **5/10 — exists as canonical *context*, not as a module**

**Purpose as proposed:** age range, employment status, life stage, financial experience, onboarding goals, household context. **Assessment:** almost none of this is *computed* — it is declared at onboarding. The schema already carries `EmploymentStatus` and `UseCase`; a `UserContext` here is a thin canonical projection (age *range* derived from encrypted DOB at a single decrypt-adjacent chokepoint, never DOB itself — consistent with the existing HKDF/per-purpose-key discipline), not a compute pipeline. There is no version to bump, no confidence to score, no honesty valve needed for "user says they're a student." **Recommendation:** build it as a small canonical context assembler (one definition site feeding AI context, Brief tone, and future benchmarking cohort keys), governed by the 7A-style rule that only coarse, enumerated values (age band, employment enum, life-stage enum) ever leave the User record. **Benchmarking context:** the cohort *key* ("25–34, employed, renter") belongs here; the benchmark *data* does not (§5). "Users aged 25–34 with similar income generally…" is a Benchmark Intelligence sentence, gated on §5's verdict. **Should it exist:** as a module with the full contract — no. As canonical user context — yes, cheap, do it when Brief personalization or benchmarking first needs it.

### 4.5 Investment Intelligence — **7/10, build in v2.6-era as a Tier-3 lens family**

**Purpose:** diversification, allocation, concentration, sector exposure, dividend metrics, portfolio health. **Ownership:** Tier 3 aggregate module over Holdings (Tier 0) — read-time lens family under Contract B, with daily persistence only if/when snapshots need it. **Overlap:** `annotations.ts` already computes `InvestmentReadinessSection` and `CapitalAllocationSection`; the holdings assembler exists; MC1 closeout names "mixed-currency allocation precision (donut/concentration)" as a residual. Investment Intelligence is the natural home that unifies these. **Difficulty:** medium — the math is deterministic and pure, but sector/asset-class classification needs reference data (a securities-metadata question with market-data dependencies), and mixed-currency aggregation must ride MC1's conversion context. **User value:** high for investor users; **AI value:** high (today the AI sees holdings but has thin portfolio semantics); **platform value:** low. **Should it exist:** yes, as 2–4 lenses (allocation, concentration, income/dividend) + an assessment section adoption — not as a new engine. Sequence after Cash Intelligence; it serves fewer users than cash math does.

### 4.6 Crypto Intelligence — **3/10, fold into Investment Intelligence**

Wallet/chain/exchange exposure, staking, stablecoin allocation are *asset-class dimensions of the portfolio*, not a separate intelligence domain — the questions ("concentration," "exposure," "yield") are the same lens math with a crypto taxonomy. Standing it up separately duplicates every allocation computation with slightly different grouping keys — the exact drift the umbrella exists to prevent. Also: `sync-crypto.ts` is literally `export {}` — there is no data substrate to be intelligent about. **Verdict:** reject as a module. Crypto becomes a classification dimension inside Investment Intelligence (asset class, chain, custody type as holding facets), unparked only when crypto sync actually exists and crypto-specific facts (staking yield, protocol risk) demonstrably don't fit the portfolio lens shape.

### 4.7 Location Intelligence — **2/10, reject**

Spending geography, travel detection, commute patterns, home radius. **This module contradicts ratified doctrine.** The TI 7A Metadata Capture Doctrine places precise location on the **Never Captured** deny-list ("if it is never stored, it can never leak"), and the PO1 privacy rule treats location-grade metadata as targeting data. Building Location Intelligence means reversing a security decision made for good reasons, to power features (travel detection, commute inference) that are low-value for a finance platform and reputationally risky ("your finance app knows your home radius"). Coarse, transaction-derived geography (merchant city/state from Plaid, already in the payload) could someday support an "international activity" flag inside TI (`fxApplied` already covers most of it). **Verdict:** reject. If a specific, narrow fact ever justifies it (e.g., foreign-transaction-fee detection), it ships as a TI facet under a 7A review — not as a module.

### 4.8 Cash Intelligence — **8/10, build after recurrence facts; the strongest new Tier-3 module**

**Purpose:** liquidity, runway, paycheck cadence, balance volatility, emergency reserves, burn/accumulation. **Ownership:** Tier 3 over SpaceSnapshot (balance history), TI facts (flow membership, settled-vs-pending), and Tier-2 recurrence (paycheck/bill cadence). **Overlap:** significant existing coverage to *adopt, not duplicate*: `LiquiditySection` + liquidity lens (coverage months, reserves), `computeAverageMonthlySpending` (the KD-10 single authority), `CashFlowSection` (reliability classification). The genuinely new facts are cadence-dependent: paycheck detection, balance volatility, deterministic runway from recurring obligations. **Difficulty:** medium; the hard dependency is recurrence (Tier 2). **User value:** the highest of any proposed module — runway/paycheck/volatility is the daily-relevance core of a PFM. **AI value:** very high (cash-flow questions dominate advisor conversations). **Platform value:** medium. **Naming: yes — "Cash Intelligence" over "Balance Intelligence."** A balance is a datum (and "balance" already means SpaceSnapshot/account-balance machinery); *cash* is the domain — liquidity, flow, runway. The rename also keeps it from being read as "intelligence about the Balance table." **Should it exist:** yes; first new Tier-3 module after the recurrence pass lands.

### 4.9 Time Intelligence — **as a module: 2/10 · as shared infrastructure: essential, do it early**

Rolling/fiscal periods, quarters, seasonality windows, cadence math. This has **no facts of its own, no confidence, no honesty valve, no version semantics that matter to users** — it is pure library code. Calling it an intelligence module would create a dependency everyone imports but that owns nothing (a "module" that is actually `date-fns` with opinions). But the *library* is genuinely load-bearing and currently scattered: window resolution lives in the chat route + intent classifier (KD-16's silent-window defect class), month-completeness in `reliableMonths`, snapshot dating in `lib/snapshots`. **Recommendation:** extract `lib/periods/` (pure, injected-clock, tested) as **shared Tier-3 infrastructure**, sequenced with AI-5/KD-16 window work — the conversation-state substrate needs a single window vocabulary anyway. Every intelligence module then consumes it; none owns it. So: yes to "shared infrastructure used by every other module," no to module status.

### 4.10 Tax Intelligence — **4/10, postpone to post-launch**

Deductible spending, estimated tax impact, gains/losses, HSA/FSA, charitable giving. **User value is real but the module is premature on four axes:** (1) *liability surface* — "estimated tax impact" crosses from descriptive facts into tax advice; the v3.0 legal workstream (remove "financial advisor" framing, external counsel) must scope tax language first; (2) *jurisdiction complexity* — deterministic tax math is per-country/state/year rule tables, a large versioned dataset to maintain solo; (3) *data insufficiency* — gains/losses need a lot model (STATUS: FX P&L "gated on a future lot model"); (4) *demand-unproven pre-beta*. Cheap descriptive subsets (charitable-giving totals, category-year rollups "for your records") fall out of TI/MI already and need no module. **Verdict:** postpone; unpark at post-launch with counsel-reviewed framing ("tax-relevant facts," never "tax advice"), starting descriptive-only.

### 4.11 Subscription Intelligence — **8/10 as capability · fold into the Tier-2 recurrence pass, not a standalone module**

Recurring subscriptions, duplicates, forgotten services, renewal/price-increase detection. **This is the highest-user-value item on the whole list** (it is *the* PFM table-stakes feature) — but architecturally it is not a peer module; it is the **recurrence relational fact** (Tier 2) plus consumers. The TI investigation already flagged the ownership question: cadence is a time-series over the *merchant-resolved* ledger, so detection arguably belongs to MI's identity spine with TI contributing the per-row `recurringCandidate`. That TI0 boundary decision is the entry gate. Once `recurrenceGroupId` + cadence + expected-amount facts persist, "Subscription Intelligence" is: a read predicate, a price-increase comparator (new amount vs group baseline — deterministic), a renewal-window calculator (Time library), and Brief/notification consumers. **Verdict:** build the recurrence pass with named priority (it also unblocks Cash and Forecast); ship "subscriptions" as its first consumer surface. Rating reflects the capability; as an independently chartered module it would be a 4 (duplication risk with MI/TI).

### 4.12 Financial Health Intelligence — **8/10 — adopt `computeAssessment` as this module; do not build a second one**

Debt/liquidity/savings/investment/overall health, benchmark scoring. **This module already exists in production**: `FinancialAssessment` (`annotations.ts`) computes data quality, cash flow, debt (+ strategy), liquidity, capital allocation, spending opportunities/trends, goal alignment, investment readiness, and risk/opportunity — deterministic, confidence-carrying, serialized to the LLM. The proposal's real content is: (a) *name it* — adopt annotations.ts as the Financial Health module under Contract B; (b) *decompose it* — 2,098 lines is the largest single intelligence artifact in the repo; splitting sections into per-domain cores (the lens pattern) would let Cash/Investment Intelligence own their sections without forking; (c) *add composite scoring* — a single "health score" is a product decision, not an architectural need, and scores invite false precision (the anti-fabrication doctrine applies to composite indices too — defer); (d) benchmark scoring gates on §5. **Is it the deterministic foundation under Advisor Intelligence? It already is** — AI-5 WS-3 (confidence propagation) is explicitly built on it. **Verdict:** exists; the work is adoption + gradual decomposition, zero new engine.

### 4.13 Forecast Intelligence — **6/10, postpone until recurrence + cadence exist**

Projected balances, cash forecasts, bill/income prediction, year-end outlook. Deterministic forecasting is legitimate and in-doctrine *if* it is arithmetic over persisted facts: recurring obligations (Tier 2) + paycheck cadence (Cash) + current balances → projected balance is a sum, not a guess, with every assumption labeled (`isEstimated` precedent from D2.x). Without recurrence facts, forecasting is curve-fitting — exactly the fabrication class the platform refuses. **Dependencies:** recurrence pass → Cash Intelligence → Forecast. **User value:** high ("will I make rent") — but honesty constraints mean wide bands for volatile users; the honest version is less impressive than competitors' confident-but-wrong versions, which is on-brand but worth acknowledging. **Verdict:** should exist eventually as Tier 3 (compute-on-read with labeled assumptions; persist only if the Brief needs day-over-day comparability); postpone behind its dependency chain.

### 4.14 Behavior Intelligence — **2/10, reject**

Financial habits, spending routines, payment behavior, long-term behavioral patterns. Every concrete deliverable already has a better home: spending routines/trends → `SpendingTrendsSection` (exists); paycheck behavior → Cash; shopping cadence → recurrence/MI; payment behavior → TI settlement + debt facts; savings habits → goal alignment (exists). What remains after subtraction is the *psychographic residue* — "what kind of spender are you" — which is exactly where deterministic platforms drift into horoscope territory: unfalsifiable labels with no fact backing them. It should not exist independently from User Intelligence, and mostly should not exist at all. **Verdict:** reject. Any specific behavioral fact that proves out gets homed in the module that owns its data.

### 4.15 Opportunity Intelligence — **6/10 — adopt the internal engine; defer external offers indefinitely**

Refinance/HYSA/cashback/optimization opportunities. Split it: (a) **Internal opportunities** — "your spending in X is 40% above trend," "idle cash exceeds your reserve target," debt-strategy candidates — *already exist* (`SpendingOpportunitySection`, `RiskOpportunitySection`, `OpportunityCode`, debt strategy). Adopt under the umbrella; extend as upstream modules add facts. (b) **External-market opportunities** — "better HYSA at 4.5%," refinance rates — require a market-rate dataset (new external dependency + freshness machinery) and, more importantly, a *positioning decision*: rate-shopping recommendations are where PFMs monetize via affiliate placement, and Anthropic-grade honesty branding ("no ads, no steering") is directly at odds with it. That is a company decision, not an architecture slice. **Verdict:** internal — yes, exists; external — defer indefinitely, revisit at v3.0 business-model work.

### 4.16 Ratings summary

| Module | Verdict | Rating |
|---|---|---|
| Transaction Intelligence | Exists — adopt as kernel | **10** |
| Merchant Intelligence | Exists — adopt; settle cadence boundary | **9** |
| Cash Intelligence | Build (after recurrence); rename endorsed | **8** |
| Subscription Intelligence | Fold into Tier-2 recurrence pass + consumers | **8** (capability) |
| Financial Health Intelligence | Exists (`computeAssessment`) — adopt + decompose | **8** |
| Investment Intelligence | Build later as Tier-3 lens family | **7** |
| Forecast Intelligence | Postpone behind recurrence + Cash | **6** |
| Opportunity Intelligence | Internal: adopt · external offers: defer | **6** |
| Receipt Intelligence | Postpone until post-TI4 + demand | **5** |
| User Intelligence | Thin canonical context, not a module | **5** |
| Benchmark Intelligence | Postpone (§5) | **4** now |
| Tax Intelligence | Postpone post-launch, descriptive-only entry | **4** |
| Crypto Intelligence | Fold into Investment | **3** |
| Time Intelligence | Library, not module — extract early | **2** as module |
| Behavior Intelligence | Reject | **2** |
| Location Intelligence | Reject (contradicts 7A doctrine) | **2** |

---

## 5. Q5 — Benchmark Intelligence

**Should benchmarks become a module? Eventually, probably; today, no — the platform is pre-beta and a benchmark module has a cold-start problem no architecture can solve.** Internal cohort benchmarks ("users aged 25–34 with similar income…") require a user population; with ~1 real user, every cohort is either empty or is the operator. Building the module now means building against synthetic data — pure speculation debt.

**How benchmark datasets should be represented (when built):** two sources, one representation.

1. **External reference datasets first** (the honest v1): public, static, citable distributions — e.g., the Fed's Survey of Consumer Finances, BLS Consumer Expenditure Survey. Imported as **versioned, append-only reference tables** (the FxRate idiom: dated, immutable, provenance = source + vintage), keyed by coarse cohort dimensions (age band, income band, household type). Facts read like "median emergency savings for your age band (SCF 2025): $X" — attributable, defensible, and available at zero users.
2. **Internal cohort aggregates later**: computed by a scheduled Tier-2-style job (PO1 dispatcher) into the same reference-table shape — never queried live across tenants at request time. Cohort keys come from User-context enums (§4.4), *never* raw attributes.

**Privacy preservation (non-negotiable rules):** age *ranges* only, DOB stays encrypted (matches the proposal); cohort **k-anonymity floor** — no aggregate computed or served for a cohort below k members (k ≥ 20–50; below floor, the fact is absent, not approximated — the honesty valve applied to cohorts); aggregates carry only distribution statistics (median/quartiles/counts), never per-user values; the benchmark store is structurally content-free (the PO1 Slice-1.1 move: fields for user-level values *do not exist in the schema*); cross-tenant reads happen only inside the aggregation job, never in any request path — request paths read the frozen reference table. Special cohorts (military members, students, retirees) are only as good as their declared source — they arrive with User-context enums and honest self-declaration, not inference.

**Would benchmark facts dramatically improve the Daily Brief and Advisor Intelligence? No — "dramatically" is the wrong expectation.** They add *color and calibration* ("your savings rate is above the median for your band") — genuinely engaging, and a real differentiator versus advice given in a vacuum. But the Brief's and advisor's core value is *your* runway, *your* debt cost, *your* anomalies; peer comparison is seasoning. The risk side is real: benchmark sentences are where "deterministic" quietly degrades into generic filler ("people like you usually…"), and a benchmark the validator can't trace to a versioned reference row is exactly the fabrication class KD-2 exists to stop. **Verdict:** postpone. Unpark condition: external — whenever a Brief/advisor surface concretely wants a citable reference figure (cheap, doable pre-scale); internal — user count where realistic cohorts clear the k-floor. Design the reference-table shape at FI0 so both sources land in it.

---

## 6. Q6 — Inter-module dependency rules

Modules may depend on one another — the example chain is broadly right in spirit — but as a **DAG with tier-monotonic edges**, not a chain, under these rules:

1. **Downward reads only.** A module may read facts from its own tier or lower (Tier 3 reads Tiers 0–2; Tier 2 reads 0–1). Never upward: a Tier-1 fact builder that reads an assessment would make row facts depend on aggregates of themselves — cycles by construction.
2. **One authority per fact; consumers import, never re-derive.** The existing law (`classifyFlow` is the only flow authority; TI never writes category; MI never writes flow), generalized: every fact/metric has exactly one definition site, named in the module registry. A second computation site for an existing fact is a review-blocking defect (the KD-10 rule as architecture).
3. **Same-tier sibling reads go through published contracts, not internals.** Cash may read TI's spend predicate; it may not import TI's classifier internals to re-classify.
4. **Rewrite-invalidation propagates along declared edges.** The `merchant-corrections.ts` contract generalized: any write that changes a Tier-1 input re-stamps dependent Tier-1/2 facts through one shared helper; Tier-3 modules need no invalidation (recomputed at read) — which is a load-bearing argument for keeping Tier 3 non-persisted by default.
5. **Version pinning at consumption.** A Tier-3 output that consumed Tier-1 facts records the fact versions in provenance, so a backfill at v(N+1) explains any assessment shift — this is what makes "why did my number change" answerable.
6. **Shared infrastructure (Time/periods, money context, visibility, coverage flags) is imported by everyone and depends on no module.** Leaf libraries, cycle-proof.
7. **Advisor Intelligence and Ambient consume Tier 3/4 outputs and own zero financial facts.** Conversation state and delivery cadence, only.
8. **Platform Operations never reads product facts** — only telemetry shadows emitted at module chokepoints (PO1 doctrine, unchanged).

Corrected example flow: Merchant Intelligence + Transaction Intelligence (siblings, Tier 1, ordered by the rewrite contract) → recurrence reconciliation (Tier 2) → Cash Intelligence → Financial Health (which also reads TI/MI directly — the DAG, not the chain) → Opportunity engine → serializer/Advisor state → LLM → validator.

---

## 7. Q7 — How should the LLM consume intelligence?

**The premise needs correcting: the LLM already consumes intelligence blobs, not raw computation.** The chat pipeline serializes pre-computed assessments, monthly rollups, merchant rollups, per-liability debt attribution, and trend sections; the model narrates; the validator reconciles figures. "Provide intelligence blobs instead" is not a change of direction — it is finishing the direction. The real deltas available:

- **Replace the remaining read-time re-derivations with stored-fact reads** (the four spend-membership copies, per-request `classifyFlow` calls, the throwaway recurring heuristic) — TI1/TI5 scope.
- **Shrink raw-row context further as Tier 2–3 facts land**: today drilldowns still ship transaction rows; recurrence groups, transfer pairing, and richer aggregates let more questions be answered from facts, holding rows for genuine "show me the transactions" intents only.
- **Upgrade the validator from membership to provenance** once facts carry canonical IDs (§1.1.4) — the architectural payoff that retires KD-2's accepted caveat.

**Estimates** (directionally honest, not measured — a D6.3D-style budget measurement should precede any cutover):

| Dimension | Estimate | Basis |
|---|---|---|
| Token savings | **Moderate — ~20–40%** on typical prompts; large (>60%) only on drilldown-heavy turns | Rollups already replaced most raw rows (KD-7 capped the rest); remaining wins are rows→facts on drilldown paths and deduped derivations. Anyone promising 10× savings is comparing against an architecture FM never had. |
| Response consistency | **High gain** | Same question → same serialized facts → same figures. The KD-10 "two competing figures" class dies by construction; cross-surface agreement (chat vs Brief vs dashboard) becomes structural because all read one authority. |
| Explainability | **High gain** | Every figure traces to module + version + provenance (`dataAsOf`, contributing accounts). "Why does it say my runway is 3.2 months" becomes a fact lookup, not a prompt archaeology session. |
| Hallucination reduction | **Real but bounded** | Fabricated *figures* are already validator-caught; persisted facts extend protection to fabricated *attributions and relationships* (the KD-18 class) by making the true relationship present in context, and enable provenance validation. Narrative-level hallucination (mischaracterizing a correct number) remains prompt-and-validator work, not architecture. |
| Architecture cleanliness | **High gain** | One serialization boundary consuming typed module outputs; the serializer stops being where semantics are invented (the current chat route's inline keyword maps and category prose disappear into modules). |

One guardrail from the TI investigation stands: facts reach the LLM as **aggregates and stored labels it phrases — never as raw per-row fact dumps** (the D6.3D context budget applies to intelligence output too).

---

## 8. Q8 — What's overlooked, and what should die

### 8.1 Genuinely missing (durable architectural value)

1. **Data-Quality / Coverage Intelligence — the most important omission.** The platform's brand is honesty, and honesty is *computed from coverage facts*: history depth per account, estimated ranges (`isEstimated`), truncation flags (KD-7), sync health (`SyncIssue`), income completeness, month reliability (`reliableMonths`). These exist as scattered flags; every Tier-3 module and AI-5 WS-3 (confidence propagation) consumes them. Formalizing **canonical per-account/per-Space coverage facts** as shared Tier-3 infrastructure (not a user-facing module) is higher-leverage than half the proposed list — it is the substrate that makes every other module's `confidence` field mean something. The D2.x deferral ("snapshot quality column, AI/Brief sync-health consumption") is this, waiting for a name.
2. **Income Intelligence — but as Cash's first-class half, not a module.** Income completeness caveats recur through the KD ledger (KD-10, WS-3); paycheck detection is listed under Cash. Naming income explicitly inside Cash Intelligence's charter (cadence, stability, source count — coarse, name-free) prevents it from being the perpetually-implicit dependency.
3. **Net-worth/trajectory facts** are *not* missing — SpaceSnapshot already is that module in all but name. Adopt it into the registry (Tier 0/2 hybrid: frozen daily computed facts) rather than letting someone propose "Snapshot Intelligence" later.

### 8.2 Should be folded or killed (recap of §4, opinionated)

Fold: **Crypto → Investment** (asset-class dimension) · **Subscription → Tier-2 recurrence + consumers** · **Time → shared library** · **User → canonical context** · **Behavior → dissolve into Cash/Trends/recurrence** (reject the residue). Reject: **Location** (contradicts the ratified 7A deny-list; the privacy brand is worth more than travel detection). Defer: **Tax, Forecast, Receipt, Benchmark, external-offer Opportunity** — each with the unpark condition named in §4/§5, so deferral is a decision, not an omission.

The meta-point: the proposed list contains **three real fact modules** (TI, MI, Receipt-later), **three real aggregate modules** (Cash, Investment, Financial-Health-which-exists), **one relational capability** (recurrence), and **nine names** that are dimensions, libraries, consumers, or wishes. A healthy FI registry at v3.0 has ~6 members, not 16.

---

## 9. Q9 — Final recommendation

### 9.1 Recommended intelligence stack (target, ~v2.7)

```
Tier 0  Canonical records: Transaction · FinancialAccount · Holding · SpaceSnapshot · FxRate · reference datasets (future)
Tier 1  Fact modules:      Transaction Intelligence (TI) · Merchant Intelligence (MI)      [Receipt: future 3rd]
Tier 2  Reconciled facts:  TI relational pass (transfers/dupes/refunds/settlement) · recurrence/cadence (boundary set at TI0)
Tier 3  Aggregate modules: Financial Health (adopted computeAssessment) · Cash · Perspective lenses · Opportunity (internal) · [Investment next]
        Shared infra:      lib/periods (Time) · coverage/data-quality facts · money context (MC1) · visibility · Provenance/Confidence types
Tier 4  Consumers:         Brief · dashboards · search/export · notifications · AI serializer + Advisor conversation state (AI-5) · PO1 (telemetry shadows only)
Above:  LLM → output validator (membership → provenance, later) → chat / Ambient delivery (v2.6b)
```

### 9.2 Dependency graph

TI ↔ MI (siblings, rewrite contract) → Tier-2 reconciliation/recurrence → {Cash, Financial Health, Investment, Opportunity} (each also reading Tier 0/1 directly) → serializer/Brief/widgets; Advisor state beside the serializer; Ambient schedules delivery; shared infra imported everywhere, depending on nothing. Rules per §6: downward-only, one authority per fact, rewrite propagation through one helper, version-pinned provenance.

### 9.3 Ownership boundaries

TI: what happened (never category/merchant). MI: who (never flow). Recurrence: owner fixed at TI0 (recommendation: MI-spine detection, TI per-row flag, per the TI investigation's own analysis). Financial Health: cross-domain assessment only — as Cash/Investment mature, it *consumes* their cores rather than keeping private copies. Cash: liquidity/flow/runway/income cadence. User context: declared attributes, coarse enums only. Advisor: conversation state, zero facts. Ambient: cadence and delivery, zero computation. PO1: telemetry only.

### 9.4 Implementation order & priorities

1. **FI0 (doc-only, one slice):** ratify the umbrella — name/track (`FI-x`; resolve the v2.5.5 name collision), tier model, the two contracts, dependency rules, module registry adopting what exists (FlowType+TI, MI, computeAssessment→Financial Health, lenses, opportunity engine, SpaceSnapshot). Fold the pending TI0 decision gate into it (recurrence boundary, name reconciliation).
2. **TI1–TI5** exactly as the 2026-07-07 investigation sequenced (TI1 zero-schema predicate consolidation is the immediate debt paydown).
3. **`lib/periods` extraction** riding AI-5/KD-16 window work (v2.6a window).
4. **Coverage/data-quality facts** formalized alongside AI-5 WS-3 (they are its inputs).
5. **Recurrence reconciliation pass** (post-TI4) → **subscription surface** as first consumer.
6. **Cash Intelligence** (adopting liquidity/cash-flow sections; new cadence-dependent facts).
7. **Financial Health decomposition** — gradual, as sibling modules claim their sections.
8. **Investment Intelligence** lens family (v2.6b+/v2.7).

**Postpone:** Forecast (behind recurrence+Cash) · Receipt (behind TI4 + demand) · Tax (post-launch, counsel-gated) · Benchmark (external-reference v1 when a surface wants it; internal cohorts at k-floor scale) · User benchmarking context (with Benchmark). **Reject:** Location · Behavior · Crypto-as-module · Time-as-module · external-offer Opportunity (business-model gated).

Nothing above displaces the live roadmap: MI2 S1 remains the recommended product-lane next step; OPS-1→PO1 remains the platform lane. FI0 is a documentation slice that can ride either lane's gap week. FI must not become a third concurrent lane of *construction* — it is the doctrine both lanes already follow.

### 9.5 Risks

1. **Scope explosion against solo capacity** — the dominant risk. Sixteen named modules is a multi-year backlog for a team; the registry discipline (modules exist only when ratified individually) is the countermeasure. The v2.5.5 warning generalizes: *growth beyond the ratified set is scope creep — cut it back.*
2. **Framework temptation** — the umbrella invites a generic module runtime; §1.2 forbids it. Watch for any PR introducing an `IntelligenceModule` interface.
3. **Name collision** (v2.5.5) — resolve at FI0 or suffer the TI §0.1 muddle at roadmap scale.
4. **Persistence creep in Tier 3** — persisted aggregates need invalidation machinery; default is compute-on-read, persist only with a named consumer requirement (Brief day-over-day comparability is the legitimate case).
5. **Confidence theater** — a standardized `confidence` field is worthless if modules stamp `HIGH` reflexively; WS-3's propagation tests are the enforcement.
6. **Decomposing `annotations.ts`** is a real refactor of the most load-bearing AI artifact — do it section-by-section with byte-comparison harnesses (the M6/TI5 pattern), never as a big-bang.
7. **The umbrella outrunning users** — every module below Tier 1 is speculative until beta users ask its questions. The demand-pull rule from PO1 ("build the panel when you've hand-run its query three times") applies verbatim to intelligence modules.

### 9.6 The platform concept, rated critically

**"Fourth Meridian as a Financial Intelligence Platform rather than an AI-powered personal finance application": 7/10.**

**Where the vision is right — and genuinely differentiating.** The mainstream failure mode of AI-PFM products is LLM-over-raw-data: ship transactions into a prompt, let the model do arithmetic, accept that figures drift between answers. Fourth Meridian's inversion — deterministic modules compute; the LLM narrates; a validator enforces; every fact carries provenance and version; the system says UNKNOWN rather than guessing — is architecturally real (not marketing), already partially shipped, and *hard to retrofit*, which is what makes it a moat rather than a feature. The differentiation is specifically: (1) cross-surface figure consistency by construction; (2) answerable "why is this number what it is" provenance; (3) the honesty valve as product behavior ("would rather tell you less than tell you wrong"); (4) eventually, provenance-validated LLM output — which no prompt-engineering competitor can match without rebuilding their data layer. The umbrella concept correctly identifies that this, not chat, is the product.

**Where the vision is flawed.** First, *it mistakes naming for building*: the platform framing implies a construction program, but ~70% of the umbrella's value is adopting and governing what exists; the marginal new construction (recurrence, Cash, coverage facts) is a handful of slices, and inflating it into a "platform transformation" initiative would burn the v2.5→v3.0 runway on internal architecture while blockers 6–7 (test coverage, legal posture) actually gate launch. Second, *fifteen modules is completeness-driven design* — the thing the prompt itself warns against; nine of them dissolve under scrutiny (§8.2), and a vision that needs pruning by half at first contact should be adopted at half size. Third, *"platform" is aspirationally plural but factually singular*: one maintainer, zero external users, no second consumer of these "canonical facts" beyond the app itself — the platform framing becomes true when Ambient, benchmarks, and beta users exist to consume facts at scale, and asserting it early risks building the nervous system before the organism (PO1's own closing warning). Fourth, *the honesty moat has a UX cost the vision doesn't price*: deterministic-with-caveats loses demos to confident-and-wrong; the differentiation compounds with user trust over months, not in a screenshot — the vision is right *because* it is long-term, and it should be funded accordingly (doctrine now, modules on demand).

**Net:** adopt Financial Intelligence as the platform's stated architecture — one FI0 ratification slice, the two contracts, the ~6-module registry, the DAG rules — and let the roadmap keep shipping MI2, OPS-1/PO1, AI-5, and Ambient *under* it. The concept earns 9/10 as doctrine and 4/10 as a near-term buildout program; executed as recommended here, it is the former.

---

**End of investigation. No implementation performed. No files modified; STATUS.md untouched. Recommended next action if the direction is approved: an FI0 ratification slice (doc-only) resolving the v2.5.5 name collision, adopting the two contracts and the tier model, and folding in the pending TI0 decision gate.**
