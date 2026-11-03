/**
 * lib/platform/customer/recently-joined.ts  (PB-7 — "Recently joined (14 d)")
 *
 * One row per customer who registered in the window: who (identity — this is
 * the Customer Success customer spine, identity-resolving by owner ruling),
 * the furthest onboarding stage reached (the same strict fold the Customers
 * list and the Growth funnel use) and an import-health dot over their bank
 * connections (import-status-core: red any failed · amber any in progress or
 * recovered · green all complete · none when nothing is linked).
 *
 * WHY A ROUTE OF ITS OWN, NOT THE OVERVIEW DTO. The Customer Success overview
 * (lib/platform/customer/overview.ts) is COUNTS-ONLY by design — no identity
 * leaves it. A panel that names customers therefore reads through the
 * customer-spine gate (CUSTOMER_SUCCESS READ, the Customers list's own), the
 * same way PB-4's "who needs help" rows hand off to the audited list. Opening a
 * row goes through the audited profile route (CUSTOMER_PROFILE_VIEWED).
 *
 * Population: active role-USER customers (the overview's and PB-4's) — the
 * Platform Ops "New-connection imports" tile counts the same population's
 * items, through the same rule, so the two cannot disagree where they overlap.
 *
 * fm_system; allowlisted selects — no token, cursor, balance or amount.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { loadLastEngagements } from "@/lib/platform/growth/product-analytics";
import { loadImportsForOwners } from "@/lib/platform/onboarding/import-facts";
import { buildRecentlyJoinedRows, type RecentlyJoined } from "./recently-joined-core";

export const RECENTLY_JOINED_DAYS = 14;
export const RECENTLY_JOINED_MAX = 100;

export async function listRecentlyJoined(opts: { days?: number; now?: Date } = {}, client = systemDb): Promise<RecentlyJoined> {
  const now = opts.now ?? new Date();
  const days = Math.min(90, Math.max(1, Math.floor(opts.days ?? RECENTLY_JOINED_DAYS)));
  const since = new Date(now.getTime() - days * 86_400_000);
  const where = { role: "USER" as const, deactivatedAt: null, createdAt: { gte: since } };

  const [total, users] = await Promise.all([
    client.user.count({ where }),
    client.user.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: RECENTLY_JOINED_MAX,
      select: { id: true, email: true, name: true, username: true, createdAt: true, emailVerifiedAt: true },
    }),
  ]);
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return buildRecentlyJoinedRows({ windowDays: days, total, users: [], facts: emptyFacts(), imports: [], floor: false });

  const [sessions, plaidFirst, walletFirst, manualFirst, firstAi, firstBrief, lastEngagements, requests, wallets, imports] = await Promise.all([
    client.userSession.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _min: { createdAt: true } }),
    client.plaidItem.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _min: { createdAt: true } }),
    client.connection.groupBy({ by: ["userId"], where: { userId: { in: ids }, provider: { notIn: ["PLAID", "MANUAL", "CSV"] } }, _min: { createdAt: true } }),
    client.financialAccount.groupBy({ by: ["createdByUserId"], where: { createdByUserId: { in: ids }, syncStatus: "manual", deletedAt: null }, _min: { createdAt: true } }),
    client.aiInvocation.groupBy({ by: ["userId"], where: { userId: { in: ids }, surface: "chat" }, _min: { occurredAt: true } }),
    client.auditLog.groupBy({ by: ["userId"], where: { userId: { in: ids }, action: AuditAction.BRIEF_VIEWED }, _min: { createdAt: true } }),
    loadLastEngagements(client, ids),
    client.betaAccessRequest.findMany({ where: { email: { in: users.map((u) => u.email) } }, select: { email: true, invitedAt: true, redeemedAt: true } }),
    client.connection.groupBy({ by: ["userId"], where: { userId: { in: ids }, provider: { notIn: ["PLAID", "MANUAL", "CSV"] }, status: { not: "REVOKED" } }, _count: { _all: true } }),
    loadImportsForOwners(ids, now, client),
  ]);

  const facts = emptyFacts();
  for (const s of sessions) if (s._min.createdAt) facts.firstSession.set(s.userId, s._min.createdAt);
  const earliest = (userId: string | null, at: Date | null) => {
    if (!userId || !at) return;
    const cur = facts.firstConnection.get(userId); if (!cur || at < cur) facts.firstConnection.set(userId, at);
  };
  for (const p of plaidFirst) earliest(p.userId, p._min.createdAt);
  for (const w of walletFirst) earliest(w.userId, w._min.createdAt);
  for (const m of manualFirst) earliest(m.createdByUserId, m._min.createdAt);
  for (const r of firstAi) if (r.userId && r._min.occurredAt) facts.firstAiTurn.set(r.userId, r._min.occurredAt);
  for (const r of firstBrief) if (r.userId && r._min.createdAt) facts.firstBriefView.set(r.userId, r._min.createdAt);
  for (const r of lastEngagements) { const cur = facts.lastEngaged.get(r.userId); if (!cur || r.at > cur) facts.lastEngaged.set(r.userId, r.at); }
  for (const r of requests) if (r.invitedAt || r.redeemedAt) facts.invitedEmails.add(r.email.toLowerCase());
  for (const w of wallets) facts.walletCount.set(w.userId, w._count._all);

  return buildRecentlyJoinedRows({ windowDays: days, total, users, facts, imports: imports.items, floor: imports.floor || total > users.length });
}

function emptyFacts() {
  return {
    firstSession: new Map<string, Date>(), firstConnection: new Map<string, Date>(), firstAiTurn: new Map<string, Date>(),
    firstBriefView: new Map<string, Date>(), lastEngaged: new Map<string, Date>(), invitedEmails: new Set<string>(),
    walletCount: new Map<string, number>(),
  };
}
