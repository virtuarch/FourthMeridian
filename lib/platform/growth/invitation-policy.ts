/**
 * lib/platform/growth/invitation-policy.ts  (PR B · configurable invitation validity)
 *
 * THE ONE READER AND WRITER of `beta_invitation_validity_days`.
 *
 *   readInvitationPolicy        the read model Growth shows (and the issuance
 *                               module's source of the default validity).
 *   updateInvitationValidity    validated (1–30, refused — never clamped),
 *                               optimistic on the row's updatedAt (a stale
 *                               version ⇒ CONFLICT, nothing written), and the
 *                               setting write + its BETA_INVITATION_VALIDITY_CHANGED
 *                               audit row (reason required, before/after) commit in
 *                               ONE transaction — the policies/mutate.ts pattern.
 *
 * ⚠️ IT CHANGES POLICY ONLY. No invitation row is read or written here: an
 * invitation already issued keeps the expiry it was issued with. Moving one of
 * those is the explicit, audited Extend (invitation-issue.ts extendBetaInvitation).
 *
 * The client is a PARAMETER (authority follows the caller; no owner default).
 */

import "server-only";
import type { PrismaClient } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import {
  PlatformSettingKey, PlatformSettingValidationError, createSettingIfAbsent, updateSettingIfVersion,
} from "@/lib/platform-settings";
import {
  INVITATION_VALIDITY_DEFAULT_DAYS, INVITATION_VALIDITY_MAX_DAYS, INVITATION_VALIDITY_MIN_DAYS,
  parseValidityDays, validityFromSettingValue, versionMatches, type InvitationPolicyReadModel,
} from "./invitation-issue.core";

export type { InvitationPolicyReadModel } from "./invitation-issue.core";

const KEY = PlatformSettingKey.BETA_INVITATION_VALIDITY_DAYS;

type ReadClient = Pick<PrismaClient, "platformSetting">;
type WriteClient = Pick<PrismaClient, "$transaction" | "platformSetting" | "auditLog">;

function modelOf(row: { value: string; updatedAt: Date } | null): InvitationPolicyReadModel {
  return {
    validityDays: validityFromSettingValue(row?.value),
    min: INVITATION_VALIDITY_MIN_DAYS,
    max: INVITATION_VALIDITY_MAX_DAYS,
    default: INVITATION_VALIDITY_DEFAULT_DAYS,
    version: row ? row.updatedAt.toISOString() : null,
    origin: row && parseValidityDays(row.value).ok ? "CONFIGURED" : "DEFAULT",
  };
}

export async function readInvitationPolicy(client: ReadClient): Promise<InvitationPolicyReadModel> {
  const row = await client.platformSetting.findUnique({ where: { key: KEY }, select: { value: true, updatedAt: true } });
  return modelOf(row);
}

export interface UpdateInvitationValidityInput {
  /** The desired validity as submitted — validated here. */
  validityDays: unknown;
  /** The version (ISO updatedAt) the caller observed, or null when it observed no row. */
  expectedVersion: string | null;
  reason: OperatorReason;
  actor: OperatorActionInput["actor"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type InvitationPolicyMutationResult =
  | { ok: true; model: InvitationPolicyReadModel }
  | { ok: false; code: "VALIDATION" | "CONFLICT"; reason: string; model: InvitationPolicyReadModel };

class PolicyConflict extends Error {
  constructor(reason: string) { super(reason); this.name = "PolicyConflict"; }
}

export async function updateInvitationValidity(
  client: WriteClient,
  input: UpdateInvitationValidityInput,
): Promise<InvitationPolicyMutationResult> {
  const parsed = parseValidityDays(input.validityDays);
  if (!parsed.ok) return { ok: false, code: "VALIDATION", reason: parsed.reason, model: await readInvitationPolicy(client) };
  const value = String(parsed.days);

  try {
    const model = await client.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key: KEY }, select: { value: true, updatedAt: true } });
      if (!versionMatches(input.expectedVersion, before)) {
        throw new PolicyConflict("The invitation validity changed since you loaded it.");
      }
      // Conditional on the observed version, so a change landing between the
      // read above and this write is refused too (createSettingIfAbsent: P2002).
      const written = before
        ? await updateSettingIfVersion(tx, KEY, value, before.updatedAt, input.actor.userId)
        : await createSettingIfAbsent(tx, KEY, value, input.actor.userId);
      if (!written) throw new PolicyConflict("The invitation validity changed while your change was being saved.");

      const after = await tx.platformSetting.findUnique({ where: { key: KEY }, select: { value: true, updatedAt: true } });
      const prev = modelOf(before);
      const next = modelOf(after);
      await recordOperatorAction(tx, {
        actor: input.actor,
        action: AuditAction.BETA_INVITATION_VALIDITY_CHANGED,
        target: { kind: "PLATFORM_SETTING", id: KEY },
        reason: input.reason,
        change: {
          before: { validityDays: prev.validityDays, origin: prev.origin, version: prev.version },
          after:  { validityDays: next.validityDays, origin: next.origin, version: next.version },
        },
        result: "SUCCESS",
        detail: { key: KEY, previous: prev.validityDays, new: next.validityDays },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });
      return next;
    });
    return { ok: true, model };
  } catch (err) {
    if (err instanceof PolicyConflict) {
      return { ok: false, code: "CONFLICT", reason: err.message, model: await readInvitationPolicy(client) };
    }
    if (err instanceof PlatformSettingValidationError) {
      return { ok: false, code: "VALIDATION", reason: err.reason, model: await readInvitationPolicy(client) };
    }
    throw err;
  }
}
