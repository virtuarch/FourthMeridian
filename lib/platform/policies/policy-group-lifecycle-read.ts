/**
 * lib/platform/policies/policy-group-lifecycle-read.ts  (BETA LIFECYCLE L1 — one group's lifecycle read)
 *
 * GET /api/platform/platform-ops/policy-groups/[key]/lifecycle (PLATFORM_OPS READ):
 *
 *   state        lifecycle, costFrozen, endedTransition, lifecycleVersion (the
 *                optimistic token a write may echo), the restriction members
 *                resolve under (lib/entitlements/lifecycle.ts), default /
 *                built-in / archived;
 *   members      COUNTS only — customers assigned, how many carry an overlay,
 *                and (default group, fail-closed switch off) the ACTIVE
 *                unassigned customers who resolve to it;
 *   transitions  the append-only history, newest first, capped: kind, from/to,
 *                freeze before/after, reason CODE, whether a note was given,
 *                the operator's display label (never an email), when;
 *   billablePolicyReadable  whether THIS instance can read the policy fresh
 *                enough for billable decisions right now (false ⇒ billable
 *                work fails closed here).
 *
 * Read straight from the table (not the 30 s cache) so an operator sees the
 * state they just wrote. Read-only, fm_system, no customer identity.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { lifecycleRestrictionOf, type LifecycleRestriction, type PolicyGroupEndedTransitionKind, type PolicyGroupLifecycleState, type PolicyGroupTransitionKindName } from "@/lib/entitlements/lifecycle";
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import { loadFreshPolicyGroupCatalogue } from "./policy-group-catalogue";

export const TRANSITION_HISTORY_CAP = 50;

export interface PolicyGroupTransitionView {
  id: string;
  kind: PolicyGroupTransitionKindName;
  fromLifecycle: PolicyGroupLifecycleState;
  toLifecycle: PolicyGroupLifecycleState;
  costFrozenBefore: boolean;
  costFrozenAfter: boolean;
  reasonCode: string;
  hasNote: boolean;
  operator: string;
  createdAt: string;
}

export interface PolicyGroupLifecycleResponse {
  key: string;
  label: string;
  lifecycle: PolicyGroupLifecycleState;
  costFrozen: boolean;
  endedTransition: PolicyGroupEndedTransitionKind | null;
  lifecycleVersion: number;
  restriction: LifecycleRestriction | null;
  isDefault: boolean;
  builtIn: boolean;
  archived: boolean;
  members: { customers: number; withOverlay: number; unassignedResolvingHere: number };
  transitions: PolicyGroupTransitionView[];
  transitionsTruncated: boolean;
  billablePolicyReadable: boolean;
  checkedAt: string;
}

export async function readPolicyGroupLifecycle(key: string, now: Date = new Date()): Promise<PolicyGroupLifecycleResponse | null> {
  const row = await systemDb.policyGroup.findUnique({
    where: { key },
    select: { key: true, label: true, isDefault: true, builtIn: true, archivedAt: true, lifecycle: true, costFrozen: true, endedTransition: true, lifecycleVersion: true },
  });
  if (!row) return null;
  const enforced = env.isPolicyAssignmentFailClosed;
  const [customers, withOverlay, unassigned, rows, fresh] = await Promise.all([
    systemDb.customerPolicyAssignment.count({ where: { policyGroup: key } }),
    systemDb.customerPolicyAssignment.count({ where: { policyGroup: key, overlay: { not: null } } }),
    row.isDefault && !enforced
      ? systemDb.user.count({ where: { role: "USER", deactivatedAt: null, policyAssignment: { is: null } } })
      : Promise.resolve(0),
    systemDb.policyGroupTransition.findMany({
      where: { groupKey: key }, orderBy: { createdAt: "desc" }, take: TRANSITION_HISTORY_CAP + 1,
      select: { id: true, kind: true, fromLifecycle: true, toLifecycle: true, costFrozenBefore: true, costFrozenAfter: true, reasonCode: true, reasonNote: true, operatorId: true, createdAt: true },
    }),
    loadFreshPolicyGroupCatalogue(),
  ]);
  const shown = rows.slice(0, TRANSITION_HISTORY_CAP);
  const ids = [...new Set(shown.map((t) => t.operatorId).filter((id): id is string => typeof id === "string"))];
  const ops = ids.length ? await systemDb.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, name: true } }) : [];
  const label = new Map(ops.map((o) => [o.id, operatorDisplayName(o)] as const));

  return {
    key: row.key,
    label: row.label,
    lifecycle: row.lifecycle,
    costFrozen: row.costFrozen,
    endedTransition: row.endedTransition,
    lifecycleVersion: row.lifecycleVersion,
    restriction: lifecycleRestrictionOf({ lifecycle: row.lifecycle, costFrozen: row.costFrozen }),
    isDefault: row.isDefault,
    builtIn: row.builtIn,
    archived: row.archivedAt !== null,
    members: { customers, withOverlay, unassignedResolvingHere: unassigned },
    transitions: shown.map((t) => ({
      id: t.id, kind: t.kind, fromLifecycle: t.fromLifecycle, toLifecycle: t.toLifecycle,
      costFrozenBefore: t.costFrozenBefore, costFrozenAfter: t.costFrozenAfter,
      reasonCode: t.reasonCode, hasNote: Boolean(t.reasonNote),
      operator: t.operatorId ? (label.get(t.operatorId) ?? `user …${t.operatorId.slice(-6)}`) : "System",
      createdAt: t.createdAt.toISOString(),
    })),
    transitionsTruncated: rows.length > TRANSITION_HISTORY_CAP,
    billablePolicyReadable: fresh !== null,
    checkedAt: now.toISOString(),
  };
}
