/**
 * GET /api/platform/platform-ops/ai-invocations  (PLATFORM OPS OBSERVABILITY)
 *
 * AI operations over the per-invocation ledger, priced by the code-owned rate
 * card. Query: window=24h|7d|30d, surface, model, environment. There is no
 * user or Space parameter: the ledger does not record them (stated on the
 * payload). Gated PLATFORM_OPS READ.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getAiOperations, parseAiOperationsFilter } from "@/lib/platform/ai/invocations";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json(await getAiOperations(parseAiOperationsFilter(req.nextUrl.searchParams)));
}
