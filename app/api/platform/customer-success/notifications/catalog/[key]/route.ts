/**
 * GET /api/platform/customer-success/notifications/catalog/[key]  (Comms Center A-1, A-2a, B1)
 *
 * One catalog definition in detail (contract §4.3), or 404 NOT_FOUND. The
 * `recent` series is the key's last 30 UTC days from the delivery ledger
 * (A-2a): null before the ledger's first day, then the day's count of
 * recorded outcomes. A failed ledger read is 503 UNAVAILABLE. No PII.
 *
 * B1 (contract v1.1 §1.1, §2.1): plus `content` (per editable leg: variants and
 * what is live), `contentLocked`, `divergesFrom` and the server-computed
 * `viewer` block for the session operator (D2, D6).
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), then the cs-comms-read bucket.
 */

import { requirePlatformAccess } from "@/lib/platform/authorize";
import { csCommsReadLimit } from "@/lib/notifications/catalog/read-deps";
import { runRead } from "@/lib/notifications/catalog/http";
import { recentSeriesForKey } from "@/lib/notifications/delivery/analytics";
import { deliveryReadSource } from "@/lib/notifications/delivery/read-store";
import { catalogDetailV11 } from "@/lib/notifications/content/http";
import { contentServices } from "@/lib/notifications/content/deps";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  return runRead({ guard: () => requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rateLimit: csCommsReadLimit }, async (now, auth) =>
    catalogDetailV11((await ctx.params).key, now, auth, contentServices, (key, at) => recentSeriesForKey(deliveryReadSource, key, at)));
}
