/**
 * lib/ai/prompts/bounded-disclosure.test.ts   (CF-1)
 *
 * A BOUNDED LIST MUST STATE ITS DENOMINATOR IN THE STRING THE MODEL READS.
 *
 *     npx tsx lib/ai/prompts/bounded-disclosure.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * CF-0 measured it end to end on the live corpus: 174 distinct spend merchants
 * → a 25-row rollup → 8 printed rows → 166 withheld, disclosed nowhere. Asked
 * "who did I spend the most with", the model answered "Your top merchants based
 * on spending in the analysis window are:" — every figure correct, the
 * superlative unsupported, and nothing in the context capable of telling it so.
 *
 * The assessment guard cannot reach this: merchant rankings are CONTEXT-ONLY,
 * no dimension grades them, so there is no refused verdict to contradict.
 *
 * ── What is pinned, and why HERE ────────────────────────────────────────────
 * `bounded-selection.test.ts` pins the contract in isolation. This file pins
 * the thing that actually protects the user: that the disclosure SURVIVES INTO
 * THE RENDERED PROMPT. A correct denominator that the serializer drops is worth
 * exactly as much as no denominator at all, and that gap — an authority with no
 * consumer — is the defect class this codebase keeps re-finding.
 *
 * So every assertion below reads a STRING produced by the real production
 * serializers. Nothing is reconstructed by hand.
 *
 * Fixtures, not corpus, deliberately: whether any Space currently HAS more than
 * eight merchants is a fact about a database, and an invariant that only holds
 * while the data cooperates is not an invariant. The corpus measurement lives in
 * scripts/audit-bounded-disclosure.ts (INFORMATIONAL).
 */

import { serializeContextBlock } from './context-serializer';
import { serializeAssessmentBlock } from './assessment-serializer';
import { computeAssessment } from '@/lib/ai/intelligence';
import { boundedSelection } from '@/lib/ai/bounded-selection';
import { mkTxn, mkCtx, mo } from '@/lib/ai/conformance/fixtures';
import type {
  SpaceContext_AI, TransactionsSummaryData, MerchantSummary, IncomeSource,
} from '@/lib/ai/types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// ── Builders ─────────────────────────────────────────────────────────────────

const merchant = (i: number): MerchantSummary => ({
  canonicalName: `Merchant ${String(i).padStart(3, '0')}`,
  total: 10_000 - i,
  count: 3,
  topCategory: 'Shopping',
  firstDate: '2026-04-02',
  lastDate:  '2026-06-28',
} as unknown as MerchantSummary);

const source = (i: number): IncomeSource => ({
  canonicalName: `Source ${String(i).padStart(3, '0')}`,
  total: 5_000 - i,
  count: 2,
  firstDate: '2026-04-02',
  lastDate:  '2026-06-28',
} as unknown as IncomeSource);

/**
 * A context whose transaction payload carries exactly the bounded lists a case
 * needs — assembled the way the PRODUCER assembles them, through
 * `boundedSelection`, so the denominator arrives the way production supplies it.
 */
function ctxWith(o: {
  merchantPop?: number; merchantCap?: number;
  incomePop?:   number; incomeCap?:   number;
  categories?:  Array<{ category: string; total: number; count: number }>;
  categoryTotalCount?: number;
  months?: ReturnType<typeof mo>[];
}): SpaceContext_AI {
  const txn = mkTxn({
    months: o.months ?? [],
    byCategory: o.categories ?? [{ category: 'Income', total: 0, count: 8 }],
  }) as TransactionsSummaryData & Record<string, unknown>;

  if (o.merchantPop !== undefined) {
    txn.merchants = boundedSelection(
      Array.from({ length: o.merchantPop }, (_, i) => merchant(i)), o.merchantCap ?? 25);
  }
  if (o.incomePop !== undefined) {
    txn.incomeSources = boundedSelection(
      Array.from({ length: o.incomePop }, (_, i) => source(i)), o.incomeCap ?? 25);
  }
  if (o.categoryTotalCount !== undefined) txn.byCategoryTotalCount = o.categoryTotalCount;
  return mkCtx(txn);
}

const render = (ctx: SpaceContext_AI) => serializeContextBlock(ctx);

/** The header line for a labelled list, out of the rendered prompt. */
function header(prompt: string, label: RegExp): string {
  return prompt.split('\n').find((l) => label.test(l)) ?? '';
}

// ══ A — MERCHANTS, CAP HIT: the CF-0 case, in the rendered string ═════════════
//
// 174 eligible → 25 rollup → 8 printed. The number the model must see is 174.
{
  const prompt = render(ctxWith({ merchantPop: 174, merchantCap: 25 }));
  const h = header(prompt, /MERCHANT SUMMARY/);

  check('A: the merchant header states the ELIGIBLE population, not the rollup cap',
    /showing 8 of 174 spending merchants/.test(h),
    `174 → 25 → 8 must read "8 of 174", never "8 of 25". Got: ${h.slice(0, 120)}`);
  check('A: …and never claims completeness',
    !/showing all/.test(h) && !/COMPLETE set of \d+ spending merchant/.test(prompt));
  check('A: the withheld count is stated in full',
    prompt.includes('166 further spending merchant(s)'),
    '174 − 8 = 166; the intermediate cap of 25 must not appear in the arithmetic');
  check('A: and the model is told not to answer count/total questions from it',
    /do not answer questions about counts, totals across all merchants/.test(prompt));

  // The property, stated directly against the rendered text: no rendered
  // denominator may equal the number of rows printed under it.
  const rows = prompt.split('\n').filter((l) => /^ {2}Merchant \d{3}:/.test(l)).length;
  check('A: exactly 8 merchant rows are printed', rows === 8, `printed ${rows}`);
  check('A: the denominator does NOT collapse to the printed row count',
    !new RegExp(`showing ${rows} of ${rows} `).test(h));
}

// ══ B — MERCHANTS, CAP NOT HIT: completeness stated, not merely unhedged ══════
{
  const prompt = render(ctxWith({ merchantPop: 5, merchantCap: 25 }));
  const h = header(prompt, /MERCHANT SUMMARY/);
  check('B: an unbounded list is stated as complete',
    /showing all 5 spending merchants/.test(h), h.slice(0, 120));
  check('B: …explicitly, so a ranking over it is licensed',
    /COMPLETE set of 5 spending merchant\(s\)/.test(prompt)
      && /a ranking over these rows is exhaustive/.test(prompt));
  check('B: and no withheld-rows warning is emitted',
    !/further spending merchant\(s\)/.test(prompt),
    'hedging a complete list trains the reader to ignore the hedge on bounded ones');
}

// ══ C — EXACTLY AT THE RENDER LIMIT is not a truncation ══════════════════════
{
  const prompt = render(ctxWith({ merchantPop: 8, merchantCap: 25 }));
  check('C: a population of exactly the render limit is COMPLETE',
    /showing all 8 spending merchants/.test(header(prompt, /MERCHANT SUMMARY/))
      && /COMPLETE set of 8 spending merchant/.test(prompt));

  // …and one more than the limit is not.
  const p9 = render(ctxWith({ merchantPop: 9, merchantCap: 25 }));
  check('C: one row beyond the limit IS a truncation',
    /showing 8 of 9 spending merchants/.test(header(p9, /MERCHANT SUMMARY/))
      && /1 further spending merchant\(s\)/.test(p9));
}

// ══ D — THE DOUBLE BOUNDARY: the rollup cap is never the denominator ═════════
//
// The specific defect the brief names: do not disclose "8 of 25" when 25 was
// itself selected from 174.
{
  for (const [pop, cap] of [[174, 25], [122, 25], [60, 10], [26, 25]] as const) {
    const h = header(render(ctxWith({ merchantPop: pop, merchantCap: cap })), /MERCHANT SUMMARY/);
    check(`D: population ${pop} through a ${cap}-row rollup discloses ${pop}, not ${cap}`,
      new RegExp(`showing \\d+ of ${pop} `).test(h) && !new RegExp(`of ${cap} spending`).test(h),
      h.slice(0, 120));
  }
}

// ══ E — INCOME SOURCES, both arms ════════════════════════════════════════════
{
  const bounded = render(ctxWith({ incomePop: 40, incomeCap: 25 }));
  check('E: a bounded income list states the eligible population',
    /showing 8 of 40 sources/.test(header(bounded, /INCOME SOURCES/)));
  check('E: …and the withheld count',
    /32 further income source\(s\)/.test(bounded));

  const whole = render(ctxWith({ incomePop: 3, incomeCap: 25 }));
  check('E: a complete income list says so',
    /showing all 3 sources/.test(header(whole, /INCOME SOURCES/))
      && /COMPLETE set of 3 income source\(s\)/.test(whole));
}

// ══ F — WINDOW CATEGORIES: the denominator survives the SCOPE cap ════════════
//
// The dangerous case. Under scopeHint='brief' the assembler keeps the top five
// spending categories, so a serializer measuring the array it received would
// print "all 5" about a Space with twelve — a FALSE completeness claim, which is
// worse than the silence CF-0 found. The producer's pre-cap count must win.
{
  const five = Array.from({ length: 5 }, (_, i) => (
    { category: `Cat${i}`, total: 500 - i, count: 4 }));

  const narrowed = render(ctxWith({ categories: five, categoryTotalCount: 12 }));
  const h = header(narrowed, /Category totals for this window/);
  check('F: the PRE-CAP count is the denominator, not the array received',
    /showing 5 of 12 spending categories/.test(h),
    `an array narrowed upstream must not be reported as complete. Got: ${h.slice(0, 120)}`);
  check('F: …and the withheld categories are stated',
    /7 further spending category\(ies\)/.test(narrowed));

  // Without the upstream cap the two agree, and the list is complete.
  const whole = render(ctxWith({ categories: five, categoryTotalCount: 5 }));
  check('F: an uncapped category list is complete',
    /showing all 5 spending categories/.test(header(whole, /Category totals for this window/))
      && !/further spending category/.test(whole));

  // Fixtures predating CF-1 carry no denominator; the local count is the
  // fallback, and it must never be silently treated as authoritative when the
  // producer DID supply one.
  const legacy = render(ctxWith({ categories: five }));
  check('F: a payload with no producer count falls back to the local one',
    /showing all 5 spending categories/.test(header(legacy, /Category totals for this window/)));
}

// ══ G — CATEGORY AVERAGES over complete months ═══════════════════════════════
{
  const months = [mo('2026-04', 4_000, 2_000), mo('2026-05', 4_000, 2_000)];
  const prompt = render(ctxWith({ months }));
  const h = header(prompt, /AVERAGE MONTHLY CATEGORY SPENDING/);
  check('G: the category-average list states its bounds',
    /showing all \d+ spending categories/.test(h) || /showing \d+ of \d+ spending categories/.test(h),
    h.slice(0, 120));
}

// ══ H — ASSESSMENT: categories, risks and opportunities ══════════════════════
//
// Through the REAL assessment engine, not a hand-shaped assessment object.
{
  const ctx = mkCtx(mkTxn({
    months: [mo('2026-04', 8_000, 6_000), mo('2026-05', 8_000, 6_000), mo('2026-06', 8_000, 6_000)],
    byCategory: [
      { category: 'Income',    total: 0,     count: 12 },
      { category: 'Dining',    total: 2_400, count: 40 },
      { category: 'Shopping',  total: 1_800, count: 30 },
      { category: 'Travel',    total: 1_500, count:  8 },
      { category: 'Utilities', total:   900, count: 12 },
      { category: 'Groceries', total:   800, count: 24 },
      { category: 'Transport', total:   600, count: 18 },
      { category: 'Health',    total:   400, count:  6 },
      { category: 'Subscriptions', total: 350, count:  9 },
    ],
  }), { totalLiabilities: 40_000, totalLiquid: 4_000 });

  const assessment = computeAssessment(ctx);
  const block = serializeAssessmentBlock(assessment, null, 'USD');
  // The engine decides which categories classify; the fixture must not guess.
  const classified = assessment.spendingOpportunities.topCategories.length;

  const cats = header(block, /^\s*By category/);
  check('H: the assessment category list states its bounds',
    /showing (all \d+|\d+ of \d+) classified categories/.test(cats),
    cats.slice(0, 120));
  // The engine classifies its own set; assert the RELATION, not a fixed count —
  // a fixture that pins the engine's category count would break on its rules,
  // not on this slice's contract.
  check('H: the fixture actually exceeds the cap — otherwise the case is vacuous',
    classified > 6, `only ${classified} categories classified`);
  const m = cats.match(/showing (\d+) of (\d+) classified categories/);
  check('H: the denominator is the ENGINE\'s classified count, not the printed rows',
    m !== null && Number(m[1]) === 6 && Number(m[2]) === classified
      && block.includes(`${classified - 6} further classified category(ies)`),
    `header says ${cats.slice(0, 90)}; engine classified ${classified}`);

  for (const [label, re] of [
    ['risks', /^\s*Top risks/], ['opportunities', /^\s*Top opportunities/],
  ] as const) {
    const line = header(block, re);
    if (line === '') continue;   // conditional block; absent is not a failure
    check(`H: "Top ${label}" states how many exist`,
      /showing (all \d+|\d+ of \d+) identified/.test(line), line.slice(0, 120));
  }
}

// ══ I — DRILLDOWN keeps the disclosure it already had ════════════════════════
//
// The one bounded list that was already honest. CF-1 must not regress it, and
// its denominator comes from the producer (the full matching set) rather than
// the rows it kept.
{
  const txn = mkTxn({}) as TransactionsSummaryData & Record<string, unknown>;
  txn.drilldown = {
    category: 'Dining',
    transactions: Array.from({ length: 15 }, (_, i) => ({
      date: '2026-06-01', description: `Row ${i}`, amount: -50, category: 'Dining',
      merchant: `Row ${i}`, accountName: 'Checking',
    })),
    startDate: '2026-04-01', endDate: '2026-06-30',
    shownCount: 15, totalCount: 61, shownTotal: 750, matchedTotal: 3_050, truncated: true,
  };
  const prompt = render(mkCtx(txn));
  check('I: the drilldown still discloses the matching population',
    /Showing the 15 largest of 61 matching transactions/.test(prompt),
    'this disclosure predates CF-1 and must survive it');

  const whole = mkTxn({}) as TransactionsSummaryData & Record<string, unknown>;
  whole.drilldown = { ...(txn.drilldown as object), shownCount: 15, totalCount: 15, truncated: false } as typeof txn.drilldown;
  check('I: a complete drilldown says so',
    /Showing all 15 matching transaction\(s\)/.test(render(mkCtx(whole))));
}

// ══ NEGATIVE — CF-1 CHANGES NO VALUE, NO ORDER, NO LIMIT ═════════════════════
//
// The disclosure is additive. If a figure or a ranking moved, the slice did
// something it was told not to do.
{
  const prompt = render(ctxWith({ merchantPop: 174, merchantCap: 25 }));
  const names = prompt.split('\n')
    .filter((l) => /^ {2}Merchant \d{3}:/.test(l))
    .map((l) => l.trim().split(':')[0]);
  check('NEG: ordering is untouched — the largest by spend, descending',
    names.join(',') === Array.from({ length: 8 }, (_, i) => `Merchant ${String(i).padStart(3, '0')}`).join(','),
    names.join(','));
  check('NEG: the render limit is unchanged at 8', names.length === 8);
  check('NEG: the printed totals are the producer\'s exact values',
    prompt.includes('Merchant 000: $10,000.00') && prompt.includes('Merchant 007: $9,993.00'),
    'CF-1 must not round, re-sum, or re-convert anything');

  // The existing doctrine lines are load-bearing (KD-17 / KD-18 tripwires).
  check('NEG: the merchant usage instruction is intact',
    /Use these exact totals for "who did I spend the most with \/ top merchants" questions/.test(prompt));
  check('NEG: the income/spending separation instruction is intact',
    /This is a SEPARATE list from spending merchants/.test(
      render(ctxWith({ incomePop: 40, incomeCap: 25 }))));

  // No disclosure may be emitted for a list that is not present at all.
  const empty = render(ctxWith({}));
  check('NEG: an absent list produces no disclosure line',
    !/MERCHANT SUMMARY/.test(empty) && !/INCOME SOURCES/.test(empty));
}

// ══ NEGATIVE — NO RENDERED DENOMINATOR EQUALS ITS OWN ROW COUNT ══════════════
//
// The collapse, asserted over every bounded list in one rendered prompt at once.
{
  const ctx = ctxWith({
    merchantPop: 174, merchantCap: 25,
    incomePop: 40, incomeCap: 25,
    categories: Array.from({ length: 5 }, (_, i) => ({ category: `Cat${i}`, total: 500 - i, count: 4 })),
    categoryTotalCount: 12,
  });
  const prompt = render(ctx);
  const collapses = prompt.split('\n')
    .map((l) => l.match(/showing (\d+) of (\d+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .filter((m) => m[1] === m[2]);
  check('NEG: no "showing N of N" survives anywhere in the rendered prompt',
    collapses.length === 0,
    'a truncated list reporting itself as its own population is the CF-0 defect');

  const bounded = (prompt.match(/showing \d+ of \d+/g) ?? []).length;
  check('NEG: …and this prompt genuinely contains bounded lists to have proven it on',
    bounded >= 3, `only ${bounded} bounded lists rendered — the assertion above would be vacuous`);
}

console.log(`\nbounded-disclosure: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
