/**
 * lib/transactions/income-rollup.ts   (V27-TRUTH-5)
 *
 * THE read-boundary composition of the canonical income taxonomy: it turns
 * per-row attributions (lib/transactions/income-source.ts) and InvestmentEvent
 * dividends into the one breakdown every surface renders.
 *
 * Pure: no DB, no React, no clock. React composes nothing — a surface receives
 * this object and prints its fields.
 *
 * ── The dividend scope decision, and why ────────────────────────────────────
 *
 * Dividends live as InvestmentEvent rows (25 · $27.76), not as Transactions, so
 * "income" meant two different things depending on which surface you read. The
 * brief allows either unification, provided it is consistent and qualified.
 *
 * **Cash Flow keeps BANK_TRANSACTIONS scope, and says so.** Two reasons:
 *
 *   1. Double counting. A dividend paid into a brokerage cash balance and later
 *      swept to checking would appear once as a DIVIDEND event and again as the
 *      arriving bank credit. Cash Flow's net would count $27.76 twice, and this
 *      arc has spent five slices removing exactly that class of error.
 *   2. Cash Flow answers "where did my money move?" over bank ledgers. A
 *      dividend accruing inside a brokerage has not moved through them.
 *
 * So the scope is NAMED on the rollup and rendered in the label — "Income (bank
 * transactions)" — rather than left implicit. `ALL_SOURCES` exists and is
 * exercised by tests, for a surface that legitimately spans both; nothing may
 * silently say "Income" while meaning one or the other.
 */

import type { IncomeAttribution, IncomeClass, IncomeSubtype } from "@/lib/transactions/income-source";
import type { Transaction } from "@/types";
import type { ConversionContext } from "@/lib/money/types";
import { convertMoney } from "@/lib/money/convert";

/** Which ledgers a rollup spans. Rendered, never implicit. */
export type IncomeScope =
  /** Bank/card Transaction rows only. Excludes InvestmentEvent dividends. */
  | "BANK_TRANSACTIONS"
  /** Bank transactions AND investment dividends. */
  | "ALL_SOURCES";

export interface IncomeRollupRow {
  id: string;
  /** Non-negative magnitude in the display currency. */
  amount: number;
  attribution: IncomeAttribution;
}

/** One dividend, from the investment ledger. */
export interface DividendRow {
  id: string;
  amount: number;
  /** The paying security. Null only when the event carries no instrument. */
  instrumentId: string | null;
  /** Display ticker, when resolvable. */
  ticker: string | null;
}

export interface IncomeLine {
  incomeClass: IncomeClass;
  label: string;
  amount: number;
  count: number;
  /** Row ids, so a card, a chart segment and a drawer share ONE identity set. */
  rowIds: string[];
  /** Interest: the paying accounts. Dividends: the paying securities. */
  sources: { id: string; label: string; amount: number; count: number }[];
}

export interface IncomeRollup {
  scope: IncomeScope;
  /** What a surface must print as the headline. Carries the scope qualifier. */
  headlineLabel: string;
  /** ALWAYS the sum of `lines`. Computed from them, never alongside. */
  broad: number;
  lines: IncomeLine[];
  /** Inflows deliberately excluded, with reasons — visible, never silent. */
  excluded: {
    amount: number;
    count: number;
    rowIds: string[];
    byReason: { subtype: string; label: string; amount: number; count: number }[];
  };
}

const HEADLINE: Record<IncomeScope, string> = {
  BANK_TRANSACTIONS: "Income (bank transactions)",
  ALL_SOURCES:       "Income (all sources)",
};

/** The four INCLUDED classes, in presentation order. NOT_INCOME is never here. */
export const INCLUDED_CLASSES: readonly IncomeClass[] = [
  "EARNED_INCOME", "INTEREST_INCOME", "DIVIDEND_INCOME", "OTHER_INCOME",
];

const LINE_LABEL: Record<IncomeClass, string> = {
  EARNED_INCOME: "Earned income", INTEREST_INCOME: "Interest",
  DIVIDEND_INCOME: "Dividends", OTHER_INCOME: "Other income", NOT_INCOME: "Not income",
};

/**
 * Compose the canonical rollup.
 *
 * `dividends` are folded in ONLY at ALL_SOURCES scope. At BANK_TRANSACTIONS they
 * are ignored entirely rather than zeroed, so a caller cannot mistake an empty
 * dividend line for "there were no dividends".
 */
export function composeIncomeRollup(input: {
  scope: IncomeScope;
  rows: readonly IncomeRollupRow[];
  dividends?: readonly DividendRow[];
  /** Account id → display name, for interest source labels. */
  accountLabels?: ReadonlyMap<string, string>;
}): IncomeRollup {
  const { scope, rows, accountLabels } = input;
  const byClass = new Map<IncomeClass, IncomeLine>();
  const line = (c: IncomeClass): IncomeLine => {
    const existing = byClass.get(c);
    if (existing) return existing;
    const l: IncomeLine = { incomeClass: c, label: LINE_LABEL[c], amount: 0, count: 0, rowIds: [], sources: [] };
    byClass.set(c, l);
    return l;
  };
  const sourceBump = (l: IncomeLine, id: string | null, label: string, amount: number) => {
    if (!id) return;
    const s = l.sources.find((x) => x.id === id);
    if (s) { s.amount += amount; s.count++; }
    else l.sources.push({ id, label, amount, count: 1 });
  };

  const excludedRows: IncomeRollupRow[] = [];
  for (const r of rows) {
    const c = r.attribution.incomeClass;
    if (c === "NOT_INCOME") { excludedRows.push(r); continue; }
    const l = line(c);
    l.amount += r.amount; l.count++; l.rowIds.push(r.id);
    // Interest keeps its paying ACCOUNT; a transaction-sourced dividend keeps
    // its security. Both come from the attribution, never re-derived here.
    if (c === "INTEREST_INCOME") {
      const id = r.attribution.sourceAccountId;
      sourceBump(l, id, accountLabels?.get(id ?? "") ?? id ?? "", r.amount);
    } else if (c === "DIVIDEND_INCOME") {
      sourceBump(l, r.attribution.instrumentId, r.attribution.instrumentId ?? "", r.amount);
    }
  }

  if (scope === "ALL_SOURCES") {
    for (const d of input.dividends ?? []) {
      const l = line("DIVIDEND_INCOME");
      l.amount += d.amount; l.count++; l.rowIds.push(d.id);
      sourceBump(l, d.instrumentId, d.ticker ?? d.instrumentId ?? "", d.amount);
    }
  }

  const lines = INCLUDED_CLASSES.filter((c) => byClass.has(c)).map((c) => {
    const l = byClass.get(c)!;
    l.sources.sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1));
    return l;
  });

  const byReasonMap = new Map<string, { subtype: string; label: string; amount: number; count: number }>();
  for (const r of excludedRows) {
    const k = r.attribution.subtype;
    const e = byReasonMap.get(k) ?? { subtype: k, label: k, amount: 0, count: 0 };
    e.amount += r.amount; e.count++;
    byReasonMap.set(k, e);
  }

  return {
    scope,
    headlineLabel: HEADLINE[scope],
    // Composed FROM the lines. A headline cannot disagree with its breakdown.
    broad: lines.reduce((s, l) => s + l.amount, 0),
    lines,
    excluded: {
      amount: excludedRows.reduce((s, r) => s + r.amount, 0),
      count: excludedRows.length,
      rowIds: excludedRows.map((r) => r.id),
      byReason: [...byReasonMap.values()].sort((a, b) => b.amount - a.amount),
    },
  };
}

/**
 * Build the canonical rollup straight from DTO rows.
 *
 * THE entry point for every Cash Flow income surface. It exists so the
 * DTO → attribution mapping lives in exactly one place: the space-data builder
 * and the compact adapter previously each rebuilt it, which is two chances to
 * disagree about what a row means. Nothing is classified here — `incomeClass`
 * was decided by the authority at serialization; this only reshapes it.
 *
 * A row whose read supplied no attribution is SKIPPED rather than defaulted, so
 * an absent class can never silently become OTHER_INCOME.
 */
export function rollupIncomeFromTransactions(
  transactions: readonly Transaction[],
  opts: {
    scope: IncomeScope;
    ctx?: ConversionContext;
    accountLabels?: ReadonlyMap<string, string>;
    dividends?: readonly DividendRow[];
  },
): IncomeRollup {
  const rows: IncomeRollupRow[] = [];
  for (const t of transactions) {
    if (t.incomeClass == null) continue;
    const converted = opts.ctx
      ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, opts.ctx).amount
      : t.amount;
    // V25-FINAL-1 — an unconvertible row is EXCLUDED, never counted at its
    // native magnitude and never as a fabricated zero.
    if (converted === null) continue;
    rows.push({
      id: t.id,
      amount: Math.abs(converted),
      attribution: {
        incomeClass:     t.incomeClass as IncomeClass,
        subtype:         (t.incomeSubtype ?? "UNRESOLVED_INCOME") as IncomeSubtype,
        instrumentId:    t.incomeInstrumentId ?? null,
        sourceAccountId: t.incomeSourceAccountId ?? null,
        reason:          "",
      },
    });
  }
  return composeIncomeRollup({
    scope: opts.scope, rows,
    dividends: opts.dividends, accountLabels: opts.accountLabels,
  });
}

/** The amount for one class, or 0. The ONE accessor a surface should use. */
export function incomeLineAmount(r: IncomeRollup, c: IncomeClass): number {
  return r.lines.find((l) => l.incomeClass === c)?.amount ?? 0;
}
