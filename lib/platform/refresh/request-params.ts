/**
 * lib/platform/refresh/request-params.ts  (OPS-2C-1)
 *
 * The ONE request-parameter contract for the refresh read routes. Pure: no
 * Prisma, no `server-only`, no clock — a `URLSearchParams` in, a typed args
 * object out. Four projection routes and the seam route share it so query
 * validation is written once rather than five times.
 *
 * ── SCOPE PARSING FAILS CLOSED ────────────────────────────────────────────────
 * `plaidItemId` is the scope narrowing. The distinction that matters:
 *
 *   key ABSENT            → `undefined`  → platform-wide (the operator default)
 *   key PRESENT, valid    → `[ids…]`     → those connections
 *   key PRESENT, empty    → `[]`         → NOTHING (the projection's fail-closed path)
 *
 * A present-but-empty scope is ambiguous, and the two possible readings are not
 * symmetric: widening on malformed input exposes data, narrowing merely returns
 * nothing. So a present key always produces an array — possibly empty — and only
 * an absent key means platform-wide. Silently widening is the failure mode this
 * shape exists to prevent.
 */

import type { RefreshProjectionArgs } from "@/lib/platform/refresh/projections";

/** YYYY-MM-DD, the window vocabulary the projections take. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The scope query key, named once. */
export const SCOPE_PARAM = "plaidItemId";

/**
 * Parse the shared projection window + scope. Invalid values are DROPPED rather
 * than rejected — a malformed `from` degrades to the projection's default window
 * instead of 400-ing an operator mid-investigation. Scope is the exception: it
 * fails closed (above).
 */
export function parseProjectionParams(params: URLSearchParams): RefreshProjectionArgs {
  const from = params.get("from");
  const to = params.get("to");

  const args: RefreshProjectionArgs = {};
  if (from && YMD.test(from)) args.from = from;
  if (to && YMD.test(to)) args.to = to;

  if (params.has(SCOPE_PARAM)) {
    args.plaidItemIds = params.getAll(SCOPE_PARAM).filter((id) => id.trim().length > 0);
  }

  return args;
}

/** The seam's filter + paging inputs. Mirrors the projection parser's tolerance. */
export interface ExecutionQueryParams {
  filter?: {
    overallStatus?: readonly string[];
    trigger?: readonly string[];
    since?: Date;
    until?: Date;
  };
  limit?: number;
  cursor?: string | null;
  /** Scope, parsed by the SAME fail-closed rule as the projections. */
  plaidItemIds?: readonly string[];
}

/** Parse an ISO instant, or undefined when absent/unparseable. */
function parseInstant(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * Parse the execution-list query. Filter values are passed through as the
 * ledger's own vocabulary strings — this parser validates SHAPE, never
 * membership: the ledger stores Strings by the JobRun idiom, so a status the
 * vocabulary does not yet know must return nothing, never crash.
 */
export function parseExecutionQueryParams(params: URLSearchParams): ExecutionQueryParams {
  const overallStatus = params.getAll("status").filter((s) => s.trim().length > 0);
  const trigger = params.getAll("trigger").filter((s) => s.trim().length > 0);
  const since = parseInstant(params.get("since"));
  const until = parseInstant(params.get("until"));

  const filter: NonNullable<ExecutionQueryParams["filter"]> = {};
  if (overallStatus.length) filter.overallStatus = overallStatus;
  if (trigger.length) filter.trigger = trigger;
  if (since) filter.since = since;
  if (until) filter.until = until;

  const rawLimit = params.get("limit");
  const parsedLimit = rawLimit != null ? Number.parseInt(rawLimit, 10) : NaN;

  const out: ExecutionQueryParams = {
    cursor: params.get("cursor"),
  };
  if (Object.keys(filter).length > 0) out.filter = filter;
  // The seam clamps; this only refuses to pass a non-number through.
  if (Number.isFinite(parsedLimit)) out.limit = parsedLimit;
  if (params.has(SCOPE_PARAM)) {
    out.plaidItemIds = params.getAll(SCOPE_PARAM).filter((id) => id.trim().length > 0);
  }

  return out;
}
