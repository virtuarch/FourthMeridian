/**
 * POST /api/platform/customer-success/notifications/automations/[id]/pause  (Comms Center B2, contract v1 §4.9; v1.1 §6.1)
 *
 * { reason, expectedVersion, body: {} }. ACTIVE → PAUSED.
 * Every SCHEDULED item of the automation becomes CANCELLED / AUTOMATION_PAUSED in
 * the same transaction (one CANCELLED ledger row each, after commit).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE") — reducing
 * sending is WRITE. Then the cs-comms-write bucket. The reason-required audit row
 * (COMMS_AUTOMATION_PAUSED) commits in the same transaction.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { readJsonBody, runContent } from "@/lib/notifications/content/http";
import { csCommsWriteLimit } from "@/lib/notifications/content/deps";
import { AUTOMATION_BODY_MAX_BYTES, transitionHandler } from "@/lib/notifications/automations/http";
import { automationServices } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), rateLimit: csCommsWriteLimit }, async (auth, now) => {
    const body = await readJsonBody(req, AUTOMATION_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return transitionHandler("PAUSE", (await ctx.params).id, body.value, auth, getRequestMeta(req), now, automationServices);
  });
}
