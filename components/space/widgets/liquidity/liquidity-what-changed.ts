/**
 * components/space/widgets/liquidity/liquidity-what-changed.ts
 *
 * S4 — the deterministic row-builder behind the Liquidity "What Changed" panel.
 * Pure, DB-free, injected-clock (unit-testable under tsx). Sourced entirely from
 * the landed, Cash-Flow-proven liquidity model — no AI, no new classification,
 * no new time model.
 *
 * Time posture (the decided constraint, restated): the period is the existing
 * shell-bridged `cashFlowPeriod`, resolved against `now()` by `filterByPeriod`.
 * This is TRANSACTION-WINDOW filtering relative to today — NOT a point-in-time
 * balance read. No second time model is created; the current-state invariant of
 * the workspace is untouched.
 */

import {
  filterByPeriod,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { groupLiquidityByReason } from "@/lib/transactions/liquidity-breakdown";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";

export interface WhatChangedRow {
  id:        string;
  label:     string;
  /** Signed display amount: cash-in positive, cash-out negative. */
  amount:    number;
  direction: "in" | "out";
}

export type WhatChangedResult =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ok"; rows: WhatChangedRow[]; cashInTotal: number; cashOutTotal: number; netCash: number };

const TOP_N = 3;

/**
 * Top cash-in + cash-out liquidity drivers for the period. Loading when
 * transactions haven't arrived; empty when the window has no movement. `now` is
 * injectable so relative periods resolve deterministically in tests; production
 * omits it and `filterByPeriod` uses the real clock (same as the Cash Flow
 * adapters).
 */
export function buildWhatChangedRows(args: {
  transactions: Transaction[] | null | undefined;
  accounts:     { id: string; type: string }[];
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
  now?:         () => Date;
}): WhatChangedResult {
  const { transactions, accounts, period, ctx, now } = args;
  if (transactions == null) return { state: "loading" };

  const rows = now ? filterByPeriod(transactions, period, now()) : filterByPeriod(transactions, period);
  if (rows.length === 0) return { state: "empty" };

  const liqCtx = tierResolver(accounts);
  const b = groupLiquidityByReason(rows as LiquidityTx[], liqCtx, ctx);

  const inRows: WhatChangedRow[] = b.cashIn.slice(0, TOP_N).map((l) => ({ id: `in:${l.reason}`, label: l.label, amount: l.amount, direction: "in" }));
  const outRows: WhatChangedRow[] = b.cashOut.slice(0, TOP_N).map((l) => ({ id: `out:${l.reason}`, label: l.label, amount: -l.amount, direction: "out" }));
  const merged = [...inRows, ...outRows];
  if (merged.length === 0) return { state: "empty" };

  return { state: "ok", rows: merged, cashInTotal: b.cashInTotal, cashOutTotal: b.cashOutTotal, netCash: b.netCash };
}
