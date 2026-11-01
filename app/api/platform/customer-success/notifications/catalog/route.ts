/**
 * GET /api/platform/customer-success/notifications/catalog  (Comms Center A-1)
 *
 * The unified notification catalog (contract §4.2): every definition, sorted by
 * status then displayName; filters status/category/audience/channel/consentClass/q;
 * cursor + limit (max 100, so limit=100 returns the whole catalog). Code
 * registry only: no DB read, no PII.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { catalogList, runRead } from "@/lib/notifications/catalog/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return runRead({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, (now) => catalogList(new URL(req.url), now));
}
