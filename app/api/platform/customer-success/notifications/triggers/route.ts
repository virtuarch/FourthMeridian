/**
 * GET /api/platform/customer-success/notifications/triggers  (Comms Center A-1)
 *
 * The controlled trigger catalog (contract §4.5, §5.1), read-only. Code
 * registry only: no DB read, no PII.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { runRead, triggersList } from "@/lib/notifications/catalog/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return runRead({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, (now) => triggersList(new URL(req.url), now));
}
