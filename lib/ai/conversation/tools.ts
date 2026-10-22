/**
 * lib/ai/conversation/tools.ts
 *
 * THE TOOL SURFACE — the adapters in `TOOLS` at the bottom of this file (the
 * registry is the count; ARCH-012: prose counts drifted 13/16/18/20), over
 * authorities that already exist, plus the memory tools from `memory-tools.ts`.
 *
 * ⚠️ ADAPTERS, NOT AUTHORITIES. Not one line here computes a financial figure.
 * Every tool resolves parameters, calls a canonical function, and reshapes the
 * result into something compact and semantically explicit. If a tool ever needs
 * to add two money numbers together, that is a signal the composition belongs in
 * an authority, not here.
 *
 * There is exactly ONE arithmetic exception, and it is named rather than hidden:
 * `scenario_projection` reconciles the accounts authority's own totals to find
 * what is neither cash nor an investment (a house, a car) so the ledger can hold
 * it flat instead of dropping it. The scenario arithmetic itself is not here — it
 * is `scenario-ledger.ts`, which is a pure function with no data access at all.
 *
 * ⚠️ READ AND CALCULATE ONLY, WITH ONE NAMED EXCEPTION. Nothing in THIS file
 * writes: there is no correction tool, no categorise tool, and no Prisma client
 * in scope, all of which a test asserts. The single write verb in the harness is
 * `remember`, which lives in `memory-tools.ts` and can reach exactly one table —
 * `SpaceMemory`, which holds intentions and dated statements and structurally
 * cannot hold a balance. The harness remains incapable of mutating financial
 * data.
 *
 * ⚠️ THE VOCABULARY IS THE USER'S, NOT THE ARCHITECTURE'S. `get_spending`, not
 * `assembleTransactionsSummary`; `explain_net_worth_composition`, not
 * `resolveExplorationNode`. A model should not have to learn Fourth Meridian's
 * internal names to ask a question, and exposing them would leak the thing the
 * reset removed.
 */

import type { AccountsSectionData, AccountSummaryItem } from '@/lib/ai/types';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import type { CanonicalSpendingBaseline } from '@/lib/transactions/canonical-spending';
import { resolveTransformableCategory } from '@/lib/transactions/category-vocabulary';
import {
  projectInterval, monthlyRateAt, type ModelledInterestExclusion, type SpendingChangeOutcome,
  type SpendingChangeRule,
} from '@/lib/ai/forecast/assemble';
import { SCENARIO_INPUTS, NOT_AN_ASSUMPTION, scenarioAssumptionKeys } from './scenario-inputs';
import { mergeIntoArgs, stagePlan, type Attribution } from './pending-plan';
import type {
  IncomeChangeOpKind, IncomeChangeResult, IncomeChangeRule, RatePeriodKind,
} from '@/lib/forecast/income-change';
import {
  findScenarioCrossing, elapsedBetween, metricAt, type CrossingDirection, type LedgerMetric,
} from './scenario-crossing';
import {
  monthEndsBetween, runScenarioLedger, expandContributions, solveForTarget, returnHorizon,
  returnRepresentation, annualizedFromPeriodPct, periodFromAnnualizedPct, monthEndOccurrences, ORIGIN,
  type Origin, type SolveBound, type ContributionSpec, type LedgerCheckpoint, type LedgerResult,
  type PlannedMovement, type ReturnPeriod, type SpinePoint, type LiabilityLine, type AllocationTarget,
} from './scenario-ledger';
import {
  clausesInForce, contributionName, outflowName, unknownContributionKeys, isAllocationTargetWord,
  refuseUnknownArguments, refuseUnknownItemKeys, notAppliedEcho, boundedLabel, type RefusedInput,
} from './scenario-rules';
// ⚠️ THE ONE WRITE PATH, IMPORTED RATHER THAN INLINED. Keeping the memory tools
// in their own module is what lets THIS file keep an exact "no Prisma client,
// no write op" scan while `memory-tools.ts` gets its own, equally exact, "may
// reach db.spaceMemory and nothing else". One loose assertion covering both
// would have protected neither.
import { MEMORY_TOOLS } from './memory-tools';
import { describeFourthMeridian } from './product';
// ⚠️ READING memory, never writing it. `recallMemories` is the store's read half;
// the write half lives in the turn loop (slice 7) and in `remember`. This file
// still holds no Prisma client, which a test asserts.
import { recallMemories, MemoryKind } from './memory-store';
/**
 * RLS-AI-S0 — THE ABSENCE CONTRACT. Value imports, and deliberately: the oracle is
 * a CAPABILITY derived from `ctx.readClient`, not a client, so this file still
 * holds no Prisma client and the source scans that assert it still pass.
 */
import {
  adjudicateMemoryAbsence, indeterminateSentence as indeterminateFor, EvidenceState,
} from '@/lib/ai/absence';
import {
  readCheckpoint, compareToStatement, diffBasis, attributeInFlightVariance, attributionSideFromCheckpoint,
} from './reconcile';
import {
  incomeCompleteness, isOmittedLine, type IncomeCompleteness,
} from '@/lib/ai/forecast/income-completeness';
import { resolveMonthsOfExpensesFloor, type FloorDerivation } from '@/lib/ai/measures/baseline';
import {
  planCheckpoints, compactMovements, compactExcludedEvents, describePlan, yearEndsBetween, CADENCES,
  type Cadence, type CheckpointPlan,
} from './scenario-checkpoints';
import { positionChange, openingPosition, checkpointPosition } from './scenario-change';
import { getFinancialSnapshot, explainNetWorthComposition } from './tools/snapshot';
import type { ToolContext, ToolDefinition } from './tools/types';
import { obj, str, num } from './tools/shared/schema';
import { round2, addYearsISO } from './tools/shared/values';
import { absentIn } from './tools/shared/reads';
import { historicalSnapshot } from './tools/shared/historical-snapshot';
import { getSpending } from './tools/spending';
import { getTransactions } from './tools/transactions';
import { getIncome, getPayDates } from './tools/income';
import { measureFlows, getBaselines } from './tools/measures';
import { getInvestments, investmentScenario } from './tools/investments';
import { getNetWorthHistory, findInBalanceHistory } from './tools/history';
import { buildCashSpine } from './tools/shared/cash-spine';
import { originOf } from './tools/shared/origin';

/**
 * CQ-011 — every name this module exported before the split, re-exported from the
 * module that now holds it. Callers keep importing `@/lib/ai/conversation/tools`.
 */
export type { CashSpineReads, ToolContext, ToolDefinition } from './tools/types';
export { clampToCeiling } from './tools/shared/values';
export type { TransactionPager } from './tools/shared/read-window';
export { readWindowToExhaustion } from './tools/shared/read-window';

/**
 * ⚠️ RE-EXPORTED, NOT REIMPLEMENTED. The month-end grid moved into
 * `scenario-ledger.ts` when a surplus share had to generate its own dates. Every
 * caller here is unmoved and there is still exactly one implementation.
 */
export { monthEndsBetween };
export { yearEndsBetween };

// ── 8. Cash projection ───────────────────────────────────────────────────────

// ── AI RELIABILITY (2026-10-16) — the income term, stated honestly ───────────

/**
 * What an INCOMPLETE projection must say beside its figure. Pure arithmetic on
 * the completeness verdict: which current streams counted $0, the evidence the
 * platform holds for each, and the ending figure if their omitted payments
 * arrived at the last observed amount. Nothing here chooses which is right.
 */
function incompletenessBlock(income: IncomeCompleteness, closing: number) {
  // FIN-001: RECENTLY_SILENT / UNKNOWN streams are omitted exactly like AMOUNT_UNESTABLISHED ones.
  const omitted = income.streams.filter((l) => l.role === 'INCOME' && isOmittedLine(l) && l.material);
  return {
    omittedStreams: omitted.map((l) => ({
      stream: l.stream, occurrencesInHorizon: l.occurrencesInHorizon, countedAt: 0,
      lastObserved: l.lastObserved, omittedAtLastObserved: l.omittedAtLastObserved ?? null,
      status: l.status, silence: l.silence ?? null,
    })),
    endingCashIfOmittedArriveAtLastObserved: round2(closing + income.omittedAtLastObserved),
    meaning: '`endingCash` counts the streams above at $0: it is a LOWER BOUND for them, not the expected '
      + 'balance. Present it only together with `endingCashIfOmittedArriveAtLastObserved`, say which stream is '
      + 'not counted and why from its `status` (AMOUNT_UNESTABLISHED: its amount is not established; '
      + 'RECENTLY_SILENT: its latest scheduled payment has not arrived; UNKNOWN: the account\'s feed has not '
      + 'reached its due date), and quote its observed deposits. Do not ask the '
      + 'user for income the platform already holds — at most ask which level applies.',
  };
}

/** The qualification sentence, from what actually contributed — never a fixed claim about payroll. */
function projectionQualification(income: IncomeCompleteness | null): string {
  const counted = (income?.streams ?? []).filter((l) => l.role === 'INCOME' && l.counted > 0);
  const deviates = counted.filter((l) => l.status === 'PRESENT_LATEST_DEVIATES');
  const parts: string[] = [];
  parts.push(income?.status === 'INCOMPLETE'
    ? 'An INCOMPLETE estimate: at least one current income stream is not counted (its amount is not '
      + 'established, or a scheduled payment is late or not yet visible) and counts $0 in this '
      + 'figure (see `incomplete`). Do not present `endingCash` as the expected balance.'
    : 'An evidence-based estimate, not a guaranteed forecast.');
  parts.push(counted.length
    ? `Future income is projected from ${counted.length} income stream(s) at their established level and cadence`
      + ' (`recurringIncome`)'
    : 'No recurring income is counted in this figure');
  for (const l of deviates) {
    const d = l.latestDeviation!;
    parts.push(`the newest payment on ${l.stream} (${d.date}, ${d.amount}) is ${d.pctFromLevel}% from its `
      + `established level ${l.level} and is NOT treated as the new level; if it is, the ${l.counted} projected `
      + `payment(s) change the figure by ${l.ifLatestIsNewLevel?.total} (\`latestPaymentDeviates\`)`);
  }
  const minor = (income?.streams ?? []).filter((l) => isOmittedLine(l) && !l.material);
  if (minor.length) {
    parts.push(`${minor.length} minor stream(s) with no established amount are not counted (at most `
      + `${round2(minor.reduce((n, l) => n + (l.omittedAtLastObserved ?? 0), 0))} at their last observed amounts)`);
  }
  parts.push('investments and debt are held flat. Say so once; do not restate the strict-path refusal as a '
    + 'second answer.');
  return parts.join('; ').replace('.; ', '. ');
}

/** What each diffed basis field IS — `dailyRate` was read as a positive "drift" when it is spending. */
const BASIS_FIELD_MEANING = {
  dailyRate: 'average daily SPENDING (an outflow) — higher means the projection falls faster; never a drift or gain',
  incomeEvents: 'how many income payments the projection COUNTED — a count, not dollars',
  monthsAveraged: 'the complete months the spending rate averaged; a different count is a different measure',
  openingCash: 'the liquid cash (checking + savings) the projection started from',
  incomeProjected: 'projected income counted to the horizon, in dollars',
  outflowsProjected: 'dated obligations inside the horizon, in dollars',
} as const;

/**
 * An interval of the projection, as the model reads it.
 *
 * ⚠️ NOTHING IS COMPUTED HERE. The window, its clamp, its refusal and every
 * figure are the projection authority's (`projectCashInterval`, reached through
 * the forecast adapter); this rounds at the display edge and names the fields.
 * `{from, to, days}` are stated on every answer because an interval whose bounds
 * are implied is how two different windows end up compared.
 */
function presentInterval(
  i: ReturnType<typeof projectInterval>, requestedFrom: string, requestedTo: string,
) {
  if (!i) {
    return { unavailable: 'there is no evidence-based projection to take an interval of',
      requested: { from: requestedFrom, to: requestedTo } };
  }
  if (i.status === 'REFUSED') {
    return { unavailable: i.refusal, requested: { from: requestedFrom, to: requestedTo },
      instead: 'a period that has already happened is measured, not projected: use '
        + 'measure_flows (or get_spending / get_income) for it' };
  }
  return {
    from: i.fromISO, to: i.toISO, days: i.days,
    ...(i.clamped ? { requested: { from: i.clamped.requestedFromISO, to: requestedTo },
      clamped: i.clamped.reason } : {}),
    cashAtStart: { date: i.opening!.dateISO, amount: round2(i.opening!.cash) },
    cashAtEnd: { date: i.closing!.dateISO, amount: round2(i.closing!.cash) },
    // ⚠️ FROM THE TWO PRINTED BALANCES, so the figure reproduces from its operands.
    // Payroll settles at sub-cent precision (…645), so the rounded components can
    // sit a cent away from it; the balances are the figures a standalone run to
    // either date prints, and they are the ones this agrees with exactly.
    cashChange: round2(round2(i.closing!.cash) - round2(i.opening!.cash)),
    components: i.components.map((c) => ({ ...c, value: round2(c.value) })),
    incomeEventsCounted: i.eventsCounted,
    meaning: 'What the SAME projection puts inside this window: income and obligations dated '
      + '`from`..`to` inclusive, spending accrued over `days` days. `cashChange` = `cashAtEnd` − '
      + '`cashAtStart` (the balance at the close of the day before the window) = income − '
      + 'obligations − spending, to the cent of rounding. `projection.endingCash` is still the '
      + 'balance at `to`. Quote these; never difference two projections yourself.',
  };
}

const projectCash: ToolDefinition = {
  name: 'project_cash',
  // ⚠️ THE BOUNDARY BELONGS IN THE DESCRIPTION, NOT ONLY ON A PARAMETER. 54eb8e1
  // put "a one-off amount on a date is not part of this projection" on
  // `assumedMonthlySpending`, where a model choosing between tools never reads
  // it — and kept choosing this one for bonuses (5/5, then 8/10, then 9/10).
  // Measured A/B: moving that sentence up here, and saying plainly what
  // scenario_projection is for, took establishment from 0/5 to 5/5 on a bonus
  // and 2/5 to 5/5 on a car, with the ordinary-projection control unmoved.
  description:
    'Deterministic cash projection to a future date, with checkpoints along the way. The ' +
    'headline answer is `projection` — an evidence-based estimate built from observed ' +
    'payroll cadence and observed spending continuing as they are. ' +
    '`assumedMonthlySpending` is the only assumption it can apply; a dated one-off amount ' +
    'arriving or leaving is not part of this projection, and neither is a CHANGE TO FUTURE ' +
    'INCOME from a date — a raise, a new salary, an income starting or ending all belong to ' +
    'scenario_projection. `establishment` says how firmly ' +
    'each input is pinned down; it is provenance, not a competing answer. With `from` it ' +
    'also states what is projected to come in and go out INSIDE a future window. ' +
    // AI RELIABILITY (2026-10-16) — the income term is reported per stream; an
    // incomplete one is a bound, and the platform's own deposits are the evidence.
    '`basis.recurringIncome` says, per income stream, what was counted; when `kind` is ' +
    'INCOMPLETE_ESTIMATE a current stream counted $0 — present `endingCash` only beside ' +
    '`incomplete.endingCashIfOmittedArriveAtLastObserved`, and never ask the user for income it lists.',
  parameters: obj({
    to: str('YYYY-MM-DD horizon end. Required.'),
    // ⚠️ A WINDOW, NOT A YEAR. "How much will I spend during 2027?" took two
    // cumulative calls and a subtraction in prose (66,733.35 − 14,575.59). The
    // projection already owned both figures; what it lacked was a start. There is
    // deliberately no annual-spending special case here or anywhere: any future
    // `[from, to]` is the same fold over the same events at the same rate.
    from: str('YYYY-MM-DD, after today. Set it only when the question is about a future '
      + 'WINDOW rather than from now — "how much will I spend during 2027", "what comes in '
      + 'next quarter". The result adds `interval`: projected income, spending and '
      + 'obligations inside from..to (both dates inclusive) and the cash change across it. '
      + 'Never subtract two projections yourself. Omit for an ordinary projection.'),
    assumedMonthlySpending: num('If the user stated a monthly spending level, pass it here. '
      + 'It is the only user assumption this tool can apply. A one-off amount on a date — '
      + 'a bonus, an inheritance, a purchase, a sale — is not part of this projection.'),
    checkpoints: { type: 'string', enum: ['monthly', 'quarterly', 'yearly', 'none'],
      description: 'How often to report a balance between now and the horizon: monthly = '
        + 'every month-end, quarterly = every quarter-end, yearly = every 31 December; the '
        + 'horizon is always the last row. Omit for the default: none under ~45 days, then '
        + 'monthly within 18 months, quarterly to about 20 years, yearly beyond. A cadence '
        + 'that would exceed the row ceiling is returned one step coarser and the result says '
        + 'so under `horizon.requested` / `horizon.omitted`.' },
    asOf: str('Project FROM this date using only evidence available then. Omit for today. '
      + 'Use for "what would you have predicted back in January?".'),
    ignoreStaged: { type: 'boolean', description: 'Only when the user has stated a plan in this '
      + 'conversation AND asks for the current trend WITHOUT it.' },
  }, ['to']),
  async run(a, ctx) {
    const toISO = String(a.to);
    // ⚠️ THE CLOSED ARGUMENT SET REACHES THIS TOOL TOO (I1). The scenario tools
    // have refused an undeclared argument since the closed set existed; this one
    // never did, and the first I1 dogfood turn found the hole by walking into it:
    // asked "starting January my income increases 10%, what does that do to my
    // cash?", the model called project_cash with a well-formed `incomeChanges`
    // array. There was nothing to read it, so the raise was SILENTLY DROPPED and a
    // current-trend projection came back as the answer to a question about a
    // raise. A tool that cannot model a condition must say so, not compute
    // without it.
    // ⚠️ PRESENTATION KEYS ARE NOT REFUSED (review). `granularity` is the scenario
    // tools' table cadence — project_cash's own is `checkpoints` — and a model
    // carrying it over from a scenario call would otherwise lose the whole
    // projection over a field that changes no figure. Only a key that would have
    // CHANGED the answer is worth refusing the answer for.
    const rejected = refuseUnknownArguments(a, projectCash.parameters)
      .filter((r) => !r.argument || !NOT_AN_ASSUMPTION.includes(r.argument));
    // ⚠️ STAGED CONDITIONS ARE NOT DROPPED BY PICKING THE TOOL THAT CANNOT SEE THEM
    // (planning continuity). Measured: with a raise, a floor, a debt order and
    // "invest the rest" all staged, "what do I have next December?" called THIS
    // tool 6/6 and answered with the current trend — while saying, in the answer,
    // that none of the user's conditions were in it. It is the same failure as
    // `incomeChanges` sent here: a condition the user stated, computed without.
    // A retrospective run ("what would you have predicted in January?") is about
    // the past and is not affected; the current trend on purpose is one visible
    // flag away.
    // ⚠️ A REAL LOOK BACK, NOT A STRING THAT SORTS EARLIER (review). `a.asOf <
    // today` let `asOf: ""` (which then falls back to today) and yesterday walk past
    // the refusal with a current-trend run. "What would you have predicted in
    // January?" is at least a month back; anything nearer is the present.
    const retrospectiveRun = typeof a.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.asOf)
      && Date.parse(`${ctx.asOfISO}T00:00:00Z`) - Date.parse(`${a.asOf}T00:00:00Z`) >= 30 * 86_400_000;
    const staged = ctx.plan?.pending.clauses ?? [];
    // ⚠️ AND WHEN A SCENARIO HAS ALREADY RUN (measured 1/6): after the plan ran,
    // "what about next June?" came here and answered the plan's question with the
    // current trend. Pending is empty once a scenario runs, so the staged check
    // could not catch it. While a plan is in play in this conversation — staged or
    // run — its questions are answered with it; the current trend is one flag away.
    // FM-AUDIT-018 — a plan that could not be CARRIED to this turn is still in play:
    // answering its question from the current trend is exactly the silent failure
    // the continuity marker exists to prevent.
    const planInPlay = staged.length > 0 || ctx.plan?.scenarioRan === true || ctx.plan?.continuity !== undefined;
    if (planInPlay && a.ignoreStaged !== true && !retrospectiveRun && rejected.length === 0) {
      if (staged.length === 0 && ctx.plan?.scenarioRan !== true && ctx.plan?.continuity) {
        return { unavailable: 'the plan the user built earlier in this conversation could not be carried to '
            + 'this turn (it was too large), so it is NOT in force and this projection cannot apply it — it '
            + 'was NOT run',
          instead: 'tell the user the earlier plan was not carried forward, and re-run scenario_projection with '
            + 'every condition they want (ask them to restate what you cannot see). Only if they asked for the '
            + 'current trend WITHOUT their plan, call project_cash again with `ignoreStaged: true`, and say so.' };
      }
      if (staged.length === 0) {
        return { unavailable: 'a scenario the user built is under discussion in this conversation, and '
            + 'this projection cannot apply it, so it was NOT run',
          instead: 'answer with scenario_projection — the ACTIVE SCENARIO\'s arguments, at the horizon the '
            + 'user asked about. Only if they asked for the current trend WITHOUT their plan, call '
            + 'project_cash again with `ignoreStaged: true`, and say that is what it shows.' };
      }
      return { unavailable: `${staged.length} condition(s) the user stated earlier in this `
          + 'conversation are staged, and this projection cannot apply them, so it was NOT run',
        staged: staged.map((c) => ({ id: c.id, [c.key]: c.value })),
        instead: 'scenario_projection applies every staged condition by itself — call it with the '
          + 'horizon (`to`) and nothing else needs restating. Only if the user asked for the '
          + 'current trend WITHOUT their conditions, call project_cash again with '
          + '`ignoreStaged: true`, and say that is what it shows.' };
    }
    if (rejected.length > 0) {
      return { unavailable: 'this projection cannot carry what was stated, so it was NOT run',
        notApplied: notAppliedEcho(rejected),
        instead: 'project_cash continues the observed pattern and can assume only a monthly '
          + 'spending level. A change to future INCOME from a date — a raise, a new salary, an '
          + 'income starting or ending — is scenario_projection\'s `incomeChanges`; a dated change '
          + 'to SPENDING (a category cut, spending less from a date) is its `spendingChanges`; a '
          + 'one-off amount arriving or leaving is its `outflows`.' };
    }
    // When the user asked for the current trend on purpose, the answer says what
    // it left out — the staged conditions are theirs, and they are not in it.
    const leftOut = planInPlay && a.ignoreStaged === true && staged.length > 0
      ? { leftOutOnPurpose: { staged: staged.map((c) => ({ id: c.id, [c.key]: c.value })),
          meaning: 'The current trend, WITHOUT the conditions the user stated in this '
            + 'conversation — as they asked. Say so; these are still held.' } }
      : {};
    const spine = await buildCashSpine(ctx, {
      asOf: (a.asOf as string) || ctx.asOfISO,
      ...(typeof a.assumedMonthlySpending === 'number'
        ? { assumedMonthlySpending: a.assumedMonthlySpending }
        : {}),
    });
    if ('unavailable' in spine) return spine;
    const { asOf, retrospective, openingBasis, runTo } = spine;

    const f = runTo(toISO);
    const licensed = 'refused' in f.forecast ? null : f.forecast.fullCashPath;
    const userAssumed = f.appliedFacts.length > 0;
    // AI RELIABILITY (2026-10-16) — what the income term HOLDS, per stream. A current
    // income stream whose payments could not be priced counted $0 and used to leave
    // no trace but a grouped `excluded` note under a complete-looking estimate.
    const income: IncomeCompleteness | null = f.projection && f.projection.closing !== null
      ? incomeCompleteness({ streams: spine.streams, events: f.events,
          excludedIds: new Set(f.projection.excluded.map((x) => x.id)), fromISO: asOf, toISO,
          openingCash: f.projection.openingCash ?? 0 })
      : null;
    const incomplete = income?.status === 'INCOMPLETE';

    // ── Checkpoints ──────────────────────────────────────────────────────────
    //
    // ⚠️ EACH CHECKPOINT IS AN INDEPENDENT RUN FROM THE SAME `asOf`, never a
    // balance carried forward from the previous one. Compounding checkpoint on
    // checkpoint would accumulate rounding and — worse — would let a series drift
    // away from the endpoint the same authority produces for the same horizon.
    // Because every point is `projectCash(asOf → thatDate)`, the last checkpoint
    // IS the endpoint by construction, and a test pins it.
    //
    // ⚠️ THE DATES ARE PLANNED BY THE SAME AUTHORITY THE SCENARIO TABLE USES. A
    // thirty-year horizon was returning 364 month-ends — 112 KB the model then
    // carried in every later prompt — and no row said how far away it was. The
    // plan chooses the cadence (or honours the one asked for, thinned if it must
    // be, and says so); the values at the chosen dates are exactly what a monthly
    // run produces at those dates, because the spine is not the plan's to touch.
    const horizonDays = Math.round(
      (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
    const requested = CADENCES.includes(a.checkpoints as Cadence) ? a.checkpoints as Cadence : null;
    const wantCheckpoints = requested !== null
      || ((a.checkpoints as string) !== 'none' && horizonDays > 45);

    let checkpoints: unknown[] | undefined;
    let plan: CheckpointPlan | undefined;
    if (wantCheckpoints) {
      plan = planCheckpoints({ asOfISO: asOf, toISO, requested });
      let prevClosing: number | null = f.projection ? (f.projection.openingCash ?? null) : null;
      checkpoints = plan.dates.map((date) => {
        const run = runTo(date);
        const closing = run.projection?.closing ?? null;
        const delta = closing !== null && prevClosing !== null ? round2(closing - prevClosing) : null;
        prevClosing = closing;
        return { date, closingCash: closing === null ? null : round2(closing),
          changeSincePrevious: delta,
          // ⚠️ HOW FAR AWAY, IN THE ENGINE'S NUMBERS. A month-end read off this
          // list was narrated as "1 year and 5½ months" when it was five and a
          // half months out; the date was right and the subtraction was not.
          elapsed: elapsedBetween(asOf, date) };
      });
    }

    return {
      ...leftOut,
      horizon: { asOf, to: toISO, days: horizonDays, elapsed: elapsedBetween(asOf, toISO),
        ...(plan ? describePlan(plan) : { checkpoints: 0 }) },
      // ⚠️ A SIBLING OF THE ANSWER, NEVER A REPLACEMENT FOR IT. `projection.endingCash`
      // stays the cumulative balance at `to` and `horizon.to` stays `to`, whether or
      // not a window was asked for — those are the two fields the turn loop's silent
      // checkpoint copies, so a window's CHANGE cannot be recorded as a BALANCE.
      ...(typeof a.from === 'string' && a.from
        ? { interval: presentInterval(projectInterval(f, { fromISO: a.from, toISO }), a.from, toISO) }
        : {}),
      ...(retrospective ? { retrospective: true, openingBasis,
        meaning: `What this projection would have said standing at ${asOf}, using only `
          + 'evidence available then. Compare it with what actually happened; do not '
          + 'present it as a current expectation.' } : {}),
      openingCash: f.projection?.openingCash
        ?? ('refused' in f.forecast ? null : f.forecast.openingCash.amount),

      // ⚠️ THE ANSWER. Product decision (2026-09-07): for an ordinary conversational
      // projection the evidence-based estimate IS the answer when it is available.
      // The strict path's refusal qualifies it; it does not suppress it, and the two
      // are deliberately not presented as competing candidates.
      projection: f.projection && f.projection.closing !== null ? {
        endingCash: round2(f.projection.closing),
        kind: incomplete ? 'INCOMPLETE_ESTIMATE' : 'EVIDENCE_BASED_ESTIMATE',
        ...(incomplete && income ? { incomplete: incompletenessBlock(income, f.projection.closing) } : {}),
        ...(income && income.streams.some((l) => l.ifLatestIsNewLevel) ? {
          latestPaymentDeviates: income.streams.filter((l) => l.ifLatestIsNewLevel).map((l) => ({
            stream: l.stream, latest: l.latestDeviation, establishedLevel: l.level,
            endingCashIfLatestIsNewLevel: round2(f.projection!.closing! + l.ifLatestIsNewLevel!.total),
          })),
        } : {}),
        checkpoints,
        basis: {
          openingCash: f.projection.openingCash,
          spending: userAssumed
            ? { source: originOf(a, 'assumedMonthlySpending', ctx), statedAs: f.appliedFacts }
            : f.observedSpending
              ? { source: 'OBSERVED', dailyRate: f.observedSpending.dailyRate,
                  monthsAveraged: (f.observedSpending as { months?: string[] }).months ?? null }
              : { source: 'NONE' },
          // ⚠️ COUNTED MEANS COUNTED. This was `f.events.length` — every GENERATED
          // occurrence, priced or not — and said 12 beside an income term of $0.65.
          incomeEventsCounted: income?.incomeEventsCounted ?? 0,
          incomeEventsExcluded: income?.incomeEventsExcluded ?? 0,
          // AI RELIABILITY — the identity, term by term, as the engine folded it:
          // endingCash = openingCash + incomeProjected − outflowsProjected − spendingProjected.
          ...(f.projection.totals ? {
            incomeProjected: round2(f.projection.totals.inflow),
            outflowsProjected: round2(f.projection.totals.outflow),
            spendingProjected: round2(f.projection.totals.spend),
            identity: 'endingCash = openingCash + incomeProjected − outflowsProjected − spendingProjected '
              + '(spendingProjected = dailyRate × horizon days). dailyRate is SPENDING, an outflow.',
          } : {}),
          recurringIncome: income?.streams ?? [],
          // ⚠️ SAID WHERE THE FIGURE IS. This projection is cash only: an existing
          // liability is neither accrued nor paid down by it, and card purchases
          // already sit in the spending rate. A scenario tool moves liabilities.
          liabilities: 'not modelled here: existing balances are not accrued or paid down by '
            + 'this projection; use scenario_projection / scenario_crossing for dynamic debt',
          components: f.projection.components,
          assumptions: f.projection.assumptions,
          // ⚠️ GROUPED, NOT LISTED. One entry per unlicensed occurrence was 83 KB
          // over thirty years, all saying the same thing about the same streams.
          excluded: compactExcludedEvents(f.projection.excluded as { id: string; reason: string }[]),
          range: f.projection.range,
          ...(f.projection.range ? { rangeMeaning: 'the ending figure at the HIGHEST and LOWEST spending month of '
            + 'the averaging window — it varies SPENDING ONLY; income is the same in both ends'
            + (incomplete ? ', so it does NOT reflect the income stream(s) this estimate omits' : '') } : {}),
        },
        qualification: projectionQualification(income),
      } : null,

      // ⚠️ PROVENANCE, NOT A RIVAL ANSWER. Kept because its `missing` list is the
      // honest account of what is not established — a NET/GROSS basis per income
      // event, a current-normal spending level. Useful for describing confidence.
      establishment: {
        status: licensed?.status ?? 'UNAVAILABLE',
        strictEndingCash: licensed?.closing ?? null,
        notEstablished: licensed?.status === 'REFUSED' ? licensed.missing : [],
        meaning: 'What a strictly-licensed forecast would still need. It qualifies the '
          + 'estimate above and must not be offered as an alternative figure.',
      },

      unavailableReason: f.projection && f.projection.closing !== null ? null
        : (f.projection?.missing?.join('; ') ?? f.unavailable ?? 'no projection could be built'),
      appliedUserFacts: f.appliedFacts,
      policyAssumptions: f.policy.assumptions.map((p) => ({
        origin: p.origin, stance: p.stance, statedAs: p.statedAs,
      })),
    };
  },
};

// ── 11. Scenario projection and goal seek ────────────────────────────────────

/**
 * The checkpoint calendar — which dates a table has rows for — lives in
 * `scenario-checkpoints.ts`, pure and beside the ledger. `yearEndsBetween` and
 * the ceiling are re-exported above so existing callers are unmoved.
 */
/** Days per month, for turning an observed daily spending rate into a monthly one. */
const DAYS_PER_MONTH = 365 / 12;

/** What a caller may vary without restating the whole scenario. */
/**
 * A ledger as the scenario runner produced it, with the floor derivations THIS
 * run actually used (FM-AUDIT-011): at the base spending level they are the
 * setup's; at a transformed one (a goal-seek spending cut) they are re-resolved,
 * and every echo — the clause roster, the floor rule — reads these.
 */
type ScenarioRun = LedgerResult & { floorDerivations: FloorDerivation[]; spendingChanges?: SpendingChangeOutcome };

/** The floor derivations a ledger ran with (the setup's, for a plain LedgerResult). */
function floorDerivationsOf(setup: ScenarioSetup, ledger: LedgerResult | ScenarioRun): FloorDerivation[] {
  return (ledger as Partial<ScenarioRun>).floorDerivations ?? setup.floorDerivations;
}

/** S1 — what the spending rules did IN THIS RUN (a solve adds its own), else the setup's. */
function spendingOf(setup: ScenarioSetup, ledger: LedgerResult | ScenarioRun): SpendingChangeOutcome | undefined {
  return (ledger as Partial<ScenarioRun>).spendingChanges ?? setup.spendingChanges;
}

interface ScenarioOverrides {
  returns?:            ReturnPeriod[];
  extraContributions?: PlannedMovement[];
  /**
   * S1-7 — spending rules appended to the scenario's own for this run (a solver's
   * cut). They compose with every stated spending change; the derived floors are
   * re-resolved at the rate they leave on each date.
   */
  extraSpendingChanges?: SpendingChangeRule[];
}

/** A spending level that came from the arguments (said by the user or supplied by the model), not observed. */
const suppliedSpending = (source: string) => source === 'USER_STATED' || source === 'MODEL_SUPPLIED';

/** The origin of every figure-bearing argument the call (and any staged clause merged into it) gave. */
const ORIGIN_KEYS = ['assumedMonthlySpending', 'annualReturnPct', 'returns', 'contributions', 'outflows',
  'liabilityAssumptions', 'incomeChanges', 'spendingChanges'] as const;
function argumentOrigins(a: Record<string, unknown>, ctx: ToolContext): Partial<Record<string, Origin>> {
  const out: Partial<Record<string, Origin>> = {};
  for (const k of ORIGIN_KEYS) {
    const v = a[k];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = originOf(a, k, ctx);
  }
  // `annualReturnPct` and `returns` are one assumption: the returns in force.
  if (out.annualReturnPct || out.returns) {
    out.returnsInForce = out.annualReturnPct === ORIGIN.MODEL_SUPPLIED || out.returns === ORIGIN.MODEL_SUPPLIED
      ? ORIGIN.MODEL_SUPPLIED : ORIGIN.USER_STATED;
  }
  return out;
}

interface ScenarioSetup {
  asOf: string; toISO: string;
  /** Which dates the table carries and why — cadence, source, anything omitted. */
  plan: CheckpointPlan;
  dates: string[];
  accounts: AccountsSectionData;
  returns: ReturnPeriod[];
  contributions: PlannedMovement[];
  outflows: PlannedMovement[];
  /** The liabilities the ledger moves, built from the position and the stated assumptions. */
  liabilities: LiabilityLine[];
  rejected: RefusedInput[];
  /** The spending level the base run used, and where it came from. */
  monthlySpending: { amount: number | null; source: 'USER_STATED' | 'MODEL_SUPPLIED' | 'OBSERVED' | 'NONE' };
  /**
   * WHO SUPPLIED each direct scenario argument — USER_STATED only when the user's own words license
   * every figure in it (`argumentFiguresStated`), else MODEL_SUPPLIED. Absent ⇒ the argument was not given.
   */
  origins: Partial<Record<string, Origin>>;
  /** The canonical baseline behind an OBSERVED `monthlySpending` — which months, how many, net of refunds. */
  spendingBaseline: CanonicalSpendingBaseline;
  /** M1 — floors stated as months of expenses, with the derivation each resolved through. */
  floorDerivations: FloorDerivation[];
  /**
   * I1 — what the income rules DID, at the horizon this scenario ran to.
   *
   * ⚠️ FROM THE SPINE, NOT FROM `a.incomeChanges`. This is the endpoint run's own
   * record of the occurrences it altered. A rule that was stated and changed
   * nothing appears here with `ran: false` and a reason; a rule that was never
   * stated does not appear at all. Absent when none was stated.
   */
  incomeChanges?: IncomeChangeResult;
  /** S1-N1 — historical interest the spending rate left out because the ledger accrues it. */
  modelledInterest?: ModelledInterestExclusion;
  /**
   * S1 — what the spending rules did at the horizon this scenario ran to: the
   * spine's own record (never `a.spendingChanges`), and the user's word for each
   * rule's category where it differed from the line. Absent when none was stated.
   */
  spendingChanges?: SpendingChangeOutcome;
  spendingRequestedAs?: Record<string, string>;
  /**
   * Conditions staged earlier in this conversation that this run applied, and the
   * arguments as they actually ran. Absent when nothing was staged.
   */
  staged?: { applied: (Attribution & { value: unknown })[]; supersededByCall: { id: string; key: string }[] };
  /** The arguments this run executed — the call's, with any staged clauses merged in. */
  argumentsRun: Record<string, unknown>;
  run: (o?: ScenarioOverrides) => ScenarioRun;
  /** S1-7 — the spine's spending outcome with these extra rules (category rates, schedule), or null. */
  runProbe: (...extra: SpendingChangeRule[]) => (SpendingChangeOutcome & { applied: true }) | null;
}

/**
 * Everything both scenario tools need, resolved once.
 *
 * ⚠️ ONE SETUP, TWO TOOLS, FOR THE SAME REASON THERE IS ONE SPINE. A goal seek
 * that parsed its own contributions or opened from its own investment total
 * would eventually solve a slightly different scenario from the one it then
 * shows the user — and the number and the table beneath it would disagree while
 * both looked right. `scenario_goal_seek` solves over `run`, and then renders
 * the ledger `run` produced at the answer.
 */
/**
 * I1 — the tool's `incomeChanges` entries as the primitive's rules.
 *
 * ⚠️ IT MAPS AND VALIDATES NOTHING ELSE. Every question about whether a rule is
 * coherent — a multiplier of 1, a gross-or-net that was not stated, a period the
 * amount is not per, a cadence that cannot be started — belongs to
 * `invalidIncomeChange`, beside the transformation that would otherwise act on
 * the answer. A second opinion here is how two layers come to disagree about
 * which rules ran.
 *
 * ⚠️ NO UNIT IS DEFAULTED AND NO WORDING IS CARRIED. `per` is passed through
 * exactly as stated so a missing one is REFUSED rather than guessed, and nothing
 * the caller wrote in prose travels: `label` names a STARTed income (a thing),
 * and the sentence describing what a rule did is derived from its figures by
 * `income-change.ts`. This is the applied-facts invariant (54eb8e1), where a
 * caller's `statedAs` once rode a $15,000 bonus into a $4,346 spending figure.
 */
function toIncomeChangeRules(
  raw: unknown, declaredOk: (entry: Record<string, unknown>) => boolean,
  rejected: RefusedInput[],
): IncomeChangeRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: IncomeChangeRule[] = [];
  raw.forEach((entry, i) => {
    const name = `\`incomeChanges\` rule i${i + 1}`;
    if (!entry || typeof entry !== 'object') {
      rejected.push({ input: name, reason: 'an `incomeChanges` entry must be an object; nothing was applied for it.' });
      return;
    }
    const c = entry as Record<string, unknown>;
    if (!declaredOk(c)) return;

    // ⚠️ A FIELD OF THE WRONG TYPE IS REFUSED, NEVER DROPPED (review blocker 4).
    // Dropping `to: 20270301` because it was not a string ran the rule to the
    // horizon — a narrower window silently widened — and `source: 123` silently
    // became every income stream. Every declared field is checked here; `null`
    // means "not stated", as it does everywhere else in the scenario contract.
    const TYPES: Record<string, 'string' | 'number'> = {
      op: 'string', source: 'string', from: 'string', to: 'string', multiplier: 'number',
      amount: 'number', per: 'string', basis: 'string', cadence: 'string', label: 'string',
    };
    const wrong = Object.entries(TYPES)
      .filter(([k, t]) => c[k] !== undefined && c[k] !== null && typeof c[k] !== t)
      .map(([k, t]) => `\`${k}\` must be a ${t}`);
    if (wrong.length > 0) {
      rejected.push({ input: name, reason: `${wrong.join('; ')}, so this rule was NOT applied — `
        + 'running it without that field would turn it into a broader rule nobody stated.' });
      return;
    }
    const str = (k: string) => (typeof c[k] === 'string' && c[k] !== '' ? c[k] as string : undefined);
    const op = c.op as IncomeChangeOpKind;

    // ⚠️ A LABEL NAMES A NEW INCOME, AND NOTHING ELSE (review blocker 3). On a
    // SCALE, SET_RATE or STOP it names a stream that already has a name, so the
    // only thing it can carry is a sentence about the scenario — "the buffer is
    // kept and the cards are paid first" rode into the envelope beside a roster
    // saying neither ran.
    if (op !== 'START' && str('label') !== undefined) {
      rejected.push({ input: name, reason: '`label` names a NEW income and belongs only on START; '
        + 'this income already has a name. The rule was NOT applied — drop `label` and re-run.' });
      return;
    }

    // ⚠️ A RATE IS BUILT WHEREVER A RATE WAS STATED (review blocker 1). The first
    // fix for "a 10% net raise" built no rate for any SCALE, which let a SCALE
    // carrying `amount: 180000, per: YEAR` run as ×1.1 and drop the $180k without
    // a word. Now `amount` or `per` always builds a rate — so a SCALE carrying one
    // reaches the engine's refusal ("two answers to one question") — and `basis`
    // alone on a SCALE is the scaled income's basis, which is what it means there.
    const statesRate = c.amount !== undefined && c.amount !== null
      || c.per !== undefined && c.per !== null
      || (op !== 'SCALE' && c.basis !== undefined && c.basis !== null);
    rules.push({
      id: `i${i + 1}`,
      op,
      sourceKey: str('source') ?? null,
      fromISO: str('from') ?? '',
      ...(str('to') ? { toISO: str('to') } : {}),
      ...(typeof c.multiplier === 'number' ? { multiplier: c.multiplier } : {}),
      ...(statesRate
        ? { rate: {
          amount: typeof c.amount === 'number' ? c.amount : NaN,
          per: c.per as RatePeriodKind,
          basis: c.basis as NonNullable<IncomeChangeRule['rate']>['basis'],
        } }
        : {}),
      ...(op === 'SCALE' && !statesRate && str('basis')
        ? { basis: str('basis') as NonNullable<IncomeChangeRule['basis']> } : {}),
      ...(str('cadence') ? { cadence: str('cadence') as NonNullable<IncomeChangeRule['cadence']> } : {}),
      // Bounded, like every other caller name that reaches a result.
      ...(boundedLabel(c.label) ? { label: boundedLabel(c.label) as string } : {}),
    });
  });
  return rules;
}

/**
 * S1 — the tool's `spendingChanges` entries as the primitive's rules.
 *
 * ⚠️ THE CATEGORY IS RESOLVED HERE, BY THE VOCABULARY, AND A REFUSAL IS WHOLE.
 * "restaurants" is refused and Dining offered; "groceries" is refused and Dining
 * offered; Interest is refused and the debt model named. Nothing of a refused rule
 * runs — a narrower sentence never becomes a broader cut. Every other question
 * about a rule (a multiplier of 1, a DELTA of 0, a date order) belongs to
 * `invalidSpendingChange`, beside the transformation, as I1's do.
 */
function toSpendingChangeRules(
  raw: unknown, declaredOk: (entry: Record<string, unknown>) => boolean,
  rejected: RefusedInput[],
): { rules: SpendingChangeRule[]; requestedAs: Record<string, string> } {
  const rules: SpendingChangeRule[] = [];
  const requestedAs: Record<string, string> = {};
  if (!Array.isArray(raw)) return { rules, requestedAs };
  raw.forEach((entry, i) => {
    const id = `s${i + 1}`;
    const name = `\`spendingChanges\` rule ${id}`;
    if (!entry || typeof entry !== 'object') {
      rejected.push({ input: name, reason: 'a `spendingChanges` entry must be an object; nothing was applied for it.' });
      return;
    }
    const c = entry as Record<string, unknown>;
    if (!declaredOk(c)) return;
    const TYPES: Record<string, 'string' | 'number'> = {
      category: 'string', op: 'string', from: 'string', to: 'string', multiplier: 'number', monthly: 'number',
    };
    const wrong = Object.entries(TYPES)
      .filter(([k, t]) => c[k] !== undefined && c[k] !== null && typeof c[k] !== t)
      .map(([k, t]) => `\`${k}\` must be a ${t}`);
    if (wrong.length > 0) {
      rejected.push({ input: name, reason: `${wrong.join('; ')}, so this rule was NOT applied — running it `
        + 'without that field would turn it into a broader rule nobody stated.' });
      return;
    }
    let scope: SpendingChangeRule['scope'] = null;
    if (typeof c.category === 'string' && c.category.trim() !== '') {
      const res = resolveTransformableCategory(c.category);
      if (!res.ok) {
        rejected.push({ input: name, reason: res.unavailable });
        return;
      }
      scope = { category: res.category, class: res.class, meaning: res.meaning };
      if (res.requestedAs) requestedAs[id] = boundedLabel(res.requestedAs) ?? res.requestedAs;
    }
    rules.push({
      id, op: c.op as SpendingChangeRule['op'], scope,
      fromISO: typeof c.from === 'string' ? c.from : '',
      ...(typeof c.to === 'string' && c.to !== '' ? { toISO: c.to } : {}),
      ...(typeof c.multiplier === 'number' ? { multiplier: c.multiplier } : {}),
      ...(typeof c.monthly === 'number' ? { monthly: c.monthly } : {}),
    });
  });
  return { rules, requestedAs };
}

/**
 * The liabilities the scenario ledger moves: one line per full-visibility debt
 * account, with any stated `liabilityAssumptions` applied. THE one definition —
 * the ledger's lines and the spine's S1-N1 interest exclusion both read it, so a
 * liability cannot be "modelled" for one and not the other.
 */
function liabilityLinesOf(
  accounts: AccountsSectionData, stated: unknown,
  onRefuse: (r: RefusedInput) => void = () => {},
  declaredOk: (raw: Record<string, unknown>, name: string) => boolean = () => true,
): LiabilityLine[] {
  const liabilities: LiabilityLine[] = [];
  const rows = Array.isArray((accounts as { accounts?: unknown }).accounts)
    ? (accounts as { accounts: AccountSummaryItem[] }).accounts : [];
  for (const r of rows) {
    if (r.type !== 'debt' || r.visibilityLevel !== 'FULL') continue;
    const reporting = r.reportingBalance;
    const balance = typeof reporting === 'number' ? Math.max(0, reporting)
      : typeof r.amountOwed === 'number' ? r.amountOwed : Math.max(0, r.balance);
    const apr = typeof r.apr === 'number' ? r.apr : null;
    const minimumPayment = typeof r.minimumPayment === 'number' ? r.minimumPayment : null;
    liabilities.push({ id: r.id, label: r.name, balance: round2(balance), apr, minimumPayment,
      subtype: (r as { debtSubtype?: string | null }).debtSubtype ?? null,
      termsProvenance: { apr: apr === null ? 'UNKNOWN' : 'STATED',
        minimumPayment: minimumPayment === null ? 'UNKNOWN' : 'STATED' } });
  }
  for (const la of (Array.isArray(stated) ? stated as Record<string, unknown>[] : [])) {
    const id = String(la.liabilityId ?? la.id ?? '');
    if (!declaredOk(la, `liability assumption for ${id || '(no id)'}`)) continue;
    const line = liabilities.find((l) => l.id === id);
    if (!line) {
      onRefuse({ input: `liability assumption for ${id || '(no id)'}`,
        reason: 'no liability with that id is in this position; use an id from get_financial_snapshot' });
      continue;
    }
    if (la.apr !== undefined) {
      const apr = Number(la.apr);
      if (!Number.isFinite(apr) || apr < 0 || apr > 100) {
        onRefuse({ input: `assumed APR for ${line.label}`, reason: 'an APR is a percentage between 0 and 100' });
      } else { line.apr = apr; line.termsProvenance!.apr = 'USER_ASSUMED'; }
    }
    if (la.minimumPayment !== undefined) {
      const min = Number(la.minimumPayment);
      if (!Number.isFinite(min) || min < 0) {
        onRefuse({ input: `assumed minimum for ${line.label}`, reason: 'a minimum payment is zero or more' });
      } else { line.minimumPayment = min; line.termsProvenance!.minimumPayment = 'USER_ASSUMED'; }
    }
  }
  return liabilities;
}

/**
 * S1-N1 — the liabilities whose FUTURE interest the ledger accrues itself: every
 * line with a known rate (the ledger accrues ACT/365 on each of them; a line with
 * no rate accrues nothing and is reported as unmodelled). Their historical interest
 * is left out of ordinary spending so it is counted once.
 */
export function interestModelledLiabilityIds(lines: readonly LiabilityLine[]): string[] {
  return lines.filter((l) => l.apr !== null).map((l) => l.id);
}

async function prepareScenario(
  a: Record<string, unknown>, ctx: ToolContext, toISO: string,
  /** The calling tool: its `parameters` are the closed set of arguments this call may carry. */
  tool: Pick<ToolDefinition, 'parameters'>,
  /**
   * The checkpoint dates to evaluate, when the caller owns them.
   *
   * ⚠️ FOR A SEARCH, NOT FOR A TABLE. `scenario_crossing` walks month-ends to
   * find one date and returns none of them; granularity and the
   * MAX_SCENARIO_CHECKPOINTS trim exist to keep a READABLE table readable, and
   * applying them to a search would delete the answer — which is precisely how
   * the historical series used to lose the day it was asked about. Given a grid,
   * this uses it verbatim.
   */
  explicitDates?: string[],
): Promise<ScenarioSetup | { unavailable: string; reason?: unknown }> {
  // ── Staged conditions, merged in before anything reads the arguments ───────
  //
  // ⚠️ THE MEASURED FAILURE (planning continuity). Stated one bare turn at a time
  // — a raise, a floor, a debt order, where the rest goes — and then "what do I
  // have next December?", the scenario that ran contained all four 0/6. What the
  // user said was in prose, and the call carried whatever the model reassembled.
  // Staged clauses are laid over the call by IDENTITY; whatever ran is reported
  // clause by clause as `EARLIER_IN_CONVERSATION`, and a call item a staged
  // restatement replaced is named. Remembered memory is never merged: there is no
  // path from it to here.
  let staged: ScenarioSetup['staged'];
  if (ctx.plan && ctx.plan.pending.clauses.length > 0) {
    const m = mergeIntoArgs(ctx.plan.pending, a);
    a = m.args;
    staged = { applied: m.applied, supersededByCall: m.supersededByCall };
  }

  // ── The closed argument set, read off the tool's own schema ────────────────
  //
  // ⚠️ THIS RAN AFTER THE SPINE WAS BUILT, AND I1 MOVED IT. Everything below
  // reads the keys it knows; nothing looked at the rest, so a premature or
  // misspelt argument (`contribution`, `floor`) ran the scenario WITHOUT that
  // clause and echoed nothing. `additionalProperties: false` only asks the
  // provider to stop it. The schema the model was shown is the one literal: an
  // undeclared argument, or an undeclared key on an array entry, is refused by
  // name (`scenario-rules`), and the echo carries it on every path.
  //
  // It is FIRST now because `incomeChanges` changes the spine, so the rules have
  // to be read and refused before there is a spine to change.
  const rejected: RefusedInput[] = [...refuseUnknownArguments(a, tool.parameters)];
  const declared = (arrayKey: string, name: string, alsoRead?: string[]) => (raw: Record<string, unknown>): boolean => {
    const refusal = refuseUnknownItemKeys(raw, tool.parameters, arrayKey, name, alsoRead);
    if (refusal) rejected.push(refusal);
    return !refusal;
  };

  const incomeChanges = toIncomeChangeRules(
    a.incomeChanges, declared('incomeChanges', 'an `incomeChanges` entry'), rejected);
  const spending = toSpendingChangeRules(
    a.spendingChanges, declared('spendingChanges', 'a `spendingChanges` entry'), rejected);

  const spine = await buildCashSpine(ctx, {
    asOf: ctx.asOfISO,
    ...(typeof a.assumedMonthlySpending === 'number'
      ? { assumedMonthlySpending: a.assumedMonthlySpending }
      : {}),
    ...(incomeChanges.length > 0 ? { incomeChanges } : {}),
    // S1-N1 — the SAME liability lines the ledger is about to accrue on, so the
    // interest it models is the interest the spending rate leaves out.
    interestModelledOn: (acc) => interestModelledLiabilityIds(liabilityLinesOf(acc, a.liabilityAssumptions)),
    ...(spending.rules.length > 0 ? { spendingChanges: spending.rules } : {}),
  });
  if ('unavailable' in spine) return spine;
  const { asOf, runTo, accounts, spendingBaseline } = spine;
  if (!accounts) return absentIn(ctx, 'no accounts in scope', 'any accounts in scope');
  if (toISO <= asOf) {
    return { unavailable: `the horizon ${toISO} is not in the future; a scenario needs a `
      + 'date after today' };
  }

  // ⚠️ THE INVESTMENT POT COMES FROM THE CANONICAL COMPOSER, NOT FROM A SUM
  // HERE. Traditional investments and digital assets are disjoint by
  // construction; when either is withheld the composer returns null, and a
  // ledger that treated null as zero would grow a hole at 8% a year.
  const composition = composeInvestments(accounts);
  if (!composition || composition.combined === null) {
    return { unavailable: 'the investment total cannot be stated for this Space, so a '
      + 'scenario over it would be arithmetic on an unknown',
      reason: composition?.withheldReason ?? 'no investment accounts in scope' };
  }

  const endpoint = runTo(toISO);

  // ── I1 — what the income rules did, and what they refused ─────────────────
  //
  // ⚠️ THE REFUSALS JOIN THE ECHO, AND THE WHOLE ARGUMENT IS FORGOTTEN ONLY WHEN
  // NOTHING IN IT RAN. A partly-refused array is kept: the rules that ran are
  // still the scenario, and the refused one is refused identically on every
  // replay, visibly. Naming `incomeChanges` as the refused ARGUMENT when only
  // some entries failed would delete the user's working clauses along with the
  // broken one.
  const incomeRejected = endpoint.incomeChanges?.rejected ?? [];
  // Stated entries = those the engine saw plus those the mapper refused before it.
  const statedEntries = Array.isArray(a.incomeChanges) ? a.incomeChanges.length : 0;
  const allRefused = statedEntries > 0 && incomeRejected.length === incomeChanges.length;
  for (const r of incomeRejected) rejected.push({ input: r.input, reason: r.reason });
  // Refusals from BOTH layers — the mapper's type and label checks, and the
  // engine's — mark the argument as unapplied only when nothing in it ran.
  if (allRefused) {
    for (const r of rejected) if (r.input.startsWith('`incomeChanges` rule')) r.argument = 'incomeChanges';
  }

  // ── S1 — what the spending rules did, and what they refused ────────────────
  //
  // Same shape as I1 above: the engine's refusals join the echo; the whole argument
  // is marked unapplied only when nothing in it ran — or when the projection that
  // would apply them did not run at all, which the outcome says in its own words.
  const spendingOutcome = endpoint.spendingChanges;
  if (spendingOutcome) {
    const stated = Array.isArray(a.spendingChanges) ? a.spendingChanges.length : 0;
    if (spendingOutcome.applied) {
      for (const r of spendingOutcome.rejected) rejected.push({ input: r.input, reason: r.reason });
      if (stated > 0 && spendingOutcome.executions.length === 0) {
        for (const r of rejected) if (r.input.startsWith('`spendingChanges` rule')) r.argument = 'spendingChanges';
      }
    } else {
      rejected.push({ input: '`spendingChanges`', reason: spendingOutcome.reason, argument: 'spendingChanges' });
    }
  } else if (Array.isArray(a.spendingChanges) && a.spendingChanges.length > 0 && spending.rules.length === 0) {
    // Every entry was refused before the spine (a subset word, an unsupported line).
    for (const r of rejected) if (r.input.startsWith('`spendingChanges` rule')) r.argument = 'spendingChanges';
  }

  // The spine's own opening balance — checking plus savings. Named `liquid`
  // below for the same reason nothing in the result is named `cash`.
  const openingLiquid = endpoint.projection?.openingCash
    ?? ('refused' in endpoint.forecast ? null : endpoint.forecast.openingCash.amount);
  if (openingLiquid === null) {
    return { unavailable: 'no opening cash balance could be established, so nothing can be '
      + 'projected from it',
      reason: endpoint.projection?.missing?.join('; ') ?? endpoint.unavailable };
  }

  // ⚠️ THE DATES ARE PLANNED, NOT CLAMPED. A caller-owned grid (the crossing
  // search) is used verbatim; a table's cadence is chosen, thinned to fit the
  // ceiling if it must be, and the plan says what was asked, what was returned
  // and which dates fell out — so a row that is not there is a row the reader
  // was told is not there.
  const requested = CADENCES.includes(a.granularity as Cadence) ? a.granularity as Cadence : null;
  const plan: CheckpointPlan = explicitDates
    ? { cadence: 'monthly', source: 'REQUESTED', requested: 'monthly', dates: explicitDates }
    : planCheckpoints({ asOfISO: asOf, toISO, requested });
  const dates = plan.dates;

  // ── The stated assumptions, normalised ─────────────────────────────────────
  // ⚠️ THE SPENDING LEVEL THIS SCENARIO RUNS AT, RESOLVED BEFORE THE RULES THAT
  // MAY DEPEND ON IT. "Keep six months of expenses" multiplies this figure, so
  // the floor and the spending in force are one number by construction.
  const observedDaily = endpoint.observedSpending?.dailyRate ?? null;
  const monthlySpending: ScenarioSetup['monthlySpending'] =
    typeof a.assumedMonthlySpending === 'number'
      ? { amount: a.assumedMonthlySpending, source: originOf(a, 'assumedMonthlySpending', ctx) as 'USER_STATED' | 'MODEL_SUPPLIED' }
      : observedDaily !== null
        ? { amount: round2(observedDaily * DAYS_PER_MONTH), source: 'OBSERVED' }
        : { amount: null, source: 'NONE' };
  const floorDerivations: FloorDerivation[] = [];

  const flatPct = typeof a.annualReturnPct === 'number' ? a.annualReturnPct : 0;
  const statedReturns = ((a.returns as Record<string, unknown>[]) ?? [])
    .filter((r) => declared('returns', `return ${String(r.annualPct)}% ${String(r.from)}..${String(r.to)}`)(r));
  // ⚠️ ONE SOURCE OF RETURNS, NOT TWO BLENDED. Per-period rates are the whole
  // truth when given; a flat rate filling their gaps would apply a number the
  // user only meant for the years they named.
  const returns: ReturnPeriod[] = statedReturns.length > 0
    ? statedReturns.map((r) => ({ fromISO: String(r.from), toISO: String(r.to),
        annualPct: Number(r.annualPct) }))
    : flatPct === 0 ? []
    : [{ fromISO: asOf, toISO, annualPct: flatPct }];

  const contribSpecs: ContributionSpec[] = [];
  for (const raw of (a.contributions as Record<string, unknown>[]) ?? []) {
    // ⚠️ THE NAME IS CODE'S, NEVER THE CALLER'S SENTENCE (G5). A rule's `label` was
    // free text that rode into every settled movement and into the envelope, and
    // it said "after keeping 6 months of expenses" over a surplus share that kept
    // nothing. The name is now derived from the basis that sized the rule; only a
    // fixed amount keeps its caller's name, quoted and bounded (`scenario-rules`).
    const name = contributionName(raw);
    // ⚠️ A CLOSED KEY SET. A key the contract does not define is a clause it cannot
    // represent; running the rest of the rule without it would be the silent
    // approximation the evidence rule forbids, so the rule is refused by name.
    const unknown = unknownContributionKeys(raw);
    if (unknown.length > 0) {
      rejected.push({ input: name,
        reason: `the contribution carries ${unknown.map((k) => `\`${k}\``).join(', ')}, which is not a `
          + 'field of this contract, so that condition cannot be applied and the rule was NOT run '
          + 'without it. Express it with the fields that exist, or tell the user it cannot be modelled.' });
      continue;
    }
    // ⚠️ M1 — "N MONTHS OF EXPENSES" BECOMES THE FLOOR LITERAL HERE, NOT IN THE
    // MODEL AND NOT IN THE LEDGER. The threshold is resolved through the canonical
    // expense-baseline authority from the scenario's own spending level, and the
    // dollar amount then feeds the EXISTING `liquidFloor` rule unchanged — the
    // ledger never learns the floor was derived. Its identity travels beside it
    // (`floorDerivations` → `floorRule.derivedFrom`) so the answer can say "six
    // months of expenses", and a later "make it nine" re-runs the same sentence.
    let c = raw;
    if (raw.liquidFloorMonthsOfExpenses !== undefined) {
      const what = name;
      if (raw.liquidFloor !== undefined) {
        rejected.push({ input: what, reason: 'state the floor ONCE: `liquidFloor` in dollars or '
          + '`liquidFloorMonthsOfExpenses` in months, not both' });
        continue;
      }
      const floor = resolveMonthsOfExpensesFloor({
        monthsOfExpenses: Number(raw.liquidFloorMonthsOfExpenses),
        stated: suppliedSpending(monthlySpending.source) ? monthlySpending.amount : null,
        observedMonthly: monthlySpending.source === 'OBSERVED' ? monthlySpending.amount : null,
      });
      if ('unavailable' in floor) { rejected.push({ input: what, reason: floor.unavailable }); continue; }
      floorDerivations.push(floor);
      const { liquidFloorMonthsOfExpenses: _months, ...rest } = raw;
      void _months;
      // FM-AUDIT-011 — the literal travels WITH its dependency, so a run at another
      // spending level re-resolves it instead of keeping this one.
      c = { ...rest, liquidFloor: floor.liquidFloor, floorMonthsOfExpenses: floor.derivedFrom.monthsOfExpenses };
    }
    const label = name;
    // How much: a dollar amount, or a share of the balance. The ledger refuses
    // both and neither; this only passes through what was said.
    // ⚠️ EVERY BASIS THE MODEL STATED TRAVELS, so a rule naming two of them is
    // refused by the ledger — the one authority on that — rather than trimmed to
    // one of them here. The floor pair rides along for the same reason.
    // ⚠️ WHERE THE MONEY GOES, NORMALISED ONCE. The model states a target as a
    // word (`investments`, `highest_apr`) or a liability id, singly or as an
    // ordered list; the ledger takes `{ liability: id }` objects. Anything else
    // is passed through so the ledger refuses it by name.
    const toTarget = (t: unknown): AllocationTarget => {
      if (isAllocationTargetWord(t)) return t;
      if (typeof t === 'string') return { liability: t };
      if (t && typeof t === 'object' && typeof (t as { liability?: unknown }).liability === 'string') {
        return { liability: (t as { liability: string }).liability };
      }
      return t as AllocationTarget;
    };
    const target = c.target === undefined ? {}
      : { target: Array.isArray(c.target) ? c.target.map(toTarget) : toTarget(c.target) };
    const size = {
      ...target,
      ...(c.amount !== undefined ? { amount: Number(c.amount) } : {}),
      ...(c.fractionOfLiquid !== undefined
        ? { fractionOfLiquid: Number(c.fractionOfLiquid) } : {}),
      ...(c.liquidFloor !== undefined ? { liquidFloor: Number(c.liquidFloor) } : {}),
      ...(c.fractionOfExcess !== undefined
        ? { fractionOfExcess: Number(c.fractionOfExcess) } : {}),
    };
    // ⚠️ A SURPLUS SHARE IS ITS OWN SHAPE, NOT A SIZE ON A SCHEDULE. It carries
    // no cadence and no single date; the ledger generates its month-ends. Anything
    // else stated alongside it is passed through untouched so that a rule naming
    // two bases is REJECTED by the one authority that decides that, rather than
    // silently resolved into one of them here.
    if (c.surplusFraction !== undefined) {
      contribSpecs.push({ surplusFraction: Number(c.surplusFraction), ...size,
        ...(c.onDate ? { onDate: String(c.onDate) } : {}),
        ...(c.from ? { from: String(c.from) } : {}),
        ...(c.to ? { to: String(c.to) } : {}),
        ...(c.cadence ? { cadence: String(c.cadence) === 'yearly' ? 'yearly' : 'monthly' } : {}),
        ...(label ? { label } : {}) } as unknown as ContributionSpec);
      continue;
    }
    // ⚠️ A FLOOR RULE IS ITS OWN SHAPE TOO: a balance read at every month-end,
    // no cadence, no single date. `from`/`to` only trim the window.
    if (c.liquidFloor !== undefined || c.fractionOfExcess !== undefined) {
      contribSpecs.push({ ...size,
        ...(c.from ? { from: String(c.from) } : {}),
        ...(c.to ? { to: String(c.to) } : {}),
        // FM-AUDIT-011 — the derived floor's dependency MUST survive this rebuild,
        // or `run()` has nothing to re-resolve (the composition contract caught
        // exactly that: a solved spending cut still echoed the uncut floor).
        ...(typeof c.floorMonthsOfExpenses === 'number' ? { floorMonthsOfExpenses: c.floorMonthsOfExpenses } : {}),
        ...(label ? { label } : {}) } as unknown as ContributionSpec);
      continue;
    }
    if (c.onDate) {
      contribSpecs.push({ onDate: String(c.onDate), ...size, ...(label ? { label } : {}) });
    } else if (c.from && c.cadence) {
      contribSpecs.push({ from: String(c.from), ...size,
        cadence: String(c.cadence) === 'yearly' ? 'yearly' : 'monthly',
        ...(c.to ? { to: String(c.to) } : {}), ...(label ? { label } : {}) });
    } else {
      rejected.push({ input: label ?? 'a contribution',
        reason: 'needs either `onDate`, or `from` together with `cadence`' });
    }
  }
  const expanded = expandContributions(contribSpecs, asOf, toISO);
  rejected.push(...expanded.rejected);

  const outflows: PlannedMovement[] = [];
  for (const o of (a.outflows as Record<string, unknown>[]) ?? []) {
    const amount = Number(o.amount);
    const date   = String(o.onDate);
    // The name is led by what code knows; the caller's words follow, quoted and bounded.
    const label  = outflowName(o);
    if (!declared('outflows', `${label} on ${date}`)(o)) continue;
    if (!Number.isFinite(amount) || amount === 0) {
      rejected.push({ input: `${label} on ${date}`, reason: 'the amount is zero or not a number' });
    } else if (date < asOf || date > toISO) {
      rejected.push({ input: `${label} on ${date}`,
        reason: `outside the projection window (${asOf}..${toISO})` });
    } else {
      outflows.push({ date, amount, label });
    }
  }

  // ⚠️ WHAT IS NOT CASH, NOT AN INVESTMENT AND NOT A DEBT STILL COUNTS. On this
  // Space the residual is a rounding cent; on a Space with a house it is the
  // house, and a five-year net-worth table that quietly dropped it would be
  // wrong by six figures while looking perfectly consistent.
  const otherAssets = round2(
    (accounts.totalAssets ?? 0) - (accounts.totalLiquid ?? 0) - composition.combined);
  // ── The liabilities the ledger moves ───────────────────────────────────────
  //
  // ⚠️ ONE LINE PER FULL-VISIBILITY DEBT ACCOUNT, FROM THE SAME PAYLOAD THE
  // POSITION IS READ FROM. The balance is `amountOwed` (a card in credit opens
  // at 0), the terms are the assembler's effective terms — DebtProfile over the
  // flat column, resolved once in `lib/debt/effective-terms.ts` — and nothing is
  // estimated. A withheld account is not a line: it stays inside the aggregate
  // the ledger holds flat, so it counts without being named.
  //
  // ⚠️ A STATED ASSUMPTION OVERRIDES A TERM FOR THIS SCENARIO ONLY. The account
  // is not touched; the line says the term was USER_ASSUMED; an id that is not
  // a liability the viewer can see is refused by name.
  const liabilities = liabilityLinesOf(accounts, a.liabilityAssumptions, (r) => rejected.push(r),
    (la, name) => declared('liabilityAssumptions', name, ['id'])(la));

  const opening = { asOfISO: asOf, liquid: openingLiquid, investments: composition.combined,
    debt: accounts.totalLiabilities ?? 0, otherAssets, liabilities };

  const checkpointDates = new Set(dates);
  // ⚠️ THE SPINE IS MEMOISED PER SPENDING LEVEL, WHICH IS WHAT MAKES A SOLVE
  // CHEAP. Varying a return or a contribution changes nothing about projected
  // cash, so eighty bisection steps re-use one set of runs; only a spending cut
  // pays for a rebuild, and even then `assembleForecast` is pure.
  const spineCache = new Map<string, SpinePoint[]>();
  const extraKey = (extra?: readonly SpendingChangeRule[]) => (extra && extra.length ? JSON.stringify(extra) : 'base');
  const spineFor = (shareDates: string[], extra?: readonly SpendingChangeRule[]): SpinePoint[] => {
    const key = `${extraKey(extra)}|${shareDates.join(',')}`;
    const hit = spineCache.get(key);
    if (hit) return hit;
    const allDates = [...new Set([...dates, ...shareDates])].sort();
    const points = allDates.map((date) => ({
      date, liquid: runTo(date, extra).projection?.closing ?? null,
      isCheckpoint: checkpointDates.has(date),
    }));
    spineCache.set(key, points);
    return points;
  };

  // S1-5 — the spending schedule a run at this spending level spends by (null when
  // no spending rule applied), from the spine's own endpoint run — memoised like it.
  const outcomeCache = new Map<string, SpendingChangeOutcome | undefined>();
  const outcomeFor = (extra?: readonly SpendingChangeRule[]) => {
    const key = extraKey(extra);
    if (!outcomeCache.has(key)) outcomeCache.set(key, runTo(toISO, extra).spendingChanges);
    return outcomeCache.get(key);
  };
  const scheduleFor = (extra?: readonly SpendingChangeRule[]) => {
    const out = outcomeFor(extra);
    return out && out.applied && out.executions.some((x) => x.affectedProjection) ? out.schedule : null;
  };

  return {
    asOf, toISO, plan, dates, accounts, returns, liabilities,
    contributions: expanded.movements, outflows, rejected, monthlySpending, spendingBaseline, floorDerivations,
    ...(endpoint.incomeChanges ? { incomeChanges: endpoint.incomeChanges } : {}),
    ...(endpoint.modelledInterest ? { modelledInterest: endpoint.modelledInterest } : {}),
    ...(spendingOutcome ? { spendingChanges: spendingOutcome, spendingRequestedAs: spending.requestedAs } : {}),
    ...(staged ? { staged } : {}),
    argumentsRun: a,
    origins: argumentOrigins(a, ctx),
    run: (o: ScenarioOverrides = {}): ScenarioRun => {
      // ⚠️ FM-AUDIT-011 — A DERIVED VALUE RECOMPUTES WHEN ITS DEPENDENCY CHANGES.
      // A floor stated as "N months of expenses" was resolved above from the BASE
      // spending level. A run at a different level (a goal-seek spending cut; S1's
      // spending transforms next) re-resolves every bound floor through the SAME
      // canonical resolver at the level THIS run spends — so "cut $X" never holds
      // six months of the uncut figure in cash. An absolute dollar floor has no
      // binding and is never touched.
      // ⚠️ S1-5 — AND WHEN SPENDING CHANGES OVER THE HORIZON, THE DEPENDENCY IS A
      // FUNCTION OF THE DATE. "Keep nine months of expenses" held at a month-end
      // after a January Dining cut is nine months of the CUT spending; before it,
      // nine months of the old. The rate in force on each floor movement's date is
      // read off the SAME spine run the ledger settles against (this run's spending
      // level, this run's schedule), never recomputed here.
      const schedule = scheduleFor(o.extraSpendingChanges);
      const baseLevel = monthlySpending.amount;
      const rebound = schedule && baseLevel !== null
        ? rebindDerivedFloorsByDate(expanded.movements, (d) => monthlyRateAt(schedule, baseLevel, d), monthlySpending, floorDerivations)
        : rebindDerivedFloors(expanded.movements, undefined, monthlySpending, floorDerivations);
      if ('unavailable' in rebound) {
        throw new Error(`a derived floor could not be re-resolved: ${rebound.unavailable}`);
      }
      const useContribs = o.extraContributions
        ? [...rebound.movements, ...o.extraContributions] : rebound.movements;
      // ⚠️ SHARE-BASED CONTRIBUTIONS NEED THE PROJECTION ON THEIR OWN DATE. "Half
      // my liquidity every June" falls nowhere near a year end, and half of a
      // balance the ledger cannot see is not something to guess at. Those dates
      // are evaluated too and marked as not being rows in the table.
      // ⚠️ A SURPLUS SHARE NEEDS BOTH ENDS OF ITS MONTH. The contribution date
      // closes the month and `baseDate` opens it; a month whose opening balance
      // the spine cannot show is a month whose surplus cannot be stated, and the
      // settler refuses it rather than inferring a neighbour from whatever else
      // happens to be in the spine.
      // ⚠️ A LIABILITY MOVES MONTHLY WHATEVER THE TABLE'S CADENCE. Interest and
      // minimums settle on spine dates, so a yearly table over an owed balance
      // still evaluates every month-end — otherwise the same scenario would
      // accrue differently depending on how often it was asked to print a row.
      const shareDates = [
        ...useContribs
          .filter((m) => m.fractionOfLiquid !== undefined || m.surplusFraction !== undefined
            || m.liquidFloor !== undefined)
          .flatMap((m) => (m.baseDate ? [m.baseDate, m.date] : [m.date])),
        ...(liabilities.some((l) => l.balance > 0) ? monthEndsBetween(asOf, toISO) : []),
      ].sort();
      return {
        ...runScenarioLedger({
          opening,
          spine: spineFor(shareDates, o.extraSpendingChanges),
          contributions: useContribs,
          outflows,
          returns: o.returns ?? returns,
        }),
        floorDerivations: rebound.derivations,
        ...(o.extraSpendingChanges && o.extraSpendingChanges.length > 0 && outcomeFor(o.extraSpendingChanges)
          ? { spendingChanges: outcomeFor(o.extraSpendingChanges) } : {}),
      };
    },
    runProbe: (...extra: SpendingChangeRule[]) => {
      const out = outcomeFor(extra);
      return out && out.applied ? out : null;
    },
  };
}

/**
 * FM-AUDIT-011 — re-resolve every DERIVED floor (a movement carrying
 * `floorMonthsOfExpenses`) at the spending level a run uses. At the base level
 * (no override, or the same figure) nothing changes. Otherwise each bound floor
 * is resolved again through `resolveMonthsOfExpensesFloor` with the transformed
 * level on the SAME rung the base came from (stated or observed), and the
 * derivation says so. Pure; the input movements are never mutated.
 */
export function rebindDerivedFloors(
  movements: readonly PlannedMovement[],
  runMonthlySpending: number | undefined,
  base: { amount: number | null; source: string },
  baseDerivations: FloorDerivation[],
): { movements: PlannedMovement[]; derivations: FloorDerivation[] } | { unavailable: string } {
  if (runMonthlySpending === undefined || runMonthlySpending === base.amount) {
    return { movements: [...movements], derivations: baseDerivations };
  }
  const byMonths = new Map<number, FloorDerivation>();
  for (const n of new Set(movements.map((m) => m.floorMonthsOfExpenses).filter((x): x is number => x !== undefined))) {
    const d = resolveFloorAt(n, runMonthlySpending, base, baseDerivations);
    if ('unavailable' in d) return d;
    byMonths.set(n, { ...d, derivedFrom: { ...d.derivedFrom, baseline: { ...d.derivedFrom.baseline,
      note: `${d.derivedFrom.baseline.note} — re-resolved at the ${round2(runMonthlySpending)}/month this run `
        + `spends (the scenario's ${suppliedSpending(base.source) ? 'supplied' : 'observed'} level after its transformation)` } } });
  }
  if (byMonths.size === 0) return { movements: [...movements], derivations: baseDerivations };
  return {
    movements: movements.map((m) => (m.floorMonthsOfExpenses === undefined ? m
      : { ...m, liquidFloor: byMonths.get(m.floorMonthsOfExpenses)!.liquidFloor })),
    derivations: [...byMonths.values()],
  };
}

/**
 * N months of expenses at one spending level, on the rung the scenario's base came
 * from — the ONE resolution both rebinds share.
 */
function resolveFloorAt(
  n: number, level: number, base: { amount: number | null; source: string }, baseDerivations: FloorDerivation[],
): FloorDerivation | { unavailable: string } {
  if (level <= 0) {
    // N months of NOTHING is a zero floor — arithmetic, not a baseline (the
    // canonical resolver refuses a non-positive baseline, which is right for a
    // baseline and wrong here: a solve's bracket reaches "cut everything").
    const was = baseDerivations.find((b) => b.derivedFrom.monthsOfExpenses === n);
    if (!was) return { unavailable: `no base derivation for ${n} months of expenses` };
    return { liquidFloor: 0, derivedFrom: { ...was.derivedFrom, rule: `${n} × 0`,
      baseline: { ...was.derivedFrom.baseline, amount: 0,
        note: 'this run spends nothing, so N months of expenses is zero' } } };
  }
  return resolveMonthsOfExpensesFloor({
    monthsOfExpenses: n,
    stated: suppliedSpending(base.source) ? level : null,
    observedMonthly: suppliedSpending(base.source) ? null : level,
  });
}

/**
 * S1-5 — every DERIVED floor at the spending in force ON ITS OWN DATE. The same
 * canonical resolver as `rebindDerivedFloors`, on the same rung, once per distinct
 * (months, level); each derivation says the first date its level governs. An
 * absolute floor carries no binding and is never touched. Pure.
 */
export function rebindDerivedFloorsByDate(
  movements: readonly PlannedMovement[],
  rateAt: (dateISO: string) => number,
  base: { amount: number | null; source: string },
  baseDerivations: FloorDerivation[],
): { movements: PlannedMovement[]; derivations: FloorDerivation[] } | { unavailable: string } {
  const byKey = new Map<string, FloorDerivation>();
  const derivations: FloorDerivation[] = [];
  const out: PlannedMovement[] = [];
  for (const m of movements) {
    if (m.floorMonthsOfExpenses === undefined) { out.push(m); continue; }
    const n = m.floorMonthsOfExpenses;
    const level = rateAt(m.date);
    const key = `${n}|${level}`;
    let d = byKey.get(key);
    if (!d) {
      const got = resolveFloorAt(n, level, base, baseDerivations);
      if ('unavailable' in got) return got;
      d = { ...got, derivedFrom: { ...got.derivedFrom, inForceFrom: m.date,
        baseline: { ...got.derivedFrom.baseline, note: `${got.derivedFrom.baseline.note} — at the `
          + `${round2(level)}/month this scenario spends from ${m.date} (its spending changes in force)` } } };
      byKey.set(key, d);
      derivations.push(d);
    }
    out.push({ ...m, liquidFloor: d.liquidFloor });
  }
  return { movements: out, derivations: derivations.length > 0 ? derivations : baseDerivations };
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

function scenarioAssumptions(
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
function changeSinceOpeningAt(setup: ScenarioSetup, ledger: LedgerResult, c: LedgerCheckpoint | undefined) {
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
function presentScenario(setup: ScenarioSetup, ledger: LedgerResult, returns: ReturnPeriod[], solved?: string) {
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
const SCENARIO_QUALIFICATION =
  'The cash line is an evidence-based projection; the returns and contributions are '
  + 'the user\'s own assumptions and nothing here predicts a market. Present the '
  + 'result as "if these assumptions hold", and never as an expectation.';

/**
 * ⚠️ ONE SENTENCE, ONE DEFINITION, TWO TOOLS. A recomputation rule stated twice
 * in slightly different words is two rules, and the one a model happens to read
 * is the one that applies. It is deliberately about ANY assumption rather than
 * about income: the failure it addresses ("make it nine months", "what about next
 * June?") predates I1 and is not about income at all.
 *
 * ⚠️ WHY A TOOL DESCRIPTION AND NOT THE SYSTEM INSTRUCTION. Post-M1 dogfood
 * measured a changed assumption recomputed 2/6 and a new horizon 2/6. Nothing in
 * the runtime detects that a user changed an assumption — the scenario slot is
 * written only by a tool EXECUTION — and nothing inspects the reply, so the choice
 * is the model's. In the same matrix the one tool carrying an explicit re-call
 * sentence (`get_baselines`) scored 5/6. The system instruction had six words of
 * headroom before a pinned 240-word ceiling; the tool contract had room and the
 * precedent.
 */
const RECOMPUTE_SENTENCE =
  'Call it AGAIN whenever the user changes ANY assumption or the horizon — a rate, a '
  + 'contribution, a floor, a raise, a date. Every figure in the result changes with it, and '
  + 'none of them is to be recomputed in prose: never scale a previous result, add to it, '
  + 'subtract two of them, or read a new date off an old table.';

const scenarioProjection: ToolDefinition = {
  name: 'scenario_projection',
  // ⚠️ IT LED WITH "NET WORTH" AND EXEMPLIFIED ONLY INVESTING, so a question
  // about CASH this year did not look like this tool's job — the one-off
  // capability was four words between two sentences about investment returns.
  // What changed is the framing and the examples, not the arithmetic: this says
  // what the ledger has always done.
  description:
    'Deterministic projection when something specific happens that the observed pattern ' +
    // ⚠️ THE INCOME CLAUSE LEADS, BECAUSE A MODEL CHOOSING A TOOL READS THE FIRST
    // SENTENCE. Measured on the first I1 dogfood: asked "starting January my income
    // increases 10%, what does that do to my cash?", the model called project_cash,
    // then explained in prose that the question needed this tool. It knew; the
    // description did not say so where it was looking. Same lever, same shape, as
    // the one-off boundary that moved 0/5 to 5/5 (7859d6c).
    'does not contain: a CHANGE TO FUTURE INCOME from a date — a raise, a new salary, an ' +
    'income starting or ending (`incomeChanges`); a CHANGE TO FUTURE SPENDING — cutting a ' +
    'spending line or all spending by a percent or an amount, from now or from a date ' +
    '("cut Dining 20%", "cut Other 20%", `spendingChanges`), passing the user\'s own word for ' +
    'the line; a dated one-off amount arriving or ' +
    'leaving — a bonus, an ' +
    'inheritance, a car, a tax bill, proceeds from a sale — money moved into investments, ' +
    'and an annual return. Cash comes from the same deterministic projection as ' +
    'project_cash; this adds only what the user said, and reports cash, investments, debt ' +
    'and net worth at every checkpoint. Do NOT do this arithmetic yourself. ' +
    RECOMPUTE_SENTENCE + ' The default ' +
    'return is 0% — the no-growth baseline, which is not a prediction that markets return ' +
    'nothing. A rate the user did not state may be run as an explicitly labelled ' +
    'illustration; it may never be called expected, likely, or a forecast.',
  parameters: obj({ to: str('YYYY-MM-DD horizon end. Required.'), ...SCENARIO_INPUTS }, ['to']),
  async run(a, ctx) {
    const setup = await prepareScenario(a, ctx, String(a.to), scenarioProjection);
    if ('unavailable' in setup) return setup;
    return presentScenario(setup, setup.run(), setup.returns);
  },
};

// ── 11b. Scenario threshold crossing ─────────────────────────────────────────

/** What each line means to a reader. The values themselves are the ledger's. */
const CROSSING_METRICS: Record<LedgerMetric, string> = {
  netWorth:    'everything owned less everything owed',
  liquid:      'unrestricted cash (checking + savings, excluding restricted accounts such as an HSA)',
  investments: 'traditional investments + crypto',
  debt:        'what is owed, as a positive amount',
  otherAssets: 'property, restricted cash such as an HSA, and anything else that is not unrestricted cash, an investment or a debt',
};
const CROSSING_DIRECTIONS: CrossingDirection[] = ['at_or_above', 'at_or_below'];

/**
 * How far forward a search may look when nobody says.
 *
 * ⚠️ A SEARCH NEEDS A WALL, AND THE WALL IS PRODUCT. `scenario_projection` will
 * happily run to 2100 because a caller naming a horizon has said what they mean;
 * a caller asking "when?" has not, and an unbounded forward walk is a loop. Thirty
 * years covers every goal anybody states in a sentence and costs about a third of
 * a second to search.
 */
const CROSSING_DEFAULT_YEARS = 30;
const CROSSING_MAX_YEARS = 30;

const scenarioCrossing: ToolDefinition = {
  name: 'scenario_crossing',
  description:
    'WHEN a scenario first reaches a number: the first future month-end where net worth, cash, '
    + 'investments or debt crosses a threshold, under the same assumptions scenario_projection '
    + 'takes. Use it for "when do I hit a million", "when will I be debt free", "how long until '
    + 'I have X" — anything asking WHEN rather than HOW MUCH. It returns the crossing month, the '
    + 'month before it, and what the position looks like there. Do NOT read a date off a '
    + 'projection table yourself, and do NOT guess a deadline to hand scenario_goal_seek: that '
    + 'tool answers "what would it take by DATE", this one answers "when". '
    + RECOMPUTE_SENTENCE,
  parameters: obj({
    metric: { type: 'string', enum: Object.keys(CROSSING_METRICS),
      description: 'Which line crosses. `liquid` is unrestricted cash (checking + savings, excluding restricted accounts such as an HSA); `debt` is what is owed, '
        + 'as a positive amount.' },
    direction: { type: 'string', enum: CROSSING_DIRECTIONS,
      description: 'at_or_above for reaching a target; at_or_below for falling to one. '
        + '"When is my debt gone" is metric `debt`, at_or_below, threshold 0.' },
    threshold: num('The number to reach, in dollars. Required.'),
    searchThrough: str('YYYY-MM-DD to stop looking. Omit to search '
      + `${CROSSING_DEFAULT_YEARS} years ahead. Use it when the user named a window — `
      + '"do I get there by 2035?" — and the search will not look past it.'),
    ...SCENARIO_INPUTS,
  }, ['metric', 'direction', 'threshold']),
  async run(a, ctx) {
    const metric = a.metric as LedgerMetric;
    const direction = a.direction as CrossingDirection;
    const threshold = Number(a.threshold);
    if (!(metric in CROSSING_METRICS)) {
      return { unavailable: `unknown metric: ${String(a.metric)}`,
        canSearch: Object.keys(CROSSING_METRICS) };
    }
    if (!CROSSING_DIRECTIONS.includes(direction)) {
      return { unavailable: `unknown direction: ${String(a.direction)}`,
        canSearch: CROSSING_DIRECTIONS };
    }
    if (!Number.isFinite(threshold)) {
      return { unavailable: 'the threshold is not a number' };
    }

    // ⚠️ THE CAP IS ABSOLUTE AND THE REQUEST IS NOT EXTENDED PAST IT. A user who
    // said "through 2035" is answered about 2035; silently searching to 2056 and
    // reporting a date they excluded would answer a question they did not ask.
    const capISO = addYearsISO(ctx.asOfISO, CROSSING_MAX_YEARS);
    const asked = (a.searchThrough as string) || addYearsISO(ctx.asOfISO, CROSSING_DEFAULT_YEARS);
    const searchThrough = asked > capISO ? capISO : asked;
    if (searchThrough <= ctx.asOfISO) {
      return { unavailable: `the search window ${searchThrough} is not in the future` };
    }

    // ⚠️ EVERY MONTH-END, IN ORDER, THROUGH ONE LEDGER RUN. Not a bisection: a
    // scenario path is not guaranteed to rise — a one-off outflow, a negative
    // return or a falling month can take a line back down — so a search that
    // assumed monotonicity could report the second crossing as the first, or
    // miss one entirely. Walking the grid is O(months) and costs less than the
    // model reading a table.
    const dates = monthEndsBetween(ctx.asOfISO, searchThrough);
    const setup = await prepareScenario(a, ctx, searchThrough, scenarioCrossing, dates);
    if ('unavailable' in setup) return setup;
    const ledger = setup.run();

    const composition = (c: LedgerCheckpoint) => ({
      liquid: c.liquid?.amount ?? null, investments: c.investments.amount,
      debt: c.debt.amount, otherAssets: c.otherAssets.amount,
      netWorth: c.netWorth?.amount ?? null,
    });
    // ⚠️ BESIDE `composition`, NEVER INSIDE IT. The active-scenario envelope reads
    // its six numbers off `composition`; how far the position is from the opening
    // is a sibling, computed by the same function the projection table uses.
    const changeAt = (c: LedgerCheckpoint) => changeSinceOpeningAt(setup, ledger, c);
    // ⚠️ THE WALK IS PURE AND LIVES NEXT DOOR. Nothing about money is decided
    // here: the ledger produced the path, `findScenarioCrossing` says where the
    // line is first crossed on it, and this only says it in words.
    const found = findScenarioCrossing({ checkpoints: ledger.checkpoints,
      opening: ledger.opening, metric, direction, threshold });

    // ⚠️ AN UNEVALUATED MONTH-END IS NOT A MONTH THE CONDITION FAILED. A Space with no complete
    // month of spending has no projection at all, and "not met at any month-end through 2056" was
    // said after examining ZERO of them (2026-10-04). Count what could not be read, and never fold
    // it into a negative.
    const unevaluated = ledger.checkpoints.filter((c) => metricAt(c, metric) === null);
    const head = {
      asOf: setup.asOf, metric, metricMeans: CROSSING_METRICS[metric], direction, threshold,
      searchedThrough: { to: searchThrough, monthsExamined: found.examined,
        ...(unevaluated.length > 0 ? { monthsUnevaluated: unevaluated.length,
          firstUnevaluated: unevaluated[0].date } : {}),
        grain: 'month-end',
        ...(asked > capISO ? { cappedAt: `${CROSSING_MAX_YEARS} years` } : {}) },
      assumptionsInForce: scenarioAssumptions(setup, ledger, setup.returns),
      rejected: [...setup.rejected, ...ledger.rejected],
      warnings: ledger.warnings,
      basis: ledger.basis,
      qualification: SCENARIO_QUALIFICATION,
    };

    // ⚠️ ALREADY TRUE IS NOT A CROSSING, AND SAYING SO IS THE WHOLE POINT. The
    // goal seek's `alreadyMet` is what produced "the solver says 0% is needed",
    // narrated as though a future event had been found. A position that already
    // satisfies the condition has a date, and it is today.
    if (found.alreadySatisfied) {
      return { ...head, outcome: 'ALREADY_SATISFIED', crossing: null,
        alreadySatisfied: { ...found.alreadySatisfied,
          elapsed: elapsedBetween(setup.asOf, found.alreadySatisfied.date) },
        meaning: 'This is already true today. Nothing here is a future event.' };
    }

    if (!found.crossing && found.examined === 0) {
      return { ...head, outcome: 'EVALUATION_FAILED', crossing: null, neverCrossesBy: null,
        projectionRefusal: unevaluated.find((c) => c.unavailable)?.unavailable ?? 'the projection produced no value',
        meaning: 'The projection could not produce a value at any month-end, so whether and when this '
          + 'condition is met is UNKNOWN. Do not say it is never met; say the calculation could not run and why.' };
    }

    if (!found.crossing) {
      return { ...head, outcome: 'NOT_WITHIN_WINDOW', crossing: null,
        neverCrossesBy: found.end
          ? { date: found.end.checkpoint.date, value: found.end.value,
              elapsed: elapsedBetween(setup.asOf, found.end.checkpoint.date),
              composition: composition(found.end.checkpoint),
              changeSinceOpening: changeAt(found.end.checkpoint) }
          : null,
        meaning: (unevaluated.length > 0
          ? `Under these assumptions the condition is not met at any of the ${found.examined} month-ends the `
            + `projection could evaluate through ${searchThrough}; ${unevaluated.length} could not be evaluated `
            + `(from ${unevaluated[0].date}), and nothing is known about those. `
          : 'Under these assumptions the condition is not met at any month-end through '
            + `${searchThrough}. `) + 'That is a statement about this search window, not about ever.' };
    }

    const hit = found.crossing;
    // ⚠️ A PAYOFF OVER AN UNMODELLED RATE IS A LOWER BOUND, AND THE DATE SAYS SO
    // ITSELF. The echo above carries the basis; this puts it beside the number
    // the model is about to quote, so "exact" cannot be read off a field that
    // was never exact.
    const interest = ledger.liabilities && ledger.liabilities.interestBasis !== 'NOT_APPLICABLE'
      ? { basis: ledger.liabilities.interestBasis,
          aprMissingFor: ledger.liabilities.unmodelled.map((u) => u.label),
          reading: ledger.liabilities.interestBasis === 'COMPLETE'
            ? 'interest modelled on every owed liability'
            : 'PAYMENTS-ONLY LOWER BOUND: interest was not modelled on the liabilities named; '
              + 'with a positive rate this crossing would come later (for debt) — say so' }
      : null;
    return {
      ...head,
      outcome: 'CROSSES',
      crossing: {
        ...(interest ? { interestEvidence: interest } : {}),
        date: hit.checkpoint.date, value: hit.value,
        // ⚠️ HOW FAR AWAY, IN NUMBERS THE ENGINE OWNS. The date was always
        // right; "1.5 years" for a gap of five and a half months was the model
        // subtracting. Measured from the scenario's own asOf.
        elapsed: elapsedBetween(setup.asOf, hit.checkpoint.date),
        // ⚠️ THE MONTH BEFORE IS WHAT MAKES IT A FIRST. Without it a reader
        // cannot tell a crossing from a value that merely happens to be above
        // the line.
        previousCheckpoint: hit.previous
          ? { ...hit.previous, elapsed: elapsedBetween(setup.asOf, hit.previous.date) } : null,
        composition: composition(hit.checkpoint),
        changeSinceOpening: changeAt(hit.checkpoint),
      },
      alreadySatisfied: null,
      meaning: 'The first month-end at which this is true. The projection is month-grain, so '
        + 'say "by the end of that month" — nothing here establishes a day within it.',
    };
  },
};

// ── 12. Goal seek ────────────────────────────────────────────────────────────

/**
 * What a goal seek is allowed to solve for, and what bounds it honestly has.
 *
 * ⚠️ EACH BOUND IS A FACT, NOT A COMFORT. A spending cut cannot exceed what the
 * user actually spends; a required return of 400%/yr is reportable and the model
 * can call it absurd. What the tool must never do is invent a number to avoid
 * saying "no" — which is exactly what turn 13 did with "mid-40% annualized
 * returns" and "~$90K/year additional investable surplus".
 */
const SOLVABLE = {
  annualReturnPct:     'annualReturnPct',
  monthlyContribution: 'monthlyContribution',
  monthlySpendingCut:  'monthlySpendingCut',
  /** S1-7 — the one spending line's cut, by percent or by monthly amount. */
  spendingChange:      'spendingChange',
} as const;

/** The first day a projection from `asOf` governs. */
const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * A wide, stated bracket. Anything beyond it is reported as out of range, not clamped.
 *
 * ⚠️ 500 IN THE HORIZON'S OWN TERMS. It was 500% A YEAR at every horizon, which over 30
 * days is +15.9% and over 89 days +54.8% — so a target needing +60% by 31 December was
 * reported as unreachable while a +293% one was impossible, both by a search that had
 * simply stopped. Below a year the bound is +500% OVER THE PERIOD (the search runs in
 * period space); from a year on it is 500% a year, as before. The two meet at 365 days.
 */
const MAX_SOLVED_RETURN_PCT = 500;

const scenarioGoalSeek: ToolDefinition = {
  name: 'scenario_goal_seek',
  description:
    // ⚠️ THE EXAMPLE CARRIES NO CURRENCY SYMBOL. Anywhere under lib/ai a quoted
    // dollar-then-digit is a hard-coded currency in a money string, and
    // `lib/ai/currency-presentation.test.ts` refuses it — correctly: this tool is
    // currency-agnostic and a Space that reports in anything but USD should not
    // read a dollar sign in its own tool surface. The guard only started applying
    // when the runtime moved out of scripts/, which is the guard working.
    'Solve for the one number that reaches a target: the annual return needed, the monthly ' +
    'contribution needed, or the monthly spending cut needed. Use it for "how could I reach ' +
    'a million by 2030?" — do NOT estimate a required return or a required saving rate ' +
    'yourself. ' +
    'It returns the value AND the full scenario at that value, with `outcome`: SOLVED, ' +
    'ALREADY_MET, INFEASIBLE (no value of the lever can reach it), OUT_OF_RANGE (the search ' +
    'stopped first — never call that impossible) or EVALUATION_FAILED (the projection could not ' +
    'run — reachability is unknown, never impossible). Takes the same scenario inputs as ' +
    'scenario_projection, which are held fixed while the one unknown is solved. ' +
    'A solved return comes as `returnAtSolution` over `horizon`: lead with `periodPct` (growth ' +
    'over the actual period) for a by-date question shorter than a year, with `annualizedPct` ' +
    'for a longer one or when the user asks for an annual/annualized rate — and give the other ' +
    'as context. Never convert between them yourself.',
  parameters: obj({
    target: num('The number to reach, in dollars. Required.'),
    by:     str('YYYY-MM-DD by which to reach it. Required.'),
    solveFor: { type: 'string', enum: Object.keys(SOLVABLE),
      description:
        'annualReturnPct = what return would be needed. monthlyContribution = how much cash '
        + 'to move into investments each month (this RELOCATES money — at a 0% return it does '
        + 'not change net worth at all). monthlySpendingCut = how much less to spend each '
        + 'month overall, with that amount invested; this is the lever that actually creates '
        + 'net worth. spendingChange = how much to cut ONE spending line ("how much would I need '
        + 'to cut Dining to…") — give `spendingChangeToSolve`.' },
    spendingChangeToSolve: obj({
      category: str('The spending line, in the user\'s own word (as in `spendingChanges[].category`).'),
      unit: { type: 'string', enum: ['percent', 'monthly'],
        description: 'percent = the share of the line to cut (0–100); monthly = how much less a '
          + 'month (up to the whole line).' },
      from: str('YYYY-MM-DD the cut starts. Omit for the first projected day.'),
    }, ['category', 'unit']),
    measure: { type: 'string', enum: ['netWorth', 'liquid', 'investments', 'debt'],
      description: 'What the target is a target FOR. Default netWorth. `debt` solves DOWNWARD: '
        + 'the smallest value that brings debt at `by` to at or below the target ("what extra '
        + 'monthly payment gets me debt free by December" = monthlyContribution, measure debt, '
        + 'target 0, contributionTarget highest_apr).' },
    contributionTarget: { description: 'For solveFor monthlyContribution: where the solved '
        + 'monthly amount goes — `investments` (default), `highest_apr`, a liability id, or an '
        + 'ordered list, exactly as `contributions[].target`.',
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    ...SCENARIO_INPUTS,
  }, ['target', 'by', 'solveFor']),
  async run(a, ctx) {
    const toISO  = String(a.by);
    const target = Number(a.target);
    const solveFor = String(a.solveFor);
    const measure = ['liquid', 'investments', 'debt'].includes(String(a.measure))
      ? String(a.measure) as 'liquid' | 'investments' | 'debt' : 'netWorth';
    // ⚠️ DEBT IS SOLVED DOWNWARD. The bisection assumes "more of X reaches a
    // higher value"; for a debt target the value that rises with X is minus the
    // balance, so the ledger's debt is negated on the way in and the target on
    // the way out. Nothing else about the solver changes.
    const sign = measure === 'debt' ? -1 : 1;
    const toTarget = (t: unknown): AllocationTarget => (t === 'investments' || t === 'highest_apr') ? t
      : typeof t === 'string' ? { liability: t } : t as AllocationTarget;
    const contributionTargets: AllocationTarget[] | undefined = a.contributionTarget === undefined ? undefined
      : Array.isArray(a.contributionTarget) ? a.contributionTarget.map(toTarget) : [toTarget(a.contributionTarget)];
    if (!Number.isFinite(target)) return { unavailable: 'the target is not a number' };
    if (!(solveFor in SOLVABLE)) {
      return { unavailable: `cannot solve for "${solveFor}"`,
        canSolveFor: Object.keys(SOLVABLE) };
    }

    const setup = await prepareScenario(a, ctx, toISO, scenarioGoalSeek);
    if ('unavailable' in setup) return setup;

    // ── S1-7 — the spending cuts a solve evaluates, as rules ──────────────────
    // Every refusal below still echoes what was in force (see `scenarioAssumptions`).
    const assumptionsNow = () => scenarioAssumptions(setup, setup.run(), setup.returns);
    const totalCut = (x: number): SpendingChangeRule => ({ id: 'solved', op: 'DELTA', scope: null,
      fromISO: dayAfter(setup.asOf), monthly: -round2(x) });
    let spendSolve = { unit: 'percent' as 'percent' | 'monthly', lineMonthly: 0, from: '', category: '',
      rule: (_x: number): SpendingChangeRule => { throw new Error(String(_x)); } };
    if (solveFor === SOLVABLE.spendingChange) {
      const want = (a.spendingChangeToSolve ?? {}) as Record<string, unknown>;
      const unitWanted = want.unit === 'monthly' ? 'monthly' : want.unit === 'percent' ? 'percent' : null;
      if (typeof want.category !== 'string' || !unitWanted) {
        return { unavailable: 'solveFor spendingChange needs `spendingChangeToSolve` with a `category` and a '
          + '`unit` (percent or monthly)', assumptionsInForce: assumptionsNow() };
      }
      const line = resolveTransformableCategory(want.category);
      if (!line.ok) {
        return { unavailable: line.unavailable, assumptionsInForce: assumptionsNow() };
      }
      const from = typeof want.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(want.from) ? want.from : dayAfter(setup.asOf);
      const scope = { category: line.category, class: line.class, meaning: line.meaning };
      // Two different rules on one line from one date are refused by the engine —
      // so a solve that would collide with a stated rule is refused up front, said.
      const stated = setup.spendingChanges?.applied ? setup.spendingChanges.executions : [];
      if (stated.some((x) => x.category?.category === line.category && x.requested.fromISO === from)) {
        return { unavailable: `the scenario already changes ${line.category} from ${from}; a solved cut from the `
          + 'same date would be a second answer to the same rule. Solve from another date, or run the scenario '
          + `without that ${line.category} rule.`, assumptionsInForce: assumptionsNow() };
      }
      // The line's own measured rate, from the spine (the category rates do not depend on any rule).
      const probe = setup.runProbe({ id: 'probe', op: 'SCALE', scope, fromISO: from, multiplier: 0.5 });
      const lineMonthly = probe?.categoryRates.find((c) => c.category === line.category)?.monthly ?? 0;
      if (lineMonthly <= 0) {
        return { unavailable: `${line.category} had no spending in the averaged months, so there is nothing to cut`,
          assumptionsInForce: assumptionsNow() };
      }
      spendSolve = { unit: unitWanted, lineMonthly, from, category: line.category,
        rule: (x) => (unitWanted === 'percent'
          ? { id: 'solved', op: 'SCALE', scope, fromISO: from, multiplier: 1 - x / 100 }
          : { id: 'solved', op: 'DELTA', scope, fromISO: from, monthly: -x }) };
    }

    /** The horizon value of whichever line the target is about. */
    const valueOf = (l: LedgerResult): number | null => {
      const last = l.checkpoints[l.checkpoints.length - 1];
      if (!last) return null;
      const line = measure === 'liquid' ? last.liquid
        : measure === 'investments' ? last.investments
        : measure === 'debt' ? last.debt : last.netWorth;
      return line?.amount === undefined || line?.amount === null ? null : sign * line.amount;
    };

    // A monthly schedule of a solved dollar amount, on the month-ends that fall by the
    // deadline — a SCHEDULE, never the checkpoint grid, which ends on `by` itself and so
    // put a whole extra month's amount on a mid-month deadline.
    const monthly = (amount: number, label: string): PlannedMovement[] =>
      monthEndOccurrences(setup.asOf, toISO).map((date) => ({ date, amount, label,
        ...(contributionTargets ? { targets: contributionTargets } : {}) }));

    let evaluate: (x: number) => number | null;
    let hi = 0, unit = '';
    let bound: SolveBound = 'SEARCH';
    const lo = 0, precision = 0.01;
    // The ledger's own day count over the solved period — one year convention per result.
    const horizon = returnHorizon(setup.asOf, toISO);
    /** A rate over [asOf, by], the only return a solve is allowed to state. */
    const solvedReturns = (annualPct: number): ReturnPeriod[] => [{ fromISO: setup.asOf, toISO, annualPct }];
    const atAnnual = (annualPct: number) => valueOf(setup.run({ returns: solvedReturns(annualPct) }));
    // ⚠️ BELOW A YEAR THE RETURN IS SEARCHED AS PERIOD GROWTH (see MAX_SOLVED_RETURN_PCT).
    const returnSpace: 'PERIOD' | 'ANNUAL' = horizon.dayCount < 365 ? 'PERIOD' : 'ANNUAL';
    const annualOf = (x: number) => (returnSpace === 'PERIOD' ? annualizedFromPeriodPct(x, horizon.dayCount) : x);
    const periodOf = (x: number) => (returnSpace === 'PERIOD' ? x : periodFromAnnualizedPct(x, horizon.dayCount));

    if (solveFor === SOLVABLE.annualReturnPct) {
      unit = 'percent per year';
      hi = MAX_SOLVED_RETURN_PCT;
      // ⚠️ A SOLVED RETURN REPLACES ANY STATED ONE. Solving for a rate while
      // leaving another in force would answer a question about a blend that
      // nobody described.
      evaluate = (x) => atAnnual(annualOf(x));
    } else if (solveFor === SOLVABLE.monthlyContribution) {
      unit = 'USD per month';
      // ⚠️ THE BRACKET FOR A DEBT TARGET IS THE DEBT. A monthly amount equal to
      // everything owed clears it in the first month whatever the rate, so the
      // top of the range is a fact, not a guess.
      hi = measure === 'debt'
        ? Math.max(setup.liabilities.reduce((t, l) => t + l.balance, 0) + (setup.accounts.totalLiabilities ?? 0), 1_000)
        : Math.max(Math.abs(target), 1_000);
      if (measure === 'debt') bound = 'STRUCTURAL';
      evaluate = (x) => valueOf(setup.run({
        extraContributions: monthly(x, 'solved monthly contribution') }));
    } else if (solveFor === SOLVABLE.monthlySpendingCut) {
      unit = 'USD per month';
      const base = setup.monthlySpending.amount;
      if (base === null || base <= 0) {
        return { unavailable: 'no monthly spending level is established for this Space, so '
          + 'there is nothing to solve a cut against',
          suggestion: 'pass assumedMonthlySpending, or solve for annualReturnPct instead' };
      }
      // ⚠️ THE CEILING IS WHAT THEY ACTUALLY SPEND. Nobody can cut more than
      // their whole outgoings, and "you would need to free up $12,400 a month"
      // said to somebody who spends $7,549 is a fabrication with a decimal point.
      hi = base;
      bound = 'STRUCTURAL';
      // ⚠️ S1-7 — THE CUT IS A RULE ON TOP OF THE SCENARIO, NOT A NEW SPENDING LEVEL.
      // It was a replacement level (`base − x`), which with a Dining cut already in
      // the scenario would have silently dropped the Dining cut. An aggregate DELTA
      // composes with every stated spending change, and without them it is exactly
      // the old arithmetic.
      evaluate = (x) => valueOf(setup.run({
        ...(x > 0 ? { extraSpendingChanges: [totalCut(x)] } : {}),
        extraContributions: monthly(x, 'solved monthly amount freed up and invested') }));
    } else {
      unit = spendSolve.unit === 'percent' ? 'percent of the line' : 'USD per month';
      hi = spendSolve.unit === 'percent' ? 100 : spendSolve.lineMonthly;
      bound = 'STRUCTURAL';
      // ⚠️ THE CUT JOINS THE SCENARIO'S OWN RULES, and the freed cash stays wherever
      // the scenario's rules send cash — a floor sweep, a waterfall, or nowhere. It is
      // a question about the line, not an instruction to invest.
      evaluate = (x) => valueOf(setup.run(x > 0 ? { extraSpendingChanges: [spendSolve.rule(x)] } : {}));
    }

    const isReturn = solveFor === SOLVABLE.annualReturnPct;
    // ⚠️ THE BASELINE IS THE LEVER AT THE BOTTOM OF ITS RANGE, UNDER THE SOLVE'S OWN RULES. A solved
    // return REPLACES any stated one, so "without the solved variable" is the scenario at 0%, not at
    // the stated rate: with a stated −20% the baseline was run at −20% while the solve started at 0%,
    // and the result said ALREADY_MET beside a positive baseline gap (2026-10-04). Status, gap and
    // solution now describe one scenario family; the replaced statement is named, not hidden.
    const baseLedger = setup.run(isReturn ? { returns: solvedReturns(annualOf(lo)) } : {});
    const baseline = valueOf(baseLedger);
    let solved = solveForTarget({ solveFor, evaluate, target: sign * target, lo, hi, precision, bound });
    // ⚠️ A PERIOD-SPACE SOLVE IS REFINED TO THE REPORTED UNIT. A hundredth of a point of period
    // growth over 89 days is fifteen hundredths a year; the answer is reported per year, so it is
    // bisected again — inside the period bracket — to a hundredth of THAT, and verified. The
    // period answer was rounded UP, so the true one lies within two steps below it.
    if (isReturn && returnSpace === 'PERIOD' && solved.outcome === 'SOLVED') {
      const refined = solveForTarget({ solveFor, evaluate: atAnnual, target: sign * target, precision,
        lo: annualOf(Math.max(0, solved.required - 2 * precision)), hi: annualOf(solved.required) });
      const required = Math.ceil((refined.feasible ? refined.required : annualOf(solved.required + precision)) * 100 - 1e-9) / 100;
      solved = { ...solved, iterations: solved.iterations + refined.iterations, required,
        reached: atAnnual(required) ?? Number.NEGATIVE_INFINITY };
    } else if (isReturn && returnSpace === 'PERIOD' && !solved.feasible) {
      solved = { ...solved, bestAt: round2(annualOf(solved.bestAt)) };
    }
    /** Why the projection itself could not produce a value — its own words, for EVALUATION_FAILED. */
    const projectionRefusal = baseLedger.checkpoints.find((c) => c.unavailable)?.unavailable
      ?? (baseline === null ? 'the projection produced no value at the deadline' : null);
    const outOfRange = !solved.feasible && solved.outcome === 'OUT_OF_RANGE';

    // ⚠️ `timeToTarget.years` IS NOT HERE. It is a display distance on a 365.25-day year; the
    // result's one year fraction is `horizon.yearFraction`, the exponent the ledger grew money by.
    const { years: _displayYears, ...timeToTarget } = elapsedBetween(setup.asOf, toISO);
    void _displayYears;

    const head = {
      asOf: setup.asOf, target, by: toISO, measure, solveFor, unit, outcome: solved.outcome,
      /** How far off the deadline is, from the scenario's asOf — the engine's subtraction, not the model's. */
      timeToTarget,
      horizon,
      // ⚠️ ON EVERY PATH, INCLUDING THE REFUSAL. See `scenarioAssumptions`. For a return solve the
      // returns in force are the solve's, so a stated rate is echoed as REPLACED, never as applied.
      assumptionsInForce: scenarioAssumptions(setup, baseLedger, isReturn ? [] : setup.returns),
      ...(isReturn && setup.returns.length > 0 ? { replacedByThisSolve: {
        returns: setup.returns.map((r) => ({ from: r.fromISO, to: r.toISO, annualPct: r.annualPct })),
        meaning: 'A solved return replaces any stated one: the baseline, the outcome and the answer are all '
          + 'computed WITHOUT these rates. To keep a stated rate, solve for a different lever.' } } : {}),
      /** Which way raising the lever moved this measure in THIS scenario (from the solve's own evaluations). */
      leverDirection: solved.direction,
      ...(contributionTargets ? { contributionTarget: contributionTargets } : {}),
      baseline: { reached: baseline === null ? null : sign * baseline,
        gap: baseline === null ? null : round2(target - sign * baseline),
        meaning: isReturn ? `where the scenario lands with ${solveFor} at ${lo}, the bottom of the solved range`
          : 'where the stated assumptions land WITHOUT the solved variable' },
      searchRange: { from: lo, to: isReturn ? round2(annualOf(hi)) : hi, unit, iterations: solved.iterations,
        ...(isReturn ? { periodTo: round2(periodOf(hi)), boundIn: returnSpace === 'PERIOD'
          ? 'period growth: up to +500% over the horizon, because the horizon is shorter than a year'
          : 'annual rate: up to 500% a year' } : {}),
        note: solveFor === SOLVABLE.monthlySpendingCut
          ? `the upper bound is the whole ${setup.monthlySpending.source.toLowerCase()} `
            + 'monthly spending level — nobody can cut more than they spend'
          : solveFor === SOLVABLE.spendingChange
            ? `the upper bound is the whole ${spendSolve.category} line (${round2(spendSolve.lineMonthly)}/month over `
              + 'the averaged months) — a line cannot be cut below nothing'
            : 'a value outside this range is reported as out of range, never clamped' },
      ...(solveFor === SOLVABLE.spendingChange ? { solving: { category: spendSolve.category, unit: spendSolve.unit,
        from: spendSolve.from, lineMonthly: round2(spendSolve.lineMonthly),
        meaning: 'The cut is added to the scenario\'s own rules (any stated spending change still applies); the '
          + 'cash it frees goes wherever the scenario\'s rules send cash.' } } : {}),
    };

    if (!solved.feasible) {
      return { ...head, feasible: false, reason: solved.reason,
        bestReached: solved.bestReached === null ? null : sign * solved.bestReached, bestAt: solved.bestAt,
        ...(isReturn && solved.outcome !== 'EVALUATION_FAILED'
          ? { bestAtPeriodPct: round2(periodOf(solved.direction === 'AWAY' ? lo : hi)) } : {}),
        // ⚠️ HOW FAR THE RANGE GOT IS AN ANSWER; A HUGE INVENTED NUMBER IS NOT.
        ...(solved.outcome === 'EVALUATION_FAILED' ? { projectionRefusal } : {}),
        meaning: (solved.outcome === 'EVALUATION_FAILED'
          ? `The projection could not produce a value (${projectionRefusal ?? 'no value'}), so whether ${target} is `
            + 'reachable is UNKNOWN. Do not call it impossible or unreachable; say the calculation could not run '
            + 'and why, and what would let it (for example a stated monthly spending level). '
          : outOfRange
          ? `The search stopped before reaching ${target}: the best it did was ${solved.bestReached ?? 'nothing'} `
            + `at ${solved.bestAt} ${unit}${isReturn ? ` (+${round2(periodOf(hi))}% over the horizon)` : ''}. `
            + 'That is where the search ended, NOT a proof that it is impossible — do not call it impossible. '
          : solved.direction === 'AWAY'
            ? `Raising ${solveFor} moves ${measure} AWAY from ${target} in this scenario, so no amount of it `
              + `reaches it; the closest is ${solveFor} = ${solved.bestAt}. `
          : `No value of ${solveFor} reaches ${target}. The best it did was `
            + `${solved.bestReached ?? 'nothing'} at ${solved.bestAt} ${unit}. `)
          + 'Say that, and '
          + 'say which other lever might close the gap — do not estimate a figure yourself. '
          + 'Describe the result using `assumptionsInForce` above and nothing else: if a '
          + 'return or a contribution from earlier in the conversation is not listed there, '
          + 'it was NOT applied, and calling the answer again with it is the way to include '
          + 'it.' };
    }

    // ⚠️ THE LEDGER RETURNED IS THE ONE RUN AT THE ANSWER, not a re-derivation of
    // it. Solve, then render what the solution actually produces, so the table
    // beneath the number cannot disagree with the number.
    const atSolution: ScenarioOverrides = solveFor === SOLVABLE.annualReturnPct
      ? { returns: [{ fromISO: setup.asOf, toISO, annualPct: solved.required }] }
      : solveFor === SOLVABLE.monthlyContribution
        ? { extraContributions: monthly(solved.required, 'solved monthly contribution') }
        : solveFor === SOLVABLE.monthlySpendingCut
          ? { ...(solved.required > 0 ? { extraSpendingChanges: [totalCut(solved.required)] } : {}),
              extraContributions: monthly(solved.required, 'solved monthly amount freed up and invested') }
          : (solved.required > 0 ? { extraSpendingChanges: [spendSolve.rule(solved.required)] } : {});
    const ledger = setup.run(atSolution);
    const returnsUsed = solveFor === SOLVABLE.annualReturnPct
      ? [{ fromISO: setup.asOf, toISO, annualPct: solved.required }] : setup.returns;
    // ⚠️ FROM THE FACTOR THE LEDGER GREW THE MONEY BY — never `investments at the answer ÷ opening`,
    // which mixes any contribution or outflow on the way into the "return".
    const representation = returnRepresentation(returnsUsed, setup.asOf, toISO);
    const last = ledger.checkpoints[ledger.checkpoints.length - 1];

    return {
      ...head,
      feasible: true,
      required: solved.required,
      alreadyMet: solved.alreadyMet,
      reachedAtSolution: sign * solved.reached,
      ...(solved.alreadyMet
        ? { meaning: `The target is already reached without any ${solveFor} at all.` }
        : {}),
      ...(isReturn ? { returnAtSolution: { ...representation,
        leadWith: horizon.dayCount < 365 ? 'periodPct' : 'annualizedPct',
        leadWithMeaning: 'the default for this horizon; when the user asked for an annual or annualized rate, '
          + 'lead with annualizedPct and give periodPct beside it' } } : {}),
      // ⚠️ "SHOW ME THE MATH" IS READ HERE, NOT REBUILT. Every term is the ledger at the answer.
      ...(last ? { derivation: {
        measure,
        identity: 'netWorth = liquid + investments + otherAssets − debt',
        terms: { liquid: last.liquid?.amount ?? null, investments: last.investments.amount,
          otherAssets: last.otherAssets.amount, debt: last.debt.amount, netWorth: last.netWorth?.amount ?? null,
          target },
        investments: { opening: ledger.opening.investments, atHorizon: last.investments.amount,
          growthFromReturn: last.movements.investmentGrowthToDate,
          principalMovedIn: round2(last.investments.amount - ledger.opening.investments
            - last.movements.investmentGrowthToDate),
          growthFactor: representation.growthFactor, periodPct: representation.periodPct,
          annualizedPct: representation.annualizedPct,
          meaning: 'atHorizon = opening + principalMovedIn + growthFromReturn. periodPct is growthFactor − 1, '
            + 'the growth of a dollar held the whole horizon; it is NOT atHorizon ÷ opening, which would '
            + 'count principal moved in as return.' },
        horizon: { ...horizon, compounding: 'effective annual over actual days: factor = (1 + annual)^(dayCount/365)' },
      } } : {}),
      // The answer is the SOLVER'S, never a figure anyone stated (provenance correction).
      origin: ORIGIN.SOLVED,
      // ⚠️ THE LEDGER AT THE ANSWER, WITH THE SOLVED RULE IN ITS ROSTER — the table
      // beneath the number is the run that produced it (S1-7: the solved spending
      // rule is listed as a rule that ran, beside the scenario's own).
      scenario: presentScenario(setup, ledger, returnsUsed, solveFor),
      qualification:
        'This is the value that reaches the target under the stated assumptions — it is '
        + 'arithmetic, not advice and not a prediction. Whether it is achievable is a '
        + 'judgement about the world, not about the numbers; say what you think.',
    };
  },
};

// ── 13. Reconciliation ───────────────────────────────────────────────────────

/** How many statements one reconciliation call will settle. */
const MAX_RECONCILED = 6;

/**
 * Which authority answers a checkpoint's metric. Unknown metrics are refused.
 *
 * ⚠️ THE STORED METRIC IS `liquid`, NOT `cash`, AND THE SCAN CAUGHT THE FIRST
 * DRAFT. The investigation's sketch wrote `metric: "cash"`, and a row saying
 * `cash: 38243.50` read back in December — with no conversation around it and no
 * tool description in sight — is the beta blocker with a longer fuse. A stored
 * record is read further from its context than any tool result, so it needs the
 * more precise name, not the more familiar one.
 */
const METRIC_FIELD: Record<string, 'liquid' | 'netWorth'> = {
  liquid: 'liquid', netWorth: 'netWorth',
};

const reconcileProjection: ToolDefinition = {
  name: 'reconcile_projection',
  description:
    'Compare what we PREVIOUSLY told this user with what actually happened, or with what we ' +
    'would say today. Use it for "were you right?", "how did that projection turn out?", ' +
    '"am I ahead of where you said I would be?". A past horizon is compared against the ' +
    'measured position on that date; a future one against the projection re-run today, which ' +
    'is the only like-for-like comparison. It also names which part of the basis changed. ' +
    // AI RELIABILITY (2026-10-16) — a variance is explained by its attribution or not at all.
    'Explain a variance ONLY with its `attribution` lines (they sum to it); a cause that is not a ' +
    'line there is unsupported. `dailyRate` is SPENDING, never a drift.',
  parameters: obj({
    subject: str('One checkpoint subject, e.g. "liquid-2026-12-31". Omit for all of them.'),
    includeSuperseded: { type: 'boolean',
      description: 'True to reconcile earlier statements too, not just the latest per horizon.' },
  }),
  async run(a, ctx) {
    const statements = await recallMemories(
      ctx.memoryClient,
      { spaceId: ctx.spaceId, ownerUserId: ctx.spaceCtx.userId },
      { kind: MemoryKind.CHECKPOINT,
        ...(a.subject ? { subject: String(a.subject) } : {}),
        ...(a.includeSuperseded ? { includeSuperseded: true } : {}) },
    );
    if (statements.length === 0) {
      // RLS-AI-S0 — the SAME adjudication `recall` makes, for the same store and
      // the same reason: this sentence is a claim about the user's history, and an
      // unreadable store must not be able to make it.
      const memoryVerdict = await adjudicateMemoryAbsence(ctx);
      if (memoryVerdict === EvidenceState.INDETERMINATE) {
        return { count: 0, evidenceState: memoryVerdict,
          unavailable: indeterminateFor('any recorded projection for this user') };
      }
      return { count: 0, evidenceState: memoryVerdict,
        // ⚠️ NOTHING RECORDED IS NOT THE SAME AS NOTHING SAID, and pretending
        // otherwise would invent a history. Checkpoints only exist from the
        // moment a projection was made in a conversation.
        unavailable: 'no projection has been recorded for this user yet — there is nothing to '
          + 'reconcile against. Ask for an evidence-based projection first — one is recorded automatically, '
          + 'while a projection run on a spending figure the user supplied is a hypothetical and is not.' };
    }

    const spine = await buildCashSpine(ctx, { asOf: ctx.asOfISO });
    const reconciled = [];

    for (const m of statements.slice(0, MAX_RECONCILED)) {
      const cp = readCheckpoint(m);
      if ('unusable' in cp) { reconciled.push({ subject: m.subject, unusable: cp.unusable }); continue; }

      const field = METRIC_FIELD[cp.metric];
      if (!field) {
        reconciled.push({ subject: cp.subject,
          unusable: `no authority in this harness answers the metric "${cp.metric}"` });
        continue;
      }

      const settled = cp.horizon < ctx.asOfISO;
      let compared: number | null = null;
      let comparedFrom = '';
      let basisNow: Record<string, unknown> | null = null;
      let attribution: unknown = null;
      let incomeNow: unknown = null;
      let incomeCountedNow: unknown = null;

      if (settled) {
        // ⚠️ ACCURACY, MEASURED AGAINST WHAT ACTUALLY HAPPENED. The horizon has
        // passed, so the financial authorities can say what the position on that
        // date really was, and the difference is the honest score.
        const snap = await historicalSnapshot(ctx, cp.horizon) as Record<string, unknown>;
        if (snap.unavailable) {
          reconciled.push({ subject: cp.subject, stated: cp, status: 'SETTLED',
            unavailable: snap.unavailable });
          continue;
        }
        compared = (snap[field] as number | null) ?? null;
        comparedFrom = `measured position on ${snap.observedOn ?? cp.horizon}`;
      } else if (!('unavailable' in spine)) {
        // ⚠️ MID-FLIGHT, THE COMPARISON IS PROJECTION AGAINST PROJECTION. Setting
        // a year-end statement beside today's balance and subtracting produces a
        // number about two different instants that means nothing at all. Re-running
        // to the SAME horizon is the only like-for-like reading of "am I ahead?".
        const f = spine.runTo(cp.horizon);
        compared = f.projection?.closing ?? null;
        comparedFrom = `the same projection re-run today, to the same horizon (${cp.horizon})`;
        const nowIncome = f.projection && f.projection.closing !== null
          ? incomeCompleteness({ streams: spine.streams, events: f.events,
              excludedIds: new Set(f.projection.excluded.map((x) => x.id)), fromISO: spine.asOf, toISO: cp.horizon,
              openingCash: f.projection.openingCash ?? 0 })
          : null;
        const b = (f.projection ? {
          spendingSource: f.observedSpending ? 'OBSERVED' : (f.appliedFacts.length ? 'USER_STATED' : 'NONE'),
          dailyRate: f.observedSpending?.dailyRate ?? null,
          monthsAveraged: (f.observedSpending as { months?: string[] } | undefined)?.months ?? null,
          // The count a statement records (project_cash `incomeEventsCounted`) — compared like for like.
          incomeEvents: nowIncome?.incomeEventsCounted ?? null,
          userAssumptions: f.appliedFacts,
          openingCash: f.projection.openingCash,
        } : null);
        basisNow = b;
        // AI RELIABILITY (2026-10-16) — THE CAUSE, IN DOLLARS, SUMMING TO THE VARIANCE.
        const thenSide = attributionSideFromCheckpoint(cp);
        if (thenSide && f.projection?.closing != null && f.projection.totals && f.observedSpending
            && f.projection.openingCash !== null) {
          // The income projected for the ELAPSED window, by the engine standing at the statement's date.
          let elapsedIncome: number | null = null;
          if (thenSide.asOfISO < spine.asOf) {
            const back = await buildCashSpine(ctx, { asOf: thenSide.asOfISO });
            if (!('unavailable' in back)) {
              const e = back.runTo(spine.asOf).projection?.totals;
              elapsedIncome = e ? e.inflow : null;
            }
          }
          attribution = attributeInFlightVariance(thenSide, {
            value: f.projection.closing, openingCash: f.projection.openingCash,
            dailyRate: f.observedSpending.dailyRate,
            monthsAveraged: (f.observedSpending as { months?: string[] }).months ?? null,
            incomeProjected: f.projection.totals.inflow, outflowsProjected: f.projection.totals.outflow,
            asOfISO: spine.asOf,
          }, cp.horizon, elapsedIncome);
        } else {
          attribution = { unavailable: 'this statement or today\'s run lacks an observed spending basis, so the '
            + 'variance cannot be decomposed — report the variance and do NOT name a cause' };
        }
        if (nowIncome && nowIncome.status === 'INCOMPLETE') {
          incomeNow = incompletenessBlock(nowIncome, f.projection!.closing!);
        }
        // What today's income term IS, per stream — so an income line is described from these, not guessed.
        incomeCountedNow = nowIncome?.streams.filter((l) => l.counted > 0 || isOmittedLine(l))
          .map((l) => ({ stream: l.stream, status: l.status, payments: l.counted, level: l.level,
            projectedTotal: l.projectedTotal })) ?? null;
      }

      reconciled.push({
        subject: cp.subject,
        status: settled ? 'SETTLED' : 'IN_FLIGHT',
        stated: { value: cp.value, metric: cp.metric, horizon: cp.horizon,
          on: cp.statedAt.slice(0, 10), inWords: cp.statedAs },
        comparedWith: comparedFrom,
        ...(compared === null
          ? { unavailable: settled
              ? 'the position on that date cannot be established'
              : 'the projection cannot be re-run to that horizon today' }
          : { variance: compareToStatement(cp.value, compared) }),
        // ⚠️ A VARIANCE WITHOUT ITS CAUSE IS A SCORE, NOT AN EXPLANATION.
        ...(basisNow ? { basisChanged: diffBasis(cp.basis, basisNow),
          fieldMeaning: BASIS_FIELD_MEANING } : {}),
        ...(attribution ? { attribution } : {}),
        // When today's re-run is itself incomplete, the comparison figure is a bound, and says so.
        ...(incomeNow ? { comparedIsIncomplete: incomeNow } : {}),
        ...(incomeCountedNow ? { incomeCountedNow } : {}),
        meaning: settled
          ? 'What we said, against what happened. The difference is our error, not the user\'s.'
          : 'Both figures describe the SAME future date — one said then, one said now. This is '
            + 'not a comparison with the current balance, and must not be described as one.',
      });
    }

    return {
      asOf: ctx.asOfISO,
      count: reconciled.length,
      ofTotal: statements.length,
      reconciled,
      note: 'A checkpoint records what we STATED and when. It is never a current balance — for '
        + 'that, call get_financial_snapshot.',
    };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

// ── 12. Staging — conditions stated before a scenario has run ────────────────

/**
 * THE CARRIER FOR "SAID, NOT YET RUN" (planning continuity).
 *
 * ⚠️ ITS PARAMETERS ARE THE SCENARIO'S OWN, READ OFF `SCENARIO_INPUTS`. There is
 * no second schema: a clause staged here is one item of the argument the scenario
 * tools already take, in the same shape, checked against the same literal — and
 * the next scenario run merges it in by identity (`pending-plan.ts`).
 *
 * ⚠️ THE BOUNDARY WITH `remember` IS THE SENTENCE THIS DESCRIPTION LEADS WITH.
 * Measured before this tool existed: "For this scenario, keep nine months in cash"
 * was written to DURABLE memory 3/3 — because memory was the only structured place
 * a condition could go. A condition for the calculation being assembled is staged
 * here; a standing preference the user wants kept across conversations is theirs
 * to ask `remember` for.
 */
/** S1 — the transformable lines named by held spending clauses, with what each holds. */
function spendingLinesHeld(clauses: readonly { key: string; value: unknown }[]) {
  const seen = new Map<string, { line: string; class: string; contains: string }>();
  for (const c of clauses) {
    const word = c.key === 'spendingChanges' ? (c.value as { category?: unknown }).category : undefined;
    if (typeof word !== 'string' || !word.trim()) continue;
    const r = resolveTransformableCategory(word);
    if (r.ok && !seen.has(r.category)) seen.set(r.category, { line: r.category, class: r.class, contains: r.meaning });
  }
  return [...seen.values()];
}

const stageAssumptions: ToolDefinition = {
  name: 'stage_assumptions',
  description:
    'Hold a condition the user just stated for a projection that has NOT been run yet — a '
    + 'raise or income change from a date, a cut or change to a spending line or to all '
    + 'spending ("cut Dining 20%"), a cash floor, which debt to pay first, where the '
    + 'rest goes, a one-off amount, a return, a spending level — so the next '
    + 'scenario_projection, scenario_crossing or scenario_goal_seek in this conversation '
    + 'applies it. Use it whenever a condition is stated without asking for a figure yet ("keep '
    + 'nine months of expenses in cash", "starting January my income goes up 10%", "pay the '
    + 'highest APR first", "for this scenario, …"), and to restate one ("actually make it 15%" '
    + 'replaces the staged raise). Each field takes exactly the shape the scenario tools take. '
    + 'Staged conditions are NOT remembered beyond this conversation, NOT current facts, and NOT '
    + 'results: nothing is calculated until a scenario runs. A standing preference the user wants '
    + 'kept for future conversations is a different thing, and is not this.',
  // ⚠️ THE KEYS ARE DERIVED; THE SHAPES ARE REFERENCED, NOT COPIED. Spreading
  // `SCENARIO_INPUTS` in here restated ~11 KB of schema that scenario_projection
  // already puts in every prompt. The model reads each shape there; this names the
  // same closed set of keys, and `pending-plan.ts` checks every entry against the
  // canonical literal exactly as the scenario would.
  parameters: obj({
    ...Object.fromEntries(scenarioAssumptionKeys().map((k) => {
      const t = (SCENARIO_INPUTS as Record<string, { type?: string }>)[k]?.type ?? 'object';
      return [k, { type: t, ...(t === 'array' ? { items: { type: 'object' } } : {}),
        description: `Exactly the shape of scenario_projection's \`${k}\`.` }];
    })),
    retract: { type: 'array', items: { type: 'string' },
      description: 'Ids of staged conditions the user has withdrawn (e.g. "p2").' },
    // ⚠️ MEASURED 1/6: "invest everything above the floor", after "pay highest APR
    // debt first", was sent with `replace: true` and the debt order left the plan —
    // the guard made it explicit, and the description had not said that naming the
    // NEXT destination is not withdrawing the first.
    replace: { type: 'boolean', description: 'Only when the user WITHDREW or CORRECTED part of a '
      + 'staged rule ("don\'t pay debt first after all", "actually from February"). Saying where '
      + 'money goes NEXT is not a withdrawal: "invest everything above the floor" after "pay the '
      + 'highest APR first" is `target: ["highest_apr","investments"]`, without `replace`.' },
    // ⚠️ THE REFUSAL NAMED A FLAG THIS TOOL DID NOT HAVE (found in S1). Staging a
    // second rule about the same thing from another date ("another 10% from July",
    // "a second raise in July") is refused until the call says which it is, and the
    // refusal says "stage it again with `inAddition: true`" — which this schema did
    // not declare, so the retry was refused as an unknown assumption.
    inAddition: { type: 'boolean', description: 'Only when the user stated a SECOND rule about the '
      + 'same thing from another date and BOTH apply ("then cut it another 10% starting July", "and '
      + 'another raise next year"). Not for a correction — that is `replace`.' },
  }),
  async run(a, ctx) {
    if (!ctx.plan || !ctx.turn) {
      return { unavailable: 'this conversation cannot hold staged conditions here, so nothing was '
        + 'staged. State the conditions in the scenario call itself.' };
    }
    // ⚠️ STAGING IS FOR BEFORE A SCENARIO RUNS, AND ONLY THEN. Measured: once a
    // scenario had run, "actually make the raise 15%" was STAGED 6/6 and nothing
    // re-ran, although the result said to run it — the recompute I1 held at 6/6
    // fell to 0/6. After a run, a change takes effect by running again with it; the
    // envelope carries every condition that ran, and a re-run merges nothing stale
    // because the staged plan is empty from the moment a scenario runs. One carrier
    // per phase: stated-not-run here, ran in the envelope.
    // Withdrawing is always allowed: a clause a run could not confirm is still held,
    // and the user must be able to take it back after the run as well as before.
    const onlyRetracting = Object.keys(a).every((k) => k === 'retract');
    if (ctx.plan.scenarioRan && !onlyRetracting) {
      return { unavailable: 'a scenario has ALREADY RUN in this conversation, so this change was '
          + 'NOT staged — staging holds conditions only until the first run',
        instead: 'run scenario_projection again now with the ACTIVE SCENARIO\'s arguments and this '
          + 'change applied to them (for the horizon the user asked about). That run is the answer.' };
    }
    const { retract, replace, inAddition, ...stage } = a;
    const r = stagePlan(ctx.plan.pending,
      { stage, replace: replace === true, inAddition: inAddition === true,
        retract: Array.isArray(retract) ? retract.filter((x): x is string => typeof x === 'string') : [] },
      { turn: Math.max(0, ctx.turn.userTexts.length - 1), evidence: ctx.turn });
    ctx.plan.pending = r.plan;
    return {
      staged: r.staged, retracted: r.retracted,
      ...(r.refused.length ? { notStaged: notAppliedEcho(r.refused) } : {}),
      ...(r.replacedFields.length ? { replacedFields: {
        fields: r.replacedFields,
        meaning: 'These fields REPLACED what was staged before — a merge cannot tell "instead" from '
          + '"then". If the user meant both (e.g. pay the highest-APR debt first, THEN invest the '
          + 'rest), stage the combined value, e.g. `target: ["highest_apr", "investments"]`.',
      } } : {}),
      heldNow: r.plan.clauses.map((c) => ({ id: c.id, [c.key]: c.value })),
      // S1 — what each held spending line CONTAINS, so a whole bucket is said when the
      // user is told it is held ("Dining — which includes groceries").
      ...(spendingLinesHeld(r.plan.clauses).length ? { spendingLines: {
        lines: spendingLinesHeld(r.plan.clauses),
        meaning: 'Tell the user what each held line contains — a WHOLE bucket (Dining includes '
          + 'groceries, Utilities includes rent) or the catch-all (Other) changes all of it.' } } : {}),
      meaning: 'Held for THIS conversation only and not yet run; nothing here is a figure. The next '
        + 'scenario run applies every condition in `heldNow` and says so. To answer with numbers, '
        + 'run the scenario.',
    };
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  getFinancialSnapshot, getSpending, measureFlows, getBaselines, getTransactions, getIncome,
  getInvestments,
  getNetWorthHistory, findInBalanceHistory, explainNetWorthComposition, projectCash,
  getPayDates, investmentScenario,
  scenarioProjection, scenarioCrossing, scenarioGoalSeek, reconcileProjection,
  stageAssumptions,
  ...MEMORY_TOOLS,
  describeFourthMeridian,
];

/** OpenAI function-tool definitions for the tool-capable arms. */
export function openAiToolSchemas(): unknown[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
