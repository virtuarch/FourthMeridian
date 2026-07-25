/**
 * GET /api/platform/platform-ops/refresh/executions  (OPS-2C-1)
 *
 * The read surface for the EXECUTION QUERY SEAM — a bounded, newest-first,
 * keyset-paged window of refresh execution rows for forensics. This is the ROW
 * seam, not a projection: it returns DTOs and a cursor, and computes no total,
 * no rate and no health. A caller wanting an aggregate is a projection caller
 * (the sibling routes in this folder).
 *
 * ── AUDIENCE IS DERIVED FROM THE GRANT, NEVER FROM THE REQUEST ────────────────
 * Platform Operations reads as `operator`, hardcoded below AFTER the platform
 * access check. It is deliberately NOT a query parameter: audience selects the
 * redaction posture, so accepting it from the client would let a caller choose
 * how much it is shown. The `support` audience (item-scoped, free-text errors
 * redacted) exists in the seam and is reached by a future support surface, not
 * by this route.
 *
 * Accepts `status` / `trigger` (repeatable), `since` / `until` (ISO), `limit`,
 * `cursor`, and repeatable `plaidItemId` scope. Paging is keyset over
 * (startedAt DESC, id DESC): the seam reads limit+1 rather than issuing a COUNT,
 * because a count would be an aggregation.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { queryRefreshExecutions } from "@/lib/platform/refresh/execution-query";
import type { ExecutionPageDTO } from "@/lib/platform/refresh/execution-query-core";
import { parseExecutionQueryParams } from "@/lib/platform/refresh/request-params";

export const runtime = "nodejs";

export type RefreshExecutionsResponse = ExecutionPageDTO;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const { filter, limit, cursor, plaidItemIds } = parseExecutionQueryParams(
    new URL(req.url).searchParams,
  );

  const page = await queryRefreshExecutions({
    // Derived from the platform grant above — never read from the request.
    audience: "operator",
    scope: plaidItemIds ? { plaidItemIds } : undefined,
    filter,
    limit,
    cursor,
  });

  return NextResponse.json(page satisfies RefreshExecutionsResponse);
}
