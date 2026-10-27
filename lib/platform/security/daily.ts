/**
 * lib/platform/security/daily.ts  (Platform visual pass V2 — SECURITY_OPS day series)
 *
 * Failed sign-ins, platform access-denial records and other anomaly trips per
 * UTC day over a short window, for the Security card's trend on the Platform
 * Overview. COUNTS ONLY: every read selects `createdAt` and nothing else — no
 * user, email, IP, key or metadata leaves the database. The access-denial vs
 * other-trip split is a database-side JSON filter on `metadata.type`, so the
 * metadata itself (which carries a per-user key) is never loaded.
 *
 * Population notes, stated on the payload:
 *   - access-denial records are throttled at write time (≤ 1 per user × area
 *     per hour, lib/platform/ops/access-denied.ts) — a floor on refusals;
 *   - rate-limited sign-in attempts write no row and cannot appear.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { ACCESS_DENIED_ANOMALY_TYPE } from "@/lib/platform/ops/access-denied";
import { countByDay, windowDayKeys, windowStart } from "@/lib/platform/trends/daily-core";

export const SECURITY_DAILY_WINDOW_DAYS = 14;
/** Per-read row cap; reaching it makes the series a floor. */
export const SECURITY_DAILY_ROW_CAP = 20_000;

export interface SecurityDay {
  day: string;
  failedSignIns: number;
  accessDenials: number;
  anomalyTrips: number;
}

export interface SecurityDailySeries {
  days: SecurityDay[];
  windowDays: number;
  /** True when a read hit its cap: counts are a floor. */
  floor: boolean;
  basis: string;
  checkedAt: string;
}

export const SECURITY_DAILY_BASIS =
  "AuditLog per UTC day: LOGIN_FAILED; SECURITY_ANOMALY_DETECTED split into platform access-denial records (≤ 1 per user × area per hour) and other detector trips. Rate-limited attempts write no row.";

export async function getSecurityDailySeries(now: Date = new Date(), days = SECURITY_DAILY_WINDOW_DAYS): Promise<SecurityDailySeries> {
  const since = windowStart(now, days);
  const denialFilter = { path: ["type"], equals: ACCESS_DENIED_ANOMALY_TYPE };
  const [failed, denials, trips] = await Promise.all([
    systemDb.auditLog.findMany({
      where: { action: AuditAction.LOGIN_FAILED, createdAt: { gte: since } },
      select: { createdAt: true }, take: SECURITY_DAILY_ROW_CAP,
    }),
    systemDb.auditLog.findMany({
      where: { action: AuditAction.SECURITY_ANOMALY_DETECTED, createdAt: { gte: since }, metadata: denialFilter },
      select: { createdAt: true }, take: SECURITY_DAILY_ROW_CAP,
    }),
    systemDb.auditLog.findMany({
      where: { action: AuditAction.SECURITY_ANOMALY_DETECTED, createdAt: { gte: since }, NOT: { metadata: denialFilter } },
      select: { createdAt: true }, take: SECURITY_DAILY_ROW_CAP,
    }),
  ]);
  const keys = windowDayKeys(now, days);
  const f = countByDay(keys, failed.map((r) => r.createdAt));
  const d = countByDay(keys, denials.map((r) => r.createdAt));
  const t = countByDay(keys, trips.map((r) => r.createdAt));
  return {
    days: keys.map((day) => ({ day, failedSignIns: f[day], accessDenials: d[day], anomalyTrips: t[day] })),
    windowDays: days,
    floor: [failed, denials, trips].some((rows) => rows.length >= SECURITY_DAILY_ROW_CAP),
    basis: SECURITY_DAILY_BASIS,
    checkedAt: now.toISOString(),
  };
}
