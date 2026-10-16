/**
 * lib/ai/conversation/reconcile.ts
 *
 * WHAT WE SAID, AGAINST WHAT HAPPENED — the arithmetic only. No data access,
 * no imports, like `scenario-ledger.ts` beside it.
 *
 * ── Why a checkpoint is not the same as re-running the past ─────────────────
 * Slice 3 gave us `project_cash(asOf: 2026-01-01)` — what we WOULD say today,
 * standing in January, from evidence through that date. That is a recomputation,
 * and it is genuinely useful. But it uses today's code and today's view of
 * January, so it cannot know that the user said "assume I spend $6K" in the
 * conversation, or which income streams the engine could see at the time.
 *
 * **A checkpoint records a STATEMENT; the retrospective records a CAPABILITY.**
 * Both are worth having, and confusing them is how a system marks its own
 * homework: re-deriving the past with better code and calling the agreement
 * accuracy.
 *
 * ── Two comparisons, because they answer different questions ────────────────
 * SETTLED — the horizon has passed. Compare the statement against what the
 * financial authorities say actually happened on that date. This is accuracy.
 *
 * IN FLIGHT — the horizon is still ahead. Comparing a year-end statement with
 * today's balance is not a variance; the two describe different instants and
 * subtracting them produces a number that means nothing. The like-for-like
 * comparison is the projection RE-RUN TO THE SAME HORIZON today: "we said
 * $38,243 for year end; today we'd say $41,100" — and then the basis diff says
 * why.
 */


// ── Variance ─────────────────────────────────────────────────────────────────

export const VARIANCE_DIRECTION = {
  AHEAD:  'AHEAD',
  BEHIND: 'BEHIND',
  ON:     'ON_TRACK',
} as const;

export type VarianceDirection =
  typeof VARIANCE_DIRECTION[keyof typeof VARIANCE_DIRECTION];

export interface Variance {
  stated:    number;
  compared:  number;
  /** compared − stated. Signed, and the sign is the point. */
  difference: number;
  direction: VarianceDirection;
  /** Null when the statement was zero — a percentage of nothing is not a number. */
  percentOfStated: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * ⚠️ "ON TRACK" IS A BAND, NOT AN EQUALITY. A projection that lands within a
 * dollar of a five-figure statement is not meaningfully different from it, and
 * reporting `difference: 0.37, direction: BEHIND` invites a sentence about being
 * behind that is false in every way that matters.
 */
export const ON_TRACK_BAND = 1;

export function compareToStatement(stated: number, compared: number): Variance {
  const difference = round2(compared - stated);
  return {
    stated: round2(stated), compared: round2(compared), difference,
    direction: Math.abs(difference) <= ON_TRACK_BAND ? VARIANCE_DIRECTION.ON
      : difference > 0 ? VARIANCE_DIRECTION.AHEAD : VARIANCE_DIRECTION.BEHIND,
    percentOfStated: stated === 0 ? null : round2((difference / Math.abs(stated)) * 100),
  };
}

// ── Basis ────────────────────────────────────────────────────────────────────

export interface BasisChange {
  field: string;
  then:  unknown;
  now:   unknown;
  /** For numbers, the signed move. Null for everything else. */
  delta: number | null;
}

/**
 * What changed between the basis we projected on and the basis we would project
 * on now.
 *
 * ⚠️ A VARIANCE WITHOUT ITS CAUSE IS A SCORE, NOT AN EXPLANATION. "You are
 * $2,900 ahead" is worth very little; "you are $2,900 ahead because observed
 * spending fell from $142.90 a day to $131.20" is the answer. Every field the
 * checkpoint copied out of `project_cash` is compared, and nothing is
 * interpreted here — the model says which change mattered.
 *
 * Fields absent from BOTH sides are not reported. A field present on one side
 * only IS reported, because appearing or disappearing is itself a change.
 */
export function diffBasis(
  then: Record<string, unknown> | null | undefined,
  now:  Record<string, unknown> | null | undefined,
): BasisChange[] {
  const a = then ?? {};
  const b = now ?? {};
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: BasisChange[] = [];
  for (const field of fields) {
    const x = a[field];
    const y = b[field];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const delta = typeof x === 'number' && typeof y === 'number' ? round2(y - x) : null;
    // ⚠️ A FIELD THAT MOVED BY LESS THAN A CENT DID NOT MOVE. A stored rate
    // round-trips through JSON as 142.8979726027397 and comes back out of the
    // engine as 142.89797260273974, and reporting that as "the basis changed,
    // delta 0" is noise dressed as an explanation.
    if (delta === 0) continue;
    out.push({ field, then: x ?? null, now: y ?? null, delta });
  }
  return out;
}

// ── Reading a checkpoint back ────────────────────────────────────────────────

export interface CheckpointStatement {
  id:       string;
  subject:  string;
  statedAs: string;
  statedAt: string;
  metric:   string;
  horizon:  string;
  value:    number;
  basis:    Record<string, unknown>;
}

/**
 * Turn a recalled memory into a statement, or refuse it.
 *
 * ⚠️ IT FAILS CLOSED. The payload was validated on the way in, but a row read
 * back is data, and a checkpoint missing its horizon or its value is not a
 * statement about anything — it is exactly the shape that could be mistaken for
 * a balance. Refusing beats reconciling against a guess.
 */
export function readCheckpoint(m: {
  id: string; subject: string; statedAs: string; statedAt: string; payload: unknown;
}): CheckpointStatement | { unusable: string } {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  if (typeof p.horizon !== 'string' || !p.horizon) {
    return { unusable: `checkpoint ${m.subject} carries no horizon, so it states nothing` };
  }
  if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
    return { unusable: `checkpoint ${m.subject} carries no value` };
  }
  if (typeof p.metric !== 'string' || !p.metric) {
    return { unusable: `checkpoint ${m.subject} does not say what it measured` };
  }
  // ⚠️ A CONDITIONAL PROJECTION IS NOT OURS TO BE GRADED ON. A projection that
  // ran on a spending figure the USER supplied says what would happen if they
  // did what they said; comparing it with what happened measures their
  // compliance, not our accuracy — the same reason a scenario is never recorded.
  // Such rows are no longer written (only an evidence-based projection is), but
  // they exist from before that rule, and they were being graded, with the
  // assumption's raw text surfacing through the basis diff.
  const source = ((p.basis ?? {}) as Record<string, unknown>).spendingSource;
  if (source === 'USER_STATED' || source === 'MODEL_SUPPLIED') {
    return { unusable: `checkpoint ${m.subject} rested on a spending figure the user supplied, so it is a conditional `
      + 'statement: comparing it with what happened would measure whether they did what they said, not whether we were right' };
  }
  return {
    id: m.id, subject: m.subject, statedAs: m.statedAs, statedAt: m.statedAt,
    metric: p.metric, horizon: p.horizon, value: p.value,
    basis: (p.basis ?? {}) as Record<string, unknown>,
  };
}

// ── Attribution (AI RELIABILITY 2026-10-16) ──────────────────────────────────

/**
 * ⚠️ A VARIANCE MAY BE EXPLAINED ONLY BY LINES THAT SUM TO IT. On the live Space
 * (2026-10-16) `reconcile_projection` returned −21,197.12 beside a basis diff of
 * a spending RATE (unlabelled, read by the model as a positive "drift"), a COUNT
 * of income events and the opening cash — every one of which moved the figure
 * UP. Nothing returned named the cause (a payroll stream that had stopped being
 * counted), so every causal sentence the model produced was unsupported.
 *
 * The cash projection is one identity — closing = opening + income − dated
 * outflows − dailyRate × days — so an in-flight variance decomposes EXACTLY:
 *
 *   Δ = (O₁ − O₀) + [(I₁ − X₁) − (I₀ − X₀)] − (r₁ − r₀)·d₀ − r₁·(d₁ − d₀)
 *
 * A checkpoint written before its basis carried income and outflows still
 * determines its own net term, (I₀ − X₀) = V₀ − O₀ + r₀·d₀, so an old statement
 * attributes exactly too — as ONE net line, never split by a guess. The residual
 * is computed, not assumed; anything over rounding is reported as unattributed.
 * PURE.
 */

export interface AttributionLine {
  cause: 'OPENING_CASH' | 'INCOME_TIMING' | 'PROJECTED_INCOME' | 'DATED_OUTFLOWS' | 'INCOME_NET_OF_OUTFLOWS'
    | 'SPENDING_RATE' | 'HORIZON_DAYS' | 'UNATTRIBUTED';
  /** Signed effect on the projected figure (positive = raised it). */
  amount: number;
  derivation: string;
}

export interface VarianceAttribution {
  /** True when the lines sum to the variance within rounding (≤ 2 cents). */
  exact: boolean;
  lines: AttributionLine[];
  residual: number;
  meaning: string;
}

export interface AttributionSide {
  value: number;
  openingCash: number;
  /** Average daily SPENDING — an outflow. */
  dailyRate: number;
  monthsAveraged: readonly string[] | null;
  /** The projection's own income and dated-outflow totals, when recorded. */
  incomeProjected: number | null;
  outflowsProjected: number | null;
  /** The day the projection stood at. */
  asOfISO: string;
}

/**
 * Whole UTC days from one calendar date to another — the same count
 * lib/forecast/_time `daysBetween` gives the projection's horizon. Restated here
 * because this module imports nothing (it is arithmetic; a baseline pin says so).
 */
const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The stated side, from a checkpoint's closed basis. Null when the basis cannot carry an attribution. */
export function attributionSideFromCheckpoint(cp: CheckpointStatement): AttributionSide | null {
  const b = cp.basis;
  const openingCash = num(b.openingCash);
  const dailyRate = num(b.dailyRate);
  if (openingCash === null || dailyRate === null || b.spendingSource !== 'OBSERVED') return null;
  return {
    value: cp.value, openingCash, dailyRate,
    monthsAveraged: Array.isArray(b.monthsAveraged) ? (b.monthsAveraged as string[]) : null,
    incomeProjected: num(b.incomeProjected), outflowsProjected: num(b.outflowsProjected),
    asOfISO: cp.statedAt.slice(0, 10),
  };
}

export function attributeInFlightVariance(
  then: AttributionSide, now: AttributionSide, horizonISO: string,
  /**
   * Income the engine projects for the ELAPSED window [then.asOf, now.asOf] when it
   * stands at then.asOf (today's code, evidence available then). When given, the
   * income line splits into INCOME_TIMING (−this: those payments are no longer ahead)
   * and the remainder — still summing exactly, the approximation landing in the remainder.
   */
  elapsedIncome: number | null = null,
): VarianceAttribution {
  const d0 = Math.max(0, daysBetween(then.asOfISO, horizonISO));
  const d1 = Math.max(0, daysBetween(now.asOfISO, horizonISO));
  const net0 = then.value - then.openingCash + then.dailyRate * d0;
  const net1 = now.value - now.openingCash + now.dailyRate * d1;
  const lines: AttributionLine[] = [];
  const money = (n: number) => n.toFixed(2);
  // ⚠️ TIMING IS PART OF THE INCOME LINE, AND IT IS STRUCTURAL. A payment the earlier
  // statement projected between its date and today is no longer ahead of today's run:
  // if it arrived it now sits inside opening cash (the line above), and either way it
  // is not projected income any more. Said whenever the start moved, never inferred.
  const split = elapsedIncome !== null && now.asOfISO > then.asOfISO;
  const timing = now.asOfISO > then.asOfISO && !split
    ? `. Income the earlier statement projected between ${then.asOfISO} and ${now.asOfISO} is no longer `
      + 'projected: what arrived is now inside opening cash, so part of this line is timing, not lost income'
    : split ? ', after removing the timing line above' : '';
  if (split) {
    lines.push({ cause: 'INCOME_TIMING', amount: round2(-elapsedIncome),
      derivation: `income projected for ${then.asOfISO}..${now.asOfISO} (${money(elapsedIncome)}, re-run standing at `
        + `${then.asOfISO}) is no longer ahead of today's projection — what arrived is inside opening cash. Timing, `
        + 'not lost income' });
  }

  lines.push({ cause: 'OPENING_CASH', amount: round2(now.openingCash - then.openingCash),
    derivation: `liquid cash the projection started from: ${money(then.openingCash)} on ${then.asOfISO}, `
      + `${money(now.openingCash)} on ${now.asOfISO}` });

  if (then.incomeProjected !== null && then.outflowsProjected !== null
      && now.incomeProjected !== null && now.outflowsProjected !== null) {
    lines.push({ cause: 'PROJECTED_INCOME', amount: round2(now.incomeProjected - then.incomeProjected + (split ? elapsedIncome : 0)),
      derivation: `income the projection counted between its start and ${horizonISO}: `
        + `${money(then.incomeProjected)} then, ${money(now.incomeProjected)} now${timing}` });
    lines.push({ cause: 'DATED_OUTFLOWS', amount: round2(-(now.outflowsProjected - then.outflowsProjected)),
      derivation: `dated obligations inside the horizon: ${money(then.outflowsProjected)} then, `
        + `${money(now.outflowsProjected)} now` });
  } else {
    lines.push({ cause: 'INCOME_NET_OF_OUTFLOWS', amount: round2(net1 - net0 + (split ? elapsedIncome : 0)),
      derivation: `projected income less dated obligations to ${horizonISO}: ${money(net0)} then `
        + '(recovered exactly from the stated figure: value − opening cash + daily spending × days, '
        + `because that statement predates recording income separately), ${money(net1)} now${timing}` });
  }

  const k0 = then.monthsAveraged?.length ?? null;
  const k1 = now.monthsAveraged?.length ?? null;
  lines.push({ cause: 'SPENDING_RATE', amount: round2(-(now.dailyRate - then.dailyRate) * d0),
    derivation: `average daily SPENDING (an outflow, not a drift): ${money(then.dailyRate)}/day then`
      + (then.monthsAveraged ? ` (averaged over ${then.monthsAveraged.join(', ')})` : '')
      + `, ${money(now.dailyRate)}/day now` + (now.monthsAveraged ? ` (over ${now.monthsAveraged.join(', ')})` : '')
      + `, applied to the ${d0} day(s) the statement covered`
      + (k0 !== null && k1 !== null && k0 !== k1
        ? `. The averaging window changed LENGTH (${k0} → ${k1} months), so part of this line is a change in how `
          + 'spending is measured, not only in what was spent' : '') });
  lines.push({ cause: 'HORIZON_DAYS', amount: round2(-now.dailyRate * (d1 - d0)),
    derivation: `${d0} day(s) of spending remained to ${horizonISO} then, ${d1} now, at ${money(now.dailyRate)}/day` });

  const variance = round2(now.value - then.value);
  const residual = round2(variance - lines.reduce((n, l) => n + l.amount, 0));
  const exact = Math.abs(residual) <= 0.02;
  if (!exact) lines.push({ cause: 'UNATTRIBUTED', amount: residual,
    derivation: 'not explained by the projection identity — do not attribute it to anything' });
  return {
    exact, lines, residual,
    meaning: 'These lines sum to the variance. Explain the change ONLY with them, largest first, in their own '
      + 'words and figures; a cause that is not a line here is not supported by the evidence.',
  };
}
