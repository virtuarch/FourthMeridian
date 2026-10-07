/**
 * lib/platform/policies/job-cadence.ts  (P1 HUMAN OPERABILITY — execution cadence)
 *
 * THE READ MODEL AND THE MUTATION SERVICE FOR PER-JOB EXECUTION CADENCE.
 *
 * Mirrors lib/platform/policies/mutate.ts for the editable job cadences
 * (fetch-fx-rates, fetch-security-prices, evaluate-alerts): descriptor
 * validation (integer within the registry's code-owned min/max), optimistic
 * concurrency on the row's updatedAt, ONE transaction holding the setting write
 * and its audit, reset = delete. Two deliberate differences from the refresh
 * cadence path:
 *
 *   • the audit is the P1 OPERATOR-ACTION envelope (recordOperatorAction) with
 *     a REQUIRED structured reason — JOB_CADENCE_CHANGED / JOB_CADENCE_RESET
 *     are reason-required by lib/audit.ts, so a cadence change can never
 *     commit without saying why;
 *   • the read model lists EVERY registered job — the refresh-policy-governed,
 *     the fixed and the continuation entries included — each with its cadence,
 *     origin, bounds, last run and next due, so the operator sees the whole
 *     execution policy, not only the knobs.
 *
 * ⚠️ A CADENCE CHANGE CHANGES CADENCE ONLY. No job runs because of it; the
 * dispatcher applies the new figure at its next wake.
 */

import "server-only";
import type { PrismaClient } from "@prisma/client";
// fm_system, never the migration principal: the service is an OPERATOR write path
// (CONTROL-gated) and reads/writes PlatformSetting + AuditLog, both of which
// fm_system holds. Defaulting to `db` would grow the db-authority ratchet.
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorReason } from "@/lib/audit";
import {
  PlatformSettingValidationError, createSettingIfAbsent, deleteSettingIfVersion, isPlatformSettingKey,
  updateSettingIfVersion, validateSetting,
} from "@/lib/platform-settings";
import { SCHEDULED_JOB_FACTS, type ScheduledJobFacts } from "@/lib/jobs/registry.core";
import { loadJobCadencePolicies, type JobCadencePolicy } from "@/lib/jobs/cadence-policy";
import { WAKE_EVERY_MINUTES, jobCadenceSettingKey, nextDueAt } from "@/lib/jobs/cadence-policy.core";

// ── Read model ────────────────────────────────────────────────────────────────

export interface JobCadenceView {
  job: string;
  hours: number;
  origin: JobCadencePolicy["origin"];
  defaultHours: number;
  minHours: number;
  maxHours: number;
  editable: boolean;
  /** The setting that governs it (its own key, or the refresh-cadence key), or null. */
  settingKey: string | null;
  primary: string | null;
  note: string;
  /** The override row's version token (ISO) when the job has its own row; null otherwise. */
  updatedAt: string | null;
  lastStartedAt: string | null;
  lastStatus: string | null;
  /** lastStart + cadence − tolerance; null when the job never ran (due at the next wake). */
  nextDueAt: string | null;
}

export interface JobCadenceReadModel {
  checkedAt: string;
  wakeEveryMinutes: number;
  jobs: JobCadenceView[];
}

type ReadClient = Pick<PrismaClient, "platformSetting" | "jobRun">;

export async function loadJobCadenceReadModel(
  client: ReadClient = systemDb,
  now: Date = new Date(),
  jobs: readonly ScheduledJobFacts[] = SCHEDULED_JOB_FACTS,
): Promise<JobCadenceReadModel> {
  const policies = await loadJobCadencePolicies(client, jobs);
  const keys = jobs.map(jobCadenceSettingKey).filter((k): k is string => k !== null);
  const rows = keys.length > 0
    ? await client.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, updatedAt: true } })
    : [];
  const versionByKey = new Map(rows.map((r) => [r.key, r.updatedAt.toISOString()]));
  const newest = await client.jobRun.findMany({
    where: { jobName: { in: jobs.map((j) => j.name) } },
    orderBy: { startedAt: "desc" },
    distinct: ["jobName"],
    select: { jobName: true, startedAt: true, status: true },
  });
  const lastByJob = new Map(newest.map((r) => [r.jobName, r]));

  return {
    checkedAt: now.toISOString(),
    wakeEveryMinutes: WAKE_EVERY_MINUTES,
    jobs: jobs.map((job) => {
      const p = policies.get(job.name)!;
      const last = lastByJob.get(job.name) ?? null;
      const own = jobCadenceSettingKey(job);
      return {
        job: job.name, hours: p.hours, origin: p.origin, defaultHours: p.defaultHours, minHours: p.minHours, maxHours: p.maxHours,
        editable: p.editable, settingKey: p.settingKey, primary: p.primary, note: p.note,
        updatedAt: own ? versionByKey.get(own) ?? null : null,
        lastStartedAt: last?.startedAt.toISOString() ?? null,
        lastStatus: last?.status ?? null,
        nextDueAt: job.continuationOf ? null
          : nextDueAt(last ? { lastStartedAt: last.startedAt, lastStatus: last.status } : null, p)?.toISOString() ?? null,
      };
    }),
  };
}

// ── Mutation ──────────────────────────────────────────────────────────────────

export interface CadenceActor {
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface UpdateJobCadenceInput {
  job: string;
  /** Hours between runs, as submitted. Validated against the descriptor. */
  hours: unknown;
  /** The override's updatedAt the caller observed (ISO), or null for "no override". */
  expectedUpdatedAt: string | null;
  reason: OperatorReason;
  actor: CadenceActor;
}

export interface ResetJobCadenceInput {
  job: string;
  expectedUpdatedAt: string;
  reason: OperatorReason;
  actor: CadenceActor;
}

export type JobCadenceMutationResult =
  | { ok: true; model: JobCadenceReadModel }
  | { ok: false; code: "VALIDATION" | "CONFLICT" | "NOT_EDITABLE"; reason: string; model: JobCadenceReadModel };

type Client = Pick<PrismaClient, "$transaction" | "platformSetting" | "auditLog" | "jobRun">;

class CadenceConflict extends Error {
  constructor(reason: string) { super(reason); this.name = "CadenceConflict"; }
}

/** The editable registry entry for a job name, or null. */
export function editableJob(job: unknown, jobs: readonly ScheduledJobFacts[] = SCHEDULED_JOB_FACTS): ScheduledJobFacts | null {
  const j = jobs.find((x) => x.name === job);
  return j && jobCadenceSettingKey(j) ? j : null;
}

function versionMatches(expected: string | null, row: { updatedAt: Date } | null): boolean {
  if (expected === null) return row === null;
  if (row === null) return false;
  const t = Date.parse(expected);
  return Number.isFinite(t) && t === row.updatedAt.getTime();
}

export async function updateJobCadence(
  input: UpdateJobCadenceInput,
  client: Client = systemDb,
  now: Date = new Date(),
): Promise<JobCadenceMutationResult> {
  const job = editableJob(input.job);
  if (!job) return { ok: false, code: "NOT_EDITABLE", reason: "This job's cadence is not editable here.", model: await loadJobCadenceReadModel(client, now) };
  const key = jobCadenceSettingKey(job)!;
  if (!isPlatformSettingKey(key)) throw new Error(`[job-cadence] ${key} is not a registered setting`);

  const v = validateSetting(key, typeof input.hours === "number" ? String(input.hours) : input.hours);
  if (!v.ok) return { ok: false, code: "VALIDATION", reason: v.reason, model: await loadJobCadenceReadModel(client, now) };
  const hours = v.value;

  try {
    await client.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });
      if (!versionMatches(input.expectedUpdatedAt, before)) {
        throw new CadenceConflict(before ? "This cadence changed since you opened the editor." : "This cadence's override was reset since you opened the editor.");
      }
      const written = before
        ? await updateSettingIfVersion(tx, key, hours, before.updatedAt, input.actor.id)
        : await createSettingIfAbsent(tx, key, hours, input.actor.id);
      if (!written) throw new CadenceConflict("This cadence changed while your change was being saved.");
      const after = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });

      await recordOperatorAction(tx, {
        actor: { userId: input.actor.id, via: "PLATFORM_GRANT", area: "PLATFORM_OPS" },
        action: AuditAction.JOB_CADENCE_CHANGED,
        target: { kind: "JOB", id: job.name },
        reason: input.reason,
        change: {
          before: { hours: before ? Number(before.value) : null, origin: before ? "SETTING" : "DEFAULT", updatedAt: before?.updatedAt.toISOString() ?? null },
          after:  { hours: Number(hours), origin: "SETTING", updatedAt: after?.updatedAt.toISOString() ?? null },
        },
        detail: { settingKey: key },
        result: "SUCCESS",
        ipAddress: input.actor.ipAddress ?? null,
        userAgent: input.actor.userAgent ?? null,
      });
    });
  } catch (err) {
    if (err instanceof CadenceConflict) return { ok: false, code: "CONFLICT", reason: err.message, model: await loadJobCadenceReadModel(client, now) };
    if (err instanceof PlatformSettingValidationError) return { ok: false, code: "VALIDATION", reason: err.reason, model: await loadJobCadenceReadModel(client, now) };
    throw err;
  }
  return { ok: true, model: await loadJobCadenceReadModel(client, now) };
}

export async function resetJobCadence(
  input: ResetJobCadenceInput,
  client: Client = systemDb,
  now: Date = new Date(),
): Promise<JobCadenceMutationResult> {
  const job = editableJob(input.job);
  if (!job) return { ok: false, code: "NOT_EDITABLE", reason: "This job's cadence is not editable here.", model: await loadJobCadenceReadModel(client, now) };
  const key = jobCadenceSettingKey(job)!;
  if (!isPlatformSettingKey(key)) throw new Error(`[job-cadence] ${key} is not a registered setting`);

  try {
    await client.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });
      if (!before) throw new CadenceConflict("There is no override to reset; the default is already in force.");
      if (!versionMatches(input.expectedUpdatedAt, before)) throw new CadenceConflict("This cadence changed since you opened the editor.");
      const deleted = await deleteSettingIfVersion(tx, key, before.updatedAt);
      if (!deleted) throw new CadenceConflict("This cadence changed while the reset was being saved.");

      await recordOperatorAction(tx, {
        actor: { userId: input.actor.id, via: "PLATFORM_GRANT", area: "PLATFORM_OPS" },
        action: AuditAction.JOB_CADENCE_RESET,
        target: { kind: "JOB", id: job.name },
        reason: input.reason,
        change: {
          before: { hours: Number(before.value), origin: "SETTING", updatedAt: before.updatedAt.toISOString() },
          after:  { hours: null, origin: "DEFAULT", updatedAt: null },
        },
        detail: { settingKey: key },
        result: "SUCCESS",
        ipAddress: input.actor.ipAddress ?? null,
        userAgent: input.actor.userAgent ?? null,
      });
    });
  } catch (err) {
    if (err instanceof CadenceConflict) return { ok: false, code: "CONFLICT", reason: err.message, model: await loadJobCadenceReadModel(client, now) };
    throw err;
  }
  return { ok: true, model: await loadJobCadenceReadModel(client, now) };
}
