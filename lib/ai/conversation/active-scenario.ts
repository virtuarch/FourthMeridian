/**
 * lib/ai/conversation/active-scenario.ts
 *
 * THE ONE HYPOTHETICAL CURRENTLY UNDER DISCUSSION — assumptions and result, as a
 * pair, for as long as a conversation lives.
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR (1d67786). A scenario ran correctly —
 * baseline 35,898.84 plus a 15,000 bonus, ledger says 50,898.84, reconciliation
 * difference 0. The user then revised the bonus to ~15,700 and the assistant did
 * that in PROSE, with the raw result still in context. Two toolless turns later
 * Clip 6 elided the result on schedule, every figure left in the transcript was
 * English, and the model rebuilt year-end cash from the oldest surviving
 * sentence — the superseded no-bonus baseline — while narrating the bonus as
 * included. The investment advice that followed was understated by roughly the
 * size of the bonus.
 *
 * ⚠️ WHAT THIS DOES, EXACTLY, AND NOTHING MORE. When `scenario_projection`
 * SUCCEEDS, the arguments it was given and the figures it produced survive
 * together, machine-readable, until they are replaced by another success or
 * discarded by a failure. That is the whole contract. It does not detect that an
 * assumption changed in prose, and it must not be described as if it did — the
 * model re-running the tool is what updates the scenario, and whether it does so
 * is a separate question (tool discoverability), deliberately untouched here.
 *
 * ⚠️ ATOMIC BY CONSTRUCTION, WHICH IS WHY THERE IS NO FINGERPRINT. Both halves
 * are built in ONE object literal from ONE tool execution, and the slot only
 * ever takes a whole `ActiveScenario`. There is no setter for `assumptions` and
 * none for `result`, so a result can never come to sit beside assumptions that
 * did not produce it. A hash would be guarding a write path that does not exist;
 * the guard that earns its place is the replay check in the test suite, which
 * re-runs the stored assumptions and demands the stored figures back.
 *
 * ⚠️ TRANSIENT. Conversation runtime only — never SpaceMemory, never a
 * checkpoint, never a row. A hypothetical is not a durable belief: "if Bitcoin
 * rises 20% by December" must not become something the user is on record as
 * expecting, and a scenario must not leak into next week's session. It dies with
 * the process, and that is the feature.
 *
 * ⚠️ NOT A SECOND SOURCE OF TRUTH. Every figure here came from the ledger. This
 * module adds no arithmetic — it projects a result, it does not compute one. The
 * envelope says what the stated hypothetical comes to; it never says what is.
 */

import {
  compactClauses, isClausesInForce, withoutUnappliedLabels, type ClausesRan,
} from './scenario-rules';

/** The tool whose success establishes a scenario. Goal-seek is NOT one of these. */
export const SCENARIO_TOOL = 'scenario_projection' as const;

/**
 * The tool that answers WHEN the same hypothetical reaches a number.
 *
 * ⚠️ THE SAME SCENARIO, ASKED A DIFFERENT QUESTION. "When do I hit a million?"
 * and "what about two?" are one evolving hypothetical, and the second inherits
 * the first only if the first was captured. It takes the identical scenario
 * inputs, so its arguments are an assumption set exactly as
 * `scenario_projection`'s are — including the target, which is what makes "what
 * about $2M?" a change of one field rather than a new conversation.
 */
export const CROSSING_TOOL = 'scenario_crossing' as const;

/**
 * The figures a later turn needs to keep talking about the hypothetical.
 *
 * Six numbers from the ledger's final checkpoint, and the two dates that place
 * them. Not the movements, not the per-period table, not the qualification — all
 * of that stays in the raw result while it lives and is re-fetchable after.
 */
export interface ActiveScenarioResult {
  asOf: string;
  to: string;
  liquid: number;
  investments: number;
  debt: number;
  netWorth: number;
}

export interface ActiveScenario {
  /**
   * The tool-call arguments, verbatim.
   *
   * ⚠️ NOT RE-PARSED INTO A SECOND SCHEMA. `scenario_projection` is stateless and
   * fully re-specifiable from its arguments, so the arguments ARE the assumption
   * set — canonical already. Restating them in a shape of our own would create
   * the parallel representation this design exists to avoid, and would be the
   * first place the two could disagree.
   */
  assumptions: Record<string, unknown>;
  /**
   * The clauses that execution actually RAN, by kind — `'NONE'` where one did not.
   *
   * ⚠️ THE ENVELOPE KEPT A MISTAKE AS FAITHFULLY AS IT KEPT A RULE (G5). With the
   * floor dropped on the way into the first scenario, every later turn re-sent
   * the floorless arguments: 0/6 recovered, against 14/14 when the floor was
   * there. Nothing in `assumptions` could show the difference — a clause that
   * was never stated leaves no key behind. This is the ledger's own roster
   * (`scenario-rules.ts`), read from the SAME tool result in the SAME literal, so
   * it is a third member of the atomic pair and never a second opinion about it.
   * Absent only when the result carried no roster.
   */
  ran?: ClausesRan;
  result: ActiveScenarioResult;
}

/** A conversation's single slot. Owned by whoever owns the transcript. */
export interface ScenarioSlot { active: ActiveScenario | null }

export const newScenarioSlot = (): ScenarioSlot => ({ active: null });

/**
 * What a tool execution means for the slot.
 *
 * Three outcomes, and the distinction between the last two is the point:
 *   REPLACE — a successful scenario. The pair is swapped whole.
 *   CLEAR   — a scenario was ATTEMPTED and did not produce a usable result.
 *   IGNORE  — some other tool ran. The hypothetical is untouched.
 */
export type ScenarioCapture =
  | { action: 'REPLACE'; scenario: ActiveScenario }
  | { action: 'CLEAR'; reason: string }
  | { action: 'IGNORE' };

interface LedgerCheckpointish {
  liquid?: { amount?: unknown };
  investments?: { amount?: unknown };
  debt?: { amount?: unknown };
  netWorth?: { amount?: unknown };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Read one tool execution and say what it does to the slot.
 *
 * ⚠️ A FAILED RECOMPUTATION CLEARS. This is the non-negotiable half. The
 * demonstrated failure was an old result staying available after its assumptions
 * moved on, and a failed retry is precisely the moment that is most tempting and
 * most dangerous. Anything that is not a complete, usable scenario result —
 * a thrown error, an `unavailable` refusal, a missing or unreadable final
 * checkpoint — leaves the conversation with NO current scenario rather than an
 * old one wearing the label.
 */
export function captureActiveScenario(
  toolName: string, args: unknown, result: unknown,
): ScenarioCapture {
  if (toolName !== SCENARIO_TOOL && toolName !== CROSSING_TOOL) return { action: 'IGNORE' };
  // ⚠️ A BASELINE QUESTION IS NOT A HYPOTHETICAL. "When do I hit $50k on my
  // current trend?" is a crossing with no assumption in it, and measured live it
  // REPLACED the sweep scenario the conversation had just built — the next turn's
  // "quarterly table of that" was answered with the baseline, rule dropped. A
  // crossing that states nothing hypothetical leaves the hypothetical alone,
  // whether it succeeds or fails: it said nothing about the scenario either way.
  if (toolName === CROSSING_TOOL && !carriesAssumptions(args)) return { action: 'IGNORE' };

  const r = result as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return { action: 'CLEAR', reason: 'no result' };
  if ('error' in r) return { action: 'CLEAR', reason: String(r.error) };
  if ('unavailable' in r) return { action: 'CLEAR', reason: String(r.unavailable) };

  // ⚠️ EACH TOOL SAYS WHERE ITS POSITION IS; NEITHER MINTS THE PAIR. A projection's
  // is its last checkpoint, a crossing's is the month it found — and both arrive
  // here as the same six numbers, so there is still exactly one place a scenario
  // comes into existence.
  const position = toolName === CROSSING_TOOL ? crossingPosition(r) : finalCheckpoint(r);
  if ('reason' in position) return { action: 'CLEAR', reason: position.reason };
  const { asOf, to, liquid, investments, debt, netWorth } = position;

  // ⚠️ VERBATIM, MINUS THE ONE KEY THE CONTRACT NEVER APPLIES. A rule's `label`
  // sized nothing; kept here it is a sentence about the scenario that no
  // execution vouches for, re-read on every later turn. Every structured field
  // is untouched, so the arguments still replay to the same figures.
  const stated = withoutUnappliedLabels(
    (args && typeof args === 'object' ? args : {}) as Record<string, unknown>);
  const ran = clausesRan(r);

  // ⚠️ ONE LITERAL, ONE EXECUTION. The pair's coupling is this expression.
  return {
    action: 'REPLACE',
    scenario: {
      assumptions: stated,
      ...(ran ? { ran } : {}),
      result: { asOf, to, liquid, investments, debt, netWorth },
    },
  };
}

/**
 * The roster a scenario result carries, at envelope size. A projection echoes
 * its assumptions under `assumptions`, a crossing under `assumptionsInForce`;
 * both are `scenarioAssumptions`' output, so both carry the same `clauses`.
 */
function clausesRan(r: Record<string, unknown>): ClausesRan | null {
  const echo = (r.assumptions ?? r.assumptionsInForce) as { clauses?: unknown } | null | undefined;
  const clauses = echo && typeof echo === 'object' ? echo.clauses : undefined;
  return isClausesInForce(clauses) ? compactClauses(clauses) : null;
}

/**
 * The scenario inputs that make a call a hypothetical rather than a reading of
 * the current trend. The same list `SCENARIO_INPUTS` offers, minus presentation
 * (`granularity`) and the search window.
 */
const ASSUMPTION_KEYS = [
  'annualReturnPct', 'returns', 'contributions', 'outflows', 'assumedMonthlySpending',
  'liabilityAssumptions',
] as const;

function carriesAssumptions(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const a = args as Record<string, unknown>;
  return ASSUMPTION_KEYS.some((k) => {
    const v = a[k];
    if (v === undefined || v === null) return false;
    return Array.isArray(v) ? v.length > 0 : true;
  });
}

/** Six numbers and the two dates that place them, or why they could not be read. */
type Position =
  | { asOf: string; to: string; liquid: number; investments: number;
      debt: number; netWorth: number }
  | { reason: string };

const position = (
  r: Record<string, unknown>, to: unknown, c: Record<string, unknown> | undefined,
  missing: string,
): Position => {
  const liquid = num(c?.liquid);
  const investments = num(c?.investments);
  const debt = num(c?.debt);
  const netWorth = num(c?.netWorth);
  const asOf = typeof r.asOf === 'string' ? r.asOf : null;
  if (liquid === null || investments === null || debt === null || netWorth === null
    || asOf === null || typeof to !== 'string') return { reason: missing };
  return { asOf, to, liquid, investments, debt, netWorth };
};

/** A projection's position: its last checkpoint, at the horizon it was asked for. */
function finalCheckpoint(r: Record<string, unknown>): Position {
  const checkpoints = r.checkpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return { reason: 'no checkpoints' };
  const last = checkpoints[checkpoints.length - 1] as LedgerCheckpointish;
  return position(r, (r.horizon as { to?: unknown } | undefined)?.to, {
    liquid: last?.liquid?.amount, investments: last?.investments?.amount,
    debt: last?.debt?.amount, netWorth: last?.netWorth?.amount,
  }, 'incomplete final checkpoint');
}

/**
 * A crossing's position, as the scenario's standing result.
 *
 * ⚠️ THE DATE IS THE ANSWER, SO THE DATE IS THE HORIZON. A projection's result is
 * its last checkpoint; a crossing's is the month it found — or, when it found
 * none, the month it searched to, which is the honest end of the same path. Both
 * are positions the scenario actually produced; neither is a fresh computation.
 *
 * ⚠️ A SEARCH THAT WAS ALREADY TRUE CARRIES NO POSITION. "You are already there"
 * is a statement about today, and today is what the financial tools are for — an
 * envelope repeating it would put a current balance inside a hypothetical.
 */
function crossingPosition(r: Record<string, unknown>): Position {
  const at = (r.crossing ?? r.neverCrossesBy) as
    { date?: unknown; composition?: Record<string, unknown> } | null | undefined;
  if (!at || typeof at !== 'object') return { reason: 'no crossing position to carry' };
  return position(r, at.date, at.composition, 'incomplete crossing position');
}

/** Apply a capture to the slot. The only way the slot ever changes. */
export function applyCapture(slot: ScenarioSlot, capture: ScenarioCapture): void {
  if (capture.action === 'REPLACE') slot.active = capture.scenario;
  else if (capture.action === 'CLEAR') slot.active = null;
}

/**
 * How the envelope appears in the request.
 *
 * ⚠️ `system`, NOT `user`. Compaction counts a turn by assistant completions and
 * never reads a system message, so this is inert to it — whereas an extra user
 * message would sit in the transcript looking like the start of a turn.
 *
 * ⚠️ THE LABEL IS STRUCTURAL, NOT DOCTRINE. It names what the object is and
 * stops. No "prefer this over the baseline", no "always trust this" — the shape
 * carries the distinction, because a baseline projection has no `assumptions`
 * block and this does.
 */
export const ACTIVE_SCENARIO_MARKER = 'ACTIVE SCENARIO (hypothetical under discussion)';

export function scenarioMessage(scenario: ActiveScenario): { role: 'system'; content: string } {
  return { role: 'system', content: `${ACTIVE_SCENARIO_MARKER}\n${JSON.stringify(scenario, null, 1)}` };
}

const isScenarioMessage = (m: unknown): boolean =>
  typeof (m as { content?: unknown })?.content === 'string'
  && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER);

/**
 * Put the envelope in its reserved slot at the tail of the transcript, replacing
 * any earlier copy. Returns the mutated array.
 *
 * ⚠️ REPLACED, NEVER APPENDED, AND ALWAYS LAST. Appending would accumulate one
 * stale envelope per turn. Placing it early — beside the orientation — would
 * invalidate the prompt cache for everything after it every time the scenario
 * changed; at the tail, a change costs only the tail.
 *
 * ⚠️ ABSENT MEANS ABSENT. With no active scenario the message is removed and
 * nothing takes its place: the transcript is exactly what it was before this
 * module existed, which is the single-frame behaviour already measured safe.
 */
export function injectScenario(messages: unknown[], slot: ScenarioSlot): unknown[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isScenarioMessage(messages[i])) messages.splice(i, 1);
  }
  if (slot.active) messages.push(scenarioMessage(slot.active));
  return messages;
}
