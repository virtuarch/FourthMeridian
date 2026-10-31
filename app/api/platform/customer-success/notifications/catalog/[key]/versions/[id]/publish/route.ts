/**
 * POST /api/platform/customer-success/notifications/catalog/[key]/versions/[id]/publish  (Comms Center B1, contract v1.1 §3.4)
 *
 * Make a DRAFT the live content of its stream: { reason, expectedRevision,
 * body: { acknowledgeWarnings } }. Every send after commit renders it.
 * 409 PROTECTED | NOT_EDITABLE | CONFLICT {current} | INVALID_STATE | STALE_DRAFT |
 * WARNINGS_UNACKNOWLEDGED; 400 CONTENT_INVALID / VALIDATION (incl. a missing reason).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "CONTROL"), then
 * the cs-comms-control bucket. The reason-required audit row
 * (COMMS_TEMPLATE_PUBLISHED) commits in the same transaction as the change.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { WRITE_BODY_MAX_BYTES, publishHandler, readJsonBody, runContent } from "@/lib/notifications/content/http";
import { contentServices, csCommsControlLimit } from "@/lib/notifications/content/deps";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string; id: string }> }): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "CONTROL"), rateLimit: csCommsControlLimit }, async (auth, now) => {
    const body = await readJsonBody(req, WRITE_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    const { key, id } = await ctx.params;
    return publishHandler(key, id, body.value, auth, getRequestMeta(req), now, contentServices);
  });
}
