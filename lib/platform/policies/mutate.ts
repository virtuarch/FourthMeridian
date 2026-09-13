/**
 * lib/platform/policies/mutate.ts  (PLATFORM OPS POLICIES — Slice 2)
 *
 * THE ONE MUTATION SERVICE FOR DECLARED OPERATIONAL POLICY.
 *
 * The route and the widget never touch PlatformSetting. Everything a policy
 * change needs happens here, in this order, and nowhere else:
 *
 *   1. CLOSED KEY CONTRACT   only the two financial-refresh cadences are
 *                            mutable through this service (EDITABLE_POLICIES).
 *                            Maintenance, ingestion, product status, security
 *                            settings and alert families are NOT reachable,
 *                            whatever their descriptor says.
 *   2. DESCRIPTOR VALIDATION the canonical rule (lib/platform-settings.ts):
 *                            enum membership AND scheduler honourability,
 *                            derived from the registry. An unhonourable value
 *                            is refused, never stored and degraded.
 *   3. OPTIMISTIC CONCURRENCY the caller states what it observed —
 *                            `expectedUpdatedAt` (the row's version token) or
 *                            null for "no override". A row that moved, appeared
 *                            or vanished since ⇒ CONFLICT, nothing written.
 *   4. ONE TRANSACTION       the setting mutation and its canonical audit row
 *                            commit together or not at all.
 *   5. THE CANONICAL RESULT  the caller gets the Policies read model reloaded —
 *                            there is no second representation of policy.
 *
 * ⚠️ POLICY MUTATION CHANGES POLICY ONLY. No refresh, no job, no provider, no
 * AI call. Existing consumers (source health, Connections, the Brief watermark,
 * the wallet sweep's due filter, job health) observe the new row on their next
 * read — the deterministic invalidation chain f54a62b measured.
 *
 * ⚠️ RESET IS DELETE. The override row is removed; the code default is in force
 * with origin DEFAULT, and a future default change propagates. The default is
 * never written as if it had been configured.
 */

import "server-only";
import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { buildAuditData } from "@/lib/audit";
import {
  PlatformSettingValidationError, createSettingIfAbsent, deleteSettingIfVersion, updateSettingIfVersion,
  validateSetting, type PlatformSettingKeyType,
} from "@/lib/platform-settings";
import {
  REFRESH_CADENCE_SETTING_KEY, resolveRefreshPolicy,
  type RefreshPolicy, type RefreshSourceKind,
} from "@/lib/platform/refresh-policy.core";
import { loadRefreshPoliciesReadModel, type RefreshPoliciesReadModel } from "./refresh-policies";

// ── The closed contract ───────────────────────────────────────────────────────

/** The only policies this service mutates. Extending it is a product decision, not a descriptor lookup. */
export const EDITABLE_POLICIES: Readonly<Record<RefreshSourceKind, PlatformSettingKeyType>> = {
  BANK:   REFRESH_CADENCE_SETTING_KEY.BANK,
  WALLET: REFRESH_CADENCE_SETTING_KEY.WALLET,
};

export function isEditableSourceKind(v: unknown): v is RefreshSourceKind {
  return v === "BANK" || v === "WALLET";
}

// ── Inputs / outputs ──────────────────────────────────────────────────────────

/** Who is acting. `id` is the canonical identity (User.id); the rest is forensic context. */
export interface PolicyActor {
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface UpdateRefreshCadenceInput {
  sourceKind: RefreshSourceKind;
  /** The desired cadence, as the operator submitted it. Validated here. */
  cadence: unknown;
  /** The override's updatedAt the caller observed (ISO), or null when it observed NO override. */
  expectedUpdatedAt: string | null;
  actor: PolicyActor;
}

export interface ResetRefreshCadenceInput {
  sourceKind: RefreshSourceKind;
  /** The override's updatedAt the caller observed (ISO). Reset requires an observed override. */
  expectedUpdatedAt: string;
  actor: PolicyActor;
}

export type PolicyMutationResult =
  | { ok: true; model: RefreshPoliciesReadModel }
  | { ok: false; code: "VALIDATION" | "CONFLICT" | "NOT_FOUND"; reason: string; model: RefreshPoliciesReadModel };

type Client = Pick<PrismaClient, "$transaction" | "platformSetting" | "auditLog" | "jobRun" | "user">;

/** Thrown inside the transaction to abort it without writing anything. */
class PolicyConflict extends Error {
  constructor(reason: string) { super(reason); this.name = "PolicyConflict"; }
}

// ── Audit facts ───────────────────────────────────────────────────────────────

interface PolicyFacts {
  raw: string | null;
  origin: RefreshPolicy["origin"];
  cadence: RefreshPolicy["cadence"];
  overdueAfterHours: number;
  updatedAt: string | null;
}

function factsOf(sourceKind: RefreshSourceKind, row: { value: string; updatedAt: Date } | null): PolicyFacts {
  const p = resolveRefreshPolicy({ sourceKind }, row);
  return {
    raw: row?.value ?? null,
    origin: p.origin,
    cadence: p.cadence,
    overdueAfterHours: p.overdueAfterHours,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/** Compare the caller's token with the row: same instant to the millisecond, or both absent. */
function versionMatches(expected: string | null, row: { updatedAt: Date } | null): boolean {
  if (expected === null) return row === null;
  if (row === null) return false;
  const t = Date.parse(expected);
  return Number.isFinite(t) && t === row.updatedAt.getTime();
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateRefreshCadence(
  input: UpdateRefreshCadenceInput,
  client: Client = db,
  now: Date = new Date(),
): Promise<PolicyMutationResult> {
  const key = EDITABLE_POLICIES[input.sourceKind];

  // 2. Descriptor validation — enum AND scheduler honourability, refused BEFORE
  //    any transaction. Reloading the model gives the caller the capability the
  //    refusal was judged against.
  const v = validateSetting(key, input.cadence);
  if (!v.ok) {
    return { ok: false, code: "VALIDATION", reason: v.reason, model: await loadRefreshPoliciesReadModel(client, now) };
  }
  const cadence = v.value;

  try {
    await client.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });

      // 3. The caller's observation must still hold.
      if (!versionMatches(input.expectedUpdatedAt, before)) {
        throw new PolicyConflict(before
          ? "This policy changed since you opened the editor."
          : "This policy's override was reset since you opened the editor.");
      }

      // 4a. The conditional write — predicated on the version, so a change that
      //     lands between the read above and this write is refused too.
      const written = before
        ? await updateSettingIfVersion(tx, key, cadence, before.updatedAt, input.actor.id)
        : await createSettingIfAbsent(tx, key, cadence, input.actor.id);
      if (!written) throw new PolicyConflict("This policy changed while your change was being saved.");

      const after = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });

      // 4b. The canonical audit row, in the same transaction.
      await tx.auditLog.create({
        data: buildAuditData({
          actorId: input.actor.id,
          actorType: "PLATFORM_OPERATOR",
          action: AuditAction.PLATFORM_POLICY_CHANGED,
          result: "SUCCESS",
          target: { type: "platform-setting", id: key },
          metadata: { key, sourceKind: input.sourceKind, previous: factsOf(input.sourceKind, before), next: factsOf(input.sourceKind, after) },
          performedByAdminId: input.actor.id,
          ipAddress: input.actor.ipAddress ?? null,
          userAgent: input.actor.userAgent ?? null,
        }),
      });
    });
  } catch (err) {
    if (err instanceof PolicyConflict) {
      return { ok: false, code: "CONFLICT", reason: err.message, model: await loadRefreshPoliciesReadModel(client, now) };
    }
    if (err instanceof PlatformSettingValidationError) {
      return { ok: false, code: "VALIDATION", reason: err.reason, model: await loadRefreshPoliciesReadModel(client, now) };
    }
    throw err;
  }

  // 5. The canonical result.
  return { ok: true, model: await loadRefreshPoliciesReadModel(client, now) };
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export async function resetRefreshCadence(
  input: ResetRefreshCadenceInput,
  client: Client = db,
  now: Date = new Date(),
): Promise<PolicyMutationResult> {
  const key = EDITABLE_POLICIES[input.sourceKind];

  try {
    await client.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });
      if (!before) throw new PolicyConflict("There is no override to reset; the default is already in force.");
      if (!versionMatches(input.expectedUpdatedAt, before)) {
        throw new PolicyConflict("This policy changed since you opened the editor.");
      }

      const deleted = await deleteSettingIfVersion(tx, key, before.updatedAt);
      if (!deleted) throw new PolicyConflict("This policy changed while the reset was being saved.");

      await tx.auditLog.create({
        data: buildAuditData({
          actorId: input.actor.id,
          actorType: "PLATFORM_OPERATOR",
          action: AuditAction.PLATFORM_POLICY_RESET,
          result: "SUCCESS",
          target: { type: "platform-setting", id: key },
          metadata: { key, sourceKind: input.sourceKind, previous: factsOf(input.sourceKind, before), next: factsOf(input.sourceKind, null) },
          performedByAdminId: input.actor.id,
          ipAddress: input.actor.ipAddress ?? null,
          userAgent: input.actor.userAgent ?? null,
        }),
      });
    });
  } catch (err) {
    if (err instanceof PolicyConflict) {
      return { ok: false, code: "CONFLICT", reason: err.message, model: await loadRefreshPoliciesReadModel(client, now) };
    }
    throw err;
  }

  return { ok: true, model: await loadRefreshPoliciesReadModel(client, now) };
}
