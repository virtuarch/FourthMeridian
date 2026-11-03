/**
 * GET /api/platform/platform-ops/ai-budget/calls?until=<ISO|ms>&page=<n>
 * (AI & Costs — the 24 h budget KPI's records)
 *
 * One page of the customer AI calls in the budget KPI's exact rolling window
 * ([until − 24 h, until]; `until` is the KPI's checkedAt from the deep link,
 * else now), with the KPI's own status over that window as the summary — the
 * same grouped read and fold (lib/platform/ai/budget-calls.ts), so the list
 * total and the KPI agree. Every dollar is an estimate, never a bill.
 *
 * Read-only, fm_system, identity-free (opaque customer refs only).
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). Never cached.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { loadBudgetCalls } from "@/lib/platform/ai/budget-calls";
import { parseBudgetCallsQuery, type BudgetCallsResponse } from "@/lib/platform/ai/budget-calls-core";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const q = parseBudgetCallsQuery(new URL(req.url).searchParams, Date.now());
  const body = await loadBudgetCalls(q);
  return NextResponse.json(body satisfies BudgetCallsResponse, { headers: { "Cache-Control": "no-store" } });
}
