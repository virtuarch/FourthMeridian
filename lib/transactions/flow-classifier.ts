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
 *    caller has them, and Plaid PFC fields ONLY if already in memory (the sync
 *    path) — never a new fetch. DESCRIPTOR-BLIND since CCPAY-2C-5: merchant and
 *    description are deliberately not accepted — see FlowClassificationInput.
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

// TI1 — the spend-ledger membership definition lives in the single-authority
// predicate module. Value-only import from a zero-import pure module: no cycle.
import { isSpendLedgerFlow } from './flow-predicates';
// CCPAY-2A/2B — liability structure (what counts as a liability account, and the
// negative-liability veto) lives in ONE authority. Also a zero-import pure
// module, so this stays Prisma-free and tsx-runnable: no cycle.
import { isLiabilityAccount, isLiabilityOutflow } from './liability-payment';

// ─────────────────────────────────────────────────────────────────────────────
// Enums (TypeScript-only in P1 — no Prisma enum is created this phase)
// ─────────────────────────────────────────────────────────────────────────────

/** Economic KIND of a movement. */
/**
 * Version of the classification LOGIC below. Persisted on each classified row
 * (Transaction.classifierVersion) so a later, improved classifier can re-run
 * over the rows an EARLIER version wrote. Bump this whenever the classification
 * rules change. Additive constant — no logic depends on it here.
 *   1 = P1 / P3 Phase B ruleset.
 *   2 = CF-4: a liability-account TRANSFER_OUT_ACCOUNT_TRANSFER outflow is a
 *       purchase (SPENDING), not a transfer — a credit card has no owned cash to
 *       transfer out.
 *   3 = CCPAY-2B/2C/2E — the accumulated liability-payment semantics:
 *         • 2B  a liability OUTFLOW can never be DEBT_PAYMENT, whatever PFC or a
 *               descriptor claims (debtPaymentUnlessLiabilityOutflow). Generalizes
 *               CF-4's argument to the LOAN_PAYMENTS and Payment-category paths.
 *         • 2C  the card-payment category rescue is normalized + word-boundary
 *               matched and shared by every ingesting path, so a liability payment
 *               leg reaches this classifier as `Payment`, not `Other`. (The rescue
 *               itself lives one layer up, in liability-payment.ts — this
 *               classifier stays descriptor-blind.)
 *         • 2E  the six MI1 M1 spend categories are known, so they classify
 *               SPENDING/REFUND instead of falling through to UNKNOWN.
 *   4 = SR-1 — the fabricated-refund correction. A positive amount in the
 *       catch-all `Other` category is NO LONGER a REFUND. `Other` is
 *       mapPlaidCategory/mapCategory's "the provider told us nothing" sentinel
 *       (absence of information), not a spend category — so a positive Other is an
 *       unclassified inflow (UNKNOWN/INFLOW, the honesty valve), never a
 *       manufactured reversal of spend. Positive amounts in GENUINE spend
 *       categories (Dining, Groceries, …) remain REFUND: a credit there is real
 *       reversal evidence. Descriptor evidence that a positive Other is actually
 *       income (payroll) is resolved into the `Income` category ONE layer up
 *       (lib/transactions/descriptor-evidence.ts) BEFORE this classifier runs, so
 *       a rescuable inflow never reaches the sign-default path as Other. This
 *       changes semantic OUTPUT for existing rows (Other/REFUND/SIGN_DEFAULT_INFLOW
 *       → UNKNOWN/AMBIGUOUS_UNKNOWN), hence the version bump: see
 *       scripts/repair-refund-misclassification.ts for the version-gated repair.
 *
 * ── OWNERSHIP, not merely staleness (CCPAY-2F) ──────────────────────────────
 * This number records WHICH AUTHORITY produced a row's persisted flow facts, and
 * only secondarily how stale they are. A convergence backfill must therefore
 * target the population a PRIOR VERSION OF THIS CLASSIFIER wrote — i.e. an exact
 * `classifierVersion = N` — never the broadest predicate that happens to match.
 *
 * In particular `classifierVersion IS NULL` does NOT mean "an old classifier
 * wrote this, safe to recompute". At the v3 migration it meant at least two
 * unrelated things: rows lib/crypto/btc-sync.ts authored with its own
 * hand-written flowType/classificationReason (a separate authority the classifier
 * does not own), and rows nothing has ever classified. Sweeping either into a
 * version migration because their version is null destroys facts this classifier
 * never produced — for the btc-sync rows it would have silently retired an
 * unknown-inflow honesty signal and raised confidence on a circular derivation.
 * See docs/doctrine/financial-semantics.md (§ Liability payment classification).
 */
export const FLOW_CLASSIFIER_VERSION = 4;

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

/**
 * ── No descriptor fields, deliberately (CCPAY-2C-5) ──────────────────────────
 * This interface carried `merchant` and `description` from the P1 foundation
 * commit until CCPAY-2C-5. The classifier NEVER read either. They were removed
 * rather than wired up, because a descriptor rule does not belong here — twice
 * over:
 *
 *  1. It would silently no-op on the live path. The two builders populated them
 *     INCONSISTENTLY: buildPlaidFlowInput set merchant but not description,
 *     while buildFlowInputFromRow set both. A descriptor rule added here would
 *     have worked on the CSV/corrections/backfill paths and done nothing on
 *     Plaid — the one path that matters. Nobody would have noticed, because a
 *     miss looks like "no rescue needed".
 *
 *  2. It would desync category from flowType. A card-payment descriptor means
 *     "this category is Payment"; flowType follows FROM category. Resolving it
 *     here would leave category='Other' beside flowType='DEBT_PAYMENT', and new
 *     rows would render as "Other" against the historical rows that say
 *     "Payment". One decision must produce both columns, so it has to happen
 *     BEFORE this function.
 *
 * The layering is therefore: descriptor → category (lib/transactions/
 * liability-payment.ts, called by every ingesting path) → flowType (here).
 * This classifier is descriptor-BLIND by contract. If you find yourself wanting
 * a merchant string in this function, the rule you are writing belongs in the
 * category layer instead.
 */
export interface FlowClassificationInput {
  /** TransactionCategory value (string-typed to avoid a Prisma import cycle). */
  category:     string;
  /** FM sign convention: + into the row's own account, − out of it. */
  amount:       number;
  /** AccountType of the row's own account, where the caller has it. */
  accountType?: string | null;
  /** FinancialAccount.debtSubtype where available (e.g. "credit_card"). */
  debtSubtype?: string | null;
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

/**
 * Every TransactionCategory whose meaning comes from the SIGN (negative = a cost,
 * positive = its reversal). Must stay a 1:1 mirror of the schema's spend values —
 * a category missing here does NOT fall back to spend, it falls through to rule 5
 * and classifies UNKNOWN, which removes the row from the spend ledger
 * (isSpendLedgerFlow), from expenseTotal (isCostFlow), and from AI context
 * entirely (isNonEconomicResidue → skipped). A missing entry is a silent
 * disappearance, not a degradation.
 *
 * CCPAY-2E — the six MI1 M1 values (Medical … Education) were absent. They are
 * "committed spend categories that rescue PFC spend primaries currently
 * collapsing to Other" (prisma/schema.prisma), written by MI M2's resolution
 * stack. Nothing writes them yet — merchant-rules.ts:24-25 records merchants
 * "blocked by a MISSING category" — so this changed ZERO rows when landed. But on
 * the day M2 shipped, every Medical/Transport/Education row would have classified
 * UNKNOWN and vanished from every economic surface: the exact opposite of the
 * rescue those categories exist to perform.
 *
 * This is the same defect lib/data/transactions.ts:96-99 already retired once —
 * a hand-listed category allow-list "silently omitting rows whose category fell
 * outside 11 hand-listed values (e.g. newer/merchant PFC categories)". The
 * classifier kept its own copy of that mistake.
 *
 * flow-category-coverage.test.ts now pins the mirror against the real Prisma
 * enum, so the next category added to the schema fails the build here rather
 * than silently deleting money from the ledger.
 */
const SPEND_CATEGORIES = new Set<string>([
  'Groceries', 'Dining', 'Shopping', 'Travel', 'Subscriptions', 'Utilities', 'Other',
  // MI1 M1 — expanded spend vocabulary (nothing writes these until MI M2).
  'Medical', 'Entertainment', 'Transport', 'PersonalCare', 'Services', 'Education',
]);

const INVESTMENT_ACTIVITY_CATEGORIES = new Set<string>([
  'Buy', 'Sell', 'Split',
]);

/**
 * SR-1 — the "provider told us nothing useful" catch-all. This is the SAME
 * sentinel lib/transactions/liability-payment.ts calls UNRESOLVED_CATEGORY: the
 * value mapPlaidCategory's `default` and the CSV importer's mapCategory fallback
 * both emit when no category could be decided.
 *
 * It is a member of SPEND_CATEGORIES only so a NEGATIVE Other still classifies
 * SPENDING (a cost with no finer label). Its POSITIVE side is NOT reversal
 * evidence — absence of information cannot prove a refund — so a positive Other
 * is deliberately routed to the honest UNKNOWN valve (rule 5) rather than
 * fabricating a REFUND. A genuine income/payment meaning is resolved into a REAL
 * category upstream (descriptor-evidence.ts / liability-payment.ts) before this
 * function ever sees the row, so nothing rescuable is lost here.
 */
const UNRESOLVED_CATEGORY = 'Other';

// ─────────────────────────────────────────────────────────────────────────────
// Direction helpers
// ─────────────────────────────────────────────────────────────────────────────

function directionFromSign(amount: number): FlowDirection {
  if (amount > 0) return 'INFLOW';
  if (amount < 0) return 'OUTFLOW';
  return 'UNKNOWN';
}

/**
 * CCPAY-2A — delegates to the ONE liability definition. Previously this module
 * carried its own copy of the same expression; it agreed with
 * plaid-category.ts's copy by luck, not by construction. Kept as a local alias
 * because `isDebtAccount(input)` reads naturally at the call sites below and
 * FlowClassificationInput is structurally a LiabilityAccountContext.
 */
function isDebtAccount(input: FlowClassificationInput): boolean {
  return isLiabilityAccount(input);
}

/**
 * CCPAY-2B — the ONLY constructor of DEBT_PAYMENT in this module, so the
 * structural veto cannot be bypassed by adding a branch that forgets it.
 *
 * Money leaving a liability account raises what you owe. That is a charge, never
 * a debt payment — regardless of what PFC, the descriptor, or the provider
 * claims. When the veto fires the row is a purchase: SPENDING/OUTFLOW at 0.7
 * with ACCOUNT_TYPE_CONTEXT, byte-identical to the shape CF-4 already returns
 * for the analogous liability TRANSFER_OUT case (see classifyFromPfc), because
 * it is the same argument applied to a path CF-4 never covered.
 *
 * NOTE this deliberately narrows the previously-unconditional
 * `Payment category → DEBT_PAYMENT` contract that
 * lib/transactions/flow-desync-invariant.test.ts and
 * scripts/audit-flow-desync.ts encode. The contract is now "unconditional EXCEPT
 * on a liability outflow"; the invariant test pins the exception explicitly.
 */
function debtPaymentUnlessLiabilityOutflow(
  input: FlowClassificationInput,
  confidence: number,
  reason: FlowReason,
): FlowClassification {
  if (isLiabilityOutflow(input)) {
    return { flowType: 'SPENDING', flowDirection: 'OUTFLOW', confidence: 0.7, reason: 'ACCOUNT_TYPE_CONTEXT' };
  }
  return {
    flowType:      'DEBT_PAYMENT',
    flowDirection: input.amount < 0 ? 'INTERNAL' : 'INFLOW',
    confidence,
    reason,
  };
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
      // CF-4 — a credit-card / liability account holds no owned cash to "transfer
      // out": an OUTFLOW Plaid filed as a generic ACCOUNT_TRANSFER is a purchase,
      // not a movement of your funds. Plaid routinely mislabels retail POS on
      // cards as TRANSFER_OUT_ACCOUNT_TRANSFER (observed: a Harvey Nichols charge).
      // Account context outranks the provider transfer tag for this exact case.
      // Cash advances are tagged TRANSFER_OUT_WITHDRAWAL (form=CASH), NOT
      // ACCOUNT_TRANSFER, so they stay TRANSFER — this never reclassifies them.
      if (isDebtAccount(input) && input.amount < 0 && detailed.includes('ACCOUNT_TRANSFER')) {
        return { flowType: 'SPENDING', flowDirection: 'OUTFLOW', confidence: 0.7, reason: 'ACCOUNT_TYPE_CONTEXT' };
      }
      return { flowType: 'TRANSFER', flowDirection: 'OUTFLOW', confidence: 0.8, reason: 'PLAID_PFC_PRIMARY' };
    case 'LOAN_PAYMENTS':
      // CCPAY-2B — Plaid routinely mislabels ordinary card purchases as
      // LOAN_PAYMENTS (observed: a restaurant bill-split app tagged
      // LOAN_PAYMENTS_CAR_PAYMENT; an Amex Travel booking tagged
      // LOAN_PAYMENTS_CREDIT_CARD_PAYMENT because the brand string matched).
      // The veto is what makes account context outrank the provider tag.
      return debtPaymentUnlessLiabilityOutflow(input, 0.8, 'PLAID_PFC_PRIMARY');
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
      //
      // CCPAY-2B — EXCEPT on a liability outflow, which is structurally a charge.
      // This path is reachable because mapPlaidCategory maps PFC LOAN_PAYMENTS →
      // "Payment" account-blind, so a mislabelled card purchase arrives here
      // carrying category "Payment". The veto is applied on BOTH DEBT_PAYMENT
      // paths so the answer cannot depend on whether PFC happened to be present.
      return debtPaymentUnlessLiabilityOutflow(input, 1.0, 'CATEGORY_FLOW_VALUE');

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
      // SR-1 — a positive amount is REFUND evidence ONLY in a GENUINE spend
      // category (Dining, Groceries, …): a credit there is the reversal of a
      // known cost. The catch-all `Other` is absence of information, never
      // reversal evidence, so a positive Other is NOT forced into a REFUND — it
      // falls through to the honest UNKNOWN valve (rule 5). A real income /
      // payment meaning behind a positive Other is resolved into a concrete
      // category ONE layer up (descriptor-evidence.ts, liability-payment.ts)
      // before this runs, so nothing rescuable reaches this branch as Other.
      if (category !== UNRESOLVED_CATEGORY) {
        return { flowType: 'REFUND', flowDirection: 'INFLOW', confidence: 0.5, reason: 'SIGN_DEFAULT_INFLOW' };
      }
      // Positive `Other` → intentionally NOT returned here; fall through to rule 5.
    } else {
      // amount === 0 in a spend category → a non-economic artifact.
      return { flowType: 'ADJUSTMENT', flowDirection: 'UNKNOWN', confidence: 0.3, reason: 'AMBIGUOUS_UNKNOWN' };
    }
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

/**
 * True when the flow contributes to the spend ledger (spend or its reversal).
 * TI1 — delegates to the single-authority predicate so the SPENDING|REFUND
 * membership is defined once; this object-shaped wrapper stays for the existing
 * `isExcludedFromSpending(classifyFlow(...))` call site in annotations.ts.
 */
export function isSpendingFlow(c: FlowClassification): boolean {
  return isSpendLedgerFlow(c.flowType);
}

/**
 * True when the flow is excluded from spending analysis. Since P5 Slice 5 this
 * IS the annotations.ts opportunity-eligibility gate (the legacy hand-written
 * SPENDING_EXCLUDED set was deleted in Slice 7); the equivalence harness in
 * flow-classifier.test.ts §3 keeps proving parity with the legacy set over the
 * banking-category domain.
 */
export function isExcludedFromSpending(c: FlowClassification): boolean {
  return !isSpendingFlow(c);
}
