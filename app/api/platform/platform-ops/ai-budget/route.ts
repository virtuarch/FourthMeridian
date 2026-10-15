/**
 * GET /api/platform/platform-ops/ai-budget  (AI COST CONTROLS — Economics)
 *
 * The budget utilization read model (AiBudgetUtilization): rolling-24 h fleet
 * spend on customer surfaces against the fleet threshold, the top customers by
 * opaque reference with today's spend against THEIR effective allowance, spend
 * by surface, the unpriced count, the two spend rules' recent triggers and the
 * controls in force. Every dollar is an estimate, never a bill.
 *
 * Read-only, fm_system, opaque refs only — no email, name, full id or Space.
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { loadAiBudgetUtilization } from "@/lib/platform/ai/ai-budget";
import type { AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";

export const runtime = "nodejs";

export type AiBudgetResponse = AiBudgetUtilization;

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const model = await loadAiBudgetUtilization();
  return NextResponse.json(model satisfies AiBudgetResponse, { headers: { "Cache-Control": "no-store" } });
}
