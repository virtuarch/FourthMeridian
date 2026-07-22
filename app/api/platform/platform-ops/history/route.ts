/**
 * GET /api/platform/platform-ops/history  (OPS-5 S7)
 *
 * The read surface for Operational History — the canonical historical authority
 * (lib/platform/history). Read-only, aggregate + non-monetary only (dates,
 * counts, states, trust tiers). Mirrors Financial time: accepts `asOf` and
 * `compareTo` (YYYY-MM-DD) query params — the SAME contract customer Perspectives
 * use; no second date authority.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getOperationalHistory } from "@/lib/platform/history/history";
import type { OperationalHistoryResult } from "@/lib/platform/history/types";

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

  const history = await getOperationalHistory({ asOf, compareTo });
  return NextResponse.json(history satisfies OperationalHistoryResult);
}
