/**
 * lib/platform/security/analytics.ts  (Platform Spaces 2.0 — Security: THE READER)
 *
 * Reads security counts on fm_system (`systemDb`; lib/platform/ is the
 * allowlisted neighbourhood). EVERY audit read is a GROUP BY in SQL that returns
 * a day, a CODE (reason / detector type / result / action) and a count — the
 * metadata's identifier, the anomaly key, the IP and the user agent never leave
 * the database. The privacy scan (lib/platform/observability-privacy.test.ts)
 * pins this file. Read-only.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { AuditAction, OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { getSetting, PlatformSettingKey } from "@/lib/platform-settings";
import { buildSecurityAnalytics, windowDays, type DayCount, type HourCount, type SecurityAnalyticsFacts } from "./analytics-core";
import type { SecurityAnalyticsResponse } from "./analytics-types";

export type SecurityAnalyticsDb = typeof systemDb;

/** Grouped rows per read — a window of 90 days × a handful of codes stays far below. */
export const SECURITY_ANALYTICS_GROUP_CAP = 10_000;

type Raw = { day: string; key: string | null; count: bigint | number };
const toDayCounts = (rows: readonly Raw[]): DayCount[] => rows.map((r) => ({ day: r.day, key: r.key, count: Number(r.count) }));

async function byDay(client: SecurityAnalyticsDb, actions: readonly string[], keyPath: string | null, since: Date): Promise<Raw[]> {
  const key = keyPath === null ? Prisma.sql`NULL::text` : Prisma.sql`"metadata"->>${keyPath}`;
  return client.$queryRaw<Raw[]>`
    SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, ${key} AS key, count(*) AS count
      FROM "AuditLog"
     WHERE "action" IN (${Prisma.join([...actions])}) AND "createdAt" >= ${since}
     GROUP BY 1, 2
     LIMIT ${SECURITY_ANALYTICS_GROUP_CAP}`;
}

export async function loadSecurityAnalyticsFacts(client: SecurityAnalyticsDb, now: Date, windowN: 30 | 90): Promise<SecurityAnalyticsFacts> {
  const since = new Date(`${windowDays(now, windowN)[0]}T00:00:00.000Z`);
  const feed = OPERATOR_ACTION_FEED_ACTIONS as readonly string[];

  const [signIns, failures, hours, anomalies, refusals, opResult, opAction, grants, customers, admins, sessions, allUsersSetting] = await Promise.all([
    byDay(client, [AuditAction.LOGIN], null, since),
    byDay(client, [AuditAction.LOGIN_FAILED], "reason", since),
    client.$queryRaw<{ dow: number; hour: number; count: bigint | number }[]>`
      SELECT (extract(isodow FROM "createdAt")::int - 1) AS dow, extract(hour FROM "createdAt")::int AS hour, count(*) AS count
        FROM "AuditLog"
       WHERE "action" = ${AuditAction.LOGIN_FAILED} AND "createdAt" >= ${since}
       GROUP BY 1, 2`,
    byDay(client, [AuditAction.SECURITY_ANOMALY_DETECTED], "type", since),
    byDay(client, [AuditAction.PLATFORM_CONTROL_REFUSED], null, since),
    byDay(client, feed, "result", since),
    client.$queryRaw<{ key: string; count: bigint | number }[]>`
      SELECT "action" AS key, count(*) AS count
        FROM "AuditLog"
       WHERE "action" IN (${Prisma.join([...feed])}) AND "createdAt" >= ${since}
       GROUP BY 1`,
    client.platformGrant.findMany({
      where: { status: "ACTIVE" }, distinct: ["userId"],
      select: { user: { select: { totpEnabled: true, deactivatedAt: true } } },
    }),
    client.user.groupBy({ by: ["totpEnabled"], where: { role: "USER", deactivatedAt: null }, _count: { _all: true } }),
    client.user.groupBy({ by: ["totpEnabled"], where: { role: "SYSTEM_ADMIN", deactivatedAt: null }, _count: { _all: true } }),
    client.userSession.count({ where: { revokedAt: null } }),
    getSetting(PlatformSettingKey.REQUIRE_TOTP_ALL_USERS),
  ]);

  const cov = (rows: readonly { totpEnabled: boolean; _count: { _all: number } }[]) => ({
    enrolled: rows.filter((r) => r.totpEnabled).reduce((a, r) => a + r._count._all, 0),
    total: rows.reduce((a, r) => a + r._count._all, 0),
  });
  const liveOperators = grants.filter((g) => g.user.deactivatedAt === null);
  const grouped = [signIns, failures, anomalies, refusals, opResult];

  return {
    signIns: toDayCounts(signIns),
    failures: toDayCounts(failures),
    failureHours: hours.map((h) => ({ dow: Number(h.dow), hour: Number(h.hour), count: Number(h.count) }) satisfies HourCount),
    anomalies: toDayCounts(anomalies),
    refusals: toDayCounts(refusals),
    operatorByResult: toDayCounts(opResult),
    operatorByAction: opAction.map((r) => ({ key: r.key, count: Number(r.count) })),
    twoFactor: {
      customers: cov(customers),
      operators: { enrolled: liveOperators.filter((g) => g.user.totpEnabled).length, total: liveOperators.length },
      admins: cov(admins),
      enforcement: {
        allUsers: allUsersSetting === "true",
        // require_totp_system_admin cannot be turned off (lib/platform-settings.ts).
        systemAdmins: true,
        operators: env.isOperatorTotpEnforced,
      },
    },
    activeSessions: sessions,
    floor: grouped.some((g) => g.length >= SECURITY_ANALYTICS_GROUP_CAP),
  };
}

export async function getSecurityAnalytics(windowN: 30 | 90, deps: { now?: Date; client?: SecurityAnalyticsDb } = {}): Promise<SecurityAnalyticsResponse> {
  const now = deps.now ?? new Date();
  return buildSecurityAnalytics(await loadSecurityAnalyticsFacts(deps.client ?? systemDb, now, windowN), now, windowN);
}
