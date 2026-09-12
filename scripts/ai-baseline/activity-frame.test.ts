/**
 * scripts/ai-baseline/activity-frame.test.ts
 *
 * THE PRODUCTION CONTRACT FOR THE SECOND MEASURED FRAME, PINNED.
 *
 * The window rule and the existence rule are pure, so they are proved here and
 * run in CI. The DB half — that the figures come from ONE extra
 * TRANSACTIONS_SUMMARY over exactly this window — is source-scanned below and
 * exercised live by `npm run ai:activity-check`.
 *
 *   npx tsx scripts/ai-baseline/activity-frame.test.ts
 */

import { readFileSync } from 'node:fs';

import { subMonths } from '@/lib/perspectives/time-range';
import {
  ACTIVITY_PRESET, resolveActivityWindow, projectActivityFrame,
} from '@/scripts/ai-baseline/activity-frame';
import type { TransactionsSummaryData } from '@/lib/ai/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

/** The W4 assessment width the orientation carries. Read, never re-declared. */
const A = 90;
const w = (asOf: string, coverageFrom: string | null, assessmentWindowDays = A) =>
  resolveActivityWindow({ asOf, coverageFrom, assessmentWindowDays });

console.log('1. MATURE SPACE — the six-month preset, ending at asOf');
{
  const r = w('2026-09-13', '2024-07-18');
  check('frame exists', r !== null);
  check('from is the PAST_6_MONTHS preset', r?.from === subMonths('2026-09-13', 6), r?.from);
  check('to is asOf', r?.to === '2026-09-13');
  check('days is the inclusive calendar span', r?.days === 185, String(r?.days));
  check('NOT the full-history start', r?.from !== '2024-07-18');
}

console.log('\n2–4. BELOW THE EXISTENCE THRESHOLD — the key must be omitted');
{
  // A Space whose record is N days long: coverage begins N-1 days before asOf.
  const hist = (n: number) => w('2026-09-13', subDays('2026-09-13', n - 1));
  for (const n of [1, 29, 45, 89, 90, 91, 120, 179]) {
    check(`${String(n).padStart(3)} days of history → omitted`, hist(n) === null);
  }
  check('exactly 90 days (one assessment window) → omitted', hist(90) === null);
}

console.log('\n5. THE EXACT THRESHOLD — the contract is >=, so 180 exists');
{
  const r = hist180();
  check('180 days → frame EXISTS', r !== null, `${r?.from}..${r?.to} ${r?.days}d`);
  check('…and is exactly 2 × the assessment window', r?.days === 2 * A);
  check('179 days → omitted', w('2026-09-13', subDays('2026-09-13', 178)) === null);
  // The threshold tracks the assessment width rather than a literal 180 — and
  // this is the tripwire that matters: a six-month frame is 182–185 days, so if
  // the assessment window were ever widened past ~92 days the frame would stop
  // existing entirely rather than silently become a near-duplicate of `recent`.
  check('the threshold follows the assessment width, not a literal 180',
    w('2026-09-13', '2020-01-01', 90) !== null
    && w('2026-09-13', '2020-01-01', 93) === null);
}

console.log('\n6. COVERAGE SHORTER THAN SIX MONTHS — clamp, never synthesise');
{
  for (const n of [180, 181, 182]) {
    const from = subDays('2026-09-13', n - 1);
    const r = w('2026-09-13', from);
    check(`${n}d record → from clamps to coverage (${from})`, r?.from === from,
      `preset would have been ${subMonths('2026-09-13', 6)}`);
    check(`${n}d record → no period before the record`, (r?.from ?? '') >= from);
  }
}

console.log('\n7. MORE THAN SIX MONTHS — the preset wins, not the record start');
{
  for (const cov of ['2024-07-18', '2020-01-01', '2026-03-12']) {
    const r = w('2026-09-13', cov);
    check(`coverage ${cov} → from = preset`, r?.from === subMonths('2026-09-13', 6), r?.from);
  }
}

console.log('\n8. RETROSPECTIVE asOf — both ends derive from the ceiling');
{
  const r = w('2026-03-15', '2024-07-18');
  check('to is the historical asOf, not today', r?.to === '2026-03-15');
  check('from is the preset applied to the historical asOf',
    r?.from === subMonths('2026-03-15', 6), r?.from);
  check('nothing after asOf can appear in the window', (r?.to ?? '') <= '2026-03-15');
  // Existence is decided from asOf + the coverage taken UNDER asOf, so a Space
  // whose record starts after the retrospective ceiling cannot exist backwards.
  check('coverage beginning after asOf → omitted (no future leak through existence)',
    w('2026-03-15', '2026-06-01') === null);
}

console.log('\n9. YEAR BOUNDARY — six months crosses it; there is no reset');
{
  const jan = w('2026-01-15', '2024-07-18');
  check('mid-January frame reaches into the PREVIOUS year',
    jan?.from === subMonths('2026-01-15', 6) && (jan?.from ?? '').startsWith('2025'), jan?.from);
  check('…and exists (a YTD frame would not)', jan !== null, `${jan?.days}d`);
  const feb = w('2026-02-01', '2024-07-18');
  check('1 February reaches into the previous year', (feb?.from ?? '').startsWith('2025'), feb?.from);
  check('width is stable across the boundary',
    Math.abs((jan?.days ?? 0) - (feb?.days ?? 0)) <= 3, `${jan?.days} vs ${feb?.days}`);
}

console.log('\n10. MONTH-END AND LEAP SEMANTICS — from the preset parser, not day maths');
{
  // 31 Aug − 6 months is the LAST day of February, which no fixed day count gives.
  for (const [asOf, expect] of [['2026-08-31', '2026-02-28'], ['2028-08-31', '2028-02-29']]) {
    check(`${asOf} → ${expect} (calendar clamp, leap-aware)`,
      w(asOf, '2020-01-01')?.from === expect, w(asOf, '2020-01-01')?.from);
    check(`…and it is exactly what subMonths says`, subMonths(asOf, 6) === expect);
  }
  check('29 Feb in a leap year resolves', w('2028-02-29', '2020-01-01')?.from === subMonths('2028-02-29', 6));
  const spans = new Set<number>();
  for (let i = 0; i < 365; i++) spans.add(w(addDays('2026-01-01', i), '2020-01-01')!.days);
  check('the inclusive span varies 182–185 across a year — calendar, not 180',
    [...spans].every((d) => d >= 182 && d <= 185) && spans.size > 1,
    [...spans].sort().join(','));
}

console.log('\n11. EMPTY COVERAGE');
{
  check('coverageFrom null → omitted', w('2026-09-13', null) === null);
  check('…at any asOf', w('2025-01-01', null) === null && w('2026-12-31', null) === null);
}

console.log('\n12. SHAPE — the field set is closed');
{
  const summary = {
    startDate: '2026-03-12', endDate: '2026-09-12', windowDays: 185,
    incomeTotal: 76066.09, expenseTotal: 42346.54, debtPaymentTotal: 62820.8,
    netCashFlow: 36925.06, transactionCount: 904,
    byCategory: [{ category: 'Dining' }], merchants: { items: [] }, monthlyBreakdown: [{}],
  } as unknown as TransactionsSummaryData;
  const f = projectActivityFrame(summary)!;
  check('exactly six keys', Object.keys(f).join(',')
    === 'window,income,spending,cardAndDebtPayments,netCashFlow,transactionCount');
  check('window carries exactly from/to/days', Object.keys(f.window).join(',') === 'from,to,days');
  check('the window reported is the one the assembler SERVED',
    f.window.from === summary.startDate && f.window.to === summary.endDate);
  check('figures are the assembler\'s own, one-to-one',
    f.income === 76066.09 && f.spending === 42346.54 && f.cardAndDebtPayments === 62820.8
    && f.netCashFlow === 36925.06 && f.transactionCount === 904);
  for (const forbidden of ['byCategory', 'merchants', 'monthlyBreakdown', 'coverage', 'note',
    'topMerchants', 'recurring', 'largestExpense']) {
    check(`no \`${forbidden}\``, !(forbidden in f));
  }
  check('a summary with no served window projects to null',
    projectActivityFrame({ windowDays: 185 } as unknown as TransactionsSummaryData) === null);
}

console.log('\n13–14. ASSEMBLY PATH — source tripwires');
{
  const code = (rel: string) =>
    readFileSync(rel, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const ev = code('scripts/ai-baseline/evidence.ts');
  const af = code('scripts/ai-baseline/activity-frame.ts');

  check('the preset comes from the ONE parser', af.includes('compareToForPreset('));
  check('…and the module hand-rolls no date maths',
    !/subMonths|startOfYear|startOfMonth|setUTCMonth|setMonth\(/.test(af));
  check(`the preset is ${ACTIVITY_PRESET}`, af.includes(`'${ACTIVITY_PRESET}'`));
  check('the threshold is derived from the assessment width, not a literal',
    /2 \* assessmentWindowDays/.test(af) && !/\b180\b/.test(af));

  check('coverage comes from the corpus authority under asOf',
    /transactionCorpusSpan\(\{ spaceId: spaceCtx\.spaceId, asOf \}\)/.test(ev));
  check('the window is resolved BEFORE any assembly (no wasted query)',
    ev.indexOf('resolveActivityWindow(') < ev.indexOf('getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY)')
    && /if \(!window\) return null;/.test(ev));
  check('EXACTLY ONE extra TRANSACTIONS_SUMMARY assembly',
    (ev.match(/getAssembler\(FinanceDomains\.TRANSACTIONS_SUMMARY\)/g) ?? []).length === 1
    && (ev.match(/buildActivityFrame\(/g) ?? []).length === 2); // definition + one call site
  check('it is assembled over exactly the resolved window',
    /startDate: window\.figures|startDate: window\.from, endDate: window\.to/.test(ev));
  check('no financial figure is computed in thinCore by hand',
    !/incomeTotal\s*[-+*/]|expenseTotal\s*[-+*/]|reduce\(/.test(
      ev.slice(ev.indexOf('function thinCore'), ev.indexOf('function assessmentCeiling'))));

  // 13 — recent must be untouched.
  const core = ev.slice(ev.indexOf('function thinCore'), ev.indexOf('\n}\n', ev.indexOf('function thinCore')));
  check('recent still reads its five figures straight off the assessment section',
    /recent: txn \? \{\s*window: \{ from: txn\.startDate, to: txn\.endDate, days: txn\.windowDays \},\s*income: txn\.incomeTotal, spending: txn\.expenseTotal,\s*cardAndDebtPayments: txn\.debtPaymentTotal, netCashFlow: txn\.netCashFlow,\s*transactionCount: txn\.transactionCount,\s*\} : null,/.test(core));
  check('activity is a SIBLING, spread only when present — never null, never {}',
    /\.\.\.\(activity \? \{ activity \} : \{\}\)/.test(core));
  check('ASSESSMENT_WINDOW_DAYS is not redefined anywhere in the slice',
    !/ASSESSMENT_WINDOW_DAYS\s*=/.test(ev) && !/ASSESSMENT_WINDOW_DAYS\s*=/.test(af));
  check('the two frames share an end date by construction',
    /function assessmentCeiling/.test(ev) && /txn\?\.endDate \?\? todayUTCISO\(\)/.test(ev));
}

// ── helpers ──────────────────────────────────────────────────────────────────
function subDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string { return subDays(iso, -n); }
function hist180() { return w('2026-09-13', subDays('2026-09-13', 179)); }

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
