/**
 * lib/ai/prompts/format.ts
 *
 * Presentation-only helpers shared across the AI prompt serializers (context
 * block + assessment block + system prompt). Pure functions: money/date
 * formatting and provenance descriptors derived from metadata the assemblers
 * already produce (windowDays, startDate, endDate, transactionCount). They
 * introduce no new queries and change no financial calculation.
 *
 * Extracted verbatim from app/api/ai/chat/route.ts (AI-ARCH) so serialization
 * is testable in isolation and the route no longer owns prompt-building detail.
 */

import type { SpaceContext_AI, TransactionsSummaryData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';

/** Format a number as a USD money string (e.g. $4,320.00). */
export function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a YYYY-MM-DD date string as "Mon YYYY" (e.g. "2026-01-15" → "Jan 2026"). */
export function fmtMonthYear(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Approximate whole months covered by a day span (minimum 1). */
export function approxMonths(windowDays: number): number {
  return Math.max(1, Math.round(windowDays / 30));
}

/** Read the transactions_summary domain data from a context, or null if absent. */
export function getTransactionsSummary(ctx: SpaceContext_AI): TransactionsSummaryData | null {
  const section = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  if (!section?.data) return null;
  return section.data as TransactionsSummaryData;
}

/**
 * Human-readable provenance descriptor for the transaction analysis window.
 * Uses only existing assembler metadata — no new queries, no new calculation.
 *   e.g. "Jan 2026 – Apr 2026 (~3 months; 90-day window), 412 transaction(s)"
 * Returns null when the transactions domain is absent (no window to describe).
 */
export function analysisWindowNote(ctx: SpaceContext_AI): string | null {
  const txn = getTransactionsSummary(ctx);
  if (!txn) return null;
  const period = `${fmtMonthYear(txn.startDate)} – ${fmtMonthYear(txn.endDate)}`;
  const months = approxMonths(txn.windowDays);
  return (
    `${period} (~${months} month${months === 1 ? '' : 's'}; ${txn.windowDays}-day window), ` +
    `${txn.transactionCount} transaction(s)`
  );
}
