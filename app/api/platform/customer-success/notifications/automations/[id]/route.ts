/**
 * /api/platform/customer-success/notifications/automations/[id]  (Comms Center B2, contract v1 §4.6, §4.10; v1.1 §6.2)
 *
 * GET   AutomationDetail + the v1.1 §6.2 additions (ownerApproval, lastDryRun,
 *       activationBlockers, liveContent) and the server-computed `viewer` block (D2).
 *       AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"); cs-comms-read.
 * PATCH edit a DRAFT or PAUSED automation: { reason, expectedVersion, body: Partial<…> }.
 *       Bumps `version` (voids any owner approval and dry run). 409 CONFLICT {current} /
 *       INVALID_STATE / PROTECTED; 400 VALIDATION (incl. any copy field).
 *       AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"); cs-comms-write.
 *       The reason-required audit row (COMMS_AUTOMATION_UPDATED) commits in the same transaction.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess, requirePlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { readJsonBody, runContent } from "@/lib/notifications/content/http";
import { csCommsWriteLimit } from "@/lib/notifications/content/deps";
import { AUTOMATION_BODY_MAX_BYTES, detailHandler, patchHandler } from "@/lib/notifications/automations/http";
import { automationServices } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return runContent({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async (auth, now) =>
    detailHandler((await ctx.params).id, auth, now, automationServices));
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), rateLimit: csCommsWriteLimit }, async (auth, now) => {
    const body = await readJsonBody(req, AUTOMATION_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return patchHandler((await ctx.params).id, body.value, auth, getRequestMeta(req), now, automationServices);
  });
}
