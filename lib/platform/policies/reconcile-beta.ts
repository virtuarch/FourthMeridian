/**
 * lib/platform/policies/reconcile-beta.ts  (owner ruling, 2026-10-30 — BETA RECONCILIATION)
 *
 * THE ONE SERVICE that gives existing ACTIVE customers with NO policy
 * assignment the beta default (DEFAULT_POLICY_GROUP). New registrations already
 * receive it at birth (app/api/auth/register/route.ts creates the row in the
 * registration transaction); this closes the gap for accounts created before
 * that, as a deliberate, audited Platform Operations action.
 *
 * THE GUARANTEES — each pinned by lib/platform/policies/reconcile-beta.test.ts:
 *
 *   1. CREATE ONLY. Rows are inserted with createMany + skipDuplicates. This
 *      module (and its route) never updates, upserts or deletes an assignment.
 *      `userId` is @unique, so an assignment written concurrently (an operator
 *      in Customer Success, a registration) WINS — the insert is skipped, never
 *      overwritten.
 *   2. EXISTING ASSIGNMENTS ARE UNTOUCHED, VALID OR NOT. Founder (an overlay on
 *      an assignment row) has a row, so it is never eligible. An assignment
 *      naming an unknown / retired group also has a row: it stays as it is for
 *      the fail-closed Attention item and alert to surface and an operator to
 *      correct (lib/platform/policy-assignment-health.ts). No silent repair.
 *   3. ACTIVE CUSTOMERS ONLY. role USER and deactivatedAt null (pending
 *      deletion sets deactivatedAt) — the same population the fail-closed
 *      Attention item counts. Non-customer roles and deactivated accounts are
 *      excluded and reported as such.
 *   4. BETA ONLY. The group is DEFAULT_POLICY_GROUP (the built-in Beta,
 *      BETA_FULL_ACCESS_V1) and nothing else — WHATEVER the DB default is: no
 *      overlay, no allowance override, never a Free / Paid / Pro group. If Beta
 *      is archived or its stored definition is unusable, the dry run reports
 *      the eligible accounts as BLOCKED and the apply REFUSES — it never falls
 *      through to another group.
 *   5. COUNTED BEFORE CHANGED. The dry run reports the population; the apply
 *      takes the count the operator saw (`expectedEligible`) and refuses with
 *      CONFLICT, writing nothing, when the population moved since.
 *   6. ONE TRANSACTION, ONE AUDIT ROW. The inserts and ONE
 *      CUSTOMER_POLICY_RECONCILED operator action (reason-required) commit
 *      together. The row carries counts only — never a customer id, email or
 *      name — and targets the POLICY_GROUP, not a customer.
 *
 * NOTHING RUNS THIS AUTOMATICALLY. There is no job, cron, migration or boot
 * hook: an operator with fresh PLATFORM_OPS CONTROL presses it. Whether it is
 * pressed in Production is an owner decision.
 *
 * Fail-closed is unchanged: an account still missing an assignment after this
 * (registered mid-run, or excluded) resolves exactly as before.
 *
 * POLICY EDITOR (Phase 2) — owner ruling (corrected in review): "reconcile
 * unassigned pre-beta accounts to BETA". The TARGET stays the built-in Beta
 * key even if an operator moves the registration default. Only the
 * alreadyAssigned / unknownAssignments split uses the policy-group catalogue
 * ("known" = a key that resolves to a valid plan).
 */

import "server-only";
import type { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { DEFAULT_POLICY_GROUP } from "@/lib/entitlements/catalogue";
import { groupLabel, resolvableGroupKeys, type PolicyGroupCatalogue } from "@/lib/entitlements/policy-groups";
import { loadPolicyGroupCatalogue } from "./policy-group-catalogue";

// ── The populations (one definition each; the read and the apply share them) ──

/** Eligible: an ACTIVE customer account with NO assignment row. */
export const ELIGIBLE_WHERE = { role: "USER" as const, deactivatedAt: null, policyAssignment: { is: null } };
const DEACTIVATED_UNASSIGNED_WHERE = { role: "USER" as const, deactivatedAt: { not: null }, policyAssignment: { is: null } };
const NON_CUSTOMER_UNASSIGNED_WHERE = { role: { not: "USER" as const }, policyAssignment: { is: null } };

// ── The DTOs ──────────────────────────────────────────────────────────────────

/**
 * The dry run: counts only, never an identity. Every account falls in exactly
 * one bucket (eligible + the four exclusions = all accounts):
 *   deactivated         customer accounts with no row that are deactivated / pending deletion
 *   nonCustomerRoles    non-USER accounts (e.g. SYSTEM_ADMIN) with no row
 *   alreadyAssigned     accounts with a row naming a catalogue group (incl. Founder overlays)
 *   unknownAssignments  accounts with a row naming a group the catalogue no longer defines
 */
export interface BetaReconciliationDryRun {
  eligible: number;
  groupKey: string;
  /** The Beta group's label (the entry names the group it assigns). */
  groupLabel?: string;
  /**
   * Why Beta cannot be assigned right now (archived, or its stored definition is
   * unusable), else null. While set, `eligible` accounts are eligible-but-BLOCKED
   * and the apply refuses — it never assigns another group.
   */
  blocked?: "ARCHIVED" | "INVALID" | null;
  excluded: { deactivated: number; nonCustomerRoles: number; alreadyAssigned: number; unknownAssignments: number };
  checkedAt: string;
}

export interface BetaReconciliationActor {
  userId: string;
  via: OperatorActionInput["actor"]["via"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ApplyBetaReconciliationInput {
  /** The eligible count the operator saw. When present and different ⇒ CONFLICT, nothing written. */
  expectedEligible?: number;
  reason: OperatorReason;
  actor: BetaReconciliationActor;
}

export type BetaReconciliationResult =
  | { ok: true; outcome: "ASSIGNED"; eligible: number; created: number; skipped: number; groupKey: string }
  | { ok: true; outcome: "NOTHING_TO_ASSIGN"; eligible: 0; created: 0; skipped: 0; groupKey: string }
  | { ok: false; code: "CONFLICT"; eligible: number; expectedEligible: number; groupKey: string }
  | { ok: false; code: "BLOCKED"; blocked: "ARCHIVED" | "INVALID"; groupKey: string };

/** Why the built-in Beta group cannot receive accounts now, or null. */
export function betaBlocked(catalogue: PolicyGroupCatalogue): "ARCHIVED" | "INVALID" | null {
  const g = catalogue.groups[DEFAULT_POLICY_GROUP];
  if (!g || !g.valid) return "INVALID";
  return g.archived ? "ARCHIVED" : null;
}

// ── The narrow clients (systemDb satisfies them; tests hand a fake) ───────────

type Count = (args: { where: Record<string, unknown> }) => Promise<number>;

export interface BetaReconciliationReadClient {
  user: { count: Count };
  customerPolicyAssignment: { count: Count };
}

export interface BetaReconciliationTx {
  user: { findMany(args: { where: typeof ELIGIBLE_WHERE; select: { id: true }; orderBy: { createdAt: "asc" } }): Promise<{ id: string }[]> };
  customerPolicyAssignment: {
    createMany(args: {
      data: { userId: string; policyGroup: string; overlay: null; aiDailyUsdAllowanceOverride: null; assignedById: string }[];
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown> };
}
export interface BetaReconciliationClient { $transaction<T>(fn: (tx: BetaReconciliationTx) => Promise<T>): Promise<T> }

// ── The dry run ───────────────────────────────────────────────────────────────

export async function readBetaReconciliation(
  client: BetaReconciliationReadClient = systemDb as unknown as BetaReconciliationReadClient,
  now: Date = new Date(),
  loadCatalogue: () => Promise<PolicyGroupCatalogue> = loadPolicyGroupCatalogue,
): Promise<BetaReconciliationDryRun> {
  const catalogue = await loadCatalogue();
  const known = resolvableGroupKeys(catalogue);
  const [eligible, deactivated, nonCustomerRoles, alreadyAssigned, unknownAssignments] = await Promise.all([
    client.user.count({ where: ELIGIBLE_WHERE }),
    client.user.count({ where: DEACTIVATED_UNASSIGNED_WHERE }),
    client.user.count({ where: NON_CUSTOMER_UNASSIGNED_WHERE }),
    client.customerPolicyAssignment.count({ where: { policyGroup: { in: known } } }),
    client.customerPolicyAssignment.count({ where: { policyGroup: { notIn: known } } }),
  ]);
  return {
    eligible,
    groupKey: DEFAULT_POLICY_GROUP,
    groupLabel: groupLabel(catalogue, DEFAULT_POLICY_GROUP),
    blocked: betaBlocked(catalogue),
    excluded: { deactivated, nonCustomerRoles, alreadyAssigned, unknownAssignments },
    checkedAt: now.toISOString(),
  };
}

// ── The apply ─────────────────────────────────────────────────────────────────

export async function applyBetaReconciliation(
  input: ApplyBetaReconciliationInput,
  client: BetaReconciliationClient = systemDb as unknown as BetaReconciliationClient,
  loadCatalogue: () => Promise<PolicyGroupCatalogue> = loadPolicyGroupCatalogue,
): Promise<BetaReconciliationResult> {
  const groupKey = DEFAULT_POLICY_GROUP;
  const blocked = betaBlocked(await loadCatalogue());
  if (blocked) return { ok: false as const, code: "BLOCKED" as const, blocked, groupKey };
  return client.$transaction(async (tx) => {
    const rows = await tx.user.findMany({ where: ELIGIBLE_WHERE, select: { id: true }, orderBy: { createdAt: "asc" } });
    const eligible = rows.length;
    if (input.expectedEligible !== undefined && input.expectedEligible !== eligible) {
      return { ok: false as const, code: "CONFLICT" as const, eligible, expectedEligible: input.expectedEligible, groupKey };
    }
    if (eligible === 0) return { ok: true as const, outcome: "NOTHING_TO_ASSIGN" as const, eligible: 0 as const, created: 0 as const, skipped: 0 as const, groupKey };

    const { count: created } = await tx.customerPolicyAssignment.createMany({
      data: rows.map((r) => ({ userId: r.id, policyGroup: groupKey, overlay: null, aiDailyUsdAllowanceOverride: null, assignedById: input.actor.userId })),
      skipDuplicates: true,
    });
    const skipped = eligible - created;
    await recordOperatorAction(tx, {
      actor: { userId: input.actor.userId, via: input.actor.via, area: "PLATFORM_OPS" },
      action: AuditAction.CUSTOMER_POLICY_RECONCILED,
      target: { kind: "POLICY_GROUP", id: groupKey },
      reason: input.reason,
      change: { before: { eligible }, after: { policyGroup: groupKey, created } },
      detail: { eligible, created, skipped },
      result: "SUCCESS",
      ipAddress: input.actor.ipAddress ?? null,
      userAgent: input.actor.userAgent ?? null,
    });
    return { ok: true as const, outcome: "ASSIGNED" as const, eligible, created, skipped, groupKey };
  });
}
