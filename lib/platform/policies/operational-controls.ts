/**
 * lib/platform/policies/operational-controls.ts  (PLATFORM OPS — Operational Controls: read model + mutation service)
 *
 * THE ONE READ AND THE ONE WRITE PATH FOR MAINTENANCE MODE. Until this module
 * the `maintenance_mode` row had a descriptor (writeSurfaces PLATFORM_OPS,
 * writeCapability CONTROL) but no writer: the admin security route refuses it
 * by design, the refresh-policies route is closed to source kinds, and the Job
 * Health button ships inert — so Release 1 set and cleared it by hand in SQL.
 * The route (app/api/platform/platform-ops/operational-controls) and the panel
 * never touch PlatformSetting; everything a change needs happens here, in the
 * lib/platform/policies/mutate.ts / lib/platform/ai/cost-controls.ts order:
 *
 *   1. CLOSED CONTRACT       the body names an ACTION (ENABLE / DISABLE / RESET),
 *                            never a setting key; only `maintenance_mode` is
 *                            reachable. The AI kill switch and ingestion pause
 *                            are read, never written.
 *   2. REASON                a structured reason (lib/audit.ts) AND a non-empty
 *                            operator note — maintenance stops the platform.
 *   3. OPTIMISTIC CONCURRENCY the caller states the row version it observed
 *                            (`expectedUpdatedAt`, null for "no row"). A row that
 *                            moved ⇒ CONFLICT and NOTHING is written.
 *   4. ONE TRANSACTION       the conditional write (descriptor-validated by the
 *                            registry primitives) and its operator-action audit
 *                            row (PLATFORM_POLICY_CHANGED / _RESET: actor, before,
 *                            after, reason, result) commit together or not at all.
 *                            A refused attempt (conflict / nothing to reset) is
 *                            audited REFUSED after the rollback.
 *   5. THE CANONICAL RESULT  the reloaded read model.
 *
 * ABSENT ≠ FALSE. ENABLE writes "true", DISABLE writes "false" (an explicit
 * row), RESET deletes the row (Not configured — the never-configured state).
 * Both "false" and no row admit work; the distinction is provenance.
 *
 * ⚠️ NO LOCKOUT. Maintenance denies exactly the admission work classes the
 * policy declares (refresh execution, connection establishment, paid AI).
 * Authentication, platform access, this route, audit and health never consult
 * admission, so an operator can always reach the panel and turn it back off.
 * ⚠️ A CHANGE CHANGES THE ROW ONLY — no job, no provider, no AI call. Every
 * consumer reads the row per decision (uncached); in-flight work finishes.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { deploymentEnvironment } from "@/lib/env";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionWriteClient, type OperatorReason } from "@/lib/audit";
import {
  PlatformSettingKey, PlatformSettingValidationError, createSettingIfAbsent, deleteSettingIfVersion, updateSettingIfVersion,
  type SettingWriteClient,
} from "@/lib/platform-settings";
import { readFactState, workDeniedBy } from "@/lib/platform/admission/policy-core";
import { CONTROL_PLANE_KEYS } from "@/lib/platform/admission/facts";
import {
  MAINTENANCE_ACTIONS,
  type DeploymentEnvironmentName, type FlagView, type MaintenanceAction, type OperationalControlsMutationCode, type OperationalControlsReadModel,
} from "./operational-controls.types";

const MAINTENANCE_KEY = CONTROL_PLANE_KEYS.maintenanceMode;
const KILL_SWITCH_KEY = PlatformSettingKey.AI_PAID_REQUESTS_PAUSED;
const INGESTION_KEY = CONTROL_PLANE_KEYS.ingestionPaused;
const READ_KEYS = [MAINTENANCE_KEY, KILL_SWITCH_KEY, INGESTION_KEY];

// ── Read model ────────────────────────────────────────────────────────────────

interface SettingRow { key: string; value: string; updatedAt: Date; updatedById: string | null }

/** The narrow shapes the loader calls — satisfied by systemDb or a test fake. */
export interface OperationalControlsReadClient {
  platformSetting: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true; updatedAt: true; updatedById: true } }): Promise<SettingRow[]>;
  };
  user: {
    findMany(args: { where: { id: { in: string[] } }; select: { id: true; name: true } }): Promise<{ id: string; name: string | null }[]>;
  };
}

/** PURE — one row as the panel sees it, in the admission module's own state words. */
export function flagViewOf(key: string, row: SettingRow | null, writerName: string | null): FlagView {
  const fact = readFactState(key, row?.value ?? null);
  return {
    key,
    state: fact.state === "UNAVAILABLE" ? "INVALID" : fact.state,
    invalidRaw: fact.state === "INVALID" ? row?.value ?? null : null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row ? writerName : null,
  };
}

export async function loadOperationalControlsReadModel(
  client: OperationalControlsReadClient = systemDb as unknown as OperationalControlsReadClient,
  environment: DeploymentEnvironmentName = deploymentEnvironment(),
  now: Date = new Date(),
): Promise<OperationalControlsReadModel> {
  const rows = await client.platformSetting.findMany({
    where: { key: { in: READ_KEYS } },
    select: { key: true, value: true, updatedAt: true, updatedById: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const m = byKey.get(MAINTENANCE_KEY) ?? null;
  let writer: string | null = null;
  if (m?.updatedById) {
    // The refresh-policies idiom: a display NAME, never an email.
    const users = await client.user.findMany({ where: { id: { in: [m.updatedById] } }, select: { id: true, name: true } });
    writer = users[0]?.name ?? null;
  }
  const kill = flagViewOf(KILL_SWITCH_KEY, byKey.get(KILL_SWITCH_KEY) ?? null, null);
  const ingestion = flagViewOf(INGESTION_KEY, byKey.get(INGESTION_KEY) ?? null, null);
  return {
    checkedAt: now.toISOString(),
    environment,
    maintenance: { ...flagViewOf(MAINTENANCE_KEY, m, writer), blocks: workDeniedBy("maintenanceMode") },
    related: {
      aiKillSwitch: { key: kill.key, state: kill.state },
      ingestionPaused: { key: ingestion.key, state: ingestion.state },
    },
  };
}

// ── Validation (pure) ─────────────────────────────────────────────────────────

export type ValidatedMaintenanceChange =
  | { ok: true; action: MaintenanceAction; expectedUpdatedAt: string | null }
  | { ok: false; reason: string };

/** PURE — the closed body: an action and the version observed. Nothing else is accepted. */
export function validateMaintenanceChange(raw: unknown): ValidatedMaintenanceChange {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "Body must be { action, expectedUpdatedAt, reason }." };
  const { action, expectedUpdatedAt } = raw as { action?: unknown; expectedUpdatedAt?: unknown };
  if (typeof action !== "string" || !(MAINTENANCE_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, reason: `action must be one of ${MAINTENANCE_ACTIONS.join(", ")}.` };
  }
  if (expectedUpdatedAt !== null && (typeof expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(expectedUpdatedAt)))) {
    return { ok: false, reason: "expectedUpdatedAt must be the version you read (an ISO timestamp) or null for no row." };
  }
  return { ok: true, action: action as MaintenanceAction, expectedUpdatedAt: expectedUpdatedAt as string | null };
}

/** The stored value each write action produces. RESET has none — it deletes. */
const STORED: Record<Exclude<MaintenanceAction, "RESET">, "true" | "false"> = { ENABLE: "true", DISABLE: "false" };

// ── Mutation ──────────────────────────────────────────────────────────────────

export interface OperationalControlsActor { id: string; ipAddress?: string | null; userAgent?: string | null }

export type OperationalControlsTx = SettingWriteClient & OperatorActionWriteClient;
export interface OperationalControlsClient extends OperationalControlsReadClient, OperatorActionWriteClient {
  $transaction<T>(fn: (tx: OperationalControlsTx) => Promise<T>): Promise<T>;
}

export type OperationalControlsMutationResult =
  | { ok: true; model: OperationalControlsReadModel }
  | { ok: false; code: OperationalControlsMutationCode; reason: string; model: OperationalControlsReadModel };

export interface ApplyMaintenanceChangeInput {
  /** The raw PATCH body minus the reason — validated here. */
  change: unknown;
  reason: OperatorReason;
  actor: OperationalControlsActor;
}

class Refusal extends Error {
  constructor(readonly code: "CONFLICT" | "NOT_FOUND", reason: string) { super(reason); this.name = "MaintenanceRefusal"; }
}

function versionMatches(expected: string | null, row: { updatedAt: Date } | null): boolean {
  if (expected === null) return row === null;
  if (row === null) return false;
  return Date.parse(expected) === row.updatedAt.getTime();
}

/** Audit facts: the stored value (null = no row) and its admission state word. Never anything else. */
function facts(row: { value: string } | null) {
  return { value: row ? row.value : null, state: readFactState(MAINTENANCE_KEY, row?.value ?? null).state };
}

const NO_CHANGE: Record<MaintenanceAction, string> = {
  ENABLE: "Maintenance is already enabled.",
  DISABLE: "Maintenance is already disabled.",
  RESET: "Maintenance is already not configured; there is no row to reset.",
};

/**
 * Apply one maintenance change: ONE transaction, one audit row. Refusals come
 * back with the canonical model (the route maps VALIDATION → 400,
 * CONFLICT → 409, NOT_FOUND → 404); a conflict or nothing-to-reset is audited
 * REFUSED once the transaction has rolled back.
 */
export async function applyMaintenanceChange(
  input: ApplyMaintenanceChangeInput,
  client: OperationalControlsClient = systemDb as unknown as OperationalControlsClient,
  environment: DeploymentEnvironmentName = deploymentEnvironment(),
  now: Date = new Date(),
): Promise<OperationalControlsMutationResult> {
  const reload = () => loadOperationalControlsReadModel(client, environment, now);
  const v = validateMaintenanceChange(input.change);
  if (!v.ok) return { ok: false, code: "VALIDATION", reason: v.reason, model: await reload() };
  if (!input.reason?.note || input.reason.note.trim() === "") {
    return { ok: false, code: "VALIDATION", reason: "Maintenance changes need a reason note describing why.", model: await reload() };
  }
  const audit = { userId: input.actor.id, via: "PLATFORM_GRANT" as const, area: "PLATFORM_OPS" };
  const detail = { control: "maintenance", action: v.action, settingKey: MAINTENANCE_KEY, environment };
  let observed: { value: string } | null = null;

  try {
    await client.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key: MAINTENANCE_KEY }, select: { value: true, updatedAt: true } });
      observed = before;
      if (!versionMatches(v.expectedUpdatedAt, before)) {
        throw new Refusal("CONFLICT", before ? "Maintenance mode changed since you loaded it. Review the current state and try again." : "Maintenance mode was reset since you loaded it. Review the current state and try again.");
      }

      if (v.action === "RESET") {
        if (!before) throw new Refusal("NOT_FOUND", NO_CHANGE.RESET);
        const deleted = await deleteSettingIfVersion(tx, MAINTENANCE_KEY, before.updatedAt);
        if (!deleted) throw new Refusal("CONFLICT", "Maintenance mode changed while the reset was being saved.");
        await recordOperatorAction(tx, {
          actor: audit, action: AuditAction.PLATFORM_POLICY_RESET, target: { kind: "PLATFORM_SETTING", id: MAINTENANCE_KEY },
          reason: input.reason, change: { before: facts(before), after: facts(null) }, detail, result: "SUCCESS",
          ipAddress: input.actor.ipAddress ?? null, userAgent: input.actor.userAgent ?? null,
        });
        return;
      }

      const stored = STORED[v.action];
      if (before?.value === stored) throw new Refusal("CONFLICT", NO_CHANGE[v.action]);
      const written = before
        ? await updateSettingIfVersion(tx, MAINTENANCE_KEY, stored, before.updatedAt, input.actor.id)
        : await createSettingIfAbsent(tx, MAINTENANCE_KEY, stored, input.actor.id);
      if (!written) throw new Refusal("CONFLICT", "Maintenance mode changed while your change was being saved.");
      const after = await tx.platformSetting.findUnique({ where: { key: MAINTENANCE_KEY }, select: { value: true, updatedAt: true } });
      if (after?.value !== stored) throw new Refusal("CONFLICT", "Maintenance mode did not read back as written; nothing was saved.");
      await recordOperatorAction(tx, {
        actor: audit, action: AuditAction.PLATFORM_POLICY_CHANGED, target: { kind: "PLATFORM_SETTING", id: MAINTENANCE_KEY },
        reason: input.reason, change: { before: facts(before), after: facts(after) }, detail, result: "SUCCESS",
        ipAddress: input.actor.ipAddress ?? null, userAgent: input.actor.userAgent ?? null,
      });
    });
  } catch (err) {
    if (err instanceof Refusal) {
      // The attempt is a fact too: audited REFUSED, outside the rolled-back transaction.
      await recordOperatorAction(client, {
        actor: audit, action: v.action === "RESET" ? AuditAction.PLATFORM_POLICY_RESET : AuditAction.PLATFORM_POLICY_CHANGED,
        target: { kind: "PLATFORM_SETTING", id: MAINTENANCE_KEY },
        reason: input.reason, change: { before: facts(observed), after: facts(observed) }, detail: { ...detail, refusal: err.code },
        result: "REFUSED", ipAddress: input.actor.ipAddress ?? null, userAgent: input.actor.userAgent ?? null,
      });
      return { ok: false, code: err.code, reason: err.message, model: await reload() };
    }
    if (err instanceof PlatformSettingValidationError) return { ok: false, code: "VALIDATION", reason: err.reason, model: await reload() };
    throw err;
  }

  return { ok: true, model: await reload() };
}
