/**
 * lib/debt.ts
 *
 * Pure, deterministic debt-math helpers. No DB access, no side effects —
 * safe to call from data-layer code, API routes, or tests.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";

/**
 * Estimates a monthly minimum payment when the user has supplied an APR but
 * no actual minimum payment (Plaid does not reliably provide this, and not
 * every issuer's minimum is a simple formula). This is a heuristic, NOT an
 * issuer-provided value — callers must label it "Estimated minimum payment"
 * and must prefer any manually-entered value over this estimate.
 *
 * Formula: max($35, 1% of balance + that month's interest accrual).
 */
export function estimateMinimumPayment(balance: number, aprPercent: number): number {
  const safeBalance = Math.max(0, balance);
  const safeApr     = Math.max(0, aprPercent);
  const monthlyInterest = safeBalance * (safeApr / 100 / 12);
  return Math.max(35, safeBalance * 0.01 + monthlyInterest);
}

// ── FlowType P5 Slice 3 — debt-payment rollups ────────────────────────────────

/**
 * Minimal transaction shape for the rollups below — a structural subset of the
 * Transaction DTO (types/index.ts), kept local so this module stays
 * dependency-free.
 *
 * currency/dateISO (MC1 Phase 2 Slice 4): optional conversion inputs. Only
 * consulted when a ConversionContext is supplied; rows without them degrade
 * per plan D-3 (native amount, estimated) — with the Phase 2 identityContext
 * the arithmetic is identical either way (golden-pinned).
 */
export interface DebtPaymentTxnLike {
  accountId: string;
  amount: number;
  flowType?: string | null;
  currency?: string | null;
  /** Row valuation date ("YYYY-MM-DD") for historical FX (plan D-6). */
  dateISO?: string;
}

/**
 * MC1 Phase 2 Slice 4 — per-row amount in the context target. No context ⇒
 * the native amount, byte-for-byte (kill switch). Convert-then-abs: with
 * positive rates, |convert(x)| === convert(|x|), so the abs-sum shape of the
 * rollups is preserved; under identity it is exactly the native |amount|.
 */
function rowAmount(
  t: DebtPaymentTxnLike,
  ctx?: ConversionContext,
  flag?: { estimated: boolean },
): number {
  if (!ctx) return t.amount;
  const c = convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.dateISO ?? "", ctx);
  if (c.estimated && flag) flag.estimated = true; // MC1 P3 Slice 2 — taint (D-7)
  return c.amount;
}

/**
 * Total paid toward debt: Σ|amount| over `flowType = DEBT_PAYMENT` rows.
 * Replaces the legacy `category === 'Payment'` string heuristic (P5 Slice 3).
 *
 * Sign-agnostic by design: destination-side legs on debt accounts carry either
 * sign depending on source convention (see flow-classifier.ts — DEBT_PAYMENT
 * is INTERNAL when negative, INFLOW when positive), matching the abs-sum shape
 * of the legacy computation. Rows with null flowType are excluded — the
 * non-null invariant holds for all production writers (P5 Slice 0 + backfill).
 */
export function totalDebtPaid(txs: DebtPaymentTxnLike[], ctx?: ConversionContext): number {
  let sum = 0;
  for (const t of txs) {
    if (t.flowType === 'DEBT_PAYMENT') sum += Math.abs(rowAmount(t, ctx));
  }
  return sum;
}

/** One liability's received payments within the caller's row scope. */
export interface DebtPaymentRollupEntry {
  accountId: string;
  total: number;
  count: number;
  /**
   * MC1 Phase 3 Slice 2 (plan D-7) — true when any converted row in this
   * entry was estimated (walk-back / miss / null-residue). Always emitted;
   * false on the context-less path. Rendered nowhere until Phase 4.
   */
  estimated: boolean;
}

/**
 * Per-liability debt-payment rollup (the KD-18 capability): destination-side
 * DEBT_PAYMENT legs grouped by account id, sorted descending by total.
 * Callers pass rows already scoped to debt accounts (getDebtTransactions),
 * so each row's accountId identifies the liability that received the payment.
 */
export function rollupDebtPaymentsByAccount(
  txs: DebtPaymentTxnLike[],
  ctx?: ConversionContext,
): DebtPaymentRollupEntry[] {
  const byAccount = new Map<string, DebtPaymentRollupEntry>();
  for (const t of txs) {
    if (t.flowType !== 'DEBT_PAYMENT') continue;
    let entry = byAccount.get(t.accountId);
    if (!entry) {
      entry = { accountId: t.accountId, total: 0, count: 0, estimated: false };
      byAccount.set(t.accountId, entry);
    }
    const flag = { estimated: false };
    entry.total += Math.abs(rowAmount(t, ctx, flag));
    entry.count += 1;
    if (flag.estimated) entry.estimated = true;
  }
  return [...byAccount.values()].sort((a, b) => b.total - a.total);
}
