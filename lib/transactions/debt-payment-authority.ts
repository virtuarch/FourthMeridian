/**
 * lib/transactions/debt-payment-authority.ts   (v2.6-TRUTH-7)
 *
 * THE single answer to "how much did I pay toward debt?"
 *
 * Pure: no DB, no React, no clock. It selects and sums; it classifies nothing.
 *
 * ── The question this settles ───────────────────────────────────────────────
 *
 * A card payment is TWO rows. Money leaves a checking account (the CASH leg)
 * and arrives on a card (the LIABILITY leg). Both are persisted `DEBT_PAYMENT`,
 * and both are true. Summing both counts the payment twice.
 *
 * Before this module, two surfaces answered the same question differently:
 *
 *     DebtPaymentsWidget   classifyLiquidity → CASH_OUT/DEBT_PAYMENT    $245,592.37   120 rows
 *     DebtClient           isDebtPayment(flowType) on debt accounts     $239,592.37   118 rows
 *     lib/debt.ts over BOTH legs (one unscoped caller away)             $485,184.74   238 rows
 *
 * ── The counted leg is CASH, and why ────────────────────────────────────────
 *
 * Measured on the live corpus:
 *
 *   · 26 cash legs ($50,150) carry NO counterparty at all — payments toward
 *     liabilities that are not connected to this app. The liability leg for
 *     those does not exist and never will. A liability-leg total silently omits
 *     them, and reports a smaller number than the money that actually left.
 *   · One $4,000 Amex payment from CHASE COLLEGE (2026-08-03) has no liability
 *     leg in the corpus at all.
 *
 * The cash leg is what YOU did: money you moved toward debt. The liability leg
 * is the creditor's record of receiving it, which is a different fact, complete
 * only for liabilities you happen to have connected. Cash Flow's liquidity axis
 * already counts the cash leg, so choosing it also makes Debt and Cash Flow
 * agree without either one adjusting.
 *
 * ⚠️ The liability leg is NOT discarded — it answers a different question, and
 * `rollupDebtPaymentsByAccount` (lib/debt.ts) still uses it, because only that
 * leg names WHICH liability received the money. Two questions, two answers, one
 * module saying which is which.
 *
 * ── Refusal by construction ─────────────────────────────────────────────────
 *
 * `selectDebtPaymentCashLegs` takes a tier resolver and does the selection
 * itself. A caller cannot hand it both legs and get a double count, because a
 * caller does not choose what is counted — this module does. That is why the
 * signature requires the context rather than trusting the caller to pre-filter.
 */

import { classifyLiquidity, type LiquidityContext, type LiquidityTx } from "@/lib/transactions/liquidity";

/**
 * WHICH LEG COUNTS. Named, exported, and asserted by a test — so the decision is
 * a fact in the codebase rather than a convention three surfaces remember.
 */
export const COUNTED_DEBT_PAYMENT_LEG = "CASH" as const;

/**
 * v2.6-DEBT-1 — the debt-payment attestation rule lives in its own module.
 *
 * It cannot live here: this module imports `classifyLiquidity`, and the
 * liquidity axis is the thing that must consult the rule — importing back would
 * be a cycle. Re-exported so callers still find it where they look for
 * debt-payment decisions.
 */
export { isDebtPaymentAttested } from "@/lib/transactions/debt-payment-attestation";

export interface DebtPaymentSelection<T> {
  /** The rows that count. Sum these; never sum anything else. */
  counted: T[];
  /**
   * The other leg of the same payments — real rows, deliberately not counted.
   * Surfaced so a caller can say "118 liability legs were excluded" instead of
   * a total quietly differing from a neighbouring screen.
   */
  excludedLiabilityLegs: T[];
}

/**
 * Select the cash legs of debt payments from ANY row set.
 *
 * Idempotent under re-selection and safe on mixed input: passing both legs,
 * only the liability legs, or the whole banking population all yield the same
 * counted set.
 *
 * The membership test is `classifyLiquidity` — the existing canonical authority.
 * This module adds no predicate of its own.
 */
export function selectDebtPaymentCashLegs<T extends LiquidityTx>(
  rows: readonly T[],
  ctx: LiquidityContext,
): DebtPaymentSelection<T> {
  const counted: T[] = [];
  const excludedLiabilityLegs: T[] = [];
  for (const r of rows) {
    const c = classifyLiquidity(r, ctx);
    if (c.reason !== "DEBT_PAYMENT") continue;
    // CASH_OUT is the spendable-cash leg; the liability-side leg is NEUTRAL.
    if (c.effect === "CASH_OUT") counted.push(r);
    else excludedLiabilityLegs.push(r);
  }
  return { counted, excludedLiabilityLegs };
}

export interface DebtPaidTotal {
  total: number;
  count: number;
  /** How many rows of the OTHER leg were present and excluded. */
  excludedLiabilityLegCount: number;
  /**
   * V25-FINAL-1 — true when a counted row had no acceptable FX rate and was left
   * out of `total`. The total is then a partial, and a surface must say so.
   */
  unconverted: boolean;
}

/**
 * Total paid toward debt: Σ|amount| over the CASH legs only.
 *
 * `magnitude` converts and absolutes a row (the caller owns the money context so
 * this stays pure); returning `null` excludes the row and sets `unconverted`.
 */
export function totalDebtPaid<T extends LiquidityTx>(
  rows: readonly T[],
  ctx: LiquidityContext,
  magnitude: (row: T) => number | null,
): DebtPaidTotal {
  const { counted, excludedLiabilityLegs } = selectDebtPaymentCashLegs(rows, ctx);
  let total = 0;
  let count = 0;
  let unconverted = false;
  for (const r of counted) {
    const m = magnitude(r);
    if (m === null) { unconverted = true; continue; }
    total += Math.abs(m);
    count += 1;
  }
  return { total, count, excludedLiabilityLegCount: excludedLiabilityLegs.length, unconverted };
}


// ─────────────────────────────────────────────────────────────────────────────
// CREDITOR ATTRIBUTION — a SEPARATE question from "is this a debt payment"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How certain we are about WHICH creditor received a payment.
 *
 * ⚠️ Orthogonal to membership. A row is a debt payment or it is not — decided
 * above, by `selectDebtPaymentCashLegs`. This axis only says whether we may NAME
 * the account, and it can never remove a payment from the total.
 */
export type CreditorCertainty =
  /** The counterparty authority resolved an OWNED LIABILITY account. Nameable. */
  | "ACCOUNT_CERTAIN"
  /**
   * The transfer authority proved the destination TYPE is a liability but could
   * not establish WHICH one — typically because two cards were paid the same day
   * for the same amount, which no evidence distinguishes. 18 live rows
   * ($34,500). The payment is real; the creditor is not nameable.
   */
  | "ACCOUNT_AMBIGUOUS"
  /** Neither an owned liability counterparty nor a destination-type proof. */
  | "NONE";

/** The account facts this module may consult. NO descriptor, ever. */
export interface CreditorAccountRef {
  id: string;
  name?: string | null;
  type: string;
}

/** The row facts this module may consult — both are other authorities' verdicts. */
export interface CreditorEvidence {
  /** Resolved by the transfer authority / persisted link. */
  counterpartyAccountId?: string | null;
  /** The transfer authority's destination verdict. */
  transferMaturity?: string | null;
}

export interface CreditorAttribution {
  certainty: CreditorCertainty;
  /** The creditor account — ONLY when ACCOUNT_CERTAIN. Null otherwise, always. */
  accountId: string | null;
}

/**
 * Which creditor received this payment?
 *
 * ⚠️ There is no merchant string, description or institution name in this
 * function, and a probe asserts it. The descriptor "AMERICAN EXPRESS ACH PMT
 * M4082" names an institution that issues several products; it is not identity.
 */
export function attributeCreditor(
  e: CreditorEvidence,
  accounts: ReadonlyMap<string, CreditorAccountRef>,
): CreditorAttribution {
  const cp = e.counterpartyAccountId ? accounts.get(e.counterpartyAccountId) : undefined;
  if (cp?.type === "debt") return { certainty: "ACCOUNT_CERTAIN", accountId: cp.id };
  // The destination TYPE is proven even where the account is not.
  if (e.transferMaturity === "DEBT_PAYMENT") return { certainty: "ACCOUNT_AMBIGUOUS", accountId: null };
  return { certainty: "NONE", accountId: null };
}

/** The single bucket every un-nameable creditor lands in. */
export const UNRESOLVED_CREDITOR_KEY = "__creditor_unresolved__";
export const UNRESOLVED_CREDITOR_LABEL = "Debt account not determined";

export interface DebtPaymentGroup {
  /** Stable grouping key: the creditor account id, or the unresolved sentinel. */
  id: string;
  label: string;
  value: number;
  count: number;
  /**
   * The rows that produced `value`, recorded on the SAME pass and under the SAME
   * skip rule. A drill-down reads these instead of re-deriving the match, which
   * would re-admit the rows this total left out.
   */
  transactionIds: string[];
  /** The creditor account, or null for the unresolved bucket. */
  creditorAccountId: string | null;
}

/**
 * Group counted debt payments by their CREDITOR ACCOUNT.
 *
 * ── What this replaces, and why ─────────────────────────────────────────────
 *
 * The previous grouping normalised the payment DESCRIPTOR and used it as the
 * creditor key, so 18 rows whose creditor account is permanently unknowable
 * appeared beneath confident headings like "American Express Ach" and "Payment
 * To Chase Card". Those headings read as creditors and were descriptor labels —
 * the card total was right while its breakdown claimed more than the evidence
 * carried, and the same descriptor class is what mis-filed a savings transfer as
 * a card payment one slice earlier.
 *
 * ⚠️ GROUPING IS PRESENTATION ONLY. Every input row lands in exactly one group,
 * so Σ(group values) == Σ(row magnitudes) and membership is untouched. An
 * un-nameable creditor changes the HEADING a payment sits under, never whether
 * it counts.
 */
export function groupDebtPaymentsByCreditor<T extends CreditorEvidence & { id: string }>(
  payments: readonly T[],
  accounts: ReadonlyMap<string, CreditorAccountRef>,
  // V25-FINAL-1 — `null` means no acceptable FX rate: the row is EXCLUDED from
  // the group (never a native magnitude, never a fake 0).
  magnitude: (t: T) => number | null,
): DebtPaymentGroup[] {
  const by = new Map<string, { value: number; count: number; ids: string[]; accountId: string | null }>();
  for (const t of payments) {
    const m = magnitude(t);
    if (m === null) continue;
    // ⚠️ ABS here, matching `totalDebtPaid`. A cash leg is negative, so a caller
    // supplying a signed converter would otherwise sum to a negative group and
    // have it dropped by the `value > 0` filter — the heading would vanish while
    // the total stayed right. The authority takes the magnitude so no caller can
    // get this half-right.
    const value = Math.abs(m);
    const { certainty, accountId } = attributeCreditor(t, accounts);
    const key = certainty === "ACCOUNT_CERTAIN" && accountId ? accountId : UNRESOLVED_CREDITOR_KEY;
    const g = by.get(key) ?? { value: 0, count: 0, ids: [], accountId: key === UNRESOLVED_CREDITOR_KEY ? null : accountId };
    g.value += value;
    g.count += 1;
    g.ids.push(t.id);
    by.set(key, g);
  }
  return [...by.entries()]
    .map(([key, g]) => ({
      id: key,
      // The account's own name, from the account graph. Never a descriptor, and
      // never an institution string standing in for an account.
      label: g.accountId
        ? (accounts.get(g.accountId)?.name?.trim() || "Liability account")
        : UNRESOLVED_CREDITOR_LABEL,
      value: g.value,
      count: g.count,
      transactionIds: g.ids,
      creditorAccountId: g.accountId,
    }))
    .filter((g) => g.value > 0)
    // Named creditors first, then the unresolved bucket — which sorts last
    // regardless of size, because it is a disclosure rather than a creditor.
    .sort((a, b) =>
      (a.creditorAccountId === null ? 1 : 0) - (b.creditorAccountId === null ? 1 : 0)
      || b.value - a.value);
}
