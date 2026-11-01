/**
 * POST /api/platform/customer-success/notifications/catalog/[key]/render  (Comms Center B1, contract v1.1 §3.8, D3)
 *
 * Live preview of UNSAVED content: { channel, variant?, content }. Renders with
 * the same validator, substitution (synthetic samples only) and frame as a
 * saved version. PERSISTS NOTHING and AUDITS NOTHING; the body is never logged.
 * Validation errors return 200 with `issues` (html / text / inApp null when not
 * renderable); a body that is not a ContentBody, or over 32 KB, is 400 VALIDATION.
 * 409 PROTECTED | NOT_EDITABLE.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the
 * dedicated cs-comms-render bucket (30/min per operator).
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { RENDER_BODY_MAX_BYTES, readJsonBody, renderHandler, runContent } from "@/lib/notifications/content/http";
import { csCommsRenderLimit } from "@/lib/notifications/content/deps";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  return runContent({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsRenderLimit }, async (_auth, now) => {
    const body = await readJsonBody(req, RENDER_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return renderHandler((await ctx.params).key, body.value, now);
  });
}
