/**
 * GET /api/platform/customer-success/notifications/catalog/[key]/preview
 *     ?channel=email-html|email-text|in-app|operator|banner[&variant=<name>][&versionId=<id>]  (Comms Center A-1, B1)
 *
 * Renders a definition with SYNTHETIC fixtures only (contract §4.4) and returns
 * the rendered strings. It never sends. 409 INVALID_STATE when the definition
 * has no such channel; 400 VALIDATION for an unknown channel, variant or parameter.
 *
 * B1 (contract v1.1 §3.7): `versionId` names any version of THIS key (another
 * key's ⇒ 404; another channel's ⇒ 409); with none, the LIVE content (the
 * published version, or the code default). Placeholders render their synthetic
 * `sample`; no parameter supplies a value. Adds { versionId, source, issues }.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { runRead } from "@/lib/notifications/catalog/http";
import { previewHandler } from "@/lib/notifications/content/http";
import { contentServices } from "@/lib/notifications/content/deps";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  return runRead({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async (now) => previewHandler((await ctx.params).key, new URL(req.url), now, contentServices));
}
