/**
 * GET /api/platform/security-ops/anomalies
 *
 * Wave 3 ⑧ — Security Ops anomaly widget read. Two things over the same data
 * the inline detector writes/uses:
 *   - `trips`: recent SECURITY_ANOMALY_DETECTED audit rows (the detector's own
 *     trip history — type, count, when), most recent first.
 *   - `summary`: a live pulse — LOGIN_FAILED volume over the detector's primary
 *     window, and the trip count over the last 24h.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ") — the same
 * granted, non-SYSTEM_ADMIN platform staff gate the other Security Ops widgets
 * use (never requireSystemAdmin).
 *
 * PII (BETA V2): the detector's `metadata.key` is NOT coarse — it carries the raw
 * login identifier (email or username) or a full IP. It is projected server-side
 * through lib/platform/security/anomalies-core.ts into a key KIND plus an opaque
 * digest, so the raw key never leaves this process; no email, IP or user-agent
 * is returned. `summary.failedLoginsWindow` is COUNT(LOGIN_FAILED) platform-wide
 * over the identifier window — every reason, every account — which the surface
 * labels as exactly that, not as the detector's per-account measure.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { ANOMALY_THRESHOLDS } from "@/lib/security/anomalies";
import { projectAnomalyTrip, type AnomalyTripProjection } from "@/lib/platform/security/anomalies-core";

export const runtime = "nodejs";

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

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  const windowMinutes = ANOMALY_THRESHOLDS.identifierFailedLogin.windowMinutes;
  const now = Date.now();
  const windowStart = new Date(now - windowMinutes * 60_000);
  const dayStart = new Date(now - 24 * 60 * 60_000);

  const [rows, failedLoginsWindow, tripsLast24h] = await Promise.all([
    db.auditLog.findMany({
      where:   { action: AuditAction.SECURITY_ANOMALY_DETECTED },
      orderBy: { createdAt: "desc" },
      take:    RECENT_LIMIT,
      select:  { id: true, createdAt: true, metadata: true },
    }),
    db.auditLog.count({ where: { action: AuditAction.LOGIN_FAILED, createdAt: { gte: windowStart } } }),
    db.auditLog.count({ where: { action: AuditAction.SECURITY_ANOMALY_DETECTED, createdAt: { gte: dayStart } } }),
  ]);

  const trips: AnomalyTrip[] = rows.map((r) => projectAnomalyTrip(r, windowMinutes));

  return NextResponse.json({
    trips,
    summary: { failedLoginsWindow, windowMinutes, tripsLast24h },
  } satisfies AnomaliesResponse);
}
