> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D4 — Financial Intelligence Layer: Architectural Critique

**Status: Investigation only. No schema, migration, API route, UI, or application code was modified.**
**Date: 2026-07-01**
**Branch: feature/phase-2-architecture**

---

## 0. Document control

| | |
|---|---|
| Scope | Critical architectural investigation into the proposed Financial Diagnosis / Playbook / FinancialAssessment layer |
| Prior documents | `D4_AI_CONTEXT_BUILDER_INVESTIGATION.md`, `D4_AI_CONTEXT_BUILDER_ADDENDUM.md`, `D4_FINANCIAL_REASONING_ARCHITECTURE.md`, `D4_CONVERSATION_QUALITY_INVESTIGATION.md`, `D4_KNOWLEDGE_GAPS_INVESTIGATION.md` |
| Mandate | Challenge assumptions, identify what the existing investigations missed, propose the architecture that holds at millions of users and dozens of financial domains |
| Does NOT | Implement anything. Propose schema. Modify code. |

---

## 1. Before the critique: what you need to know

The core observation — that Fourth Meridian exposes raw financial context to the LLM and asks it to rediscover financial principles every conversation — is correct. The proposed intermediate layer is architecturally sound in intent.

But before proposing what to add, you should know what has already been designed.

`D4_FINANCIAL_REASONING_ARCHITECTURE.md` (produced today) defines a four-layer architecture that is nearly identical to what you have proposed:

- Layer 1: Financial State (context builder — context assembly)
- Layer 2: Financial Intelligence (deterministic pre-computed annotations)
- Layer 3: Financial Reasoning (reasoning modules + LLM synthesis)
- Layer 4: Financial Memory (persistent AiAdvice rows, user-confirmed values)

It defines nine financial concepts — Debt Health, Liquidity, Cash Flow Health, Financial Stability, Financial Flexibility, Wealth Progress, Emergency Readiness, Capital Allocation, Goal Progress — each with deterministic metric formulas, threshold classifications, and prescribed reasoning postures. It defines six reasoning modules (DEBT_HEALTH, LIQUIDITY, CASH_FLOW, WEALTH, AFFORDABILITY, DEBT_VS_SAVINGS) with explicit injection logic and module content. It defines a complete deterministic annotation set: monthly interest burden, liquidity months covered, deficit cause classification, net worth cause classification, goal on-track status.

Your proposal for "Financial Diagnoses + Financial Playbooks" is the same idea, slightly differently named.

This is not a criticism — it means your architectural instinct is sound. The gap is not what to design. The gap is (a) the existing design has precision holes that need filling, (b) the existing design will not scale to multiple financial domains without structural changes, and (c) the proposed FinancialAssessment object needs rethinking before it is built.

The rest of this document addresses those gaps.

---

## 2. Q1 — Should Fourth Meridian introduce a deterministic Financial Diagnosis layer? What belongs there?

**Yes, unambiguously. The design already exists; the question is what belongs where.**

The layer — call it Financial Intelligence Layer, not Financial Diagnosis — should contain everything that is math, threshold comparison, or classification. The name "Diagnosis" is medically loaded in a way that will cause problems. Medical diagnoses are clinical conclusions that imply causality and require expert judgment. What this layer produces is measurements with classifications. That is annotation, not diagnosis.

**What belongs in the Financial Intelligence Layer:**

Every quantity that can be derived from assembled data without language generation:

- Per-account: monthly interest cost (`balance × APR ÷ 12`), revolving utilization (`|balance| ÷ creditLimit`), days since last sync, connection health enum
- Cross-account: total monthly interest burden, total consumer debt, total secured debt, weighted average APR, liquid cash total, debt-to-income ratio, committed obligation ratio
- Cash flow: net cash flow classification (`SURPLUS / NEUTRAL / DEFICIT`), deficit cause classification (`INTENTIONAL_DEBT_PAYOFF / OVERSPENDING / INCOME_SHOCK / MIXED`)
- Trajectory: net worth direction (`INCREASING / DECLINING / FLAT`), net worth cause classification (`STRATEGIC_DEBT_PAYOFF / STRUCTURAL_DETERIORATION / MARKET_FLUCTUATION / MIXED`)
- Goal status: per-goal on-track enum (`AHEAD / ON_TRACK / BEHIND / AT_RISK`), required monthly contribution vs. actual, completion estimate at current velocity
- Liquidity: months covered at current spending, emergency fund coverage percentage, available revolving credit buffer
- Risk flags: knowledge gaps (null APR, null minimum payment), stale connections, accounts needing reauth, goal conflicts (combined required contributions exceed discretionary margin)
- Capital allocation hierarchy position: which step in the standard framework is the current recommended focus

**What absolutely should NOT be in this layer:**

- Priority judgments about which domain matters most to THIS user. "Biggest risk" is a judgment call, not a measurement. A threshold breach in Liquidity is a fact; declaring it "the biggest risk" requires knowing the user's goals, risk tolerance, and context. That is LLM territory.
- Natural language framing of any kind. The layer outputs structured data, not sentences.
- Recommendations. A recommendation is a judgment synthesizing multiple domain states. The annotation layer classifies individual states; recommendations require cross-domain synthesis that the LLM does with the annotated context as input.
- Confidence scores on individual metrics that are derived from hard math. Monthly interest cost at a known APR is exact. Estimated monthly income from transaction inflows is noisy. These have different epistemic statuses and should be labeled, not averaged into a single `confidence` field.

---

## 3. Q2 — Should Reasoning Modules replace Financial Reasoning Modules? Would Playbooks better represent how a CFP thinks?

**"Playbooks" is the wrong mental model. "Reasoning Modules" is correct. Here is the distinction.**

A playbook prescribes a fixed response to a recognized pattern. If situation matches condition A, execute play 3. This is appropriate in domains where patterns are exhaustive and situations are predictable. Financial advisory is not that domain.

The failure mode of the playbook model is rigidity at edge cases. A user with 24.99% APR credit card debt and a $50,000 inheritance arriving in 60 days should not receive the "eliminate high-APR debt immediately" playbook. The standard capital allocation hierarchy (which IS a playbook) gives the wrong answer because the user's specific situation changes the calculus. A CFP with decades of experience does not look up which play to run — they apply a framework to a specific situation and reason about the exceptions.

What a Reasoning Module does is different from a playbook. It injects a framework — a set of relationships, priorities, and doctrines — into the AI's reasoning context, then lets the AI apply that framework to the specific situation. The module says "when evaluating debt: compute monthly interest cost, rank by APR, note that debt payments are intentional capital allocation not expenses." It does not say "recommend avalanche payoff." The AI applies the framework to what it sees.

The six modules defined in `D4_FINANCIAL_REASONING_ARCHITECTURE.md` are correctly designed. The names (DEBT_HEALTH, LIQUIDITY, CASH_FLOW, WEALTH, AFFORDABILITY, DEBT_VS_SAVINGS) are more precise than "debt doctrine" or "liquidity doctrine" because they name the domain they address, not the philosophy they express.

**What the existing module design gets wrong:**

Module selection in the D4 architecture is injection-based — modules are added to the system prompt based on Space category and detected intent. This means the LLM always receives the same module content regardless of the user's specific state. A module that says "check if emergency fund is below 3 months" is redundant if the annotated context already says `liquidityClassification: "CRITICAL"`. The module should be adaptive — its injected content should vary based on what the annotations already say.

Example: the LIQUIDITY module should have two variants. When liquidity is `SAFE` or `EXCELLENT`, the injected doctrine is brief: "Liquidity is healthy. You can treat it as a given in this conversation unless the user asks about it specifically." When liquidity is `WARNING` or `CRITICAL`, the full doctrine is injected: "Liquidity is the most important near-term indicator. Lead with it. Do not recommend debt payoff acceleration, investment contributions, or major purchases without noting the liquidity constraint."

This state-aware module injection is the gap between what has been designed and what a professional advisor actually does. A CFP does not recite the emergency fund doctrine to every client regardless of their emergency fund status. They focus on what is actually relevant.

---

## 4. Q3 — Should there be a deterministic FinancialAssessment object generated every request?

**Yes, but not as you have described it. The proposed field design conflates measurement with judgment in a way that will break the layer's deterministic guarantee.**

Your proposed fields:

```
biggestRisk         → judgment call
biggestOpportunity  → judgment call  
biggestConstraint   → judgment call
biggestWin         → judgment call
recommendedPriority → recommendation (not assessment)
confidence         → ambiguous — confidence in what, exactly?
```

Every one of these requires deciding which of several domain states is most important. That decision is the LLM's job. If you compute it deterministically, you are encoding a financial philosophy into your classification logic (which is fine for domain-specific things like "critical APR threshold") but not appropriate for cross-domain prioritization (which requires knowing whether the user cares more about debt elimination or liquidity building — a preference, not a mathematical fact).

**What a FinancialAssessment object should actually contain:**

```typescript
interface FinancialAssessment {
  // Domain-specific classifications (deterministic)
  liquidity:     LiquidityAssessment;
  debtHealth:    DebtHealthAssessment;
  cashFlow:      CashFlowAssessment;
  goalProgress:  GoalProgressAssessment;
  wealthTrend:   WealthTrendAssessment | null; // null if no investment/snapshot data

  // Risk flags (deterministic threshold breaches)
  activeRisks:   RiskFlag[];        // ordered by severity, not by which is "biggest"
  knowledgeGaps: KnowledgeGap[];    // null APRs, missing data

  // Capital allocation position (deterministic)
  capitalHierarchyPosition: number; // which step in the 7-step hierarchy is current focus
  capitalHierarchyLabel:    string; // "Step 2: Eliminate high-APR consumer debt"

  // What changed since last assessment (deterministic, requires prior snapshot)
  sinceLastSession: ChangeLog | null; // "Chase balance fell $340, emergency fund +$200"
}
```

Each domain assessment is typed with its own precise fields:

```typescript
interface LiquidityAssessment {
  liquidCashTotal:          number;
  monthsCovered:            number;
  classification:           "CRITICAL" | "WARNING" | "SAFE" | "EXCELLENT";
  emergencyFundCoveragePct: number | null;  // null if no EMERGENCY_FUND goal
  availableRevolvingCredit: number;
  trendDirection:           "IMPROVING" | "DECLINING" | "FLAT";
}

interface DebtHealthAssessment {
  totalConsumerDebt:       number;
  totalSecuredDebt:        number;
  weightedAverageAPR:      number | null;  // null if any APR is missing
  monthlyInterestBurden:   number | null;
  debtToIncomeRatio:       number | null;
  revolvingUtilization:    number | null;
  payoffVelocity:          number | null;  // monthly payment ÷ total consumer debt
  classification:          "CRITICAL" | "WARNING" | "IMPROVING" | "HEALTHY";
  hasNullAPR:              boolean;         // precision flag for the LLM
}
```

The LLM receives these structured assessments and synthesizes the cross-domain picture. It decides which assessment is most relevant to the user's question. The deterministic layer does not make that judgment — it provides the data for the judgment.

**The `confidence` field problem:**

Dropping a single `confidence` field on `FinancialAssessment` conflates three different types of uncertainty:

1. Data completeness uncertainty — if APR is null for two of four debt accounts, the DebtHealthAssessment is incomplete. This is known and quantifiable: `hasNullAPR: true`.
2. Estimation uncertainty — income estimated from transaction inflows has noise. This should be flagged per-metric, not averaged into a global confidence score.
3. Recommendation uncertainty — whether the recommended action is correct for this user's situation. This is inherently LLM territory and should not be precomputed.

Instead of a global `confidence` field, each metric that involves estimation should carry an `estimated: true` flag and an explanation. The LLM is instructed: "When presenting an estimated metric, note that it is an approximation based on [method] and suggest the user confirm it."

---

## 5. Q4 — What should be computed before the LLM ever sees context? Draw the architectural boundary precisely.

**The boundary is: if it requires language, it belongs to the LLM. If it requires math or lookup, it belongs to the deterministic layer.**

**Deterministic side (before LLM):**

| Computation | Input | Output |
|---|---|---|
| Monthly interest cost per account | `balance × APR ÷ 12` | `number | null` |
| Total monthly interest burden | Sum of above | `number | null` |
| Revolving utilization per account | `|balance| ÷ creditLimit` | `number` |
| Liquidity months covered | `liquidCash ÷ estimatedMonthlyExpenses` | `number` |
| Emergency fund coverage % | `liquidCash ÷ goal.targetAmount` | `number | null` |
| Net cash flow classification | Sign and magnitude of `inflow - outflow` | `SURPLUS / NEUTRAL / DEFICIT` |
| Deficit cause classification | Ratio of `debtPaymentTotal` to `netCashFlow` + active goal check | `INTENTIONAL / OVERSPENDING / MIXED` |
| Net worth direction | 90-day snapshot slope | `INCREASING / DECLINING / FLAT` |
| Net worth cause classification | Asset and liability trend cross-reference | `STRATEGIC_DEBT_PAYOFF / etc.` |
| Goal on-track status per goal | Required rate vs. actual rate | `AHEAD / ON_TRACK / BEHIND / AT_RISK` |
| Capital allocation hierarchy position | 7-step lookup given current state | `number` (1–7) |
| Risk flags | Threshold breach detection | `RiskFlag[]` |
| Knowledge gaps | Null field detection on debt accounts | `KnowledgeGap[]` |
| Today's date | System clock | `string` |
| Module selection | Keyword match + Space category + assessment state | `ReasoningModule[]` |

**LLM side (not deterministic):**

- All natural language generation, including framing of assessment results
- Cross-domain synthesis ("your negative cash flow combined with your goal progress and liquidity position means...")
- Causal explanation of why a state exists and what it means for this user's situation
- Trade-off judgment when multiple valid strategies exist
- Tone calibration based on the combined picture
- Handling of anything outside the defined financial domains
- Deciding which of the computed assessments is most relevant to the user's specific question — the LLM receives all assessments and routes toward the relevant ones based on intent

**The boundary violation to avoid more carefully than in the existing design:**

The existing `D4_FINANCIAL_REASONING_ARCHITECTURE.md` proposes a `Stability Score` that is a weighted composite of Liquidity (40%), DTI headroom (30%), and Cash Flow Surplus (30%). The document immediately says "Informational only — never display as a number to the user." This is the right instinct followed by the wrong implementation. A weighted composite with arbitrary weights is not a measurement — it is an editorial judgment. The 40/30/30 split encodes a financial philosophy that is not derivable from math. That is fine if it is explicit doctrine injected into the LLM's reasoning context. It is wrong if it is presented as a deterministic computation. Remove the composite score. Expose the three component classifications separately. Let the LLM apply the weights contextually.

---

## 6. Q5 — Is the current Context Builder exposing data too early? Should it expose interpreted financial state instead?

**Yes, and the existing investigation knows it. The gap is that the fix is half-designed.**

`D4_CONVERSATION_QUALITY_INVESTIGATION.md` identifies this precisely as W4: "Context serialized as raw JSON — the model reads data, not meaning." The proposed fix is rewriting `serializeContextBlock()` with per-field formatting and annotations. That is the right direction.

The problem is that annotation-at-serialization time is late. If the annotation happens at serialization (converting the assembled context to a string for the prompt), the annotations are embedded in text that the LLM must parse to extract structure. The annotations should happen as a structured pass between assembly and serialization:

```
Assembly (SpaceContext_AI — typed domains)
    ↓
Financial Intelligence Pass (FinancialAssessment — typed annotations)
    ↓
Serialization (annotated text blocks — not raw JSON dumps)
    ↓
LLM
```

The serialized form the LLM receives should not be JSON at all. It should be a structured text format — closer to what a financial analyst would write in a briefing document than what a database would emit. Each domain section should have a human-readable header, the classified state prominently placed, supporting numbers subordinated:

```
LIQUIDITY ASSESSMENT
Classification: WARNING (2.1 months covered)
Liquid Cash: $5,460 (checking $3,200 + savings $2,260)
Monthly Expense Estimate: $2,600 (from 90-day average)
Emergency Fund: 57% of $9,600 goal
Available Revolving Credit: $4,200 (backup buffer only)
Trend: DECLINING (-$420 over 30 days)
Note: Emergency fund progress is an active goal — this is intentional construction, not a shortfall.
```

That is what a CFP reads. Not `{"liquidCash":5460,"monthsCovered":2.1,"emergencyFundPct":0.57}`.

The difference is not cosmetic. Dense JSON trained into a prompt teaches the model to treat all fields as equally weighted data points. Formatted text with classification labels prominent teaches the model that the classification is the finding and the numbers are the evidence.

---

## 7. Q6 — Design the complete architecture for an advisor that behaves like a CFP with decades of experience

The architecture has five layers, not four. The existing design collapses two distinct responsibilities into one.

---

### Layer 0: Intent & Routing (deterministic, ~0ms)

Keyword-based classification of the user's question into one of eight intents. This runs before context assembly.

Outputs:
- `detectedIntent`: controls temporal frame (current-state vs. historical) and module selection priority
- `scopeHint`: 'brief' (state questions) vs. 'full' (analytical questions)
- `temporalFrameLabel`: injected into system prompt to orient the LLM before it receives context

This layer already exists in `D4_FINANCIAL_REASONING_ARCHITECTURE.md` §6 but is underspecified in one way: intent is currently detected from the last user message only. At session turn 3 or 4, the question "should I do this?" is ambiguous without knowing what "this" refers to from prior turns. The intent classifier needs a short rolling context window — the last 2–3 user messages — not just the current one. This is the only place in the architecture where conversation history is relevant; the rest of the context is stateless per-request.

---

### Layer 1: Context Assembly (permission-gated, database-queried)

The existing Context Builder as designed in `D4_AI_CONTEXT_BUILDER_INVESTIGATION.md`. Unchanged in structure.

Outputs: `SpaceContext_AI` — typed domain sections (accounts, transactions, snapshot, goals, providers, holdings, health).

**The one design decision this layer gets wrong that is worth fixing here:**

The `scopeHint` ('brief' vs. 'full') controls how much data each assembler returns, but the distinction between brief and full is currently at the assembler level. The better design is to control it at the domain level. A "brief" snapshot is last-30-days; a "full" snapshot is last-90-days. A "brief" transactions section is only category totals; a "full" transactions section is totals plus per-category trend. The assembler should accept a `detail` parameter rather than the caller making two separate requests.

---

### Layer 2: Financial Intelligence (deterministic, in-memory, no additional DB queries)

Runs synchronously after assembly on the already-assembled `SpaceContext_AI`. No database queries — all inputs come from the assembled domains. This is the "Financial Diagnosis" layer in your proposal, more precisely named.

Computes the `FinancialAssessment` object as specified in Q3 above.

**The key implementation rule this layer must enforce:** every computed field that involves estimation rather than precise measurement must carry a precision flag. Income estimation from transaction inflows is noisy. Monthly expense estimation from transaction averages is noisy. Debt payoff velocity from payment patterns is noisy. These must be flagged as `estimated: true` with an `estimationMethod` note. The LLM uses this to calibrate how confidently it presents the finding.

**What is added beyond the existing D4 design:**

`D4_FINANCIAL_REASONING_ARCHITECTURE.md` proposes pre-computed annotations without specifying how they are surfaced to the LLM. They are described as things to "inject" but the mechanism is vague. The specification here is: the Financial Intelligence Pass produces a typed `FinancialAssessment` object that is:

1. Passed to the module selector (Layer 3 input)
2. Serialized as labeled text blocks for the system prompt (distinct from the raw context blocks)
3. Available as structured data to any future capability that needs it without re-running assembly

---

### Layer 3: Reasoning Module Selection & Prompt Assembly (deterministic)

Two functions:

**Module selector:** Takes `detectedIntent + FinancialAssessment + spaceCategory` and returns a ranked list of up to three Reasoning Modules. Module selection is state-aware: the LIQUIDITY module has two variants (liquidity is safe → brief; liquidity is warning/critical → full doctrine). This is the gap in the existing module design.

**System prompt assembler:** Combines:
- Static preamble (date, ADVISOR_PRINCIPLES)
- Selected reasoning modules (injected as labeled text sections, max 3)
- Temporal frame instruction (current-state or historical mode)
- FinancialAssessment as structured summary blocks (not JSON)
- Raw domain context as annotated text blocks (not JSON)
- Knowledge gap prompt if any gaps exist

The existing design puts all of this in `route.ts` which has grown to own too many responsibilities. At scale, prompt assembly should be a dedicated function: `buildSystemPrompt(assessment, modules, context, intent, knowledgeGaps)`.

---

### Layer 4: LLM Reasoning

Receives the assembled system prompt and user message. Responsible for: language generation, cross-domain synthesis, causal explanation, trade-off judgment, tone calibration.

**What the LLM must never do:**

- Calculate (the annotations already did it)
- Classify a financial state (the assessment already did it)
- Decide what to lead with based on data prominence (the temporal frame doctrine tells it what to lead with)
- Speculate about data it does not have (knowledge gap protocol handles this)

---

### Layer 5: Financial Memory (persistent, session-spanning)

Currently partially implemented via `AiAdvice` rows and `DebtProfile` user-confirmed values.

At this layer's full design, the AI should know:
- What it recommended previously and what the outcome was
- Which knowledge gap values the user has confirmed vs. which remain missing
- Whether the user's stated goals have changed since the last session

The memory layer is not conversation history. It is financial state history — the delta between this session's `FinancialAssessment` and the prior session's. This is what allows the AI to say "last session your Chase balance was $4,800. It is now $4,200. You have made $600 of progress since we last spoke." That observation requires persistent storage of prior assessment values, not conversation transcripts.

---

### The complete data flow

```
User message (+ rolling 2-3 turn context for disambiguation)
    │
    ↓ [Layer 0 — ~0ms]
Intent Classifier
    │  detectedIntent, scopeHint, temporalFrameLabel
    │
    ↓ [Layer 1 — async, DB queries]
Context Assembler
    │  SpaceContext_AI (typed domain sections)
    │
    ↓ [Layer 2 — sync, in-memory]
Financial Intelligence Pass
    │  FinancialAssessment (typed per-domain + cross-domain)
    │
    ↓ [Layer 3 — sync, ~0ms]
Module Selector + Prompt Assembler
    │  system prompt (date + principles + modules + assessment + context)
    │
    ↓ [Layer 4]
LLM
    │  streaming response
    │
    ↓ [Layer 5 — async, post-response]
Financial Memory Writer
    │  persist assessment delta to AiAdvice + update DebtProfile
```

---

## 8. Q7 — Does this architecture scale to Business, Household, Property, Investment, Retirement, Tax, Marketplace?

**No, not as currently designed. Here is precisely where it breaks and how to fix it.**

The financial concept schemas in `D4_FINANCIAL_REASONING_ARCHITECTURE.md` — Debt Health, Liquidity, Cash Flow Health, Capital Allocation, Emergency Readiness — are household personal finance frameworks. They work for Personal, Household, and Debt-focused Spaces. They break for the following domains:

---

**Business Spaces:**

A business does not have an "emergency fund" in the household sense. It has runway (months of operating expense coverage at current burn rate). It does not have "cash flow health" in the household three-bucket model — it has revenue, COGS, gross margin, operating expenses, EBITDA, and net cash burn/generation. It does not have revolving credit utilization — it has accounts receivable aging and payables due.

The entire vocabulary is different. The capital allocation hierarchy (employer match → high-APR debt → emergency fund → retirement → moderate-APR debt → taxable investment → low-APR debt) does not apply to a business. The business equivalent is: operating reserves → high-interest business debt → growth investment → owner distributions.

A Business Space needs a `BusinessIntelligencePass` that computes:
- Runway months (`liquidBusinessAssets ÷ monthlyBurnRate`)
- Gross margin % and trend
- Payroll coverage ratio
- AR days outstanding
- Revenue vs. prior period
- Cash burn classification (`INVESTING_GROWTH / SUSTAINABLE / CONCERNING / CRITICAL`)

The Reasoning Modules for a Business Space are: RUNWAY, CASH_BURN, MARGIN, PAYROLL_COVERAGE, BUSINESS_DEBT — completely different from the personal finance modules.

---

**Property Spaces:**

Real estate has its own vocabulary: LTV (loan-to-value ratio), NOI (net operating income), cap rate, debt service coverage ratio (DSCR), vacancy rate, depreciation schedule. None of these map to household financial concepts.

A Property Space's intelligence pass computes:
- LTV: `mortgageBalance ÷ estimatedPropertyValue` (the latter requires user-confirmed or estimated value)
- Monthly NOI: `rentalIncome - operatingExpenses` (if rental)
- Equity: `estimatedValue - mortgageBalance`
- DSCR: `NOI ÷ debtServicePayments`

The reasoning modules are: EQUITY_BUILD, INVESTMENT_PROPERTY_CASH_FLOW, REFINANCE_READINESS (when LTV drops below 80%).

---

**Retirement Spaces:**

A Retirement Space has specific concerns that personal finance modules do not address: sequence of returns risk, safe withdrawal rate, required minimum distributions (RMDs), Social Security optimization, Roth conversion windows. These require their own module definitions. The capital allocation hierarchy inverts somewhat — in drawdown phase, the hierarchy focuses on sequence risk preservation rather than debt elimination.

---

**Tax Spaces:**

Tax is a fundamentally different domain — it is not about financial state assessment but about optimization of an annual process. The intelligence layer for a Tax Space would compute estimated effective rate, estimated quarterly payments due, estimated deduction availability. The reasoning modules are about optimization strategies, not ongoing health monitoring.

---

**The architectural implication:**

The Financial Intelligence Layer cannot be a single function that runs for every Space. It must be domain-routed:

```typescript
function buildFinancialAssessment(
  context: SpaceContext_AI,
  spaceCategory: SpaceCategory,
): FinancialAssessment {
  const domainClass = getDomainClass(spaceCategory);
  // domainClass: 'PERSONAL_FINANCE' | 'BUSINESS' | 'PROPERTY' | 'RETIREMENT' | 'TAX'

  switch (domainClass) {
    case 'PERSONAL_FINANCE':
      return buildPersonalFinanceAssessment(context);
    case 'BUSINESS':
      return buildBusinessAssessment(context);
    case 'PROPERTY':
      return buildPropertyAssessment(context);
    case 'RETIREMENT':
      return buildRetirementAssessment(context);
    case 'TAX':
      return buildTaxAssessment(context);
  }
}
```

Each domain class produces a typed assessment with domain-appropriate fields. The `FinancialAssessment` interface becomes a union type, not a universal object. The Reasoning Modules are organized by domain class, not as a flat list. Module injection is `domainClass + intent → selectedModules`, not `spaceCategory + intent → selectedModules`.

This domain-class routing is the single most important architectural decision for long-term scale. Without it, the system will work for the most common Space types and silently fail for others — giving a household emergency-fund lecture to a business owner asking about their runway.

The Space categories that exist today and their domain class mapping:

| SpaceCategory | Domain Class |
|---|---|
| PERSONAL, HOUSEHOLD, FAMILY, DEBT_PAYOFF, DEBT_REDUCTION, EMERGENCY_FUND, SAVINGS | PERSONAL_FINANCE |
| BUSINESS, FREELANCE, STARTUP | BUSINESS |
| PROPERTY, REAL_ESTATE | PROPERTY |
| RETIREMENT | RETIREMENT |
| INVESTMENT | INVESTMENT |
| GOAL (legacy) | PERSONAL_FINANCE (fallback) |

The Marketplace domain class should be deferred explicitly — its financial intelligence requirements are unknown until the marketplace product is defined.

---

## 9. Q8 — Be critical. Challenge assumptions in both the prior investigations and the proposal.

---

**Assumption 1: "The LLM should explain and personalize — not discover."**

This is correct as a direction but overstated as a clean separation. The LLM must still make judgment calls that the deterministic layer cannot make:

- Which of several threshold breaches is most actionable for this user right now?
- When multiple valid strategies exist (debt payoff vs. savings), which is better for THIS user given their risk tolerance and stated goals?
- When the user asks an ambiguous question, how should it be interpreted?

The deterministic layer eliminates a large class of rediscovery — computing APR math, classifying cash flow states, detecting goal conflicts. But cross-domain synthesis, prioritization of competing recommendations, and adaptation to user-specific circumstances remain LLM responsibilities. Calling this "explain and personalize" understates the remaining reasoning burden.

**The risk of overspecifying the deterministic layer:** If the Financial Intelligence Pass pre-computes "biggest risk" and passes it to the LLM as a fact, the LLM may defer to it even when the user's question context suggests a different domain is more relevant. The deterministic layer should report state and flags; it should not prioritize them. Prioritization is context-sensitive in a way that keyword-matching cannot capture.

---

**Assumption 2: "Every response should begin from a deterministic FinancialAssessment object."**

The FinancialAssessment object should be assembled on every request. Whether every RESPONSE begins from it is different. A user who says "what was my highest spending category in October?" is asking a pure historical lookup. The response should lead with the answer, not with a FinancialAssessment summary. Forcing every response to begin with the assessment creates a conversational pattern that will feel formulaic and advisor-like in a bad way — like a doctor reciting your vital signs before answering your question about your headache.

The assessment should inform every response (the LLM knows the full financial picture) but should be surfaced directly only when the question is about overall financial health, or when a critical flag (CRITICAL liquidity, CRITICAL debt-to-income) is present regardless of the question asked. The LIQUIDITY module doctrine already specifies this correctly: "Below 3 months: mention it. Below 1 month: lead with it." That is the right behavior — contextual surfacing, not mandatory recitation.

---

**Assumption 3: "A CFP does not rediscover financial principles from raw balances every conversation."**

True, but the analogy has a limit. A CFP also carries knowledge of the specific client across sessions — they remember the conversation from last quarter, the family situation mentioned last month, the career change discussed in the spring. The LLM does not have this. The Financial Memory layer (Layer 5) compensates by persisting financial state deltas, but it cannot persist the qualitative knowledge a long-term CFP relationship accumulates.

This is not a flaw to fix — it is a boundary condition to acknowledge. Fourth Meridian should not position itself as equivalent to a long-term CFP relationship. It can position itself as equivalent to a CFP's first meeting with a new client, where the full picture is assembled fresh each time but the professional framework is applied consistently. That is already a substantial improvement over what currently exists.

---

**Assumption 4 (from the prior investigations): "Intent classification is keyword-based and sufficient."**

Keyword matching will correctly classify approximately 70–75% of intents in a financial conversation. The remaining 25–30% are either ambiguous ("what should I do?"), compound ("is my debt high and should I pay it or save?"), or context-dependent ("should I do this?" at turn 3 of a debt conversation). For those cases, keyword classification fails silently — it returns a best-guess intent that may be wrong.

The correct architecture: keyword-based classification as the default, with a fallback to `CURRENT_STATE` intent (safest default) when confidence is low, and a short rolling context window (2–3 prior turns) for disambiguation. Do not introduce an NLU model for intent classification — the latency cost and maintenance overhead are not justified for eight intent types. Keyword matching with rolling context is sufficient and measurable.

---

**Assumption 5 (from the prior investigations): "Reasoning Modules should be injected at max 3 per turn."**

The three-module limit is the right call for token efficiency. But the existing design does not address what happens when a user switches domains mid-conversation. If the first two turns were about debt health (DEBT_HEALTH + CASH_FLOW modules active) and turn 3 asks "by the way, is my emergency fund adequate?", the intent classifier will correctly identify the LIQUIDITY module but now needs to decide whether to replace the current modules or add to them. Adding risks crowding; replacing loses continuity.

The correct approach: re-run module selection on every turn, do not accumulate modules across turns. The intent classifier re-evaluates from the current message (+ rolling 2-turn context for disambiguation). Fresh module selection is correct and cheap. Accumulated module state is complex and wrong — it assumes each question builds directly on the prior ones, which financial conversations often do not.

---

**Assumption 6 (from this proposal): "The architecture needs another layer."**

Adding a layer is the right call. But the problem is not primarily architectural — it is implementational. The four-layer architecture was defined in `D4_FINANCIAL_REASONING_ARCHITECTURE.md` today. Layers 1 and 2 are partially built (context builder exists, annotations exist for some fields). Layers 3 and 4 (modules, annotated serialization) are designed but not implemented.

The biggest risk is designing a fifth layer before the four designed layers are fully implemented. The `deficit_cause_classification` annotation has been designed twice (in the conversation quality investigation and the reasoning architecture investigation). It is not implemented. The snapshot domain is missing from the manifest for most Space categories — a one-line fix that has been identified but not applied. The date injection is missing from the system prompt — a two-line fix.

Before designing a FinancialAssessment object, the existing Tier 1 prompt changes (temporal doctrine, debt payment doctrine, date injection, knowledge acquisition carve-out) should ship. They require no schema change, no new assembler, no migration. They address four of the five observed failure modes immediately. If those changes eliminate the observed failures, the architecture for Layers 2 and 3 can be iterated. If failures remain, the specific failures that remain will be clearer targets for the annotation and assessment work.

The danger of building the full Financial Intelligence Layer before the simplest fixes ship is that the simplest fixes' effects are unknowable. If temporal doctrine alone fixes 60% of observed quality issues, the scope of the annotation work can be calibrated accordingly. If it fixes only 20%, a more aggressive annotation pass is justified. Design informed by evidence is better than design in advance of it.

---

## 10. The recommended architecture stated precisely

This section states the complete recommended architecture without qualification, as a definitive proposal.

### Layers

**Layer 0: Intent & Routing** — keyword-based, rolling 2-turn context window, eight intent types, `~0ms`. Outputs: `detectedIntent`, `scopeHint`, `temporalFrameLabel`.

**Layer 1: Context Assembly** — permission-gated, domain-scoped, `scopeHint`-aware assemblers. Outputs: `SpaceContext_AI`. Unchanged from the existing design.

**Layer 2: Financial Intelligence Pass** — domain-class-routed, synchronous, in-memory. Computes `FinancialAssessment` as a domain-typed union (PERSONAL_FINANCE / BUSINESS / PROPERTY / RETIREMENT / INVESTMENT). Fields: per-domain typed assessments, `RiskFlag[]` ordered by severity, `KnowledgeGap[]`, `capitalHierarchyPosition`, precision flags on estimated metrics.

**Layer 3: Module Selection + Prompt Assembly** — state-aware module selection (module variants based on assessment state, not just Space category + intent). Max 3 modules. Serializes context as formatted annotated text, not JSON. Assembles system prompt with date, ADVISOR_PRINCIPLES, modules, assessment summary, domain context blocks.

**Layer 4: LLM Reasoning** — receives the assembled prompt. Explains, synthesizes, personalizes. Does not calculate, classify, or prioritize.

**Layer 5: Financial Memory** — persists per-request `FinancialAssessment` delta to enable "since last session" observations. Does not persist conversation history. Writes `AiAdvice` rows with assessment snapshot.

### What the existing design adds that this critique endorses

- The nine financial concepts defined in `D4_FINANCIAL_REASONING_ARCHITECTURE.md` (Debt Health through Goal Progress) are correctly designed for the PERSONAL_FINANCE domain class. They become the implementation targets for the Financial Intelligence Pass, personal finance variant.
- The six Reasoning Modules (DEBT_HEALTH, LIQUIDITY, CASH_FLOW, WEALTH, AFFORDABILITY, DEBT_VS_SAVINGS) are correctly designed. The addition here is state-aware variants per module.
- The temporal frame doctrine stated in `D4_FINANCIAL_REASONING_ARCHITECTURE.md` §7 is correct as written and should ship immediately as a Tier 1 prompt change.
- The capital allocation hierarchy in §3.8 of that document is the correct philosophical foundation for the PERSONAL_FINANCE domain class. It should be injected explicitly as a Tier 1 system prompt addition.

### What this critique adds that the existing design does not have

- Domain-class routing in the Financial Intelligence Pass (PERSONAL_FINANCE / BUSINESS / PROPERTY / RETIREMENT / INVESTMENT)
- State-aware Reasoning Module variants (module content varies based on the assessment, not just the intent)
- Typed `FinancialAssessment` as a distinct structured object, not embedded annotations in the context serialization
- Rolling 2-turn context window for intent disambiguation
- Per-metric precision flags for estimated values
- Explicit rejection of cross-domain "biggest X" fields from the deterministic layer — that judgment belongs to the LLM
- Re-running module selection per turn, not accumulating modules across turns
- `sinceLastSession` delta object in the Financial Memory layer, derived from assessment persistence
- The explicit sequencing instruction: ship Tier 1 prompt changes first, evaluate effect, then implement the annotation layer

### The architecture that makes sense at millions of users and dozens of financial domains

The core structure does not change at scale. What changes is the breadth of domain classes and the depth of each class's concept schemas, reasoning modules, and context assemblers.

At millions of users, the deterministic layers (0, 2, 3) are horizontally scalable without coordination — each request is stateless within those layers. The only stateful component at scale is Layer 5 (Financial Memory), which writes per-request to the `AiAdvice` table. That table should be treated as a time-series at scale, with a retention policy (e.g., last 90 days of assessments per Space) rather than unbounded growth.

At dozens of financial domains, the architecture scales through domain-class routing. Each new domain class (e.g., Tax) requires: a new `SpaceCategory` group, a new domain-class-specific context assembler set (or extension of existing assemblers), a new Financial Intelligence Pass variant with domain-appropriate concept schemas, and a new set of Reasoning Modules. These additions are isolated — they do not touch the personal finance domain class or the core architectural layers. This is the key property that makes the architecture scalable: additions are additive, not modifications.

The only architectural component that does not scale cleanly with new domains is the `SpaceContext_AI` type, which currently has all domains as optional fields on a single interface. At scale, a typed union per domain class is more maintainable. That refactor is not urgent — it is a correctness improvement that becomes valuable when Business and Property domain classes are implemented, not before.

---

## 11. Implementation sequencing recommendation

In priority order, not all at once:

1. **Ship Tier 1 prompt changes immediately.** Temporal frame doctrine, debt payment doctrine, date injection, knowledge acquisition carve-out, snapshot manifest fix. No schema, no migration, no new assembler. These address the majority of observed failures. The scope of remaining work depends on their effect.

2. **Implement the Financial Intelligence Pass for the PERSONAL_FINANCE domain class.** Start with the five highest-leverage annotations: `deficitCauseClassification`, `netWorthCauseClassification`, `liquidityMonthsCovered`, `totalMonthlyInterestBurden`, `goalOnTrackStatus`. These drive the most common advisory failures.

3. **Implement state-aware Reasoning Modules.** The two-variant LIQUIDITY module (safe vs. warning) is the highest-value addition. Implement DEBT_HEALTH and CASH_FLOW second.

4. **Implement annotated context serialization.** Replace `JSON.stringify()` with formatted labeled text blocks.

5. **Implement Financial Memory.** Assessment delta persistence enables "since last session" observations.

6. **Define BUSINESS domain class.** Only when a Business Space has real users and specific failures to address.

7. **Define PROPERTY and RETIREMENT domain classes.** Sequenced the same way — real users, observed failures.

---

## 12. Sign-off

This document makes no code changes.

The core observation driving this investigation is correct: the AI is doing too much reasoning from raw materials and not enough applying a pre-built professional framework. The proposed intermediate layers are the right architectural response.

The critique is: the existing D4 investigations have already designed most of what is proposed, the FinancialAssessment object needs structural refinement before it is built, the domain-class routing is the missing piece for long-term scale, and the highest-impact changes require no new architecture at all — they require shipping Tier 1 prompt changes that are already fully specified.

The architecture recommended here is the same four-five layers — intent classification, context assembly, financial intelligence, reasoning modules, LLM — with three additions: domain-class routing in Layer 2, state-aware module variants in Layer 3, and assessment persistence in Layer 5. Everything else is already designed.
