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
 * account number, or free-form body.
 */

import "server-only";
import { db } from "@/lib/db";
import { getProviderCallContext, nextAttempt, type ProviderCallContext } from "@/lib/plaid/provider-call-context";

export type ProviderCallStatus = "SUCCEEDED" | "FAILED" | "RATE_LIMITED";

export interface ProviderCallInput {
  refreshExecutionId: string;
  endpoint?: string;
  provider: string;
  operation: string;
  status: ProviderCallStatus;
  attempt: number;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  providerRequestId?: string;
  httpStatus?: number;
  errorCode?: string;
  errorCategory?: string;
}

// ── Narrow write-client seam (the JobRunWriteClient idiom) ───────────────────
export interface ProviderCallWriteClient {
  providerCall: { create(args: { data: ProviderCallInput }): Promise<unknown> };
}
const providerCallDb = db as unknown as ProviderCallWriteClient;

/** Best-effort, non-throwing write of one provider-call attempt. */
export async function recordProviderCall(
  input: ProviderCallInput,
  client: ProviderCallWriteClient = providerCallDb,
): Promise<void> {
  try {
    await client.providerCall.create({ data: input });
  } catch (err) {
    console.error(`[provider-call] write failed for ${input.provider}.${input.operation} (non-fatal):`, err);
  }
}

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
  /** Test seam — production uses the real recordProviderCall. */
  record?: (input: ProviderCallInput) => void;
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
  const rawEmit = deps.record ?? ((input: ProviderCallInput) => { void recordProviderCall(input); });
  // Guard the emit so a throwing telemetry write can NEVER be mistaken for a
  // provider failure by the try/catch below (telemetry ≠ provider semantics).
  const emit = (input: ProviderCallInput) => {
    try { rawEmit(input); } catch (e) { console.error(`[provider-call] emit failed for ${input.operation} (non-fatal):`, e); }
  };
  const startedAt = new Date();
  const t0 = Date.now();
  const attempt = nextAttempt(ctx, operation);
  const base = {
    refreshExecutionId: ctx.refreshExecutionId,
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
