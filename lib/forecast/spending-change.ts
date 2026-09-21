/**
 * lib/forecast/spending-change.ts   (S1 — a dated change to future spending)
 *
 * WHAT "CUT DINING 20% FROM JANUARY" DOES TO THE SPENDING RATE, AND THE PROOF.
 *
 * ── Why the transformation is on the RATE ───────────────────────────────────
 * The projection spends at a RATE (`projection.ts`: "Income is DATED … Spending is
 * a RATE — it has no dates to fall anywhere"). A spending change is therefore a
 * change to that rate from a date, never a set of synthetic dated transactions —
 * which would re-create, in reverse, the thirteenth-paycheque error the interval
 * code warns about. The output is a PIECEWISE-CONSTANT schedule of daily rates over
 * the projected days, and the projection's one spend term integrates it.
 *
 * ── The reconciliation, which is the whole design ───────────────────────────
 * The total rate `R` stays what the projection already spends at. A category rate
 * `c_k` is the canonical ledger's line over the SAME averaged months. A rule never
 * transforms the total and a category independently; on every day `d`:
 *
 *     T(d) = max(0, R + Σ_k (c_k(d) − c_k))      then the TOTAL-scope rules on T(d)
 *
 * A category change moves the total by exactly its own delta, once. What no rule
 * names — other categories, uncategorised spending, refunds the lines could not
 * place (`R − Σ c_k`, which need not be zero) — stays inside `R`, untouched.
 *
 * ── Rules are INTERVALS, not history ────────────────────────────────────────
 * For each day, the rate is derived from the baseline and the rules ACTIVE ON THAT
 * DAY — never from whatever an earlier rule "left behind". A 20% cut for January to
 * March and a further 10% for February to April give 800 / 720 / 720 / 900 / 1000
 * on a 1,000 baseline; April is NOT 720, because the first rule has expired.
 * Active rules on one scope fold in ascending `from` (then id) — SCALE multiplies,
 * DELTA adds, SET_RATE replaces what the earlier-starting rules made of it — with a
 * rate never below zero at any step. Two DIFFERENT rules on the same scope from the
 * same date are refused: nothing orders them, and guessing would pick one silently.
 *
 * ⚠️ PURE. No DB, no clock, no model, no category vocabulary: a rule arrives with
 * its category already resolved (and its semantic class stated) by the caller.
 */

import { addDays, daysBetween } from './_time';

/** Days in an average month — the same constant the observed rate accrues by. */
export const DAYS_PER_MONTH = 365 / 12;

// ── The contract ─────────────────────────────────────────────────────────────

/**
 * Three operations. STOP is `SET_RATE 0` (or `SCALE 0`) — a second spelling of the
 * same arithmetic would be two answers to one question. There is no START: a
 * brand-new recurring expense is a new obligation, not a category change.
 */
export const SpendingChangeOp = {
  /** × a multiplier. "Cut Dining 20%" = 0.8. 0 stops it. */
  SCALE: 'SCALE',
  /** + a monthly amount, signed. "Spend $500 less on Shopping" = −500. */
  DELTA: 'DELTA',
  /** The rate becomes a stated monthly figure. "Travel at $300 a month." */
  SET_RATE: 'SET_RATE',
} as const;
export type SpendingChangeOpKind = typeof SpendingChangeOp[keyof typeof SpendingChangeOp];

/**
 * What a transformed category MEANS, from the vocabulary:
 *   DIRECT        the line is what its name says (Travel, Fee);
 *   WHOLE_BUCKET  the line holds more than its name (Dining holds groceries);
 *   RESIDUAL      the catch-all (Other).
 */
export type SpendingScopeClass = 'DIRECT' | 'WHOLE_BUCKET' | 'RESIDUAL';

export interface SpendingScope {
  /** The canonical vocabulary name. */
  category: string;
  class: SpendingScopeClass;
  /** What the line contains, verbatim from the vocabulary. */
  meaning: string;
}

export interface SpendingChangeRule {
  /** Stable within one call, so an execution can name its rule. */
  id: string;
  op: SpendingChangeOpKind;
  /** A resolved category, or null for TOTAL spending. */
  scope: SpendingScope | null;
  /** Inclusive — the first day the rule governs. */
  fromISO: string;
  /** Inclusive — the last day it governs. Omitted runs to the horizon. */
  toISO?: string;
  /** SCALE. 0.8 for "cut 20%". Not a percentage. */
  multiplier?: number;
  /** DELTA (signed) | SET_RATE (≥ 0). Per month. */
  monthly?: number;
}

/** The total rate being transformed, and where it came from. */
export interface SpendingBaseline {
  monthly: number;
  /**
   * The daily rate the projection ACCRUES this baseline at — its own figure, never
   * re-derived here. The observed rate converts by 365/12 and a stated level by the
   * mean Gregorian month; a schedule built on the other constant would move the
   * projection on days no rule governs. Every segment converts by `monthly / daily`.
   */
  daily: number;
  /** MEASURED — the observed average; STATED_TOTAL — the user's own monthly figure. */
  basis: 'MEASURED' | 'STATED_TOTAL';
  /** The averaged months, oldest first (the category rates are over the SAME months). */
  months: string[];
  /** The total per averaged month (MEASURED only). */
  values: number[];
}

/** One category line's rate over the averaged months. */
export interface CategoryRate {
  category: string;
  monthly: number;
  months: string[];
  values: number[];
}

/** A run of consecutive projected days at one rate. Both ends inclusive. */
export interface SpendingSegment {
  fromISO: string;
  toISO: string;
  monthly: number;
  daily: number;
}

/**
 * WHAT ONE RULE DID.
 *
 * ⚠️ `ran` IS WHETHER IT GOVERNED A PROJECTED DAY, never the presence of an
 * argument; `affectedProjection` is whether it changed the money. A rule that ran
 * and moved nothing (a cut to a line with no spending) says so.
 */
export interface SpendingChangeExecution {
  ruleId: string;
  op: SpendingChangeOpKind;
  scope: 'CATEGORY' | 'TOTAL';
  /** The line it transformed, with its class and meaning. Absent for TOTAL. */
  category?: SpendingScope;
  requested: { fromISO: string; toISO: string | null };
  /** The part of the requested window this projection covered; null when none. */
  governed: { fromISO: string; toISO: string } | null;
  /** The scope's baseline — the category line's, or the total's. */
  baseline: { monthly: number; basis: 'MEASURED' | 'STATED_TOTAL'; months: string[]; values: number[] };
  /**
   * The scope's monthly rate on the first governed day, from the rules that fold
   * BEFORE this one, and after this one's step. Null when it governed nothing.
   */
  monthlyBefore: number | null;
  monthlyAfter: number | null;
  /** This rule took a rate to zero on some governed day (a DELTA larger than the rate). */
  clampedAtZero: boolean;
  /**
   * Spending this rule removed over the projection (negative = added): the whole
   * schedule with every rule, against the same schedule without this one. Full
   * precision. ⚠️ Per-rule figures do not sum when rules overlap — the total is
   * `SpendingChangeResult.spendingRemoved`.
   */
  spendingRemoved: number;
  affectedProjection: boolean;
  /** Other rules on the same scope whose windows overlap this one's. */
  overlapsRules?: string[];
  ran: boolean;
  /** Required whenever `ran` is false. */
  reason?: string;
}

export interface RejectedSpendingChange { input: string; reason: string }

export interface SpendingChangeResult {
  /** The projected days (asOf, horizon], contiguous, adjacent equal rates merged. */
  schedule: SpendingSegment[];
  baseline: SpendingBaseline;
  /** The category lines the rules read, by name. */
  categoryRates: CategoryRate[];
  executions: SpendingChangeExecution[];
  rejected: RejectedSpendingChange[];
  /** Σ over projected days of (baseline − scheduled) daily spend. Positive = less spent. */
  spendingRemoved: number;
}

// ── Validation ───────────────────────────────────────────────────────────────

const isISO = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Why this rule cannot run at all, or null. A rule that cannot be represented is refused WHOLE. */
export function invalidSpendingChange(r: SpendingChangeRule): string | null {
  if (!Object.values(SpendingChangeOp).includes(r.op)) {
    return `\`${String(r.op)}\` is not an operation this contract has — it is one of `
      + `${Object.values(SpendingChangeOp).join(', ')}. To stop spending on something, SET_RATE 0.`;
  }
  if (!isISO(r.fromISO)) return '`from` must be a YYYY-MM-DD date.';
  if (r.toISO !== undefined && !isISO(r.toISO)) return '`to` must be a YYYY-MM-DD date.';
  if (r.toISO !== undefined && r.toISO < r.fromISO) return '`to` is before `from`.';
  if (r.op === SpendingChangeOp.SCALE) {
    if (!finite(r.multiplier)) return 'SCALE needs a `multiplier` (0.8 for "cut 20%").';
    if (r.monthly !== undefined) return 'SCALE is a percentage change and takes no `monthly` amount.';
    if (r.multiplier < 0) return 'a `multiplier` below 0 would make spending negative.';
    if (r.multiplier === 1) return 'a `multiplier` of 1 changes nothing, so there is no change to run.';
    return null;
  }
  if (r.multiplier !== undefined) return `${r.op} takes a \`monthly\` amount, not a \`multiplier\`.`;
  if (!finite(r.monthly)) return `${r.op} needs a \`monthly\` amount.`;
  if (r.op === SpendingChangeOp.DELTA && r.monthly === 0) return 'a DELTA of 0 changes nothing.';
  if (r.op === SpendingChangeOp.SET_RATE && r.monthly < 0) return 'a spending rate cannot be below 0.';
  return null;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

const TOTAL = '*';
const keyOf = (r: SpendingChangeRule) => r.scope?.category ?? TOTAL;
const byStart = (a: SpendingChangeRule, b: SpendingChangeRule) =>
  (a.fromISO < b.fromISO ? -1 : a.fromISO > b.fromISO ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One step of one rule on a rate. Returns the new rate and whether it hit zero. */
function step(rate: number, r: SpendingChangeRule): { rate: number; clamped: boolean } {
  const raw = r.op === SpendingChangeOp.SCALE ? rate * (r.multiplier as number)
    : r.op === SpendingChangeOp.DELTA ? rate + (r.monthly as number)
    : (r.monthly as number);
  return raw < 0 ? { rate: 0, clamped: true } : { rate: raw, clamped: false };
}

const active = (r: SpendingChangeRule, day: string, horizon: string) =>
  r.fromISO <= day && day <= (r.toISO ?? horizon);

/** The fold of the active rules on one scope, from its baseline, on one day. */
function foldScope(
  base: number, rules: readonly SpendingChangeRule[], day: string, horizon: string,
  clampedBy?: Set<string>,
): number {
  let rate = base;
  for (const r of rules) {
    if (!active(r, day, horizon)) continue;
    const s = step(rate, r);
    if (s.clamped) clampedBy?.add(r.id);
    rate = s.rate;
  }
  return rate;
}

/** The total rate on one day under a set of (sorted) rules. */
function totalOn(
  day: string, horizon: string, R: number, cats: ReadonlyMap<string, number>,
  byScope: ReadonlyMap<string, SpendingChangeRule[]>, clampedBy?: Set<string>,
): number {
  let t = R;
  for (const [k, rules] of byScope) {
    if (k === TOTAL) continue;
    const c = cats.get(k) ?? 0;
    t += foldScope(c, rules, day, horizon, clampedBy) - c;
  }
  t = Math.max(0, t);
  const agg = byScope.get(TOTAL);
  return agg ? foldScope(t, agg, day, horizon, clampedBy) : t;
}

/** Segment boundaries: every day on which some rule starts or stops governing. */
function boundaries(rules: readonly SpendingChangeRule[], start: string, horizon: string): string[] {
  const b = new Set<string>([start]);
  for (const r of rules) {
    if (r.fromISO > start && r.fromISO <= horizon) b.add(r.fromISO);
    const after = r.toISO ? addDays(r.toISO, 1) : null;
    if (after && after > start && after <= horizon) b.add(after);
  }
  return [...b].sort();
}

function scheduleOf(
  rules: readonly SpendingChangeRule[], start: string, horizon: string,
  base: SpendingBaseline, cats: ReadonlyMap<string, number>, clampedBy?: Set<string>,
): SpendingSegment[] {
  const R = base.monthly;
  // The base's own days-per-month; an unchanged segment keeps the base daily rate exactly.
  const perMonth = base.monthly > 0 && base.daily > 0 ? base.monthly / base.daily : DAYS_PER_MONTH;
  const dailyOf = (monthly: number) => (monthly === R ? base.daily : monthly / perMonth);
  if (start > horizon) return [];
  const byScope = new Map<string, SpendingChangeRule[]>();
  for (const r of [...rules].sort(byStart)) {
    byScope.set(keyOf(r), [...(byScope.get(keyOf(r)) ?? []), r]);
  }
  const bs = boundaries(rules, start, horizon);
  const out: SpendingSegment[] = [];
  bs.forEach((from, i) => {
    const to = i + 1 < bs.length ? addDays(bs[i + 1], -1) : horizon;
    // Constant across the segment by construction: no rule starts or stops inside it.
    const monthly = totalOn(from, horizon, R, cats, byScope, clampedBy);
    const last = out[out.length - 1];
    if (last && last.monthly === monthly) last.toISO = to;
    else out.push({ fromISO: from, toISO: to, monthly, daily: dailyOf(monthly) });
  });
  return out;
}

/**
 * Spend over the days AFTER `fromExclusiveISO` up to and including `toISO`, at the
 * base daily rate except where a segment says otherwise.
 *
 * ⚠️ THE ONE PLACE A SCHEDULE BECOMES MONEY. Written as the base accrual PLUS the
 * segments' departures from it, so that with no schedule the spend is exactly
 * `baseDaily × days` — the projection's arithmetic before S1, to the bit.
 */
export function spendOver(
  schedule: readonly SpendingSegment[] | null | undefined, baseDaily: number,
  fromExclusiveISO: string, toISO: string,
): number {
  const days = Math.max(0, daysBetween(fromExclusiveISO, toISO));
  let spend = baseDaily * days;
  if (!schedule || schedule.length === 0) return spend;
  const first = addDays(fromExclusiveISO, 1);
  for (const s of schedule) {
    const from = s.fromISO > first ? s.fromISO : first;
    const to = s.toISO < toISO ? s.toISO : toISO;
    if (from > to) continue;
    spend += (s.daily - baseDaily) * (daysBetween(from, to) + 1);
  }
  return spend;
}

/** The monthly rate in force ON a date (the base rate outside the schedule). */
export function monthlyRateAt(
  schedule: readonly SpendingSegment[] | null | undefined, baseMonthly: number, dateISO: string,
): number {
  const s = schedule?.find((x) => x.fromISO <= dateISO && dateISO <= x.toISO);
  return s ? s.monthly : baseMonthly;
}

/**
 * Apply dated spending rules to the spending rate over (asOf, horizon].
 *
 * Refusals are per rule and never partial: a malformed rule, and every rule in a
 * group that shares a scope AND a start date, is rejected by name with nothing of it
 * applied. The rest run.
 */
export function applySpendingChanges(args: {
  baseline: SpendingBaseline;
  categoryRates: readonly CategoryRate[];
  rules: readonly SpendingChangeRule[];
  /** The projection's own start: days AFTER this are projected. */
  asOfISO: string;
  horizonISO: string;
}): SpendingChangeResult {
  const { baseline, categoryRates, asOfISO, horizonISO } = args;
  const rejected: RejectedSpendingChange[] = [];
  const named = (id: string) => `\`spendingChanges\` rule ${id}`;

  const valid: SpendingChangeRule[] = [];
  for (const r of args.rules) {
    const bad = invalidSpendingChange(r);
    if (bad) rejected.push({ input: named(r.id), reason: bad });
    else valid.push(r);
  }
  // Same scope + same start date: nothing orders them, so none of them runs.
  const groups = new Map<string, SpendingChangeRule[]>();
  for (const r of valid) groups.set(`${keyOf(r)}|${r.fromISO}`, [...(groups.get(`${keyOf(r)}|${r.fromISO}`) ?? []), r]);
  const conflicted = new Set<string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const r of g) {
      conflicted.add(r.id);
      rejected.push({ input: named(r.id), reason: `rules ${g.map((x) => x.id).join(' and ')} both change `
        + `${r.scope ? r.scope.category : 'total spending'} from ${r.fromISO}, and nothing says which applies `
        + 'first, so NEITHER was applied. If one corrects the other, send only the correction; if both '
        + 'apply, give the second its own start date.' });
    }
  }
  const rules = valid.filter((r) => !conflicted.has(r.id));

  const cats = new Map(categoryRates.map((c) => [c.category, c.monthly]));
  const start = addDays(asOfISO, 1);
  const clampedBy = new Set<string>();
  const schedule = scheduleOf(rules, start, horizonISO, baseline, cats, clampedBy);
  const baseDaily = baseline.daily;
  const spent = (s: SpendingSegment[]) => spendOver(s, baseDaily, asOfISO, horizonISO);
  const scheduled = spent(schedule);
  const spendingRemoved = spendOver(null, baseDaily, asOfISO, horizonISO) - scheduled;

  const sorted = [...rules].sort(byStart);
  const executions: SpendingChangeExecution[] = [...args.rules].filter((r) => rules.includes(r)).map((r) => {
    const k = keyOf(r);
    const to = r.toISO ?? horizonISO;
    const gFrom = r.fromISO > start ? r.fromISO : start;
    const gTo = to < horizonISO ? to : horizonISO;
    const governed = gFrom <= gTo ? { fromISO: gFrom, toISO: gTo } : null;
    const cat = r.scope ? categoryRates.find((c) => c.category === r.scope!.category) : undefined;
    const scopeBase = r.scope ? (cat?.monthly ?? 0) : null;

    // Before / after on the first governed day: the scope's fold up to this rule.
    let monthlyBefore: number | null = null, monthlyAfter: number | null = null;
    if (governed) {
      const earlier = sorted.filter((x) => keyOf(x) === k && byStart(x, r) < 0);
      // A TOTAL rule's "before" is the total with every category change applied.
      const b0 = r.scope ? (scopeBase as number)
        : totalOn(governed.fromISO, horizonISO, baseline.monthly, cats,
          new Map([...groupByScope(sorted)].filter(([key]) => key !== TOTAL)));
      monthlyBefore = foldScope(b0, earlier, governed.fromISO, horizonISO);
      monthlyAfter = step(monthlyBefore, r).rate;
    }
    const without = scheduleOf(rules.filter((x) => x !== r), start, horizonISO, baseline, cats);
    const removed = spent(without) - scheduled;
    const overlaps = sorted.filter((x) => x !== r && keyOf(x) === k
      && x.fromISO <= to && (x.toISO ?? horizonISO) >= r.fromISO).map((x) => x.id);
    return {
      ruleId: r.id, op: r.op,
      scope: r.scope ? 'CATEGORY' as const : 'TOTAL' as const,
      ...(r.scope ? { category: r.scope } : {}),
      requested: { fromISO: r.fromISO, toISO: r.toISO ?? null },
      governed,
      baseline: r.scope
        ? { monthly: scopeBase as number, basis: 'MEASURED' as const, months: cat?.months ?? baseline.months, values: cat?.values ?? [] }
        : { monthly: baseline.monthly, basis: baseline.basis, months: baseline.months, values: baseline.values },
      monthlyBefore, monthlyAfter,
      clampedAtZero: clampedBy.has(r.id),
      spendingRemoved: removed,
      affectedProjection: Math.abs(removed) >= 0.005,
      ...(overlaps.length ? { overlapsRules: overlaps } : {}),
      ran: governed !== null,
      ...(governed ? {} : { reason: notRunReason(r, asOfISO, horizonISO) }),
    };
  });

  return { schedule, baseline, categoryRates: [...categoryRates], executions, rejected, spendingRemoved };
}

function groupByScope(sorted: readonly SpendingChangeRule[]): Map<string, SpendingChangeRule[]> {
  const m = new Map<string, SpendingChangeRule[]>();
  for (const r of sorted) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]);
  return m;
}

function notRunReason(r: SpendingChangeRule, asOfISO: string, horizonISO: string): string {
  if (r.fromISO > horizonISO) {
    return `it starts on ${r.fromISO}, after this projection ends (${horizonISO}), so it did NOT affect `
      + 'any figure here. The result is the same as without it.';
  }
  return `its window ends on ${r.toISO}, on or before ${asOfISO} — that spending has already happened `
    + 'and is measured, not projected — so it did NOT affect any figure here.';
}
