/**
 * GET /api/platform/platform-ops/refresh/failures  (OPS-2C-1)
 *
 * The read surface for the Failure Summary projection — non-clean executions,
 * failed stages by endpoint, and failed/rate-limited provider attempts grouped
 * by Plaid's OWN error vocabulary (`errorCode` / `errorCategory`).
 *
 * ── NO NEW FAILURE TAXONOMY ───────────────────────────────────────────────────
 * The projection groups only by taxonomies that already exist: the execution's
 * derived `overallStatus`, the stage `endpoint`, and the provider's own codes.
 * Free-text `errorSummary` is never grouped and never echoed — it is not a
 * controlled vocabulary, and grouping it would mint a taxonomy this layer has no
 * authority to own.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getFailureSummary } from "@/lib/platform/refresh/projections";
import { parseProjectionParams } from "@/lib/platform/refresh/request-params";
import type { FailureSummary } from "@/lib/platform/refresh/types";

export const runtime = "nodejs";

export type RefreshFailuresResponse = FailureSummary;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const args = parseProjectionParams(new URL(req.url).searchParams);
  const result = await getFailureSummary(args);
  return NextResponse.json(result satisfies RefreshFailuresResponse);
}
