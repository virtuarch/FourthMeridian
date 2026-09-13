/**
 * GET /api/platform/platform-ops/refresh-policy
 *
 * The expected refresh cadence per source kind (BANK, WALLET) — the runtime
 * policy source health judges "overdue" against — with what the production
 * scheduler can actually honour. The SAME PlatformSetting rows the health
 * loaders read; no second store.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * ⚠️ READ-ONLY IN THIS SLICE, DELIBERATELY. Editing declared operational policy
 * is classified as a CONTROL capability (lib/platform/capability-classification.ts,
 * "control-plane-policy", PLANNED), and CONTROL is not yet issuable. Gating the
 * write at WRITE would contradict that classification; gating it at CONTROL would
 * ship the capability. The write path therefore arrives with CONTROL, and must
 * refuse any cadence `schedulerCanHonour` rejects. Until then the settings are
 * set through lib/platform-settings.ts setSetting.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { loadRefreshPolicies } from "@/lib/platform/refresh-policy";
import {
  REFRESH_CADENCES, SCHEDULER_FLOOR_HOURS, schedulerCanHonour, type RefreshSourceKind,
} from "@/lib/platform/refresh-policy.core";

export const runtime = "nodejs";

const KINDS: readonly RefreshSourceKind[] = ["BANK", "WALLET"];

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const policies = await loadRefreshPolicies(db);
  return NextResponse.json({
    policies: KINDS.map((kind) => ({
      sourceKind: kind,
      cadence: policies[kind].cadence,
      expectedEveryHours: policies[kind].expectedEveryHours,
      graceHours: policies[kind].graceHours,
      overdueAfterHours: policies[kind].overdueAfterHours,
      origin: policies[kind].origin,
      schedulerFloorHours: SCHEDULER_FLOOR_HOURS[kind],
      honourableCadences: REFRESH_CADENCES.filter((c) => schedulerCanHonour(kind, c)),
    })),
  });
}
