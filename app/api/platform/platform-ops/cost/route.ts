/**
 * GET /api/platform/platform-ops/cost  (OPS-5 S10)
 *
 * The read surface for Cost & Latency Intelligence — purely derived over S7
 * history + S9 convergence (lib/platform/cost). Read-only; every figure states
 * its provenance and trust tier. Accepts `asOf` / `compareTo` (YYYY-MM-DD).
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getCostIntelligence } from "@/lib/platform/cost/cost";
import type { CostResult } from "@/lib/platform/cost/types";

export const runtime = "nodejs";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const url = new URL(req.url);
  const asOfParam = url.searchParams.get("asOf");
  const compareParam = url.searchParams.get("compareTo");
  const asOf = asOfParam && YMD.test(asOfParam) ? asOfParam : undefined;
  const compareTo = compareParam && YMD.test(compareParam) ? compareParam : undefined;

  const result = await getCostIntelligence({ asOf, compareTo });
  return NextResponse.json(result satisfies CostResult);
}
