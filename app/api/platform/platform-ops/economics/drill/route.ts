/**
 * GET /api/platform/platform-ops/economics/drill?figure=<key>&window=<cycle|7d|30d|90d>&until=<epoch ms>
 * (Platform Economics — a KPI's records)
 *
 * The rows an Overview figure is the sum of, recomputed from the SAME inputs at
 * the KPI's own window end (`until` = the snapshot's checkedAt, carried in the
 * figure's drill href), with the figure itself beside them — so the list total
 * and the KPI agree (lib/platform/economics/snapshot-core.ts). A figure without
 * records (revenue, margin, infrastructure) is a 404.
 *
 * Read-only, fm_system, identity-free (opaque customer references only).
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getEconomicsDrill } from "@/lib/platform/economics/snapshot";
import { parseEconomicsDrillQuery, type EconomicsDrillResponse } from "@/lib/platform/economics/snapshot-core";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const q = parseEconomicsDrillQuery(new URL(req.url).searchParams, Date.now());
  if (!q) return NextResponse.json({ error: "This figure has no records to drill into." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const body = await getEconomicsDrill(q);
  return NextResponse.json(body satisfies EconomicsDrillResponse, { headers: { "Cache-Control": "no-store" } });
}
