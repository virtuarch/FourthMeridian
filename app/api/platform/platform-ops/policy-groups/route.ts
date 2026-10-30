/**
 * GET /api/platform/platform-ops/policy-groups  (PLATFORM OPS PHASE 1 UX)
 *
 * The Policy Group catalogue for Platform Operations' Policies › Policy groups
 * view (PolicyGroupsPanel) — READ-ONLY in Phase 1: editing groups arrives with
 * the entitlement engine (Phase 2). The SAME reader the Growth route uses
 * (lib/platform/policy-groups-read.ts), so the two responses share one shape:
 * definitions from code, customer COUNTS only, no identity.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { readPolicyGroups } from "@/lib/platform/policy-groups-read";

export const runtime = "nodejs";

export type { PolicyGroupsResponse } from "@/lib/platform/policy-groups-read";

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json(await readPolicyGroups());
}
