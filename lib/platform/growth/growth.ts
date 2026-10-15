/**
 * lib/platform/growth/growth.ts  (OPS-6F Growth)
 *
 * A PURE PROJECTION of the growth funnel over the ledgers that already exist —
 * `BetaAccessRequest` (the beta lifecycle) + `User` + `UserSession`. NO new
 * telemetry, no writes: the beta conversion funnel (requested → approved →
 * redeemed → activated) and the signup activation funnel (users → verified →
 * activated → returning) are all counts + honest ratios over existing rows.
 *
 * ── BETA A5 — THE ONBOARDING FUNNEL STAGES ────────────────────────────────────
 * `onboarding` carries the design §6 stages (registered → verified → first
 * session → first connection [manual included] → first AI turn → first Brief
 * viewed → returned) as the frozen `FunnelStage` shape, each with a three-state
 * conversion rate and an abandonment count at the 7-day horizon. The fold is
 * lib/platform/growth/product-analytics-core.ts's `buildFunnel` — the same one
 * the product-analytics surface renders — fed by the shared fm_system loader,
 * so the two surfaces can never disagree about who reached what. The two
 * existing funnels are untouched.
 *
 * PURE CORE + INJECTED I/O: counts are read through an injected `GrowthReaders`;
 * the funnel + ratios are a pure function.
 */

import "server-only";
import { db, systemDb } from "@/lib/db";
import { buildFunnel, firstConnections, type FunnelInputs } from "@/lib/platform/growth/product-analytics-core";
import { loadFunnelFacts } from "@/lib/platform/growth/product-analytics";
import type { FunnelStage } from "@/lib/platform/growth/product-analytics-types";

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
  /**
   * BETA A5 — the onboarding stages (design §6), strict and monotone; see the
   * header. Always present from `getGrowthFunnel`; optional in the type only so
   * literals that predate A5 (the funnel-view test fixtures) still compile.
   */
  onboarding?: FunnelStage[];
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
  /** BETA A5 — the per-user "ever" facts the onboarding funnel folds (shared product-analytics loader). */
  funnelFacts(): Promise<FunnelInputs>;
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
  onboarding: FunnelStage[] = [],
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
    onboarding,
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
    // fm_system, like every Platform reader of cross-tenant activity; the loader
    // selects ids and clocks only (pinned by observability-privacy.test.ts).
    async funnelFacts() {
      const f = await loadFunnelFacts(systemDb);
      return {
        users: f.users, firstSessions: f.firstSessions, firstConnections: firstConnections(f),
        firstAiTurns: f.firstAiTurns, firstBriefViews: f.firstBriefViews, lastEngagements: f.lastEngagements,
      };
    },
  };
}

// ── Invitation lifecycle (PO-3A) ─────────────────────────────────────────────
//
// The four invitation states the HQ Beta Controls surface reports, derived
// purely from BetaAccessRequest columns — no new store, no fabricated metric:
//   sent     — an invite email was ever issued  (invitedAt != null)
//   accepted — the invite was consumed at registration (status = REDEEMED)
//   expired  — an outstanding APPROVED invite whose inviteExpiresAt has lapsed
//              (unredeemed; expiry is otherwise evaluated lazily at redeem time)
//   revoked  — an invite that was issued and then pulled (DENIED after invitedAt)
// These are orthogonal projections of the same rows the funnel counts, reported
// separately because the operator asks "what happened to the invitations?" not
// only "how many requests are pending?".

export interface BetaInvitationLifecycle {
  sent: number;
  accepted: number;
  expired: number;
  revoked: number;
  checkedAt: string;
}

export interface InvitationLifecycleReaders {
  sent(): Promise<number>;
  accepted(): Promise<number>;
  expired(now: Date): Promise<number>;
  revoked(): Promise<number>;
}

function realInvitationReaders(): InvitationLifecycleReaders {
  return {
    sent:     () => db.betaAccessRequest.count({ where: { invitedAt: { not: null } } }),
    accepted: () => db.betaAccessRequest.count({ where: { status: "REDEEMED" } }),
    expired:  (now) => db.betaAccessRequest.count({ where: { status: "APPROVED", inviteExpiresAt: { lt: now } } }),
    revoked:  () => db.betaAccessRequest.count({ where: { status: "DENIED", invitedAt: { not: null } } }),
  };
}

export async function getBetaInvitationLifecycle(
  deps: { now?: Date; readers?: InvitationLifecycleReaders } = {},
): Promise<BetaInvitationLifecycle> {
  const now = deps.now ?? new Date();
  const r = deps.readers ?? realInvitationReaders();
  const [sent, accepted, expired, revoked] = await Promise.all([
    r.sent(), r.accepted(), r.expired(now), r.revoked(),
  ]);
  return { sent, accepted, expired, revoked, checkedAt: now.toISOString() };
}

export async function getGrowthFunnel(deps: { now?: Date; readers?: GrowthReaders } = {}): Promise<GrowthFunnel> {
  const now = deps.now ?? new Date();
  const r = deps.readers ?? realReaders(now);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

  const [beta, redeemedActivated, total, verified, activated, returning7, facts] = await Promise.all([
    r.betaByStatus(),
    r.redeemedActivated(),
    r.totalUsers(),
    r.verifiedUsers(),
    r.activatedUsers(),
    r.returningUsers(weekAgo, weekAgo),
    r.funnelFacts(),
  ]);

  return buildGrowthFunnel(beta, redeemedActivated, { total, verified, activated, returning7 }, now.toISOString(), buildFunnel(facts, now));
}
