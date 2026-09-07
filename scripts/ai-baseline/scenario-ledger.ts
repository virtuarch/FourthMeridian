/**
 * scripts/ai-baseline/scenario-ledger.ts
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
 * Exactly one of `amount` and `fractionOfLiquid` is set. Amounts are SIGNED:
 * positive moves cash into investments, negative takes it back out.
 */
export interface PlannedMovement {
  date:   string;
  label:  string;
  amount?: number;
  /** A share of the projected cash on that date: 0.5 for "half". */
  fractionOfLiquid?: number;
}

/** A movement with its amount settled, ready to apply. */
export interface DatedMovement {
  date:   string;
  amount: number;
  label:  string;
  /** The share it was stated as, when it was stated as a share. */
  fractionOfLiquid?: number;
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

/** What the user said about putting money in — one date, or a repeating schedule. */
export type ContributionSpec =
  | { onDate: string; amount?: number; fractionOfLiquid?: number; label?: string }
  | { from: string; to?: string; amount?: number; fractionOfLiquid?: number;
      cadence: 'monthly' | 'yearly'; label?: string };

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
    const stated = spec.fractionOfLiquid !== undefined
      ? `${spec.fractionOfLiquid * 100}% of cash` : String(spec.amount);
    const name = 'onDate' in spec
      ? `${label} ${stated} on ${spec.onDate}`
      : `${label} ${stated} ${spec.cadence} from ${spec.from}`;

    const hasAmount   = spec.amount !== undefined;
    const hasFraction = spec.fractionOfLiquid !== undefined;
    if (hasAmount === hasFraction) {
      rejected.push({ input: name,
        reason: 'state EITHER an amount in dollars OR a fraction of cash, not both and not neither' });
      continue;
    }
    if (hasFraction) {
      const f = spec.fractionOfLiquid as number;
      if (!Number.isFinite(f) || f <= 0 || f > 1) {
        rejected.push({ input: name,
          reason: 'a fraction of cash must be greater than 0 and at most 1 (0.5 for half)' });
        continue;
      }
    } else {
      const amt = spec.amount as number;
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
      ...(hasAmount ? { amount: spec.amount as number }
                    : { fractionOfLiquid: spec.fractionOfLiquid as number }) });

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

    const step  = spec.cadence === 'yearly' ? 12 : 1;
    const start = spec.from < asOfISO ? asOfISO : spec.from;
    const end   = spec.to && spec.to < horizonISO ? spec.to : horizonISO;
    if (start > end) {
      rejected.push({ input: name, reason: 'the schedule ends before the projection starts' });
      continue;
    }
    let n = 0;
    // Occurrences are measured from the STATED start, not from the clamped one,
    // so trimming a schedule to the projection window shifts no pay-in date.
    for (let i = 0; ; i++) {
      const date = addMonths(spec.from, i * step);
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
 */
export function settleMovements(
  contributions: readonly PlannedMovement[],
  outflows:      readonly PlannedMovement[],
  spine:         readonly SpinePoint[],
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
  const settled = settleMovements(input.contributions, input.outflows, spine);
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
