/**
 * lib/platform/activity/activity.ts  (OPS-6C User Activity Intelligence)
 *
 * A PURE PROJECTION of user-activity metrics over the ledgers that ALREADY exist —
 * the immutable `AuditLog` event ledger (`LOGIN` per sign-in, `SPACE_SWITCH` per
 * Space open) + `User` + `UserSession`. NO new telemetry, NO historical storage:
 * the ledgers ARE the history (the S7 idiom). DAU/WAU/MAU are distinct-user login
 * counts over 1/7/30-day windows; most-active-Spaces come from the SPACE_SWITCH
 * ledger. Reads only; no writes.
 *
 * PURE CORE + INJECTED I/O: the real db-backed reads are built here; tests pass a
 * fake `ActivityReaders`. The Space ranking is a pure function.
 */

import "server-only";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";

const DAY_MS = 86_400_000;

export interface SpaceActivity {
  spaceId: string;
  spaceName: string;
  opens: number;
}
export interface UserActivityMetrics {
  totalUsers: number;
  newUsers7: number;
  newUsers30: number;
  activatedEver: number; // distinct users with ≥1 session (signed in at least once)
  dau: number;
  wau: number;
  mau: number;
  /** Most-active Spaces by SPACE_SWITCH opens in the last 30d, top-first. */
  topSpaces: SpaceActivity[];
  checkedAt: string;
}

export interface ActivityReaders {
  now: Date;
  /** Distinct userIds with a LOGIN AuditLog row since `since`. */
  distinctLoginUsers(since: Date): Promise<number>;
  totalUsers(): Promise<number>;
  newUsersSince(since: Date): Promise<number>;
  /** Distinct userIds with ≥1 UserSession ever. */
  activatedEver(): Promise<number>;
  /** Raw SPACE_SWITCH events since `since` (spaceId + name from metadata). */
  spaceOpensSince(since: Date): Promise<{ spaceId: string; spaceName: string }[]>;
}

/** Pure: rank Spaces by open count, top `cap` first. */
export function rankSpaces(events: readonly { spaceId: string; spaceName: string }[], cap = 8): SpaceActivity[] {
  const byId = new Map<string, SpaceActivity>();
  for (const e of events) {
    const cur = byId.get(e.spaceId) ?? { spaceId: e.spaceId, spaceName: e.spaceName, opens: 0 };
    cur.opens++;
    if (e.spaceName) cur.spaceName = e.spaceName;
    byId.set(e.spaceId, cur);
  }
  return [...byId.values()].sort((a, b) => b.opens - a.opens).slice(0, cap);
}

// ── Real readers ─────────────────────────────────────────────────────────────────

function realReaders(now: Date): ActivityReaders {
  return {
    now,
    async distinctLoginUsers(since) {
      const rows = await db.auditLog.findMany({
        where: { action: AuditAction.LOGIN, createdAt: { gte: since }, userId: { not: null } },
        select: { userId: true },
        distinct: ["userId"],
      });
      return rows.length;
    },
    totalUsers: () => db.user.count(),
    newUsersSince: (since) => db.user.count({ where: { createdAt: { gte: since } } }),
    async activatedEver() {
      const rows = await db.userSession.groupBy({ by: ["userId"], _count: { _all: true } });
      return rows.length;
    },
    async spaceOpensSince(since) {
      const rows = await db.auditLog.findMany({
        where: { action: AuditAction.SPACE_SWITCH, createdAt: { gte: since }, spaceId: { not: null } },
        select: { spaceId: true, metadata: true },
        take: 5000,
      });
      return rows.map((r) => ({
        spaceId: r.spaceId as string,
        spaceName: ((r.metadata ?? {}) as { spaceName?: string }).spaceName ?? "",
      }));
    },
  };
}

// ── The projection ─────────────────────────────────────────────────────────────────

export async function getUserActivity(deps: { now?: Date; readers?: ActivityReaders } = {}): Promise<UserActivityMetrics> {
  const now = deps.now ?? new Date();
  const r = deps.readers ?? realReaders(now);
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const [totalUsers, newUsers7, newUsers30, activatedEver, dau, wau, mau, opens30] = await Promise.all([
    r.totalUsers(),
    r.newUsersSince(since(7)),
    r.newUsersSince(since(30)),
    r.activatedEver(),
    r.distinctLoginUsers(since(1)),
    r.distinctLoginUsers(since(7)),
    r.distinctLoginUsers(since(30)),
    r.spaceOpensSince(since(30)),
  ]);

  return {
    totalUsers, newUsers7, newUsers30, activatedEver,
    dau, wau, mau,
    topSpaces: rankSpaces(opens30),
    checkedAt: now.toISOString(),
  };
}
