/**
 * lib/forecast/income-change.ts   (I1 — a dated change to future income)
 *
 * WHAT A RAISE DOES TO A SET OF DATED PAYCHEQUES, AND THE PROOF THAT IT DID IT.
 *
 * ── Why the transformation lives on the EVENTS ──────────────────────────────
 * The obvious home for "starting January my income increases 10%" is a sixth
 * `AssumptionDimension` in `./policy.ts`, beside the five suppositions that are
 * already there. It would have been wrong, and quietly so.
 *
 * `applyPolicy` feeds `forecastCash` — the LICENSED path. On a real Space that
 * path REFUSES, because every derived payroll amount carries `basis: UNKNOWN`
 * and FORECAST-3 will not guess a tax treatment. The answer therefore comes from
 * PROJECTION-1's `projectCash`, whose input is `{ openingCash, events, spending,
 * fromISO, toISO }` — and which never sees the policy at all. An income change
 * expressed only as a policy dimension would have appeared in every explanation
 * and moved no money: REQUESTED but not EXECUTED, arrived at by the most
 * respectable-looking route available.
 *
 * So the change is applied where a licensed stream becomes dated cash, to the
 * `FutureCashEvent[]` themselves — the one representation BOTH paths fold.
 *
 * ── Why this can prove it ran ───────────────────────────────────────────────
 * Every other scenario clause proves it executed by being read back off SETTLED
 * MOVEMENTS (`scenario-rules.ts`). An income change settles nothing — it changes
 * the shape of the cash curve the movements are settled AGAINST. So it carries
 * its own evidence, and the evidence is a DIFF: the occurrences this rule
 * actually altered, counted from the arrays before and after, with the dates at
 * either end. A caller cannot supply it, a label cannot forge it, and a rule that
 * matched nothing or fell outside the horizon reports `ran: false` WITH THE
 * REASON rather than inheriting the truth of its neighbours.
 *
 * The precedent is `liabilityAssumptions`, the one existing non-movement
 * transformation that is honestly evidenced: a provenance-tagged structure the
 * engine consumes and RETURNS. This generalises it.
 *
 * ── What this module refuses to do ──────────────────────────────────────────
 * It does not decide which transactions are salary — a rule names a `sourceKey`
 * the stream authority already minted, or it names nothing and means all of them.
 * It does not convert units — `./cadence.ts` owns every rate conversion, under
 * the evaluation order pinned there. It does not invent a date — governance is a
 * string comparison over dates `expectedOccurrencesBetween` already produced. It
 * does not touch a one-off event: an asserted bonus carries no `sourceKey`, so it
 * is not income-from-a-stream and no rule can reach it.
 *
 * ⚠️ PURE. No DB, no clock, no model. A function of values end to end.
 */

import {
  AmountBasis, EventProvenance, FlowRole,
  type AmountBasisKind, type FlowRoleKind, type FutureCashEvent,
} from './future-cash-event';
import {
  CadenceKind, occurrencesBetween, perOccurrenceFromAnnual, perOccurrenceFromMonthly,
  type Cadence, type CadenceKindName,
} from './cadence';

// ── The contract ─────────────────────────────────────────────────────────────

/**
 * The four things a dated income rule can be.
 *
 * ⚠️ FOUR, AND A ONE-OFF IS NOT ONE OF THEM. "I get a $20,000 bonus in December"
 * is a single dated movement and already has a deterministic, movement-evidenced
 * home: a negative `outflow` on the scenario ledger. Adding a fifth operation for
 * it here would be a second way to say the same thing, and the two would
 * eventually disagree about the same December.
 */
export const IncomeChangeOp = {
  /** × a multiplier. "Starting January my income increases 10%." */
  SCALE: 'SCALE',
  /** The rate becomes a stated figure. "Starting March I make $15,000 a month." */
  SET_RATE: 'SET_RATE',
  /** No occurrence from the boundary on. "This income stops after June." */
  STOP: 'STOP',
  /** A stream that did not exist. "Starting February I receive $3,000 a month." */
  START: 'START',
} as const;

export type IncomeChangeOpKind = typeof IncomeChangeOp[keyof typeof IncomeChangeOp];

/** What a stated `amount` is an amount PER. */
export const RatePeriod = {
  YEAR: 'YEAR',
  MONTH: 'MONTH',
  /** Per payment, at the stream's own cadence. */
  OCCURRENCE: 'OCCURRENCE',
} as const;

export type RatePeriodKind = typeof RatePeriod[keyof typeof RatePeriod];

/**
 * One rule, already typed. Whatever turned a sentence into this is somebody
 * else's problem — nothing here parses, matches or interprets English.
 */
export interface IncomeChangeRule {
  /** Stable within one call, so an execution record can name its rule. */
  id: string;
  op: IncomeChangeOpKind;
  /**
   * The stream this governs, or null for EVERY projection-eligible income stream.
   *
   * ⚠️ `null` IS THE EXISTING CONVENTION, not a new one: FORECAST-8's
   * `StreamContinuationAssumption.sourceKey` already means "every
   * projection-eligible stream" when it is null.
   */
  sourceKey: string | null;
  /** Inclusive. The first occurrence the rule governs — for STOP, the first NOT paid. */
  fromISO: string;
  /** Inclusive. Omitted runs to the horizon. */
  toISO?: string;
  /** SCALE. 1.1 for "+10%". */
  multiplier?: number;
  /** SET_RATE | START. */
  rate?: { amount: number; per: RatePeriodKind; basis: AmountBasisKind; currency?: string };
  /** START only — the schedule the new stream pays on. */
  cadence?: CadenceKindName;
  /** START only — the name of a THING ("consulting"), never a restatement of the rule. */
  label?: string;
}

/** The streams a rule may name, as this module needs to see them. */
export interface IncomeStreamRef {
  sourceKey: string;
  label?: string;
  /**
   * INCOME or INTEREST, as the flow classifier decided.
   *
   * ⚠️ AN AGGREGATE RULE REACHES INCOME STREAMS ONLY, never INTEREST. A pay rise
   * does not raise the interest a bank pays, and the repo's taxonomy separates
   * them (`income-source.ts`: EARNED_INCOME vs INTEREST_INCOME). A rule that
   * NAMES a stream may still name an interest one — the user who says "my
   * interest income stops when I close that account" means it, and has said which.
   *
   * ⚠️ AND ON THE REAL SPACE THIS FILTER CURRENTLY SEPARATES NOTHING, which is
   * worth knowing rather than believing otherwise. Measured: of 79 positive
   * inflow rows in a year, every one — including three bank interest streams —
   * carries `flowType: INCOME`; the single `INTEREST` row is a purchase interest
   * CHARGE. `streams.ts` derives a stream's role from `flowType` alone and never
   * consults `incomeClass`, so an unqualified rule on that Space reaches the
   * interest streams too. That is the classifier's verdict and this module does
   * not overrule it by matching names. What it does instead is SAY SO: an
   * aggregate rule reports every stream it reached, so a reader who meant only
   * the salary can see that and name it. The filter stays because it is correct
   * and will bind the day the classifier separates the two.
   */
  role: FlowRoleKind;
  /** Null when the schedule was never established — a rate has nothing to be a rate OF. */
  cadence: CadenceKindName | null;
  projectionEligible: boolean;
}

/**
 * WHAT ONE RULE DID, counted from the arrays it changed.
 *
 * ⚠️ `ran` IS COMPUTED FROM THE DIFF. It is never set from the presence of an
 * argument, never from a label, and never inherited from another rule. A rule
 * that matched no stream, or whose window falls outside the horizon, is a rule
 * that did not run — which is the truth about it, and which the answer may not
 * describe as included.
 */
export interface IncomeChangeExecution {
  ruleId: string;
  op: IncomeChangeOpKind;
  /**
   * Whether the rule NAMED an income or meant income as a whole.
   *
   * ⚠️ AN AGGREGATE IS A CHOICE THE USER DID NOT MAKE EXPLICITLY, so the result
   * says it made one. "My income increases 10%" reaching four streams is the
   * right reading of the sentence and the wrong reading of some of the people
   * who say it; naming what it reached is what lets that be corrected in one
   * turn instead of going unnoticed.
   */
  scope: 'NAMED' | 'EVERY_INCOME_STREAM';
  /** The streams this rule actually reached. Empty when it reached none. */
  matched: { sourceKey: string; label?: string }[];
  /** Occurrences whose amount this rule altered, or which it created or removed. */
  occurrencesChanged: number;
  firstChangedISO: string | null;
  lastChangedISO: string | null;
  /** The window as it was governed, clamped to the horizon it actually ran over. */
  governed: { fromISO: string; toISO: string };
  /** Nominal dated income inside the governed window, before and after. Full precision. */
  nominalBefore: number;
  nominalAfter: number;
  /**
   * Of that nominal income, how much the projection will actually COUNT AS CASH.
   *
   * ⚠️ A RULE CAN EXECUTE PERFECTLY AND LOWER THE PROJECTION. A stated GROSS rate
   * is real money and is NOT cash the user can spend (FORECAST-3), so replacing an
   * observed take-home level with a gross salary removes it from the projected
   * balance. That is correct, and it is exactly the result a reader would
   * otherwise call a bug.
   *
   * ⚠️ BUT IT IS A COMPARISON, NOT A PROPERTY OF THE RESULT. The first version of
   * this asked whether EVERY resulting occurrence was spendable, and a real Space
   * turned it red on an ordinary +10% — because two of the streams it reached
   * were already unspendable BEFORE the rule, and a rule is not answerable for
   * what it inherited. Reporting both sides is what lets a reader see whether the
   * rule took something away or merely passed it on.
   */
  spendableBefore: number;
  spendableAfter: number;
  /** Another rule in this call governs some of the same occurrences on the same stream. */
  overlapsRules?: string[];
  ran: boolean;
  /** Required whenever `ran` is false. Never absent. */
  reason?: string;
}

/** One input that was not applied, in the shape the scenario echo already carries. */
export interface RejectedIncomeChange { input: string; reason: string }

export interface IncomeChangeResult {
  events: FutureCashEvent[];
  executions: IncomeChangeExecution[];
  rejected: RejectedIncomeChange[];
}

// ── Validation ───────────────────────────────────────────────────────────────

const isISO = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The cadences a START may mint, and why the fourth is missing. */
const STARTABLE: readonly CadenceKindName[] = [
  CadenceKind.WEEKLY, CadenceKind.BIWEEKLY, CadenceKind.MONTHLY,
];

const SEMIMONTHLY_REFUSAL =
  'a SEMIMONTHLY stream lands on TWO days of the month (24 a year, not 26 and not 12), and a '
  + 'single start date cannot say which two. Starting one would silently generate a monthly '
  + 'schedule while counting a semimonthly rate. State the schedule as MONTHLY or BIWEEKLY, or '
  + 'tell the user this cadence cannot be started.';

/**
 * Why this rule cannot run at all, or null.
 *
 * ⚠️ A RULE THAT CANNOT BE REPRESENTED IS REFUSED WHOLE. Running "the rest of it"
 * — the dates without the amount, the scale without the window — is the silent
 * approximation the evidence rule forbids, and it is how a weaker scenario comes
 * to wear a stronger sentence.
 */
export function invalidIncomeChange(r: IncomeChangeRule): string | null {
  if (!Object.values(IncomeChangeOp).includes(r.op)) {
    return `\`${String(r.op)}\` is not an operation this contract has — it is one of `
      + `${Object.values(IncomeChangeOp).join(', ')}.`;
  }
  if (!isISO(r.fromISO)) return '`from` must be a YYYY-MM-DD date.';
  if (r.toISO !== undefined && !isISO(r.toISO)) return '`to` must be a YYYY-MM-DD date.';
  if (r.toISO !== undefined && r.toISO < r.fromISO) return '`to` is before `from`.';

  if (r.op === IncomeChangeOp.SCALE) {
    if (!finite(r.multiplier)) return 'SCALE needs a `multiplier` (1.1 for "+10%").';
    if (r.multiplier <= 0) {
      return 'a `multiplier` of 0 or less would make income negative or nil; to end an income '
        + 'use STOP, which says so.';
    }
    if (r.multiplier === 1) return 'a `multiplier` of 1 changes nothing, so there is no change to run.';
    if (r.rate || r.cadence) return 'SCALE takes a `multiplier` only — a rate or a cadence belongs to SET_RATE or START.';
    return null;
  }

  if (r.op === IncomeChangeOp.STOP) {
    if (r.multiplier !== undefined || r.rate || r.cadence) {
      return 'STOP takes only a date — it is the absence of income, and an amount cannot qualify it.';
    }
    return null;
  }

  if (r.op !== IncomeChangeOp.SET_RATE && r.op !== IncomeChangeOp.START) {
    return `\`${String(r.op)}\` is not an operation this contract has.`;
  }

  // SET_RATE | START
  const rate = r.rate;
  if (!rate) return `${r.op} needs a stated rate (\`amount\`, \`per\` and \`basis\`).`;
  // ⚠️ `per` IS NOT DEFAULTED. Guessing that "$180,000" meant a year — or a month
  // — is a unit conversion made by whoever wrote the default, and it is wrong by
  // a factor of twelve exactly half the time.
  if (rate.per !== RatePeriod.YEAR && rate.per !== RatePeriod.MONTH
    && rate.per !== RatePeriod.OCCURRENCE) {
    return '`per` must say what the amount is per: YEAR, MONTH or OCCURRENCE. It is never '
      + 'assumed — "$180,000" is a salary or a very good month, and only the user knows which.';
  }
  if (!finite(rate.amount) || rate.amount <= 0) {
    return 'a stated income rate must be greater than zero; to end an income use STOP.';
  }
  if (rate.basis !== AmountBasis.NET && rate.basis !== AmountBasis.GROSS) {
    return '`basis` must be NET or GROSS. Whether a stated payroll figure is take-home or '
      + 'before deductions cannot be guessed — a 30-40% wedge always flatters the forecast in '
      + 'the same direction — so it is asked for, never inferred.';
  }
  if (r.multiplier !== undefined) return `${r.op} takes a rate, not a \`multiplier\`.`;

  if (r.op === IncomeChangeOp.START) {
    if (!r.cadence) return 'START needs a `cadence` — a new stream has no observed schedule to inherit.';
    if (r.cadence === CadenceKind.SEMIMONTHLY) return SEMIMONTHLY_REFUSAL;
    if (!STARTABLE.includes(r.cadence)) return `\`${r.cadence}\` is not a schedule this contract can start.`;
    if (r.sourceKey !== null) {
      return 'START creates a stream, so it cannot name an existing one. To change an existing '
        + 'income use SCALE or SET_RATE.';
    }
    if (rate.per === RatePeriod.OCCURRENCE && !r.cadence) {
      return 'a per-occurrence rate needs the cadence those occurrences fall on.';
    }
  } else if (r.cadence) {
    return 'SET_RATE changes the rate of an existing stream and keeps that stream\'s own '
      + 'schedule; it cannot restate the cadence.';
  }
  return null;
}

// ── Units ────────────────────────────────────────────────────────────────────

/**
 * A stated rate as a per-occurrence amount on a given schedule.
 *
 * ⚠️ EVERY BRANCH DELEGATES. `$180,000 a year` on a BIWEEKLY stream is
 * `180000 ÷ 26 = 6,923.08` a paycheque — not `180000 ÷ 12 = 15,000`, which is the
 * answer prose reaches for and which is wrong by the whole difference between 26
 * and 12. The division is `cadence.ts`'s because the factor is.
 */
export function perOccurrence(
  amount: number, per: RatePeriodKind, kind: CadenceKindName,
): number {
  switch (per) {
    case RatePeriod.YEAR:  return perOccurrenceFromAnnual(amount, kind);
    case RatePeriod.MONTH: return perOccurrenceFromMonthly(amount, kind);
    case RatePeriod.OCCURRENCE: return amount;
  }
}

// ── Application ──────────────────────────────────────────────────────────────

const isStreamIncome = (e: FutureCashEvent): boolean =>
  e.direction === 'INFLOW' && typeof e.sourceKey === 'string' && e.sourceKey !== ''
  && (e.role === FlowRole.INCOME || e.role === FlowRole.INTEREST);

const nominal = (events: readonly FutureCashEvent[]): number =>
  events.reduce((s, e) => s + (e.amount?.value ?? 0), 0);

/**
 * ⚠️ THE PROJECTION'S OWN TEST, NOT A SECOND ONE. `observedCashContribution`
 * counts an occurrence when its basis is NET or when it was observed settling
 * into a depository account; anything else is real money that is not spendable
 * cash. Restating that rule here with a different shape is how the fold and the
 * report come to disagree about the same paycheque.
 */
const spendable = (e: FutureCashEvent): boolean =>
  e.amount !== null && (e.amount.basis === AmountBasis.NET || e.amount.observedSettled === true);

const spendableTotal = (events: readonly FutureCashEvent[]): number =>
  events.reduce((s, e) => s + (spendable(e) ? (e.amount?.value ?? 0) : 0), 0);

const dateOf = (e: FutureCashEvent): string | null =>
  e.timing.kind === 'EXACT' ? e.timing.dateISO : null;

/** The synthetic identity a STARTed stream carries, so a later rule can reach it. */
export const startedSourceKey = (ruleId: string): string => `i1:started:${ruleId}`;

/**
 * Apply dated income rules to a set of future cash events.
 *
 * Rules run IN THE ORDER GIVEN. That is the repo's existing convention for
 * statements ("order matters: for a given subject the LAST statement wins, so a
 * correction is expressed by appending"), and it makes composition explicit: a
 * raise then a replacement is a different world from a replacement then a raise,
 * and the caller has said which. Overlapping rules on one stream are not refused
 * — they are a legitimate way to describe a changing year — but each execution
 * NAMES the rules it overlaps, so a reader is never left to infer precedence.
 */
export function applyIncomeChanges(args: {
  events: readonly FutureCashEvent[];
  streams: readonly IncomeStreamRef[];
  rules: readonly IncomeChangeRule[];
  horizon: { fromISO: string; toISO: string };
  currency: string;
}): IncomeChangeResult {
  const { streams, horizon, currency } = args;
  let events: FutureCashEvent[] = [...args.events];
  const executions: IncomeChangeExecution[] = [];
  const rejected: RejectedIncomeChange[] = [];

  // Streams a rule may reach. A STARTed stream joins the set, so a LATER
  // aggregate rule governs it — which is what "my income goes up 10%" means once
  // the user has already said a second income begins.
  const known = new Map<string, IncomeStreamRef>(streams.map((s) => [s.sourceKey, s]));

  const named = (id: string) => `\`incomeChanges\` rule ${id}`;

  for (const rule of args.rules) {
    const bad = invalidIncomeChange(rule);
    if (bad !== null) { rejected.push({ input: named(rule.id), reason: bad }); continue; }

    const to = rule.toISO ?? horizon.toISO;
    const governed = { fromISO: rule.fromISO, toISO: to };

    // ── Which streams does it reach ──────────────────────────────────────────
    let targets: IncomeStreamRef[];
    if (rule.op === IncomeChangeOp.START) {
      targets = [];
    } else if (rule.sourceKey !== null) {
      const hit = known.get(rule.sourceKey);
      if (!hit) {
        rejected.push({ input: named(rule.id), reason:
          `no income stream is called \`${rule.sourceKey}\`. The streams this Space has are `
          + `${[...known.values()].map((s) => `\`${s.sourceKey}\`${s.label ? ` ("${s.label}")` : ''}`).join(', ') || '(none)'}`
          + ' — name one of those, or ask the user which income they mean. Do not guess.' });
        continue;
      }
      targets = [hit];
    } else {
      // ⚠️ EARNED INCOME ONLY, when the user named no source. See `IncomeStreamRef.role`.
      targets = [...known.values()]
        .filter((s) => s.projectionEligible && s.role === FlowRole.INCOME);
      // ⚠️ AGGREGATE IS DEFENSIBLE FOR A SCALE AND AMBIGUOUS FOR THE OTHER TWO.
      // "My income increases 10%" means all of it goes up by a tenth, whatever the
      // streams are. "I make $15,000 a month from March" against three streams
      // could mean replace all income or replace the salary, and those are
      // different worlds. So it is refused and the streams are named.
      if (rule.op !== IncomeChangeOp.SCALE && targets.length > 1) {
        rejected.push({ input: named(rule.id), reason:
          `${rule.op} did not say WHICH income it is about, and this Space has `
          + `${targets.length} income streams (${targets.map((s) => `"${s.label ?? s.sourceKey}"`).join(', ')}). `
          + 'Replacing or ending "income" could mean one of them or all of them, and those are '
          + 'different results — so nothing was applied. Name a `source`, or ask the user which '
          + 'income they mean.' });
        continue;
      }
      if (targets.length === 0) {
        rejected.push({ input: named(rule.id), reason:
          'no EARNED income stream in this Space is licensed to continue into the projection, so '
          + 'there is nothing an unqualified income change can reach. Interest is not raised by a '
          + 'pay rise and is left alone unless a rule names it; if that is what the user meant, '
          + 'name the stream with `source`.' });
        continue;
      }
    }

    const keys = new Set(targets.map((s) => s.sourceKey));
    const governs = (e: FutureCashEvent): boolean => {
      const d = dateOf(e);
      return d !== null && d >= rule.fromISO && d <= to
        && isStreamIncome(e) && keys.has(e.sourceKey as string);
    };

    const before = events.filter(governs);
    const nominalBefore = nominal(before);
    const spendableBefore = spendableTotal(before);
    let changed = 0;
    let after: FutureCashEvent[] = [];

    if (rule.op === IncomeChangeOp.STOP) {
      events = events.filter((e) => !governs(e));
      changed = before.length;
      after = [];
    } else if (rule.op === IncomeChangeOp.SCALE) {
      const m = rule.multiplier as number;
      events = events.map((e) => {
        if (!governs(e) || e.amount === null) return e;
        changed += 1;
        return { ...e,
          // ⚠️ BASIS AND `observedSettled` ARE PRESERVED. A tenth more of an
          // observed net deposit is still money of the same kind, and the
          // gross-or-net question the basis answers has not changed. What DOES
          // change is who says so: the level is no longer purely observed, so the
          // provenance becomes HYPOTHETICAL — the value FORECAST-3 minted and
          // reserved in writing for exactly a supposition like this.
          amount: { ...e.amount, value: e.amount.value * m,
            provenance: EventProvenance.HYPOTHETICAL } };
      });
      after = events.filter(governs);
    } else if (rule.op === IncomeChangeOp.SET_RATE) {
      const rate = rule.rate as NonNullable<IncomeChangeRule['rate']>;
      const stream = targets[0];
      if (stream.cadence === null) {
        rejected.push({ input: named(rule.id), reason:
          `"${stream.label ?? stream.sourceKey}" has no established pay schedule, so a rate has `
          + 'nothing to be a rate of — the occurrences it would apply to are not known. Nothing '
          + 'was applied.' });
        continue;
      }
      const value = perOccurrence(rate.amount, rate.per, stream.cadence);
      events = events.map((e) => {
        if (!governs(e)) return e;
        changed += 1;
        return { ...e,
          amount: { value, currency: rate.currency || currency, basis: rate.basis,
            provenance: EventProvenance.HYPOTHETICAL } };
      });
      after = events.filter(governs);
    } else {
      // START — mint a schedule and its occurrences.
      const rate = rule.rate as NonNullable<IncomeChangeRule['rate']>;
      const kind = rule.cadence as CadenceKindName;
      const sourceKey = startedSourceKey(rule.id);
      const cadence: Cadence = {
        kind, anchorISO: rule.fromISO, provenance: 'USER_ASSERTED', sourceKey,
        ...(kind === CadenceKind.MONTHLY
          ? { daysOfMonth: [Number(rule.fromISO.slice(8, 10))] } : {}),
      };
      // Clamped to the horizon: a stream that starts after the projection ends
      // produces nothing, and says so rather than producing dates nobody folds.
      const from = rule.fromISO > horizon.fromISO ? rule.fromISO : horizon.fromISO;
      const until = to < horizon.toISO ? to : horizon.toISO;
      const value = perOccurrence(rate.amount, rate.per, kind);
      const minted = occurrencesBetween(cadence, from, until).map((dateISO): FutureCashEvent => ({
        id: `i1:${rule.id}:${sourceKey}@${dateISO}`,
        timing: { kind: 'EXACT', dateISO },
        timingProvenance: EventProvenance.HYPOTHETICAL,
        direction: 'INFLOW',
        role: FlowRole.INCOME as FlowRoleKind,
        amount: { value, currency: rate.currency || currency, basis: rate.basis,
          provenance: EventProvenance.HYPOTHETICAL },
        sourceKey,
      }));
      events = [...events, ...minted];
      changed = minted.length;
      after = minted;
      if (minted.length > 0) {
        // ⚠️ A STARTED STREAM IS EARNED INCOME, so a LATER unqualified "my income
        // goes up 10%" reaches it — which is what the sentence means once the user
        // has already said a second income begins.
        known.set(sourceKey, { sourceKey, ...(rule.label ? { label: rule.label } : {}),
          role: FlowRole.INCOME, cadence: kind, projectionEligible: true });
      }
    }

    const dates = (rule.op === IncomeChangeOp.STOP ? before : after)
      .map(dateOf).filter((d): d is string => d !== null).sort();

    const overlaps = executions
      .filter((x) => x.ran && x.matched.some((m) => keys.has(m.sourceKey))
        && x.governed.fromISO <= to && x.governed.toISO >= rule.fromISO)
      .map((x) => x.ruleId);

    const ran = changed > 0;
    executions.push({
      ruleId: rule.id, op: rule.op,
      scope: rule.op === IncomeChangeOp.START || rule.sourceKey !== null
        ? 'NAMED' : 'EVERY_INCOME_STREAM',
      matched: (rule.op === IncomeChangeOp.START
        ? (ran ? [{ sourceKey: startedSourceKey(rule.id), ...(rule.label ? { label: rule.label } : {}) }] : [])
        : targets.map((s) => ({ sourceKey: s.sourceKey, ...(s.label ? { label: s.label } : {}) }))),
      occurrencesChanged: changed,
      firstChangedISO: dates[0] ?? null,
      lastChangedISO: dates[dates.length - 1] ?? null,
      governed,
      nominalBefore,
      nominalAfter: nominal(after),
      spendableBefore,
      spendableAfter: spendableTotal(after),
      ...(overlaps.length ? { overlapsRules: overlaps } : {}),
      ran,
      ...(ran ? {} : { reason: notRunReason(rule, horizon) }),
    });
  }

  return { events, executions, rejected };
}

/**
 * Why a well-formed rule that reached a stream still changed nothing.
 *
 * ⚠️ NEVER ABSENT ON `ran: false`. "It did not run" without a reason is the shape
 * a reader fills in with a guess, and the guess is usually "it must have applied
 * anyway".
 */
function notRunReason(r: IncomeChangeRule, horizon: { fromISO: string; toISO: string }): string {
  const to = r.toISO ?? horizon.toISO;
  if (r.fromISO > horizon.toISO) {
    return `it starts on ${r.fromISO}, after this projection ends (${horizon.toISO}), so it did `
      + 'NOT affect any figure here. The result is the same as without it.';
  }
  if (to < horizon.fromISO) {
    return `its window ends on ${to}, before this projection begins (${horizon.fromISO}), so it `
      + 'did NOT affect any figure here.';
  }
  return `no pay date falls in ${r.fromISO}..${to}, so there was no occurrence to change. The `
    + 'figures here were computed without it.';
}
