/**
 * lib/plaid/provider-call.ts  (DF-2D — provider-call attribution writer)
 *
 * The single lifecycle for recording one external provider request ATTEMPT as
 * an immutable ProviderCall, correlated to the active RefreshExecution.
 *
 *   instrumentProviderCall(operation, ctx, call)
 *     open (startedAt, attempt) → await the real provider call → record SUCCEEDED
 *     (with request_id) or FAILED/RATE_LIMITED (with safe error evidence) →
 *     re-throw the original error unchanged.
 *
 * Invoked from the ONE Plaid-client Proxy chokepoint (lib/plaid/client.ts), so
 * every attributed Plaid call — across manual / cron / reconnect / webhook —
 * records exactly once, with no duplication across wrappers and no per-call-site
 * code. Retries and pagination each re-enter the Proxy and produce a distinct
 * immutable row (attempt increments); a failed attempt is never overwritten by a
 * later success.
 *
 * TELEMETRY NEVER BREAKS THE CALL (the recordApiUsage / runJob house posture):
 * the ProviderCall write is fire-and-forget and non-throwing. The provider
 * result (or its thrown error) passes through UNCHANGED — a telemetry failure
 * must never turn a successful provider operation into a reported failure, nor
 * mask a real provider failure. `durationMs` is the provider round-trip only.
 *
 * DATA MINIMIZATION: only allowlisted operational fields are ever persisted —
 * provider, operation, status, timing, attempt, request id, http status, Plaid's
 * own error_code/error_type. NEVER a token, secret, request/response payload,
 * account number, or free-form body. The allowlist IS the `ProviderCallInput`
 * type, which lives with the writer (lib/plaid/refresh-ledger.ts).
 *
 * ── RLS-P-1: IT NO LONGER ISSUES THE WRITE ───────────────────────────────────
 * `ProviderCall` is revoked from `fm_app` outright and the operational ledger now
 * has exactly one door. This module keeps what it is good at — timing one round
 * trip, counting attempts, and extracting ONLY allowlisted facts from a Plaid
 * response or error — and hands the row to the ledger handle the context
 * carries. It no longer resolves a database client of any kind, so there is no
 * second authority for this table to find later.
 *
 * ⚠️ AND IT STILL DOES NOT AWAIT. `handle.recordProviderCall` returns `void`, so
 * the emit cannot be awaited into the provider's latency even by accident, and
 * cannot be inside a transaction.
 */

import "server-only";
import { getProviderCallContext, nextAttempt, type ProviderCallContext } from "@/lib/plaid/provider-call-context";
import { redactedErrorForLog } from "@/lib/plaid/errors";

// The row shape and its status vocabulary live with the ONE writer; re-exported
// here because this module is where the facts are extracted.
export type { ProviderCallInput, ProviderCallStatus } from "@/lib/plaid/refresh-ledger";
import type { ProviderCallInput, ProviderCallStatus } from "@/lib/plaid/refresh-ledger";

/** What `instrumentProviderCall` emits: everything but the execution id, which only the door may set. */
export type ProviderCallFacts = Omit<ProviderCallInput, "refreshExecutionId">;

// ── Safe extraction from Plaid responses / errors (no secrets, no payloads) ──

/** Plaid responses carry `data.request_id`; return it if present. */
export function extractPlaidRequestId(res: unknown): string | undefined {
  const id = (res as { data?: { request_id?: unknown } } | null | undefined)?.data?.request_id;
  return typeof id === "string" ? id : undefined;
}

interface ProviderCallErrorFacts {
  status: ProviderCallStatus;
  httpStatus?: number;
  errorCode?: string;
  errorCategory?: string;
  providerRequestId?: string;
}

/**
 * Extract ONLY allowlisted error facts from a Plaid (Axios-shaped) error —
 * Plaid's own error_code / error_type, the HTTP status, and request_id. Reuses
 * Plaid's taxonomy; introduces no competing one. Never reads tokens/payloads.
 */
export function classifyProviderCallError(err: unknown): ProviderCallErrorFacts {
  const resp = (err as { response?: { status?: unknown; data?: Record<string, unknown> } } | null | undefined)?.response;
  const httpStatus = typeof resp?.status === "number" ? resp.status : undefined;
  const data = resp?.data ?? {};
  const errorCode = typeof data.error_code === "string" ? data.error_code : undefined;
  const errorCategory = typeof data.error_type === "string" ? data.error_type : undefined;
  const providerRequestId = typeof data.request_id === "string" ? data.request_id : undefined;
  const rateLimited = httpStatus === 429 || errorCode === "RATE_LIMIT_EXCEEDED" || errorCategory === "RATE_LIMIT_EXCEEDED";
  return { status: rateLimited ? "RATE_LIMITED" : "FAILED", httpStatus, errorCode, errorCategory, providerRequestId };
}

// ── The instrumentation seam (called by the Plaid Proxy; unit-testable) ──────

export interface InstrumentDeps {
  /** Test seam — production emits through the ledger handle the context carries. */
  record?: (input: ProviderCallFacts) => void;
}

/**
 * Time one external provider request, record an immutable ProviderCall attempt
 * (fire-and-forget), and return/throw exactly what the call did. `ctx` is the
 * active provider-call context (attribution + attempt counter).
 */
export async function instrumentProviderCall<T>(
  operation: string,
  ctx: ProviderCallContext,
  call: () => Promise<T>,
  deps: InstrumentDeps = {},
): Promise<T> {
  const rawEmit = deps.record ?? ((input: ProviderCallFacts) => { ctx.ledger.recordProviderCall(input); });
  // Guard the emit so a throwing telemetry write can NEVER be mistaken for a
  // provider failure by the try/catch below (telemetry ≠ provider semantics).
  const emit = (input: ProviderCallFacts) => {
    try { rawEmit(input); } catch (e) { console.error(`[provider-call] emit failed for ${input.operation} (non-fatal):`, redactedErrorForLog(e)); }
  };
  const startedAt = new Date();
  const t0 = Date.now();
  const attempt = nextAttempt(ctx, operation);
  const base = {
    // No execution id: the handle fills its own, so this function has no way to
    // attribute a call to any execution but the one in flight.
    endpoint: ctx.currentEndpoint,
    provider: "PLAID",
    operation,
    attempt,
    startedAt,
  } as const;
  try {
    const res = await call();
    emit({
      ...base,
      status: "SUCCEEDED",
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      providerRequestId: extractPlaidRequestId(res),
    });
    return res;
  } catch (err) {
    const facts = classifyProviderCallError(err);
    emit({
      ...base,
      status: facts.status,
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      providerRequestId: facts.providerRequestId,
      httpStatus: facts.httpStatus,
      errorCode: facts.errorCode,
      errorCategory: facts.errorCategory,
    });
    throw err; // original error, unchanged — provider semantics stay authoritative
  }
}

/**
 * Proxy entry point: if a refresh context is active, instrument the call;
 * otherwise run it verbatim (unattributed, behavior identical to pre-DF-2D).
 */
export function maybeInstrumentProviderCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  const ctx = getProviderCallContext();
  return ctx ? instrumentProviderCall(operation, ctx, call) : call();
}
