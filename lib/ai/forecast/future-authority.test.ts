/**
 * lib/ai/forecast/future-authority.test.ts   (PARITY-3)
 *
 * A CLAIM ABOUT THE FUTURE NEEDS A LICENCE THAT REACHES IT.
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs \
 *       lib/ai/forecast/future-authority.test.ts
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * PARITY-2 measured assistant-history contamination and could not close it. With
 * one invented projection in the assistant's own history — "estimated cash flow
 * until EOY: $34,035.64" — a net-worth follow-up rebuilt on it 5 times out of 5,
 * in BOTH master and named-Space mode, and three interventions changed nothing:
 * a doctrine rule ranking prior replies below evidence, routing the turn to
 * FORECAST so the substrate and doctrine applied, and FORECAST-14's guard in
 * repair mode.
 *
 * The guard failed for three separate reasons, and each is worth naming because
 * each is a way this boundary could be wrong again:
 *   · `ENDING_CASH_OVER_REFUSAL` keys on ending-cash vocabulary. "Projected
 *     increase of" is not that vocabulary.
 *   · `UNLICENSED_PRODUCT` looks for a multiple. $75,022.17 is a SUM.
 *   · `UNLICENSED_CASH_CLAIM` needs cash-claim language. "Net worth of" is not
 *     cash-claim language, and net worth is not licensed by a cash forecast at all.
 *
 * ── Why the fix is an axis and not a fourth pattern ─────────────────────────
 * Every one of those is a rule about WORDS. The thing they were all reaching for
 * is a rule about AUTHORITY: a figure can be perfectly licensed as a fact about
 * today and carry nothing whatever for a claim about December. So `LicensedFigure`
 * gains `horizon`, and a value asserted at a future point must match a licence
 * that reaches the future. Conversational history mints no licences, so the
 * contaminating figure fails for the same reason an invented one does — not
 * because it came from a prior reply, which the boundary never has to detect.
 *
 * ⚠️ THE REJECTED FORMULATION, RECORDED. "Any figure asserted about a future date
 * that is not in this prompt" was the obvious rule and is too broad: the
 * contaminated answers put the present and the future in ONE sentence ("start
 * with your current net worth of $40,986.53 and add the projected increase"),
 * and redaction removes sentences — so that rule destroys a correct, licensed
 * present fact to remove an invented future one. Sections D/H/I below exist to
 * keep that from being an acceptable trade.
 */

import {
  detectUnlicensedForecastArithmetic, licensedFigures, guardForecastReply,
  FigureRole, FigureHorizon, resolveForecastGuardMode,
} from './numerical-guard';
import { currentAuthorityFigures } from './for-request';
import { ConclusionStatus } from '@/lib/forecast/policy';
import { AmountBasis } from '@/lib/forecast/future-cash-event';
import { FinanceDomains, type SpaceContext_AI } from '@/lib/ai/types';
import type { CashForecast } from '@/lib/forecast/engine';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// Two forecasts over the same Space: one REFUSED (the real corpus today, which
// is what the contaminated conversation actually ran against) and one COMPUTED.

const OPENING = 16_976.35;
const ENDING  = 35_144.66;
const NET_WORTH = 40_986.53;
const CONTAMINANT = 34_035.64;      // the model's own invention, one turn earlier
const DERIVED_SUM = 75_022.17;      // NET_WORTH + CONTAMINANT

const base = {
  horizon: { fromISO: '2026-08-31', toISO: '2026-12-31', origin: 'USER_REQUESTED', statedAs: 'to EOY' },
  horizonDays: 122,
  openingCash: { state: 'FACTUALLY_LICENSED', amount: OPENING, asOfISO: '2026-08-31', reason: null },
  points: [], events: [],
  spending: { treatment: 'UNRESOLVED', amount: null, dailyRate: null },
  withoutAssumptions: null, firstNegativeDateISO: null,
  accepted: [], rejected: [], unresolvedInputs: ['current-normal discretionary spending'],
} as unknown as CashForecast;

const refused: CashForecast = {
  ...base,
  knownEventPath: { status: ConclusionStatus.FACTUALLY_LICENSED, closing: OPENING, dependencies: [], missing: [] },
  fullCashPath:   { status: ConclusionStatus.REFUSED, closing: null, dependencies: [],
                    missing: ['current-normal discretionary spending'] },
} as unknown as CashForecast;

const computed: CashForecast = {
  ...base,
  spending: { treatment: 'ASSUMED', amount: 4_000, dailyRate: 4_000 / 30.44 },
  knownEventPath: { status: ConclusionStatus.FACTUALLY_LICENSED, closing: OPENING, dependencies: [], missing: [] },
  fullCashPath:   { status: ConclusionStatus.FACTUALLY_LICENSED, closing: ENDING, dependencies: [], missing: [] },
} as unknown as CashForecast;

/** The accounts authority for the same Space — CURRENT figures, freely sayable. */
const ctx = {
  domains: { [FinanceDomains.ACCOUNTS]: { data: {
    netWorth: NET_WORTH, totalAssets: 41_536.28, totalLiabilities: 549.75,
    totalLiquid: OPENING, totalInvestments: 5_006.64, totalDigitalAssets: 19_014.63,
  } } },
} as unknown as SpaceContext_AI;
const CURRENT = currentAuthorityFigures(ctx);

const find = (reply: string, f: CashForecast = refused) =>
  detectUnlicensedForecastArithmetic(reply, f, CURRENT);
const kinds = (reply: string, f?: CashForecast) => find(reply, f).map((x) => x.kind);
const flagged = (reply: string, value: number, f?: CashForecast) =>
  find(reply, f).some((x) => Math.abs(x.value - value) < 0.51);

// ── The licence gains an axis ───────────────────────────────────────────────
{
  const lic = licensedFigures(computed, CURRENT);
  check('L1 opening cash is licensed CURRENT, not FUTURE',
    lic.some((l) => l.value === OPENING && l.horizon === FigureHorizon.CURRENT));
  check('L2 ending cash is licensed FUTURE',
    lic.some((l) => l.value === ENDING && l.horizon === FigureHorizon.FUTURE));
  check('L3 a stated spending LEVEL is a CURRENT rate, never a forward total',
    lic.some((l) => l.value === 4_000 && l.role === FigureRole.RATE
      && l.horizon === FigureHorizon.CURRENT));
  check('L4 current-authority figures enter as CURRENT',
    lic.some((l) => l.value === NET_WORTH && l.horizon === FigureHorizon.CURRENT));
  // ⚠️ NOT "no forward figure at all". A refused FULL path still licenses the
  // known-event balance — opening cash plus licensed events, with no spending
  // term — which is a real forward figure FORECAST-7 grants. What a refusal
  // withholds is the ENDING CASH slot, and that is what is pinned.
  check('L5 a REFUSED full path licenses no ending-cash figure',
    !licensedFigures(refused, CURRENT).some((l) => l.label === 'ending cash'));
}

// ── A. the contaminated follow-up ───────────────────────────────────────────
{
  const reply = `To project your net worth by the end of the year, we start with your current `
    + `net worth of $${NET_WORTH.toLocaleString('en-US', { minimumFractionDigits: 2 })} and add `
    + `the projected increase of $${CONTAMINANT.toLocaleString('en-US', { minimumFractionDigits: 2 })}. `
    + `Your estimated net worth by the end of the year would be $${DERIVED_SUM.toLocaleString('en-US', { minimumFractionDigits: 2 })}.`;
  check('A1 the invented projection is refused authority',
    flagged(reply, CONTAMINANT), kinds(reply).join(',') || 'no findings');
  check('A2 the figure derived from it is refused too',
    flagged(reply, DERIVED_SUM));
  check('A3 the finding names the AUTHORITY, not the prior turn',
    find(reply).some((f) => /no forecast this turn licenses a figure for that date/.test(f.claim)));
  // ⚠️ D/H — the correct half of the same sentence survives as a FINDING; whether
  // the sentence survives redaction is section R below.
  check('A4 the licensed CURRENT net worth is not itself a finding',
    !flagged(reply, NET_WORTH));
}

// ── B. both modes — the guard is mode-shaped, not entry-shaped ──────────────
//
// There is no master-vs-space branch in this boundary: the route hands the same
// (reply, forecast, current) triple from either entry, which is exactly why
// PARITY-2 found the failure in both. Pinned as the shared call it is.
{
  const reply = `By the end of the year your net worth would be $${DERIVED_SUM.toLocaleString('en-US', { minimumFractionDigits: 2 })}.`;
  const narrate = () => ['Ending cash: REFUSED'];
  const shadow = guardForecastReply(reply, refused, resolveForecastGuardMode('shadow'), narrate, CURRENT);
  const repair = guardForecastReply(reply, refused, resolveForecastGuardMode('repair'), narrate, CURRENT);
  check('B1 shadow observes and does not rewrite', shadow.findings.length > 0 && shadow.reply === reply);
  check('B2 repair removes the unlicensed future figure',
    !repair.reply.includes('75,022.17'), repair.reply.slice(0, 120));
  check('B3 and the outcome is reported', /redacted|fallback/.test(repair.outcome), repair.outcome);
}

// ── C/J/K. legitimate future values still pass ──────────────────────────────
{
  const ok = `Your ending cash by the end of the year would be $35,144.66.`;
  check('C1 a deterministic ending-cash forecast is allowed',
    !flagged(ok, ENDING, computed), kinds(ok, computed).join(','));
  check('C2 the same sentence over a REFUSED path is not',
    flagged(ok, ENDING, refused));

  // J — a NET future event reaches the horizon exactly once, through the engine.
  const withEvent: CashForecast = { ...computed, events: [
    { id: 'e1', dateISO: '2026-09-11', direction: 'INFLOW', role: 'INCOME',
      included: true, cashDelta: 5_286.65, refusalReason: null, assumedBasis: null,
      authoritativeAmount: { value: 5_286.65, basis: AmountBasis.NET } },
  ] } as unknown as CashForecast;
  const j = `You will receive $5,286.65 on September 11, and by year-end your balance would be $35,144.66.`;
  check('J1 a licensed NET future event is sayable',
    !flagged(j, 5_286.65, withEvent), kinds(j, withEvent).join(','));

  // K — a GROSS event is visible with its caveat, never as spendable future value.
  const withGross: CashForecast = { ...computed, events: [
    { id: 'e2', dateISO: '2026-10-15', direction: 'INFLOW', role: 'BONUS',
      included: true, cashDelta: null, refusalReason: 'gross basis', assumedBasis: null,
      authoritativeAmount: { value: 15_500, basis: AmountBasis.GROSS } },
  ] } as unknown as CashForecast;
  const kOk  = `A $15,500 bonus is expected on October 15 (gross — not counted as cash).`;
  const kBad = `By the end of the year you will have $15,500 available to spend from the bonus.`;
  check('K1 a GROSS future amount is sayable with its caveat',
    !flagged(kOk, 15_500, withGross), kinds(kOk, withGross).join(','));
  check('K2 and never convertible into spendable future value',
    flagged(kBad, 15_500, withGross));
}

// ── D/E/H/I. present and past figures are untouched ─────────────────────────
{
  const d = `Your current net worth is $40,986.53 and your liquid cash is $16,976.35.`;
  check('D1 a current net worth is allowed', find(d).length === 0, kinds(d).join(','));

  const dMixed = `I cannot project your year-end position. Currently, your net worth is $40,986.53.`;
  check('D2 a present fact beside a refusal to project is allowed',
    find(dMixed).length === 0, kinds(dMixed).join(','));

  const e = `### Spending Over the Last 3 Months\n- **Total Spending:** $25,048.98`;
  check('E1 a historical section is out of scope entirely', find(e).length === 0, kinds(e).join(','));

  const h = `As I mentioned, your net worth is $40,986.53 today.`;
  check('H1 repeating a CURRENT figure is licensed by current authority, not by the prior turn',
    find(h).length === 0, kinds(h).join(','));
  // I — the licence is what allows it; sameness with prior prose is irrelevant.
  check('I1 a figure equal to a licensed one passes because authority licenses it',
    licensedFigures(refused, CURRENT).some((l) => l.value === NET_WORTH));
  check('I2 and the identical number asserted at a FUTURE point does not',
    flagged(`By the end of the year your net worth would be $40,986.53.`, NET_WORTH));
}

// ── F/G. user-authored amounts enter through their own authorities ──────────
//
// Not through this boundary, which is the point: a fact or a supposition the
// user stated reaches the forecast via FORECAST-9A/13 (facts) or FORECAST-8
// (policy) and arrives here already licensed. A number the user merely typed,
// which no authority accepted, licenses nothing.
{
  const accepted: CashForecast = { ...computed,
    spending: { treatment: 'ASSUMED', amount: 4_000, dailyRate: 4_000 / 30.44 },
    accepted: [{ origin: 'USER_REQUESTED', statedAs: 'assume I spend $4,000/month' }],
  } as unknown as CashForecast;
  const g = `Assuming $4,000/month in spending, your ending cash would be $35,144.66.`;
  check('G1 a supposition the policy accepted is sayable as a rate',
    !flagged(g, 4_000, accepted), kinds(g, accepted).join(','));
  check('F1 an amount no authority accepted licenses no future value',
    flagged(`By the end of the year you would have $99,999.00.`, 99_999));
}

// ── L. no authority ⇒ refuse rather than extrapolate ────────────────────────
{
  const l = `Your net worth by the end of the year would be $75,022.17, based on your cash flow.`;
  const g = guardForecastReply(l, refused, resolveForecastGuardMode('repair'),
    () => ['Ending cash: REFUSED — current-normal discretionary spending is missing'], CURRENT);
  check('L6 an unlicensed future value does not reach the user',
    !g.reply.includes('75,022.17'), g.reply.slice(0, 140));
  check('L7 and what remains states the refusal', /REFUSED|cannot|missing/i.test(g.reply), g.reply.slice(0, 140));
}

// ── N. follow-up continuity, from a COMPUTED forecast ───────────────────────
//
// ⚠️ COVERED HERE BECAUSE THE LIVE CORPUS CANNOT REACH IT. On the real Space the
// forecast refuses for want of an established income basis, so the "valid
// forecast, then ask about net worth" pair could not be exercised end-to-end
// against the model. The invariant is deterministic, so it is pinned
// deterministically rather than left to a corpus that happens to refuse.
//
// The rule the pair encodes: turn 2 may restate what THIS turn's authority
// licenses, and may not derive anything further from it.
{
  const restate = `As forecast, your ending cash by the end of the year would be $35,144.66.`;
  check('N1 a follow-up may restate a figure this turn\'s forecast licenses',
    find(restate, computed).length === 0, kinds(restate, computed).join(','));

  const derive = `Your ending cash would be $35,144.66, so your net worth by then would be $59,144.66.`;
  check('N2 but may not derive a further future value from it',
    flagged(derive, 59_144.66, computed));
  check('N2b while the licensed figure in the same reply stays licensed',
    !flagged(derive, ENDING, computed));
}

// ── R. redaction keeps the correct half where it can ────────────────────────
//
// ⚠️ HONEST LIMIT, PINNED RATHER THAN CLAIMED AWAY. Redaction removes SENTENCES
// (FORECAST-14 measured that removing the number alone leaves a sentence still
// making a claim). So when the model puts a licensed present fact and an
// invented future one in the SAME sentence, the present fact goes with it. What
// this section pins is that a present fact in its OWN sentence survives — which
// is the shape the answer takes once the future half is refused.
{
  const two = `Your current net worth is $40,986.53. By the end of the year it would be $75,022.17.`;
  const g = guardForecastReply(two, refused, resolveForecastGuardMode('repair'),
    () => ['Ending cash: REFUSED'], CURRENT);
  check('R1 the licensed present sentence survives redaction',
    g.reply.includes('40,986.53'), g.reply.slice(0, 160));
  check('R2 the unlicensed future sentence does not', !g.reply.includes('75,022.17'));
}

console.log(failures === 0
  ? `\nPARITY-3 future numerical authority: ${passes} checks passed.`
  : `\nPARITY-3 future numerical authority: ${failures} FAILURE(S) (${passes} passed).`);
process.exit(failures === 0 ? 0 : 1);
