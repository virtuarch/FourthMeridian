/**
 * lib/ai/conversation/scenario-ledger.ts
 *
 * THE SCENARIO LEDGER — the one piece of arithmetic the repository does not
 * already own, at the smallest size that retires three turns of prose maths.
 *
 * ⚠️ IT IS A LEDGER OVER AN EXISTING SPINE, NOT A SECOND PROJECTION. Cash at
 * every checkpoint arrives already computed, from `projectCash(asOf → that
 * date)` — the same authority, re-run independently per checkpoint, exactly as
 * the checkpoint invariant established. Nothing here forecasts cash, infers a
 * rate, or reads a transaction. It applies movements the spine cannot know
 * about, because the user has only just stated them.
 *
 * ⚠️ THE USER SUPPLIES EVERY ASSUMPTION. Returns and contributions come from the
 * person, never from history, never from a market average, and the default
 * return is ZERO. An unstated return must not quietly become optimism. This is
 * the same rule `scenario.ts` follows for a one-instant move, extended over
 * time.
 *
 * ── Why it cannot double count ──────────────────────────────────────────────
 * A contribution is ONE movement recorded twice with opposite signs, in the same
 * step: cash goes down by the amount, investments go up by the same amount. At
 * a zero return the composed net worth at that checkpoint is therefore
 * unchanged, and a test asserts precisely that. There is no event, no second
 * projection, and nothing for the two halves to drift apart from.
 *
 * ── Why every checkpoint is computed from the opening ───────────────────────
 * Investments at date d are `opening × G(asOf, d) + Σ contribution × G(c, d)` —
 * never last checkpoint's balance carried forward. Carrying forward accumulates
 * rounding and, worse, lets a series drift away from the endpoint the same
 * inputs produce for the same horizon. Independence is what makes the last
 * checkpoint equal a standalone run by construction rather than by luck.
 *
 * ⚠️ RESEARCH CODE, UNDER scripts/ ON PURPOSE, like `scenario.ts` beside it. It
 * has no production caller. If the experiment shows the product needs it, it
 * moves to lib/ with the rest of the canonical arithmetic — not before.
 */

// ── Provenance ───────────────────────────────────────────────────────────────

/**
 * Where a figure came from. A LIST, not a lattice.
 *
 * ⚠️ THE POINT IS THAT A STATED RETURN CAN NEVER BE READ AS MEASURED. Every line
 * carries the full set of sources that produced it, so a balance built from an
 * observed opening plus a hypothetical 8% says both — rather than picking the
 * more flattering of the two, or a single label that has to mean "some of each".
 */
export const PROVENANCE = {
  /** An observed balance from a financial authority. */
  MEASURED: 'MEASURED',
  /** The cash spine: observed payroll cadence and observed spending, projected. */
  PROJECTED_FROM_EVIDENCE: 'PROJECTED_FROM_EVIDENCE',
  /** Carried forward unchanged because nothing was stated about it. */
  HELD_FLAT: 'HELD_FLAT',
  /** A return or a contribution the user supplied. Never derived from history. */
  USER_ASSUMED: 'USER_ASSUMED',
} as const;

export type ProvenanceKind = typeof PROVENANCE[keyof typeof PROVENANCE];

/** One money figure and everything that produced it. */
export interface LedgerLine {
  amount:     number;
  provenance: ProvenanceKind[];
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/**
 * A dated cash movement as the user STATED it — which is not always an amount.
 *
 * ⚠️ "INVEST HALF MY LIQUIDITY EACH YEAR" IS A RULE, NOT A NUMBER, and the first
 * live run proved a fixed amount cannot carry it: asked to redo the table that
 * way, the model filled in `amount: -0.5` — a fifty-cent withdrawal — and the
 * answer came back arithmetically flawless and about a different question. Half
 * of the balance is only knowable at each date, from the projection.
 *
 * Exactly one of `amount`, `fractionOfLiquid` and `surplusFraction` is set.
 * Amounts are SIGNED: positive moves cash into investments, negative takes it
 * back out.
 */
export interface PlannedMovement {
  date:   string;
  label:  string;
  amount?: number;
  /** A share of the projected cash BALANCE on that date: 0.5 for "half". */
  fractionOfLiquid?: number;
  /**
   * A share of the month's projected cash SURPLUS: 0.75 for "invest three
   * quarters of what I'm putting aside".
   *
   * ⚠️ A DIFFERENT BASE FROM `fractionOfLiquid`, AND THE DIFFERENCE IS THE WHOLE
   * POINT. A share of the balance sweeps everything the account holds, every
   * month, including money that was already there — measured on the live Space,
   * 0.75 of the balance monthly drains cash to about $2,300 and holds it there.
   * A share of the surplus touches only what the month ADDED, so the opening
   * balance is never swept and a month that adds nothing contributes nothing.
   */
  surplusFraction?: number;
  /**
   * The date whose projected balance opens the month this movement closes.
   * Present only for a surplus share; absent means the projection's own start,
   * whose balance is the opening cash.
   */
  baseDate?: string;
}

/** A movement with its amount settled, ready to apply. */
export interface DatedMovement {
  date:   string;
  amount: number;
  label:  string;
  /** The share it was stated as, when it was stated as a share of the balance. */
  fractionOfLiquid?: number;
  /** The share it was stated as, when it was stated as a share of the surplus. */
  surplusFraction?: number;
  /**
   * The month's projected cash movement this contribution was taken from.
   *
   * ⚠️ THE RULE IS COMPACT; THE MONEY IS NOT. "75% of the surplus" is one
   * sentence and forty different amounts, and a reader owed the second cannot
   * check the first without it. Negative when the month projected a fall — the
   * contribution is then zero, and saying so is the difference between a month
   * that was skipped and a month that was never there.
   */
  projectedSurplus?: number;
}

/**
 * A stated return over a period. `toISO` is INCLUSIVE, because a person writing
 * "8% for 2027" writes `2027-01-01 .. 2027-12-31` and means a whole year.
 * Internally the period runs to the following day so adjacent years tile exactly.
 */
export interface ReturnPeriod {
  fromISO:   string;
  toISO:     string;
  annualPct: number;
}

/**
 * What the user said about putting money in — one date, a repeating schedule, or
 * a standing share of what each month adds.
 *
 * ⚠️ THE SURPLUS RULE CARRIES NO CADENCE, because it has only one. A month's
 * surplus is a monthly fact: the cash spine is month-grain, the solver already
 * works in month-ends, and a "yearly share of the monthly surplus" is not a
 * thing anybody means. Offering a cadence that has one legal value invites a
 * caller to state the illegal one.
 */
export type ContributionSpec =
  | { onDate: string; amount?: number; fractionOfLiquid?: number; label?: string }
  | { from: string; to?: string; amount?: number; fractionOfLiquid?: number;
      cadence: 'monthly' | 'yearly'; label?: string }
  | { surplusFraction: number; from?: string; to?: string; label?: string };

export interface LedgerOpening {
  asOfISO:     string;
  /**
   * Observed spendable cash — checking PLUS savings, the same population
   * `get_financial_snapshot` and `get_net_worth_history` call `liquid`.
   *
   * ⚠️ IT IS NOT CALLED `cash`, AND THAT IS THE BETA BLOCKER SPEAKING. The
   * exploration tree's `cash` lens is the checking bucket ALONE; on 2026-01-01
   * the two differ by $8,262.26. A 2030 net-worth table with a column headed
   * "cash" sitting beside a `cash` lens worth a seventh of it is the identical
   * contradiction slice 1 removed, four years further out where nobody can
   * check it.
   */
  liquid:      number;
  /** Observed investments — traditional + digital, from the canonical composer. */
  investments: number;
  /** Observed liabilities. */
  debt:        number;
  /**
   * Everything else the accounts authority counts as an asset: property,
   * vehicles, anything not cash and not an investment. Held flat, and named so a
   * house cannot silently vanish from a five-year net-worth table.
   */
  otherAssets: number;
}

/**
 * Spendable cash on a date, computed by the spine. Null when it refused.
 *
 * ⚠️ NOT EVERY POINT IS A CHECKPOINT. A movement stated as a share of the balance
 * needs the projection on ITS OWN date, which is rarely a month or year end, so
 * the caller evaluates those dates too and marks them. Reporting them as
 * checkpoints would put rows in the table that nobody asked for.
 */
export interface SpinePoint {
  date:   string;
  liquid: number | null;
  isCheckpoint: boolean;
}

export interface LedgerInput {
  opening:       LedgerOpening;
  spine:         readonly SpinePoint[];
  contributions: readonly PlannedMovement[];
  outflows:      readonly PlannedMovement[];
  returns:       readonly ReturnPeriod[];
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface LedgerCheckpoint {
  date: string;
  liquid:      LedgerLine | null;
  investments: LedgerLine;
  debt:        LedgerLine;
  otherAssets: LedgerLine;
  netWorth:    LedgerLine | null;
  movements: {
    contributionsToDate: { count: number; total: number };
    outflowsToDate:      { count: number; total: number };
    /** investments − opening − contributions. The part the stated return produced. */
    investmentGrowthToDate: number;
    sincePreviousCheckpoint: { contributions: number; outflows: number };
  };
  /** Present when the spine could not produce cash for this date. */
  unavailable?: string;
}

export interface LedgerResult {
  opening: LedgerOpening & { netWorth: number };
  checkpoints: LedgerCheckpoint[];
  /**
   * Every movement with its amount settled, in the order it was applied.
   *
   * ⚠️ A SHARE RESOLVES TO A DIFFERENT NUMBER EVERY YEAR, and the user is owed
   * those numbers. "Half my liquidity" is the instruction; $19,193 then $45,292
   * is what it turned out to mean, and only the second of those can be checked.
   */
  movements: (DatedMovement & { kind: 'CONTRIBUTION' | 'OUTFLOW' })[];
  /** Inputs that were not applied, with the reason. Never silently dropped. */
  rejected: { input: string; reason: string }[];
  /** Things that happened and are worth saying out loud, e.g. cash going negative. */
  warnings: string[];
  basis: string;
}

export const LEDGER_BASIS =
  'A ledger over the deterministic cash projection. Cash at each checkpoint is the '
  + 'projection re-run from today to that date; the contributions, one-off amounts and '
  + 'returns are exactly what the user stated and nothing was inferred from history. '
  + 'Investment growth compounds at the stated annual rate over actual days (365-day '
  + 'year). Debt and any other assets are held flat. This is arithmetic over stated '
  + 'assumptions, not a forecast of markets.';

// ── Date helpers ─────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const utc  = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const iso  = (ms: number)  => new Date(ms).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((utc(b) - utc(a)) / MS_PER_DAY);
const nextDay = (d: string) => iso(utc(d) + MS_PER_DAY);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The same calendar day `n` months on, clamped into the target month.
 *
 * Always measured from the ORIGINAL date rather than stepped one month at a
 * time, so a schedule starting on the 31st does not walk itself back to the 28th
 * and stay there for the rest of the horizon.
 */
export function addMonths(startISO: string, n: number): string {
  const d = new Date(utc(startISO));
  const dom = d.getUTCDate();
  const firstOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(
    firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();
  firstOfTarget.setUTCDate(Math.min(dom, lastDay));
  return firstOfTarget.toISOString().slice(0, 10);
}

// ── Returns ──────────────────────────────────────────────────────────────────

/** Guard against a runaway schedule turning into an unbounded loop. */
export const MAX_EXPANDED_CONTRIBUTIONS = 600;

/**
 * Every calendar month-end strictly after `fromISO` and not after `toISO`, plus
 * `toISO` itself when it is not already one.
 *
 * ⚠️ THE LAST ENTRY IS ALWAYS THE HORIZON, which is what makes the final
 * checkpoint and the standalone endpoint the same number rather than nearly.
 *
 * ⚠️ IT LIVES HERE NOW BECAUSE THE LEDGER NEEDS IT. A surplus share is a monthly
 * fact and has to generate its own dates; `tools.ts` re-exports this so every
 * existing caller is unmoved, and there is still exactly one implementation.
 */
export function monthEndsBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const from = new Date(`${fromISO}T00:00:00.000Z`);
  const to   = new Date(`${toISO}T00:00:00.000Z`);
  const cur  = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  while (cur <= to) {
    const iso = cur.toISOString().slice(0, 10);
    if (iso > fromISO) out.push(iso);
    cur.setUTCMonth(cur.getUTCMonth() + 2, 0);
  }
  if (out[out.length - 1] !== toISO && toISO > fromISO) out.push(toISO);
  return out;
}

/**
 * Reject overlapping return periods rather than silently applying both.
 *
 * Two rates in force at once has no honest reading — neither "the later one
 * wins" nor "multiply them" is what anybody meant — so the ledger says which
 * pair collided and applies neither.
 */
export function validateReturns(
  periods: readonly ReturnPeriod[],
): { ok: ReturnPeriod[]; rejected: { input: string; reason: string }[] } {
  const rejected: { input: string; reason: string }[] = [];
  const ok: ReturnPeriod[] = [];
  for (const p of periods) {
    const name = `return ${p.annualPct}% ${p.fromISO}..${p.toISO}`;
    if (!Number.isFinite(p.annualPct)) {
      rejected.push({ input: name, reason: 'the stated rate is not a number' }); continue;
    }
    if (p.toISO < p.fromISO) {
      rejected.push({ input: name, reason: 'the period ends before it starts' }); continue;
    }
    const clash = ok.find((q) => p.fromISO <= q.toISO && q.fromISO <= p.toISO);
    if (clash) {
      rejected.push({ input: name,
        reason: `overlaps ${clash.annualPct}% ${clash.fromISO}..${clash.toISO}; `
          + 'two return rates cannot both be in force, so neither was applied to the overlap' });
      continue;
    }
    ok.push(p);
  }
  return { ok, rejected };
}

/**
 * The compounding factor between two dates under the stated periods.
 *
 * ⚠️ THE SPAN IS HALF-OPEN AND THAT IS DELIBERATE. Growth from a date to itself
 * is zero, and a 31 December checkpoint is 364 days after 1 January — not a full
 * year. Rounding it up to a clean ×1.08 would flatter every table by the width
 * of a day, forever, and the difference would never appear in any test.
 *
 * A date not covered by any stated period grows at 0%. There is no default rate.
 */
export function growthFactor(
  periods: readonly ReturnPeriod[], fromISO: string, toISO: string,
): number {
  if (toISO <= fromISO) return 1;
  let factor = 1;
  for (const p of periods) {
    const start = p.fromISO > fromISO ? p.fromISO : fromISO;
    // `toISO` on a period is inclusive; the exclusive bound is the next day.
    const periodEnd = nextDay(p.toISO);
    const end = periodEnd < toISO ? periodEnd : toISO;
    if (end <= start) continue;
    factor *= Math.pow(1 + p.annualPct / 100, days(start, end) / 365);
  }
  return factor;
}

// ── Contributions ────────────────────────────────────────────────────────────

/**
 * Turn what the user said into dated movements.
 *
 * Amounts are SIGNED: positive moves cash into investments, negative takes it
 * back out. Nothing is clamped to the balance available — a plan that spends
 * money the projection does not have is reported as a negative cash checkpoint
 * with a warning, because silently shrinking somebody's stated contribution is
 * how a scenario stops answering the question that was asked.
 */
export function expandContributions(
  specs: readonly ContributionSpec[], asOfISO: string, horizonISO: string,
): { movements: PlannedMovement[]; rejected: { input: string; reason: string }[] } {
  const movements: PlannedMovement[] = [];
  const rejected: { input: string; reason: string }[] = [];

  for (const spec of specs) {
    const label = spec.label ?? ('cadence' in spec
      ? `${spec.cadence} contribution` : 'one-off contribution');
    const hasSurplus  = 'surplusFraction' in spec && spec.surplusFraction !== undefined;
    const hasAmount   = 'amount' in spec && spec.amount !== undefined;
    const hasFraction = 'fractionOfLiquid' in spec && spec.fractionOfLiquid !== undefined;
    const stated = hasSurplus ? `${(spec as { surplusFraction: number }).surplusFraction * 100}% of monthly surplus`
      : hasFraction ? `${(spec as { fractionOfLiquid: number }).fractionOfLiquid * 100}% of cash`
      : String((spec as { amount?: number }).amount);
    const name = 'onDate' in spec
      ? `${label} ${stated} on ${spec.onDate}`
      : 'cadence' in spec
        ? `${label} ${stated} ${spec.cadence} from ${spec.from}`
        : `${label} ${stated} monthly from ${('from' in spec && spec.from) || asOfISO}`;

    // ⚠️ ONE BASIS PER RULE, AND NEITHER IS THE DEFAULT. A rule naming two bases
    // is a rule whose author had two different scenarios in mind; picking one of
    // them silently would answer a question nobody asked, in a table that looks
    // exactly as authoritative as a right one.
    const bases = [hasAmount, hasFraction, hasSurplus].filter(Boolean).length;
    if (bases !== 1) {
      rejected.push({ input: name,
        reason: 'state EXACTLY ONE of: an amount in dollars, `fractionOfLiquid` for a share of '
          + 'the cash balance, or `surplusFraction` for a share of the month\'s projected surplus' });
      continue;
    }

    // ── A share of what each month adds ────────────────────────────────────
    if (hasSurplus) {
      const f = (spec as { surplusFraction: number }).surplusFraction;
      if (!Number.isFinite(f) || f <= 0 || f > 1) {
        rejected.push({ input: name,
          reason: 'a share of the surplus must be greater than 0 and at most 1 (0.75 for three quarters)' });
        continue;
      }
      const sFrom = 'from' in spec && spec.from && spec.from > asOfISO ? spec.from : asOfISO;
      const sTo   = 'to' in spec && spec.to && spec.to < horizonISO ? spec.to : horizonISO;
      if (sFrom >= sTo) {
        rejected.push({ input: name, reason: 'the window ends before the projection starts' });
        continue;
      }
      // ⚠️ MONTH-ENDS, GENERATED, AND THE BASE TRAVELS WITH THE MOVEMENT. Each
      // contribution closes one month; the month it closes opens at the previous
      // month-end, or at the projection's own start for the first one. Carrying
      // that date here is what lets the settler subtract two balances it can see
      // rather than infer a neighbour from whatever else is in the spine.
      // ⚠️ THE GRID RUNS FROM THE PROJECTION'S START, NOT FROM THE WINDOW'S. A
      // rule that begins in 2030 still closes a MONTH, and the month it closes
      // opens at the month-end before it — not at today. Generating from `asOf`
      // and then taking the tail is what makes the first contribution of a
      // late-starting rule one month's surplus instead of four years of it.
      const grid = monthEndsBetween(asOfISO, sTo);
      const firstIdx = grid.findIndex((d) => d >= sFrom);
      const dates = firstIdx === -1 ? [] : grid.slice(firstIdx);
      if (dates.length === 0) {
        rejected.push({ input: name, reason: 'no month-end falls inside the projection window' });
        continue;
      }
      let n = 0;
      for (const [k, date] of dates.entries()) {
        const i = firstIdx + k;
        movements.push({ date, label, surplusFraction: f,
          ...(i > 0 ? { baseDate: grid[i - 1] } : {}) });
        if (++n >= MAX_EXPANDED_CONTRIBUTIONS) {
          rejected.push({ input: name,
            reason: `stopped after ${MAX_EXPANDED_CONTRIBUTIONS} occurrences` });
          break;
        }
      }
      continue;
    }
    if (hasFraction) {
      const f = (spec as { fractionOfLiquid: number }).fractionOfLiquid;
      if (!Number.isFinite(f) || f <= 0 || f > 1) {
        rejected.push({ input: name,
          reason: 'a fraction of cash must be greater than 0 and at most 1 (0.5 for half)' });
        continue;
      }
    } else {
      const amt = (spec as { amount: number }).amount;
      if (!Number.isFinite(amt) || amt === 0) {
        rejected.push({ input: name, reason: 'the amount is zero or not a number' }); continue;
      }
      // ⚠️ AN "AMOUNT" UNDER A DOLLAR IS A FRACTION IN DISGUISE. Asked to invest
      // half the balance each year, a model filled in `amount: -0.5` and the
      // ledger dutifully moved fifty cents. Refusing it is what turns a
      // confidently wrong table into a correctable mistake.
      if (Math.abs(amt) < 1) {
        rejected.push({ input: name,
          reason: 'amounts are in dollars; use fractionOfLiquid for a share of the balance' });
        continue;
      }
    }
    const planned = (date: string): PlannedMovement => ({ date, label,
      ...(hasAmount ? { amount: (spec as { amount: number }).amount }
                    : { fractionOfLiquid: (spec as { fractionOfLiquid: number }).fractionOfLiquid }) });

    if ('onDate' in spec) {
      if (spec.onDate < asOfISO) {
        rejected.push({ input: name, reason: `dated before the projection starts (${asOfISO})` });
      } else if (spec.onDate > horizonISO) {
        rejected.push({ input: name, reason: `dated after the horizon (${horizonISO})` });
      } else {
        movements.push(planned(spec.onDate));
      }
      continue;
    }

    const sched = spec as { from: string; to?: string; cadence: 'monthly' | 'yearly' };
    const step  = sched.cadence === 'yearly' ? 12 : 1;
    const start = sched.from < asOfISO ? asOfISO : sched.from;
    const end   = sched.to && sched.to < horizonISO ? sched.to : horizonISO;
    if (start > end) {
      rejected.push({ input: name, reason: 'the schedule ends before the projection starts' });
      continue;
    }
    let n = 0;
    // Occurrences are measured from the STATED start, not from the clamped one,
    // so trimming a schedule to the projection window shifts no pay-in date.
    for (let i = 0; ; i++) {
      const date = addMonths(sched.from, i * step);
      if (date > end) break;
      if (date < start) continue;
      movements.push(planned(date));
      if (++n >= MAX_EXPANDED_CONTRIBUTIONS) {
        rejected.push({ input: name,
          reason: `stopped after ${MAX_EXPANDED_CONTRIBUTIONS} occurrences` });
        break;
      }
    }
    if (n === 0) {
      rejected.push({ input: name, reason: 'no occurrence falls inside the projection window' });
    }
  }

  movements.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { movements, rejected };
}

// ── Settling the amounts ─────────────────────────────────────────────────────

type Kind = 'CONTRIBUTION' | 'OUTFLOW';

/**
 * Turn what the user said into dated amounts, in the order the money actually
 * moves.
 *
 * ⚠️ A SHARE IS OF WHAT IS LEFT, AND ORDER IS THEREFORE PART OF THE ANSWER. On a
 * date carrying both, the outflow settles first: buying the car and then
 * investing half of what remains is what a person means, and investing half and
 * then discovering the car is unaffordable is not.
 *
 * Nothing is clamped to what the projection can afford — a plan that spends
 * money the projection does not have is reported as a negative cash checkpoint
 * with a warning, because silently shrinking somebody's stated contribution is
 * how a scenario stops answering the question that was asked. The one exception
 * is a SHARE of a balance that has already gone negative: half of nothing is
 * nothing, and half of a negative number is a contribution that pays the user.
 *
 * ⚠️ A SURPLUS SHARE IS TAKEN FROM THE MONTH, NOT FROM THE ACCOUNT. Its base is
 * the projected cash movement between two dates the spine can both show —
 * BEFORE this contribution or any other is applied — so the rule can never eat
 * into the base it is computed from, and a scenario with a 100% share moves
 * exactly the money the month brought in and not a cent of what was already
 * there. A month that projects a fall contributes nothing: no negative
 * contribution, no sale of investments, no deficit carried into the next month.
 */
export function settleMovements(
  contributions: readonly PlannedMovement[],
  outflows:      readonly PlannedMovement[],
  spine:         readonly SpinePoint[],
  /** The projection's opening cash — the base for the first month's surplus. */
  openingLiquid: number = 0,
): {
  movements: (DatedMovement & { kind: Kind })[];
  rejected:  { input: string; reason: string }[];
  warnings:  string[];
} {
  const liquidOn = new Map(spine.map((p) => [p.date, p.liquid]));
  const rank: Record<Kind, number> = { OUTFLOW: 0, CONTRIBUTION: 1 };
  const planned = [
    ...outflows.map((m) => ({ ...m, kind: 'OUTFLOW' as Kind })),
    ...contributions.map((m) => ({ ...m, kind: 'CONTRIBUTION' as Kind })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : rank[a.kind] - rank[b.kind]));

  const movements: (DatedMovement & { kind: Kind })[] = [];
  const rejected: { input: string; reason: string }[] = [];
  const warnings: string[] = [];
  let consumed = 0;

  for (const m of planned) {
    const name = `${m.label} on ${m.date}`;
    if (m.amount !== undefined) {
      movements.push({ date: m.date, label: m.label, amount: m.amount, kind: m.kind });
      consumed += m.amount;
      continue;
    }

    // ── A share of the month's projected surplus ──────────────────────────
    if (m.surplusFraction !== undefined) {
      const closing = liquidOn.get(m.date);
      // The month opens at the previous month-end, or at the projection's start.
      const opening = m.baseDate === undefined ? openingLiquid : liquidOn.get(m.baseDate);
      if (closing === undefined || opening === undefined) {
        rejected.push({ input: name,
          reason: 'a share of the surplus needs the projection at both ends of the month, and '
            + 'one of them was not supplied' });
        continue;
      }
      if (closing === null || opening === null) {
        rejected.push({ input: name,
          reason: 'the projection could not produce a balance for one end of the month, so the '
            + 'surplus cannot be stated' });
        continue;
      }
      // ⚠️ THE BASE IS THE PROJECTION, NEVER THE RUNNING BALANCE. `consumed` is
      // deliberately not subtracted here: the spine is the cash path before any
      // contribution, so two rules taking a share of the same month each take a
      // share of the same month, and neither shrinks the other's base.
      const projectedSurplus = round2(closing - opening);
      const eligible = projectedSurplus > 0 ? projectedSurplus : 0;
      const amount = round2(m.surplusFraction * eligible);
      movements.push({ date: m.date, label: m.label, amount, kind: m.kind,
        surplusFraction: m.surplusFraction, projectedSurplus });
      consumed += amount;
      continue;
    }

    const fraction = m.fractionOfLiquid as number;
    if (!liquidOn.has(m.date)) {
      rejected.push({ input: name,
        reason: 'a share of the balance needs the projection on that date, and none was supplied' });
      continue;
    }
    const projected = liquidOn.get(m.date) ?? null;
    if (projected === null) {
      rejected.push({ input: name,
        reason: 'the projection could not produce a balance for that date, so a share of it '
          + 'cannot be stated' });
      continue;
    }
    const available = projected - consumed;
    if (available <= 0) {
      warnings.push(`${name}: nothing was available to move (the projected balance at that `
        + 'date is already spent), so this contribution is zero.');
      movements.push({ date: m.date, label: m.label, amount: 0, kind: m.kind,
        fractionOfLiquid: fraction });
      continue;
    }
    const amount = round2(fraction * available);
    movements.push({ date: m.date, label: m.label, amount, kind: m.kind,
      fractionOfLiquid: fraction });
    consumed += amount;
  }

  return { movements, rejected, warnings };
}

// ── The ledger ───────────────────────────────────────────────────────────────

const uniq = (xs: ProvenanceKind[]): ProvenanceKind[] => [...new Set(xs)];

export function runScenarioLedger(input: LedgerInput): LedgerResult {
  const { opening, spine } = input;
  const { ok: returns, rejected } = validateReturns(input.returns);
  const settled = settleMovements(
    input.contributions, input.outflows, spine, opening.liquid);
  rejected.push(...settled.rejected);
  const warnings: string[] = [...settled.warnings];
  const contributions = settled.movements.filter((m) => m.kind === 'CONTRIBUTION');
  const outflows      = settled.movements.filter((m) => m.kind === 'OUTFLOW');

  const openingNetWorth = round2(
    opening.liquid + opening.investments + opening.otherAssets - opening.debt);

  const checkpoints: LedgerCheckpoint[] = [];
  let prevContribTotal = 0;
  let prevOutflowTotal = 0;

  for (const point of spine) {
    // ⚠️ A POINT EVALUATED ONLY TO SETTLE A SHARE IS NOT A ROW IN THE TABLE.
    if (!point.isCheckpoint) continue;
    const upTo = <T extends { date: string }>(xs: readonly T[]) =>
      xs.filter((x) => x.date <= point.date);

    const contribs = upTo(contributions);
    const outs     = upTo(outflows);
    const contribTotal = contribs.reduce((s, m) => s + m.amount, 0);
    const outflowTotal = outs.reduce((s, m) => s + m.amount, 0);

    // ⚠️ ONE MOVEMENT, TWO SIGNS, ONE STEP. The same `contribTotal` leaves cash
    // and arrives in investments. At a zero return the composed net worth is
    // therefore identical to the no-contribution run, which is the property that
    // makes a transfer a transfer rather than a second source of money.
    const liquidAmount = point.liquid === null ? null
      : round2(point.liquid - contribTotal - outflowTotal);

    const grown = opening.investments * growthFactor(returns, opening.asOfISO, point.date);
    const contributed = contribs.reduce(
      (s, m) => s + m.amount * growthFactor(returns, m.date, point.date), 0);
    const investAmount = round2(grown + contributed);

    const stated = contribs.length > 0 || outs.length > 0;
    const grew   = Math.abs(investAmount - opening.investments - contribTotal) >= 0.005;

    const liquidLine: LedgerLine | null = liquidAmount === null ? null : {
      amount: liquidAmount,
      provenance: uniq([
        PROVENANCE.PROJECTED_FROM_EVIDENCE,
        ...(stated ? [PROVENANCE.USER_ASSUMED] : []),
      ]),
    };
    const investLine: LedgerLine = {
      amount: investAmount,
      provenance: uniq([
        PROVENANCE.MEASURED,
        ...(contribs.length > 0 || grew ? [PROVENANCE.USER_ASSUMED] : [PROVENANCE.HELD_FLAT]),
      ]),
    };
    const debtLine:  LedgerLine = { amount: round2(opening.debt),
      provenance: [PROVENANCE.MEASURED, PROVENANCE.HELD_FLAT] };
    const otherLine: LedgerLine = { amount: round2(opening.otherAssets),
      provenance: [PROVENANCE.MEASURED, PROVENANCE.HELD_FLAT] };

    const netWorth: LedgerLine | null = liquidLine === null ? null : {
      amount: round2(liquidLine.amount + investLine.amount + otherLine.amount - debtLine.amount),
      provenance: uniq([
        ...liquidLine.provenance, ...investLine.provenance,
        ...debtLine.provenance, ...otherLine.provenance,
      ]),
    };

    if (liquidAmount !== null && liquidAmount < 0) {
      warnings.push(`Cash is negative (${liquidAmount.toFixed(2)}) at ${point.date}: the stated `
        + 'contributions and one-off amounts exceed the projected balance. Nothing was '
        + 'clamped — the plan as stated does not fund itself.');
    }
    if (investAmount < 0) {
      warnings.push(`Investments are negative (${investAmount.toFixed(2)}) at ${point.date}: `
        + 'the stated withdrawals exceed the balance.');
    }

    checkpoints.push({
      date: point.date,
      liquid: liquidLine, investments: investLine, debt: debtLine,
      otherAssets: otherLine, netWorth,
      movements: {
        contributionsToDate: { count: contribs.length, total: round2(contribTotal) },
        outflowsToDate:      { count: outs.length,     total: round2(outflowTotal) },
        investmentGrowthToDate: round2(investAmount - opening.investments - contribTotal),
        sincePreviousCheckpoint: {
          contributions: round2(contribTotal - prevContribTotal),
          outflows:      round2(outflowTotal - prevOutflowTotal),
        },
      },
      ...(point.liquid === null
        ? { unavailable: 'the cash projection could not produce a balance for this date' } : {}),
    });

    prevContribTotal = contribTotal;
    prevOutflowTotal = outflowTotal;
  }

  return {
    opening: { ...opening, netWorth: openingNetWorth },
    checkpoints,
    movements: settled.movements,
    rejected,
    warnings: [...new Set(warnings)],
    basis: LEDGER_BASIS,
  };
}

// ── Goal seek ────────────────────────────────────────────────────────────────

/**
 * The bisection behind `scenario_goal_seek`.
 *
 * ⚠️ IT SOLVES; IT DOES NOT MODEL. `evaluate` is supplied by the caller and runs
 * the same ledger the user would have got by stating the value themselves, so a
 * solved answer and a stated answer are the same arithmetic. That is what makes
 * the round trip — solve for a return, run the ledger at it, reach the target —
 * a property rather than a coincidence.
 *
 * ⚠️ THE BRACKET IS THE HONESTY MECHANISM. Nothing here decides that 142%/yr is
 * unrealistic; the model owns that judgement, as it owns every other one. What
 * the solver owes is a WIDE, STATED bracket and, when the target sits outside it,
 * how far the bracket actually got — "even at 500% a year you reach $612K" is an
 * answer. A huge number invented to avoid saying "no" is not.
 *
 * `evaluate` may return null (the projection refused for that input); a null is
 * treated as "did not reach", never as zero.
 */
export interface SolveOutcome {
  solveFor:   string;
  lo:         number;
  hi:         number;
  iterations: number;
}

export type SolveResult =
  | (SolveOutcome & { feasible: true;  required: number; alreadyMet: boolean; reached: number })
  | (SolveOutcome & { feasible: false; reason: string; bestReached: number | null; bestAt: number });

const ceilTo = (n: number, step: number) => Math.ceil(n / step - 1e-9) * step;

export function solveForTarget(args: {
  solveFor:  string;
  evaluate:  (x: number) => number | null;
  target:    number;
  lo:        number;
  hi:        number;
  /** The smallest step worth reporting: 0.01 of a percentage point, or a cent. */
  precision: number;
  maxIterations?: number;
}): SolveResult {
  const { solveFor, evaluate, target, lo, hi, precision } = args;
  const maxIterations = args.maxIterations ?? 80;
  const frame = { solveFor, lo, hi };
  const at = (x: number) => evaluate(x) ?? Number.NEGATIVE_INFINITY;

  const atLo = at(lo);
  if (atLo >= target) {
    return { ...frame, iterations: 0, feasible: true, required: lo,
      alreadyMet: true, reached: atLo };
  }

  const atHi = at(hi);
  if (atHi < target) {
    return { ...frame, iterations: 1, feasible: false,
      bestReached: Number.isFinite(atHi) ? atHi : null, bestAt: hi,
      reason: atHi === atLo
        // ⚠️ A FLAT FUNCTION IS THE MOST USEFUL REFUSAL THIS TOOL PRODUCES.
        // Moving cash into investments at a 0% return relocates money; it does
        // not create any, so NO monthly contribution reaches a net-worth target.
        // "You would need $90K a year" was the fabrication; "no amount of this
        // changes the answer" is the truth it was standing in for.
        ? `the target does not respond to ${solveFor} at all under these assumptions — `
          + 'every value in the range produces the same result, so no amount of it reaches '
          + 'the target'
        : `no value of ${solveFor} between ${lo} and ${hi} reaches the target`,
    };
  }

  let low = lo, high = hi, iterations = 0;
  while (high - low > precision && iterations < maxIterations) {
    const mid = (low + high) / 2;
    if (at(mid) >= target) high = mid; else low = mid;
    iterations++;
  }

  // Report the smallest reportable value that still clears the target, and
  // verify it — a value rounded to the cent must not land a cent short.
  let required = ceilTo(high, precision);
  let reached  = at(required);
  if (reached < target) { required = ceilTo(required + precision, precision); reached = at(required); }

  return { ...frame, iterations, feasible: true, required, alreadyMet: false, reached };
}
