/**
 * lib/platform/customer/assign.ts  (P1 — manual Policy / cohort assignment)
 *
 * THE ONE MUTATION SERVICE for a customer's Policy Group, overlay and cohorts
 * (Customer Success WRITE during beta). Each change and its operator-action
 * audit row commit in ONE transaction, with a structured reason the chokepoint
 * requires — an assignment can never land un-explained.
 *
 * Definitions are code (lib/entitlements/catalogue.ts): an unknown key is
 * REFUSED here, never stored. Cohorts are append-only identity: assigning one a
 * customer already has is reported as a no-op, not re-stamped.
 */

import "server-only";
import type { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { OperatorActionValidationError, recordOperatorAction, type OperatorReason } from "@/lib/audit";
import { isCohortKey, isOverlayKey, isPolicyGroupKey } from "@/lib/entitlements/catalogue";
import { resolveEffectiveEntitlements, type EffectiveEntitlements } from "@/lib/entitlements/resolve";

export interface AssignActor { userId: string; via: "PLATFORM_GRANT" | "SYSTEM_ADMIN"; area?: string; ipAddress?: string | null; userAgent?: string | null }

/** The narrow transactional surface the service needs — satisfied by a Prisma transaction or a test fake. */
export interface AssignTx {
  customerPolicyAssignment: {
    findUnique(args: { where: { userId: string } }): Promise<{ policyGroup: string; overlay: string | null; assignedAt: Date; assignedById: string | null } | null>;
    upsert(args: { where: { userId: string }; create: { userId: string; policyGroup: string; overlay: string | null; assignedById: string };
      update: { policyGroup: string; overlay: string | null; assignedById: string; assignedAt: Date } }): Promise<{ policyGroup: string; overlay: string | null; assignedAt: Date; assignedById: string | null }>;
  };
  customerCohort: {
    findUnique(args: { where: { userId_cohort: { userId: string; cohort: string } } }): Promise<{ id: string } | null>;
    create(args: { data: { userId: string; cohort: string; source: string; assignedById: string } }): Promise<{ id: string; joinedAt: Date }>;
  };
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown> };
}
export interface AssignClient { $transaction<T>(fn: (tx: AssignTx) => Promise<T>): Promise<T> }

export class AssignmentRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "AssignmentRefusedError"; }
}

export interface AssignPolicyInput {
  userId: string;
  /** Omit to keep the current group (requires an existing row or defaults to the catalogue default). */
  policyGroup?: string;
  /** undefined = keep; null = clear; string = set. */
  overlay?: string | null;
  reason: OperatorReason;
  actor: AssignActor;
}

export async function assignCustomerPolicy(input: AssignPolicyInput, client: AssignClient = systemDb as unknown as AssignClient): Promise<EffectiveEntitlements> {
  if (input.policyGroup !== undefined && !isPolicyGroupKey(input.policyGroup)) throw new AssignmentRefusedError(`Unknown policy group "${input.policyGroup}".`);
  if (typeof input.overlay === "string" && !isOverlayKey(input.overlay)) throw new AssignmentRefusedError(`Unknown overlay "${input.overlay}".`);
  if (input.policyGroup === undefined && input.overlay === undefined) throw new AssignmentRefusedError("Nothing to change.");
  if (!input.reason) throw new OperatorActionValidationError("A structured reason is required.");

  return client.$transaction(async (tx) => {
    const before = await tx.customerPolicyAssignment.findUnique({ where: { userId: input.userId } });
    const current = resolveEffectiveEntitlements(before);
    const nextGroup = input.policyGroup ?? current.policyGroup;
    const nextOverlay = input.overlay === undefined ? (before?.overlay ?? null) : input.overlay;
    const now = new Date();
    const row = await tx.customerPolicyAssignment.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, policyGroup: nextGroup, overlay: nextOverlay, assignedById: input.actor.userId },
      update: { policyGroup: nextGroup, overlay: nextOverlay, assignedById: input.actor.userId, assignedAt: now },
    });
    const overlayChanged = (before?.overlay ?? null) !== nextOverlay;
    const groupChanged = (before?.policyGroup ?? null) !== nextGroup;
    await recordOperatorAction(tx, {
      actor: { userId: input.actor.userId, via: input.actor.via, area: input.actor.area ?? "CUSTOMER_SUCCESS" },
      action: overlayChanged && !groupChanged ? AuditAction.CUSTOMER_POLICY_OVERLAY_CHANGED : AuditAction.CUSTOMER_POLICY_ASSIGNED,
      target: { kind: "USER", id: input.userId },
      reason: input.reason,
      change: {
        before: before ? { policyGroup: before.policyGroup, overlay: before.overlay } : null,
        after: { policyGroup: row.policyGroup, overlay: row.overlay },
      },
      result: "SUCCESS",
      ipAddress: input.actor.ipAddress ?? null, userAgent: input.actor.userAgent ?? null,
    });
    return resolveEffectiveEntitlements({ policyGroup: row.policyGroup, overlay: row.overlay, assignedAt: row.assignedAt, assignedById: row.assignedById });
  });
}

export interface AssignCohortInput { userId: string; cohort: string; reason: OperatorReason; actor: AssignActor }
export type AssignCohortResult = { outcome: "ADDED"; joinedAt: string } | { outcome: "ALREADY_MEMBER" };

export async function assignCustomerCohort(input: AssignCohortInput, client: AssignClient = systemDb as unknown as AssignClient): Promise<AssignCohortResult> {
  if (!isCohortKey(input.cohort)) throw new AssignmentRefusedError(`Unknown cohort "${input.cohort}".`);
  if (!input.reason) throw new OperatorActionValidationError("A structured reason is required.");
  return client.$transaction(async (tx) => {
    const existing = await tx.customerCohort.findUnique({ where: { userId_cohort: { userId: input.userId, cohort: input.cohort } } });
    if (existing) return { outcome: "ALREADY_MEMBER" as const };
    const row = await tx.customerCohort.create({ data: { userId: input.userId, cohort: input.cohort, source: "OPERATOR", assignedById: input.actor.userId } });
    await recordOperatorAction(tx, {
      actor: { userId: input.actor.userId, via: input.actor.via, area: input.actor.area ?? "CUSTOMER_SUCCESS" },
      action: AuditAction.CUSTOMER_COHORT_ASSIGNED,
      target: { kind: "USER", id: input.userId },
      reason: input.reason,
      change: { before: null, after: { cohort: input.cohort, source: "OPERATOR" } },
      result: "SUCCESS",
      ipAddress: input.actor.ipAddress ?? null, userAgent: input.actor.userAgent ?? null,
    });
    return { outcome: "ADDED" as const, joinedAt: row.joinedAt.toISOString() };
  });
}
