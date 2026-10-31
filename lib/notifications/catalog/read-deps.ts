/**
 * lib/notifications/catalog/read-deps.ts  (Comms Center Phase A-1)
 *
 * The production `cs-comms-read` bucket (contract §4.1, 120/min per operator).
 * The Customer Success READ gate is called in each route file itself, where
 * the route-guard census (scripts/lib/route-guards.ts) can see it. Kept apart
 * from http.ts so the handlers stay testable without a DB.
 */

import "server-only";
import { limitByUser } from "@/lib/rate-limit";
import { CS_COMMS_READ_BUCKET, CS_COMMS_READ_LIMIT, type ReadDeps } from "@/lib/notifications/catalog/http";

export const csCommsReadLimit: ReadDeps["rateLimit"] = (userId) => limitByUser(userId, CS_COMMS_READ_BUCKET, CS_COMMS_READ_LIMIT);
