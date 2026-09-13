/**
 * GET /api/platform/platform-ops/policies
 *
 * PLATFORM OPS POLICIES (Slice 1) — the read model behind the Policies
 * workspace: for each financial-refresh source kind (BANK, WALLET), what is
 * CONFIGURED, what is EFFECTIVE, what the deployed scheduler can HONOUR, and
 * what the latest recorded sweep ACTUALLY ran under. Composed at read time from
 * PlatformSetting, the job registry and the JobRun ledger; no second store.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * ⚠️ READ-ONLY. No write exists on this route family yet. Editing declared
 * operational policy is the `control-plane-policy` family
 * (lib/platform/capability-classification.ts, PLANNED); the write route arrives
 * with that capability and consumes the SAME descriptor and the SAME capability
 * derivation this read model already exposes.
 *
 * ⚠️ NO PROVIDER CALL, NO JOB, NO AI CALL. Opening the page observes persisted
 * and derived state only (lib/platform/policies/refresh-policies.ts).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { loadRefreshPoliciesReadModel, type RefreshPoliciesReadModel } from "@/lib/platform/policies/refresh-policies";

export const runtime = "nodejs";

export type PlatformPoliciesResponse = RefreshPoliciesReadModel;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const model = await loadRefreshPoliciesReadModel();
  return NextResponse.json(model satisfies PlatformPoliciesResponse);
}
