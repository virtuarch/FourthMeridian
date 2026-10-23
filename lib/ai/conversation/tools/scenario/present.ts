/**
 * lib/ai/conversation/tools/scenario/present.ts
 *
 * Scenario presentation: the clause roster / assumptions echo and the
 * presented table every scenario tool returns.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import type { SpendingChangeOutcome } from '@/lib/ai/forecast/assemble';
import {
  ORIGIN, type Origin, type LedgerCheckpoint, type LedgerResult, type ReturnPeriod,
} from '../../scenario-ledger';
import { clausesInForce, notAppliedEcho } from '../../scenario-rules';
import type { FloorDerivation } from '@/lib/ai/measures/baseline';
import { compactMovements, describePlan } from '../../scenario-checkpoints';
import { positionChange, openingPosition, checkpointPosition } from '../../scenario-change';
import { round2 } from '../shared/values';
import type { ScenarioRun, ScenarioSetup } from './setup';

/** The floor derivations a ledger ran with (the setup's, for a plain LedgerResult). */
function floorDerivationsOf(setup: ScenarioSetup, ledger: LedgerResult | ScenarioRun): FloorDerivation[] {
  return (ledger as Partial<ScenarioRun>).floorDerivations ?? setup.floorDerivations;
}

/** S1 — what the spending rules did IN THIS RUN (a solve adds its own), else the setup's. */
function spendingOf(setup: ScenarioSetup, ledger: LedgerResult | ScenarioRun): SpendingChangeOutcome | undefined {
  return (ledger as Partial<ScenarioRun>).spendingChanges ?? setup.spendingChanges;
}

/**
 * What was actually in force, echoed back.
 *
 * ⚠️ IT TRAVELS ON EVERY PATH, INCLUDING A REFUSAL, and the first live run is
 * why. Asked "how could I reach $1M?", the model called the goal seek with a bare
 * target — no return, no contributions — got an honest "not reachable", and then
 * described the answer as *"investing half your liquidity each year at 8%"*,
 * because that is what the conversation had said two turns earlier. The figure
 * was right and the sentence around it was not. A refusal that echoes nothing
 * invites the model to supply the frame from memory; a refusal that names its own
 * assumptions does not.
 */
/**
 * The surplus share in force, as the rule it is.
 *
 * ⚠️ IT IS READ BACK OFF THE SETTLED MOVEMENTS, not carried alongside them, so
 * what is echoed is what was actually applied. A scenario cannot claim a share it
 * did not run.
 */
function surplusRule(ledger: LedgerResult) {
  const taken = ledger.movements.filter(
    (m) => m.kind === 'CONTRIBUTION' && m.surplusFraction !== undefined);
  if (taken.length === 0) return null;
  const fractions = [...new Set(taken.map((m) => m.surplusFraction as number))];
  const funded = taken.filter((m) => m.amount > 0);
  return {
    surplusFraction: fractions.length === 1 ? fractions[0] : fractions,
    from: taken[0].date, to: taken[taken.length - 1].date,
    months: taken.length,
    monthsWithNoSurplus: taken.length - funded.length,
    contributed: round2(taken.reduce((s, m) => s + m.amount, 0)),
    meaning: 'A share of the cash each month is projected to ADD, taken at month-end. The '
      + 'balance already held is never touched, and a month projecting no gain contributes '
      + 'nothing. At a 0% return this moves money between lines and changes net worth by '
      + 'nothing at all.',
  };
}

/**
 * The liquid floor in force, as the rule it is — read back off the settled
 * movements like `surplusRule`, so what is echoed is what was applied.
 *
 * ⚠️ IT SAYS WHEN THE FLOOR WAS FIRST REACHED AND HOW OFTEN IT WAS NOT HELD.
 * "Keep $50k" is one sentence; the projection may sit under $50k for months
 * before it gets there and may fall under it again in a bad month. A reader
 * told only "the rule was in force" would narrate a floor that was maintained
 * throughout, which the arithmetic did not do.
 */
function floorRule(ledger: LedgerResult, derivations: FloorDerivation[] = []) {
  const taken = ledger.movements.filter(
    (m) => m.kind === 'CONTRIBUTION' && m.liquidFloor !== undefined);
  if (taken.length === 0) return null;
  const floors = [...new Set(taken.map((m) => m.liquidFloor as number))];
  const shares = [...new Set(taken.map((m) => m.fractionOfExcess as number))];
  const isAbove = (m: typeof taken[number]) => (m.availableBefore ?? 0) > (m.liquidFloor as number);
  const firstAbove = taken.findIndex(isAbove);
  // ⚠️ TWO DIFFERENT KINDS OF "UNDER THE FLOOR", COUNTED APART. The months before
  // the balance first reaches the line are the run-up the user asked for; the
  // months under it AFTER that are the ones where ordinary cash activity undid
  // the floor and the rule sat out. Only the second is a fact a reader needs
  // before saying the floor was kept.
  const afterReached = firstAbove === -1 ? [] : taken.slice(firstAbove);
  const derived = derivations.filter((d) => floors.includes(d.liquidFloor)).map((d) => d.derivedFrom);
  return {
    liquidFloor: floors.length === 1 ? floors[0] : floors,
    // ⚠️ M1 — THE FLOOR KEEPS ITS IDENTITY. When the dollars came from "N months of
    // expenses", the rule and the baseline it multiplied are echoed beside them:
    // say "six months of expenses ($X at $Y/month)", not only the dollar figure.
    ...(derived.length ? { derivedFrom: derived.length === 1 ? derived[0] : derived } : {}),
    fractionOfExcess: shares.length === 1 ? shares[0] : shares,
    from: taken[0].date, to: taken[taken.length - 1].date,
    months: taken.length,
    alreadyAboveFloorAtStart: floors.length === 1 && ledger.opening.liquid > floors[0],
    firstMonthEndAtOrAboveFloor: firstAbove === -1 ? null : taken[firstAbove].date,
    monthsBeforeFloorReached: firstAbove === -1 ? taken.length : firstAbove,
    monthsBelowFloor: afterReached.filter((m) => !isAbove(m)).length,
    contributed: round2(taken.reduce((s, m) => s + m.amount, 0)),
    meaning: 'At each month-end, the share of cash held ABOVE the floor is moved into '
      + 'investments; cash is left at the floor. Nothing moves until the balance first '
      + 'reaches the floor (`firstMonthEndAtOrAboveFloor`). The rule itself never takes cash '
      + 'below the floor, but ordinary spending or a stated outflow can; `monthsBelowFloor` '
      + 'counts the month-ends AFTER the floor was first reached where the balance was under '
      + 'it — in those months the rule moves nothing and sells nothing, and the floor was not '
      + 'held. At a 0% return this moves money between lines and changes net worth by nothing '
      + 'at all.',
  };
}

/**
 * Which staged clauses this run can be SHOWN to have applied.
 *
 * ⚠️ REVIEW BLOCKER 2. The first version listed every merged clause as applied and
 * the turn then consumed them — while `notApplied` in the SAME result named one as
 * refused. A staged STOP on an unknown source was "applied, describe it as the
 * user's stated condition", refused, consumed, and dropped from the envelope: it
 * then existed nowhere. A clause is now confirmed only when nothing refused it:
 * exactly, for an income rule (refusals name it by position) and for a wholly
 * refused argument; conservatively otherwise — when this run refused something it
 * cannot attribute, the staged clauses of the other arguments are reported NOT
 * CONFIRMED and are kept for the next run rather than consumed on a guess.
 */
function stagedEcho(setup: ScenarioSetup, rejected: readonly { input: string; argument?: string }[]) {
  const staged = setup.staged!;
  const run = setup.argumentsRun;
  const incomeIdx = (v: unknown) =>
    (Array.isArray(run.incomeChanges) ? run.incomeChanges : []).indexOf(v) + 1;
  const refusedIncome = new Set(rejected.map((r) => /`incomeChanges` rule i(\d+)/.exec(r.input)?.[1])
    .filter((n): n is string => !!n).map(Number));
  const spendIdx = (v: unknown) =>
    (Array.isArray(run.spendingChanges) ? run.spendingChanges : []).indexOf(v) + 1;
  const refusedSpending = new Set(rejected.map((r) => /`spendingChanges` rule s(\d+)/.exec(r.input)?.[1])
    .filter((n): n is string => !!n).map(Number));
  const wholeArgs = new Set(rejected.map((r) => r.argument).filter((a): a is string => !!a));
  const unattributed = rejected.some((r) => !r.argument && !/`(incomeChanges|spendingChanges)`/.test(r.input));
  const confirmed: typeof staged.applied = [];
  const unconfirmed: typeof staged.applied = [];
  for (const c of staged.applied) {
    const refused = wholeArgs.has(c.key)
      || (c.key === 'incomeChanges' ? refusedIncome.has(incomeIdx(c.value))
        : c.key === 'spendingChanges' ? refusedSpending.has(spendIdx(c.value))
        : c.key === 'annualReturnPct' ? Array.isArray(run.returns) && run.returns.length > 0
          : c.key === 'assumedMonthlySpending' ? false : unattributed);
    (refused ? unconfirmed : confirmed).push(c);
  }
  return {
    clauses: confirmed.map((x) => ({ id: x.id, argument: x.key, statedInTurn: x.stagedAt + 1 })),
    ...(unconfirmed.length ? { notConfirmed: {
      clauses: unconfirmed.map((x) => ({ id: x.id, argument: x.key })),
      meaning: 'These staged conditions were sent to this run but it refused something in them (see '
        + '`notApplied`), so they are NOT shown to have applied. They are still held; do not describe '
        + 'them as included.',
    } } : {}),
    ...(staged.supersededByCall.length ? { supersededByThisCall: {
      clauses: staged.supersededByCall,
      meaning: 'This call restated these rules (or another rule about the same thing), so the call\'s '
        + 'version ran and the staged one did not.',
    } } : {}),
    meaning: '`clauses` were stated earlier in this conversation and applied to this run alongside the '
      + 'arguments of this call. Describe them as the user\'s stated conditions.',
  };
}

export function scenarioAssumptions(
  setup: ScenarioSetup, ledger: LedgerResult, returns: ReturnPeriod[],
  /** The lever a goal seek SOLVED for, whose values in this run are the solver's, not anyone's statement. */
  solved?: string,
) {
  const solvedReturn = solved === 'annualReturnPct';
  const solvedFlow = solved === 'monthlyContribution' || solved === 'monthlySpendingCut';
  const kind = (k: 'CONTRIBUTION' | 'OUTFLOW') => ledger.movements.filter((m) => m.kind === k);
  return {
    // ⚠️ THE HORIZON IS AN ASSUMPTION, AND IT IS ECHOED WITH THE OTHERS. A solve
    // to mid-2030 and a projection to end-2029 were narrated as the same scenario
    // at different rates; every scenario tool now states the date its ledger ran
    // to in the same field, so a later turn cannot inherit one and quote the other.
    horizon: { to: setup.toISO },
    // ⚠️ EVERY CLAUSE KIND, RAN OR NOT (G5). `surplusRule` and `floorRule` below
    // describe a rule that ran; neither can say the OTHER did not. This is the
    // closed roster — a floor that was dropped on the way into the arguments is
    // reported here as `cashFloor.ran: false`, with the lowest cash the scenario
    // reached, in the same turn the model is about to narrate it.
    clauses: clausesInForce(ledger,
      floorDerivationsOf(setup, ledger).map((d) => ({ liquidFloor: d.liquidFloor, derivedFrom: d.derivedFrom })),
      // I1 — the SPINE's own record, not `a.incomeChanges`. See `clausesInForce`.
      setup.incomeChanges?.executions ?? [],
      // S1 — likewise the spine's record of each spending rule (this run's, so a
      // solved cut is listed beside the scenario's own rules).
      ((sc) => (sc?.applied ? sc.executions : []))(spendingOf(setup, ledger)),
      setup.spendingRequestedAs ?? {}),
    returns: returns.length === 0
      ? { statedRate: null,
          note: 'No return was in force. Investments are held flat at 0% — do not substitute '
            + 'a market average, and do not describe this result as carrying a return.' }
      : returns.map((r) => ({ from: r.fromISO, to: r.toISO, annualPct: r.annualPct,
          origin: solvedReturn ? ORIGIN.SOLVED : setup.origins.returnsInForce ?? ORIGIN.MODEL_SUPPLIED,
          scenarioAssumption: true })),
    // ⚠️ WHAT THE SHARE ACTUALLY CAME TO, EVERY TIME. "Half my liquidity" is the
    // instruction; the dollar figures are the answer, they differ at every date,
    // and only the settled ones can be checked against the table.
    contributions: {
      scheduled: kind('CONTRIBUTION').length,
      total: round2(kind('CONTRIBUTION').reduce((s, m) => s + m.amount, 0)),
      settled: kind('CONTRIBUTION').slice(0, 12),
      ...(setup.origins.contributions ? { origin: setup.origins.contributions } : {}),
      ...(solvedFlow ? { solvedIncluded: { origin: ORIGIN.SOLVED,
        meaning: 'the movements labelled "solved …" are the goal seek\'s answer, not a stated contribution' } } : {}),
      scenarioAssumption: true,
      // ⚠️ THE RULE, NOT ONLY ITS ARTIFACTS. "75% of each month's surplus" is one
      // sentence that expands into a hundred and thirty-five dated amounts; a
      // later turn saying "make it 8%" has to inherit the SENTENCE, and a
      // scenario state carrying only the amounts would inherit an accident of
      // one horizon. `settled` above stays the evidence; this is the assumption.
      ...(surplusRule(ledger) ? { surplusRule: surplusRule(ledger) } : {}),
      ...(floorRule(ledger, floorDerivationsOf(setup, ledger))
        ? { floorRule: floorRule(ledger, floorDerivationsOf(setup, ledger)) } : {}),
      ...(kind('CONTRIBUTION').length === 0
        ? { note: 'No contributions were in force. Do not describe this result as including '
            + 'any.' } : {}),
    },
    outflows: { count: kind('OUTFLOW').length, settled: kind('OUTFLOW').slice(0, 12),
      ...(setup.origins.outflows ? { origin: setup.origins.outflows } : {}), scenarioAssumption: true },
    spending: { source: setup.monthlySpending.source, monthly: setup.monthlySpending.amount,
      // ⚠️ WHICH MONTHS, ALWAYS, WHEN THE RATE IS OBSERVED. "Roughly $5.7k to low-$7k
      // baked in" was narrated over a rate that was one number over two months the
      // echo never named. The canonical baseline's own months travel with the figure.
      ...(setup.monthlySpending.source === 'OBSERVED' ? { averagedMonths: {
        months: setup.spendingBaseline.months, count: setup.spendingBaseline.monthCount,
        label: setup.spendingBaseline.label, basis: setup.spendingBaseline.basis,
        ...(setup.spendingBaseline.zeroMonths.length ? { zeroMonths: setup.spendingBaseline.zeroMonths } : {}),
        ...(setup.spendingBaseline.excluded.length ? { notAveraged: setup.spendingBaseline.excluded } : {}),
      } } : {}),
      ...(setup.monthlySpending.source === 'OBSERVED'
        ? { note: setup.modelledInterest
          ? 'from the same observed rate project_cash uses, LESS the interest below — so it can be lower than project_cash\'s'
          : 'from the same observed rate project_cash uses' } : {}),
      // S1 — the schedule the spending rules left, and what it removed in total.
      ...(spendingOf(setup, ledger) ? { changes: spendingOf(setup, ledger)!.applied
        ? { applied: true,
            spendingRemovedToHorizon: round2((spendingOf(setup, ledger) as SpendingChangeOutcome & { applied: true }).spendingRemoved),
            // At most 12 rows; the roster carries each rule.
            monthlyFrom: (spendingOf(setup, ledger) as SpendingChangeOutcome & { applied: true }).schedule.slice(0, 12)
              .map((x) => ({ from: x.fromISO, to: x.toISO, monthly: round2(x.monthly) })),
            meaning: 'Spending runs at `monthly` between those dates because of the spending changes in '
              + '`clauses.spendingChange`; `monthly` above is the rate BEFORE them. Positive '
              + '`spendingRemovedToHorizon` is spending the changes took away.' }
        : { applied: false, reason: (spendingOf(setup, ledger) as { reason: string }).reason } } : {}),
      // S1-N1 — interest counted once: as the ledger's accrual, not as spending.
      ...(setup.modelledInterest ? { interestLeftOut: {
        liabilities: setup.modelledInterest.accounts,
        byMonth: setup.modelledInterest.months.map((m) => ({ month: m.month, amount: round2(m.excluded) })),
        meaning: setup.modelledInterest.meaning } } : {}) },
    ...(ledger.liabilities ? { liabilities: liabilityEcho(ledger, setup.origins.liabilityAssumptions) } : {}),
    // ⚠️ WHAT RAN BECAUSE IT WAS STAGED, SAID CLAUSE BY CLAUSE (planning
    // continuity). A condition the user stated in an earlier turn and this run
    // applied is named as such — never as something this call said — and a call
    // item a newer staged restatement replaced is named too, so "pending wins" is
    // never silent. `argumentsRun` is what executed; the envelope keeps THAT.
    ...(setup.staged ? { fromEarlierInConversation: stagedEcho(setup, [...setup.rejected, ...ledger.rejected]) } : {}),
    argumentsRun: setup.argumentsRun,
    // ⚠️ WHAT WAS STATED AND NOT APPLIED, IN THE SAME ECHO — see `notAppliedEcho`.
    ...(notAppliedEcho([...setup.rejected, ...ledger.rejected])
      ? { notApplied: notAppliedEcho([...setup.rejected, ...ledger.rejected]) } : {}),
  };
}

/**
 * The liabilities in force, as the ledger moved them.
 *
 * ⚠️ `interestBasis` IS THE FIELD A PAYOFF DATE MUST BE READ WITH. PARTIAL means
 * at least one owed line has no rate, nothing accrued on it, and any payoff
 * date is a payments-only lower bound; the unmodelled lines are named so the
 * answer can say which. A user-assumed rate is echoed as USER_ASSUMED so a term
 * the user supplied is never presented as the issuer's.
 */
function liabilityEcho(ledger: LedgerResult, assumedOrigin?: Origin) {
  // ⚠️ AN ACCOUNT'S STORED TERMS ARE THE USER'S SAVED SETTINGS, NOT AN ASSUMPTION AND NOT "STATED" IN
  // THIS CONVERSATION. The ledger's own STATED/USER_ASSUMED marks are translated into the vocabulary
  // here; an assumed term carries whether the user's words license it.
  const termOrigin = (t: 'STATED' | 'USER_ASSUMED' | 'UNKNOWN') => (t === 'STATED' ? ORIGIN.USER_CONFIRMED
    : t === 'USER_ASSUMED' ? assumedOrigin ?? ORIGIN.MODEL_SUPPLIED : null);
  const L = ledger.liabilities!;
  const last = ledger.checkpoints[ledger.checkpoints.length - 1];
  const paid = ledger.movements.filter((m) => m.kind === 'CONTRIBUTION' && m.placed && m.placed.liabilities.length > 0);
  const targetsUsed = [...new Set(ledger.movements
    .filter((m) => m.kind === 'CONTRIBUTION' && m.placed)
    .flatMap((m) => m.placed!.liabilities.map((l) => l.id)))];
  return {
    lines: L.lines.map((l) => ({ id: l.id, label: l.label, openingBalance: l.balance,
      apr: l.apr, minimumPayment: l.minimumPayment, subtype: l.subtype ?? null,
      terms: l.termsProvenance ? {
        apr: termOrigin(l.termsProvenance.apr), minimumPayment: termOrigin(l.termsProvenance.minimumPayment),
        meaning: 'USER_CONFIRMED = the term stored on the account; USER_STATED / MODEL_SUPPLIED = a scenario '
          + 'assumption for this run; null = no term known' } : null })),
    interestBasis: L.interestBasis,
    unmodelled: L.unmodelled,
    withheldAggregate: L.withheldAggregate,
    totals: last ? { interestToDate: last.movements.interestToDate,
      minimumPaymentsToDate: last.movements.minimumPaymentsToDate,
      extraPaymentsToDate: round2(paid.reduce((s, m) => s + m.placed!.liabilities.reduce((t, l) => t + l.amount, 0), 0)),
      closingDebt: last.debt.amount } : null,
    allocationsToLiabilities: { rules: paid.length, liabilitiesPaid: targetsUsed },
    meaning: L.interestBasis === 'PARTIAL' || L.interestBasis === 'NONE'
      ? 'Interest is NOT modelled on the unmodelled liabilities — no rate is known for them. '
        + 'Any balance or payoff date over them is a payments-only lower bound: with a positive '
        + 'rate the balance would be higher and payoff later. Say so; do not call it exact. '
        + 'The user may state a rate with `liabilityAssumptions`.'
      : L.interestBasis === 'COMPLETE'
        ? 'Every owed liability accrues simple interest at its known rate over actual days on the '
          + 'balance carried into each month-end, before its stated minimum and any allocation.'
        : 'Nothing is owed on the modelled liabilities.',
  };
}

/**
 * How far one ledger position is from the ledger's opening — the ONE call both
 * the projection's horizon and a crossing's position go through.
 *
 * ⚠️ THE BASE IS THE LEDGER'S OPENING, AND WHEN THAT IS NOT THE ACCOUNTS TOTAL
 * THE BLOCK SAYS SO ITSELF. The result tells the model to quote the accounts
 * figure as today's position; "X higher than today" is X above the LEDGER figure.
 * `base` names it on every block, and `baseVsAccounts` appears exactly when the
 * reconciliation warning does, carrying both figures, so the sentence cannot be
 * attached to the wrong "today".
 */
export function changeSinceOpeningAt(setup: ScenarioSetup, ledger: LedgerResult, c: LedgerCheckpoint | undefined) {
  const change = c ? positionChange(openingPosition(ledger.opening), checkpointPosition(c)) : null;
  if (!change) return null;
  const difference = round2(ledger.opening.netWorth - (setup.accounts.netWorth ?? 0));
  return Math.abs(difference) > 1
    ? { ...change, baseVsAccounts: { ledgerOpeningNetWorth: ledger.opening.netWorth,
        accountsNetWorth: setup.accounts.netWorth, difference } }
    : change;
}

/**
 * The scenario payload both tools return, so a solved answer and a stated one
 * are read the same way.
 */
export function presentScenario(setup: ScenarioSetup, ledger: LedgerResult, returns: ReturnPeriod[], solved?: string) {
  const difference = round2(ledger.opening.netWorth - (setup.accounts.netWorth ?? 0));
  const warnings = [...ledger.warnings];
  if (Math.abs(difference) > 1) {
    warnings.push('The ledger\'s opening net worth differs from the accounts total by '
      + `${difference.toFixed(2)}; state the accounts figure, not this one, as today's position.`);
  }
  return {
    asOf: setup.asOf,
    // ⚠️ WHAT THE TABLE HAS ROWS FOR, AND WHAT IT DOES NOT. `granularity` is the
    // cadence actually returned; `requested` appears when it differs from what
    // was asked; `omitted` names the dates that have no row. A model reading
    // this can tell a missing date from a date it forgot to look at — the hole
    // it once filled with invented rows is now a field.
    horizon: { to: setup.toISO, ...describePlan(setup.plan) },
    // ⚠️ THE LEDGER'S OPENING RECONCILED AGAINST THE ACCOUNTS AUTHORITY, out
    // loud. Two net-worth figures for today in one answer is exactly the class
    // of contradiction this whole slice exists to stop.
    reconciliation: {
      accountsNetWorth: setup.accounts.netWorth,
      ledgerOpeningNetWorth: ledger.opening.netWorth,
      difference,
    },
    assumptions: scenarioAssumptions(setup, ledger, returns, solved),
    opening: ledger.opening,
    // ⚠️ THE DIFFERENCE IS A FIELD, NOT A SUBTRACTION LEFT TO THE READER. "About
    // $65k higher by next June" was the projected net worth minus the opening one,
    // composed in prose in 4 of 8 runs because the payload stated both levels and
    // never the movement. Stated ONCE, for the horizon — the date the caller named
    // — with its operands, `abs`, `pct`, its `base`, and what the sign of `debt`
    // means. NOT on every row: that was ~100 B a row for an unmeasured benefit, and
    // `checkpoints` below is the ledger's own array, untouched.
    changeSinceOpening: changeSinceOpeningAt(setup, ledger, ledger.checkpoints[ledger.checkpoints.length - 1]),
    checkpoints: ledger.checkpoints,
    // ⚠️ BOUNDED. A thirty-year rule settles 361 dated amounts and the result was
    // repeating every one beside a table whose rows already carry the same money.
    movements: compactMovements(ledger.movements),
    rejected: [...setup.rejected, ...ledger.rejected],
    warnings,
    basis: ledger.basis,
    // ⚠️ SAID ONCE, PLAINLY, WHERE THE MODEL WILL READ IT. Every earlier
    // version of this answer was composed in prose, and the assumption that a
    // stated return was a forecast is the failure that follows.
    qualification: SCENARIO_QUALIFICATION,
  };
}

/**
 * ⚠️ SAID ONCE, PLAINLY, WHERE THE MODEL WILL READ IT. Every earlier version of
 * this answer was composed in prose, and the assumption that a stated return was
 * a forecast is the failure that follows.
 */
export const SCENARIO_QUALIFICATION =
  'The cash line is an evidence-based projection; the returns and contributions are '
  + 'the user\'s own assumptions and nothing here predicts a market. Present the '
  + 'result as "if these assumptions hold", and never as an expectation.';
