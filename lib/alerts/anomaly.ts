/**
 * lib/alerts/anomaly.ts  (quota/cost anomaly — the ONE anomaly rule, anomaly@1)
 *
 * A JUMP relative to a measure's OWN recent baseline, whether or not any
 * absolute threshold is crossed. Shared by every anomaly alert rule
 * (`ai-spend-anomaly`, `ai-spend-user-anomaly`, `plaid-call-anomaly` in
 * lib/alerts/rules.ts) so the three can never disagree about what "anomalous"
 * means. Pure and client-safe: no clock, no I/O.
 *
 * DEFINITION (anomaly@1), over one measure at a time: a CURRENT window and the
 * `baselineWindows` windows immediately before it. The first step that matches
 * decides:
 *
 *   1. CURRENT       the current window has no figure: unpriced (any call the
 *                    rate card cannot price, so the figure would be a lower
 *                    bound), unreadable, or idle (nothing recorded, which is
 *                    UNAVAILABLE and never $0)                   ⇒ NOT_EVALUABLE
 *   2. BASELINE      any baseline window unpriced or unreadable ⇒ NOT_EVALUABLE
 *                    (an idle baseline window is a measured zero and counts)
 *   3. HISTORY       fewer than `minBaselineWindows` baseline windows with
 *                    activity                                    ⇒ NOT_EVALUABLE
 *   4. JUMP          current ≥ `ratio` × median(baseline) AND
 *                    current ≥ the measure's absolute floor      ⇒ ANOMALOUS
 *   5. otherwise                                                 ⇒ NORMAL
 *
 * NOT_EVALUABLE never fires and never "recovers": it is reported as such (the
 * rule outcome's `notEvaluable`), so silence is never mistaken for health. The
 * floor stops a tiny base from firing ($0.10 → $0.40 is ×4 and means nothing).
 * With step 3 satisfied the median is positive, so the ratio is always defined.
 *
 * Severity is always WARNING: a jump is a question for an operator, not an
 * outage. The absolute spend rules stay the critical path.
 */

export const ANOMALY_DEFINITION = {
  id: "anomaly",
  version: 1,
  /** Current ÷ baseline median at or above which the current window is a jump. */
  ratio: 3,
  /** Baseline windows immediately before the current one. */
  baselineWindows: 7,
  /** Baseline windows that must show activity before a median means anything. */
  minBaselineWindows: 5,
  /** Absolute floors on the CURRENT window, per measure. */
  floors: {
    /** Fleet customer-surface AI spend, USD per 24 h. */
    aiFleetUsd: 1,
    /** One customer's AI spend, USD per 24 h. */
    aiCustomerUsd: 1,
    /** Plaid provider calls per UTC day. */
    plaidCalls: 20,
  },
} as const;

/** "anomaly@1" — the stamp every anomaly signal carries. */
export const ANOMALY_DEFINITION_ID = `${ANOMALY_DEFINITION.id}@${ANOMALY_DEFINITION.version}` as const;

/**
 * One window of a measure, as the reader saw it.
 *   VALUE       a figure (may be 0 only for a count; spend with no calls is IDLE)
 *   IDLE        nothing recorded in the window
 *   UNPRICED    at least one call the rate card could not price
 *   UNREADABLE  the reader could not produce a figure
 */
export type AnomalyWindow =
  | { kind: "VALUE"; value: number }
  | { kind: "IDLE" }
  | { kind: "UNPRICED"; unpricedInvocations: number }
  | { kind: "UNREADABLE" };

export type AnomalyVerdict = "ANOMALOUS" | "NORMAL" | "NOT_EVALUABLE";

export interface AnomalyJudgement {
  verdict: AnomalyVerdict;
  /** The current figure; null when NOT_EVALUABLE at step 1. */
  current: number | null;
  /** Median of the baseline windows; null when not computed. */
  median: number | null;
  /** current ÷ median, rounded to one decimal; null when not computed. */
  multiple: number | null;
  /** Baseline windows with activity. */
  activeBaselineWindows: number;
  /** Why NOT_EVALUABLE (one operator sentence); null otherwise. */
  reason: string | null;
}

/** Median of a non-empty list (mean of the middle pair for an even count). */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const D = ANOMALY_DEFINITION;

function whyUnusable(w: AnomalyWindow): string | null {
  switch (w.kind) {
    case "UNPRICED": return `${w.unpricedInvocations} call(s) on an unpriced model, so the figure is only a lower bound`;
    case "UNREADABLE": return "the figure could not be read";
    default: return null;
  }
}

/** Apply anomaly@1 to one measure. */
export function judgeAnomaly(input: {
  current: AnomalyWindow;
  baseline: readonly AnomalyWindow[];
  floor: number;
}): AnomalyJudgement {
  const ne = (reason: string, current: number | null = null, active = 0): AnomalyJudgement =>
    ({ verdict: "NOT_EVALUABLE", current, median: null, multiple: null, activeBaselineWindows: active, reason });

  // 1. CURRENT
  const cur = input.current;
  if (cur.kind === "IDLE") return ne("nothing was recorded in the current window (unavailable, never $0)");
  if (cur.kind !== "VALUE") return ne(`current window: ${whyUnusable(cur)}`);

  // 2. BASELINE
  if (input.baseline.length < D.baselineWindows) {
    return ne(`only ${input.baseline.length} of ${D.baselineWindows} baseline windows were provided`, cur.value);
  }
  const unusable = input.baseline.map(whyUnusable).filter((r): r is string => r !== null);
  if (unusable.length > 0) return ne(`${unusable.length} baseline window(s) unusable: ${unusable[0]}`, cur.value);

  // 3. HISTORY
  const values = input.baseline.map((w) => (w.kind === "VALUE" ? w.value : 0));
  const active = values.filter((v) => v > 0).length;
  if (active < D.minBaselineWindows) {
    return ne(`short history: ${active} of ${D.baselineWindows} prior windows show activity (${ANOMALY_DEFINITION_ID} needs ${D.minBaselineWindows})`, cur.value, active);
  }

  // 4 / 5. JUMP
  const med = median(values);
  const multiple = Math.round((cur.value / med) * 10) / 10;
  const anomalous = cur.value >= D.ratio * med && cur.value >= input.floor;
  return { verdict: anomalous ? "ANOMALOUS" : "NORMAL", current: cur.value, median: med, multiple, activeBaselineWindows: active, reason: null };
}

/** "24 h $12.40 vs 7-day median $2.10, ×5.9 (anomaly@1)" — the basis a signal carries. */
export function anomalyBasis(j: AnomalyJudgement, fmt: (n: number) => string, windowLabel: string): string {
  return `${windowLabel} ${fmt(j.current ?? 0)} vs ${D.baselineWindows}-day median ${fmt(j.median ?? 0)}, ×${(j.multiple ?? 0).toFixed(1)} (${ANOMALY_DEFINITION_ID})`;
}
