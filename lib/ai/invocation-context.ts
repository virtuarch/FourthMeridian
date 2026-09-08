/**
 * lib/ai/invocation-context.ts  (Platform Ops cost accounting — Slice 3)
 *
 * OPAQUE CORRELATION FOR AI INVOCATIONS, propagated via AsyncLocalStorage so the
 * ONE provider chokepoint (lib/ai/provider.ts) can group a turn's invocations
 * without threading context through every generator signature, every tool loop
 * and every caller.
 *
 * ⚠️ DELIBERATELY THE SAME MECHANISM AS PLAID'S. `lib/plaid/provider-call-context.ts`
 * already solves exactly this problem for RefreshExecution attribution, for the
 * same reasons: ALS survives the whole async stage pipeline, each `run()` gets its
 * own store so concurrent sessions never cross-attribute, and a call made OUTSIDE
 * any context simply sees no store. Inventing a second mechanism for AI would be
 * two idioms for one problem.
 *
 * ⚠️ ONE DIFFERENCE FROM PLAID, AND IT MATTERS. A Plaid call outside a refresh is
 * NOT ATTRIBUTED AND WRITES NO ROW — being outside a refresh means it is out of
 * that ledger's scope. An AI call outside a context is still BILLABLE, so it is
 * still recorded, with null correlation. Cost does not depend on being groupable;
 * losing the row because nobody set a context would make the ledger a floor
 * rather than a total.
 *
 * ⚠️ THE IDENTIFIERS ARE OPAQUE GROUPING KEYS AND NOTHING ELSE. `correlationId`
 * is not a foreign key, not a `Conversation` row, not resolvable to a person, and
 * carries no meaning outside this ledger. It exists so invocations can be summed
 * into turns and sessions; it must never become a business entity, and no other
 * subsystem may key off it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AiInvocationContext {
  /**
   * Groups every invocation of one conversation/session. Opaque — any stable
   * string the caller already has. Never a user id, never an account id.
   */
  correlationId: string;
  /**
   * The user turn within that conversation. One turn produces one invocation on
   * a plain answer and SEVERAL when the model runs a tool loop, so this is what
   * makes "what did this turn cost?" answerable.
   *
   * Mutable on purpose: a turn loop advances it in place, exactly as Plaid's
   * recorder advances `currentEndpoint` as stages begin and end.
   */
  turnIndex?: number;
  /** Where the call came from — "chat", "brief", "harness". Separates traffic. */
  surface?: string;
}

const storage = new AsyncLocalStorage<AiInvocationContext>();

/** Run `fn` with `ctx` as the active AI invocation context. */
export function runWithAiInvocationContext<T>(ctx: AiInvocationContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active context, or undefined when the caller established none. */
export function getAiInvocationContext(): AiInvocationContext | undefined {
  return storage.getStore();
}
