/**
 * lib/ai/intelligence/debt-payments.ts
 *
 * Deterministic per-card debt-payment breakdown for one Space — the ONE
 * attributed dimension the KD-18 attribution guardrail permits (FlowType P5
 * Slice 6). Destination-side settled flowType=DEBT_PAYMENT legs recorded on
 * each debt account, grouped by account (the Slice 3 rollup), clipped to the
 * context's transaction window.
 *
 * AI-ARCH: relocated out of app/api/ai/chat/route.ts so the chat route no
 * longer owns a domain read. The read goes through the canonical authorities —
 * getDebtTransactions (visibility-guarded data layer) and
 * rollupDebtPaymentsByAccount (lib/debt) — and the display-currency conversion
 * uses the reportingCurrency the assembled context already carries, so this
 * module performs NO raw Space query of its own.
 *
 * Privacy: getDebtTransactions applies the same Space scoping + KD-15
 * TRANSACTION_DETAIL_VISIBILITY predicate as every other transaction read, so
 * only FULL-visibility accounts can contribute; account names come from the
 * accounts section the context already carries (no new name exposure). Fails
 * open to [] — the serializer then emits no per-liability line and the
 * generalized attribution disclosure covers the dimension as before.
 */

import type { SpaceContext_AI, AccountsSectionData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { getDebtTransactions } from '@/lib/data/transactions';
import { rollupDebtPaymentsByAccount } from '@/lib/debt';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';
import { identityContext } from '@/lib/money/convert';
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
    const { rows } = await getDebtTransactions({ spaceId: ctx.space.id });
    const inWindow = rows.filter(
      (r) => !r.pending && r.date >= txn.startDate && r.date <= txn.endDate,
    );
    // MC1 Phase 3 Slice 4 — THE AI FLIP (plan seam #5). Each debt leg converts
    // at ITS OWN row date into the Space's reporting currency (rows carry
    // currency + ISO date from getDebtTransactions). All-USD Spaces are
    // numerically identical to the Phase 2 identity behavior; unresolvable
    // rows degrade per D-3 and flag entry.estimated (data-only — the
    // serializer's presentation is Phase 4). The reporting currency comes from
    // the assembled context (same Space row that produced it), so no extra
    // Space query is needed; identity fallback only if the context carries none.
    const debtRows = inWindow.map((r) => ({
      accountId: r.accountId,
      amount:    r.amount,
      flowType:  r.flowType,
      currency:  r.currency ?? null,
      dateISO:   r.date, // getDebtTransactions emits ISO "YYYY-MM-DD"
    }));
    const reportingCurrency = ctx.space.reportingCurrency;
    const moneyCtx = reportingCurrency
      ? await buildSpaceConversionContext({ reportingCurrency }, {
          currencies: debtRows.map((r) => r.currency),
          dates:      [...new Set(debtRows.map((r) => r.dateISO))],
        })
      : identityContext(DEFAULT_DISPLAY_CURRENCY);
    const rollup = rollupDebtPaymentsByAccount(debtRows, moneyCtx);
    if (rollup.length === 0) return [];
    const accounts =
      (ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined)?.accounts ?? [];
    const nameById = new Map(accounts.map((a) => [a.id, a.name]));
    return rollup.map((e) => ({
      name:  nameById.get(e.accountId) ?? 'Unnamed debt account',
      total: Math.round(e.total * 100) / 100,
      count: e.count,
    }));
  } catch (err) {
    console.error('[ai/intelligence/debt-payments] per-liability debt rollup failed:', err);
    return [];
  }
}
