/**
 * lib/platform/growth/growth.ts  (OPS-6F Growth)
 *
 * A PURE PROJECTION of the growth funnel over the ledgers that already exist —
 * `BetaAccessRequest` (the beta lifecycle) + `User` + `UserSession`. NO new
 * telemetry, no writes: the beta conversion funnel (requested → approved →
 * redeemed → activated) and the signup activation funnel (users → verified →
 * activated → returning) are all counts + honest ratios over existing rows.
 *
 * PURE CORE + INJECTED I/O: counts are read through an injected `GrowthReaders`;
 * the funnel + ratios are a pure function.
 */

import "server-only";
import { db } from "@/lib/db";

const DAY_MS = 86_400_000;

export interface BetaFunnel {
  requested: number;
  approved: number; // APPROVED + REDEEMED (approved-ever)
  redeemed: number;
  denied: number;
  pending: number;
  redeemedActivated: number; // redeemed users who have signed in at least once
  approveRate: number | null; // approved / requested
  redeemRate: number | null;  // redeemed / approved
}
export interface ActivationFunnel {
  totalUsers: number;
  verified: number;
  activated: number;  // ≥1 session ever
  returning7: number; // users older than 7d with a session in the last 7d
  verifyRate: number | null;
  activationRate: number | null;
}
export interface GrowthFunnel {
  beta: BetaFunnel;
  activation: ActivationFunnel;
  checkedAt: string;
}

export interface GrowthReaders {
  now: Date;
  betaByStatus(): Promise<Record<string, number>>;
  redeemedActivated(): Promise<number>;
  totalUsers(): Promise<number>;
  verifiedUsers(): Promise<number>;
  activatedUsers(): Promise<number>;
  returningUsers(activeSince: Date, createdBefore: Date): Promise<number>;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

/** Pure: build the funnel + honest ratios from the raw counts. */
export function buildGrowthFunnel(
  beta: Record<string, number>,
  redeemedActivated: number,
  users: { total: number; verified: number; activated: number; returning7: number },
  checkedAt: string,
): GrowthFunnel {
  const pending = beta.PENDING ?? 0;
  const denied = beta.DENIED ?? 0;
  const redeemed = beta.REDEEMED ?? 0;
  const approvedOnly = beta.APPROVED ?? 0;
  const approved = approvedOnly + redeemed; // approved-ever
  const requested = pending + denied + approved;

  return {
    beta: {
      requested, approved, redeemed, denied, pending, redeemedActivated,
      approveRate: ratio(approved, requested),
      redeemRate: ratio(redeemed, approved),
    },
    activation: {
      totalUsers: users.total, verified: users.verified, activated: users.activated, returning7: users.returning7,
      verifyRate: ratio(users.verified, users.total),
      activationRate: ratio(users.activated, users.total),
    },
    checkedAt,
  };
}

// ── Real readers ─────────────────────────────────────────────────────────────────

function realReaders(now: Date): GrowthReaders {
  return {
    now,
    async betaByStatus() {
      const rows = await db.betaAccessRequest.groupBy({ by: ["status"], _count: { _all: true } });
      const out: Record<string, number> = {};
      for (const r of rows) out[r.status] = r._count._all;
      return out;
    },
    async redeemedActivated() {
      const redeemed = await db.betaAccessRequest.findMany({ where: { status: "REDEEMED", redeemedUserId: { not: null } }, select: { redeemedUserId: true } });
      const ids = redeemed.map((r) => r.redeemedUserId as string);
      if (ids.length === 0) return 0;
      const active = await db.userSession.groupBy({ by: ["userId"], where: { userId: { in: ids } } });
      return active.length;
    },
    totalUsers: () => db.user.count(),
    verifiedUsers: () => db.user.count({ where: { emailVerifiedAt: { not: null } } }),
    async activatedUsers() {
      const rows = await db.userSession.groupBy({ by: ["userId"], _count: { _all: true } });
      return rows.length;
    },
    async returningUsers(activeSince, createdBefore) {
      const recent = await db.userSession.findMany({ where: { lastActiveAt: { gte: activeSince } }, select: { userId: true }, distinct: ["userId"] });
      const ids = recent.map((r) => r.userId);
      if (ids.length === 0) return 0;
      return db.user.count({ where: { id: { in: ids }, createdAt: { lt: createdBefore } } });
    },
  };
}

export async function getGrowthFunnel(deps: { now?: Date; readers?: GrowthReaders } = {}): Promise<GrowthFunnel> {
  const now = deps.now ?? new Date();
  const r = deps.readers ?? realReaders(now);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

  const [beta, redeemedActivated, total, verified, activated, returning7] = await Promise.all([
    r.betaByStatus(),
    r.redeemedActivated(),
    r.totalUsers(),
    r.verifiedUsers(),
    r.activatedUsers(),
    r.returningUsers(weekAgo, weekAgo),
  ]);

  return buildGrowthFunnel(beta, redeemedActivated, { total, verified, activated, returning7 }, now.toISOString());
}
