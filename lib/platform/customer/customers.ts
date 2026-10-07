/**
 * lib/platform/customer/customers.ts  (P1 — CUSTOMER SUCCESS SPINE, list)
 *
 * The bounded customer LIST behind the `cs_customers` widget: who the customers
 * are (identity-resolving, by ruling), which policy group and cohorts they are
 * on, when they were last active and how many provider connections they hold.
 * Every figure is a join over existing ledgers; nothing is stored here.
 *
 * fm_system: an operator reaching a customer is acting outside their own
 * tenancy by definition (the Platform page header records the same reasoning).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { DEFAULT_POLICY_GROUP } from "@/lib/entitlements/catalogue";
import { projectActivity } from "./customer-core";

export const CUSTOMER_LIST_MAX = 200;

export interface CustomerListRow {
  id: string; email: string; name: string | null; username: string | null; role: string;
  createdAt: string; deactivatedAt: string | null;
  lastActiveAt: string | null; lastActiveSource: "SESSION" | "LOGIN" | "NONE";
  policyGroup: string; policyAssigned: boolean; overlay: string | null;
  cohorts: string[];
  connectionCount: number;
}

export interface CustomerList { total: number; customers: CustomerListRow[] }

export async function listCustomers(opts: { search?: string; limit?: number } = {}, client = systemDb): Promise<CustomerList> {
  const search = (opts.search ?? "").trim();
  const limit = Math.min(CUSTOMER_LIST_MAX, Math.max(1, Math.floor(opts.limit ?? 50)));
  const where = search
    ? { OR: [
        { email: { contains: search, mode: "insensitive" as const } },
        { name: { contains: search, mode: "insensitive" as const } },
        { username: { contains: search, mode: "insensitive" as const } },
      ] }
    : {};

  const [total, users] = await Promise.all([
    client.user.count({ where }),
    client.user.findMany({
      where, orderBy: { createdAt: "desc" }, take: limit,
      select: { id: true, email: true, name: true, username: true, role: true, createdAt: true, deactivatedAt: true },
    }),
  ]);
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return { total, customers: [] };

  const [assignments, cohorts, sessions, logins, plaidCounts, connCounts] = await Promise.all([
    client.customerPolicyAssignment.findMany({ where: { userId: { in: ids } }, select: { userId: true, policyGroup: true, overlay: true } }),
    client.customerCohort.findMany({ where: { userId: { in: ids } }, select: { userId: true, cohort: true } }),
    client.userSession.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { lastActiveAt: true } }),
    client.auditLog.groupBy({ by: ["userId"], where: { userId: { in: ids }, action: AuditAction.LOGIN }, _max: { createdAt: true } }),
    client.plaidItem.groupBy({ by: ["userId"], where: { userId: { in: ids }, status: { not: "REVOKED" } }, _count: { _all: true } }),
    client.connection.groupBy({ by: ["userId"], where: { userId: { in: ids }, provider: { notIn: ["PLAID", "MANUAL", "CSV"] }, status: { not: "REVOKED" } }, _count: { _all: true } }),
  ]);
  const assignBy = new Map(assignments.map((a) => [a.userId, a] as const));
  const cohortsBy = new Map<string, string[]>();
  for (const c of cohorts) cohortsBy.set(c.userId, [...(cohortsBy.get(c.userId) ?? []), c.cohort]);
  const sessBy = new Map(sessions.map((s) => [s.userId, s._max.lastActiveAt] as const));
  const loginBy = new Map(logins.map((l) => [l.userId, l._max.createdAt] as const));
  const plaidBy = new Map(plaidCounts.map((p) => [p.userId, p._count._all] as const));
  const connBy = new Map(connCounts.map((p) => [p.userId, p._count._all] as const));

  return {
    total,
    customers: users.map((u) => {
      const a = assignBy.get(u.id);
      const act = projectActivity({ lastSessionActiveAt: sessBy.get(u.id) ?? null, lastLoginAt: loginBy.get(u.id) ?? null, activeSessions: 0 });
      return {
        id: u.id, email: u.email, name: u.name, username: u.username, role: u.role,
        createdAt: u.createdAt.toISOString(), deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
        lastActiveAt: act.lastActiveAt, lastActiveSource: act.lastActiveSource,
        policyGroup: a?.policyGroup ?? DEFAULT_POLICY_GROUP, policyAssigned: a !== undefined, overlay: a?.overlay ?? null,
        cohorts: cohortsBy.get(u.id) ?? [],
        connectionCount: (plaidBy.get(u.id) ?? 0) + (connBy.get(u.id) ?? 0),
      };
    }),
  };
}
