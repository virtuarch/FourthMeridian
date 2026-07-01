> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D4 — Financial Reasoning Architecture Investigation

**Status: Investigation only. No schema, migration, API route, UI, or application code was modified.**
**Date: 2026-07-01**
**Branch: feature/phase-2-architecture**

---

## 0. Document control

| | |
|---|---|
| Parent documents | `docs/initiatives/d4/D4_AI_CONTEXT_BUILDER_INVESTIGATION.md`, `docs/initiatives/d4/D4_CONVERSATION_QUALITY_INVESTIGATION.md`, `docs/initiatives/d4/D4_KNOWLEDGE_GAPS_INVESTIGATION.md` |
| Scope | Financial reasoning architecture — CFP mental model, financial concept schemas, reasoning module design, deterministic/LLM boundary, intent layer, scale architecture |
| Does NOT duplicate | The conversation quality investigation already diagnosed root causes W1–W12 and proposed a Tier 1–6 roadmap. This document answers what should replace improvised LLM reasoning: a formal financial reasoning philosophy that the AI is trained on at system-prompt construction time. |
| Governing docs | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` (§12), `docs/architecture/PHASE_2_DECISION_MATRIX.md` (D4) |
| Confirmed sources read | `lib/ai/context-builder.ts`, `lib/ai/assemblers/accounts.ts`, `lib/ai/assemblers/transactions.ts`, `lib/ai/assemblers/snapshot.ts`, `lib/ai/assemblers/goals.ts`, `lib/ai/domain-manifest.ts`, `lib/ai/signals/types.ts`, `app/api/ai/chat/route.ts`, `prisma/schema.prisma` (relevant models) |

---

## 1. The problem this document addresses

The conversation quality investigation established that the AI behaves like a **reporting engine** — it reads data and summarizes it — rather than a **financial advisor** — one who evaluates data through a professional framework and produces a judgment. The root causes were diagnosed (W1–W12). The Tier 1–3 fixes were proposed (temporal doctrine, debt payment doctrine, reasoning modules).

What was not specified is the content of those reasoning modules — the actual financial philosophy that should govern how the AI thinks. A financial advisor's value is not in knowing that a client has $4,200 in credit card debt. It is in knowing immediately, without calculation, what that means in the context of their income, their liquidity, their other obligations, and their goals.

This investigation asks: "If Fourth Meridian hired a CFP with 30 years of experience to train the AI, what concepts would they teach first?" and translates those concepts into a formal architecture.

---

## 2. How a CFP thinks: the mental evaluation sequence

A certified financial planner does not evaluate financial health linearly. They assess categories simultaneously and in priority order. The order matters because it mirrors urgency and action-ability.

### 2.1 The CFP's first evaluation: liquidity before everything

Before a CFP says anything about debt, investments, or goals, they silently ask one question: **can this household survive a financial shock today?** This is the liquidity check. Not net worth. Not debt-to-income. Not investment allocation. Liquidity.

The CFP's mental sequence:

1. **How much liquid cash is available right now?** (Checking + savings + money market. Not brokerage. Not home equity. Not retirement.)
2. **How many months of essential expenses does that cover?**
3. **Is there an open credit line as backup liquidity?** (A paid-off credit card counts here — available credit, not utilization.)
4. **Are there any imminent cash obligations in the next 30–90 days?** (Upcoming large bills, known expenses, minimum payments.)

Only after answering these four questions does the CFP engage the rest of the financial picture. This is not just a style preference — it is the professionally correct priority because illiquidity is the cause of most personal financial crises. High debt loads are survivable. Investment losses are survivable. Running out of liquid cash while obligations are due is not.

**Fourth Meridian implication:** Every AI chat session for a Personal or Household Space should silently evaluate liquidity first. When answering any question, the AI should know whether this person is in a liquid or illiquid position. A liquidity warning does not need to be volunteered every conversation — but it shapes the recommendation. "Should I pay extra on my mortgage?" gets a different answer at 8 months of emergency fund vs. 3 weeks of emergency fund.

### 2.2 The second evaluation: debt structure

After confirming the household can survive a shock, the CFP evaluates the debt load — not as a single number but as a structure:

1. **What is the total debt burden, sorted by type?** (Consumer debt first: credit cards, personal loans. Then installment debt: auto, student. Then secured debt: mortgage, HELOC.)
2. **What is the cost of each debt?** (APR or effective annual rate.)
3. **What is the utilization on revolving debt?** (Credit cards and HELOCs.)
4. **Are any minimum payments being missed or approaching due dates?**
5. **What is the debt-to-income ratio?**
6. **Is the debt load improving or deteriorating over time?**

The CFP distinguishes structurally: consumer debt (high APR, no collateral, urgently actionable) versus secured debt (lower APR, long amortization, requires a different optimization strategy). Treating a 24.99% credit card and a 6.5% mortgage identically is a professional error.

**Fourth Meridian implication:** The AI must know the `debtSubtype` of each liability account and apply category-specific reasoning. A credit card at 24.99% and an auto loan at 7.9% require different advice. The advice is never "pay off all debt" — it is "pay off this debt, in this order, at this rate."

### 2.3 The third evaluation: income vs. committed obligations

The CFP looks at whether the household's income can comfortably cover all committed obligations — not whether income exceeds total spending, but whether income covers the non-discretionary floor:

1. **What is reliable monthly income?** (Employment + known recurring income. Not expected bonuses, not variable income unless averaged over 12 months.)
2. **What are committed monthly obligations?** (Housing, minimum debt payments, insurance, subscriptions that functionally cannot be cancelled without major lifestyle change.)
3. **What is the committed obligation ratio?** (Committed obligations ÷ income. Safe: below 50%. Warning: 50–65%. Critical: above 65%.)
4. **After committed obligations, what remains as discretionary cash?**

The CFP never calls the remaining discretionary amount "savings." They call it "optionality" — the capacity to allocate toward goals, savings, debt acceleration, or unexpected costs.

**Fourth Meridian implication:** The AI currently treats all spending categories as equivalent. The correct framing splits spending into three buckets: committed obligations (fixed), intentional capital allocation (debt payments above minimum, savings contributions), and discretionary consumption. When cash flow is negative, the diagnosis must identify which bucket is the cause.

### 2.4 The fourth evaluation: goal alignment and trajectory

With liquidity and debt structure understood, the CFP asks whether the household's financial behavior is pointed in the right direction:

1. **What are the stated goals and their priority?**
2. **Is current capital allocation consistent with stated goal priority?**
3. **What is the realistic time horizon for each goal at the current rate?**
4. **Are there competing goals that create a capital allocation conflict?** (Example: simultaneously targeting debt payoff, emergency fund, and retirement — insufficient cash flow to fund all three adequately.)

A CFP does not tell a client what their goals should be. They reflect back whether current behavior is consistent with stated goals and surface the trade-offs.

**Fourth Meridian implication:** The AI must cross-reference the `goals` domain with the `transactions_summary` domain and evaluate alignment. "You have a DEBT_PAYOFF goal but your largest spending category is Dining and Entertainment" is a cross-domain observation the AI should be able to make automatically.

### 2.5 The fifth evaluation: wealth trajectory

For clients with investment assets:

1. **What is the current net worth and its trend?**
2. **What is the composition of wealth?** (Liquid, illiquid real assets, retirement-locked, accessible investments, home equity.)
3. **Is net worth growing faster or slower than the rate of inflation plus a healthy buffer?**
4. **What is the wealth concentration risk?** (Single employer equity, single asset class, single property market.)

The CFP knows that net worth can decline in the short term while financial health improves — the textbook case is aggressive debt payoff: liquid assets are consumed to reduce liabilities, which temporarily compresses net worth as reported but improves balance sheet health. A CFP does not panic at this. They see the direction.

**Fourth Meridian implication:** This matches exactly the W1 failure mode. The AI must understand that declining liquid assets + declining total debt = improving financial health if the goal is debt elimination. This is not LLM reasoning — it should be a deterministic annotation computed before the prompt is constructed.

---

## 3. Financial concepts Fourth Meridian should formally define

A CFP operates with a defined vocabulary. These concepts are not invented per conversation — they are standard frameworks applied consistently. The AI should receive these definitions explicitly in the system prompt, selected by the Space's category and active goal types.

Each concept has a canonical four-part schema: **Current State**, **Progress**, **Risk**, **Recommendation**.

---

### Concept 1: Debt Health

**Definition:** A holistic assessment of the debt structure, cost burden, and trajectory. Distinct from net worth and cash flow — specifically evaluates the liability side of the balance sheet.

**Inputs required:**
- All liability account balances and `debtSubtype`
- APR per account (from `DebtProfile.apr` → `FinancialAccount.interestRate` → null)
- Minimum payments (from `DebtProfile.minimumPayment`)
- Available credit (for revolving accounts: `creditLimit - |balance|`)
- Active debt-related goals (`DEBT_PAYOFF`, `DEBT_REDUCTION`)
- Monthly debt payments (`debtPaymentTotal` from transactions assembler)
- Monthly income estimate (`incomeTotal` from transactions assembler)

**Deterministic outputs (computed before LLM):**

| Metric | Formula | Threshold |
|---|---|---|
| Total consumer debt | Sum of `credit_card` + `personal_loan` accounts | — |
| Total secured debt | Sum of `mortgage` + `auto_loan` + `heloc` accounts | — |
| Weighted average APR | Σ(balance × APR) ÷ total balance | Warning >15%, Critical >22% |
| Monthly interest cost | Σ(balance × APR ÷ 12) per account | — |
| Revolving utilization | |total revolving balance| ÷ total credit limit | Warning >30%, Critical >70% |
| Debt-to-income ratio | Total minimum payments ÷ monthly income | Warning >20%, Critical >36% |
| Consumer debt payoff velocity | Monthly `debtPaymentTotal` ÷ total consumer debt balance | — |

**Current State:** Summary of total debt by type, highest-cost account, current monthly interest burden.

**Progress:** Trend of total debt balance over 90-day snapshot window. Reduction rate. Whether on-track for any active debt goal.

**Risk:** Accounts at critical utilization, accounts with null APR (calculation blind spot), any account above warning DTI contribution, accounts with promo APR expiring within 60 days.

**Recommendation:** The single highest-impact action available — most likely "focus next extra payment on [account] at [APR]% — saves approximately $[X] per month in interest."

**Supporting Evidence:** Historical payment amounts from `transactions_summary.debtPaymentTotal`, 90-day balance trend from snapshot domain, goal progress percentage.

---

### Concept 2: Liquidity

**Definition:** The household's capacity to meet current and near-term obligations from available liquid assets without selling investments, taking on new debt, or creating financial hardship.

**Inputs required:**
- All accounts classified as `liquid` (checking, savings, money market, cash)
- All accounts classified as `liabilities` with minimum payment and due date
- Monthly committed obligations estimate (computed from recurring transactions or user-entered)
- Active emergency fund goal (`targetAmount` from `SpaceGoal`)

**Deterministic outputs:**

| Metric | Formula | Threshold |
|---|---|---|
| Liquid cash total | Sum of all `liquid` classified account balances | — |
| Months of expenses covered | Liquid cash ÷ estimated monthly essential spending | Critical <1, Warning 1–3, Safe 3–6, Excellent >6 |
| Emergency fund coverage % | Liquid cash ÷ `SpaceGoal.targetAmount` (EMERGENCY_FUND goal) | — |
| Available revolving credit | Σ(creditLimit - |balance|) for revolving accounts | — |
| Total liquidity buffer | Liquid cash + 50% of available revolving credit | — |

**Current State:** Liquid cash total, months-of-expenses coverage, emergency fund progress if applicable.

**Progress:** 30-day change in liquid cash total. Is liquidity improving or declining?

**Risk:** Coverage below 1 month is critical. Below 3 months with no backup credit line is warning. Negative trend (declining liquid cash) while in warning zone is critical.

**Recommendation:** If below target: "Prioritize building liquid reserves before accelerating debt payoff — you have [X] weeks of coverage if income stops." If above target: "Your liquidity is healthy — it may be appropriate to deploy excess cash toward [highest-APR debt / investment goal]."

**Supporting Evidence:** Emergency fund goal progress, prior-period liquid cash from snapshot domain.

---

### Concept 3: Cash Flow Health

**Definition:** The relationship between income and the three categories of outflow — committed obligations, intentional capital allocation (savings and debt acceleration), and discretionary spending — and whether the current allocation is financially sustainable and aligned with goals.

**Inputs required:**
- `incomeTotal`, `expenseTotal`, `debtPaymentTotal` from transactions assembler
- Active goals (to identify whether debt payments are intentional capital allocation)
- `netCashFlow` (already computed in assembler)

**Deterministic outputs:**

| Metric | Formula | Notes |
|---|---|---|
| True discretionary spending | `expenseTotal` minus estimated committed expenses | Committed = housing + utilities + insurance + subscriptions |
| Intentional capital allocation | `debtPaymentTotal` above minimum payments | Requires minimum payment data |
| Cash flow classification | `SURPLUS`, `NEUTRAL`, `DEFICIT` | Surplus: net > +5% income; Deficit: net < -2% income |
| Deficit cause classification | `OVERSPENDING`, `INTENTIONAL_DEBT_PAYOFF`, `INCOME_SHOCK`, `MIXED` | Deterministic from component ratios |

**The critical doctrine for this concept:** Negative cash flow caused primarily by `debtPaymentTotal` above minimum obligations is intentional capital allocation, not a spending problem. The AI must never describe intentional debt payoff as "expenses exceeding income" without also noting that this is a strategy. A DEBT_PAYOFF goal in the `goals` domain is direct confirmation that this deficit is intentional.

**Current State:** Income, three-bucket split (committed obligations, capital allocation, discretionary consumption), net classification.

**Progress:** 30-day vs. 90-day comparison of the same three buckets. Is discretionary spending trending up, down, or stable?

**Risk:** If cash flow is negative AND the cause is `OVERSPENDING` (not intentional debt payoff): warning. If liquidity is also below 3 months: critical. If negative AND the cause is `INTENTIONAL_DEBT_PAYOFF` with healthy liquidity: informational (not a risk).

**Recommendation:** If overspending: name the top two categories by dollar amount and note the percentage of income they represent. If intentional payoff: affirm the strategy and estimate months until goal completion at current velocity.

**Supporting Evidence:** `byCategory` breakdown from transactions assembler, active goal types, 90-day trend.

---

### Concept 4: Financial Stability

**Definition:** The overall resilience of the household's financial position — its ability to sustain current living standards through a moderate income disruption or unexpected expense without restructuring debt or liquidating long-term assets.

This is a composite concept — it synthesizes Liquidity, Debt Health, and Cash Flow Health into a single holistic assessment.

**Deterministic outputs:**

| Metric | Components | Threshold |
|---|---|---|
| Stability Score | Weighted composite: Liquidity (40%) + DTI headroom (30%) + Cash Flow Surplus (30%) | Informational only — never display as a number to the user |
| Stability Rating | `VULNERABLE`, `DEVELOPING`, `STABLE`, `RESILIENT` | Derived from component thresholds |

**Stability ratings:**

- `VULNERABLE`: liquidity < 1 month AND (DTI > 36% OR cash flow deficit from overspending)
- `DEVELOPING`: liquidity 1–3 months OR DTI 25–36% OR neutral cash flow
- `STABLE`: liquidity 3–6 months AND DTI < 25% AND cash flow neutral or better
- `RESILIENT`: liquidity > 6 months AND DTI < 20% AND cash flow positive AND net worth trending up

**This rating is for AI reasoning only — it is not a score to display to users.** It informs how the AI frames its overall assessment and what urgency level to use in recommendations.

---

### Concept 5: Financial Flexibility

**Definition:** The degree to which the household has discretionary capital available to redirect toward opportunities — extra debt payoff, investment, goal contributions, or unexpected events — without creating hardship.

**Inputs required:**
- `netCashFlow` after committed obligations
- Available liquid cash above emergency fund target
- Available revolving credit (backed by healthy utilization)
- Investment accounts that are accessible without penalty

**Key principle:** Flexibility is distinct from stability. A household can be stable (resilient to shocks) but inflexible (no discretionary capital to act on opportunities). High flexibility with low stability is dangerous. High stability with low flexibility is limiting but safe.

**Current State:** Monthly discretionary margin, accessible surplus assets, available credit buffer.

**Recommendation context:** Flexibility determines whether advice like "pay an extra $500 on your Chase card this month" is actionable. If discretionary margin is $120/month, that advice is not actionable. If it is $800/month, it is.

---

### Concept 6: Wealth Progress

**Definition:** The trajectory of the household's total net worth — assets minus liabilities — over time, and whether that trajectory is consistent with long-term financial goals.

**Inputs required:**
- 90-day snapshot history (net worth, total assets, total liabilities)
- Active wealth-related goals (`INVESTMENT`, `RETIREMENT`, `EMERGENCY_FUND`)
- Composition of assets: liquid, investment, real assets, retirement-locked

**Key doctrine:** Net worth can decline while financial health improves. The AI must distinguish between:

1. **Strategic net worth compression:** Liquid assets declining because they are being used to pay down debt (correct — liabilities decline faster than assets). Net worth may show flat or slight decline short-term; balance sheet health is improving.
2. **Structural deterioration:** Net worth declining because expenses exceed income AND debt is growing. Both sides of the balance sheet are moving in the wrong direction.
3. **Market-driven fluctuation:** Net worth declining because investment values dropped. Not a behavioral issue — contextually explain market conditions and note the underlying contribution rate is unchanged.

**Deterministic annotation (computed before LLM):**

Classify the direction and cause of any net worth change detected from the snapshot domain before the LLM receives the data:

```
net_worth_direction: "INCREASING" | "DECLINING" | "FLAT"
asset_trend: "INCREASING" | "DECLINING" | "FLAT"
liability_trend: "INCREASING" | "DECLINING" | "FLAT"
net_worth_cause_classification:
  - "STRATEGIC_DEBT_PAYOFF" (assets ↓, liabilities ↓↓, active debt goal)
  - "INCOME_DRIVEN_GROWTH" (assets ↑↑, liabilities stable)
  - "STRUCTURAL_DETERIORATION" (liabilities ↑ or net cash deficit from overspending)
  - "MARKET_FLUCTUATION" (investment accounts' value changed, no behavioral change)
  - "MIXED" (multiple causes)
```

This classification is the most important deterministic annotation in the system. It prevents the AI from confusing a deliberate financial strategy with a financial problem.

---

### Concept 7: Emergency Readiness

**Definition:** The specific readiness of the household to absorb an unexpected disruption — job loss, medical emergency, major unplanned expense — without going into debt.

**Distinct from Liquidity:** Liquidity measures available cash against ongoing obligations. Emergency Readiness measures available cash against the specific risk of a major disruption. The key variable is not "how many months of normal expenses can I cover" but "could I cover a $5,000 unexpected expense today without going into debt?"

**Deterministic outputs:**

| Metric | Formula |
|---|---|
| Emergency fund coverage | Liquid cash ÷ active EMERGENCY_FUND goal target |
| Emergency cash buffer (no goal) | Liquid cash ÷ (monthly expense estimate × 3) |
| Available credit cushion | Available revolving credit (if utilization < 30%) |
| Combined emergency capacity | Liquid cash + available revolving credit |

**Key doctrine:** An emergency fund target is not arbitrary. The standard is 3–6 months of essential expenses. For a household with variable income, a single income earner, or dependents, 6 months is the minimum. For a dual-income household with stable employment and no dependents, 3 months is defensible.

The AI must know which scenario applies from Space metadata (FAMILY category → higher target; PERSONAL single → standard target) and surface the correct guidance.

---

### Concept 8: Capital Allocation

**Definition:** How the household is actively deploying discretionary cash — the explicit choices made above and beyond committed obligations. The key insight: every dollar of discretionary income is an allocation decision, even if it feels passive.

**Inputs required:**
- `debtPaymentTotal` vs. total minimum obligations (excess = intentional allocation)
- Savings contributions (positive transactions to savings accounts)
- Investment contributions (positive transactions to investment accounts)
- Any recurring goal contribution pattern in `transactions_summary`

**Capital allocation hierarchy (the CFP's default recommendation framework):**

1. **Capture all employer match** — if there is employer retirement match available and the household is not fully capturing it, this is the highest-return risk-free investment available. (Fourth Meridian does not currently track employer match — informational only.)
2. **Eliminate high-APR consumer debt** — debt above 10–12% APR costs more annually than most investments return after tax. Paying it off is a guaranteed, after-tax return equal to the APR.
3. **Build emergency fund to 3 months** — liquidity before investment optimization.
4. **Contribute to tax-advantaged retirement accounts** — IRA, Roth IRA, 401(k) beyond employer match.
5. **Pay down moderate-APR debt** — 6–10% range: contextual (compare against expected investment returns).
6. **Invest in taxable accounts / contribute to other goals** — lowest priority among alternatives with positive expected return.
7. **Pay down low-APR debt** — below 5%: optional, often not financially optimal.

**This hierarchy is Fourth Meridian's financial philosophy.** It should be stated explicitly in every debt/savings/investment trade-off question. Not as a prescription but as a framework. The AI says: "Using the standard approach, here is where your current situation sits in the priority stack — and here is what I would look at next."

---

### Concept 9: Goal Progress

**Definition:** Whether the household's active financial goals are achievable at the current rate, what behavioral changes are required if they are not, and which goals are competing for the same limited capital.

**Inputs required:**
- All active `SpaceGoal` rows (category, target, progress, targetDate, targetAmount)
- Current `debtPaymentTotal`, savings rate
- Monthly discretionary margin from Cash Flow Health

**Deterministic outputs per goal:**

| Metric | Formula |
|---|---|
| Monthly contribution rate | From transaction patterns or `targetAmount ÷ months_to_targetDate` |
| Required monthly contribution | `(targetAmount - currentAmount) ÷ months_remaining` |
| On-track status | `AHEAD`, `ON_TRACK`, `BEHIND`, `AT_RISK`, `OVERDUE` |
| Completion estimate at current rate | `months_remaining_at_current_rate` |

**Goal conflict detection (deterministic):** When two or more active goals require combined monthly contributions that exceed the household's discretionary margin, a conflict exists. The AI must name the conflict explicitly and ask which goal the user wants to prioritize — not silently recommend both.

---

## 4. Financial Reasoning Modules

Financial Reasoning Modules are the mechanism that delivers this vocabulary to the AI at chat time. They are short instruction blocks, injected into the system prompt between `ADVISOR_PRINCIPLES` and the serialized context block, selected deterministically based on the Space category and the user's question intent.

### 4.1 Module design principles

Each module must:

1. Be **short** — 3–8 lines. A module that requires a full paragraph to state its framework is too complex. The AI should internalize a framework, not read an essay.
2. Be **prescriptive** — not "consider APR" but "when comparing two debts, compute the monthly interest cost of each (`balance × APR ÷ 12`) and state it directly."
3. Name the **deterministic annotations** it relies on — modules should reference pre-computed fields, not raw data. "The `debt_payoff_cause_classification` field tells you whether negative cash flow is intentional or problematic."
4. State the **default recommendation posture** — what should the AI conclude by default absent compelling evidence to the contrary?

### 4.2 Module definitions

---

**MODULE: DEBT_HEALTH**

Inject when: Space has any liability accounts, OR Space category is `DEBT_PAYOFF` or `DEBT_REDUCTION`.

```
Debt Health Framework:
- Lead every debt question with current balances and total monthly interest cost, not historical payments.
- The `monthly_interest_burden` annotation shows exactly how much debt is costing per month. State it.
- Consumer debt (credit cards, personal loans) costs more and should be eliminated before secured debt.
- When APR is available: rank debts by APR descending. The highest-APR balance is the highest-priority payoff target regardless of balance size.
- When cash flow is negative primarily due to `debtPaymentTotal`: the user is intentionally paying down debt. Confirm this is the strategy, reference their active debt goal if present, and estimate completion at current velocity.
- Never describe intentional debt payments as "expenses" or "overspending."
- When APR is null for a debt account: name the account and the missing APR explicitly. State that calculations omitting it are approximate.
```

---

**MODULE: LIQUIDITY**

Inject when: Space has liquid accounts, OR user asks about cash, savings, or emergency funds, OR active EMERGENCY_FUND goal exists.

```
Liquidity Framework:
- Liquidity is the most important near-term financial indicator. Check it before framing any recommendation.
- The `months_covered` annotation shows liquid cash ÷ estimated monthly expenses. Below 3 months: mention it. Below 1 month: lead with it.
- An emergency fund is a different question from general liquidity: use `emergency_fund_coverage_pct` from the goals domain when an EMERGENCY_FUND goal is active.
- Available revolving credit is backup liquidity — not ideal, but relevant when liquid cash is below 2 months. Note it as a backstop, not a substitute for cash.
- Recommendation posture: below 3 months coverage, the default recommendation is to build liquidity before accelerating any investment or optional debt payoff. This is not optional advice — it is the correct priority.
```

---

**MODULE: CASH_FLOW**

Inject when: user asks about spending, cash flow, income vs. expenses, or why cash flow is negative.

```
Cash Flow Framework:
- Cash flow has three buckets, not two: (1) committed obligations, (2) intentional capital allocation (debt payments above minimums, savings contributions), (3) discretionary spending.
- The `deficit_cause_classification` annotation tells you which bucket is causing negative cash flow. Use it. Do not diagnose an intentional payoff strategy as a spending problem.
- When `deficit_cause_classification` is `INTENTIONAL_DEBT_PAYOFF`: affirm the strategy. Reference the active debt goal. State estimated completion velocity.
- When `deficit_cause_classification` is `OVERSPENDING`: identify the top two spending categories by dollar amount and state their percentage of income. Do not moralize — state the fact and what it means for goal progress.
- Lead with the total income, then the three-bucket split. Net cash flow is the last line, not the first.
```

---

**MODULE: WEALTH**

Inject when: Space has investment, retirement, or real asset accounts, OR user asks about net worth, investments, or retirement.

```
Wealth Framework:
- The `net_worth_cause_classification` annotation tells you whether a net worth change is strategic, structural, or market-driven. Use it before interpreting any net worth trend.
- `STRATEGIC_DEBT_PAYOFF` classification: net worth may appear flat or slightly declining short-term while the balance sheet health is actually improving. Explain this explicitly.
- Portfolio allocation questions: state total investable value, asset class percentages, and whether any single asset class exceeds 60% of investable assets (concentration risk).
- Retirement accounts that are locked (IRA, 401k): note they are not available liquidity. Do not include them in liquidity calculations.
- Lead with net worth trend over 90 days, then asset composition, then any recommendation.
```

---

**MODULE: AFFORDABILITY**

Inject when: user asks "can I afford X", "should I buy X", "is now a good time to X."

```
Affordability Framework:
- Answer affordability questions in three parts: (1) cash flow headroom (does income support this new obligation?), (2) liquidity impact (does this reduce the emergency fund below 3 months?), (3) opportunity cost (what does this cost in terms of deferred goals?).
- State the committed obligation ratio before and after the proposed expense. Warning: above 50%. Critical: above 65%.
- For large purchases: compute the monthly payment equivalent if financed, and compare it to the current discretionary margin.
- Do not answer "can I afford it?" with "yes" or "no" alone. Answer with: "Your current cash flow margin is $X/month. This obligation would reduce it to $Y/month, leaving [Z months] before reaching your emergency fund target."
```

---

**MODULE: DEBT_VS_SAVINGS**

Inject when: user asks about prioritizing debt payoff versus savings, investment, or emergency fund building.

```
Debt vs. Savings Framework:
- The standard framework for this trade-off: guaranteed return (debt APR) vs. expected return (savings/investment yield).
- Debt at APR > expected investment return after tax: mathematically, pay the debt first.
- Debt at APR 5–10%: contextual — typically split contributions. State the comparison explicitly.
- Debt at APR < 5%: often correct to invest, since expected real returns exceed the debt cost.
- But always check liquidity first. If emergency fund is below 3 months: the answer is build liquidity first, regardless of APR calculation.
- Compute and state directly: monthly interest cost of the debt, estimated monthly return on the savings alternative, net monthly difference. Then give a recommendation.
- When APR is missing: state the calculation cannot be completed without it, name the account, and direct the user to the form below to save it.
```

---

### 4.3 Module selection (deterministic)

Module selection is a pure function of Space category + active goal types + detected user intent. It runs before `buildContext()` modifies the prompt.

```typescript
// Conceptual — not implementation code

function selectReasoningModules(
  spaceCategory: string,
  activeGoalTypes: string[],
  detectedIntent: ChatIntent,
): ReasoningModule[] {
  const modules: ReasoningModule[] = [];

  // Always include if debt accounts exist
  if (hasLiabilityAccounts) modules.push(DEBT_HEALTH);

  // Always include for cash/liquidity questions
  if (spaceCategory === 'EMERGENCY_FUND' || hasLiquidAccounts) modules.push(LIQUIDITY);

  // Cash flow intent or DEBT_PAYOFF space
  if (detectedIntent === 'CASH_FLOW_QUESTION' || spaceCategory === 'DEBT_PAYOFF') {
    modules.push(CASH_FLOW);
  }

  // Investment/retirement spaces
  if (['INVESTMENT', 'RETIREMENT'].includes(spaceCategory)) modules.push(WEALTH);

  // Explicit trade-off intent
  if (detectedIntent === 'DEBT_VS_SAVINGS_TRADEOFF') modules.push(DEBT_VS_SAVINGS);
  if (detectedIntent === 'AFFORDABILITY_QUESTION') modules.push(AFFORDABILITY);

  return modules; // max 3 modules to avoid context crowding
}
```

Maximum three modules per conversation turn. If more are eligible, priority order is: `LIQUIDITY` > `DEBT_HEALTH` > `CASH_FLOW` > `DEBT_VS_SAVINGS` > `AFFORDABILITY` > `WEALTH`.

---

## 5. What should remain deterministic

The boundary between deterministic computation and LLM reasoning is the most important architectural decision in financial AI. The rule is:

**Deterministic: anything that is math, classification, or threshold comparison.**
**LLM: anything that requires judgment, synthesis, narrative, or explanation.**

The AI should never be asked to calculate. It should be given calculated facts and asked to reason about them.

### Mandatory deterministic computations (compute before prompt construction)

| Computation | Where | Notes |
|---|---|---|
| Monthly interest burden per account | Accounts assembler | `balance × APR ÷ 12`; skip if APR null |
| Total monthly interest cost | Accounts assembler | Sum of above |
| Revolving utilization per account | Accounts assembler | `|balance| ÷ creditLimit` |
| Debt-to-income ratio | Assembler post-pass | `totalMinimumPayments ÷ estimatedMonthlyIncome` |
| Liquidity coverage (months) | Accounts assembler | `liquidCash ÷ estimatedMonthlyExpenses` |
| Emergency fund coverage % | Goals assembler | `liquidCash ÷ EMERGENCY_FUND goal targetAmount` |
| Net cash flow classification | Transactions assembler | `SURPLUS / NEUTRAL / DEFICIT` |
| Deficit cause classification | Transactions assembler post-pass | `INTENTIONAL_DEBT_PAYOFF / OVERSPENDING / MIXED` |
| Net worth direction and cause classification | Snapshot assembler post-pass | `STRATEGIC_DEBT_PAYOFF / STRUCTURAL_DETERIORATION / MARKET_FLUCTUATION` |
| Goal on-track status per goal | Goals assembler | `AHEAD / ON_TRACK / BEHIND / AT_RISK` |
| Capital allocation hierarchy position | Context builder post-pass | Which step in the hierarchy is the current recommendation target |
| Knowledge gap list | Accounts assembler | Null fields for debt accounts |
| Today's date | System prompt injection | Always |

### What should remain LLM reasoning

- **Natural language framing of all findings** — the AI generates the sentences; deterministic code generates the facts.
- **Cross-domain synthesis** — "your negative cash flow, combined with your 63% debt payoff goal progress and 4.2 months of emergency fund, means you are in a good position" requires connecting three domains. The AI does this. Deterministic code cannot.
- **Causal explanation and framing** — why something matters for this user's specific situation.
- **Trade-off judgment when the inputs are not clear-cut** — when two valid strategies exist, the AI weighs them with a recommendation. The framework module sets the weighting criteria; the AI applies them.
- **Open-ended questions** — anything outside the financial framework modules falls to the AI's general reasoning.
- **Tone calibration** — the AI decides whether to encourage, caution, or celebrate based on the combined picture.

### The boundary violation to avoid

**Never ask the LLM to classify a financial state.** "Is this cash flow healthy?" should never be in the prompt. The deterministic layer classifies `SURPLUS/NEUTRAL/DEFICIT` and `INTENTIONAL_DEBT_PAYOFF/OVERSPENDING/MIXED` before the LLM receives the data. The LLM explains what those classifications mean for this user — it does not derive them.

---

## 6. The Intent Layer

The conversation quality investigation (W9, Q11) established that an intent layer is necessary. This section specifies the intent taxonomy and the mapping to context assembly behavior.

### 6.1 Intent types

The intent layer's purpose is narrow: classify the user's question into a type that controls (a) temporal frame, (b) reasoning module selection, and (c) scope hint. Eight intents are sufficient.

| Intent | Trigger keywords / patterns | Temporal frame | Modules injected | Scope hint |
|---|---|---|---|---|
| `CURRENT_STATE` | "how is my", "what is my", "where do I stand", "show me", "what's my" + noun | Present: lead with `accounts` domain | By account type | `brief` |
| `HISTORICAL_QUESTION` | "last month", "over the last", "past 90 days", "historically", "how much did I" | Historical: lead with `transactions`/`snapshot` | `CASH_FLOW` | `full` |
| `CASH_FLOW_QUESTION` | "why is my cash flow", "where is my money going", "am I spending too much", "budget" | Present + historical | `CASH_FLOW`, `LIQUIDITY` | `full` |
| `DEBT_QUESTION` | "my debt", "pay off", "credit card", "interest", "APR", "which debt first" | Present: lead with balances | `DEBT_HEALTH`, `LIQUIDITY` | `full` |
| `DEBT_VS_SAVINGS_TRADEOFF` | "should I pay off or save", "debt vs savings", "emergency fund or debt" | Present | `DEBT_VS_SAVINGS`, `LIQUIDITY` | `full` |
| `AFFORDABILITY_QUESTION` | "can I afford", "should I buy", "is now a good time to" | Present | `AFFORDABILITY`, `LIQUIDITY` | `full` |
| `GOAL_QUESTION` | "am I on track", "my goal", "when will I reach", "how is my progress" | Present + historical | By goal type | `full` |
| `WEALTH_QUESTION` | "net worth", "portfolio", "investments", "retirement", "am I growing" | Historical trend | `WEALTH` | `full` |

Intent classification is keyword/pattern matching over the last user message. It is a pure function — no LLM call, no latency. If no pattern matches, default to `CURRENT_STATE` intent (safest default — leads with balances rather than history).

### 6.2 The pipeline with the intent layer

```
User message
    │
    ▼ (deterministic, ~0ms)
Intent Classifier
    │  detectedIntent: ChatIntent
    │  temporalFrame: 'CURRENT_STATE' | 'HISTORICAL'
    ▼
Context assembler options
    │  scopeHint: 'brief' | 'full'
    │  selectedModules: ReasoningModule[]
    ▼
buildContext(spaceId, userId, { scopeHint })
    │
    ▼ (async, DB queries)
SpaceContext_AI
    │
    ▼ (deterministic, post-assembly)
Pre-computed annotations
    │  debtInterestBurden, liquidityMonths, netWorthCauseClassification, etc.
    ▼
System prompt builder
    │  date injection
    │  ADVISOR_PRINCIPLES
    │  selected ReasoningModules (max 3)
    │  temporalFrameInstruction
    │  serialized annotated context (not raw JSON)
    ▼
LLM call
    │
    ▼
Chat response + knowledgeGaps
```

This is the proposed architecture from W9/Q11 of the conversation quality investigation, with the concrete module definitions filled in.

---

## 7. Historical metrics as supporting evidence: the doctrine

This is the most impactful single prompt change available. The doctrine should be explicit in `ADVISOR_PRINCIPLES`:

---

**Temporal Frame Doctrine (to be added to ADVISOR_PRINCIPLES):**

```
When the user asks about their current financial position — debt situation, net worth, account balances,
emergency fund, goal progress — the `accounts` and `goals` domains are the primary source.
Lead with today's state. Historical data (transactions, snapshots) is supporting evidence only.
Historical evidence answers the question "how did I get here?" or "how is this trending?" —
it does not answer "where am I today?"

When the user asks about historical behavior — what they spent, how their net worth changed,
whether they hit a target over a period — the `transactions_summary` and `snapshot_history`
domains are the primary source. Current balances from `accounts` are supporting context.

Explicit triggers for historical mode: "last month", "over the last [period]", "historically",
"past [X] days", "how much did I", "how has my [metric] changed."

Absent these triggers: default to current-state mode. The most recent balance is the answer.
The historical trend is the elaboration.
```

---

This doctrine is not a vague principle. It is a concrete instruction with clear triggers and clear default behavior. The AI does not need to decide which temporal frame to use — it is told.

**Should historical metrics automatically become supporting evidence unless explicitly requested?**

Yes. The explicit default is: current state first, history second. The history is never irrelevant — it is almost always the best way to explain and contextualize the current state. But it answers the question "why" and "how," not the question "what."

---

## 8. What a true AI financial advisor architecture looks like at scale

The four-layer architecture that separates Fourth Meridian's AI from a chat interface bolted onto a database:

### Layer 1: Financial state layer (deterministic, always fresh)

Assembled by the context builder per request. No caching of the financial picture. Every session sees the current state.

Additions at scale:
- **Credit score** assembled from `CreditScore` table when context needs it (deferred in current schema but architecturally straightforward)
- **Tax efficiency signals** — detecting high-yield savings in taxable vs. tax-advantaged accounts
- **Employer match capture status** — if the user has connected a 401k and contribution rate is known

### Layer 2: Financial intelligence layer (deterministic, pre-computed)

Post-assembly annotations that compute the financial concepts defined in §3. These run synchronously after assembly, before the LLM call. Fast (in-memory computation over already-assembled data, no additional DB queries).

At current stage: debt health metrics, liquidity metrics, cash flow classification, net worth cause classification, goal on-track status. At scale: DTI trend, capital allocation hierarchy position, goal conflict detection, portfolio concentration risk.

### Layer 3: Financial reasoning layer (deterministic doctrine + LLM reasoning)

The intent layer selects reasoning modules, the system prompt injector assembles them, and the LLM applies them. This is the layer that gives the AI a financial philosophy rather than improvised reasoning.

At scale, modules can evolve independently of the context architecture. New modules for tax strategy, real estate, business finance, or retirement planning are added here — they do not require schema changes, assembler changes, or context builder modifications.

### Layer 4: Financial memory layer (persistent, session-spanning)

Deferred in current architecture. When implemented:
- User-confirmed values (`DebtProfile.apr`, `minimumPayment`) are the first form of financial memory — they already persist across sessions.
- Future: `AiAdvice` rows that record prior recommendations so the AI can say "I previously suggested focusing on your Chase card — you've made $800 in extra payments since then."
- Not: raw conversation history. The AI does not need conversation history — it needs the user's financial state history, which is captured by the snapshot domain.

### The principle that distinguishes an advisor from a reporting engine

A reporting engine answers what the data says. An advisor answers what the data means for this person's situation.

The difference is always pre-computed financial intelligence (Layer 2) × injected domain philosophy (Layer 3). Without Layer 2, the AI has raw numbers. Without Layer 3, the AI has numbers and classification but no framework to reason about them. With both, the AI has what a CFP has: a structured view of the current state, a professional framework for interpreting it, and the ability to give a recommendation that is grounded, specific, and correct.

---

## 9. Answers to the eight investigation questions

### Q1 — What does a CFP evaluate first?

In priority order: Liquidity (can the household survive a shock today?), then Debt Structure (what is the cost of liabilities?), then Cash Flow (is income covering committed obligations?), then Goal Alignment (is behavior consistent with stated priorities?), then Wealth Trajectory (is net worth growing appropriately?). The CFP never jumps to recommendations before completing this sequence mentally — it takes approximately 10 seconds with a trained professional and should take approximately the same time as a deterministic pre-assembly pass.

### Q2 — What reusable financial concepts should Fourth Meridian formally define?

In implementation priority: Cash Flow Health (most common question type, highest current failure rate), Debt Health (most data already assembled, highest advisory leverage), Liquidity (controls most other recommendations), Capital Allocation (clarifies debt vs. savings trade-offs), Emergency Readiness (directly addresses EMERGENCY_FUND goal type), Wealth Progress (needed for investment Spaces). Financial Stability and Financial Flexibility are derivative of the above — they should be computed but need not be named in the prompt.

### Q3 — For each concept: Current State, Progress, Risk, Recommendation, Supporting Evidence

Defined fully in §3. Each concept has deterministic metric definitions, threshold classifications, and a recommended response posture.

### Q4 — Should Fourth Meridian introduce Financial Reasoning Modules?

Yes. Not as a replacement for the LLM but as the domain philosophy layer between context assembly and LLM reasoning. Six modules are specified in §4: DEBT_HEALTH, LIQUIDITY, CASH_FLOW, WEALTH, AFFORDABILITY, DEBT_VS_SAVINGS. Each is 3–8 lines, injected selectively based on Space category and detected intent.

### Q5 — What should remain deterministic?

Defined in §5. The rule: every classification, threshold comparison, and mathematical derivation is deterministic. Monthly interest burden, liquidity months covered, deficit cause classification, net worth cause classification, goal on-track status — all computed before the LLM receives the data. The LLM reasons about these classifications and generates narrative. It does not derive them.

### Q6 — Should Fourth Meridian introduce an Intent Layer?

Yes. Eight intent types, keyword-based classification, runs before `buildContext()`. Controls temporal frame (current state vs. historical), module selection (max 3 per turn), and scope hint. Specified in §6.

### Q7 — Should historical metrics always become supporting evidence unless explicitly requested?

Yes. The Temporal Frame Doctrine in §7 codifies this as an explicit, two-sentence instruction in `ADVISOR_PRINCIPLES`. The default is current-state mode. Historical mode requires explicit triggers. Historical metrics answer "why" and "how" — not "what."

### Q8 — What would a true AI financial advisor architecture look like at scale?

Four layers: Financial State (deterministic context assembly), Financial Intelligence (deterministic pre-computed annotations), Financial Reasoning (modules + LLM synthesis), Financial Memory (persistent user-confirmed values and prior advice). Defined in §8. The present architecture has Layers 1 and 4 (partially). Layers 2 and 3 are the implementation targets of this investigation.

---

## 10. Implementation priority

This investigation is not an implementation plan. But for the follow-on checklist, the priority order is:

**Highest impact, zero code change:** Temporal Frame Doctrine and Debt Payment Doctrine added to `ADVISOR_PRINCIPLES` in `route.ts`. Fixes the majority of observed failures immediately.

**High impact, minimal code change:** Today's date injection. Knowledge Acquisition prompt carve-out. Snapshot added to `FINANCE_CORE` manifest.

**Medium impact, moderate code change:** Pre-computed annotations (monthly interest burden, deficit cause classification, net worth cause classification). Context serialization rewrite (annotated blocks, not raw JSON). CASH_FLOW, DEBT_HEALTH, LIQUIDITY modules defined and injected.

**Medium impact, new module:** Intent classifier (keyword-based, 8 intents). Module selection function.

**Deferred until above is proven:** Holdings assembler (needed for investment Spaces). Providers assembler. Model upgrade (validates on improved foundation).

---

## 11. Sign-off

This document makes no code changes. It establishes the financial reasoning philosophy that should govern how the AI thinks, and the architecture that delivers that philosophy at prompt construction time.

The Tier 1 prompt changes from D4_CONVERSATION_QUALITY_INVESTIGATION.md should proceed first. The reasoning modules defined in §4 of this document are the implementation target of Tier 3 in that investigation. This document is the content specification for those modules.

Recommended next step: review this document, confirm the six modules and their doctrines, then produce a Tier 1 implementation checklist covering the prompt-only changes. No schema, no migration, no new assembler — just the system prompt changes that implement the Temporal Frame Doctrine, Debt Payment Doctrine, date injection, and Knowledge Acquisition carve-out.
