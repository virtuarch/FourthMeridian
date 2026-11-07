/**
 * GET /api/platform/platform-ops/economics/platform-ai?window=<7d|30d|90d|cycle>&until=<epoch ms>&page=<n>
 * (Platform Economics — the Platform AI category's records)
 *
 * Every AI invocation made for an OPERATOR (Comms Center authoring) in the
 * window — returned and failed — with model, tokens, latency, outcome and the
 * estimated cost, beside the KPI itself (lib/platform/economics/platform-ai.ts).
 * Σ returned cost = the KPI. Operators appear as opaque references only.
 *
 * Read-only, fm_system. AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getPlatformAiRecords, parsePlatformAiQuery, type PlatformAiRecords } from "@/lib/platform/economics/platform-ai";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const q = parsePlatformAiQuery(new URL(req.url).searchParams, Date.now());
  if (!q) return NextResponse.json({ error: "window must be 7d, 30d, 90d or cycle." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const body = await getPlatformAiRecords(q);
  return NextResponse.json(body satisfies PlatformAiRecords, { headers: { "Cache-Control": "no-store" } });
}
