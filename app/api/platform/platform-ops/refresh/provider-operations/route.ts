/**
 * GET /api/platform/platform-ops/refresh/provider-operations  (OPS-2C-1)
 *
 * The read surface for the Provider Operation Summary projection — per
 * (provider, operation) attempt counts, outcomes, latency and the attempt
 * DISTRIBUTION recorded on ProviderCall.
 *
 * ── NO RETRY RATE ─────────────────────────────────────────────────────────────
 * The projection deliberately publishes none, and this route adds none. At the
 * Plaid-client Proxy chokepoint a retry and a pagination page are
 * indistinguishable (REFRESH_EXECUTION_DOCTRINE.md §M), so each rollup carries
 * `paginationConfounded` and an `attemptSemantics` sentence instead. Consumers
 * must render those rather than dividing attempts by operations.
 *
 * Named "provider OPERATIONS" — not "provider health", which is a different and
 * already-owned authority (lib/platform/provider-health.ts synthesizes job +
 * freshness + connection axes). These are per-attempt facts, not a trust verdict.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Read-only.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getProviderOperationSummary } from "@/lib/platform/refresh/projections";
import { parseProjectionParams } from "@/lib/platform/refresh/request-params";
import type { ProviderOperationSummary } from "@/lib/platform/refresh/types";

export const runtime = "nodejs";

export type ProviderOperationsResponse = ProviderOperationSummary;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const args = parseProjectionParams(new URL(req.url).searchParams);
  const result = await getProviderOperationSummary(args);
  return NextResponse.json(result satisfies ProviderOperationsResponse);
}
