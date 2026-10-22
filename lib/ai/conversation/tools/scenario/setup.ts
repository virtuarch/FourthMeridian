/**
 * lib/ai/conversation/tools/scenario/setup.ts
 *
 * Scenario setup: argument resolution (`prepareScenario`), income/spending rule
 * conversion, liability lines, and derived-floor rebinding — shared by every
 * scenario tool.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import type { AccountsSectionData, AccountSummaryItem } from '@/lib/ai/types';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import type { CanonicalSpendingBaseline } from '@/lib/transactions/canonical-spending';
import { resolveTransformableCategory } from '@/lib/transactions/category-vocabulary';
import {
  monthlyRateAt, type ModelledInterestExclusion, type SpendingChangeOutcome, type SpendingChangeRule,
} from '@/lib/ai/forecast/assemble';
import { mergeIntoArgs, type Attribution } from '../../pending-plan';
import type {
  IncomeChangeOpKind, IncomeChangeResult, IncomeChangeRule, RatePeriodKind,
} from '@/lib/forecast/income-change';
import {
  monthEndsBetween, runScenarioLedger, expandContributions, ORIGIN, type Origin, type ContributionSpec,
  type LedgerResult, type PlannedMovement, type ReturnPeriod, type SpinePoint, type LiabilityLine,
  type AllocationTarget,
} from '../../scenario-ledger';
import {
  contributionName, outflowName, unknownContributionKeys, isAllocationTargetWord, refuseUnknownArguments,
  refuseUnknownItemKeys, boundedLabel, type RefusedInput,
} from '../../scenario-rules';
import { resolveMonthsOfExpensesFloor, type FloorDerivation } from '@/lib/ai/measures/baseline';
import { planCheckpoints, CADENCES, type Cadence, type CheckpointPlan } from '../../scenario-checkpoints';
import type { ToolContext, ToolDefinition } from '../types';
import { round2 } from '../shared/values';
import { absentIn } from '../shared/reads';
import { buildCashSpine } from '../shared/cash-spine';
import { originOf } from '../shared/origin';

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
export type ScenarioRun = LedgerResult & { floorDerivations: FloorDerivation[]; spendingChanges?: SpendingChangeOutcome };

export interface ScenarioOverrides {
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

export interface ScenarioSetup {
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

export async function prepareScenario(
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
