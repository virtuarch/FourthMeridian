/**
 * GET /api/platform/growth-revenue/policy-groups  (P1 — the Policy Group catalogue)
 *
 * GROWTH_REVENUE owns the DEFINITIONS and rollout policy; this is their read-only
 * view: every Policy Group with each dimension's value beside its platform
 * ceiling, the overlays, the cohorts, and how many customers sit on each —
 * counts only, no identity (assignment happens in Customer Success, which may
 * resolve identity; this area may not). Definitions come from code
 * (lib/entitlements/catalogue.ts); only the counts are read, through fm_system.
 *
 * PLATFORM OPS PHASE 1 UX — the read itself lives in lib/platform/policy-groups-read.ts,
 * shared with GET /api/platform/platform-ops/policy-groups (PLATFORM_OPS READ),
 * so both answer the same shape. The response here is unchanged.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { readPolicyGroups } from "@/lib/platform/policy-groups-read";

export const runtime = "nodejs";

// The response types moved with the reader; re-exported so existing importers
// (GrowthPolicyGroupsWidget) keep their path.
export type { CohortRow, OverlayRow, PolicyDimensionRow, PolicyGroupRow, PolicyGroupsResponse } from "@/lib/platform/policy-groups-read";

export async function GET() {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  return NextResponse.json(await readPolicyGroups());
}
