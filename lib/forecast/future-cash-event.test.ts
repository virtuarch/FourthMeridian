/**
 * lib/forecast/future-cash-event.test.ts   (FORECAST-3)
 *
 * WHAT MAY BE CONCLUDED FROM A FUTURE AMOUNT — PINNED.
 *
 *     npx tsx lib/forecast/future-cash-event.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * Measured live: a $15,500 completion bonus and $1,500 vacation pay, neither
 * with any stated tax treatment, became $17,000 of spendable cash. Both amounts
 * were known. Whether either was money the user could spend was not, and the
 * sum asserted it silently.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   GROSS and UNKNOWN can never become NET;
 *   there is no single "future cash total" to read the failure out of;
 *   provenance and basis are orthogonal;
 *   a derived date may carry an asserted amount;
 *   cadence-derived events require an activity licence;
 *   periodic is not payroll, and INFLOW is not operating income;
 *   a hypothetical can never look like evidence;
 *   and no future exchange rate is ever invented.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AmountBasis, EventProvenance, FlowRole,
  exactDateOf, describeTiming, netCashContribution,
  cadenceDerivedEvents, composeFutureCash, describeFutureCash,
  type FutureCashEvent, type EventTiming, type AmountBasisKind, type EventProvenanceKind,
} from './future-cash-event';
import { deriveCadence, isCadence, occurrencesBetween, type Cadence } from './cadence';
import { resolveStreamActivity, ActivityState, type StreamActivity } from './stream-activity';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const src = readFileSync(join(__dirname, 'future-cash-event.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

let seq = 0;
function ev(o: Partial<FutureCashEvent> & { value?: number; basis?: AmountBasisKind;
  amountProvenance?: EventProvenanceKind; currency?: string }): FutureCashEvent {
  const { value, basis, amountProvenance, currency, ...rest } = o;
  return {
    id: `e${++seq}`,
    timing: { kind: 'EXACT', dateISO: '2026-10-15' },
    timingProvenance: EventProvenance.USER_ASSERTED,
    direction: 'INFLOW',
    role: FlowRole.INCOME,
    amount: value === undefined ? null : {
      value, currency: currency ?? 'USD',
      basis: basis ?? AmountBasis.UNKNOWN,
      provenance: amountProvenance ?? EventProvenance.USER_ASSERTED,
    },
    ...rest,
  };
}

// ── Real streams, verbatim from the live ledger ─────────────────────────────
const VECTRUS = ['2025-12-19','2026-01-01','2026-01-16','2026-01-30','2026-02-13','2026-02-27',
  '2026-03-13','2026-03-14','2026-03-27','2026-04-10','2026-04-24','2026-05-08','2026-05-22',
  '2026-06-05','2026-06-18','2026-07-02','2026-07-17','2026-07-31','2026-08-14'];
const ABACUS = ['2024-07-25','2024-08-09','2024-08-23','2024-09-10','2024-09-25','2024-10-10',
  '2024-10-25','2024-11-08','2024-11-23','2024-12-10','2024-12-24','2025-01-10','2025-01-24',
  '2025-02-08','2025-02-25','2025-03-08','2025-03-25','2025-04-10','2025-04-25','2025-05-09',
  '2025-05-23','2025-06-10','2025-06-25','2025-07-10','2025-07-25','2025-08-08','2025-08-23',
  '2025-09-10','2025-09-25','2025-10-10','2025-10-24','2025-11-08','2025-11-25','2025-12-10','2025-12-24'];
const INT_10 = ['2025-10-10','2025-11-10','2025-12-10','2026-01-10','2026-02-10','2026-03-10',
  '2026-04-10','2026-05-10','2026-06-10','2026-07-10','2026-08-10'];
const AS_OF = '2026-08-27', LEDGER = '2026-08-25';

const cadOf = (d: readonly string[], k: string): Cadence => {
  const c = deriveCadence(d, k); if (!isCadence(c)) throw new Error(k); return c;
};
const vecCad = cadOf(VECTRUS, 'vectrus'), abaCad = cadOf(ABACUS, 'abacus'), tenCad = cadOf(INT_10, 'interest');
const act = (c: Cadence, s: readonly string[], reach = LEDGER): StreamActivity =>
  resolveStreamActivity({ cadence: c, settlements: s, observedThroughISO: reach, asOfISO: AS_OF });
const vecAct = act(vecCad, VECTRUS), abaAct = act(abaCad, ABACUS);
const tenAct = act(tenCad, INT_10, '2026-08-17');

// ═══════════════════════════════════════════════════════════════════════════
// A. THE LIVE FAILURE
// ═══════════════════════════════════════════════════════════════════════════

const bonus   = ev({ value: 15500, basis: AmountBasis.UNKNOWN });
const vacation = ev({ value: 1500, basis: AmountBasis.UNKNOWN });
const liveFailure = composeFutureCash([bonus, vacation]);

eq('A1 the stated amounts total $17,000 — that much IS known', liveFailure.nominalInflow, 17000);
eq('A2 the spendable contribution is NOT ASSERTABLE', liveFailure.assertableNet, null);
check('A3 and it says why', /unestablished basis/.test(liveFailure.netRefusalReason ?? ''), String(liveFailure.netRefusalReason));
eq('A4 the whole $17,000 sits in unresolved', liveFailure.unresolved.unknownBasis, 17000);
check('A5 there is NO single field a caller could read $17,000 of spendable cash from',
  !/futureCashTotal|totalFutureCash|spendableTotal/.test(code));
check('A6 the rendering forbids the spendable claim in words',
  /may NOT be described as money available to spend/.test(describeFutureCash(liveFailure).join('\n')),
  describeFutureCash(liveFailure).join('\n'));

// Mixed basis: the resolved part must not be lost, and the unresolved part must
// not be absorbed into it.
const mixed = composeFutureCash([
  ev({ value: 15500, basis: AmountBasis.GROSS }),
  ev({ value: 1500,  basis: AmountBasis.NET }),
]);
eq('A7 mixed basis still states $17,000 nominal', mixed.nominalInflow, 17000);
eq('A8 the net component is NOT silently dropped', mixed.unresolved.gross, 15500);
eq('A9 but no combined net is asserted while $15,500 is unresolved', mixed.assertableNet, null);
check('A10 and the refusal names the gross component',
  /15500 stated as GROSS/.test(mixed.netRefusalReason ?? ''), String(mixed.netRefusalReason));
eq('A11 the assertable component is still visible per-event',
  netCashContribution(ev({ value: 1500, basis: AmountBasis.NET })), { assertable: true, value: 1500, currency: 'USD' });

// ═══════════════════════════════════════════════════════════════════════════
// B. Basis semantics
// ═══════════════════════════════════════════════════════════════════════════

eq('B1 NET is assertable at its stated amount',
  netCashContribution(ev({ value: 5250, basis: AmountBasis.NET })), { assertable: true, value: 5250, currency: 'USD' });
check('B2 GROSS is not assertable', !netCashContribution(ev({ value: 15500, basis: AmountBasis.GROSS })).assertable);
check('B3 UNKNOWN is not assertable', !netCashContribution(ev({ value: 15500, basis: AmountBasis.UNKNOWN })).assertable);
check('B4 no amount at all is not assertable', !netCashContribution(ev({})).assertable);
check('B5 GROSS and UNKNOWN refuse for DIFFERENT reasons — one is answered, one is open', (() => {
  const g = netCashContribution(ev({ value: 1, basis: AmountBasis.GROSS }));
  const u = netCashContribution(ev({ value: 1, basis: AmountBasis.UNKNOWN }));
  return !g.assertable && !u.assertable && g.reason !== u.reason
    && /excludes deductions/.test(g.reason) && /never established/.test(u.reason);
})());
eq('B6 exactly three bases', Object.keys(AmountBasis).sort(), ['GROSS', 'NET', 'UNKNOWN']);
// Every mention of NET in the code is a COMPARISON. Nothing assigns it, so no
// branch can promote a GROSS or UNKNOWN amount into a spendable one.
check('B7 nothing promotes a basis — NET is only ever compared, never assigned',
  (code.match(/AmountBasis\.NET/g) ?? []).length ===
  (code.match(/=== AmountBasis\.NET/g) ?? []).length,
  code.match(/.{0,40}AmountBasis\.NET.{0,20}/g)?.join(' | '));
check('B8 netCashContribution is the ONLY gate to spendable cash',
  (code.match(/basis === AmountBasis\.NET/g) ?? []).length <= 2);
check('B9 no withholding rate or tax estimate exists anywhere',
  !/withhold|taxRate|0\.7|0\.3\b|afterTax/i.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// C. Provenance is orthogonal to basis
// ═══════════════════════════════════════════════════════════════════════════

eq('C1 exactly three provenances', Object.keys(EventProvenance).sort(),
  ['DERIVED', 'HYPOTHETICAL', 'USER_ASSERTED']);
check('C2 a USER_ASSERTED amount can still have UNKNOWN basis — the live case', (() => {
  const e = ev({ value: 15500, basis: AmountBasis.UNKNOWN, amountProvenance: EventProvenance.USER_ASSERTED });
  return e.amount!.provenance === EventProvenance.USER_ASSERTED
    && e.amount!.basis === AmountBasis.UNKNOWN && !netCashContribution(e).assertable;
})());
check('C3 basis is not inferred from provenance — an asserted amount is not net',
  !netCashContribution(ev({ value: 5250, amountProvenance: EventProvenance.USER_ASSERTED })).assertable);
check('C4 basis is not inferred from role — "payroll" does not mean NET',
  !netCashContribution(ev({ value: 5250, role: FlowRole.INCOME })).assertable);
check('C5 timing provenance and amount provenance are SEPARATE fields',
  /timingProvenance: EventProvenanceKind;/.test(src) && /provenance: EventProvenanceKind;/.test(src));
check('C6 provider-attested provenance was NOT minted — it does not exist in the data',
  !/KNOWN_SCHEDULED|PROVIDER_ATTESTED/.test(code));
check('C7 ESTIMATED was NOT minted — no producer', !/\bESTIMATED\b/.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// D. Hypothetical is not evidence
// ═══════════════════════════════════════════════════════════════════════════

const hypo = ev({ value: 10000, basis: AmountBasis.NET,
  amountProvenance: EventProvenance.HYPOTHETICAL, timingProvenance: EventProvenance.HYPOTHETICAL });
eq('D1 a hypothetical carries its own provenance', hypo.amount!.provenance, EventProvenance.HYPOTHETICAL);
check('D2 which is neither USER_ASSERTED nor DERIVED',
  hypo.amount!.provenance !== EventProvenance.USER_ASSERTED
  && hypo.amount!.provenance !== EventProvenance.DERIVED);
check('D3 nothing in this slice PRODUCES a hypothetical — the representation exists, the producer does not',
  !/EventProvenance\.HYPOTHETICAL/.test(code.replace(/HYPOTHETICAL: 'HYPOTHETICAL',/, '')));
check('D4 a hypothetical is distinguishable after composition',
  composeFutureCash([hypo]).components.length === 1
  && hypo.amount!.provenance === EventProvenance.HYPOTHETICAL);

// ═══════════════════════════════════════════════════════════════════════════
// E. The licensed chain: cadence → activity → event
// ═══════════════════════════════════════════════════════════════════════════

const abaEvents = cadenceDerivedEvents(abaAct, abaCad, AS_OF, '2026-12-31', FlowRole.INCOME);
const vecEvents = cadenceDerivedEvents(vecAct, vecCad, AS_OF, '2026-12-31', FlowRole.INCOME);

check('E1 the raw generator still produces Abacus dates',
  occurrencesBetween(abaCad, AS_OF, '2026-12-31').length === 8);
eq('E2 the stale stream produces ZERO expected cash events', abaEvents.length, 0);
eq('E3 and Abacus is SILENT, not ENDED', abaAct.state, ActivityState.SILENT);
check('E4 the current payroll produces events', vecEvents.length === 9, String(vecEvents.length));
eq('E5 on deterministic cadence dates', vecEvents.slice(0, 2).map((e) => exactDateOf(e.timing)),
  ['2026-08-28', '2026-09-11']);
check('E6 generation routes through the LICENSED api, never the mechanical one',
  /expectedOccurrencesBetween\(activity, cadence, fromISO, toISO\)/.test(code)
  // The strongest form of this pin: the module does not even IMPORT the
  // mechanical generator, so it cannot skip the licence by accident.
  && !/\boccurrencesBetween\b/.test(code.replace(/expectedOccurrencesBetween/g, 'X')),
  code.match(/.{0,60}occurrencesBetween.{0,30}/)?.[0]);
check('E7 an activity decision is a required argument',
  /export function cadenceDerivedEvents\(\s*activity: StreamActivity,/.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// F. Amount authority — measured, and honestly absent
// ═══════════════════════════════════════════════════════════════════════════

check('F1 cadence-derived events carry NO amount by default',
  vecEvents.every((e) => e.amount === null));
check('F2 which is not zero — composition counts them as unresolved', (() => {
  const c = composeFutureCash(vecEvents);
  return c.assertableNet === null && c.unresolved.noAmount === 9 && c.nominalInflow === 0;
})());
check('F3 no amount is derived from the observation series',
  !/median|mean|average|typicalAmount/.test(code));
check('F4 the module records the measured reason', /CV 24\.6%/.test(src));

// A user-asserted amount attaches, and the DATE stays derived.
const asserted = cadenceDerivedEvents(vecAct, vecCad, AS_OF, '2026-09-30', FlowRole.INCOME,
  { value: 5250, currency: 'USD', basis: AmountBasis.NET, provenance: EventProvenance.USER_ASSERTED });
eq('F5 asserted amount + derived date is representable',
  [asserted[0].amount!.provenance, asserted[0].timingProvenance],
  [EventProvenance.USER_ASSERTED, EventProvenance.DERIVED]);
eq('F6 and the net contribution is assertable', composeFutureCash(asserted).assertableNet, 5250 * asserted.length);
check('F7 the same amount with unstated basis is NOT', (() => {
  const u = cadenceDerivedEvents(vecAct, vecCad, AS_OF, '2026-09-30', FlowRole.INCOME,
    { value: 5250, currency: 'USD', basis: AmountBasis.UNKNOWN, provenance: EventProvenance.USER_ASSERTED });
  return composeFutureCash(u).assertableNet === null;
})());

// ═══════════════════════════════════════════════════════════════════════════
// G. Timing
// ═══════════════════════════════════════════════════════════════════════════

const october: EventTiming = { kind: 'RANGE', fromISO: '2026-10-01', toISO: '2026-10-31' };
eq('G1 "a bonus in October" keeps its range', describeTiming(october), '2026-10');
eq('G2 and yields NO exact date — no day is invented', exactDateOf(october), null);
eq('G3 unknown timing stays unknown', exactDateOf({ kind: 'UNKNOWN' }), null);
eq('G4 an exact date is an exact date', exactDateOf({ kind: 'EXACT', dateISO: '2026-09-11' }), '2026-09-11');
check('G5 nothing picks a midpoint', !/midpoint|\/ 2\b|floor\(\(/.test(code));
eq('G6 a cross-month range shows both ends',
  describeTiming({ kind: 'RANGE', fromISO: '2026-10-15', toISO: '2026-11-15' }), '2026-10-15..2026-11-15');
check('G7 an unresolved-timing event still composes',
  composeFutureCash([ev({ value: 15500, timing: october })]).components[0].timing === '2026-10');

// ═══════════════════════════════════════════════════════════════════════════
// H. Economic role — existing vocabulary, no new taxonomy
// ═══════════════════════════════════════════════════════════════════════════

const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const flowTypeEnum = schema.slice(schema.indexOf('enum FlowType {'));
const flowTypeBody = flowTypeEnum.slice(0, flowTypeEnum.indexOf('}'));
check('H1 every role is a real FlowType member — the ledger\'s own vocabulary',
  Object.values(FlowRole).every((r) => new RegExp(`^\\s*${r}\\s*$`, 'm').test(flowTypeBody)),
  Object.values(FlowRole).filter((r) => !new RegExp(`^\\s*${r}\\s*$`, 'm').test(flowTypeBody)).join(','));
check('H2 no invented roles — no BONUS, VACATION_PAY or PAYROLL taxonomy',
  !/BONUS|VACATION_PAY|PAYROLL|SALARY/.test(code));

// Periodic is not payroll.
const interestEvents = cadenceDerivedEvents(tenAct, tenCad, AS_OF, '2026-12-31', FlowRole.INTEREST);
check('H3 monthly interest generates events — it is not suppressed', interestEvents.length === 4,
  String(interestEvents.length));
check('H4 and keeps the INTEREST role, never INCOME',
  interestEvents.every((e) => e.role === FlowRole.INTEREST));
check('H5 role travels through composition',
  composeFutureCash(interestEvents).components.every((k) => k.role === FlowRole.INTEREST));

// Direction is not role, and INFLOW is not operating income.
const refund = ev({ value: 240, basis: AmountBasis.NET, role: FlowRole.REFUND });
const transfer = ev({ value: 2000, basis: AmountBasis.NET, role: FlowRole.TRANSFER });
check('H6 a refund is an INFLOW and keeps the REFUND role',
  refund.direction === 'INFLOW' && refund.role === FlowRole.REFUND);
check('H7 a transfer is an INFLOW and keeps the TRANSFER role',
  transfer.direction === 'INFLOW' && transfer.role === FlowRole.TRANSFER);
check('H8 nothing in the module concludes "operating income" or "recurring"',
  !/operatingIncome|isRecurring|recurringIncome/i.test(code));
check('H9 direction and role are independent fields',
  /direction: 'INFLOW' \| 'OUTFLOW';/.test(src) && /role: FlowRoleKind;/.test(src));

// ═══════════════════════════════════════════════════════════════════════════
// I. Currency — no invented future FX
// ═══════════════════════════════════════════════════════════════════════════

const mixedCcy = composeFutureCash([
  ev({ value: 5250, basis: AmountBasis.NET, currency: 'USD' }),
  ev({ value: 0.05, basis: AmountBasis.NET, currency: 'BTC' }),
]);
eq('I1 unlike currencies produce NO combined net', mixedCcy.assertableNet, null);
eq('I2 and no nominal total either', [mixedCcy.nominalInflow, mixedCcy.nominalOutflow], [0, 0]);
check('I3 the refusal names the missing future rate',
  /no exchange rate exists for a future date/.test(mixedCcy.netRefusalReason ?? ''),
  String(mixedCcy.netRefusalReason));
eq('I4 both currencies are still disclosed', mixedCcy.currencies.sort(), ['BTC', 'USD']);
eq('I5 currency is null when there is no single one', mixedCcy.currency, null);
check('I6 no FX conversion is attempted anywhere', !/convertMoney|fxRate|FxRate|rate \*/i.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// J. Composition discipline (CF-1 / CF-7 shape)
// ═══════════════════════════════════════════════════════════════════════════

eq('J1 an empty collection composes to nothing assertable',
  [composeFutureCash([]).assertableNet, composeFutureCash([]).components.length], [0, 0]);
check('J2 every event becomes a named component',
  composeFutureCash([bonus, vacation]).components.length === 2);
check('J3 each component states whether it counts',
  composeFutureCash([bonus, vacation]).components.every((k) => k.countsTowardNet === false));
check('J4 an all-NET collection DOES yield a net figure',
  composeFutureCash([ev({ value: 1500, basis: AmountBasis.NET }), ev({ value: 500, basis: AmountBasis.NET })])
    .assertableNet === 2000);
eq('J5 outflows reduce the net contribution',
  composeFutureCash([
    ev({ value: 3000, basis: AmountBasis.NET }),
    ev({ value: 1200, basis: AmountBasis.NET, direction: 'OUTFLOW', role: FlowRole.DEBT_PAYMENT }),
  ]).assertableNet, 1800);
check('J6 D-4: nothing rounds', !/Math\.round|toFixed/.test(code));
eq('J7 full precision survives composition',
  composeFutureCash([ev({ value: 0.1, basis: AmountBasis.NET }), ev({ value: 0.2, basis: AmountBasis.NET })])
    .assertableNet, 0.1 + 0.2);
check('J8 composition is deterministic',
  JSON.stringify(composeFutureCash([bonus, vacation])) === JSON.stringify(composeFutureCash([bonus, vacation])));

// ═══════════════════════════════════════════════════════════════════════════
// K. Substrate discipline
// ═══════════════════════════════════════════════════════════════════════════

check('K1 no database', !/from ['"]@?\/?lib\/db|prisma/i.test(code));
check('K2 no clock', !/Date\.now\(\)|new Date\(\)/.test(code));
check('K3 imports only FORECAST-1 and FORECAST-2',
  (src.match(/^import /gm) ?? []).length === 2
  && /from '\.\/cadence'/.test(src) && /from '\.\/stream-activity'/.test(src));
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
 * reaches for. A test and a conformance fixture build inputs for the authority
 * on purpose — `lib/ai/conformance/forecast-scenarios.ts` constructs the real
 * Space's streams so the language model can be measured against them — and
 * counting those as consumers would make the gate fail for the act of testing
 * the thing it protects.
 */
const isProductionFile = (f: string) =>
  !f.endsWith('.test.ts') && !f.startsWith('lib/ai/conformance/');
check('K4 FORECAST-3 is consumed only through the sanctioned adapter',
  execSync('grep -rl "forecast/future-cash-event" lib app components jobs scripts 2>/dev/null || true',
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter(isProductionFile)
    .every((f: string) => ALLOWED_CONSUMER_ROOTS.some((r) => f.startsWith(r))));
// baseline to the WORKING TREE, which turns "FORECAST-3 touched none of its
// dependencies" — a true and checkable claim about one commit — into "no later
// slice may touch them either", which FORECAST-3 has no standing to assert. Three
// gates of this exact shape had already failed for that reason (FORECAST-6 L5,
// FORECAST-7 J6, FORECAST-8 J10/J11), each time for a legitimate later edit. The
// files and the claim are unchanged; only the second ref is.
check('K5 FORECAST-3 did not touch FORECAST-1 or FORECAST-2',
  execSync('git diff --name-only d720d1e f849c05 -- lib/forecast/cadence.ts lib/forecast/stream-activity.ts',
    { encoding: 'utf8' }).trim() === '');
check('K6 no persistence', !/\.create\(|\.upsert\(|\.update\(|migration/i.test(code));
check('K7 no forecast, baseline or policy vocabulary leaked in',
  !/baselineSpend|forecastMonths|projectBalance|CurrentOperatingState/i.test(code));

// ═══════════════════════════════════════════════════════════════════════════
// L. Regression corpus A–K
// ═══════════════════════════════════════════════════════════════════════════

const one = (e: FutureCashEvent) => composeFutureCash([e]);
eq('L-A unknown-basis bonus: amount known, net unknown',
  [one(ev({ value: 15500 })).nominalInflow, one(ev({ value: 15500 })).assertableNet], [15500, null]);
eq('L-B explicit gross bonus is not spendable at face value',
  one(ev({ value: 15500, basis: AmountBasis.GROSS })).assertableNet, null);
eq('L-C explicit net payment is assertable',
  one(ev({ value: 1500, basis: AmountBasis.NET })).assertableNet, 1500);
eq('L-D mixed basis keeps both components',
  [mixed.assertableNet, mixed.unresolved.gross, mixed.nominalInflow], [null, 15500, 17000]);
eq('L-E asserted biweekly paycheck on derived dates',
  [asserted.length > 0, asserted[0].timingProvenance, asserted[0].amount!.provenance],
  [true, EventProvenance.DERIVED, EventProvenance.USER_ASSERTED]);
eq('L-F stale Abacus generates zero events', abaEvents.length, 0);
eq('L-G monthly interest keeps its role', interestEvents[0].role, FlowRole.INTEREST);
eq('L-H a transfer is not promoted to income', transfer.role, FlowRole.TRANSFER);
eq('L-I a refund is not promoted to recurring income', refund.role, FlowRole.REFUND);
eq('L-J a hypothetical cannot pass as evidence', hypo.amount!.provenance, EventProvenance.HYPOTHETICAL);
eq('L-K no silent future FX assumption', mixedCcy.assertableNet, null);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
