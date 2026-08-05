/**
 * lib/ai/intelligence/debt-payments.ts
 *
 * Deterministic per-creditor debt-payment breakdown for one Space — the ONE
 * attributed dimension the KD-18 attribution guardrail permits (FlowType P5
 * Slice 6), clipped to the context's transaction window.
 *
 * ⚠️ v2.6-TRUTH-9 — this read the DESTINATION-side legs recorded on each debt
 * account, which is a different population from the one every Cash Flow surface
 * counts (the CASH leg). The two answered the same question with different
 * numbers, and the AI's was the one nobody could see on screen to check. It now
 * uses the same authority, the same population and the same grouping as the
 * Debt Payments card, so the assistant and the UI cite identical event ids.
 *
 * A payment whose creditor account cannot be established appears under one
 * honest heading rather than beneath a descriptor pretending to be a creditor.
 *
 * AI-ARCH: relocated out of app/api/ai/chat/route.ts so the chat route no
 * longer owns a domain read. Both the read and the arithmetic go through the
 * canonical authorities, and the display-currency conversion uses the
 * reportingCurrency the assembled context already carries, so this module
 * performs NO raw Space query of its own.
 *
 * Privacy: the bounded read applies the same Space scoping + KD-15
 * TRANSACTION_DETAIL_VISIBILITY predicate as every other transaction read, so
 * only FULL-visibility accounts can contribute; account names come from the
 * accounts section the context already carries (no new name exposure). Fails
 * open to [] — the serializer then emits no per-creditor line and the
 * generalized attribution disclosure covers the dimension as before.
 */

import type { SpaceContext_AI, AccountsSectionData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { getDebtPaymentRows } from '@/lib/data/transactions';
import {
  selectDebtPaymentCashLegs, groupDebtPaymentsByCreditor,
} from '@/lib/transactions/debt-payment-authority';
import { tierResolver } from '@/lib/transactions/liquidity';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';
import { identityContext, convertMoney } from '@/lib/money/convert';
import { buildSpaceConversionContext } from '@/lib/money/server-context';
import { getTransactionsSummary } from '@/lib/ai/prompts/format';
import type { DebtPaymentLine } from '@/lib/ai/prompts/context-serializer';

export type { DebtPaymentLine };

export async function fetchPerLiabilityDebtPayments(ctx: SpaceContext_AI): Promise<DebtPaymentLine[]> {
  const txn = getTransactionsSummary(ctx);
  if (!txn) return [];
  try {
    // TX-2 — bounded read (default cap); the in-memory window filter below is
    // unchanged. The AI intel now inherits the loader's bound automatically.
    // The SAME bounded read the Credit page uses, and the SAME leg selection the
    // Debt Payments card uses — so membership is identical by construction.
    const { rows } = await getDebtPaymentRows({ spaceId: ctx.space.id });
    const inWindow = rows.filter(
      (r) => !r.pending && r.date >= txn.startDate && r.date <= txn.endDate,
    );
    const accounts =
      (ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined)?.accounts ?? [];
    const accountRefs = new Map(accounts.map((a) => [a.id, { id: a.id, name: a.name, type: a.type }]));
    const counted = selectDebtPaymentCashLegs(
      inWindow as never, tierResolver(accounts.map((a) => ({ id: a.id, type: a.type })))).counted;
    if (counted.length === 0) return [];

    // MC1 Phase 3 Slice 4 — each leg converts at ITS OWN row date into the
    // Space's reporting currency; an unresolvable rate EXCLUDES the row (never a
    // fake 0), exactly as the card does.
    const reportingCurrency = ctx.space.reportingCurrency;
    const moneyCtx = reportingCurrency
      ? await buildSpaceConversionContext({ reportingCurrency }, {
          currencies: counted.map((r) => (r as never as { currency?: string | null }).currency ?? null),
          dates:      [...new Set(counted.map((r) => (r as never as { date: string }).date))],
        })
      : identityContext(DEFAULT_DISPLAY_CURRENCY);

    const groups = groupDebtPaymentsByCreditor(counted as never, accountRefs, (t) => {
      const row = t as never as { amount: number; currency?: string | null; date: string };
      const c = convertMoney({ amount: row.amount, currency: row.currency ?? null }, row.date, moneyCtx);
      return c.amount === null ? null : Math.abs(c.amount);
    });
    return groups.map((g) => ({
      name:  g.label,
      total: Math.round(g.value * 100) / 100,
      count: g.count,
    }));
  } catch (err) {
    console.error('[ai/intelligence/debt-payments] per-liability debt rollup failed:', err);
    return [];
  }
}
