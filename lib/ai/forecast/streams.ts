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
 *
 * ⚠️ AND IT TRUNCATES FROM THE PAST, WHICH IS THE ONLY SAFE END. The read was
 * `sort: 'oldest'` until the local-UI parity investigation measured it on a
 * real Space: the oldest 100 INCOME rows reached 2026-01-21 while the ledger
 * ran to 2026-08-28, so seven months of the CURRENT regime were invisible.
 * That is not a truncated series, it is a WRONG one — `observedThroughISO`
 * came from a stale page, so FORECAST-2 judged every live stream SILENT and
 * FORECAST-1 saw three scattered dates instead of nineteen biweekly ones. A
 * dropped observation from two years ago costs a cadence nothing; a dropped
 * observation from last fortnight costs it everything, because cadence,
 * activity and the current periodic amount are all statements about the
 * RECENT end. So the page is taken newest-first and each series is restored
 * to chronological order before any authority sees it.
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

/**
 * PARITY-2 — the read itself, injectable.
 *
 * ⚠️ THE SEAM EXISTS BECAUSE THE PAGE BOUNDARY IS THE DEFECT SURFACE. PARITY-1
 * found this loader taking the OLDEST page of its window, which on a real Space
 * hid seven months of the current regime; no test could reach that, because the
 * behaviour only appears once a corpus exceeds the read authority's 100-row cap
 * and `queryTransactions` talks to Postgres. So the ONE dependency that decides
 * which rows arrive is a parameter with a production default.
 *
 * ⚠️ IT IS `typeof queryTransactions`, DELIBERATELY. Not a hand-written port,
 * and not a repository abstraction: a narrowed structural type would let a fake
 * satisfy a contract the real read authority does not, which is the fidelity
 * gap this seam exists to close. Widening `queryTransactions` breaks the fakes,
 * which is the correct direction for the failure to travel.
 */
export type IncomeTransactionReader = typeof queryTransactions;

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
  spaceId: string, asOfISO: string, read: IncomeTransactionReader = queryTransactions,
): Promise<ResolvedIncomeStream[]> {
  const page = await read({
    spaceId,
    query: {
      dateFrom: shift(asOfISO, -LOOKBACK_DAYS),
      dateTo: asOfISO,
      flowTypes: ['INCOME', 'INTEREST'],
      pending: false,
      sort: 'newest',
      limit: MAX_TRANSACTION_PAGE_SIZE,
    },
  });

  // ⚠️ THE KEY IS SOURCE **AND** ACCOUNT, because FORECAST-1 says so in as many
  // words: "a cadence belongs to ONE income stream on ONE account ... 'interest
  // payment' across two savings accounts produced a nonsense gap histogram
  // (5, 6, 7, 21, 25…33 days) that resolves into two clean monthly series the
  // moment the account is part of the identity."
  const groups = new Map<string, {
    observations: { date: string; amount: number }[]; role: FlowRoleKind; label: string;
  }>();
  for (const row of page.rows) {
    if (row.amount <= 0) continue;
    const norm = normalizeMerchant(row.merchantDisplayName ?? row.merchant);
    const key = `${norm.canonicalKey}@${row.accountId}`;
    const role = row.flowType === 'INTEREST' ? FlowRole.INTEREST : FlowRole.INCOME;
    const g = groups.get(key) ?? { observations: [], role, label: norm.canonicalName };
    g.observations.push({ date: row.date, amount: row.amount });
    groups.set(key, g);
  }

  // ⚠️ CHRONOLOGICAL, AS DEFENCE IN DEPTH. The page arrives newest-first (see the
  // header note). Measured since: both authorities already sort defensively —
  // `cadence.ts` uniques-and-sorts its dates, `periodic-amount.ts` sorts its
  // observations — so removing this line changes no verdict today. It stays
  // because a series handed to an authority should be a series, and the cost is
  // one sort per stream.
  //
  // ⚠️ THE PAIRING IS THE PART THAT MATTERS. This replaced parallel `dates[]` and
  // `amounts[]` arrays zipped by index, where any reordering of one desynchronised
  // the other silently and a stream's current amount could come from a different
  // settlement's date. Records make that unrepresentable.
  for (const g of groups.values()) {
    g.observations.sort((a, b) => a.date.localeCompare(b.date));
  }

  // How far the ledger reaches, for FORECAST-2: beyond it, silence proves nothing.
  const observedThroughISO = page.rows.length > 0
    ? page.rows.map((r) => r.date).sort().at(-1) ?? null
    : null;

  const out: ResolvedIncomeStream[] = [];
  for (const [sourceKey, g] of groups) {
    const dates = g.observations.map((o) => o.date);
    if (dates.length < MIN_OBSERVATIONS) continue;

    const cadence = deriveCadence(dates, sourceKey);
    const activity = resolveStreamActivity({
      cadence, settlements: dates, observedThroughISO, asOfISO });
    // ⚠️ A LEVEL NEEDS A SCHEDULE TO BE A LEVEL OF. FORECAST-5 takes an
    // established cadence because its regime detection walks the schedule; an
    // unknown cadence yields no amount, and that is a refusal rather than a gap
    // to fill with a mean.
    const amount = isCadence(cadence)
      ? deriveCurrentPeriodicAmount(
        g.observations.map((o) => ({ dateISO: o.date, value: o.amount, currency: 'USD' })),
        cadence)
      : null;

    out.push({
      sourceKey, label: g.label, role: g.role, cadence, activity, amount,
      // ⚠️ FORECAST-2's field verbatim. Never `activity.state === CURRENT` —
      // that is a re-derivation of the licence, and the licence is the contract.
      projectionEligible: activity.mayGenerateExpectedOccurrences,
      observationCount: dates.length,
      truncated: page.hasMore,
    });
  }
  return out;
}
