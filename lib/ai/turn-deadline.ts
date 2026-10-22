/**
 * lib/ai/turn-deadline.ts  (SEC-AI-003 — one clock per turn, pure)
 *
 * THE WALL-CLOCK BUDGET A CONVERSATION TURN RUNS INSIDE, and the bounds the
 * app-level retry may spend of it.
 *
 * ⚠️ WHY IT EXISTS. Before this module the OpenAI client was built on SDK
 * defaults — a ten-minute per-request timeout and two silent retries — under a
 * route whose `maxDuration` is 300 s. The chat tool loop passed no `AbortSignal`
 * to any hop, so a hung provider connection held the lambda until Vercel killed
 * it (and the reservation's `finally` never ran), and the app's own 429 retry
 * (≤ 5) multiplied on the SDK's hidden two: one rate-limited turn issued 18
 * provider requests (runtime/05-AI-RELIABILITY.md, item 4). The ledger saw six.
 *
 * ⚠️ ONE RETRY AUTHORITY. The SDK is pinned to `maxRetries: 0`
 * (lib/ai/provider.ts); every retry a turn takes is `callWithRateLimitRetry`'s,
 * bounded here in COUNT (`CHAT_RATE_LIMIT_ATTEMPTS`) and in TOTAL WAIT
 * (`CHAT_RATE_LIMIT_WAIT_BUDGET_MS`), and never past the turn's deadline.
 *
 * ⚠️ PURE, AND DELIBERATELY NOT `server-only`. The route opens the deadline, the
 * engine threads it, the turn loop and the provider honour it; tests drive it
 * with an injected clock and timer. Nothing here touches a database, a network
 * or the SDK.
 */

/** `app/api/ai/chat/route.ts` `maxDuration`, mirrored (pinned by a source scan). */
export const CHAT_ROUTE_MAX_DURATION_S = 300;

/**
 * What the turn gives back to the route before the platform kills the lambda:
 * time for the guidance label, the seal, the ledger await and the response.
 */
export const TURN_DEADLINE_SAFETY_MARGIN_MS = 30_000;

/** The turn's wall-clock budget: route `maxDuration` minus the safety margin. */
export const CHAT_TURN_BUDGET_MS = CHAT_ROUTE_MAX_DURATION_S * 1_000 - TURN_DEADLINE_SAFETY_MARGIN_MS;

/** Provider attempts per hop: one call plus at most two rate-limit retries. */
export const CHAT_RATE_LIMIT_ATTEMPTS = 3;

/** The most a hop may spend SLEEPING between rate-limited attempts, in total. */
export const CHAT_RATE_LIMIT_WAIT_BUDGET_MS = 60_000;

/** A retry is not taken unless at least this much of the budget is left for the attempt itself. */
export const CHAT_MIN_ATTEMPT_MS = 5_000;

/** Below this much remaining budget the guidance label is skipped rather than attempted. */
export const GUIDANCE_MIN_REMAINING_MS = 5_000;

export const TURN_TIMEOUT_CODE = 'turn_deadline';
const TURN_TIMEOUT_MARKER = `[ai/turn] ${TURN_TIMEOUT_CODE}:`;

/**
 * The turn ran out of its budget. The name says "Timeout" on purpose:
 * `classifyAiFailure` (lib/ai/invocation.ts) reads the name, so a provider call
 * abandoned at this deadline is a zero-token TIMEOUT fact with this code.
 */
export class TurnTimeoutError extends Error {
  readonly code = TURN_TIMEOUT_CODE;
  constructor(readonly budgetMs: number, readonly where: string) {
    super(`${TURN_TIMEOUT_MARKER} the turn's ${budgetMs} ms budget ran out (${where}); the provider was not asked again.`);
    this.name = 'TurnTimeoutError';
  }
}

/** Whether a recorded turn error is the deadline's — the `isUnpricedModelFailure` idiom. */
export function isTurnTimeoutFailure(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.includes(TURN_TIMEOUT_MARKER);
}

export interface TurnDeadline {
  /** Epoch ms by which the turn must have finished its provider work. */
  readonly deadlineAt: number;
  /** The whole budget, for the error message. */
  readonly budgetMs: number;
  /** Aborted at the deadline, or by `abort()`. Handed to every provider call. */
  readonly signal: AbortSignal;
  /** What is left, never negative. */
  remainingMs(): number;
  /** Cancel the turn now (the route's `finally`, a client disconnect). Idempotent. */
  abort(): void;
  /** Release the timer. Safe to call more than once; aborts nothing. */
  dispose(): void;
}

export interface TurnDeadlineOptions {
  budgetMs?: number;
  /** Injectable clock and timer for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Open a deadline for one turn. The signal fires once the budget is spent;
 * `dispose()` must be called when the turn ends so the timer does not outlive it.
 */
export function openTurnDeadline(options: TurnDeadlineOptions = {}): TurnDeadline {
  const now = options.now ?? Date.now;
  const budgetMs = Math.max(0, Math.floor(options.budgetMs ?? CHAT_TURN_BUDGET_MS));
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const deadlineAt = now() + budgetMs;
  const controller = new AbortController();
  let timer: unknown = setTimer(() => controller.abort(new TurnTimeoutError(budgetMs, 'deadline')), budgetMs);
  const dispose = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  return {
    deadlineAt, budgetMs, signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    abort: () => { if (!controller.signal.aborted) controller.abort(new TurnTimeoutError(budgetMs, 'cancelled')); dispose(); },
    dispose,
  };
}

/**
 * A deadline that is ALREADY SPENT — for a caller handed an aborted signal with
 * no budget of its own (tests, a cancelled request).
 */
export function spentTurnDeadline(): TurnDeadline {
  const d = openTurnDeadline({ budgetMs: 0, setTimer: () => null, clearTimer: () => {} });
  d.abort();
  return d;
}
