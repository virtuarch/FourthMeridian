/**
 * lib/ai/conversation/tools/projection.ts
 *
 * Cash projection: `project_cash` and `reconcile_projection`, with the FIN-001
 * incompleteness block and projection qualification they share.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { projectInterval } from '@/lib/ai/forecast/assemble';
import { NOT_AN_ASSUMPTION } from '../scenario-inputs';
import { elapsedBetween } from '../scenario-crossing';
import { refuseUnknownArguments, notAppliedEcho } from '../scenario-rules';
// ⚠️ READING memory, never writing it. `recallMemories` is the store's read half;
// the write half lives in the turn loop (slice 7) and in `remember`. This file
// still holds no Prisma client, which a test asserts.
import { recallMemories, MemoryKind } from '../memory-store';
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
} from '../reconcile';
import {
  incomeCompleteness, isOmittedLine, type IncomeCompleteness,
} from '@/lib/ai/forecast/income-completeness';
import {
  planCheckpoints, compactExcludedEvents, describePlan, CADENCES, type Cadence, type CheckpointPlan,
} from '../scenario-checkpoints';
import type { ToolDefinition } from './types';
import { obj, str, num } from './shared/schema';
import { round2 } from './shared/values';
import { historicalSnapshot } from './shared/historical-snapshot';
import { buildCashSpine } from './shared/cash-spine';
import { originOf } from './shared/origin';

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

export const projectCash: ToolDefinition = {
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

export const reconcileProjection: ToolDefinition = {
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
