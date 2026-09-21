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
  if (((p.basis ?? {}) as Record<string, unknown>).spendingSource === 'USER_STATED') {
    return { unusable: `checkpoint ${m.subject} rested on a spending figure the user supplied, so it is a conditional `
      + 'statement: comparing it with what happened would measure whether they did what they said, not whether we were right' };
  }
  return {
    id: m.id, subject: m.subject, statedAs: m.statedAs, statedAt: m.statedAt,
    metric: p.metric, horizon: p.horizon, value: p.value,
    basis: (p.basis ?? {}) as Record<string, unknown>,
  };
}
