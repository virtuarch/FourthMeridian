/**
 * lib/transactions/cash-flow-context.ts
 *
 * CF-1 — the Cash Flow Perspective "context" projection. Pure, presentation-facing
 * grouping of the period's transactions into two human sections, consuming ONLY
 * existing canonical facts (liquidity effect + transferDisposition + the TE-2B
 * needsClassification flag). It computes NO money totals that feed Cash In / Cash
 * Out / Net Cash — those are derived from the canonical DayFacts fold and untouched.
 *
 * Scope invariant (keeps the context honest and non-double-counting): the
 * "Moved, not spent" buckets contain ONLY transfers that are liquidity-NEUTRAL or
 * UNRESOLVED — i.e. movements that did NOT register as Cash In or Cash Out. Rows
 * already counted in Cash In/Out (earned income, real cost, owned asset
 * deploy/liquidate) never appear here, so no dollar is represented twice.
 *
 * Payment-app movement is shown as a named "Moved, not spent" row (it is a
 * transfer, not spending). "Needs classification" then surfaces the remaining
 * TE-2B rows that are NOT already a recognizable movement — i.e. unidentified
 * inflows — so every row lands in at most ONE displayed group (zero overlap) while
 * still consuming the same predicate. It is a review flag, never subtracted.
 */

import { classifyLiquidity, type LiquidityTx, type LiquidityContext } from "@/lib/transactions/liquidity";
import type { TransferDisposition } from "@/lib/transactions/transfer-evidence";
import { deriveCashMovement } from "@/lib/transactions/cash-movement";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";

/** A displayed context row: a human label + its magnitude, count, and drill-down rows. */
export interface CashFlowContextRow {
  key:    string;
  label:  string;
  amount: number;          // Σ|amount| (moved, not spent) — never part of Cash In/Out
  count:  number;
  rows:   Transaction[];   // the exact transactions behind the row (for the slice drawer)
}

export interface CashFlowContext {
  /** Money that moved without new spending, grouped by disposition. */
  movedNotSpent:       CashFlowContextRow[];
  /** Rows Fourth Meridian can see moved but can't yet explain (TE-2B). Count-first. */
  needsClassification: CashFlowContextRow[];
}

/**
 * Human, non-technical label for a NEUTRAL/UNRESOLVED transfer, by disposition and
 * (for cash / investments) direction. No disposition/FlowType/provider terminology.
 * Cash direction comes from CM-1 (deriveCashMovement); investment direction from sign.
 */
function movedLabel(disposition: TransferDisposition, amount: number): { key: string; label: string } | null {
  switch (disposition) {
    case "INTERNAL_TRANSFER":
      return { key: "between-accounts", label: "Between your accounts" };
    // CF-2B — PAYMENT_APP_MOVEMENT is no longer a "Moved, not spent" bucket: liquid
    // payment-app rows are Cash In/Out ("From payment apps" / "Payments through apps"),
    // and the non-liquid (liability) leg is neutral and not surfaced (a card charge).
    case "CASH_MOVEMENT": {
      const cm = deriveCashMovement({ transferMovementForm: "CASH", amount });
      // Audit CF-2B: this bucket is overwhelmingly ATM/branch withdrawals — the
      // concrete label the data earned. Deposits keep their own row.
      return cm?.direction === "DEPOSIT"
        ? { key: "cash-deposited", label: "Cash deposited" }
        : { key: "cash-withdrawals", label: "Cash withdrawals" };
    }
    // CF-2 — ASSET_VENUE_TRANSFER is no longer "Moved, not spent": liquid-account
    // venue movements are recognized as Cash In ("From investments") / Cash Out
    // ("Money invested") on the liquidity axis; the non-liquid (debt) leg is neutral
    // and deliberately not surfaced here (like a credit-card purchase).
    case "EXTERNAL_BANK_TRANSFER":
    case "UNKNOWN_MOVEMENT":
      // Audit CF-2B: honest review label — these are transfers whose counterparty/
      // evidence is unresolved (external banks + no-evidence + upstream-misclassified
      // rows), not a meaningful financial category.
      return { key: "unresolved-transfers", label: "Unresolved transfers" };
    default:
      return null;
  }
}

// V25-FINAL-1 — `null` when the row's conversion is UNAVAILABLE (no rate); the
// caller EXCLUDES such rows rather than blending a native magnitude or a fake 0.
function magnitude(t: LiquidityTx, ctx?: ConversionContext): number | null {
  if (!ctx) return Math.abs(t.amount);
  const amt = convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount;
  return amt === null ? null : Math.abs(amt);
}

function upsert(map: Map<string, CashFlowContextRow>, key: string, label: string, t: LiquidityTx, amt: number): void {
  const row = map.get(key);
  if (row) { row.amount += amt; row.count += 1; row.rows.push(t as Transaction); }
  else map.set(key, { key, label, amount: amt, count: 1, rows: [t as Transaction] });
}

/**
 * Group the period's rows into the two context sections. Each row lands in at most
 * one displayed group: needsClassification takes precedence (actionable), then
 * NEUTRAL/UNRESOLVED transfers by disposition; everything else (Cash In/Out rows,
 * ordinary spending/income) is excluded.
 */
export function groupCashFlowContext(
  transactions: LiquidityTx[],
  liquidityCtx: LiquidityContext,
  moneyCtx?: ConversionContext,
): CashFlowContext {
  const moved = new Map<string, CashFlowContextRow>();
  const needs = new Map<string, CashFlowContextRow>();

  for (const t of transactions) {
    const amt = magnitude(t, moneyCtx);
    if (amt === null) continue; // V25-FINAL-1 — unconvertible row excluded from the context groups
    const disposition = (t as { transferDisposition?: TransferDisposition | null }).transferDisposition ?? null;
    const needsClassification = (t as { needsClassification?: boolean }).needsClassification ?? false;

    // 1. Needs classification — the actionable review flag. Only UNIDENTIFIED INFLOWS
    //    (an INCOME row with no transfer disposition) into a LIQUID account: an
    //    ambiguous bank deposit. Payment-app rows (disposition set) are excluded here —
    //    they are handled on the liquidity axis (Cash In/Out) or as a neutral leg.
    //    Inflows into asset accounts (e.g. on-chain crypto receipts) are excluded too.
    if (needsClassification && disposition == null) {
      const ownTier = liquidityCtx.tierOf(t.financialAccountId ?? t.accountId ?? null);
      if (ownTier === "liquid") upsert(needs, "unknown-inflow", "Money in, source unknown", t, amt);
      continue;
    }

    // 2. Money that MOVED but is not in Cash In/Out — NEUTRAL/UNRESOLVED transfers.
    if (disposition == null) continue; // non-transfer (spending/income/etc.) — not context
    const effect = classifyLiquidity(t, liquidityCtx).effect;
    if (effect !== "NEUTRAL" && effect !== "UNRESOLVED") continue; // already in Cash In/Out
    const label = movedLabel(disposition, t.amount);
    if (!label) continue;
    upsert(moved, label.key, label.label, t, amt);
  }

  return {
    movedNotSpent:       [...moved.values()].sort((a, b) => b.amount - a.amount),
    needsClassification: [...needs.values()].sort((a, b) => b.count - a.count),
  };
}
