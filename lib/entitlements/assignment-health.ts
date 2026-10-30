/**
 * lib/entitlements/assignment-health.ts  (owner ruling, 2026-10-30 — the read)
 *
 * THE ONE READ behind "which customers have a missing or invalid policy-group
 * assignment", shared by the Platform Ops Attention feed (lib/platform/ops/
 * attention.ts) and the `policy-assignment-invalid` alert rule (lib/alerts/run.ts).
 * The fold is pure (assignment-health-core.ts).
 *
 * READ-ONLY, BOUNDED, fm_system: two exact counts and two lists capped at
 * POLICY_ASSIGNMENT_ISSUE_CAP. It selects ids and timestamps only — never an
 * email, name or username — and it writes, rewrites or deletes nothing: a
 * broken assignment is REPORTED, never repaired here (correcting it is an
 * audited Customer Success action, lib/platform/customer/assign.ts).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { POLICY_GROUPS } from "./catalogue";
import { POLICY_ASSIGNMENT_ISSUE_CAP, buildPolicyAssignmentHealth, type PolicyAssignmentHealth } from "./assignment-health-core";

/** The narrow read surface (systemDb satisfies it; tests hand a fake). Counts and finds only. */
export interface PolicyAssignmentReadClient {
  user: {
    count(args: { where: { role: "USER"; policyAssignment: { is: null } } }): Promise<number>;
    findMany(args: {
      where: { role: "USER"; policyAssignment: { is: null } };
      select: { id: true; createdAt: true };
      orderBy: { createdAt: "asc" };
      take: number;
    }): Promise<{ id: string; createdAt: Date }[]>;
  };
  customerPolicyAssignment: {
    count(args: { where: { policyGroup: { notIn: string[] } } }): Promise<number>;
    findMany(args: {
      where: { policyGroup: { notIn: string[] } };
      select: { userId: true; policyGroup: true; assignedAt: true };
      orderBy: { assignedAt: "asc" };
      take: number;
    }): Promise<{ userId: string; policyGroup: string; assignedAt: Date }[]>;
  };
}

export async function loadPolicyAssignmentHealth(opts: {
  client?: PolicyAssignmentReadClient; enforced?: boolean; now?: Date; cap?: number;
} = {}): Promise<PolicyAssignmentHealth> {
  const client = opts.client ?? (systemDb as unknown as PolicyAssignmentReadClient);
  const cap = opts.cap ?? POLICY_ASSIGNMENT_ISSUE_CAP;
  const known = Object.keys(POLICY_GROUPS);
  const unassignedWhere = { role: "USER" as const, policyAssignment: { is: null } };
  const unknownWhere = { policyGroup: { notIn: known } };
  const [unassignedCount, unassignedRows, unknownCount, unknownRows] = await Promise.all([
    client.user.count({ where: unassignedWhere }),
    client.user.findMany({ where: unassignedWhere, select: { id: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: cap }),
    client.customerPolicyAssignment.count({ where: unknownWhere }),
    client.customerPolicyAssignment.findMany({ where: unknownWhere, select: { userId: true, policyGroup: true, assignedAt: true }, orderBy: { assignedAt: "asc" }, take: cap }),
  ]);
  return buildPolicyAssignmentHealth({
    unassignedCount, unknownCount,
    unassignedRows: unassignedRows.map((r) => ({ userId: r.id, createdAt: r.createdAt })),
    unknownRows,
    enforced: opts.enforced ?? env.isPolicyAssignmentFailClosed,
  }, opts.now ?? new Date(), cap);
}
