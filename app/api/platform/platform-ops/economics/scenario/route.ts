/**
 * GET /api/platform/platform-ops/economics/scenario?group=<KEY>&allowance=<USD/day>
 * (Platform Economics — Entitlements, HYPOTHETICAL scenario)
 *
 * "What if group X's daily AI allowance were $Y": the group's recorded customer
 * AI spend this cycle re-read with each customer-day capped at Y
 * (lib/platform/economics/entitlements-core.ts buildScenario). HYPOTHETICAL and
 * READ-ONLY — a GET that writes nothing, changes no policy and moves no
 * allowance (pinned by a static scan in entitlements.test.ts). An invalid query
 * or an unknown group is a 400.
 *
 * Identity-free (opaque refs). AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getEconomicsScenario } from "@/lib/platform/economics/providers-entitlements";
import type { EconomicsScenario } from "@/lib/platform/economics/entitlements-core";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const body = await getEconomicsScenario(new URL(req.url).searchParams, Date.now());
  if (!body) return NextResponse.json({ error: "A scenario needs a known policy group and an allowance of 0–1000 USD/day." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(body satisfies EconomicsScenario, { headers: { "Cache-Control": "no-store" } });
}
