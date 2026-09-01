/**
 * lib/reasoning/master/dedupe.test.ts
 *
 * V26-REASONING Slice 6 — DEDUPLICATION, AND THE FOUR THINGS THAT MAKE IT
 * UNSOUND.
 *
 * ⚠️ THE DANGEROUS DIRECTION IS A SILENT TOTAL, NOT A REFUSAL. Every check below
 * is about the composition producing a number it should not, and the one that
 * matters most is the one measurement found: a class with no rows composing to
 * ZERO instead of refusing.
 */

import { classifyAccounts } from '@/lib/account-classifier';
import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import { deduplicateMasterAccounts } from './dedupe';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

type Row = { id: string; type: string; reportingBalance: number | null };
const row = (id: string, type: string, bal: number | null): Row =>
  ({ id, type, reportingBalance: bal });

/** A Space whose declared totals are, by construction, exactly its rows. */
function space(name: string, rows: Row[], over: Partial<AccountsSectionData> = {}): SpaceContext_AI {
  const c = classifyAccounts(rows.map((r) => ({ type: r.type, balance: r.reportingBalance ?? 0 })));
  const data: AccountsSectionData = {
    totalCount: rows.length, redactedCount: 0,
    totalAssets: c.totalAssets, totalLiabilities: c.totalLiabilities, netWorth: c.netWorth,
    totalLiquid: c.totalLiquid, totalInvestments: c.totalInvestments,
    totalDigitalAssets: c.totalDigitalAssets, totalRealAssets: c.totalRealAssets,
    totalsEstimated: false, totalsUnconverted: false,
    counts: { liquid: c.liquid.length, investments: c.investments.length,
      digitalAssets: c.digitalAssets.length, realAssets: c.realAssets.length,
      liabilities: c.liabilities.length },
    health: {} as AccountsSectionData['health'], knowledgeGaps: [],
    accounts: rows as unknown as AccountsSectionData['accounts'],
    accountIds: rows.map((r) => r.id),
    ...over,
  } as AccountsSectionData;
  return { space: { name }, domains: { [FinanceDomains.ACCOUNTS]: { data } } } as unknown as SpaceContext_AI;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. IT DEDUPLICATES
// ═══════════════════════════════════════════════════════════════════════════

const A = space('A', [row('c1', 'checking', 10_000), row('d1', 'debt', 500)]);
const B = space('B', [row('c1', 'checking', 10_000), row('s1', 'savings', 2_500)]);
const both = deduplicateMasterAccounts([A, B]);

check('A1 two Spaces sharing an account compose', both.ok);
if (both.ok) {
  // ⚠️ THE WHOLE POINT. Adding the two Spaces' totals gives $22,500 of liquid
  // cash from $12,500 of actual money.
  eq('A2 the shared account is counted ONCE', both.accounts.totalLiquid, 12_500);
  eq('A3 and the union is the distinct set', both.distinctCount, 3);
  eq('A4 with the shared placement reported', both.sharedCount, 1);
  eq('A5 liabilities compose too', both.accounts.totalLiabilities, 500);
  eq('A6 and net worth is over the deduplicated set', both.accounts.netWorth, 12_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// B. THE FOUR REFUSALS, AND EACH IS A DEFECT THIS REPOSITORY HAS RECORDED
// ═══════════════════════════════════════════════════════════════════════════

const refusalOf = (ctxs: SpaceContext_AI[]) => {
  const r = deduplicateMasterAccounts(ctxs);
  return r.ok ? null : r.reason.code;
};

// ⚠️ THE ONE MEASUREMENT FOUND. A Space declaring $19,014.63 of digital assets
// with NO digital-asset rows composed to $0.00, and the answer read "your
// digital assets are projected to be $0.00, even if Bitcoin goes up 10%". An
// absent row is not an empty class — W6's `nativeBalance ?? 0` and W-M3a's
// NOT-NULL-DEFAULT-0 column are the same defect in earlier costumes.
const short = space('Short', [row('c1', 'checking', 10_000)],
  { totalDigitalAssets: 19_014.63, totalAssets: 29_014.63, netWorth: 29_014.63 });
eq('B1 rows that do not add up to the declared totals REFUSE, never compose to zero',
  refusalOf([short, B]), 'INSUFFICIENT_EVIDENCE');
check('B1b and the refusal names the class that did not add up', (() => {
  const r = deduplicateMasterAccounts([short, B]);
  return !r.ok && /digital assets/.test(r.reason.detail);
})());

// ⚠️ `reportingBalance: null` IS UNAVAILABLE, NEVER ZERO (V25-FINAL-1).
eq('B2 an unconvertible balance refuses',
  refusalOf([space('N', [row('c1', 'checking', 1), row('x1', 'checking', null)]), B]),
  'UNRELIABLE_EVIDENCE');

// ⚠️ A HIDDEN ACCOUNT IS NOT AN ABSENT ONE.
eq('B3 a redacted account refuses, as an AGGREGATE and without naming it',
  refusalOf([space('R', [row('c1', 'checking', 1)], { redactedCount: 2 }), B]),
  'BLOCKED_BY_PERMISSION');
check('B3b and the detail names no account', (() => {
  const r = deduplicateMasterAccounts([space('R', [row('c1', 'checking', 1)], { redactedCount: 2 }), B]);
  return !r.ok && /some accounts/.test(r.reason.detail) && !/c1|checking/.test(r.reason.detail);
})());

eq('B4 a payload that says its own totals are partial refuses',
  refusalOf([space('U', [row('c1', 'checking', 1)], { totalsUnconverted: true }), B]),
  'UNRELIABLE_EVIDENCE');

eq('B5 no per-account rows at all refuses',
  refusalOf([space('X', [], { accounts: undefined }), B]), 'INSUFFICIENT_EVIDENCE');

// ⚠️ AND IT NEVER FALLS BACK TO ADDING THE TOTALS. That is the one thing a
// caller might reach for when this refuses, and it is exactly the cross-Space
// sum over overlapping accounts the whole product forbids.
check('B6 no refusal path produces a figure',
  [[short, B], [space('U', [row('c1', 'checking', 1)], { totalsUnconverted: true }), B]]
    .every((pair) => {
      const r = deduplicateMasterAccounts(pair as SpaceContext_AI[]);
      return !r.ok && !('accounts' in r);
    }));

// ═══════════════════════════════════════════════════════════════════════════
// C. IT REPLACES A COUNT OF SPACES, NOT A JUDGEMENT
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `forecastable = spaceIds.length === 1` REFUSED ON ARITHMETIC ABOUT SPACES.
// Whether a combined figure can be stated is a question about ACCOUNTS, and the
// four refusals above are the real conditions. Three Spaces that deduplicate
// cleanly compose; one Space with a hidden account does not.

const C3 = deduplicateMasterAccounts([A, B, space('C', [row('i1', 'investment', 4_000)])]);
check('C1 three Spaces compose when the accounts allow it', C3.ok);
if (C3.ok) eq('C2 over the distinct set', C3.distinctCount, 4);
eq('C3 and ONE Space can still refuse — it was never about the count',
  refusalOf([space('Solo', [row('c1', 'checking', 1)], { redactedCount: 1 })]),
  'BLOCKED_BY_PERMISSION');

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
