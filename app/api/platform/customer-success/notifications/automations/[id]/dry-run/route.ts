/**
 * POST /api/platform/customer-success/notifications/automations/[id]/dry-run  (Comms Center B2, contract v1 §4.7; v1.1 §6.8)
 *
 * { reason, expectedVersion?, body: { sample?: { triggerRef? }, window?: "7d" | "30d" } }.
 * Replays the recorded trigger facts through the whole live evaluation AS A READ:
 * it sends nothing, claims no item and writes no CommsDelivery row. It writes ONE
 * AutomationRun{mode:"DRY_RUN"} and the audit row, and echoes the window (C8).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), then the
 * cs-comms-dryrun bucket (10/min). The reason-required audit row
 * (COMMS_AUTOMATION_DRY_RUN) commits in the same transaction as the run row.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { readJsonBody, runContent } from "@/lib/notifications/content/http";
import { AUTOMATION_BODY_MAX_BYTES, dryRunHandler } from "@/lib/notifications/automations/http";
import { automationServices, csCommsDryRunLimit } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), rateLimit: csCommsDryRunLimit }, async (auth, now) => {
    const body = await readJsonBody(req, AUTOMATION_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return dryRunHandler((await ctx.params).id, body.value, auth, getRequestMeta(req), now, automationServices);
  });
}
