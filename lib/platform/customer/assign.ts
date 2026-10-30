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
 *
 * AI COST CONTROLS — the per-customer daily AI allowance OVERRIDE
 * (`aiDailyUsdAllowanceOverride`, migration 20261016000000) is written HERE and
 * nowhere else: `undefined` keeps, `null` removes, an integer 1 … the catalogue
 * ceiling sets. Above the ceiling is REFUSED at the service (never clamped
 * silently, so no accidental escalation); the resolver still clamps as belt and
 * braces. Audited as CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED (reason-required)
 * when it is the only change; a change made together with a group or overlay
 * change rides that action's row (the change block carries all three facts).
 *
 * POLICY EDITOR (Phase 2) — Customer Success may ASSIGN any group the
 * policy-group catalogue offers as assignable: a code group or a DB group that
 * is VALID and NOT ARCHIVED (lib/entitlements/policy-groups.ts
 * isAssignableGroup). An archived, invalid or unknown key is REFUSED here,
 * never stored. CS cannot create or edit groups (that is Platform Operations
 * CONTROL, lib/platform/policies/policy-groups-write.ts).
 */

import "server-only";
import type { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { OperatorActionValidationError, recordOperatorAction, type OperatorReason } from "@/lib/audit";
import { ENTITLEMENT_DIMENSIONS, isCohortKey, isOverlayKey } from "@/lib/entitlements/catalogue";
import { loadPlatformEntitlementInputs, resolveEffectiveEntitlements, type EffectiveEntitlements } from "@/lib/entitlements/resolve";
import { isAssignableGroup, type PolicyGroupCatalogue } from "@/lib/entitlements/policy-groups";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";

/** The catalogue ceiling an override may never exceed (derived, never hand-copied). */
export const AI_ALLOWANCE_OVERRIDE_CEILING_USD: number = ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance.ceiling;

/** PURE — an override value is a whole number of dollars from 1 to the ceiling; anything else is refused. */
export function validateAllowanceOverride(v: unknown): { ok: true; usd: number } | { ok: false; reason: string } {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return { ok: false, reason: "The allowance override must be a whole number of dollars." };
  if (v < 1) return { ok: false, reason: "The allowance override must be at least 1 (remove it to fall back to the policy)." };
  if (v > AI_ALLOWANCE_OVERRIDE_CEILING_USD) return { ok: false, reason: `The allowance override cannot exceed the platform ceiling of ${AI_ALLOWANCE_OVERRIDE_CEILING_USD}.` };
  return { ok: true, usd: v };
}

export interface AssignActor { userId: string; via: "PLATFORM_GRANT" | "SYSTEM_ADMIN"; area?: string; ipAddress?: string | null; userAgent?: string | null }

/** The narrow transactional surface the service needs — satisfied by a Prisma transaction or a test fake. */
type AssignmentRow = { policyGroup: string; overlay: string | null; assignedAt: Date; assignedById: string | null; aiDailyUsdAllowanceOverride?: number | null };

export interface AssignTx {
  customerPolicyAssignment: {
    findUnique(args: { where: { userId: string } }): Promise<AssignmentRow | null>;
    upsert(args: { where: { userId: string }; create: { userId: string; policyGroup: string; overlay: string | null; assignedById: string; aiDailyUsdAllowanceOverride: number | null };
      update: { policyGroup: string; overlay: string | null; assignedById: string; assignedAt: Date; aiDailyUsdAllowanceOverride: number | null } }): Promise<AssignmentRow>;
  };
  /** Optional: the platform allowance value, read for the returned effective entitlements (fm_system holds PlatformSetting). */
  platformSetting?: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> };
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
  /** AI COST CONTROLS — undefined = keep; null = remove; integer 1 … ceiling = set (above the ceiling is refused). */
  aiDailyUsdAllowanceOverride?: number | null;
  reason: OperatorReason;
  actor: AssignActor;
}

export async function assignCustomerPolicy(
  input: AssignPolicyInput,
  client: AssignClient = systemDb as unknown as AssignClient,
  loadCatalogue: () => Promise<PolicyGroupCatalogue> = loadPolicyGroupCatalogue,
): Promise<EffectiveEntitlements> {
  const catalogue = await loadCatalogue();
  if (input.policyGroup !== undefined && !isAssignableGroup(catalogue, input.policyGroup)) {
    const g = catalogue.groups[input.policyGroup];
    throw new AssignmentRefusedError(g?.archived ? `Policy group "${input.policyGroup}" is archived and cannot be assigned.`
      : g ? `Policy group "${input.policyGroup}" has an invalid stored definition and cannot be assigned.`
      : `Unknown policy group "${input.policyGroup}".`);
  }
  if (typeof input.overlay === "string" && !isOverlayKey(input.overlay)) throw new AssignmentRefusedError(`Unknown overlay "${input.overlay}".`);
  if (input.policyGroup === undefined && input.overlay === undefined && input.aiDailyUsdAllowanceOverride === undefined) throw new AssignmentRefusedError("Nothing to change.");
  if (input.aiDailyUsdAllowanceOverride !== undefined && input.aiDailyUsdAllowanceOverride !== null) {
    const v = validateAllowanceOverride(input.aiDailyUsdAllowanceOverride);
    if (!v.ok) throw new AssignmentRefusedError(v.reason);
  }
  if (!input.reason) throw new OperatorActionValidationError("A structured reason is required.");

  return client.$transaction(async (tx) => {
    const before = await tx.customerPolicyAssignment.findUnique({ where: { userId: input.userId } });
    const current = resolveEffectiveEntitlements(before, undefined, { catalogue });
    const nextGroup = input.policyGroup ?? current.policyGroup;
    const nextOverlay = input.overlay === undefined ? (before?.overlay ?? null) : input.overlay;
    const beforeOverride = before?.aiDailyUsdAllowanceOverride ?? null;
    const nextOverride = input.aiDailyUsdAllowanceOverride === undefined ? beforeOverride : input.aiDailyUsdAllowanceOverride;
    const now = new Date();
    const row = await tx.customerPolicyAssignment.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, policyGroup: nextGroup, overlay: nextOverlay, assignedById: input.actor.userId, aiDailyUsdAllowanceOverride: nextOverride },
      update: { policyGroup: nextGroup, overlay: nextOverlay, assignedById: input.actor.userId, assignedAt: now, aiDailyUsdAllowanceOverride: nextOverride },
    });
    const overlayChanged = (before?.overlay ?? null) !== nextOverlay;
    const groupChanged = (before?.policyGroup ?? null) !== nextGroup;
    const overrideChanged = beforeOverride !== nextOverride;
    const action = groupChanged ? AuditAction.CUSTOMER_POLICY_ASSIGNED
      : overlayChanged ? AuditAction.CUSTOMER_POLICY_OVERLAY_CHANGED
      : overrideChanged ? AuditAction.CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED
      : AuditAction.CUSTOMER_POLICY_ASSIGNED;
    const rowOverride = row.aiDailyUsdAllowanceOverride ?? nextOverride;
    await recordOperatorAction(tx, {
      actor: { userId: input.actor.userId, via: input.actor.via, area: input.actor.area ?? "CUSTOMER_SUCCESS" },
      action,
      target: { kind: "USER", id: input.userId },
      reason: input.reason,
      change: {
        before: before ? { policyGroup: before.policyGroup, overlay: before.overlay, aiDailyUsdAllowanceOverride: beforeOverride } : null,
        after: { policyGroup: row.policyGroup, overlay: row.overlay, aiDailyUsdAllowanceOverride: rowOverride },
      },
      result: "SUCCESS",
      ipAddress: input.actor.ipAddress ?? null, userAgent: input.actor.userAgent ?? null,
    });
    const platform = await loadPlatformEntitlementInputs({ customerPolicyAssignment: tx.customerPolicyAssignment, platformSetting: tx.platformSetting });
    return resolveEffectiveEntitlements({
      policyGroup: row.policyGroup, overlay: row.overlay, assignedAt: row.assignedAt, assignedById: row.assignedById,
      aiDailyUsdAllowanceOverride: rowOverride,
    }, platform, { catalogue });
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
