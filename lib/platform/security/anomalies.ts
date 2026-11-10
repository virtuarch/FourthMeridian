/**
 * lib/platform/security/anomalies.ts  (P12a — Security Ops anomaly widget reader)
 *
 * The anomaly widget read, moved verbatim out of
 * GET /api/platform/security-ops/anomalies (pure move; pinned old-vs-new by
 * ./p12a-readers.test.ts). The route keeps its gate —
 * requirePlatformAccess("SECURITY_OPS", "READ") — and calls this reader with
 * its clock.
 *
 *   - `trips`: recent SECURITY_ANOMALY_DETECTED audit rows, most recent first,
 *     projected through ./anomalies-core.ts (the raw detector key → a key KIND
 *     plus an opaque digest; no email, IP or user-agent leaves this reader).
 *   - `summary`: COUNT(LOGIN_FAILED) platform-wide over the identifier window,
 *     and the trip count over the last 24h.
 *
 * AUTHORITY: the caller passes its client; there is no default.
 */

import type { PrismaClient } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { ANOMALY_THRESHOLDS } from "@/lib/security/anomalies";
import { projectAnomalyTrip, type AnomalyTripProjection } from "./anomalies-core";

const RECENT_LIMIT = 15;

export type AnomalyTrip = AnomalyTripProjection;

export interface AnomaliesResponse {
  trips: AnomalyTrip[];
  summary: {
    failedLoginsWindow:   number; // LOGIN_FAILED over the identifier window
    windowMinutes:        number;
    tripsLast24h:         number;
  };
}

/** The only model this reader touches. */
export type SecurityAnomaliesClient = Pick<PrismaClient, "auditLog">;

/** `now` is the caller's epoch-ms clock (the route passes Date.now()). */
export async function readSecurityAnomalies(client: SecurityAnomaliesClient, now: number): Promise<AnomaliesResponse> {
  const windowMinutes = ANOMALY_THRESHOLDS.identifierFailedLogin.windowMinutes;
  const windowStart = new Date(now - windowMinutes * 60_000);
  const dayStart = new Date(now - 24 * 60 * 60_000);

  const [rows, failedLoginsWindow, tripsLast24h] = await Promise.all([
    client.auditLog.findMany({
      where:   { action: AuditAction.SECURITY_ANOMALY_DETECTED },
      orderBy: { createdAt: "desc" },
      take:    RECENT_LIMIT,
      select:  { id: true, createdAt: true, metadata: true },
    }),
    client.auditLog.count({ where: { action: AuditAction.LOGIN_FAILED, createdAt: { gte: windowStart } } }),
    client.auditLog.count({ where: { action: AuditAction.SECURITY_ANOMALY_DETECTED, createdAt: { gte: dayStart } } }),
  ]);

  const trips: AnomalyTrip[] = rows.map((r) => projectAnomalyTrip(r, windowMinutes));

  return {
    trips,
    summary: { failedLoginsWindow, windowMinutes, tripsLast24h },
  };
}
