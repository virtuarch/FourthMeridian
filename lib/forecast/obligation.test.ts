/**
 * lib/forecast/obligation.test.ts   (FORECAST-4)
 *
 * COMMITMENT IS NOT HABIT — PINNED.
 *
 *     npx tsx lib/forecast/obligation.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * Asked to project spending, the system read history as commitment: a $7,500
 * card payoff, a holiday and a round of gifts became "normal monthly spending".
 *
 * ── The trap ────────────────────────────────────────────────────────────────
 * The most obligation-shaped thing in the real ledger is not an obligation:
 * Amazon Prime, 26 charges, every one exactly $16.32, monthly for two years.
 * More regular than any paycheck in the corpus. Any rule built on frequency or
 * amount stability licenses it, and licensing it would be wrong.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   regularity is not evidence, and the authority cannot even see it;
 *   history is not an input to debt obligations;
 *   an ESTIMATED minimum is not a stated requirement;
 *   a minimum is a floor, not a payment, and never reaches NET;
 *   silence never terminates a commitment;
 *   and an unknown amount is never filled from an average.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ObligationEvidence, ObligationStatus, ObligationAmountKind,
  basisForAmount, monthlySchedule, debtObligation, assertedObligation,
  unlicensedCandidate, obligationEvents, describeObligation,
  type Obligation,
} from './obligation';
import {
  AmountBasis, FlowRole,
  composeFutureCash, netCashContribution, exactDateOf,
} from './future-cash-event';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const src = readFileSync(join(__dirname, 'obligation.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** Code with comments AND string literals removed. The reasons this module
 *  emits talk ABOUT history in order to refuse it; a scan for the word finds
 *  the refusal and calls it the offence. */
const codeOnly = code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
const AS_OF = '2026-08-27', TO = '2026-12-31';

// ═══════════════════════════════════════════════════════════════════════════
// A. OBLIGATION VS HABIT — the load-bearing guard
// ═══════════════════════════════════════════════════════════════════════════

check('A1 the module never imports RecurringCandidate or the AI types that carry it',
  !/RecurringCandidate|lib\/ai/.test(src));
check('A2 the module takes NO transaction history at all',
  !/transactions|history|occurrences:|settlements/i.test(codeOnly),
  codeOnly.match(/.{0,40}(transactions|history|settlements).{0,20}/i)?.[0]);
check('A3 no frequency, count or stability threshold exists anywhere',
  !/\bcount\b|frequency|occurrences >|>= *\d+ *&&|stddev|variance/i.test(code));
check('A4 no averaging of any kind', !/average|mean|median|reduce\(/i.test(code));

// Amazon Prime: 26 charges, every one $16.32, monthly for two years.
const prime = unlicensedCandidate('merchant:amazon-prime', 'Amazon Prime');
eq('A5 flawless two-year regularity is UNLICENSED', prime.status, ObligationStatus.UNLICENSED);
eq('A6 with NO evidence class', prime.evidence, ObligationEvidence.NONE);
eq('A7 and generates zero events', obligationEvents(prime, AS_OF, TO), []);
check('A8 and says why it is not a commitment',
  /habit and not a commitment/.test(prime.reason), prime.reason);
check('A9 nothing can raise it — the producer accepts no counts or amounts',
  /export function unlicensedCandidate\(id: string, label: string\)/.test(src));
// Defence in depth: even a hand-built obligation claiming ACTIVE status with a
// full schedule generates nothing while its evidence class is NONE. Status and
// evidence are separate gates, and habit can never satisfy the second.
const forgedActive: Obligation = {
  ...unlicensedCandidate('merchant:amazon-prime', 'Amazon Prime'),
  status: ObligationStatus.ACTIVE,
  schedule: monthlySchedule(20, AS_OF),
};
eq('A9b an ACTIVE status cannot rescue a NONE evidence class',
  obligationEvents(forgedActive, AS_OF, TO), []);

eq('A10 Uber, 474 charges, is the same answer',
  obligationEvents(unlicensedCandidate('merchant:uber', 'Uber'), AS_OF, TO), []);
eq('A11 food delivery, 385 charges, is the same answer',
  obligationEvents(unlicensedCandidate('merchant:hungerstation', 'Hunger Station'), AS_OF, TO), []);
// T-Mobile: the 8th of every month, $108.79-$174.95. Schedule-like AND variable.
eq('A12 a merchant billing on a fixed day is still not an obligation',
  obligationEvents(unlicensedCandidate('merchant:t-mobile', 'T-Mobile'), AS_OF, TO), []);

// ═══════════════════════════════════════════════════════════════════════════
// B. Debt obligations — canonical terms only
// ═══════════════════════════════════════════════════════════════════════════

const card = (o: Partial<Parameters<typeof debtObligation>[0]> = {}) => debtObligation({
  accountId: 'acct-1', accountName: 'Beacon Credit Card', balanceOwed: 5800,
  currency: 'USD', minimumPayment: 135, dueDay: 15, asOfISO: AS_OF, ...o,
});

eq('B1 a stated minimum with a due date is ACTIVE', card().status, ObligationStatus.ACTIVE);
eq('B2 on canonical debt-terms evidence', card().evidence, ObligationEvidence.DEBT_TERMS);
eq('B3 the amount is a MINIMUM, never FIXED', card().amount.kind, ObligationAmountKind.MINIMUM);
eq('B4 an ESTIMATED minimum is NOT a stated requirement',
  card({ minimumPaymentIsEstimated: true }).status, ObligationStatus.UNLICENSED);
check('B5 and says the estimate is not a requirement',
  /estimate computed from balance and APR/.test(card({ minimumPaymentIsEstimated: true }).reason));
eq('B6 no minimum at all is UNLICENSED', card({ minimumPayment: null }).status, ObligationStatus.UNLICENSED);
eq('B7 a discharged debt is TERMINATED', card({ balanceOwed: 0 }).status, ObligationStatus.TERMINATED);
eq('B8 and generates zero events', obligationEvents(card({ balanceOwed: 0 }), AS_OF, TO), []);
check('B9 the producer consults the RESOLVED terms, never raw columns',
  /minimumPayment: number \| null;/.test(src) && !/interestRate|debtProfile\?\./.test(code));
check('B10 the module documents effective-terms as the source of the minimum',
  /effective-terms/.test(src));

// A minimum with no due date: amount known, timing unknown → no events.
const noDue = card({ dueDay: null });
eq('B11 a minimum with no due date is still ACTIVE', noDue.status, ObligationStatus.ACTIVE);
eq('B12 but generates ZERO events — a date is never invented', obligationEvents(noDue, AS_OF, TO), []);
check('B13 and says the due date is missing', /no due date is recorded/.test(noDue.reason));

// ═══════════════════════════════════════════════════════════════════════════
// C. History is not an input — §13
// ═══════════════════════════════════════════════════════════════════════════

check('C1 debtObligation takes balance and terms, never transactions',
  /export interface DebtObligationInput \{[\s\S]*?\}/.exec(src)![0]
    .match(/^\s{2}\w+[?]?:/gm)!.length === 8);
check('C2 a $7,500 historical payoff cannot reach this module — there is no parameter for it',
  // minimumPayment is a REQUIREMENT, not a payment made; nothing accepts the latter.
  !/payoff|priorPayments|paymentHistory|\bpayments\s*[?:]/i.test(codeOnly),
  codeOnly.match(/.{0,40}(payoff|payments).{0,20}/i)?.[0]);
// The only way a large past payment matters is through the balance it left.
eq('C3 a payoff that cleared the balance TERMINATES rather than repeating',
  card({ balanceOwed: 0 }).status, ObligationStatus.TERMINATED);
eq('C4 travel, gifts and one-time purchases have no producer at all',
  obligationEvents(unlicensedCandidate('merchant:airline', 'Airline'), AS_OF, TO), []);

// ═══════════════════════════════════════════════════════════════════════════
// D. Amount semantics — FIXED / MINIMUM / UNKNOWN
// ═══════════════════════════════════════════════════════════════════════════

const rent = assertedObligation({
  id: 'rent', role: FlowRole.SPENDING, dueDay: 1, value: 2400, currency: 'USD',
  amountKind: ObligationAmountKind.FIXED, asOfISO: AS_OF,
});
const utility = assertedObligation({
  id: 'electric', role: FlowRole.SPENDING, dueDay: 20, value: null, currency: 'USD',
  amountKind: ObligationAmountKind.UNKNOWN, asOfISO: AS_OF,
});

eq('D1 only FIXED reaches NET', basisForAmount(rent.amount), AmountBasis.NET);
eq('D2 a MINIMUM does NOT reach NET', basisForAmount(card().amount), AmountBasis.UNKNOWN);
eq('D3 an unknown amount does not reach NET', basisForAmount(utility.amount), AmountBasis.UNKNOWN);
check('D4 NET is assigned in exactly ONE place, and only for FIXED',
  (code.match(/AmountBasis\.NET/g) ?? []).length === 1
  && /kind === ObligationAmountKind\.FIXED && amount\.value !== null\s*\?\s*AmountBasis\.NET/.test(code));
check('D5 GROSS is never used — an outflow has no deductions',
  !/AmountBasis\.GROSS/.test(code));
eq('D6 a $2,400 rent event IS assertable cash',
  netCashContribution(obligationEvents(rent, AS_OF, '2026-09-30')[0]),
  { assertable: true, value: 2400, currency: 'USD' });
// A minimum does not populate the event amount AT ALL. It is a floor on the
// obligation, and putting it on the event would present a floor as a stated
// future outflow — inflating any nominal total that sums stated amounts.
const minEvent = obligationEvents(card({ minimumPayment: 85 }), AS_OF, '2026-09-30')[0];
eq('D7 a minimum never becomes the event amount', minEvent.amount, null);
check('D8 so it is not assertable cash', !netCashContribution(minEvent).assertable);
eq('D9 and contributes nothing to a stated-outflow total',
  composeFutureCash([minEvent]).nominalOutflow, 0);
eq('D10 while still being reported as unresolved',
  composeFutureCash([minEvent]).unresolved.noAmount, 1);

// ═══════════════════════════════════════════════════════════════════════════
// E. Variable amounts are never averaged — §8, corpus H
// ═══════════════════════════════════════════════════════════════════════════

const utilityEvents = obligationEvents(utility, AS_OF, '2026-11-30');
check('E1 a known schedule with an unknown amount still produces DATED events',
  utilityEvents.length === 3, String(utilityEvents.length));
check('E2 with amount null — not a historical average',
  utilityEvents.every((e) => e.amount === null));
eq('E3 on the declared due day', utilityEvents.map((e) => exactDateOf(e.timing)),
  ['2026-09-20', '2026-10-20', '2026-11-20']);
check('E4 composition reports them as unresolved, not as zero', (() => {
  const c = composeFutureCash(utilityEvents);
  return c.unresolved.noAmount === 3 && c.assertableNet === null && c.nominalOutflow === 0;
})());

// ═══════════════════════════════════════════════════════════════════════════
// F. Activity / termination — silence never cancels
// ═══════════════════════════════════════════════════════════════════════════

const cancelled = assertedObligation({
  id: 'gym', role: FlowRole.SPENDING, dueDay: 5, value: 49, currency: 'USD',
  amountKind: ObligationAmountKind.FIXED, cancelled: true, asOfISO: AS_OF,
});
eq('F1 an explicit cancellation TERMINATES', cancelled.status, ObligationStatus.TERMINATED);
eq('F2 and generates zero events', obligationEvents(cancelled, AS_OF, TO), []);
check('F3 TERMINATED is reachable ONLY from positive evidence — cancellation or zero balance',
  (code.match(/ObligationStatus\.TERMINATED/g) ?? []).length === 2
  && /balanceOwed <= 0/.test(code) && /input\.cancelled/.test(code));
check('F4 no silence, staleness or coverage inference exists here',
  !/silen|stale|missed|observedThrough|coverage/i.test(code));
check('F5 FORECAST-2 StreamActivity is NOT imported — its inference inverts for obligations',
  !/stream-activity|StreamActivity|mayGenerateExpectedOccurrences/.test(code));
check('F6 and the module explains why',
  /Missing a mortgage payment does not[\s\S]{0,20}extinguish a mortgage/.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// G. Timing — billing schedule, not settlement history
// ═══════════════════════════════════════════════════════════════════════════

const rentEvents = obligationEvents(rent, AS_OF, '2026-12-31');
eq('G1 monthly rent lands on day 1', rentEvents.map((e) => exactDateOf(e.timing)),
  ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
eq('G2 a day-31 schedule clamps to short months',
  obligationEvents(assertedObligation({ id: 'x', role: FlowRole.SPENDING, dueDay: 31, value: 100,
    currency: 'USD', amountKind: ObligationAmountKind.FIXED, asOfISO: AS_OF }), '2026-09-01', '2026-11-30')
    .map((e) => exactDateOf(e.timing)), ['2026-09-30', '2026-10-31', '2026-11-30']);
check('G3 the schedule is DECLARED, never derived from past payments',
  /export function monthlySchedule\(dueDay: number, asOfISO: string\)/.test(src));
check('G4 a late settlement cannot move the due date — settlements are not a parameter',
  !/settle/i.test(code));
eq('G5 no due day means no schedule and no events',
  [assertedObligation({ id: 'y', role: FlowRole.SPENDING, dueDay: null, value: 500, currency: 'USD',
    amountKind: ObligationAmountKind.FIXED, asOfISO: AS_OF }).schedule,
   obligationEvents(assertedObligation({ id: 'y', role: FlowRole.SPENDING, dueDay: null, value: 500,
     currency: 'USD', amountKind: ObligationAmountKind.FIXED, asOfISO: AS_OF }), AS_OF, TO).length],
  [null, 0]);
check('G6 the anchor is a real calendar slot on or before as-of',
  monthlySchedule(1, AS_OF).anchorISO === '2026-08-01'
  && monthlySchedule(31, AS_OF).anchorISO <= AS_OF,
  `${monthlySchedule(1, AS_OF).anchorISO} / ${monthlySchedule(31, AS_OF).anchorISO}`);

// ═══════════════════════════════════════════════════════════════════════════
// H. Economic roles — transfers and refunds stay clean
// ═══════════════════════════════════════════════════════════════════════════

const sweep = assertedObligation({
  id: 'savings-sweep', role: FlowRole.TRANSFER, dueDay: 15, value: 1000, currency: 'USD',
  amountKind: ObligationAmountKind.FIXED, asOfISO: AS_OF,
});
const sweepEvents = obligationEvents(sweep, AS_OF, '2026-10-31');
check('H1 a scheduled internal transfer keeps the TRANSFER role',
  sweepEvents.every((e) => e.role === FlowRole.TRANSFER));
check('H2 which is the ledger\'s own non-consumption vocabulary, not a new name',
  !/INTERNAL_TRANSFER/.test(code));
check('H3 it is an OUTFLOW without being spending',
  sweepEvents.every((e) => e.direction === 'OUTFLOW' && e.role !== FlowRole.SPENDING));
eq('H4 debt obligations carry DEBT_PAYMENT, not SPENDING', card().role, FlowRole.DEBT_PAYMENT);
check('H5 no producer creates a REFUND obligation — a refund is an inflow',
  !/FlowRole\.REFUND/.test(code));
check('H6 nothing here concludes baseline or discretionary spending',
  !/baseline|discretionary|normal|operating/i.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// I. Composition — completeness withheld when required parts are unresolved
// ═══════════════════════════════════════════════════════════════════════════

const mixed = composeFutureCash([
  ...obligationEvents(rent, AS_OF, '2026-09-30'),
  ...obligationEvents(utility, AS_OF, '2026-09-30'),
]);
eq('I1 the known rent stays visible as a stated outflow', mixed.nominalOutflow, 2400);
eq('I2 but no complete obligation total is asserted', mixed.assertableNet, null);
check('I3 because one event has no amount', /1 event\(s\) with no amount/.test(mixed.netRefusalReason ?? ''),
  String(mixed.netRefusalReason));
eq('I4 an all-known set DOES compose', composeFutureCash(obligationEvents(rent, AS_OF, '2026-09-30')).assertableNet, -2400);
check('I5 outflows reduce net contribution', composeFutureCash(obligationEvents(rent, AS_OF, '2026-10-31')).assertableNet === -4800);

// ═══════════════════════════════════════════════════════════════════════════
// J. Substrate discipline
// ═══════════════════════════════════════════════════════════════════════════

check('J1 no database', !/from ['"]@?\/?lib\/db|prisma/i.test(code));
check('J2 no clock — asOf is a required argument', !/Date\.now\(\)|new Date\(\)\./.test(code));
check('J3 imports only FORECAST-1 and FORECAST-3',
  (src.match(/^import /gm) ?? []).length === 2
  && /from '\.\/cadence'/.test(src) && /from '\.\/future-cash-event'/.test(src));
check('J4 no second future-event type was created',
  !/interface \w*Event \{/.test(code) && /FutureCashEvent\[\]/.test(src));
check('J5 no persistence', !/\.create\(|\.upsert\(|\.update\(/i.test(code));
check('J6 no `recurring` flag substituting for semantics', !/recurring/i.test(code));
// ⚠️ RESTATED BY FORECAST-10, WHICH IS THE SLICE THAT WIRES THESE. The check
// read "no consumer outside lib/forecast", and through FORECAST-9 that was both
// true and the point: a substrate with no production reader could not change an
// answer. FORECAST-10 gives it exactly one reader, so the claim worth keeping is
// not "nothing consumes this" but "only the sanctioned adapter does" — no
// assembler, prompt, route or component reaches past `lib/ai/forecast/` into the
// authorities. That is the protection the original was really providing, and it
// is now pinned directly.
const ALLOWED_CONSUMER_ROOTS = ['lib/forecast/', 'lib/ai/forecast/'];
/**
 * ⚠️ PRODUCTION FILES ONLY (FORECAST-11). The claim is about what PRODUCTION
 * reaches for; a test builds inputs for the authority on purpose, and counting
 * those as consumers would make the gate fail for the act of testing the thing
 * it protects.
 *
 * The two former exceptions — `lib/ai/conformance/` fixtures and the
 * `scripts/check-forecast-*` operator harnesses — were deleted in the AI
 * conversation reset, so the exclusions went with them.
 */
const isProductionFile = (f: string) => !f.endsWith('.test.ts');
check('J7 FORECAST-4 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/obligation" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
// baseline to the WORKING TREE, which turns "FORECAST-4 touched none of its
// dependencies" — a true and checkable claim about one commit — into "no later
// slice may touch them either", which FORECAST-4 has no standing to assert. Three
// gates of this exact shape had already failed for that reason (FORECAST-6 L5,
// FORECAST-7 J6, FORECAST-8 J10/J11), each time for a legitimate later edit. The
// files and the claim are unchanged; only the second ref is.
check('J8 FORECAST-4 did not touch FORECAST-1/2/3',
  execSync('git diff --name-only f849c05 f0af73d -- lib/forecast/cadence.ts lib/forecast/stream-activity.ts lib/forecast/future-cash-event.ts',
    { encoding: 'utf8' }).trim() === '');

// ═══════════════════════════════════════════════════════════════════════════
// K. Regression corpus A–L
// ═══════════════════════════════════════════════════════════════════════════

eq('K-A fixed monthly rent generates deterministic outflows',
  [rentEvents.length, exactDateOf(rentEvents[0].timing), rentEvents[0].direction], [4, '2026-09-01', 'OUTFLOW']);
eq('K-B a card minimum with a due date generates events',
  obligationEvents(card(), AS_OF, '2026-10-31').length, 2);
eq('K-C a large historical payoff generates nothing', obligationEvents(card({ balanceOwed: 0 }), AS_OF, TO), []);
eq('K-D Uber (474x) is not an obligation', unlicensedCandidate('u', 'Uber').status, ObligationStatus.UNLICENSED);
eq('K-E food delivery (385x) is not an obligation', unlicensedCandidate('h', 'Hunger Station').status, ObligationStatus.UNLICENSED);
eq('K-F Amazon Prime — 26 identical charges — remains unlicensed', obligationEvents(prime, AS_OF, TO), []);
eq('K-G a cancelled subscription generates zero', obligationEvents(cancelled, AS_OF, TO), []);
eq('K-H a variable utility gives dated events with no amount',
  [utilityEvents.length, utilityEvents[0].amount], [3, null]);
eq('K-I an internal transfer keeps its role', sweepEvents[0].role, FlowRole.TRANSFER);
eq('K-J a paid-off debt gives no future obligation', obligationEvents(card({ balanceOwed: -0.01 }), AS_OF, TO), []);
eq('K-K one-time travel has no producer', obligationEvents(unlicensedCandidate('t', 'Travel'), AS_OF, TO), []);
eq('K-L known rent + unknown utility withholds the combined total',
  [mixed.nominalOutflow, mixed.assertableNet], [2400, null]);

// ═══════════════════════════════════════════════════════════════════════════
// L. Rendering
// ═══════════════════════════════════════════════════════════════════════════

check('L1 a minimum renders as a floor, not a payment',
  /at least 135 USD/.test(describeObligation(card())), describeObligation(card()));
check('L2 a fixed obligation renders its exact figure',
  /2400 USD/.test(describeObligation(rent)) && !/at least/.test(describeObligation(rent)));
check('L3 an unlicensed candidate renders its status', /UNLICENSED/.test(describeObligation(prime)));
check('L4 no rendering claims recurrence', !/recurring/i.test(
  [card(), rent, prime, cancelled].map(describeObligation).join(' ')));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
