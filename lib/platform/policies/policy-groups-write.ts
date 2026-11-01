/**
 * lib/platform/policies/policy-groups-write.ts  (POLICY EDITOR — the ONE mutation service)
 *
 * Owner ruling (2026-10-30): "Platform Operations CONTROL permission is required
 * to create, edit, clone, archive, or otherwise modify customer policy groups.
 * Require an operator reason and audit trail." The routes enforce fresh
 * PLATFORM_OPS CONTROL; THIS module enforces everything else:
 *
 *   createPolicyGroup     POLICY_GROUP_CREATED         a new group from the default's
 *                                                      values, or a CLONE of an existing
 *                                                      group's current version (optionally
 *                                                      with edited values); version 1
 *   updatePolicyGroup     POLICY_GROUP_UPDATED         a NEW version; `expectedVersion` is
 *                                                      the optimistic token (stale ⇒ CONFLICT)
 *   rollbackPolicyGroup   POLICY_GROUP_ROLLED_BACK     a NEW version whose values equal an
 *                                                      earlier version's (history is append-only)
 *   archivePolicyGroup    POLICY_GROUP_ARCHIVED        refused while ANY assignment names the
 *                                                      group (counted under a FOR UPDATE row
 *                                                      lock), for the default group, and for
 *                                                      built-in groups
 *   setDefaultPolicyGroup POLICY_GROUP_DEFAULT_CHANGED moves the default; affects NEW
 *                                                      registrations only — never an assignment
 *
 * THE GUARANTEES (pinned by policy-groups-write.test.ts):
 *   · ONE systemDb transaction per operation, with ONE recordOperatorAction row
 *     (every action reason-required) — the change and its audit commit together.
 *   · VALIDATED: every dimension present, the right kind, within [0, ceiling]
 *     for counts, [ceiling, 7 days] for floors, a boolean never above its
 *     ceiling; no unknown dimension; label 1–60; key UPPER_SNAKE, never a code
 *     group / overlay / cohort key; the key is immutable after create.
 *   · VERSIONS ARE IMMUTABLE: this module only ever CREATES PolicyGroupVersion
 *     rows (and fm_system holds no UPDATE/DELETE on the table).
 *   · NO DELETE, NO ASSIGNMENT WRITE: groups are archived, never deleted; no
 *     operation here reads a customer id or writes CustomerPolicyAssignment.
 *     Customer COUNTS only, in the audit row and the change summary.
 *   · The ceilings, the Founder overlay and FAIL_CLOSED_VALUES are code and are
 *     not reachable from here.
 *   · The in-process catalogue cache is invalidated after every commit.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import {
  diffEntitlementValues, normaliseStoredValues, validateEntitlementValues, validateGroupDescription, validateGroupLabel, validateNewGroupKey,
  type DimensionChange, type PolicyGroupCatalogue,
} from "@/lib/entitlements/policy-groups";
import { POLICY_GROUPS, type EntitlementValues } from "@/lib/entitlements/catalogue";
import {
  invalidatePolicyGroupCatalogue, readPolicyGroupCatalogue, type PolicyGroupCatalogueReadClient,
} from "./policy-group-catalogue";

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface PolicyGroupActor {
  userId: string;
  via: OperatorActionInput["actor"]["via"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type PolicyGroupRefusalCode = "VALIDATION" | "CONFLICT" | "NOT_FOUND" | "NOT_EDITABLE";

export type PolicyGroupWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PolicyGroupRefusalCode; error: string; errors?: string[] };

export interface PolicyGroupWritten {
  key: string;
  version: number;
  changes: DimensionChange[];
  /** Customers whose assignment names the group (counts only). */
  customersAffected: number;
}

/** The change summary stored on a version (and mirrored in the audit row). No customer data. */
export interface PolicyGroupChangeSummary {
  kind: "SEEDED" | "CREATED" | "UPDATED" | "ROLLED_BACK";
  /** CREATED: the group the values came from (or the default's key). */
  from?: string;
  fromVersion?: number | null;
  /** ROLLED_BACK: the version whose values were restored. */
  restoredVersion?: number;
  changes: { key: string; before: boolean | number | null; after: boolean | number }[];
  label?: { before: string | null; after: string };
  descriptionChanged?: boolean;
  customersAffected?: number;
}

/** The transaction surface (a Prisma transaction satisfies it). */
type Tx = Prisma.TransactionClient;
export interface PolicyGroupWriteClient { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }

const refuse = (code: PolicyGroupRefusalCode, error: string, errors?: string[]) => ({ ok: false as const, code, error, ...(errors ? { errors } : {}) });

/** Thrown inside a transaction to ROLL BACK what it already wrote and answer a refusal (never a 500). */
class RefusalRollback extends Error {
  constructor(readonly refusal: { ok: false; code: PolicyGroupRefusalCode; error: string }) { super(refusal.error); this.name = "RefusalRollback"; }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Run one write; a unique violation (a concurrent create/edit) is a CONFLICT, never a 500. Invalidate after commit. */
async function run<T>(client: PolicyGroupWriteClient, fn: (tx: Tx) => Promise<PolicyGroupWriteResult<T>>): Promise<PolicyGroupWriteResult<T>> {
  try {
    const r = await client.$transaction(fn);
    if (r.ok) invalidatePolicyGroupCatalogue();
    return r;
  } catch (e) {
    if (e instanceof RefusalRollback) return e.refusal;
    if (isUniqueViolation(e)) return refuse("CONFLICT", "Someone else changed policy groups at the same time — reload and review again.");
    throw e;
  }
}

const catalogueIn = (tx: Tx): Promise<PolicyGroupCatalogue> => readPolicyGroupCatalogue(tx as unknown as PolicyGroupCatalogueReadClient);

async function assignedCounts(tx: Tx, key: string): Promise<{ customers: number; withOverlay: number }> {
  const [customers, withOverlay] = await Promise.all([
    tx.customerPolicyAssignment.count({ where: { policyGroup: key } }),
    tx.customerPolicyAssignment.count({ where: { policyGroup: key, overlay: { not: null } } }),
  ]);
  return { customers, withOverlay };
}

const summaryChanges = (c: DimensionChange[]) => c.map((d) => ({ key: d.key, before: d.before, after: d.after }));

async function audit(tx: Tx, actor: PolicyGroupActor, action: AuditActionType, key: string, reason: OperatorReason,
  change: OperatorActionInput["change"], detail: Record<string, unknown>): Promise<void> {
  await recordOperatorAction(tx, {
    actor: { userId: actor.userId, via: actor.via, area: "PLATFORM_OPS" },
    action,
    target: { kind: "POLICY_GROUP", id: key },
    reason,
    change,
    detail,
    result: "SUCCESS",
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });
}

// ── Create / clone ────────────────────────────────────────────────────────────

export interface CreatePolicyGroupInput {
  key: unknown;
  label: unknown;
  description?: unknown;
  /** "DEFAULT" = the default group's current values; otherwise an existing group key to CLONE. */
  from: string;
  /** Optional edited values (validated); absent ⇒ exactly the source's values. */
  values?: unknown;
  reason: OperatorReason;
  actor: PolicyGroupActor;
}

export async function createPolicyGroup(input: CreatePolicyGroupInput, client: PolicyGroupWriteClient = systemDb): Promise<PolicyGroupWriteResult<PolicyGroupWritten>> {
  const key = validateNewGroupKey(input.key);
  if (!key.ok) return refuse("VALIDATION", key.error);
  const label = validateGroupLabel(input.label);
  if (!label.ok) return refuse("VALIDATION", label.error);
  const description = validateGroupDescription(input.description);
  if (!description.ok) return refuse("VALIDATION", description.error);
  let edited: EntitlementValues | null = null;
  if (input.values !== undefined) {
    const v = validateEntitlementValues(input.values);
    if (!v.ok) return refuse("VALIDATION", "The values are not valid.", v.errors);
    edited = v.values;
  }

  return run(client, async (tx) => {
    const catalogue = await catalogueIn(tx);
    const fromKey = input.from === "DEFAULT" ? catalogue.defaultKey : input.from;
    const source = catalogue.groups[fromKey];
    if (!source) return refuse("NOT_FOUND", `Policy group "${String(input.from).slice(0, 64)}" does not exist.`);
    if (!source.valid || !source.values) return refuse("VALIDATION", "The source group's stored definition is invalid; it cannot be cloned.");
    // Review fix 7 — an archived group is retired; cloning it would resurrect a retired definition.
    // (No path needs it: "New group" starts from the default, which can never be archived.)
    if (source.archived) return refuse("NOT_EDITABLE", "An archived group cannot be cloned — clone an active group instead.");
    if (await tx.policyGroup.findUnique({ where: { key: key.key }, select: { key: true } })) {
      return refuse("CONFLICT", `A policy group "${key.key}" already exists.`);
    }
    const values = edited ?? source.values;
    const changes = diffEntitlementValues(source.values, values);
    const summary: PolicyGroupChangeSummary = {
      kind: "CREATED", from: fromKey, fromVersion: source.version, changes: summaryChanges(changes),
      label: { before: null, after: label.label }, customersAffected: 0,
    };
    await tx.policyGroup.create({
      data: { key: key.key, label: label.label, description: description.description, isDefault: false, builtIn: false, currentVersion: 1, createdById: input.actor.userId },
      select: { key: true },
    });
    await tx.policyGroupVersion.create({
      data: {
        groupKey: key.key, version: 1, values: values as unknown as Prisma.InputJsonValue, label: label.label, description: description.description,
        changeSummary: summary as unknown as Prisma.InputJsonValue, reasonCode: input.reason.code, reasonNote: input.reason.note ?? null, createdById: input.actor.userId,
      },
    });
    await audit(tx, input.actor, AuditAction.POLICY_GROUP_CREATED, key.key, input.reason,
      { before: null, after: { key: key.key, version: 1, label: label.label, from: fromKey, fromVersion: source.version } },
      { from: fromKey, fromVersion: source.version, clone: input.from !== "DEFAULT", changes: summary.changes, changedDimensions: changes.length, customersAffected: 0 });
    return { ok: true as const, value: { key: key.key, version: 1, changes, customersAffected: 0 } };
  });
}

// ── Update (a new version) ────────────────────────────────────────────────────

export interface UpdatePolicyGroupInput {
  key: string;
  /** The version the operator reviewed (optimistic token). */
  expectedVersion: number;
  values: unknown;
  label?: unknown;
  description?: unknown;
  reason: OperatorReason;
  actor: PolicyGroupActor;
}

interface NewVersionPlan {
  key: string;
  expectedVersion: number;
  values: EntitlementValues;
  label: string;
  description: string;
  kind: "UPDATED" | "ROLLED_BACK";
  restoredVersion?: number;
}

/** The shared core of update and rollback: guard the token, append a version, move the pointer, audit. */
async function appendVersion(tx: Tx, plan: NewVersionPlan, reason: OperatorReason, actor: PolicyGroupActor): Promise<PolicyGroupWriteResult<PolicyGroupWritten>> {
  // Explicit select (review fix 5): never a column a pre-migration database may lack.
  const row = await tx.policyGroup.findUnique({ where: { key: plan.key }, select: { archivedAt: true, currentVersion: true, label: true, description: true } });
  if (!row) return refuse("NOT_FOUND", `Policy group "${plan.key.slice(0, 64)}" does not exist.`);
  if (row.archivedAt) return refuse("NOT_EDITABLE", "An archived group cannot be edited.");
  if (row.currentVersion !== plan.expectedVersion) {
    return refuse("CONFLICT", `The group changed since you opened it (now version ${row.currentVersion}) — reload and review again.`);
  }
  const current = await tx.policyGroupVersion.findUnique({ where: { groupKey_version: { groupKey: plan.key, version: row.currentVersion } } });
  // The stored version as the resolver reads it (tolerant normalisation), so the diff is against what is in force.
  const currentCheck = current ? normaliseStoredValues(current.values, POLICY_GROUPS[plan.key]?.values ?? null) : null;
  const before = currentCheck?.ok ? currentCheck.values : null;
  const changes = diffEntitlementValues(before, plan.values);
  const labelChanged = row.label !== plan.label;
  const descriptionChanged = row.description !== plan.description;
  if (before !== null && changes.length === 0 && !labelChanged && !descriptionChanged) {
    return refuse("VALIDATION", "Nothing changed.");
  }
  const next = row.currentVersion + 1;
  // The pointer moves only from the version the operator reviewed — a concurrent edit makes this 0 rows.
  const moved = await tx.policyGroup.updateMany({
    where: { key: plan.key, currentVersion: plan.expectedVersion, archivedAt: null },
    data: { currentVersion: next, label: plan.label, description: plan.description },
  });
  if (moved.count !== 1) return refuse("CONFLICT", "The group changed since you opened it — reload and review again.");
  const counts = await assignedCounts(tx, plan.key);
  const summary: PolicyGroupChangeSummary = {
    kind: plan.kind, fromVersion: row.currentVersion, ...(plan.restoredVersion !== undefined ? { restoredVersion: plan.restoredVersion } : {}),
    changes: summaryChanges(changes), ...(labelChanged ? { label: { before: row.label, after: plan.label } } : {}),
    descriptionChanged, customersAffected: counts.customers,
  };
  await tx.policyGroupVersion.create({
    data: {
      groupKey: plan.key, version: next, values: plan.values as unknown as Prisma.InputJsonValue, label: plan.label, description: plan.description,
      changeSummary: summary as unknown as Prisma.InputJsonValue, reasonCode: reason.code, reasonNote: reason.note ?? null, createdById: actor.userId,
    },
  });
  await audit(tx, actor, plan.kind === "ROLLED_BACK" ? AuditAction.POLICY_GROUP_ROLLED_BACK : AuditAction.POLICY_GROUP_UPDATED, plan.key, reason,
    { before: { version: row.currentVersion, label: row.label }, after: { version: next, label: plan.label } },
    {
      fromVersion: row.currentVersion, version: next, ...(plan.restoredVersion !== undefined ? { restoredVersion: plan.restoredVersion } : {}),
      changes: summary.changes, changedDimensions: changes.length, labelChanged, descriptionChanged,
      customersAffected: counts.customers, customersWithOverlay: counts.withOverlay,
    });
  return { ok: true as const, value: { key: plan.key, version: next, changes, customersAffected: counts.customers } };
}

export async function updatePolicyGroup(input: UpdatePolicyGroupInput, client: PolicyGroupWriteClient = systemDb): Promise<PolicyGroupWriteResult<PolicyGroupWritten>> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return refuse("VALIDATION", "expectedVersion is required: the version you reviewed.");
  const v = validateEntitlementValues(input.values);
  if (!v.ok) return refuse("VALIDATION", "The values are not valid.", v.errors);
  return run(client, async (tx) => {
    const row = await tx.policyGroup.findUnique({ where: { key: input.key }, select: { label: true, description: true } });
    if (!row) return refuse("NOT_FOUND", `Policy group "${input.key.slice(0, 64)}" does not exist.`);
    const label = input.label === undefined ? { ok: true as const, label: row.label } : validateGroupLabel(input.label);
    if (!label.ok) return refuse("VALIDATION", label.error);
    const description = input.description === undefined ? { ok: true as const, description: row.description } : validateGroupDescription(input.description);
    if (!description.ok) return refuse("VALIDATION", description.error);
    return appendVersion(tx, { key: input.key, expectedVersion: input.expectedVersion, values: v.values, label: label.label, description: description.description, kind: "UPDATED" }, input.reason, input.actor);
  });
}

// ── Rollback (a new version from an earlier one) ──────────────────────────────

export interface RollbackPolicyGroupInput {
  key: string;
  expectedVersion: number;
  /** The earlier version whose values (and label/description) are restored. */
  toVersion: number;
  reason: OperatorReason;
  actor: PolicyGroupActor;
}

export async function rollbackPolicyGroup(input: RollbackPolicyGroupInput, client: PolicyGroupWriteClient = systemDb): Promise<PolicyGroupWriteResult<PolicyGroupWritten>> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return refuse("VALIDATION", "expectedVersion is required: the version you reviewed.");
  if (!Number.isInteger(input.toVersion) || input.toVersion < 1) return refuse("VALIDATION", "toVersion must be an earlier version number.");
  if (input.toVersion >= input.expectedVersion) return refuse("VALIDATION", "Only an EARLIER version can be restored.");
  return run(client, async (tx) => {
    const target = await tx.policyGroupVersion.findUnique({ where: { groupKey_version: { groupKey: input.key, version: input.toVersion } } });
    if (!target) return refuse("NOT_FOUND", `Version ${input.toVersion} of "${input.key.slice(0, 64)}" does not exist.`);
    const v = validateEntitlementValues(target.values);
    if (!v.ok) return refuse("VALIDATION", `Version ${input.toVersion} is not valid under today's ceilings and cannot be restored.`, v.errors);
    return appendVersion(tx, {
      key: input.key, expectedVersion: input.expectedVersion, values: v.values, label: target.label, description: target.description,
      kind: "ROLLED_BACK", restoredVersion: input.toVersion,
    }, input.reason, input.actor);
  });
}

// ── Archive ───────────────────────────────────────────────────────────────────

export interface ArchivePolicyGroupInput { key: string; reason: OperatorReason; actor: PolicyGroupActor }

export async function archivePolicyGroup(input: ArchivePolicyGroupInput, client: PolicyGroupWriteClient = systemDb): Promise<PolicyGroupWriteResult<{ key: string; archivedAt: string }>> {
  return run(client, async (tx) => {
    // REVIEW FIX 3 — lock the group row (FOR UPDATE) BEFORE counting assignments:
    // a concurrent Customer Success assignment re-reads it FOR SHARE inside its own
    // transaction, so either it commits first (and is counted here) or it waits and
    // then sees archivedAt and refuses. Parameterised tagged template only.
    await tx.$queryRaw`SELECT "key" FROM "PolicyGroup" WHERE "key" = ${input.key} FOR UPDATE`;
    const row = await tx.policyGroup.findUnique({ where: { key: input.key }, select: { archivedAt: true, isDefault: true, builtIn: true, currentVersion: true } });
    if (!row) return refuse("NOT_FOUND", `Policy group "${input.key.slice(0, 64)}" does not exist.`);
    if (row.archivedAt) return refuse("VALIDATION", "The group is already archived.");
    if (row.isDefault) return refuse("NOT_EDITABLE", "The default group cannot be archived — make another group the default first.");
    // Review fix 6 (ruling) — built-in groups (the seeded Beta) are never archived.
    if (row.builtIn) return refuse("NOT_EDITABLE", "Built-in groups cannot be archived.");
    const counts = await assignedCounts(tx, input.key);
    if (counts.customers > 0) {
      return refuse("CONFLICT", `${counts.customers} customer${counts.customers === 1 ? " is" : "s are"} assigned to this group — reassign them in Customer Success before archiving.`);
    }
    const now = new Date();
    const moved = await tx.policyGroup.updateMany({ where: { key: input.key, archivedAt: null, isDefault: false }, data: { archivedAt: now } });
    if (moved.count !== 1) return refuse("CONFLICT", "The group changed since you opened it — reload and review again.");
    await audit(tx, input.actor, AuditAction.POLICY_GROUP_ARCHIVED, input.key, input.reason,
      { before: { archived: false, version: row.currentVersion }, after: { archived: true, version: row.currentVersion } },
      { version: row.currentVersion, customersAffected: 0 });
    return { ok: true as const, value: { key: input.key, archivedAt: now.toISOString() } };
  });
}

// ── Default ───────────────────────────────────────────────────────────────────

export interface SetDefaultPolicyGroupInput {
  key: string;
  /** The default the operator saw (optimistic token). */
  expectedDefaultKey: string;
  reason: OperatorReason;
  actor: PolicyGroupActor;
}

/** Moves the default for NEW registrations. Never reads or writes an assignment. */
export async function setDefaultPolicyGroup(input: SetDefaultPolicyGroupInput, client: PolicyGroupWriteClient = systemDb): Promise<PolicyGroupWriteResult<{ key: string; previousDefault: string }>> {
  return run(client, async (tx) => {
    const catalogue = await catalogueIn(tx);
    const target = await tx.policyGroup.findUnique({ where: { key: input.key }, select: { archivedAt: true } });
    if (!target) return refuse("NOT_FOUND", `Policy group "${input.key.slice(0, 64)}" does not exist.`);
    if (target.archivedAt) return refuse("NOT_EDITABLE", "An archived group cannot be the default.");
    if (!catalogue.groups[input.key]?.valid) return refuse("VALIDATION", "The group's stored definition is invalid; it cannot be the default.");
    const previous = catalogue.defaultKey;
    if (previous !== input.expectedDefaultKey) return refuse("CONFLICT", `The default changed since you opened it (now ${previous}) — reload and review again.`);
    if (previous === input.key) return refuse("VALIDATION", "The group is already the default.");
    await tx.policyGroup.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    // REVIEW FIX 4 — only a NON-ARCHIVED row may become the default; a concurrent
    // archive makes this 0 rows ⇒ CONFLICT and the unset above rolls back.
    const set = await tx.policyGroup.updateMany({ where: { key: input.key, archivedAt: null }, data: { isDefault: true } });
    if (set.count !== 1) throw new RefusalRollback(refuse("CONFLICT", "The group changed (it may have been archived) — reload and review again."));
    await audit(tx, input.actor, AuditAction.POLICY_GROUP_DEFAULT_CHANGED, input.key, input.reason,
      { before: { defaultPolicyGroup: previous }, after: { defaultPolicyGroup: input.key } },
      { previousDefault: previous, appliesTo: "NEW_REGISTRATIONS_ONLY", assignmentsChanged: 0 });
    return { ok: true as const, value: { key: input.key, previousDefault: previous } };
  });
}
