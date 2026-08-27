/**
 * lib/ai/prompts/transaction-analysis-gate.test.ts   (CF-11)
 *
 * TRANSACTION AUTHORITY SURVIVES; TRANSACTION ANALYSIS IS CONDITIONAL.
 *
 *     npx tsx lib/ai/prompts/transaction-analysis-gate.test.ts
 *
 * ── The split ───────────────────────────────────────────────────────────────
 * AUTHORITY is what keeps the model honest about the period it is answering
 * for: the CF-2/3/4 scope block, the analysis window, the attribution and
 * coverage-cap disclosures, the per-liability debt rollup. It renders whatever
 * the question is.
 *
 * ANALYSIS is what the question may not have asked about: category and monthly
 * rollups, merchant and income rankings. On a question the retrieval plan does
 * not route to transactions, that is 1,512 measured tokens describing something
 * nobody asked for.
 *
 * ── The highest-risk regression ─────────────────────────────────────────────
 * CF-1's bounded disclosures live INSIDE the analysis sections, so a careless
 * gate could keep a merchant ranking and drop its denominator — a ranking
 * presented as complete, which is precisely the failure CF-1 exists to prevent.
 * The disclosures travel WITH their rows here (a whole section renders or does
 * not), and this file asserts that structurally rather than by checking one
 * known header.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { serializeContextBlock } from './context-serializer';
import { omitTransactionAnalysis, omitDomainJson } from './system-prompt';
import { computeAssessment } from '@/lib/ai/intelligence';
import { planRetrieval, NeedLevel, type RetrievalPlan } from '@/lib/ai/retrieval-plan';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { FinanceDomains, type SpaceContext_AI, type TransactionsSummaryData } from '@/lib/ai/types';
import { boundedSelection } from '@/lib/ai/bounded-selection';
import { TemporalRequests, SelectionReasons, ScopeProvenances, type TemporalScope } from '@/lib/ai/temporal-scope';
import { mkTxn, mkCtx, mo } from '@/lib/ai/conformance/fixtures';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const TXN = FinanceDomains.TRANSACTIONS_SUMMARY;
const NOW = new Date('2026-08-27T00:00:00.000Z');

const envelope: CoverageEnvelope = {
  transactions: { availability: EvidenceAvailability.AVAILABLE,
                  span: { fromISO: '2024-07-18', toISO: '2026-08-26', count: 4_156 } },
  snapshots:    { availability: EvidenceAvailability.AVAILABLE,
                  span: { fromISO: '2024-07-21', toISO: '2026-08-27', count: 768 } },
  accounts: { cash: 4, debt: 2, investments: 3, digitalAssets: 4, other: 0 },
  chains: [],
};

function plan(turns: string | string[]): RetrievalPlan {
  const list = Array.isArray(turns) ? turns : [turns];
  const messages: { role: string; content: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    messages.push({ role: 'user', content: list[i] });
    if (i < list.length - 1) messages.push({ role: 'assistant', content: '(elided)' });
  }
  return planRetrieval({ messages, envelope, now: NOW });
}

/** A context with every bounded transaction list populated. */
function ctxRich(o: { drilldown?: boolean } = {}): SpaceContext_AI {
  const txn = mkTxn({
    months: [mo('2026-06', 8_000, 6_000), mo('2026-07', 8_000, 6_000)],
    byCategory: [
      { category: 'Income', total: 0, count: 12 },
      { category: 'Dining', total: 2_400, count: 40 },
      { category: 'Travel', total: 1_500, count: 8 },
    ],
  }) as TransactionsSummaryData & Record<string, unknown>;
  txn.byCategoryTotalCount = 9;
  txn.merchants = boundedSelection(
    Array.from({ length: 122 }, (_, i) => ({
      canonicalName: `Merchant ${String(i).padStart(3, '0')}`, total: 10_000 - i,
      occurrences: 3, category: 'Shopping', firstSeen: '2026-06-01', lastSeen: '2026-08-20',
    })), 25) as never;
  txn.incomeSources = boundedSelection(
    Array.from({ length: 40 }, (_, i) => ({
      canonicalName: `Source ${i}`, total: 5_000 - i, count: 2,
      firstSeen: '2026-06-01', lastSeen: '2026-08-20',
    })), 25) as never;
  if (o.drilldown) {
    txn.drilldown = {
      category: 'Dining', startDate: '2026-06-01', endDate: '2026-08-27',
      transactions: Array.from({ length: 15 }, (_, i) => ({
        date: '2026-06-01', merchant: `Row ${i}`, amount: -50, category: 'Dining',
      })),
      shownCount: 15, totalCount: 126, shownTotal: 750, matchedTotal: 3_050, truncated: true,
    };
  }
  return mkCtx(txn);
}

const scope: TemporalScope = {
  requested: { intent: TemporalRequests.CALENDAR_YEAR, label: '2025',
               startDate: '2025-01-01', endDate: '2025-12-31',
               provenance: ScopeProvenances.INHERITED, inheritedFrom: '2025' },
  selected:  { startDate: '2025-01-01', endDate: '2025-12-31', days: 365,
               reason: SelectionReasons.AS_REQUESTED, interpretation: null },
  coverage:  { fromDate: '2025-01-01', toDate: '2025-12-31', transactionCount: 2_251, boundedBy: null },
};

const render = (ctx: SpaceContext_AI, omitAnalysis: boolean, sc: TemporalScope | undefined = scope) =>
  serializeContextBlock(ctx, undefined, sc, undefined, omitAnalysis);

// ── Section markers, by class ────────────────────────────────────────────────
const AUTHORITY: [string, RegExp][] = [
  ['CF-2 scope block',        /TRANSACTION SCOPE — what was asked for/],
  ['analysis window',         /Transaction analysis window \(use this exact period/],
  ['availability caveat',     /only period FETCHED into this context/],
  ['attribution disclosure',  /attribut/i],
];
const ANALYSIS: [string, RegExp][] = [
  ['average monthly spending', /AVERAGE MONTHLY SPENDING/],
  ['category averages',        /AVERAGE MONTHLY CATEGORY SPENDING — /],
  ['monthly rollup',           /MONTHLY SPENDING BY MONTH/],
  ['merchant ranking',         /MERCHANT SUMMARY — /],
  ['income sources',           /INCOME SOURCES — /],
];

// ══ THE BOUNDARY ═════════════════════════════════════════════════════════════
{
  const ctx = ctxRich();
  const full = render(ctx, false);
  const lean = render(ctx, true);

  for (const [name, re] of AUTHORITY) {
    check(`AUTHORITY survives omission: ${name}`, re.test(lean) && re.test(full));
  }
  for (const [name, re] of ANALYSIS) {
    check(`ANALYSIS present when needed: ${name}`, re.test(full));
    check(`ANALYSIS omitted when not: ${name}`, !re.test(lean));
  }

  check('the omission is worth real tokens',
    Math.ceil((full.length - lean.length) / 4) > 1_000,
    `saved ${Math.ceil((full.length - lean.length) / 4)} tokens`);
  check('…and authority is a small fraction of what remains',
    lean.length < full.length);
}

// ══ CF-1 — A ROW NEVER OUTLIVES ITS DENOMINATOR ══════════════════════════════
//
// The highest-risk regression. Asserted STRUCTURALLY over every bounded list,
// not by checking one known header: if any ranking row is rendered, the
// disclosure that bounds it must be rendered too.
{
  const ctx = ctxRich();
  for (const [label, lean] of [['analysis rendered', render(ctx, false)],
                               ['analysis omitted',  render(ctx, true)]] as const) {
    const merchantRows = /^ {2}Merchant \d{3}:/m.test(lean);
    const merchantBound = /MERCHANT SUMMARY — showing \d+ of 122/.test(lean);
    check(`CF-1 [${label}]: merchant rows ⇒ merchant bounds`,
      !merchantRows || merchantBound,
      'a ranking without its denominator is the exact CF-0 failure');

    const incomeRows = /^ {2}Source \d+:/m.test(lean);
    const incomeBound = /INCOME SOURCES — showing/.test(lean);
    check(`CF-1 [${label}]: income rows ⇒ income bounds`, !incomeRows || incomeBound);

    const catRows = /^ {4}(Dining|Travel): \$/m.test(lean);
    const catBound = /showing \d+ of \d+ spending categories|showing all \d+ spending categories/.test(lean);
    check(`CF-1 [${label}]: category rows ⇒ category bounds`, !catRows || catBound);
  }

  // And when analysis IS rendered, the bounds are the real ones.
  const full = render(ctxRich(), false);
  check('CF-1: the merchant denominator is the eligible population',
    /showing 8 of 122 spending merchants/.test(full));
  check('CF-1: the income denominator survives',
    /showing 8 of 40 sources/.test(full));
}

// ══ CF-2/3/4 — SCOPE IS AUTHORITY, NOT ANALYSIS ══════════════════════════════
{
  const lean = render(ctxRich(), true);
  check('CF-2: the requested period survives omission',
    /a specific calendar year \("2025" — 2025-01-01 to 2025-12-31\)/.test(lean));
  check('CF-4: inherited provenance survives omission',
    /NOT restated in the latest message/.test(lean) && /\("2025"\)/.test(lean));
  check('CF-2: the loaded interval survives omission',
    /Transactions loaded for: 2025-01-01 to 2025-12-31/.test(lean));

  // Every provenance renders identically with and without analysis.
  for (const prov of [ScopeProvenances.THIS_TURN, ScopeProvenances.INHERITED,
                      ScopeProvenances.CLEARED, ScopeProvenances.NONE]) {
    const sc: TemporalScope = { ...scope, requested: { ...scope.requested, provenance: prov } };
    const a = render(ctxRich(), false, sc);
    const b = render(ctxRich(), true, sc);
    const block = (s: string) => s.slice(s.indexOf('TRANSACTION SCOPE'), s.indexOf('Transaction analysis window'));
    check(`CF-4: ${prov} scope block is identical with and without analysis`,
      block(a) === block(b));
  }
}

// ══ §13 — DRILLDOWN OVERRIDES THE OMISSION ═══════════════════════════════════
//
// Measured planner defect: "what is Dining made up of?" plans NOT_NEEDED while
// producing a live 15-of-126 drilldown. An explicit evidence request must never
// be suppressed by an aggregate-level verdict, so the serializer overrides.
{
  const ctx = ctxRich({ drilldown: true });
  const lean = render(ctx, true);
  check('§13: drilldown rows survive a NOT_NEEDED verdict',
    /Showing the 15 largest of 126 matching transactions/.test(lean));
  check('§13: …and its bounds survive with them',
    /126/.test(lean));
  check('§13: …and the surrounding analysis is restored, not half-rendered',
    /MERCHANT SUMMARY — /.test(lean),
    'a drilldown answer that lost its aggregate context would be worse than the tokens saved');

  // Without a drilldown the same verdict omits.
  check('§13: no drilldown ⇒ the omission applies',
    !/MERCHANT SUMMARY — /.test(render(ctxRich(), true)));
}

// ══ THE RULE IS EXACTLY NOT_NEEDED ═══════════════════════════════════════════
{
  check('NOT_NEEDED omits', omitTransactionAnalysis(plan('What are my investments?')));
  check('REQUIRED keeps',   !omitTransactionAnalysis(plan('What did I spend in 2025?')));
  check('SUPPORTING keeps', !omitTransactionAnalysis(plan('How am I doing financially?')),
    'supporting evidence is still evidence; token pressure must not narrow a broad overview');
  check('…and that question really is SUPPORTING',
    plan('How am I doing financially?').domains.find((d) => d.domain === TXN)!.need
      === NeedLevel.SUPPORTING);

  for (const q of ['Who did I spend the most with?', 'Where is my money going?',
                   'How much came in last quarter?', 'What was my most expensive purchase?']) {
    check(`"${q}" keeps its analysis`, !omitTransactionAnalysis(plan(q)));
  }
  for (const q of ['What stocks do I own?', 'What crypto do I own?',
                   'How far back can you see my transactions?', 'Traditional vs crypto?']) {
    check(`"${q}" omits its analysis`, omitTransactionAnalysis(plan(q)));
  }
}

// ══ FAIL OPEN ════════════════════════════════════════════════════════════════
{
  check('no plan ⇒ render everything', omitTransactionAnalysis(undefined) === false);
  check('a plan with no transaction entry ⇒ render everything',
    omitTransactionAnalysis({ domains: [] } as unknown as RetrievalPlan) === false);
  const ctx = ctxRich();
  check('…and the rendered prompt keeps the analysis',
    /MERCHANT SUMMARY — /.test(render(ctx, omitTransactionAnalysis(undefined))));
  check('an omitted-analysis render with no flag equals the full render',
    render(ctx, false) === serializeContextBlock(ctx, undefined, scope));
}

// ══ ASSESSMENT IS UNTOUCHED ══════════════════════════════════════════════════
//
// Three independent states, all true at once: assembled, consumed by the
// assessment, and NOT serialized as analysis.
{
  const ctx = ctxRich();
  check('the domain is assembled', ctx.domains[TXN]?.data !== undefined);
  const a = computeAssessment(ctx);
  check('…and reaches the assessment', a.dataQuality.transactionHistoryCompleteness !== undefined);
  check('…while the plan says the model does not need it',
    plan('What are my investments?').domains.find((d) => d.domain === TXN)!.need
      === NeedLevel.NOT_NEEDED);
  check('…and the assessment is byte-identical regardless of rendering',
    JSON.stringify(computeAssessment(ctx)) === JSON.stringify(a),
    'serialization is downstream of computation and cannot move it');
}

// ══ STRUCTURAL — ONE DECISION, ONE PLACE ═════════════════════════════════════
{
  const ser = readFileSync(join(process.cwd(), 'lib/ai/prompts/context-serializer.ts'), 'utf8');
  const code = ser.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

  check('the analysis gate is evaluated exactly once',
    (code.match(/omitTransactionAnalysis/g) ?? []).length === 2,
    'once in the signature, once in the single decision — no scattered checks');
  check('the serializer never consults the retrieval plan itself',
    !/RetrievalPlan|planRetrieval|NeedLevel/.test(code),
    'the plan decides relevance once; the serializer obeys a boolean');
  check('there is exactly one analysis gate',
    (code.match(/const renderAnalysis =/g) ?? []).length === 1);

  const sp = readFileSync(join(process.cwd(), 'lib/ai/prompts/system-prompt.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const set = sp.slice(sp.indexOf('CONDITIONAL_JSON_DOMAINS'), sp.indexOf('function omitDomainJson'));
  const named = set.match(/FinanceDomains\.\w+/g) ?? [];
  check('the conditional JSON set is still exactly two domains',
    named.length === 2 && named.includes('FinanceDomains.SNAPSHOT_HISTORY')
      && named.includes('FinanceDomains.TRANSACTIONS_SUMMARY'), named.join(','));
  check('accounts raw serialization is untouched',
    !omitDomainJson(plan('What are my investments?')).has(FinanceDomains.ACCOUNTS));
  check('holdings raw serialization is untouched',
    !omitDomainJson(plan('What are my investments?')).has(FinanceDomains.HOLDINGS_SUMMARY));
}

console.log(`\ntransaction-analysis-gate: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
