/**
 * lib/platform/activity/activity.ts  (OPS-6C User Activity Intelligence)
 *
 * A PURE PROJECTION of user-activity metrics over the ledgers that ALREADY exist —
 * the immutable `AuditLog` event ledger (`LOGIN` per sign-in, `SPACE_SWITCH` per
 * Space open, and since BETA A2 the product events) + `User` + `UserSession` +
 * `AiInvocation`. NO new telemetry, NO historical storage: the ledgers ARE the
 * history (the S7 idiom). Reads only; no writes.
 *
 * ── BETA A3 — PRESENT vs ENGAGED, SIGN-INS KEPT APART ─────────────────────────
 * `dau` / `wau` / `mau` were distinct-user LOGIN counts, which under a 30-day JWT
 * is "credential sign-ins", not activity. They are KEPT, unchanged in meaning
 * (every consumer still reads them), and now explicitly labelled SIGN-INS by
 * `signInBasis`. The activity figures the owner asked for ride beside them in
 * `active`: PRESENT (an authenticated session touched the day —
 * SESSION_ACTIVE_DAY ∪ the sign-in day) and ENGAGED (the frozen engagement
 * predicate: product event ∪ chat/brief invocation with a userId ∪ connection
 * add; never cron, webhook, operator or harness), both over the trailing 1 / 7 /
 * 30 UTC days and both counted as DISTINCT (user, day). The ONE implementation
 * of that predicate is lib/platform/growth/product-analytics-core.ts; this
 * module folds the facts the shared reader loads and restates nothing.
 *
 * PURE CORE + INJECTED I/O: the real db-backed reads are built here; tests pass a
 * fake `ActivityReaders`. The Space-open fold is a pure function.
 *
 * ── SEC-PLAT-2 — IDENTITY-MINIMIZED (owner ruling P-4, 2026-10-27) ─────────────
 * Growth must not resolve customer identity. The former "Most active Spaces"
 * list projected customer-chosen Space NAMES (from SPACE_SWITCH metadata) and
 * ids onto a Growth surface. It is now two counts — distinct Spaces opened and
 * total opens — and the reader selects `spaceId` only, never metadata.
 * Customer identity belongs to Customer Success, under its own grant.
 */

import "server-only";
import { db, systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { toISODateUTC } from "@/lib/time/clock";
import { activeUsers, activitySets, type ActivityFactSet } from "@/lib/platform/growth/product-analytics-core";
import { loadActivityFacts } from "@/lib/platform/growth/product-analytics";
import type { ActiveUsers } from "@/lib/platform/growth/product-analytics-types";

const DAY_MS = 86_400_000;

/** Space opens over the window, as COUNTS only — no id, no name (SEC-PLAT-2). */
export interface SpaceOpenCounts {
  /** Distinct Spaces opened at least once. */
  distinctSpaces: number;
  /** Total SPACE_SWITCH opens (bounded by the reader's scan cap). */
  opens: number;
}
export interface UserActivityMetrics {
  totalUsers: number;
  newUsers7: number;
  newUsers30: number;
  activatedEver: number; // distinct users with ≥1 session (signed in at least once)
  /** Distinct users with a credential SIGN-IN (AuditLog LOGIN) in the trailing 1 / 7 / 30 days — NOT an activity metric (BETA A3). */
  dau: number;
  wau: number;
  mau: number;
  /** What dau/wau/mau count. */
  signInBasis: "LOGIN";
  /** BETA A3 — present vs engaged (with sign-ins repeated beside them) over the trailing 1 / 7 / 30 UTC days. */
  active: { daily: ActiveUsers; weekly: ActiveUsers; monthly: ActiveUsers };
  activeBasis: string;
  /** SPACE_SWITCH opens in the last 30d, as counts only (SEC-PLAT-2: no Space names or ids on Growth). */
  spaceOpens30: SpaceOpenCounts;
  checkedAt: string;
}

export const ACTIVE_BASIS =
  "present = SESSION_ACTIVE_DAY ∪ sign-in day; engaged = product event ∪ chat/brief invocation with a userId ∪ connection add; distinct (user, UTC day); never cron, webhook, operator or harness";

export interface ActivityReaders {
  now: Date;
  /** Distinct userIds with a LOGIN AuditLog row since `since`. */
  distinctLoginUsers(since: Date): Promise<number>;
  totalUsers(): Promise<number>;
  newUsersSince(since: Date): Promise<number>;
  /** Distinct userIds with ≥1 UserSession ever. */
  activatedEver(): Promise<number>;
  /** Raw SPACE_SWITCH events since `since` — the opaque spaceId only, never metadata. */
  spaceOpensSince(since: Date): Promise<{ spaceId: string }[]>;
  /** BETA A3 — the day-grain presence / engagement / sign-in facts since `since` (the shared product-analytics loader). */
  activityFacts(since: Date): Promise<ActivityFactSet>;
}

/** Pure: fold Space-open events into counts. Ids are counted, never returned. */
export function countSpaceOpens(events: readonly { spaceId: string }[]): SpaceOpenCounts {
  return { distinctSpaces: new Set(events.map((e) => e.spaceId)).size, opens: events.length };
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
        select: { spaceId: true },
        take: 5000,
      });
      return rows.map((r) => ({ spaceId: r.spaceId as string }));
    },
    // fm_system, like every Platform reader of cross-tenant activity; the loader
    // selects ids and clocks only (pinned by observability-privacy.test.ts).
    activityFacts: (since) => loadActivityFacts(systemDb, since),
  };
}

// ── The projection ─────────────────────────────────────────────────────────────────

export async function getUserActivity(deps: { now?: Date; readers?: ActivityReaders } = {}): Promise<UserActivityMetrics> {
  const now = deps.now ?? new Date();
  const r = deps.readers ?? realReaders(now);
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);

  // Day-grain facts start at 00:00Z of the oldest of the 30 calendar days ending today.
  const today = toISODateUTC(now);
  const factsSince = new Date(`${today}T00:00:00.000Z`);
  factsSince.setUTCDate(factsSince.getUTCDate() - 29);

  const [totalUsers, newUsers7, newUsers30, activatedEver, dau, wau, mau, opens30, facts] = await Promise.all([
    r.totalUsers(),
    r.newUsersSince(since(7)),
    r.newUsersSince(since(30)),
    r.activatedEver(),
    r.distinctLoginUsers(since(1)),
    r.distinctLoginUsers(since(7)),
    r.distinctLoginUsers(since(30)),
    r.spaceOpensSince(since(30)),
    r.activityFacts(factsSince),
  ]);
  const sets = activitySets(facts);

  return {
    totalUsers, newUsers7, newUsers30, activatedEver,
    dau, wau, mau, signInBasis: "LOGIN",
    active: { daily: activeUsers(sets, today, 1), weekly: activeUsers(sets, today, 7), monthly: activeUsers(sets, today, 30) },
    activeBasis: ACTIVE_BASIS,
    spaceOpens30: countSpaceOpens(opens30),
    checkedAt: now.toISOString(),
  };
}
