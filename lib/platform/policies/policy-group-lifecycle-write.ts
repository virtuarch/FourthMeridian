/**
 * lib/platform/policies/policy-group-lifecycle-write.ts  (BETA LIFECYCLE L1 — the ONE lifecycle mutation)
 *
 * Owner decisions (2026-10-31): a Policy Group may be PAUSED, RESUMED, ENDED,
 * cost-FROZEN and UNFROZEN by a Platform Operations CONTROL holder with a
 * reason; history is preserved as transition records. The route enforces
 * fresh PLATFORM_OPS CONTROL and the rate limit; THIS module enforces the rest:
 *
 *   · ONE systemDb transaction: the group row is locked FOR UPDATE, the
 *     optional optimistic token (`expectedVersion` = lifecycleVersion) is
 *     checked, the transition is validated by the ONE table
 *     (lib/entitlements/lifecycle.ts planLifecycleTransition), the row is
 *     moved (conditional on the version it read), ONE PolicyGroupTransition row
 *     is appended and ONE recordOperatorAction audit row is written — all
 *     commit together or not at all.
 *   · Reopening an ENDED group (resume from ENDED) requires a reason NOTE.
 *   · An archived group is not changed (it has no members by construction).
 *   · Membership is never read by id or written: member COUNTS only.
 *   · Transitions are APPEND-ONLY (fm_system holds SELECT + INSERT only; no
 *     code path updates or deletes one — pinned by lifecycle-write.test.ts).
 *   · The in-process catalogue cache is invalidated after commit, so this
 *     instance enforces the change on the next request; other instances within
 *     CATALOGUE_TTL_MS (20 s from the read start; + one read, within the 30 s bound).
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorReason } from "@/lib/audit";
import {
  planLifecycleTransition, type LifecycleAction, type LifecycleState, type PolicyGroupTransitionKindName,
} from "@/lib/entitlements/lifecycle";
import { invalidatePolicyGroupCatalogue } from "./policy-group-catalogue";
import type { PolicyGroupActor, PolicyGroupRefusalCode, PolicyGroupWriteClient, PolicyGroupWriteResult } from "./policy-groups-write";

type Tx = Prisma.TransactionClient;

export const TRANSITION_AUDIT_ACTION: Readonly<Record<PolicyGroupTransitionKindName, AuditActionType>> = {
  PAUSE: AuditAction.POLICY_GROUP_PAUSED,
  RESUME: AuditAction.POLICY_GROUP_RESUMED,
  END: AuditAction.POLICY_GROUP_ENDED,
  FREEZE: AuditAction.POLICY_GROUP_COST_FROZEN,
  UNFREEZE: AuditAction.POLICY_GROUP_COST_UNFROZEN,
};

export interface LifecycleTransitionInput {
  key: string;
  action: LifecycleAction;
  /** The lifecycleVersion the operator reviewed (optional optimistic token). */
  expectedVersion?: number;
  reason: OperatorReason;
  actor: PolicyGroupActor;
}

export interface LifecycleTransitioned {
  key: string;
  kind: PolicyGroupTransitionKindName;
  from: LifecycleState;
  to: LifecycleState;
  lifecycleVersion: number;
  transitionId: string;
  /** Customers whose assignment names the group (counts only). */
  membersAffected: number;
  /** True for the default group: NEW registrations land in this state too. */
  isDefault: boolean;
}

const refuse = (code: PolicyGroupRefusalCode, error: string) => ({ ok: false as const, code, error });

export async function transitionPolicyGroupLifecycle(
  input: LifecycleTransitionInput,
  client: PolicyGroupWriteClient = systemDb,
): Promise<PolicyGroupWriteResult<LifecycleTransitioned>> {
  if (input.expectedVersion !== undefined && !(Number.isInteger(input.expectedVersion) && input.expectedVersion >= 0)) {
    return refuse("VALIDATION", "expectedVersion must be the lifecycle version you reviewed (a whole number ≥ 0).");
  }
  let result: PolicyGroupWriteResult<LifecycleTransitioned>;
  try {
    result = await client.$transaction(async (tx: Tx): Promise<PolicyGroupWriteResult<LifecycleTransitioned>> => {
      // Serialise every lifecycle change of one group (parameterised tagged template only).
      await tx.$queryRaw`SELECT "key" FROM "PolicyGroup" WHERE "key" = ${input.key} FOR UPDATE`;
      const row = await tx.policyGroup.findUnique({
        where: { key: input.key },
        select: { key: true, archivedAt: true, isDefault: true, lifecycle: true, costFrozen: true, endedTransition: true, lifecycleVersion: true },
      });
      if (!row) return refuse("NOT_FOUND", `Policy group "${input.key.slice(0, 64)}" does not exist.`);
      if (row.archivedAt) return refuse("NOT_EDITABLE", "An archived group's lifecycle cannot be changed.");
      if (input.expectedVersion !== undefined && row.lifecycleVersion !== input.expectedVersion) {
        return refuse("CONFLICT", `The group's lifecycle changed since you opened it (now version ${row.lifecycleVersion}) — reload and review again.`);
      }
      const from: LifecycleState = { lifecycle: row.lifecycle, costFrozen: row.costFrozen, endedTransition: row.endedTransition };
      const plan = planLifecycleTransition(from, input.action, Boolean(input.reason.note));
      if (!plan.ok) return refuse(plan.needsNote ? "VALIDATION" : "CONFLICT", plan.error);

      const next = row.lifecycleVersion + 1;
      const moved = await tx.policyGroup.updateMany({
        where: { key: input.key, lifecycleVersion: row.lifecycleVersion, archivedAt: null },
        data: { lifecycle: plan.to.lifecycle, costFrozen: plan.to.costFrozen, endedTransition: plan.to.endedTransition, lifecycleVersion: next },
      });
      if (moved.count !== 1) return refuse("CONFLICT", "The group changed since you opened it — reload and review again.");

      const [members, withOverlay] = await Promise.all([
        tx.customerPolicyAssignment.count({ where: { policyGroup: input.key } }),
        tx.customerPolicyAssignment.count({ where: { policyGroup: input.key, overlay: { not: null } } }),
      ]);
      const transition = await tx.policyGroupTransition.create({
        data: {
          groupKey: input.key, kind: plan.kind,
          fromLifecycle: plan.from.lifecycle, toLifecycle: plan.to.lifecycle,
          costFrozenBefore: plan.from.costFrozen, costFrozenAfter: plan.to.costFrozen,
          reasonCode: input.reason.code, reasonNote: input.reason.note ?? null, operatorId: input.actor.userId,
        },
        select: { id: true },
      });
      await recordOperatorAction(tx, {
        actor: { userId: input.actor.userId, via: input.actor.via, area: "PLATFORM_OPS" },
        action: TRANSITION_AUDIT_ACTION[plan.kind],
        target: { kind: "POLICY_GROUP", id: input.key },
        reason: input.reason,
        change: {
          before: { lifecycle: plan.from.lifecycle, costFrozen: plan.from.costFrozen, endedTransition: plan.from.endedTransition, lifecycleVersion: row.lifecycleVersion },
          after: { lifecycle: plan.to.lifecycle, costFrozen: plan.to.costFrozen, endedTransition: plan.to.endedTransition, lifecycleVersion: next },
        },
        detail: {
          transition: plan.kind, transitionId: transition.id, reopened: plan.kind === "RESUME" && plan.from.lifecycle === "ENDED",
          membersAffected: members, membersWithOverlay: withOverlay, isDefault: row.isDefault,
        },
        result: "SUCCESS",
        ipAddress: input.actor.ipAddress ?? null,
        userAgent: input.actor.userAgent ?? null,
      });
      return {
        ok: true as const,
        value: { key: input.key, kind: plan.kind, from: plan.from, to: plan.to, lifecycleVersion: next, transitionId: transition.id, membersAffected: members, isDefault: row.isDefault },
      };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return refuse("CONFLICT", "Someone else changed the group at the same time — reload and review again.");
    }
    throw e;
  }
  if (result.ok) invalidatePolicyGroupCatalogue();
  return result;
}
