/**
 * lib/ai/forecast/entry-parity.test.ts   (PARITY-1)
 *
 * THE DEFAULT ENTRY POINT MUST NOT BE LESS CAPABLE THAN THE NAMED ONE.
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs \
 *       lib/ai/forecast/entry-parity.test.ts
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Every gate the CF and FORECAST programmes built measured `buildSpaceSystemPrompt`
 * — the NAMED-Space assembly. `AnalyzeClient` opens on `spaceId: "master"`, so the
 * ordinary first question a user asks never reached any of it. Two capabilities
 * that had passed acceptance were therefore invisible in the running product:
 *
 *   · CF-7's investment composition. Master had no `question` at all, so the
 *     block was never rendered and "How much do I have in investments?" was
 *     answered off the raw `totalInvestments` scalar — $5,006.64, with every
 *     digital asset silently dropped from a figure the user reads as complete.
 *
 *   · FORECAST-16's pay dates. Absent for the same reason, so "When is my next
 *     paycheck?" was answered by the model SPECULATING over visible income rows
 *     ("you might expect your next paycheck around the same time next month") —
 *     exactly the ungrounded forward claim FORECAST-11..15 exist to prevent.
 *
 * HF2a–f could not have caught either: they pin harness-vs-production FIDELITY
 * for the single-Space assembler, and both prompts are perfectly faithful there.
 * The defect was never in the assembler — it was that the product's default door
 * opened onto a different one. So the invariant here is a RELATION between the
 * two entry points, not a property of either.
 *
 * ── PARITY-2 — why the relation is now stated over CLASSES ──────────────────
 * PARITY-1 pinned the two prompts that had failed. The next real conversation
 * failed two more ways: `holdings_summary` was never assembled on any master
 * turn (master passed no evidence envelope, so CF-6 could not license the
 * domain) and no forecast ever ran (master never planned, so the model met a
 * forecast question holding a monthly income, a monthly spend and a cash
 * balance, and multiplied — 4 of 6 primed turns produced an unlicensed year-end
 * figure, and with one such figure in history 5 of 5 follow-ups treated the
 * assistant's own prose as evidence).
 *
 * Pinning prompts would have pinned the same two prompts again. So the gate now
 * asserts BLOCK-SET EQUALITY for a question in every capability class: whatever
 * the named-Space prompt renders for a question, master renders too. A future
 * capability wired into one entry point and not the other fails here without
 * anyone adding a case for it — which is the only version of this test that
 * stops the pattern rather than the instance.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildMasterSystemPrompt, buildSpaceSystemPrompt, renderForecastScopeRefusal,
  type SpaceSurfaces,
} from '@/lib/ai/prompts/system-prompt';
import { planRetrieval, Concepts } from '@/lib/ai/retrieval-plan';
import { routeForMessages } from '@/lib/ai/chat/message-analysis';
import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { detectPayDateAsk, resolvePayDates } from './pay-dates';
import { resolveStreamActivity, ActivityState } from '@/lib/forecast/stream-activity';
import { CadenceKind, CadenceProvenance, type Cadence } from '@/lib/forecast/cadence';
import { AmountBasis, EventProvenance, FlowRole } from '@/lib/forecast/future-cash-event';
import type { ResolvedIncomeStream } from './streams';
import { computeAssessment } from '@/lib/ai/intelligence';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ── The two prompts the local UI got wrong, verbatim ────────────────────────
const Q_INVEST = 'How much do I have in investments?';
const Q_PAY    = 'When is my next paycheck?';

const AS_OF = '2026-08-28';

// ⚠️ SHAPES, NOT THIS USER'S MONEY. The figures below are fixture values chosen
// so the two components are distinguishable; nothing here is asserted to match
// any real Space, and no assertion below names a user-specific amount.
const accounts = {
  totalLiquid: 1000, totalLiabilities: 0,
  totalInvestments: 4000, totalDigitalAssets: 6000,
  redactedCount: 0, totalsUnconverted: false,
  counts: { liquid: 1, liabilities: 0, investments: 2, digitalAssets: 3, realAssets: 0 },
} as unknown as AccountsSectionData;

const ctx = {
  space: { id: 'space_fixture', name: 'Personal', reportingCurrency: 'USD' },
  domains: { [FinanceDomains.ACCOUNTS]: { data: accounts } },
  signals: [], knowledgeGaps: [], meta: {},
} as unknown as SpaceContext_AI;

// ⚠️ A COMPLETE envelope, not the two fields the caller happens to read. A
// partial one threw inside `describeCoverageEnvelope` — the same stub trap the
// FORECAST harness-fidelity work hit twice.
const span = { fromISO: '2024-09-10', toISO: AS_OF, count: 1200 };
const envelope: CoverageEnvelope = {
  transactions: { availability: EvidenceAvailability.AVAILABLE, span },
  snapshots:    { availability: EvidenceAvailability.AVAILABLE, span },
  accounts: { cash: 1, debt: 0, investments: 2, digitalAssets: 3, other: 0 },
  chains: [],
};

const cadence: Cadence = {
  kind: CadenceKind.BIWEEKLY, anchorISO: '2026-08-14', sourceKey: 'payroll',
  provenance: CadenceProvenance.DERIVED, observationCount: 19, confidence: 1,
  reason: 'biweekly payroll', toleranceDays: 2,
} as unknown as Cadence;
const activity = resolveStreamActivity({
  cadence, settlements: ['2026-07-17', '2026-07-31', '2026-08-14'],
  observedThroughISO: AS_OF, asOfISO: AS_OF,
});
const STREAM: ResolvedIncomeStream = {
  sourceKey: 'payroll', label: 'Payroll', role: FlowRole.INCOME, cadence, activity,
  amount: {
    assertable: true, value: 1000, currency: 'USD', provenance: EventProvenance.DERIVED,
    basis: AmountBasis.UNKNOWN, basisProvenance: null, regimeStartISO: '2026-04-10',
    observationCount: 6, spread: 0, verdicts: [], reason: 'fixture',
  },
  projectionEligible: activity.mayGenerateExpectedOccurrences,
  observationCount: 19, truncated: false,
};

const payDates = resolvePayDates([STREAM], AS_OF, Q_PAY);
const msgs = (q: string) => [{ role: 'user' as const, content: q }];
const assessment = computeAssessment(ctx);

/** The surfaces a named-Space turn would resolve for this question. */
const surfacesFor = (q: string): SpaceSurfaces => ({
  envelope, plan: planRetrieval({ messages: msgs(q), envelope, now: new Date(`${AS_OF}T12:00:00Z`) }),
  payDates: detectPayDateAsk(q) ? payDates : undefined,
});

const master = (q: string, s: SpaceSurfaces = surfacesFor(q), refusal?: string[]) =>
  buildMasterSystemPrompt([ctx], [assessment], routeForMessages(msgs(q) as never), undefined,
    { attemptedSpaceCount: 1, failedSpaceNames: [], distinctAccountCount: 1 },
    { question: q, surfaces: [s], forecastScopeRefusal: refusal });

const space = (q: string, s: SpaceSurfaces = surfacesFor(q)) =>
  buildSpaceSystemPrompt(ctx, assessment, routeForMessages(msgs(q) as never), s.debtPayments,
    s.envelope, q, s.plan, s.forecast, s.payDates);

/** Every `=== BLOCK ===` marker a prompt renders, deduped. */
const blocks = (p: string) => new Set(
  [...p.matchAll(/^=== ([A-Z][A-Z0-9 :()/&-]+) ===$/gm)].map((m) => m[1]!));

// ── EP1 — the entry seam itself ─────────────────────────────────────────────
//
// The reason master is the path that matters. If this default ever changes,
// the rest of this file is measuring a door nobody opens, and the comment above
// stops being true — so it is pinned rather than assumed.
/** Source proxies read CODE, never the prose that explains it — see EP8. */
const codeOnly = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const client = read('components/dashboard/AnalyzeClient.tsx');
check('EP1 the Analyze client defaults to master mode',
  /useState<string>\("master"\)/.test(client),
  'AnalyzeClient no longer defaults to master — re-derive which entry this file must guard');
check('EP1b master is a real option the route branches on',
  /spaceId === 'master'/.test(read('app/api/ai/chat/route.ts')));

// ── EP2 — BLOCK-SET PARITY, one question per capability class ───────────────
//
// The invariant that outlives any particular prompt. Master may add blocks a
// named Space has no use for (the cross-Space arithmetic rule, a scope
// refusal); it may never render FEWER.
const CLASSES: [string, string][] = [
  ['PAY_DATES',              Q_PAY],
  ['INVESTMENTS composition', Q_INVEST],
  ['INVESTMENTS holdings',   'can you not see my portfolio holdings?'],
  ['NET_WORTH',              'what is my net worth?'],
  ['SPENDING',               'where can I cut spending?'],
  ['DEBT',                   'how is my debt situation?'],
  ['COVERAGE',               'how far back does my data go?'],
];
for (const [label, q] of CLASSES) {
  const missing = [...blocks(space(q))].filter((b) => !blocks(master(q)).has(b));
  check(`EP2 ${label}: master renders every block the named Space does`,
    missing.length === 0, `master is missing: ${missing.join(', ')}`);
}

// ── EP3 — the two blocks PARITY-1 fixed, named explicitly ───────────────────
check('EP3 investments composition names BOTH components in master',
  /Traditional investments:/.test(master(Q_INVEST)) &&
  /Digital assets:/.test(master(Q_INVEST)) &&
  /Combined investments:/.test(master(Q_INVEST)),
  'digital assets are missing from the default entry\'s investment statement');
check('EP3b pay dates render in master',
  blocks(master(Q_PAY)).has('EXPECTED PAY DATES'));

// ── EP4 — FORECAST: master answers deterministically or REFUSES ─────────────
//
// Never silently. The measured failure was not that master lacked a forecast —
// it was that lacking one, it computed a year-end figure from historical means.
const Q_EOY = 'how much money would i have by the eoy based on my financial data';
const forecastPlan = planRetrieval({
  messages: msgs(Q_EOY), envelope, now: new Date(`${AS_OF}T12:00:00Z`) });
check('EP4 the EOY question resolves FORECAST',
  forecastPlan.concepts.includes(Concepts.FORECAST), forecastPlan.concepts.join(','));

const refusal = renderForecastScopeRefusal(['Personal', 'Household']);
const mRefused = master(Q_EOY, surfacesFor(Q_EOY), refusal);
check('EP4b an unscopeable forecast REFUSES in the prompt',
  blocks(mRefused).has('CASH FORECAST: REFUSED (SCOPE)'),
  'master met a forecast question with no forecast and no refusal — the exact silence that was filled with arithmetic');
check('EP4c the refusal forbids the substitute arithmetic by name',
  /do not multiply any monthly income, monthly spending, or net cash flow figure by a number of months/i
    .test(mRefused) && /do not add such a product to a cash or net-worth balance/i.test(mRefused));
check('EP4d the refusal names the Spaces to choose between',
  /"Personal"/.test(mRefused) && /"Household"/.test(mRefused));

// ── EP5 — forecast follow-up: the assistant's own prose is not authority ────
//
// FORECAST-13 re-derives facts from USER messages for this reason; master had
// no equivalent, and 5 of 5 follow-ups reused a projection the assistant itself
// had invented one turn earlier.
check('EP5 the refusal strips authority from prior assistant figures',
  /appeared in your own earlier replies/i.test(mRefused) &&
  /are NOT evidence/i.test(mRefused));

// ── EP6 — master builds no cross-Space cash forecast ────────────────────────
//
// The converse direction, and the refusal PARITY-1 got right. Spaces share
// accounts, so projecting over summed balances would be a new aggregation
// authority over knowingly overlapping inputs.
check('EP6 a multi-Space master turn resolves NO forecast',
  !blocks(master(Q_EOY, surfacesFor(Q_EOY), refusal)).has('CASH FORECAST'),
  'master grew a forecast section — a cross-Space projection over shared accounts');
check('EP6b the resolver refuses to forecast when more than one Space is eligible',
  /const forecastable = spaceIds\.length === 1;/.test(codeOnly(read('lib/ai/chat/master-surfaces.ts'))));

// ── EP7 — the wiring, at the seam the route owns ────────────────────────────
const route = codeOnly(read('app/api/ai/chat/route.ts'));
check('EP7 master resolves surfaces through the shared resolver',
  /resolveMasterSurfaces\(\{/.test(route),
  'master assembles a context that cannot answer the question it was assembled for');
check('EP7b the master forecast reaches FORECAST-14\'s guard',
  /forecast = ms\.forecast; forecastSpaceId = ms\.forecastSpaceId;/.test(route) &&
  /spaceId: forecastSpaceId \?\? spaceId/.test(route),
  'a master forecast would be generated but never guarded');
check('EP7c the evidence envelope reaches master assembly',
  /evidence: envelope/.test(codeOnly(read('lib/ai/chat/master-surfaces.ts'))),
  'without the envelope CF-6 never licenses holdings_summary — the holdings defect');

// ── EP8 — the read that fed the pay-date failure ────────────────────────────
//
// The masked SECOND defect of PARITY-1. `loadForecastIncomeStreams` took the
// OLDEST page of a 730-day window: on a real Space that page ended 2026-01-21
// while the ledger ran to 2026-08-28, so seven months of the current regime
// were unreadable. EP8b pins the CONSEQUENCE behaviourally, which is the part
// that explains why the direction is not a stylistic choice.
//
// ⚠️ COMMENTS STRIPPED FIRST. The first version of this check failed on the
// header note in `streams.ts`, which QUOTES the old value while explaining it —
// the same way CF-10's size probe matched the doctrine preamble instead of the
// section. A source proxy has to read code, or it is reading prose about code.
const streams = read('lib/ai/forecast/streams.ts')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('EP8 the income read takes the NEWEST page',
  /sort: 'newest'/.test(streams) && !/sort: 'oldest'/.test(streams),
  'truncating from the recent end makes every live stream look silent');
check('EP8b a stale observation horizon withholds the projection licence',
  resolveStreamActivity({
    cadence, settlements: ['2026-07-17', '2026-07-31', '2026-08-14'],
    observedThroughISO: '2026-01-21', asOfISO: AS_OF,
  }).state !== ActivityState.CURRENT,
  'a stale ledger horizon must not read as a current stream');

console.log(failures === 0
  ? `\nPARITY-1/2 entry parity: ${passes} checks passed.`
  : `\nPARITY-1/2 entry parity: ${failures} FAILURE(S) (${passes} passed).`);
process.exit(failures === 0 ? 0 : 1);
