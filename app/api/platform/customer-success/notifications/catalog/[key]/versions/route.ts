/**
 * /api/platform/customer-success/notifications/catalog/[key]/versions  (Comms Center B1, contract v1.1 §3.2, §3.3)
 *
 * GET  ?channel=&variant=&state=&cursor=&limit=  the stream's versions (newest first), its
 *      revision token, what is live, the code default, the placeholder allowlist, the
 *      limits, the lock, the `viewer` block (D2) and the advisory `ai` block (D4).
 *      AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"); cs-comms-read.
 * POST save a NEW draft version: { expectedRevision, body: { channel, variant?,
 *      parentVersionId, content, source }, reason? }. 201, or 400 CONTENT_INVALID /
 *      409 PROTECTED | NOT_EDITABLE | CONFLICT {current} | SUGGESTION_EXPIRED.
 *      AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"); cs-comms-write.
 *      The audit row (COMMS_TEMPLATE_DRAFT_SAVED) commits in the same transaction.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess, requirePlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { WRITE_BODY_MAX_BYTES, readJsonBody, runContent, saveDraftHandler, versionsList } from "@/lib/notifications/content/http";
import { contentServices, csCommsWriteLimit } from "@/lib/notifications/content/deps";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  return runContent({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async (auth, now) =>
    versionsList((await ctx.params).key, new URL(req.url), auth, now, contentServices));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), rateLimit: csCommsWriteLimit }, async (auth, now) => {
    const body = await readJsonBody(req, WRITE_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return saveDraftHandler((await ctx.params).key, body.value, auth, getRequestMeta(req), now, contentServices);
  });
}
