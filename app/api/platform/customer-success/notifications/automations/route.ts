/**
 * /api/platform/customer-success/notifications/automations  (Comms Center B2, contract v1 §4.6, §4.10; v1.1 §6.1)
 *
 * GET  ?state=&cursor=&limit=  the automations (ListEnvelope<AutomationSummary>).
 *      AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"); cs-comms-read.
 * POST create a DRAFT: { reason, body: { triggerKey, definitionKey, name, recipient,
 *      conditions?, delay?, dedupeKeyTemplate?, frequencyCap?, retryPolicy?,
 *      maxRecipientsPerRun?, channels?, variant? } }. No copy, no code: 400 on any
 *      copy field; 409 PROTECTED on a protected definition (before validation).
 *      AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"); cs-comms-write.
 *      The reason-required audit row (COMMS_AUTOMATION_CREATED) commits in the same transaction.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess, requirePlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { readJsonBody, runContent } from "@/lib/notifications/content/http";
import { csCommsWriteLimit } from "@/lib/notifications/content/deps";
import { AUTOMATION_BODY_MAX_BYTES, createHandler, listHandler } from "@/lib/notifications/automations/http";
import { automationServices } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return runContent({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, (_auth, now) =>
    listHandler(new URL(req.url), now, automationServices));
}

export async function POST(req: NextRequest): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), rateLimit: csCommsWriteLimit }, async (auth, now) => {
    const body = await readJsonBody(req, AUTOMATION_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return createHandler(body.value, auth, getRequestMeta(req), now, automationServices);
  });
}
