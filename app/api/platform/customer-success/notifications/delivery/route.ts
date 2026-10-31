/**
 * GET /api/platform/customer-success/notifications/delivery  (Comms Center A-2a)
 *
 * Delivery analytics from the delivery ledger (contract §4.11, C1–C4):
 * ?window=7d|30d|90d (default 7d) &channel= &status= &template=<catalog key>.
 * Totals / per-key status vectors over the OBSERVED range, six dense day series
 * (null before the ledger's first day, 0 on an observed day with no sends),
 * the coverage block and checkedAt. Aggregates only: no recipient, no body.
 * A failed ledger read is 503 UNAVAILABLE — never zeros or an empty list.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket (120/min).
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { runRead } from "@/lib/notifications/catalog/http";
import { deliveryAnalytics } from "@/lib/notifications/delivery/analytics";
import { deliveryReadSource } from "@/lib/notifications/delivery/read-store";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return runRead({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, (now) =>
    deliveryAnalytics(new URL(req.url), now, deliveryReadSource, process.env));
}
