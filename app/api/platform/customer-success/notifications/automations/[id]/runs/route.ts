/**
 * GET /api/platform/customer-success/notifications/automations/[id]/runs?cursor=&limit=  (Comms Center B2, contract v1 §4.6)
 *
 * The automation's LIVE and DRY_RUN runs, newest first (ListEnvelope<AutomationRunItem>):
 * counts only, every suppression reason present, haltReason when HALTED.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { runContent } from "@/lib/notifications/content/http";
import { runsHandler } from "@/lib/notifications/automations/http";
import { automationServices } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return runContent({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async (_auth, now) =>
    runsHandler((await ctx.params).id, new URL(req.url), now, automationServices));
}
