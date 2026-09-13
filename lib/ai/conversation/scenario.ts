/**
 * lib/ai/conversation/scenario.ts
 *
 * INVESTMENT SCENARIO ARITHMETIC — the one genuinely new calculation the
 * investigation identified, at the smallest size that answers the goldens.
 *
 * ⚠️ THIS IS ARITHMETIC, NOT A FORECAST. It predicts nothing, infers no expected
 * return, extrapolates no history and assigns no probability. THE USER SUPPLIES
 * THE PERCENTAGE. Code owns the multiplication; the model owns explaining it.
 * "What if Bitcoin goes up 10%?" is a question about arithmetic over a stated
 * hypothetical, and treating it as a market opinion is how a scenario tool turns
 * into a prediction engine.
 *
 * ⚠️ IT LIVES UNDER scripts/ ON PURPOSE. It is research code for the baseline
 * experiment and has no production caller. If the experiment shows the product
 * needs it, it moves to lib/investments/ with the rest of the canonical
 * arithmetic — not before.
 *
 * ── What makes it generic ───────────────────────────────────────────────────
 * A component is anything the caller can name and value: a digital-asset
 * bucket, a brokerage total, a single instrument, all of them at once. Nothing
 * here knows what Bitcoin is. The caller supplies (key, label, currentValue) —
 * from a canonical authority — and a percentage per key.
 */

/** One valued component the caller wants to move. Value comes from an authority. */
export interface ScenarioComponent {
  key:          string;
  label:        string;
  currentValue: number;
}

export interface ScenarioLeg {
  key:            string;
  label:          string;
  currentValue:   number;
  /** The stated move, as a fraction: +0.10 for "up 10%". */
  changePct:      number;
  /** currentValue × changePct. */
  delta:          number;
  scenarioValue:  number;
}

export interface ScenarioResult {
  legs: ScenarioLeg[];
  /** Σ current across the legs that moved. */
  movedCurrentTotal:  number;
  /** Σ scenario across the legs that moved. */
  movedScenarioTotal: number;
  /** The arithmetic total of the move. */
  totalDelta:         number;
  /**
   * Net worth AFTER the stated move, when the caller supplied a current one.
   *
   * ⚠️ NOTHING ELSE MOVES, AND THAT IS STATED RATHER THAN IMPLIED. Cash does not
   * change, debt does not change, no position is sold, no tax is computed. Null
   * when the caller had no authoritative net worth to start from — a scenario
   * net worth built on a guessed baseline is worse than none.
   */
  currentNetWorth:  number | null;
  scenarioNetWorth: number | null;
  /** Components the caller named that could not be matched or valued. */
  unresolved: { key: string; reason: string }[];
  /** One sentence stating exactly what this is. Quoted, never paraphrased. */
  basis: string;
}

export const SCENARIO_BASIS =
  'Arithmetic over a stated hypothetical: each named component is multiplied by ' +
  'the percentage the user supplied. Nothing else changes — cash, debt and every ' +
  'unnamed holding are held exactly as they are. This is not a forecast and ' +
  'carries no view on what any market will do.';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Apply stated percentage moves to named components.
 *
 * `moves` is keyed by component key; a key with no matching component is
 * REPORTED as unresolved rather than silently dropped, because "what if Bitcoin
 * does 10%" answered without Bitcoin in it is the wrong answer stated
 * confidently.
 */
export function applyInvestmentScenario(args: {
  components:      readonly ScenarioComponent[];
  moves:           Readonly<Record<string, number>>;
  currentNetWorth: number | null;
}): ScenarioResult {
  const { components, moves, currentNetWorth } = args;
  const legs: ScenarioLeg[] = [];
  const unresolved: { key: string; reason: string }[] = [];

  for (const [key, changePct] of Object.entries(moves)) {
    const c = components.find((x) => x.key === key);
    if (!c) {
      unresolved.push({ key, reason: 'no valued component with this key is in scope' });
      continue;
    }
    if (!Number.isFinite(c.currentValue)) {
      unresolved.push({ key, reason: 'component has no assertable current value' });
      continue;
    }
    if (!Number.isFinite(changePct)) {
      unresolved.push({ key, reason: 'the stated change is not a number' });
      continue;
    }
    const delta = c.currentValue * changePct;
    legs.push({
      key: c.key, label: c.label,
      currentValue:  round2(c.currentValue),
      changePct,
      delta:         round2(delta),
      scenarioValue: round2(c.currentValue + delta),
    });
  }

  const movedCurrentTotal  = round2(legs.reduce((s, l) => s + l.currentValue, 0));
  const movedScenarioTotal = round2(legs.reduce((s, l) => s + l.scenarioValue, 0));
  const totalDelta         = round2(legs.reduce((s, l) => s + l.delta, 0));

  return {
    legs,
    movedCurrentTotal,
    movedScenarioTotal,
    totalDelta,
    currentNetWorth:  currentNetWorth === null ? null : round2(currentNetWorth),
    scenarioNetWorth: currentNetWorth === null ? null : round2(currentNetWorth + totalDelta),
    unresolved,
    basis: SCENARIO_BASIS,
  };
}
