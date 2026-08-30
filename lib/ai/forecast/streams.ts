/**
 * lib/ai/forecast/streams.ts
 *
 * FORECAST-10 — THE DATABASE EDGE, AND THE ONLY ONE.
 *
 * ── Why a dedicated read ────────────────────────────────────────────────────
 * FORECAST-1/2/5 need a DATED SERIES per income stream: settlement dates to
 * derive a cadence from, a last-seen date to judge silence by, and the amounts
 * of the recent regime. Measured at 714d099, nothing in the AI context carries
 * one. `RecurringCandidate` is merchant frequency plus a mean — it holds no
 * dates at all, so it cannot yield a cadence even in principle — and the
 * `incomeSources` rollup is a total per source. Both are the shape FORECAST-4
 * and FORECAST-6 explicitly declined to license as evidence about the future.
 *
 * So this reads dated INCOME rows through the canonical read authority
 * (`queryTransactions`), groups them by source, and hands each series to the
 * authorities. It computes no cadence, no activity and no amount of its own —
 * three `derive*` calls, and their verdicts travel unchanged.
 *
 * ⚠️ BOUNDED BY CONSTRUCTION. One page, INCOME and INTEREST only, over a
 * bounded lookback. The read authority caps a page at 100 rows; a corpus with
 * more income rows than that in the window yields a series that is TRUNCATED
 * and is reported as such rather than silently deriving a cadence from a
 * partial history.
 */

import { queryTransactions } from '@/lib/data/transaction-query';
import { MAX_TRANSACTION_PAGE_SIZE } from '@/lib/data/transaction-query-core';
import { normalizeMerchant } from '@/lib/transactions/merchant';
import { deriveCadence, isCadence, type CadenceResult } from '@/lib/forecast/cadence';
import { resolveStreamActivity, type StreamActivity } from '@/lib/forecast/stream-activity';
import { deriveCurrentPeriodicAmount, type PeriodicAmount } from '@/lib/forecast/periodic-amount';
import { FlowRole, type FlowRoleKind } from '@/lib/forecast/future-cash-event';

/** How far back to look for the series. Two years covers a biweekly regime many times over. */
const LOOKBACK_DAYS = 730;
/** Below this, no cadence is derivable and the stream is not worth carrying. */
const MIN_OBSERVATIONS = 3;

export interface ResolvedIncomeStream {
  /** `<canonical merchant key>@<accountId>` — one stream, one account. */
  sourceKey: string;
  /** The display name, so a prompt can name a stream without leaking an id. */
  label: string;
  role: FlowRoleKind;
  cadence: CadenceResult;
  activity: StreamActivity;
  amount: PeriodicAmount | null;
  projectionEligible: boolean;
  observationCount: number;
  /** True when the bounded page could not hold the whole series. */
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const shift = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Resolve every income stream this Space can license a forecast from.
 *
 * ⚠️ THE AUTHORITIES DECIDE, NOT THIS FILE. Grouping is the only judgement
 * here, and it uses the canonical merchant key the rest of the system already
 * groups income by, so a stream's identity is the same one the transactions
 * assembler shows. Everything after the grouping is a delegated verdict.
 */
export async function loadForecastIncomeStreams(
  spaceId: string, asOfISO: string,
): Promise<ResolvedIncomeStream[]> {
  const page = await queryTransactions({
    spaceId,
    query: {
      dateFrom: shift(asOfISO, -LOOKBACK_DAYS),
      dateTo: asOfISO,
      flowTypes: ['INCOME', 'INTEREST'],
      pending: false,
      sort: 'oldest',
      limit: MAX_TRANSACTION_PAGE_SIZE,
    },
  });

  // ⚠️ THE KEY IS SOURCE **AND** ACCOUNT, because FORECAST-1 says so in as many
  // words: "a cadence belongs to ONE income stream on ONE account ... 'interest
  // payment' across two savings accounts produced a nonsense gap histogram
  // (5, 6, 7, 21, 25…33 days) that resolves into two clean monthly series the
  // moment the account is part of the identity."
  const groups = new Map<string, {
    dates: string[]; amounts: number[]; role: FlowRoleKind; label: string;
  }>();
  for (const row of page.rows) {
    if (row.amount <= 0) continue;
    const norm = normalizeMerchant(row.merchantDisplayName ?? row.merchant);
    const key = `${norm.canonicalKey}@${row.accountId}`;
    const role = row.flowType === 'INTEREST' ? FlowRole.INTEREST : FlowRole.INCOME;
    const g = groups.get(key) ?? { dates: [], amounts: [], role, label: norm.canonicalName };
    g.dates.push(row.date);
    g.amounts.push(row.amount);
    groups.set(key, g);
  }

  // How far the ledger reaches, for FORECAST-2: beyond it, silence proves nothing.
  const observedThroughISO = page.rows.length > 0
    ? page.rows.map((r) => r.date).sort().at(-1) ?? null
    : null;

  const out: ResolvedIncomeStream[] = [];
  for (const [sourceKey, g] of groups) {
    if (g.dates.length < MIN_OBSERVATIONS) continue;

    const cadence = deriveCadence(g.dates, sourceKey);
    const activity = resolveStreamActivity({
      cadence, settlements: g.dates, observedThroughISO, asOfISO });
    // ⚠️ A LEVEL NEEDS A SCHEDULE TO BE A LEVEL OF. FORECAST-5 takes an
    // established cadence because its regime detection walks the schedule; an
    // unknown cadence yields no amount, and that is a refusal rather than a gap
    // to fill with a mean.
    const amount = isCadence(cadence)
      ? deriveCurrentPeriodicAmount(
        g.dates.map((dateISO, i) => ({ dateISO, value: g.amounts[i], currency: 'USD' })),
        cadence)
      : null;

    out.push({
      sourceKey, label: g.label, role: g.role, cadence, activity, amount,
      // ⚠️ FORECAST-2's field verbatim. Never `activity.state === CURRENT` —
      // that is a re-derivation of the licence, and the licence is the contract.
      projectionEligible: activity.mayGenerateExpectedOccurrences,
      observationCount: g.dates.length,
      truncated: page.hasMore,
    });
  }
  return out;
}
