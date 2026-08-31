/**
 * lib/ai/forecast/stream-read.test.ts   (PARITY-1 / PARITY-3)
 *
 * THE PAGE BOUNDARY, EXERCISED — NOT ASSERTED ABOUT.
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs \
 *       lib/ai/forecast/stream-read.test.ts
 *
 * PARITY-1 found `loadForecastIncomeStreams` taking the OLDEST page of its
 * 730-day window. On the real Space that page ended 2026-01-21 while the ledger
 * ran to 2026-08-28, so seven months of the current regime were unreadable —
 * `observedThroughISO` came from a stale page, FORECAST-2 judged live streams
 * SILENT, and FORECAST-1 saw three scattered dates instead of nineteen biweekly
 * ones. That is not a truncated series but a WRONG one.
 *
 * It could only be pinned by a source regex, because the behaviour appears only
 * once a corpus exceeds the read authority's 100-row page cap and
 * `queryTransactions` is a database edge. That gate said the code SAYS
 * `sort: 'newest'`; it could not say the loader DOES the right thing. This file
 * closes that by driving the loader through its injected reader, over a corpus
 * built to have exactly the shape that broke it.
 *
 * ⚠️ THE FAKE IMPLEMENTS THE READ AUTHORITY'S CONTRACT, NOT THE LOADER'S WISHES.
 * It filters, sorts and pages the way `queryTransactions` documents — including
 * `hasMore` from a limit+1 sentinel — so a loader that only works against a
 * lenient stub fails here.
 */

import { loadForecastIncomeStreams, type IncomeTransactionReader } from './streams';
import { MAX_TRANSACTION_PAGE_SIZE } from '@/lib/data/transaction-query-core';
import { CadenceKind, isCadence } from '@/lib/forecast/cadence';
import { ActivityState, expectedOccurrencesBetween } from '@/lib/forecast/stream-activity';
import type { PeriodicAmount } from '@/lib/forecast/periodic-amount';

/** The level, when FORECAST-5 asserted one. Null is a refusal, never a zero. */
const level = (a: PeriodicAmount | null | undefined): number | null =>
  a && a.assertable ? a.value : null;

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const AS_OF = '2026-08-28';
const DAY = 86_400_000;
const iso = (d: number) => new Date(d).toISOString().slice(0, 10);
const at = (s: string) => Date.parse(`${s}T00:00:00.000Z`);

// ── The corpus ──────────────────────────────────────────────────────────────
//
// Shaped like the Space that exposed the defect, and nothing about this user:
// a long dense tail of OLD rows from one source, and the CURRENT biweekly
// payroll regime only at the recent end. The oldest page is therefore entirely
// legacy rows and stops before the payroll ever starts.

interface Row { id: string; date: string; amount: number; accountId: string;
  merchant: string; merchantDisplayName: string | null; flowType: string; pending: boolean; }

const rows: Row[] = [];
// ⚠️ DENSE, AND INSIDE THE WINDOW. The loader looks back 730 days from the
// as-of date, so legacy rows older than that are filtered out before paging and
// cannot push the page boundary anywhere. The first version of this fixture put
// them weekly from 2024-06-07 and most fell outside the window, so the oldest
// page still reached 2026-04 and the defect it was built to reproduce did not
// reproduce. Every-4-days from 2024-09-01 keeps 100+ rows INSIDE the window and
// before the payroll regime, which is the shape the real Space had.
for (let i = 0; i < 150; i++) {
  rows.push({ id: `legacy-${String(i).padStart(3, '0')}`, date: iso(at('2024-09-01') + i * 4 * DAY), amount: 120,
    accountId: 'acct-legacy', merchant: 'LEGACY DEPOSIT', merchantDisplayName: 'Legacy Deposit',
    flowType: 'INCOME', pending: false });
}
// The CURRENT regime: 15 biweekly payroll settlements ending on the as-of date.
// The last six carry a raised amount, so FORECAST-5 has a regime to find and
// date/amount pairing is observable in the result.
const PAY_OLD = 4_000, PAY_NOW = 5_286.65;
const payDates: string[] = [];
for (let i = 14; i >= 0; i--) {
  const d = iso(at(AS_OF) - i * 14 * DAY);
  payDates.push(d);
  rows.push({ id: `pay-${i}`, date: d, amount: i < 6 ? PAY_NOW : PAY_OLD,
    accountId: 'acct-main', merchant: 'VECTRUS SYSTEMS PAYROLL', merchantDisplayName: 'Vectrus Systems Payroll',
    flowType: 'INCOME', pending: false });
}

/** A reader honouring the documented contract of `queryTransactions`. */
const readerFor = (order: 'newest' | 'oldest' | 'scrambled'): {
  read: IncomeTransactionReader; sorts: string[];
} => {
  const sorts: string[] = [];
  const read = (async (args: { query: Record<string, unknown> }) => {
    const q = args.query;
    sorts.push(String(q.sort));
    const matched = rows
      .filter((r) => r.date >= String(q.dateFrom) && r.date <= String(q.dateTo))
      .filter((r) => (q.flowTypes as string[]).includes(r.flowType))
      .filter((r) => r.pending === false);
    const effective = order === 'scrambled' ? String(q.sort) : order;
    matched.sort((a, b) => effective === 'oldest'
      ? a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
      : b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const limit = Number(q.limit);
    const fetched = matched.slice(0, limit + 1);
    const hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;
    // ⚠️ 'scrambled' returns the CORRECT page in a WRONG order, which is the
    // only way to prove the loader restores chronology itself rather than
    // inheriting it from the database.
    const out = order === 'scrambled' ? [...page].sort((a, b) => a.id.localeCompare(b.id)) : page;
    return { rows: out, nextCursor: null, hasMore, cursorReset: false };
  }) as unknown as IncomeTransactionReader;
  return { read, sorts };
};

const PAY_KEY = (s: { sourceKey: string }) => s.sourceKey.includes('acct-main');

// ── 1. the corpus has the shape that broke it ───────────────────────────────
{
  check('S1 the corpus exceeds one page', rows.length > MAX_TRANSACTION_PAGE_SIZE,
    `${rows.length} rows vs page cap ${MAX_TRANSACTION_PAGE_SIZE}`);
  const oldestPage = [...rows].sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, MAX_TRANSACTION_PAGE_SIZE);
  const oldestEnd = oldestPage.map((r) => r.date).sort().at(-1)!;
  check('S2 the OLDEST page ends before the current payroll regime begins',
    oldestEnd < payDates[0]!, `oldest page ends ${oldestEnd}, regime starts ${payDates[0]}`);
  check('S2b and contains no payroll row at all',
    !oldestPage.some((r) => r.accountId === 'acct-main'));
}

async function main(): Promise<void> {
  // ── 2. the loader asks for, and keeps, the recent edge ──────────────────────
  {
    const { read, sorts } = readerFor('newest');
    const streams = await loadForecastIncomeStreams('space', AS_OF, read);
    check('S3 the loader requests the newest page', sorts.every((s) => s === 'newest'), sorts.join(','));
    const pay = streams.find(PAY_KEY);
    check('S4 the payroll stream is resolved at all', pay !== undefined,
      streams.map((s) => s.sourceKey).join(' | '));
    check('S5 it carries the whole current regime',
      pay?.observationCount === payDates.length, `${pay?.observationCount} of ${payDates.length}`);
    check('S6 a biweekly cadence is derived', isCadence(pay!.cadence)
      && pay!.cadence.kind === CadenceKind.BIWEEKLY, String((pay?.cadence as { kind?: string })?.kind));
    check('S7 the stream reads CURRENT, not SILENT', pay?.activity.state === ActivityState.CURRENT,
      pay?.activity.state);
    check('S8 and it may generate expected occurrences',
      pay?.projectionEligible === true);
    // ⚠️ FROM THE DAY AFTER. A settlement ON the as-of date is an OBSERVATION,
    // not an expectation, and `occurrencesBetween` is inclusive of its window
    // start — so asking from the as-of date returns a date already in the ledger.
    const next = expectedOccurrencesBetween(
      pay!.activity, pay!.cadence, iso(at(AS_OF) + DAY), '2026-10-31');
    check('S9 which produces the next pay dates on the biweekly rhythm',
      next.length >= 3 && next[0] === iso(at(AS_OF) + 14 * DAY), next.slice(0, 3).join(','));
    // ⚠️ PAIRING. The recent six settlements carry the raised amount; a loader that
    // reordered dates without carrying amounts alongside would land on the old one.
    check('S10 the current periodic amount is the RECENT regime, not the old one',
      Math.abs((level(pay?.amount) ?? 0) - PAY_NOW) < 0.01,
      `got ${level(pay?.amount)}, recent ${PAY_NOW}, superseded ${PAY_OLD}`);
    check('S11 truncation is reported, since the corpus exceeds one page',
      pay?.truncated === true);
  }

  // ── 3. the defect itself, reproduced through the seam ───────────────────────
  //
  // The reader ignores what the loader asked for and returns the OLDEST page —
  // exactly the pre-PARITY-1 behaviour. Everything above must collapse.
  {
    const { read } = readerFor('oldest');
    const streams = await loadForecastIncomeStreams('space', AS_OF, read);
    const pay = streams.find(PAY_KEY);
    check('S12 reading from the oldest end loses the payroll stream entirely',
      pay === undefined, pay ? `still found: ${pay.sourceKey}` : '');
    const legacy = streams.find((s) => s.sourceKey.includes('acct-legacy'));
    check('S13 and the stream it CAN see is judged not-current on a stale horizon',
      legacy !== undefined && legacy.activity.state !== ActivityState.CURRENT,
      legacy?.activity.state);
  }

  // ── 4. the verdicts are ORDER-INDEPENDENT ───────────────────────────────────
//
// ⚠️ WHAT THIS DOES AND DOES NOT PROVE, MEASURED. Removing the loader's own
// `observations.sort(...)` leaves these two checks passing, because both
// authorities sort defensively themselves — `cadence.ts` uniques-and-sorts its
// dates and `periodic-amount.ts` sorts its observations. So the loader's sort is
// defence in depth, and this section pins the property that actually matters:
// whatever order the page arrives in, the verdicts are the same.
//
// The genuinely load-bearing half of that change is not sortedness at all but
// PAIRING. The original code carried `dates[]` and `amounts[]` as parallel
// arrays and zipped them by index; any reordering of one desynchronised the
// other silently. They are now `{date, amount}` records, which makes a
// mis-pairing unrepresentable rather than merely untested — S10 and S15 would
// land on the superseded $4,000 regime if it were not.
  {
    const { read } = readerFor('scrambled');
    const streams = await loadForecastIncomeStreams('space', AS_OF, read);
    const pay = streams.find(PAY_KEY);
    check('S14 a shuffled page still yields a biweekly cadence',
      pay !== undefined && isCadence(pay.cadence) && pay.cadence.kind === CadenceKind.BIWEEKLY,
      String((pay?.cadence as { kind?: string })?.kind));
    check('S15 and the amount still pairs with the right dates',
      Math.abs((level(pay?.amount) ?? 0) - PAY_NOW) < 0.01, `got ${level(pay?.amount)}`);
  }

}

main().then(() => {
  console.log(failures === 0
  ? `\nPARITY stream read: ${passes} checks passed.`
  : `\nPARITY stream read: ${failures} FAILURE(S) (${passes} passed).`);
  process.exit(failures === 0 ? 0 : 1);
});
