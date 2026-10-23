/**
 * lib/ai/format.ts
 *
 * Presentation helpers for money, dates and the transactions-summary payload.
 *
 * ⚠️ EXTRACTED FROM `lib/ai/prompts/format.ts` BY THE AI CONVERSATION RESET.
 * The prompt layer that owned this file was removed; these four functions were
 * the only part of it consumed by code that survived — the deterministic
 * intelligence engines (`lib/ai/intelligence/**`) and the signal detectors
 * (`lib/ai/signals/**`) — so they moved here rather than being deleted with
 * their old neighbours. Nothing here builds a prompt, reads a message, or knows
 * that a language model exists.
 *
 * REVIEW-3 C-6 still applies: every money string is currency-aware. No literal
 * `$` may appear in a money string under `lib/ai/**` (pinned by
 * `lib/ai/currency-presentation.test.ts`).
 */

import type { SpaceContext_AI, TransactionsSummaryData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';

/**
 * Format a money string in the given currency (e.g. $4,320.00, €4,320.00).
 *
 * REVIEW-3 C-6 — this used to hard-code `$`, so every serialized line was
 * dollar-signed regardless of the Space's reporting currency. Callers bind it
 * to `ctx.space.reportingCurrency`; the USD default keeps fixture callers (and
 * all-USD output) identical for non-negative amounts.
 */
export function fmtMoney(n: number, currency: string = DEFAULT_DISPLAY_CURRENCY): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
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
