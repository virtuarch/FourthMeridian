/**
 * GET /api/platform/customer-success/notifications/catalog/[key]  (Comms Center A-1)
 *
 * One catalog definition in detail (contract §4.3), or 404 NOT_FOUND. The
 * `recent` series is all-null (not observed) until the Phase A delivery
 * ledger exists. No DB read, no PII.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { catalogDetail, runRead } from "@/lib/notifications/catalog/http";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  return runRead({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async (now) => catalogDetail((await ctx.params).key, now));
}
