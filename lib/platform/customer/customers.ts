/**
 * lib/platform/customer/customers.ts  (P1 — CUSTOMER SUCCESS SPINE, list)
 *
 * The bounded customer LIST behind the `cs_customers` widget: who the customers
 * are (identity-resolving, by ruling), which policy group and cohorts they are
 * on, when they were last active and how many provider connections they hold.
 * Every figure is a join over existing ledgers; nothing is stored here.
 *
 * BETA (design §8) — each row also carries the per-user usage / cost / stage
 * ROLL-UP the list renders as one line: chat turns and the rate-card ESTIMATE
 * over the last 30 days (AiInvocation, customer surfaces only), non-REVOKED
 * Plaid Items, the newest engagement fact (the frozen predicate, through the
 * shared product-analytics loader) and the furthest onboarding stage reached
 * (the same strict fold the Growth funnel uses). `CustomerRollup` in
 * customer-core.ts is the pure projection; this file only fetches.
 *
 * PB-4 — WHO NEEDS HELP, AND WHY. Every row carries `attention` (the reasons
 * that active customer needs help, [] when none) and the list accepts
 * `attention: <key | "any">` to show only those customers. Both come from the
 * ONE fold the overview counts with (attention-core.ts via attention.ts), so a
 * reason's count on the dashboard equals this list filtered to it. Identities
 * stay here, in the audited, identity-resolving list — the overview stays
 * counts-only.
 *
 * fm_system: an operator reaching a customer is acting outside their own
 * tenancy by definition (the Platform page header records the same reasoning).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";
import { ENGAGEMENT_AI_SURFACES } from "@/lib/platform/growth/product-analytics-core";
import { loadLastEngagements } from "@/lib/platform/growth/product-analytics";
import { projectActivity, projectRollup, type CustomerRollup } from "./customer-core";
import { ATTENTION_KEYS, ATTENTION_LABELS, ATTENTION_SHORT, attentionOf, idsForAttention } from "./attention-core";
import { loadAttention } from "./attention";
import type { AttentionFilter, AttentionKey } from "./overview-types";

export const CUSTOMER_LIST_MAX = 200;
export const ROLLUP_WINDOW_DAYS = 30;

export interface CustomerListRow extends CustomerRollup {
  id: string; email: string; name: string | null; username: string | null; role: string;
  createdAt: string; deactivatedAt: string | null;
  lastActiveAt: string | null; lastActiveSource: "SESSION" | "LOGIN" | "NONE";
  policyGroup: string; policyAssigned: boolean; overlay: string | null;
  cohorts: string[];
  connectionCount: number;
  /** PB-4 — why this customer needs help, in display order ([] = no reason, or not an active customer). */
  attention: AttentionKey[];
}

export interface CustomerList {
  total: number;
  customers: CustomerListRow[];
  /** PB-4 — the filter this page was read with (null = none). */
  attention: AttentionFilter | null;
  /** PB-4 — the reasons, named by the server (the list's chips and filter options). */
  attentionReasons: { key: AttentionKey; label: string; short: string }[];
}

const ATTENTION_REASONS = ATTENTION_KEYS.map((key) => ({ key, label: ATTENTION_LABELS[key], short: ATTENTION_SHORT[key] }));

/** The id tail of an opaque `user …abc123` reference (or a bare 6+ character token), else null. */
export function opaqueRefTail(search: string): string | null {
  const m = /^(?:user\s*)?(?:…|\.\.\.)?\s*([A-Za-z0-9_-]{6,})$/.exec(search.trim());
  return m ? m[1] : null;
}

export async function listCustomers(
  opts: { search?: string; limit?: number; now?: Date; attention?: AttentionFilter | null } = {}, client = systemDb,
): Promise<CustomerList> {
  const now = opts.now ?? new Date();
  const search = (opts.search ?? "").trim();
  const limit = Math.min(CUSTOMER_LIST_MAX, Math.max(1, Math.floor(opts.limit ?? 50)));
  // Owner ruling (2026-10-30) — operator surfaces that minimise identity (Platform
  // Ops Attention, the alert email) name a customer as `user …abc123`; searching
  // that reference here (or its bare 6+ character tail) finds the account by its
  // id suffix, so the policy-assignment alert is actionable in Customer Success.
  const idTail = opaqueRefTail(search);
  const searchWhere = search
    ? { OR: [
        { email: { contains: search, mode: "insensitive" as const } },
        { name: { contains: search, mode: "insensitive" as const } },
        { username: { contains: search, mode: "insensitive" as const } },
        ...(idTail ? [{ id: { endsWith: idTail } }] : []),
      ] }
    : {};
  // PB-4 — the attention fold is read for every page (the row chips need it);
  // a filter narrows the population BEFORE paging, so `total` is the filtered count.
  const filter = opts.attention ?? null;
  const att = await loadAttention(now, client);
  const where = filter
    ? { AND: [searchWhere, { id: { in: [...idsForAttention(att.fold, filter)] } }] }
    : searchWhere;

  const defaultPolicyGroup = (await loadPolicyGroupCatalogue()).defaultKey;
  const [total, users] = await Promise.all([
    client.user.count({ where }),
    client.user.findMany({
      where, orderBy: { createdAt: "desc" }, take: limit,
      select: { id: true, email: true, name: true, username: true, role: true, createdAt: true, emailVerifiedAt: true, deactivatedAt: true },
    }),
  ]);
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return { total, customers: [], attention: filter, attentionReasons: ATTENTION_REASONS };

  const since = new Date(now.getTime() - ROLLUP_WINDOW_DAYS * 86_400_000);
  const [
    assignments, cohorts, sessions, logins, plaidCounts, connCounts,
    invocations, lastEngagements, plaidFirst, walletFirst, manualFirst, firstAiTurns, firstBriefViews,
  ] = await Promise.all([
    client.customerPolicyAssignment.findMany({ where: { userId: { in: ids } }, select: { userId: true, policyGroup: true, overlay: true } }),
    client.customerCohort.findMany({ where: { userId: { in: ids } }, select: { userId: true, cohort: true } }),
    client.userSession.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { lastActiveAt: true }, _min: { createdAt: true } }),
    client.auditLog.groupBy({ by: ["userId"], where: { userId: { in: ids }, action: AuditAction.LOGIN }, _max: { createdAt: true } }),
    client.plaidItem.groupBy({ by: ["userId"], where: { userId: { in: ids }, status: { not: "REVOKED" } }, _count: { _all: true } }),
    client.connection.groupBy({ by: ["userId"], where: { userId: { in: ids }, provider: { notIn: ["PLAID", "MANUAL", "CSV"] }, status: { not: "REVOKED" } }, _count: { _all: true } }),
    // BETA roll-up — customer surfaces only (harness never), the last 30 days; ids, clocks, tokens and the turn key.
    client.aiInvocation.findMany({
      where: { userId: { in: ids }, occurredAt: { gte: since }, surface: { in: [...ENGAGEMENT_AI_SURFACES] } },
      select: { userId: true, provider: true, model: true, occurredAt: true, outcome: true, conversationId: true, surface: true,
        promptTokens: true, cachedPromptTokens: true, completionTokens: true, latencyMs: true, correlationId: true, turnIndex: true },
    }),
    loadLastEngagements(client, ids),
    // First connection — Plaid, wallet and MANUAL (design §6), revoked included: it still was a first connection.
    client.plaidItem.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _min: { createdAt: true } }),
    client.connection.groupBy({ by: ["userId"], where: { userId: { in: ids }, provider: { notIn: ["PLAID", "MANUAL", "CSV"] } }, _min: { createdAt: true } }),
    client.financialAccount.groupBy({ by: ["createdByUserId"], where: { createdByUserId: { in: ids }, syncStatus: "manual", deletedAt: null }, _min: { createdAt: true } }),
    client.aiInvocation.groupBy({ by: ["userId"], where: { userId: { in: ids }, surface: "chat" }, _min: { occurredAt: true } }),
    client.auditLog.groupBy({ by: ["userId"], where: { userId: { in: ids }, action: AuditAction.BRIEF_VIEWED }, _min: { createdAt: true } }),
  ]);
  const assignBy = new Map(assignments.map((a) => [a.userId, a] as const));
  const cohortsBy = new Map<string, string[]>();
  for (const c of cohorts) cohortsBy.set(c.userId, [...(cohortsBy.get(c.userId) ?? []), c.cohort]);
  const sessBy = new Map(sessions.map((s) => [s.userId, s._max.lastActiveAt] as const));
  const firstSessionBy = new Map(sessions.map((s) => [s.userId, s._min.createdAt] as const));
  const loginBy = new Map(logins.map((l) => [l.userId, l._max.createdAt] as const));
  const plaidBy = new Map(plaidCounts.map((p) => [p.userId, p._count._all] as const));
  const connBy = new Map(connCounts.map((p) => [p.userId, p._count._all] as const));
  const invocationsBy = new Map<string, typeof invocations>();
  for (const r of invocations) if (r.userId) invocationsBy.set(r.userId, [...(invocationsBy.get(r.userId) ?? []), r]);
  const lastEngagedBy = new Map<string, Date>();
  for (const r of lastEngagements) { const cur = lastEngagedBy.get(r.userId); if (!cur || r.at > cur) lastEngagedBy.set(r.userId, r.at); }
  const firstConnectionBy = new Map<string, Date>();
  const earliest = (userId: string | null, at: Date | null) => {
    if (!userId || !at) return;
    const cur = firstConnectionBy.get(userId); if (!cur || at < cur) firstConnectionBy.set(userId, at);
  };
  for (const p of plaidFirst) earliest(p.userId, p._min.createdAt);
  for (const w of walletFirst) earliest(w.userId, w._min.createdAt);
  for (const m of manualFirst) earliest(m.createdByUserId, m._min.createdAt);
  const firstAiBy = new Map(firstAiTurns.flatMap((r) => (r.userId ? [[r.userId, r._min.occurredAt] as const] : [])));
  const firstBriefBy = new Map(firstBriefViews.flatMap((r) => (r.userId ? [[r.userId, r._min.createdAt] as const] : [])));

  return {
    total,
    attention: filter,
    attentionReasons: ATTENTION_REASONS,
    customers: users.map((u) => {
      const a = assignBy.get(u.id);
      const act = projectActivity({ lastSessionActiveAt: sessBy.get(u.id) ?? null, lastLoginAt: loginBy.get(u.id) ?? null, activeSessions: 0 });
      const rollup = projectRollup({
        invocations30d: invocationsBy.get(u.id) ?? [],
        plaidItemCount: plaidBy.get(u.id) ?? 0,
        lastEngagedAt: lastEngagedBy.get(u.id) ?? null,
        stage: {
          createdAt: u.createdAt, emailVerifiedAt: u.emailVerifiedAt,
          firstSession: firstSessionBy.get(u.id) ?? null, firstConnection: firstConnectionBy.get(u.id) ?? null,
          firstAiTurn: firstAiBy.get(u.id) ?? null, firstBriefView: firstBriefBy.get(u.id) ?? null,
        },
      });
      return {
        id: u.id, email: u.email, name: u.name, username: u.username, role: u.role,
        createdAt: u.createdAt.toISOString(), deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
        lastActiveAt: act.lastActiveAt, lastActiveSource: act.lastActiveSource,
        // POLICY EDITOR — an unassigned row names the catalogue DEFAULT (policyAssigned false says so).
        policyGroup: a?.policyGroup ?? defaultPolicyGroup, policyAssigned: a !== undefined, overlay: a?.overlay ?? null,
        cohorts: cohortsBy.get(u.id) ?? [],
        connectionCount: (plaidBy.get(u.id) ?? 0) + (connBy.get(u.id) ?? 0),
        attention: attentionOf(att.fold, u.id),
        ...rollup,
      };
    }),
  };
}
