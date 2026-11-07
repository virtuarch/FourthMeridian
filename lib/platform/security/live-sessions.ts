/**
 * lib/platform/security/live-sessions.ts  (shared live-session COUNT readers)
 *
 * The two live-session aggregates the Platform shows, moved out of their route
 * handlers so the route, its tile and (next) the Phase 3 retrieval contract all
 * read ONE function — never a parallel query:
 *
 *   countLiveSessions(client, now)           live-sessions@1 — a SESSION count
 *       (UserSession rows), plus the distinct owners of those sessions.
 *       Served by GET /api/platform/security-ops/sessions (SECURITY_OPS READ).
 *   countAccountsWithLiveSession(client, now) accounts-with-live-session@1 — an
 *       ACCOUNT count: distinct customer (role USER) accounts holding ≥ 1 live
 *       session. Served by GET /api/platform/growth-revenue/users (GROWTH_REVENUE READ).
 *
 * Both are built on THE live-session rule, `liveSessionWhere` (lib/auth/session-proof.ts:
 * not revoked, inside the SEC-010 idle and absolute lifetime, owner not locked
 * out), and the customer population on `CUSTOMER_WHERE` (lib/platform/customer/population.ts).
 * Nothing here restates either predicate. A pure move: the queries are exactly
 * the ones the routes ran (pinned by live-sessions.test.ts, old vs new).
 *
 * AUTHORITY: the caller passes its client; there is no default (a `?? db`
 * default would be an implicit migration-principal read — scripts/audit-db-authority.ts).
 * Aggregates only: counts, never an id, email or row.
 */

import type { PrismaClient } from "@prisma/client";
import { liveSessionWhere } from "@/lib/auth/session-proof";
import { CUSTOMER_WHERE } from "@/lib/platform/customer/population";

/** The only model these readers touch. */
export type LiveSessionReadClient = Pick<PrismaClient, "userSession">;

export interface LiveSessionCounts {
  /** Live UserSession rows (one account on two devices = 2). */
  sessions: number;
  /** Distinct owners of those sessions (every role). */
  distinctUsers: number;
}

/** live-sessions@1: live sessions now, and their distinct owners. */
export async function countLiveSessions(client: LiveSessionReadClient, now: Date): Promise<LiveSessionCounts> {
  const live = liveSessionWhere(now);
  const [sessions, owners] = await Promise.all([
    client.userSession.count({ where: live }),
    client.userSession.groupBy({ by: ["userId"], where: live }),
  ]);
  return { sessions, distinctUsers: owners.length };
}

/** accounts-with-live-session@1: distinct customer accounts holding at least one live session now. */
export async function countAccountsWithLiveSession(client: LiveSessionReadClient, now: Date): Promise<number> {
  const rows = await client.userSession.groupBy({ by: ["userId"], where: liveSessionWhere(now, { userWhere: CUSTOMER_WHERE }), _count: { _all: true } });
  return rows.length;
}
