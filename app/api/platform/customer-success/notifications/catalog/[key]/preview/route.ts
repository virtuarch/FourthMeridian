/**
 * GET /api/platform/customer-success/notifications/catalog/[key]/preview
 *     ?channel=email-html|email-text|in-app|operator|banner[&variant=<name>]  (Comms Center A-1)
 *
 * Renders a definition with SYNTHETIC fixtures only (contract §4.4) and returns
 * the rendered strings. It never sends: lib/notifications/catalog/preview.ts
 * imports no transport. 409 INVALID_STATE when the definition has no such
 * channel; 400 VALIDATION for an unknown channel, variant or parameter.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { catalogPreview, runRead } from "@/lib/notifications/catalog/http";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  return runRead({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async (now) => catalogPreview((await ctx.params).key, new URL(req.url), now));
}
