# D4 — Layer 2 Financial Intelligence Investigation

**Status: Investigation only. No schema, migration, API route, UI, or application code was modified.**
**Date: 2026-07-01**
**Branch: feature/phase-2-architecture**

---

## 0. Document control

| | |
|---|---|
| Scope | Design of the smallest Layer 2 Financial Intelligence Pass addressing data confidence, income completeness, cash-flow deficit classification, debt health classification, and liquidity coverage |
| Confirmed sources read | `lib/ai/assemblers/transactions.ts`, `lib/ai/assemblers/accounts.ts`, `lib/ai/assemblers/snapshot.ts`, `lib/ai/context-builder.ts`, `lib/ai/types.ts`, `lib/ai/signals/types.ts`, `lib/ai/signals/detectors/transactions.ts`, `lib/ai/signals/detectors/snapshot.ts` |
| Observed failure | User income ~$10,500/month. AI sees $11,600 over 90 days (~$3,867/month implied). AI declares cash flow dangerously negative. Cause: incomplete transaction import, not genuine deficit. |
| Does NOT | Implement anything. Propose schema. Modify code. |

---

## 1. The precise failure mechanism

The transactions assembler queries `WHERE date >= today - 90 days` and returns whatever is there. It has no knowledge of whether that set of rows represents a complete financial picture. The `startDate` field in `TransactionsSummaryData` is always `today - 90 days` — it is a query floor, not a proxy for data completeness. The assembler cannot distinguish between:

- A user with $3,867/month income (genuine)
- A user with $10,500/month income whose income account was connected two weeks ago (incomplete)

The LLM receives `incomeTotal: 11600, windowDays: 90, netCashFlow: -8420` and applies the Debt Payment Doctrine correctly — it knows the debt payments are intentional — but still concludes the underlying income is too low to support the spending. That conclusion is correct given the data it has. The data is wrong. The LLM has no signal that it should distrust the income figure.

The fix is not a prompt instruction telling the LLM to hedge all income claims. The fix is a deterministic confidence annotation computed from fields that *are* reliable, delivered to the LLM before it sees the income figure.

---

## 2. Q1 — What fields already exist to estimate transaction-history completeness?

All of the following are already assembled and available in `SpaceContext_AI.domains`. No schema changes or new queries are needed.

### From `transactions_summary` domain (`TransactionsSummaryData`)

| Field | How it helps |
|---|---|
| `windowDays` | 30 or 90 — tells us the intended window |
| `transactionCount` | Total settled + pending rows. A 90-day window with < 30 transactions is sparse. |
| `incomeTotal` | Absolute income captured in the window |
| `expenseTotal` | Absolute expenses captured in the window |
| `debtPaymentTotal` | Absolute debt payments in the window |
| `byCategory` | `CategorySpend[]` sorted by absolute total — Income category entry contains `count` (number of income transactions). This is critical: it tells us how many pay cycles are represented, not just the dollar amount. |
| `startDate` | Always `today - 90 days` — NOT meaningful for completeness. Do not use. |
| `endDate` | Date of the most recent transaction. If this is days ago, data may be current. If this is weeks ago, sync may be stale — cross-reference with account health. |

### From `snapshot_history` domain (`SnapshotSectionData`)

| Field | How it helps |
|---|---|
| `snapshotCount` | The strongest single completeness signal. Snapshots are written daily by the sync job. If `snapshotCount = 12`, the Space has 12 days of financial history — the 90-day transaction window is ~87% empty by calendar. If `snapshotCount ≥ 60`, the Space has been active for at least 60 days and the 90-day window is substantially populated. |
| `oldestDate` | The calendar date of the first snapshot. If this is 10 days ago, the Space is new regardless of whether transactions exist. |
| `newestDate` | Should be yesterday or today. If it is more than 2 days old, snapshots are not generating — a data quality issue distinct from completeness. |

### From `accounts` domain (`AccountsSectionData`)

| Field | How it helps |
|---|---|
| `health.staleCount` | Manual accounts not updated in 30+ days contribute to income invisibility if the stale account is a checking account where payroll lands |
| `health.errorCount` | Broken Plaid connections mean their transactions are missing from the window |
| `health.needsReauthCount` | Same as error — transactions from that account are absent |
| `accounts[*].syncStatus` | Per-account sync health. 'error' or 'manual' accounts are transaction blind spots. |
| `totalLiquid` | The current liquid balance is reliable (balance data is fresh from Plaid). This is always more trustworthy than income totals for evaluating liquidity. |

### What does NOT exist but would help

- **Earliest transaction date in the database for this Space.** The assembler knows what it fetched for the window but not whether the user has transactions before the window started. This would require an additional query that is not currently run.
- **Account-level oldest transaction date.** Would identify which accounts have deep history vs. were recently connected.
- **Connection established date.** When the Plaid item was first created — a proxy for how long that account's history has been available.

None of these require schema additions. They require an additional query at assembly time — which belongs in the intelligence pass, not the transaction assembler.

---

## 3. Q2 — Can we determine the transaction window is incomplete?

Yes — not with certainty, but with confidence classification. The evidence is circumstantial but converging. Three independent signals:

### Signal A: Snapshot count vs. window length

`snapshotCount` is the most reliable proxy for how long the Space has been active. Snapshots are written daily by the sync job. A Space with `snapshotCount = 15` has been active for 15 days — its 90-day transaction window is 75 days empty.

```
snapshotCount < 14  → window coverage < 15%  → LOW completeness
snapshotCount 14–44 → window coverage 15–50%  → MEDIUM completeness
snapshotCount ≥ 45  → window coverage > 50%   → HIGH completeness
```

This signal alone is sufficient to classify the specific reported case. If a Space has `snapshotCount = 12` and `incomeTotal = $11,600`, the LLM should know: this is 12 days of data extrapolated over a 90-day query window — the income figure is likely 7× too low.

**Caveat:** `snapshotCount` can be low even for an older Space if the snapshot job wasn't running. But this is indistinguishable from "new Space" in the assembled data without additional context. The correct behavior for both cases is the same: LOW confidence.

### Signal B: Income transaction count

The `byCategory` array contains an entry for the `Income` category when income transactions exist. The `count` field tells us how many income transactions were recorded.

For any employed person with monthly or biweekly pay:
- Monthly pay → 3 income transactions expected in 90 days
- Biweekly pay → 6-7 income transactions expected in 90 days

```
incomeTransactionCount = 0      → income account not connected or no income imported
incomeTransactionCount = 1      → only 1 pay cycle captured — very likely incomplete
incomeTransactionCount = 2      → possibly 2 months (monthly pay) or 1 month (biweekly) — borderline
incomeTransactionCount ≥ 3      → at least 1 transaction per 30 days — plausible completeness
```

This signal catches the reported failure case: if only 1 paycheck is in the system but 90 days of data are being queried, the income figure is approximately 3× too low for a monthly-paid user.

**Caveat:** Self-employed users with quarterly revenue, freelancers with irregular income, or users who receive annual bonuses will trigger false LOW confidence even when their data is complete. The signal should produce a warning to hedge, not a refusal to engage.

### Signal C: Income-to-expense plausibility ratio

When both income and expense data exist, their ratio reveals implausibility:

```
incomeTotal / (expenseTotal + debtPaymentTotal)
```

In the reported case: $11,600 / (expenses + debt payments). If total outflows are, say, $22,000, the ratio is 0.53 — income covers only 53% of outflows. Sustained deficit at that level would rapidly exhaust savings. If the user has maintained a stable liquid balance in the snapshot history, the deficit is implausible — income data must be incomplete.

This is the most powerful cross-domain signal, but it requires both `transactions_summary` and `snapshot_history`. It works as follows: if `netCashFlow < 0` at a rate that would exhaust `totalLiquid` in < 6 months, but `snapshotHistory.latest.liquid` has been stable or growing, the income figure is contradicted by the balance trajectory. Contradiction = LOW income confidence.

### Combining the signals

No single signal is conclusive. The classification should be additive:

| snapshotCount | incomeTransactionCount | incomePlausibilityRatio | Classification |
|---|---|---|---|
| < 14 | any | any | LOW — dominant signal |
| 14–44 | 0 or 1 | any | LOW |
| 14–44 | 2 | < 0.6 | LOW |
| 14–44 | ≥ 2 | ≥ 0.6 | MEDIUM |
| ≥ 45 | 0 | any | LOW — income not connected |
| ≥ 45 | 1–2 | < 0.6 | MEDIUM |
| ≥ 45 | ≥ 3 | ≥ 0.6 | HIGH |

---

## 4. Q3 — Should `transactions_summary` expose a confidence flag?

**No. Not in the assembler itself.**

A confidence flag on `TransactionsSummaryData` would require the transactions assembler to access snapshot data — which is assembled in parallel by a separate assembler. The transaction assembler is a pure function over its own domain's query results. Introducing a cross-domain dependency would:

1. Force the transaction assembler to either run after the snapshot assembler (sequential dependency) or duplicate the snapshot query (redundancy)
2. Violate the clean one-domain-per-assembler architecture
3. Complicate future testing — transaction assembler tests would need to mock snapshot data

The transaction assembler should continue to return what it observes (`transactionCount`, `incomeTotal`, `byCategory`, etc.) without interpretation. Confidence is a cross-domain judgment that belongs in Layer 2 — after all assemblers complete, before the LLM receives context.

**One exception: `incomeTransactionCount` is worth extracting.**

The `byCategory` array currently buries the income count inside the sorted array. The intelligence pass needs to find the Income entry to compute `incomeTransactionCount`. This lookup is trivial, but making it explicit in `TransactionsSummaryData` would make the intelligence pass cleaner. The transaction assembler could add:

```ts
incomeTransactionCount: number;  // byCategory entry for Income category, .count
```

This is an additive change to the assembler's output — not a confidence flag, just making a derived number explicit. It belongs in the assembler because it is computed from assembler data without cross-domain knowledge.

---

## 5. Q4 — Should Layer 2 produce these annotations?

### `incomeConfidence: LOW | MEDIUM | HIGH`

**Yes. This is the primary fix.**

Computed from: `snapshotCount` (from snapshot domain) + `incomeTransactionCount` (from transactions domain) + `incomePlausibilityRatio` (cross-domain computation).

Purpose: prevents the LLM from trusting a low income total when the transaction history is sparse. When `incomeConfidence: LOW`, the LLM should hedge all income-based claims and suggest connecting remaining accounts rather than declaring a cash flow deficit.

### `transactionHistoryCompleteness: LOW | MEDIUM | HIGH`

**Yes. Rename from `transactionHistoryConfidence` for precision — this is about coverage, not accuracy.**

Computed from: `snapshotCount` and `transactionCount`.

Purpose: a broader signal than income confidence. Even if income data is complete, expense data may be sparse. `transactionHistoryCompleteness: LOW` should suppress any strong claim about spending patterns.

### `deficitCauseClassification`

**Yes, but with a fourth value not in the original proposal.**

Proposed enum:

```
INTENTIONAL_DEBT_PAYOFF  — netCashFlow < 0 primarily because debtPaymentTotal is large;
                            active debt goal confirms this is the strategy.

POSSIBLE_OVERSPENDING    — netCashFlow < 0 and debtPaymentTotal is not the primary driver;
                           expense categories suggest discretionary spending is high.

LOW_INCOME_SAMPLE        — netCashFlow < 0 but incomeConfidence is LOW; the deficit may
                           be an artifact of incomplete income import, not genuine.
                           This must take priority over the other two classifications
                           when incomeConfidence is LOW.

MIXED                    — both INTENTIONAL_DEBT_PAYOFF and genuine expense pressure
                           contribute to the deficit; cannot cleanly separate.

NOT_APPLICABLE           — netCashFlow >= 0; no deficit to classify.
```

The `LOW_INCOME_SAMPLE` classification is the specific fix for the reported failure. It tells the LLM: "do not diagnose the cash flow situation — the data is insufficient."

Priority rule: `LOW_INCOME_SAMPLE` overrides `INTENTIONAL_DEBT_PAYOFF` and `POSSIBLE_OVERSPENDING` when `incomeConfidence === 'LOW'`. A deficit that looks like intentional debt payoff but is based on incomplete income data should not be classified as `INTENTIONAL_DEBT_PAYOFF` — the LLM would still anchor on the low income figure to compute payoff timelines.

### `debtHealthClassification: CRITICAL | WARNING | IMPROVING | HEALTHY | INSUFFICIENT_DATA`

**Yes, and `INSUFFICIENT_DATA` is the most important value.**

Classification logic:
- `INSUFFICIENT_DATA`: any FULL-visibility debt account has null APR. The LLM cannot assess interest burden without APR.
- `CRITICAL`: weighted average APR > 22% AND revolving utilization > 70%
- `WARNING`: weighted average APR > 15% OR revolving utilization > 30%
- `IMPROVING`: net debt balance declining over snapshot window (liabilities trending down)
- `HEALTHY`: no warning flags; debt load is manageable relative to income (requires income confidence ≥ MEDIUM)

Note: `HEALTHY` should not be emitted when `incomeConfidence === 'LOW'` — the debt-to-income ratio cannot be computed reliably.

Inputs required: accounts domain (APR per account, balances, credit limits) + snapshot domain (liabilities trend) + income confidence annotation (to qualify HEALTHY).

### `currentStatePriority: LIQUIDITY | DEBT | CASH_FLOW | GOALS | DATA_QUALITY`

**Yes — this is the highest-leverage annotation for prompt behavior.**

Purpose: tells the LLM what topic to center the response on when the user asks an open-ended question ("how am I doing?", "what should I focus on?").

Priority rules (apply in order):

```
1. DATA_QUALITY     — if transactionHistoryCompleteness === 'LOW' or incomeConfidence === 'LOW'
2. LIQUIDITY        — if liquid cash < 1 month of expenses
3. DEBT             — if debtHealthClassification === 'CRITICAL' or any APR > 22%
4. CASH_FLOW        — if deficitCauseClassification === 'POSSIBLE_OVERSPENDING'
5. GOALS            — if any active goal is AT_RISK or OVERDUE
6. DEBT             — if debtHealthClassification === 'WARNING'
7. CASH_FLOW        — if deficitCauseClassification === 'INTENTIONAL_DEBT_PAYOFF' (affirm strategy)
8. LIQUIDITY        — default if no other condition triggers
```

When `currentStatePriority === 'DATA_QUALITY'`, the LLM leads with: "I have limited transaction history for this Space. Here is what I can see with confidence: [accounts domain, which is always reliable]. Connecting [specific missing account types] will give me a complete picture."

### `liquidityCoverageMonths` (additional annotation not in original proposal)

**Yes, and it is more reliable than any income-based calculation.**

The accounts domain provides `totalLiquid` (reliable — balance data from Plaid is current). The transactions domain provides `expenseTotal` (more reliable than `incomeTotal` because expenses are present even when income accounts aren't connected). Monthly expense rate = `expenseTotal / windowDays * 30`. This estimate is less sensitive to income incompleteness.

```
liquidityCoverageMonths: number | null  // null when expenseTotal === 0
liquidityCoverageClassification: 'CRITICAL' | 'WARNING' | 'SAFE' | 'EXCELLENT' | 'UNKNOWN'
```

Thresholds:
- CRITICAL: < 1 month
- WARNING: 1–3 months
- SAFE: 3–6 months
- EXCELLENT: > 6 months
- UNKNOWN: expenseTotal === 0 (no expense data)

This annotation is more actionable than income-based cash flow because it uses current balances (trustworthy) and outflows (more complete than inflows). A user with CRITICAL liquidity is urgent regardless of income data quality. A user with EXCELLENT liquidity is fine regardless of whether the income figure is accurate.

---

## 6. Q5 — Where should this live?

### Option A: Chat route only (`app/api/ai/chat/route.ts`)

Quick to implement, self-contained. But the annotations are not available to any other consumer (Daily Brief, future push notifications, a future Recommendations engine). If those consumers are added later, the logic has to be duplicated. The chat route is already responsible for too many things.

**Not recommended.**

### Option B: Context builder post-pass (`lib/ai/context-builder.ts`)

The context builder already runs signal detectors post-assembly (Step 5 in `buildContext()`). This is the established pattern for deterministic post-assembly analysis. Adding an intelligence pass here is architecturally consistent.

The problem: `SpaceContext_AI` would need a new `annotations` field to carry the intelligence output. This is an additive type change — no schema migration — but it changes the public contract of `buildContext()`. Every consumer gets the annotations whether they use them or not.

**Acceptable for the minimal implementation. Not ideal at scale.**

### Option C: New `lib/ai/intelligence/` module, invoked from the chat route

A separate `lib/ai/intelligence/` directory with a `computeAnnotations(ctx: SpaceContext_AI): FinancialAnnotations` function. The chat route calls it after `buildContext()` and passes the result to the system prompt builder.

```
buildContext() → SpaceContext_AI
    ↓
computeAnnotations(ctx) → FinancialAnnotations
    ↓
buildSpaceSystemPrompt(ctx, annotations) → string
    ↓
generateChatReply(systemPrompt, messages) → string
```

Advantages:
- Clean separation: `buildContext()` is still purely assembly + permission enforcement
- `computeAnnotations()` is independently testable with mock `SpaceContext_AI` inputs
- Other consumers (Daily Brief, future push notifications) can call `computeAnnotations()` when they need it — it is not forced onto every consumer
- `SpaceContext_AI` type does not change
- The module can grow (add new annotations) without touching the context builder

Disadvantages:
- One additional function call in the chat route hot path
- The `systemPrompt` builder function signature needs to change to accept annotations

**Recommended: Option C, `lib/ai/intelligence/`.**

### Why not the signal registry?

The existing signal detectors (`lib/ai/signals/detectors/`) are close to what is needed but are designed to produce `ContextSignal[]` — discrete alerts with severity and human-readable titles. Signals are surfaced as a list in the serialized context block. They are good for "there is a problem with account X" but not for structured annotations with typed enum values that the prompt builder uses to make decisions.

A `TRANSACTION_DATA_INCOMPLETE` signal could be added to the existing signal infrastructure as the **minimal viable change** (see Q6 below). For the full intelligence pass, `lib/ai/intelligence/` is the right home.

---

## 7. Q6 — What is the smallest implementation that stops the AI from over-trusting bad 90-day data?

Two options in ascending order of scope:

---

### Minimum viable: one new signal type + prompt instruction (smallest)

**Scope: 3 files. No new module. No type changes to `SpaceContext_AI`.**

**File 1: `lib/ai/signals/types.ts`** — add one constant:
```
TRANSACTION_DATA_INCOMPLETE: 'TRANSACTION_DATA_INCOMPLETE'
```

**File 2: `lib/ai/signals/detectors/completeness.ts`** — new file, one detector:
```
Fires TRANSACTION_DATA_INCOMPLETE (severity: 'warning') when:
  snapshotCount < 30
  OR incomeTransactionCount < 2 for a 90-day window

Title: "Transaction history may be incomplete — income data should be treated as approximate."
Body: "Only N days of snapshot history exist. Income totals may not reflect a full pay cycle."
```

**File 3: `app/api/ai/chat/route.ts`** — add one instruction to `KNOWLEDGE_GAPS_RULES` or `ADVISOR_PRINCIPLES`:
```
"When a TRANSACTION_DATA_INCOMPLETE signal is active:
- Do not state that cash flow is negative or that income is too low to cover expenses.
- Instead, note that the transaction history is partial and that the income total covers
  only N days of the 90-day window.
- Suggest connecting any remaining accounts or importing additional history.
- You may still assess the accounts domain (balances, debt, liquidity) — those are reliable.
  Only income-based and cash-flow-based conclusions should be hedged."
```

**What this fixes:** The AI sees the `TRANSACTION_DATA_INCOMPLETE` signal in the serialized context block (which already renders signals as a labeled list). The new prompt instruction tells it to hedge income and cash flow claims when that signal is present. The LLM will still describe account balances and debt correctly — those are not affected by income incompleteness.

**Limitation:** The signal text is the only data the LLM receives about *why* data is incomplete. It cannot do nuanced reasoning like "income is 37% of what it should be." It only knows: "data may be incomplete — hedge."

---

### Proper implementation: `lib/ai/intelligence/` module

**Scope: 1 new directory, 2–3 new files, 1 modified file (route.ts). No schema changes.**

**`lib/ai/intelligence/annotations.ts`** — the core module:

```typescript
// Proposed interface — not implementation code

interface FinancialAnnotations {
  // Data quality
  transactionHistoryCompleteness: 'LOW' | 'MEDIUM' | 'HIGH';
  incomeConfidence:               'LOW' | 'MEDIUM' | 'HIGH';
  incomeTransactionCount:         number;
  impliedMonthlyIncome:           number | null;  // incomeTotal / windowDays * 30
  snapshotSpanDays:               number;         // snapshotCount

  // Cash flow
  deficitCauseClassification:
    | 'INTENTIONAL_DEBT_PAYOFF'
    | 'POSSIBLE_OVERSPENDING'
    | 'LOW_INCOME_SAMPLE'
    | 'MIXED'
    | 'NOT_APPLICABLE';
  cashFlowReliability: 'UNRELIABLE' | 'PARTIAL' | 'RELIABLE';

  // Debt
  debtHealthClassification:
    | 'CRITICAL'
    | 'WARNING'
    | 'IMPROVING'
    | 'HEALTHY'
    | 'INSUFFICIENT_DATA'
    | 'NO_DEBT';
  totalMonthlyInterestBurden: number | null;  // null when any APR is missing
  hasNullAPR:                 boolean;

  // Liquidity
  liquidityCoverageMonths:         number | null;
  liquidityCoverageClassification: 'CRITICAL' | 'WARNING' | 'SAFE' | 'EXCELLENT' | 'UNKNOWN';
  liquidityEstimateMonthlyExpense: number | null;  // expenseTotal / windowDays * 30

  // Priority hint
  currentStatePriority: 'DATA_QUALITY' | 'LIQUIDITY' | 'DEBT' | 'CASH_FLOW' | 'GOALS' | 'GOALS_GOOD';
}
```

**`lib/ai/intelligence/index.ts`** — the entry point:
```typescript
// computeAnnotations(ctx: SpaceContext_AI): FinancialAnnotations
// Pure function — no DB queries, no side effects
```

**`app/api/ai/chat/route.ts`** — updated:
- Import `computeAnnotations` from `lib/ai/intelligence`
- Call it after `buildContext()` with the assembled context
- Pass `FinancialAnnotations` to `buildSpaceSystemPrompt()` and `buildMasterSystemPrompt()`
- Inject a new `=== FINANCIAL ASSESSMENT ===` block into the system prompt between `ADVISOR_PRINCIPLES` and `=== SPACE CONTEXT ===`

The assessment block in the prompt (for the reported case) would look like:

```
=== FINANCIAL ASSESSMENT ===
Transaction History Completeness: LOW
  Reason: 12 days of snapshot history for a 90-day query window.
  Income data covers approximately 13% of the window.

Income Confidence: LOW
  Implied monthly income from available data: $3,867 (based on 12 days)
  Income transaction count: 1
  Do not make income-based conclusions. The account showing income may have
  been connected recently and does not reflect a full pay cycle.

Cash Flow Reliability: UNRELIABLE
  Deficit cause: LOW_INCOME_SAMPLE — cash flow deficit is likely an artifact
  of incomplete income data, not genuine overspending or debt payoff behavior.
  Do not state that cash flow is negative. Note the data limitation instead.

Debt Health: WARNING
  Monthly interest burden: $214 (based on available APR data)
  Note: Chase Sapphire APR is missing — total interest burden may be higher.

Liquidity Coverage: SAFE
  Liquid cash: $8,440
  Estimated monthly expenses (from available data): $2,180
  Coverage: 3.9 months — healthy buffer even under uncertainty.

Current State Priority: DATA_QUALITY
  Lead with data limitations before making any income or cash flow assessment.
=== END ASSESSMENT ===
```

This block gives the LLM structured, labeled conclusions to reason from. It replaces the raw JSON income figure as the primary input for income-related questions. The LLM sees `Income Confidence: LOW` and `Cash Flow Reliability: UNRELIABLE` as the first thing in the assessment block — before it sees any numbers.

---

## 8. The specific thresholds — derivation and rationale

**`snapshotCount` thresholds:**

The snapshot assembler takes `take: -90` — up to 90 most-recent daily rows. `snapshotCount` is therefore the number of calendar days for which a snapshot exists. Thresholds:

- `< 14` (< 2 weeks): The transaction query covers 90 days but only 2 weeks have any financial history. The income total reflects at most 14 days of activity. For a biweekly-paid user, that is likely 0 or 1 paychecks. Confidence: LOW, dominant signal.
- `14–44` (2–6 weeks): Partial history. Some income captured, some missing.
- `≥ 45` (> 6 weeks): More than half the transaction window has history. Confidence improves, but income transaction count still matters.

**`incomeTransactionCount` thresholds:**

Extracted from `byCategory.find(c => c.category === 'Income')?.count ?? 0`.

- `0`: No income transactions at all. Could mean income account isn't connected, or income comes via Transfer (e.g., payroll to savings then transfer to checking — the Transfer category would absorb it). Classification: LOW, regardless of snapshot count.
- `1`: One paycheck in 90 days. For monthly-paid users this is plausible but sparse. For biweekly users this means 5–6 paychecks are missing. Classification: LOW if snapshotCount < 45; MEDIUM if snapshotCount ≥ 45.
- `2`: Two paychecks. Consistent with monthly pay over 2 months or biweekly over ~1 month. Classification: MEDIUM.
- `≥ 3`: At least one paycheck per month. Classification: HIGH (combined with snapshotCount ≥ 45).

**Income-to-expense plausibility ratio:**

`ratio = incomeTotal / max(expenseTotal + debtPaymentTotal, 1)`

A ratio below 0.5 means income is covering less than half of outflows. Sustained at this level for 90 days, the user would exhaust most emergency funds. If the snapshot history shows stable or increasing liquid balances, this ratio contradicts the data — income must be incomplete.

Cross-check: if `liquidityCoverageClassification === 'SAFE'` or `'EXCELLENT'` but `ratio < 0.5`, that is a contradiction. Income data is incomplete.

**Monthly interest burden:**

`sum(account.balance * account.apr / 12)` for each liability account with a non-null effective APR. This is the most actionable debt metric because it is in dollars per month — directly comparable to cash flow.

Skip any account with null APR; set `hasNullAPR: true` on the annotation to tell the LLM the calculation is incomplete.

**Liquidity coverage:**

Use expenses, not income, for the denominator:
`liquidityCoverageMonths = totalLiquid / (expenseTotal / windowDays * 30)`

Expenses are more complete than income even in a partially-imported dataset — the user's outflows are usually visible even if their inflows are not. A savings account not connected to Plaid still shows expenses hitting the checking account.

---

## 9. Answers to the investigation questions — summary

**Q1** — Fields that already exist: `transactionCount`, `incomeTotal`, `byCategory` (especially Income.count), `windowDays`, `snapshotCount`, `snapshotOldestDate`, `totalLiquid`, `expenseTotal`, `health.errorCount`, `health.staleCount`. No new queries needed for the minimum viable change. The one field worth making explicit: extracting Income category `count` into `incomeTransactionCount` on `TransactionsSummaryData`.

**Q2** — Yes, incompleteness is detectable with high confidence via three converging signals: snapshot count vs. window length (strongest), income transaction count, and income-to-expense plausibility ratio. No single signal is conclusive; the combination is reliable for the reported case.

**Q3** — No confidence flag on the assembler itself. The assembler should remain a pure single-domain function. An `incomeTransactionCount` field (a derived count, not an interpretation) is a reasonable additive change. The confidence classification belongs in Layer 2.

**Q4** — All five proposed annotations are warranted:
- `incomeConfidence` — primary fix for the reported failure
- `transactionHistoryCompleteness` — broader coverage quality signal
- `deficitCauseClassification` — with `LOW_INCOME_SAMPLE` as the fourth value, overriding the other classifications when income confidence is low
- `debtHealthClassification` — with `INSUFFICIENT_DATA` when APR data is incomplete
- `currentStatePriority` — with `DATA_QUALITY` as the highest-priority value, suppressing strong cash flow claims when data is incomplete
- `liquidityCoverageMonths` (additional) — the most reliable financial metric available even when income data is incomplete; uses expense data (more complete) rather than income data

**Q5** — `lib/ai/intelligence/` as a standalone module, invoked from the chat route after `buildContext()`. Not inside the context builder (which is an assembly module, not an interpretation module) and not duplicated in the route itself.

**Q6** — Two tiers:
- **Minimal viable (smallest):** New signal type `TRANSACTION_DATA_INCOMPLETE` + new detector in `lib/ai/signals/detectors/completeness.ts` + a 4-line prompt instruction in `ADVISOR_PRINCIPLES`. Stops the specific failure with minimal code surface.
- **Proper (recommended):** `lib/ai/intelligence/annotations.ts` producing a typed `FinancialAnnotations` object, injected into the system prompt as a structured `=== FINANCIAL ASSESSMENT ===` block. Delivers structured, reliable annotations across all five categories. The assessment block ensures the LLM sees interpreted findings before raw numbers.

---

## 10. Implementation sequencing recommendation

1. **Signal minimum viable first.** Ship the `TRANSACTION_DATA_INCOMPLETE` signal + prompt instruction immediately. This addresses the reported failure. Requires 3 file changes, no type changes.

2. **Observe.** Verify the AI hedges income claims when the signal fires. Verify it does not hedge when history is complete.

3. **Then implement the intelligence module.** `lib/ai/intelligence/` gives all five annotations, enables the `=== FINANCIAL ASSESSMENT ===` block, and is the foundation for future Layer 2 expansion (net worth cause classification, capital hierarchy position, goal conflict detection).

4. **Replace the signal with the annotation.** Once the intelligence module produces `transactionHistoryCompleteness: LOW`, the `TRANSACTION_DATA_INCOMPLETE` signal is redundant. Retire the signal or keep it for the signal list in the serialized context block — both are fine.

---

## 11. Open questions for approval before implementation

1. **`incomeTransactionCount` field on `TransactionsSummaryData`.** Is this a warranted additive change to the assembler, or should the intelligence module extract the Income count from `byCategory` at runtime? The assembler change is cleaner and testable; the in-place extraction avoids changing the assembler's output type.

2. **Prompt block placement.** The `=== FINANCIAL ASSESSMENT ===` block should precede `=== SPACE CONTEXT ===` so the LLM reads the interpretation before the raw numbers. Confirm this ordering is correct.

3. **Threshold values.** The thresholds proposed (`snapshotCount < 14 → LOW`, `incomeTransactionCount < 2 → LOW`) are derived from reasoning about common pay frequencies. They should be validated against a few real user datasets before hardcoding. If the thresholds are wrong, the annotation will either miss real incompleteness (too permissive) or flag complete data as incomplete (too strict). Request: confirm against actual snapshot counts and income transaction counts for the affected user.

4. **Minimum viable vs. intelligence module — which to start with.** The minimum viable (signal approach) stops the bleeding immediately. The intelligence module is the proper solution. Recommendation is to do the signal first, but confirm this sequencing is the right call before beginning.
