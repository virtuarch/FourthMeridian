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
 * two entry points, not a property of either, and it keeps holding as new
 * question-scoped capabilities land.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildMasterSystemPrompt, buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { routeForMessages } from '@/lib/ai/chat/message-analysis';
import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { resolvePayDates } from './pay-dates';
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

const master = (q: string, withPayDates: boolean) => buildMasterSystemPrompt(
  [ctx], [], routeForMessages(msgs(q) as never), undefined,
  { attemptedSpaceCount: 1, failedSpaceNames: [], distinctAccountCount: 1 },
  { question: q, payDatesList: withPayDates ? [payDates] : undefined });

const space = (q: string, withPayDates: boolean) => buildSpaceSystemPrompt(
  ctx, assessment, routeForMessages(msgs(q) as never), undefined, envelope, q,
  undefined, undefined, withPayDates ? payDates : undefined);

// ── EP1 — the entry seam itself ─────────────────────────────────────────────
//
// The reason master is the path that matters. If this default ever changes,
// the rest of this file is measuring a door nobody opens, and the comment above
// stops being true — so it is pinned rather than assumed.
const client = read('components/dashboard/AnalyzeClient.tsx');
check('EP1 the Analyze client defaults to master mode',
  /useState<string>\("master"\)/.test(client),
  'AnalyzeClient no longer defaults to master — re-derive which entry this file must guard');
check('EP1b master is a real option the route branches on',
  /spaceId === 'master'/.test(read('app/api/ai/chat/route.ts')));

// ── EP2 — the capability blocks reach the DEFAULT entry ─────────────────────
const mInvest = master(Q_INVEST, false);
check('EP2 master renders the CF-7 composition for the investments prompt',
  mInvest.includes('=== INVESTMENT COMPOSITION ==='),
  'the default entry answers an investments question with no composition block');
check('EP2b master names BOTH components, not the traditional total alone',
  /Traditional investments:/.test(mInvest) && /Digital assets:/.test(mInvest) &&
  /Combined investments:/.test(mInvest),
  'digital assets are missing from the default entry\'s investment statement');

const mPay = master(Q_PAY, true);
check('EP3 master renders the FORECAST-16 pay-date block',
  mPay.includes('=== EXPECTED PAY DATES ==='),
  'the default entry answers a pay-date question with nothing but raw income rows to guess from');

// ── EP4 — PARITY, the invariant that outlives these two prompts ─────────────
//
// Stated as a relation so a future question-scoped capability wired into the
// named-Space assembler and forgotten in master fails HERE rather than in a
// user's first conversation.
const CAPABILITY_BLOCKS = ['=== INVESTMENT COMPOSITION ===', '=== EXPECTED PAY DATES ==='];
for (const [label, q, wantPay] of [['investments', Q_INVEST, false], ['pay dates', Q_PAY, true]] as const) {
  const s = space(q, wantPay), m = master(q, wantPay);
  for (const block of CAPABILITY_BLOCKS) {
    check(`EP4 ${label}: master matches named-Space on ${block}`,
      s.includes(block) === m.includes(block),
      `named-Space=${s.includes(block)} master=${m.includes(block)}`);
  }
}

// ── EP5 — master carries no capability the named entry lacks ────────────────
//
// The converse direction. A cross-Space CASH FORECAST is the case this guards:
// Spaces share accounts, so projecting over summed balances would be a new
// aggregation authority built on knowingly overlapping inputs. Pay dates and a
// composition compose per Space; a projection does not.
check('EP5 master builds no cross-Space cash forecast',
  !master('what will my balance be in three months?', false).includes('=== CASH FORECAST ==='),
  'master grew a forecast section — a cross-Space projection over shared accounts');

// ── EP6 — the wiring, at the seam the route owns ────────────────────────────
const route = read('app/api/ai/chat/route.ts');
check('EP6 master-mode buildContext receives the question',
  /buildContext\(m\.spaceId, user\.id, \{[^}]*question: masterQuestion/s.test(route),
  'master assembles a context that cannot answer the question it was assembled for');
check('EP6b master-mode prompt receives the capabilities',
  /buildMasterCapabilities\(contexts, masterQuestion\)/.test(route));

// ── EP7 — the read that fed the pay-date failure ────────────────────────────
//
// The masked SECOND defect. `loadForecastIncomeStreams` took the OLDEST page of
// a 730-day window: on a real Space that page ended 2026-01-21 while the ledger
// ran to 2026-08-28, so seven months of the current regime were unreadable.
// A source assertion because the truncation only appears past the read
// authority's 100-row page cap and `queryTransactions` is a database edge with
// no injection seam; EP7b pins the CONSEQUENCE behaviourally, which is the part
// that explains why the direction is not a stylistic choice.
// ⚠️ COMMENTS STRIPPED FIRST. The first version of this check failed on the
// header note above, which QUOTES the old value while explaining it — the same
// way CF-10's size probe matched the doctrine preamble instead of the section.
// A source proxy has to read code, or it is reading prose about code.
const streams = read('lib/ai/forecast/streams.ts')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('EP7 the income read takes the NEWEST page',
  /sort: 'newest'/.test(streams) && !/sort: 'oldest'/.test(streams),
  'truncating from the recent end makes every live stream look silent');
check('EP7b a stale observation horizon withholds the projection licence',
  resolveStreamActivity({
    cadence, settlements: ['2026-07-17', '2026-07-31', '2026-08-14'],
    observedThroughISO: '2026-01-21', asOfISO: AS_OF,
  }).state !== ActivityState.CURRENT,
  'a stale ledger horizon must not read as a current stream');

console.log(failures === 0
  ? `\nPARITY-1 entry parity: ${passes} checks passed.`
  : `\nPARITY-1 entry parity: ${failures} FAILURE(S) (${passes} passed).`);
process.exit(failures === 0 ? 0 : 1);
