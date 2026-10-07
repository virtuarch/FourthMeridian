/**
 * lib/ai/invocation-context.ts  (Platform Ops cost accounting — Slice 3;
 * attribution added by OPERATIONALIZATION P0, 2026-10-07)
 *
 * CORRELATION AND ATTRIBUTION FOR AI INVOCATIONS, propagated via
 * AsyncLocalStorage so the ONE provider chokepoint (lib/ai/provider.ts) can
 * group and attribute a turn's invocations without threading context through
 * every generator signature, every tool loop and every caller.
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
 * ⚠️ THE 2026-10-07 OWNER RULING. Slice 3 held that an invocation must never be
 * resolvable to a person, so the context carried opaque grouping keys only. The
 * owner has ruled that per-user and per-Space AI cost attribution MAY exist, as
 * BOUNDED OPERATOR-ONLY TELEMETRY: `userId`, `spaceId` and a real
 * `conversationId` now ride here and land on AiInvocation. What did NOT change
 * is the authority: AiInvocation stays revoked from fm_app and is written and
 * read by fm_system alone, so no tenant path — and no Conversations tool — can
 * reach another user's telemetry through it. The identifiers are still soft
 * references (no FK, no join from a tenant surface), never financial truth,
 * never Memory, never conversational context the model sees.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AiInvocationContext {
  /**
   * Groups every invocation of one conversation/session. Opaque — any stable
   * string the caller already has. For chat this IS the conversationId.
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
  /**
   * Which call within the surface — "chat:answer", "chat:guidance",
   * "brief:generate". The guidance labeller is a second invocation on the same
   * (correlationId, turnIndex); without this it is indistinguishable from the
   * answer it labels.
   */
  subSurface?: string;
  /** The authenticated user the call is made for. Absent for harness/job traffic. */
  userId?: string;
  /** The Space whose context the call reads. Absent when there is none. */
  spaceId?: string;
  /**
   * A REAL conversation identity (random, minted on the first turn, carried in
   * the sealed runtime-state cookie). Never derived from content.
   */
  conversationId?: string;
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

/**
 * The attribution a surface hands the turn loop. One small object, so the
 * route → engine → turn → labeller chain threads one argument, not four.
 */
export interface AiAttribution {
  userId?: string;
  spaceId?: string;
  conversationId?: string;
}
