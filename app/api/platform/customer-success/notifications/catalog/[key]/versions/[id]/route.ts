/**
 * GET /api/platform/customer-success/notifications/catalog/[key]/versions/[id]  (Comms Center B1, contract v1.1 §3.3)
 *
 * One version (TemplateVersionDTO), or 404 when the id is not a version of this key.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { runContent, versionGet } from "@/lib/notifications/content/http";
import { contentServices } from "@/lib/notifications/content/deps";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ key: string; id: string }> }): Promise<Response> {
  return runContent({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async () => {
    const { key, id } = await ctx.params;
    return versionGet(key, id, contentServices);
  });
}
