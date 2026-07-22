"use client";

/**
 * components/ui/TransactionDate.tsx
 *
 * The ONE canonical transaction-row date block, stacked:
 *
 *   11
 *   Jul
 *   2026
 *
 * day · 3-letter month · 4-digit year. Every transaction-backed table/list/drawer
 * (Transaction History, Cash Flow drill-down drawers, Debt / Banking / Investment
 * / Account rows) renders its date through this so the presentation is consistent
 * and the year is always shown — unambiguous once history spans multiple years.
 *
 * Presentation only: it reads the canonical `date` each table already uses and
 * formats via lib/format's transactionDateParts (local-noon, timezone-stable for
 * date-only strings). It changes no sorting, no semantics, no date math.
 *
 * Typography matches the long-standing block (w-9 column, semibold day, faint
 * month) with a compact faint year line added; the merchant/amount column is
 * taller, so the extra line does not increase row height.
 */

import { transactionDateParts } from "@/lib/format";

interface Props {
  /** Canonical transaction date, date-only `YYYY-MM-DD` (the value each table sorts on). */
  date: string;
  /** Optional extra classes on the fixed-width column wrapper. */
  className?: string;
}

export function TransactionDate({ date, className = "" }: Props) {
  const { day, month, year } = transactionDateParts(date);
  return (
    <div className={`w-9 shrink-0 text-center ${className}`}>
      <p className="text-xs font-semibold leading-none text-[var(--text-secondary)]">{day}</p>
      <p className="text-xs leading-none mt-0.5 text-[var(--text-faint)]">{month}</p>
      <p className="text-[10px] leading-none mt-0.5 text-[var(--text-faint)] tabular-nums">{year}</p>
    </div>
  );
}
