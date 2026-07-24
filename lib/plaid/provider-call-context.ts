/**
 * lib/plaid/provider-call-context.ts  (DF-2D — provider-call correlation context)
 *
 * A narrow, request/job-independent correlation context that carries ONLY what
 * provider telemetry needs, propagated via AsyncLocalStorage so the Plaid client
 * Proxy (lib/plaid/client.ts) can attribute each external call to the owning
 * RefreshExecution without threading context through every wrapper or depending
 * on HTTP-route / UI state.
 *
 * WHY AsyncLocalStorage: runFullRefresh establishes ONE context per per-item
 * refresh via runWithProviderCallContext(). ALS propagates it through the whole
 * async stage pipeline (await chains, best-effort helpers) and — crucially —
 * survives Vercel `after()` because the context is set INSIDE the refresh, not
 * inherited from the request. Each runFullRefresh call gets its OWN store, so
 * concurrent item refreshes never cross-attribute. A Plaid call OUTSIDE any
 * refresh (link-token, token exchange, item removal) sees no store → is not
 * attributed, which is exactly the intended scope.
 *
 * The context object is intentionally MUTABLE: the StageRecorder updates
 * `currentEndpoint` as stages begin/end, so a provider call is attributed to the
 * stage that was active when it fired. `attempts` counts external requests per
 * operation within this execution (retries + pagination each increment it).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RefreshEndpoint } from "@/lib/plaid/refresh-execution-types";

export interface ProviderCallContext {
  /** The owning execution — always set (the row exists before the runner runs). */
  refreshExecutionId: string;
  /** The stage active right now, updated by the recorder; undefined between stages. */
  currentEndpoint?: RefreshEndpoint;
  /** Per-operation external-request counter (retries + pagination). Internal. */
  attempts: Map<string, number>;
}

const storage = new AsyncLocalStorage<ProviderCallContext>();

/** Run `fn` with `ctx` as the active provider-call context (one per refresh). */
export function runWithProviderCallContext<T>(ctx: ProviderCallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active provider-call context, or undefined when not inside a refresh. */
export function getProviderCallContext(): ProviderCallContext | undefined {
  return storage.getStore();
}

/** Next attempt ordinal for `operation` within this context (synchronous — no race). */
export function nextAttempt(ctx: ProviderCallContext, operation: string): number {
  const n = (ctx.attempts.get(operation) ?? 0) + 1;
  ctx.attempts.set(operation, n);
  return n;
}
