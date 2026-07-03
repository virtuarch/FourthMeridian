/**
 * lib/transactions/flow-classifier.ts
 *
 * Single source of truth for TRANSACTION FLOW semantics (v2.5.5 FlowType, P1).
 *
 * A pure, deterministic classifier that answers "what economic KIND of money
 * movement is this, and in what DIRECTION" from the fields Fourth Meridian
 * already holds in memory. It changes no numbers today: P1 introduces the
 * module and its tests only — no schema, no persisted column, no read cutover.
 * Later phases persist its output (P3) and route the scattered ad-hoc
 * definitions through it (P5). See:
 *   docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md      (design)
 *   docs/initiatives/flowtype/P1_CLASSIFIER_IMPLEMENTATION_CHECKLIST.md (this phase)
 *
 * Design contract (P1):
 *  - PURE: same input → same output. No DB, no I/O, no Date.now, no randomness,
 *    no env reads. Safe to call from data-layer code, API routes, or tests.
 *  - PRISMA-FREE: `category` and `accountType` are typed as plain strings so
 *    this module never imports the generated client (avoids an import cycle and
 *    keeps it runnable under `tsx` without `prisma generate`). Callers pass the
 *    TransactionCategory / AccountType enum values, which are already strings.
 *  - EXISTING FIELDS ONLY: category, amount (FM sign convention: + = into the
 *    row's own account, − = out of it), account type / debtSubtype where the
 *    caller has them, merchant/description if needed, and Plaid PFC fields ONLY
 *    if already in memory (the sync path) — never a new fetch.
 *  - NEVER THROWS: an unmappable row returns a defined classification
 *    (UNKNOWN / ADJUSTMENT), never an exception — mirroring the "never block a
 *    row" contract of mapPlaidCategory() and mapCategory().
 *  - HONESTY VALVE: when signals conflict or are insufficient, return UNKNOWN
 *    with low confidence rather than forcing a wrong SPENDING value. This keeps
 *    the KD-18 posture (never fabricate) expressed in data form.
 *
 * Value sets deliberately match FLOWTYPE_FOUNDATION_INVESTIGATION.md §3 so a
 * later Prisma enum (P3) can promote them 1:1.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums (TypeScript-only in P1 — no Prisma enum is created this phase)
// ─────────────────────────────────────────────────────────────────────────────

/** Economic KIND of a movement. */
export type FlowType =
  | 'SPENDING'      // discretionary/non-discretionary consumption (a real cost)
  | 'INCOME'        // earnings: payroll, dividends received, interest earned
  | 'REFUND'        // reversal of a prior SPENDING — reduces spend, is NOT income
  | 'DEBT_PAYMENT'  // liability reduction (card payment, loan principal) — not spend
  | 'TRANSFER'      // movement between accounts — not spend, not income
  | 'INVESTMENT'    // asset conversion / security activity — feeds net worth
  | 'FEE'           // bank/card/service fee — a real cost, distinct from SPENDING
  | 'INTEREST'      // interest charged (cost) or the interest leg of a debt payment
  | 'ADJUSTMENT'    // balance corrections, provider artifacts, non-economic rows
  | 'UNKNOWN';      // classifier could not decide with acceptable confidence

/** Economic DIRECTION, decoupled from the per-account amount sign. */
export type FlowDirection =
  | 'INFLOW'    // money entering the user's world from outside
  | 'OUTFLOW'   // money leaving the user's world
  | 'INTERNAL'  // both endpoints are the user's own accounts (by flow kind)
  | 'UNKNOWN';

/** Stable, testable reason for the decision — never user-facing prose. */
export type FlowReason =
  | 'PLAID_PFC_DETAILED'        // decided from personal_finance_category.detailed
  | 'PLAID_PFC_PRIMARY'         // decided from personal_finance_category.primary
  | 'CATEGORY_FLOW_VALUE'       // category was itself a flow value (Transfer/Payment/…)
  | 'CATEGORY_INVESTMENT_VALUE' // Buy/Sell/Dividend/Split/Fee investment set
  | 'ACCOUNT_TYPE_CONTEXT'      // debtSubtype / accountType disambiguated the row
  | 'SIGN_DEFAULT_SPENDING'     // fell through to negative-amount = SPENDING
  | 'SIGN_DEFAULT_INFLOW'       // positive amount, no stronger signal → REFUND/inflow
  | 'AMBIGUOUS_UNKNOWN';        // below confidence threshold → UNKNOWN, never forced

export interface FlowClassificationInput {
  /** TransactionCategory value (string-typed to avoid a Prisma import cycle). */
  category:     string;
  /** FM sign convention: + into the row's own account, − out of it. */
  amount:       number;
  /** AccountType of the row's own account, where the caller has it. */
  accountType?: string | null;
  /** FinancialAccount.debtSubtype where available (e.g. "credit_card"). */
  debtSubtype?: string | null;
  merchant?:    string | null;
  description?: string | null;
  /** Plaid personal_finance_category.primary — ONLY if already in memory. */
  pfcPrimary?:  string | null;
  /** Plaid personal_finance_category.detailed — ONLY if already in memory. */
  pfcDetailed?: string | null;
}

export interface FlowClassification {
  flowType:      FlowType;
  flowDirection: FlowDirection;
  /** 0..1. Low values gate UNKNOWN and downstream AI honesty disclosures. */
  confidence:    number;
  reason:        FlowReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Known category sets (mirror prisma/schema.prisma TransactionCategory)
// ─────────────────────────────────────────────────────────────────────────────

const SPEND_CATEGORIES = new Set<string>([
  'Groceries', 'Dining', 'Shopping', 'Travel', 'Subscriptions', 'Utilities', 'Other',
]);

const INVESTMENT_ACTIVITY_CATEGORIES = new Set<string>([
  'Buy', 'Sell', 'Split',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Direction helpers
// ─────────────────────────────────────────────────────────────────────────────

function directionFromSign(amount: number): FlowDirection {
  if (amount > 0) return 'INFLOW';
  if (amount < 0) return 'OUTFLOW';
  return 'UNKNOWN';
}

function isDebtAccount(input: FlowClassificationInput): boolean {
  return input.accountType === 'debt' || (input.debtSubtype != null && input.debtSubtype !== '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Plaid PFC path (dormant in P1 — exercised only when a caller passes PFC,
// which no persisted read path does yet; the future sync/import write path will)
// ─────────────────────────────────────────────────────────────────────────────

function classifyFromPfc(input: FlowClassificationInput): FlowClassification | null {
  const detailed = (input.pfcDetailed ?? '').toUpperCase();
  const primary  = (input.pfcPrimary ?? '').toUpperCase();

  // Detailed-level overrides — more precise than the primary bucket alone.
  if (detailed.includes('INTEREST')) {
    // Interest EARNED on a non-debt account is income; interest CHARGED is a cost.
    const earned = !isDebtAccount(input) && input.amount > 0;
    return earned
      ? { flowType: 'INCOME',   flowDirection: 'INFLOW',  confidence: 0.9, reason: 'PLAID_PFC_DETAILED' }
      : { flowType: 'INTEREST', flowDirection: 'OUTFLOW', confidence: 0.9, reason: 'PLAID_PFC_DETAILED' };
  }

  if (!primary) return null;

  switch (primary) {
    case 'INCOME':
      return { flowType: 'INCOME', flowDirection: 'INFLOW', confidence: 0.8, reason: 'PLAID_PFC_PRIMARY' };
    case 'TRANSFER_IN':
      return { flowType: 'TRANSFER', flowDirection: 'INFLOW', confidence: 0.8, reason: 'PLAID_PFC_PRIMARY' };
    case 'TRANSFER_OUT':
      return { flowType: 'TRANSFER', flowDirection: 'OUTFLOW', confidence: 0.8, reason: 'PLAID_PFC_PRIMARY' };
    case 'LOAN_PAYMENTS':
      return { flowType: 'DEBT_PAYMENT', flowDirection: input.amount < 0 ? 'INTERNAL' : 'INFLOW', confidence: 0.8, reason: 'PLAID_PFC_PRIMARY' };
    case 'BANK_FEES':
      return { flowType: 'FEE', flowDirection: 'OUTFLOW', confidence: 0.8, reason: 'PLAID_PFC_PRIMARY' };
    case 'FOOD_AND_DRINK':
    case 'GENERAL_MERCHANDISE':
    case 'GENERAL_SERVICES':
    case 'PERSONAL_CARE':
    case 'ENTERTAINMENT':
    case 'RENT_AND_UTILITIES':
    case 'TRAVEL':
    case 'TRANSPORTATION':
    case 'HOME_IMPROVEMENT':
    case 'MEDICAL':
      // Spend primaries: a positive amount here is a refund, not income.
      return input.amount > 0
        ? { flowType: 'REFUND',   flowDirection: 'INFLOW',  confidence: 0.7, reason: 'PLAID_PFC_PRIMARY' }
        : { flowType: 'SPENDING', flowDirection: 'OUTFLOW', confidence: 0.8, reason: 'PLAID_PFC_PRIMARY' };
    default:
      return null; // unrecognized primary → fall through to category/sign path
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyFlow — the single entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies one transaction's economic flow from in-memory fields.
 * Precedence: Plaid PFC (if supplied) → flow-value category → account-type
 * context → sign default. First rule that fires wins and sets `reason`.
 */
export function classifyFlow(input: FlowClassificationInput): FlowClassification {
  const { category, amount } = input;

  // 1. Provider taxonomy first — only when the caller already has it in memory.
  if (input.pfcPrimary || input.pfcDetailed) {
    const fromPfc = classifyFromPfc(input);
    if (fromPfc) return fromPfc;
  }

  // 2. Flow-value categories — the category is itself the economic signal.
  switch (category) {
    case 'Transfer':
      return { flowType: 'TRANSFER', flowDirection: directionFromSign(amount), confidence: 1.0, reason: 'CATEGORY_FLOW_VALUE' };

    case 'Payment':
      // A payment ROW is a debt payment regardless of leg. Source leg (amount<0,
      // paid FROM an owned account) is INTERNAL; destination leg (amount>0,
      // received BY the liability) is an inflow to that liability.
      return { flowType: 'DEBT_PAYMENT', flowDirection: amount < 0 ? 'INTERNAL' : 'INFLOW', confidence: 1.0, reason: 'CATEGORY_FLOW_VALUE' };

    case 'Interest': {
      const debt = isDebtAccount(input);
      if (debt) {
        return { flowType: 'INTEREST', flowDirection: 'OUTFLOW', confidence: 1.0, reason: 'ACCOUNT_TYPE_CONTEXT' };
      }
      // Non-debt / unknown account: interest received is income, interest paid is a cost.
      return amount > 0
        ? { flowType: 'INCOME',   flowDirection: 'INFLOW',  confidence: input.accountType ? 0.8 : 0.6, reason: input.accountType ? 'ACCOUNT_TYPE_CONTEXT' : 'CATEGORY_FLOW_VALUE' }
        : { flowType: 'INTEREST', flowDirection: 'OUTFLOW', confidence: input.accountType ? 0.8 : 0.6, reason: input.accountType ? 'ACCOUNT_TYPE_CONTEXT' : 'CATEGORY_FLOW_VALUE' };
    }

    case 'Income':
      return { flowType: 'INCOME', flowDirection: amount >= 0 ? 'INFLOW' : 'OUTFLOW', confidence: amount >= 0 ? 1.0 : 0.5, reason: 'CATEGORY_FLOW_VALUE' };

    case 'Fee':
      return { flowType: 'FEE', flowDirection: amount > 0 ? 'INFLOW' : 'OUTFLOW', confidence: 1.0, reason: 'CATEGORY_FLOW_VALUE' };

    case 'Dividend':
      // Dividends RECEIVED are real (taxable) income by doctrine (foundation §5).
      return { flowType: 'INCOME', flowDirection: 'INFLOW', confidence: 0.7, reason: 'CATEGORY_INVESTMENT_VALUE' };
  }

  // 3. Investment security-activity categories (Buy/Sell/Split).
  if (INVESTMENT_ACTIVITY_CATEGORIES.has(category)) {
    return { flowType: 'INVESTMENT', flowDirection: 'INTERNAL', confidence: 1.0, reason: 'CATEGORY_INVESTMENT_VALUE' };
  }

  // 4. Spend/merchant categories — meaning comes from the sign.
  if (SPEND_CATEGORIES.has(category)) {
    if (amount < 0) {
      return { flowType: 'SPENDING', flowDirection: 'OUTFLOW', confidence: 0.5, reason: 'SIGN_DEFAULT_SPENDING' };
    }
    if (amount > 0) {
      // Positive in a spend category → a refund/reversal, NOT income.
      return { flowType: 'REFUND', flowDirection: 'INFLOW', confidence: 0.5, reason: 'SIGN_DEFAULT_INFLOW' };
    }
    // amount === 0 in a spend category → a non-economic artifact.
    return { flowType: 'ADJUSTMENT', flowDirection: 'UNKNOWN', confidence: 0.3, reason: 'AMBIGUOUS_UNKNOWN' };
  }

  // 5. Unknown category string — honest UNKNOWN, never forced into SPENDING.
  if (amount < 0) {
    return { flowType: 'UNKNOWN', flowDirection: 'OUTFLOW', confidence: 0.2, reason: 'AMBIGUOUS_UNKNOWN' };
  }
  if (amount > 0) {
    return { flowType: 'UNKNOWN', flowDirection: 'INFLOW', confidence: 0.2, reason: 'AMBIGUOUS_UNKNOWN' };
  }
  return { flowType: 'UNKNOWN', flowDirection: 'UNKNOWN', confidence: 0.1, reason: 'AMBIGUOUS_UNKNOWN' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience predicates (for safe call-site routing in later phases)
// ─────────────────────────────────────────────────────────────────────────────

/** True when the flow contributes to the spend ledger (spend or its reversal). */
export function isSpendingFlow(c: FlowClassification): boolean {
  return c.flowType === 'SPENDING' || c.flowType === 'REFUND';
}

/**
 * True when the flow is excluded from spending analysis — the classifier
 * counterpart of annotations.ts SPENDING_EXCLUDED. Not routed in P1 (see the
 * checklist §1.2 gate); exported so the equivalence harness can prove where it
 * does and does not reproduce the legacy set.
 */
export function isExcludedFromSpending(c: FlowClassification): boolean {
  return !isSpendingFlow(c);
}
