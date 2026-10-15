/**
 * lib/platform/ai/cost-controls.ts  (AI COST CONTROLS — read model + mutation service)
 *
 * THE ONE READ AND THE ONE WRITE PATH FOR THE SEVEN AI COST CONTROLS. The route
 * (app/api/platform/platform-ops/ai-cost-controls) and the widget never touch
 * PlatformSetting; everything a change needs happens here, in the
 * lib/platform/policies/mutate.ts order, and nowhere else:
 *
 *   1. CLOSED CONTRACT       only the seven controls of cost-controls.types.ts
 *                            are reachable; the body names a CONTROL, never a
 *                            setting key.
 *   2. DESCRIPTOR VALIDATION the registry's rule (lib/platform-settings.ts):
 *                            booleans "true"/"false", integers within the
 *                            descriptor's bounds (the allowance's max is the
 *                            catalogue ceiling, derived). The WHOLE batch is
 *                            validated before any transaction.
 *   3. OPTIMISTIC CONCURRENCY per control: the caller states the row version it
 *                            observed (`expectedUpdatedAt`, or null for "no
 *                            row"). A row that moved ⇒ CONFLICT naming the
 *                            control, and NOTHING in the batch is written.
 *   4. ONE TRANSACTION       every setting write and its operator-action audit
 *                            row (one per change; PLATFORM_POLICY_CHANGED /
 *                            PLATFORM_POLICY_RESET, reason REQUIRED by
 *                            lib/audit.ts) commit together or not at all.
 *   5. THE CANONICAL RESULT  the reloaded read model — there is no second
 *                            representation of the controls.
 *
 * ⚠️ A CONTROL CHANGE CHANGES THE CONTROL ONLY. No refresh, no job, no provider,
 * no AI call. Consumers observe the new row on their next decision — see
 * `propagation` in the read model, which states the caching posture honestly.
 *
 * ⚠️ RESET IS DELETE. The override row is removed; the code default is in force
 * with origin DEFAULT. The default is never written as if it were configured.
 *
 * fm_system: PlatformSetting, AuditLog, User (display names), JobRun (the
 * alert history) and CustomerPolicyAssignment (the override list) are all
 * tables fm_system holds. Identity minimisation: the override list carries
 * opaque refs; the writer is a display NAME, never an email.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionWriteClient, type OperatorReason } from "@/lib/audit";
import {
  PlatformSettingValidationError, createSettingIfAbsent, deleteSettingIfVersion, updateSettingIfVersion,
  type SettingWriteClient,
} from "@/lib/platform-settings";
import { ALERT_JOB_NAME } from "@/lib/alerts/run";
import { collectAlertHistory, type AlertRunSummary } from "@/lib/alerts/evaluate";
import { latestAlertEvaluation } from "@/lib/alerts/latest-evaluation";
import { findAlertRule } from "@/lib/alerts/rules";
import { ENTITLEMENT_DIMENSIONS, BETA_FULL_ACCESS_V1 } from "@/lib/entitlements/catalogue";
import { resolveAiDailyAllowance } from "@/lib/entitlements/ai-allowance";
import { opaqueUserRef } from "@/lib/platform/ai/spend-health";
import { AI_PAUSED_CUSTOMER_MESSAGE } from "@/lib/platform/ai/paid-requests-admission";
import { RESERVE_USD } from "@/lib/ai/allowance-core";
import {
  AI_COST_CONTROL_SETTING_KEY_LIST, resolveControlValue, resolveControls, validateControlChanges,
  type ControlRowFacts, type ResolvedControls, type ValidatedChange,
} from "./cost-controls-core";
import {
  AI_SPEND_RULE_IDS,
  type AiCostControlKey, type AiCostControlsMutationCode, type AiCostControlsReadModel, type AlertControlsView,
  type AlertTriggerView, type AllowanceOverrideView, type ControlOrigin,
} from "./cost-controls.types";

export { validateControlChanges } from "./cost-controls-core";

// ── Caps ─────────────────────────────────────────────────────────────────────

/** The override list is capped; `count` carries the true total. */
export const OVERRIDE_LIST_CAP = 50;
/** Recent triggers per alert, newest first. */
export const ALERT_RECENT_CAP = 10;
/** evaluate-alerts summaries examined for history/firing (the alerts route's window). */
const RECENT_RUNS_EXAMINED = 10;

/**
 * THE CACHING FINDING (2026-10-15), stated for the operator in `propagation`:
 * no AI policy read is cached anywhere in the process. `getSetting` /
 * `findUnique` / `findMany` run per decision (the kill switch per route call and
 * per provider call; the enforcement flag and spend inside the reservation
 * transaction; the platform allowance in the entitlement load of each request;
 * the alert-enabled keys per evaluation cycle); `AI_RATES` is code. A change is
 * visible to the very next decision. The one thing that is NOT instantaneous is
 * the in-flight reservation: a lost release over-reserves for up to two hours
 * (the counter bucket), refusing too much, never too little.
 */
export const PROPAGATION_NOTE =
  "Nothing here is cached: every decision reads the setting row (the kill switch per request and per model call; " +
  "the enforcement flag and today's spend inside the reservation transaction; the platform allowance with each request's entitlements; " +
  "the alert-enabled keys per evaluation cycle). A change is in force for the very next decision. The daily-allowance refusal is " +
  "bounded, not absolute: concurrent turns are judged under a per-customer lock with an in-flight reserve of about $" + RESERVE_USD.toFixed(3) +
  " each, so admitted spend can exceed the allowance by at most (a turn's actual cost − its reserve) per concurrently admitted turn; " +
  "if the reservation store is unavailable the plain check decides and the verdict says so.";

export const ENFORCEMENT_NOTE =
  "Judged in the Conversations and Daily Brief routes after authentication, entitlement, pacing and the kill switch, " +
  "before any model work, over today's RETURNED customer-surface invocations since midnight UTC; the next turn is refused at or over the allowance.";

// ── Read model ────────────────────────────────────────────────────────────────

/** The narrow shapes the loader calls — satisfied by systemDb or a test fake. */
export interface CostControlsReadClient {
  platformSetting: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true; updatedAt: true; updatedById: true } }):
      Promise<{ key: string; value: string; updatedAt: Date; updatedById: string | null }[]>;
  };
  user: {
    findMany(args: { where: { id: { in: string[] } }; select: { id: true; name: true } }): Promise<{ id: string; name: string | null }[]>;
  };
  jobRun: {
    findMany(args: { where: { jobName: string; status: string }; orderBy: { startedAt: "desc" }; take: number; select: { summary: true } }):
      Promise<{ summary: unknown }[]>;
  };
  customerPolicyAssignment: {
    findMany(args: {
      where: { aiDailyUsdAllowanceOverride: { not: null } };
      orderBy: { updatedAt: "desc" };
      take: number;
      select: { userId: true; aiDailyUsdAllowanceOverride: true; updatedAt: true };
    }): Promise<{ userId: string; aiDailyUsdAllowanceOverride: number | null; updatedAt: Date }[]>;
    count(args: { where: { aiDailyUsdAllowanceOverride: { not: null } } }): Promise<number>;
  };
}

const DEFAULT_READ = (): CostControlsReadClient => systemDb as unknown as CostControlsReadClient;

/** The seven rows + the writers' display names, resolved. Shared with the budget reader. */
export async function loadResolvedControls(client: CostControlsReadClient = DEFAULT_READ()): Promise<ResolvedControls> {
  const rows = await client.platformSetting.findMany({
    where: { key: { in: [...AI_COST_CONTROL_SETTING_KEY_LIST] } },
    select: { key: true, value: true, updatedAt: true, updatedById: true },
  });
  const byKey = new Map<string, ControlRowFacts>(rows.map((r) => [r.key, { value: r.value, updatedAt: r.updatedAt, updatedById: r.updatedById }]));
  const writerIds = [...new Set(rows.map((r) => r.updatedById).filter((id): id is string => !!id))];
  const names = new Map<string, string | null>();
  if (writerIds.length > 0) {
    // The refresh-policies idiom: a display NAME, never an email.
    const users = await client.user.findMany({ where: { id: { in: writerIds } }, select: { id: true, name: true } });
    for (const u of users) names.set(u.id, u.name ?? null);
  }
  return resolveControls(byKey, names);
}

/** Recent evaluate-alerts summaries, newest first, through the given client (fm_system). */
export async function loadRecentAlertSummaries(client: Pick<CostControlsReadClient, "jobRun">, limit = RECENT_RUNS_EXAMINED): Promise<AlertRunSummary[]> {
  const rows = await client.jobRun.findMany({
    where: { jobName: ALERT_JOB_NAME, status: "succeeded" },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: { summary: true },
  });
  const out: AlertRunSummary[] = [];
  for (const r of rows) {
    const s = r.summary as AlertRunSummary | null;
    if (s && Array.isArray(s.fired)) out.push(s);
  }
  return out;
}

/** PURE — one rule's recent triggers from the retained history (newest first, capped). */
export function recentTriggersFor(ruleId: string, recent: readonly AlertRunSummary[], cap = ALERT_RECENT_CAP): AlertTriggerView[] {
  return collectAlertHistory(recent, Number.MAX_SAFE_INTEGER)
    .filter((f) => f.ruleId === ruleId)
    .slice(0, cap)
    .map((f) => ({ at: f.deliveredAtISO, severity: f.severity, summary: f.summary, dedupeKey: f.dedupeKey }));
}

/** PURE — one alert's view from the resolved controls and the retained summaries. */
export function composeAlertView(
  ruleId: string,
  enabled: AlertControlsView["enabled"],
  thresholdUsd: AlertControlsView["thresholdUsd"],
  recent: readonly AlertRunSummary[],
): AlertControlsView {
  const latest = latestAlertEvaluation(recent);
  const outcome = latest?.rules.find((r) => r.id === ruleId) ?? null;
  const triggers = recentTriggersFor(ruleId, recent);
  return {
    ruleId,
    enabled,
    thresholdUsd,
    status: {
      live: findAlertRule(ruleId)?.live ?? false,
      firingNow: outcome?.firing === true,
      lastFiredAt: triggers[0]?.at ?? null,
      recent: triggers,
    },
  };
}

export async function loadAiCostControlsReadModel(
  client: CostControlsReadClient = DEFAULT_READ(),
  now: Date = new Date(),
): Promise<AiCostControlsReadModel> {
  const [controls, recent, overrideRows, overrideCount] = await Promise.all([
    loadResolvedControls(client),
    loadRecentAlertSummaries(client),
    client.customerPolicyAssignment.findMany({
      where: { aiDailyUsdAllowanceOverride: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: OVERRIDE_LIST_CAP,
      select: { userId: true, aiDailyUsdAllowanceOverride: true, updatedAt: true },
    }),
    client.customerPolicyAssignment.count({ where: { aiDailyUsdAllowanceOverride: { not: null } } }),
  ]);

  const ceilingUsd = ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance.ceiling;
  // What a customer on the default policy with no overlay and no override gets today — the ONE precedence function.
  const effective = resolveAiDailyAllowance({
    policyUsd: BETA_FULL_ACCESS_V1.values.aiDailyUsdAllowance,
    overlayUsd: null,
    platformUsd: controls["allowance.usd"].origin === "SETTING" ? controls["allowance.usd"].value : null,
    userOverrideUsd: null,
    ceilingUsd,
  });
  const customers: AllowanceOverrideView[] = overrideRows
    .filter((r) => typeof r.aiDailyUsdAllowanceOverride === "number")
    .map((r) => ({ ref: opaqueUserRef(r.userId), usd: r.aiDailyUsdAllowanceOverride as number, updatedAt: r.updatedAt.toISOString() }));

  return {
    checkedAt: now.toISOString(),
    allowance: {
      enforced: controls["allowance.enforced"],
      usd: controls["allowance.usd"],
      ceilingUsd,
      effectiveDefaultUsd: effective.usd,
      effectiveDefaultSource: effective.source === "PLATFORM_SETTING" ? "PLATFORM_SETTING" : effective.source === "CEILING" ? "CEILING" : "POLICY",
      overrides: { count: overrideCount, customers },
      enforcementNote: ENFORCEMENT_NOTE,
    },
    userAlert: composeAlertView(AI_SPEND_RULE_IDS.user, controls["userAlert.enabled"], controls["userAlert.thresholdUsd"], recent),
    fleetAlert: composeAlertView(AI_SPEND_RULE_IDS.fleet, controls["fleetAlert.enabled"], controls["fleetAlert.thresholdUsd"], recent),
    killSwitch: { paused: controls["killSwitch.paused"], customerMessage: AI_PAUSED_CUSTOMER_MESSAGE },
    propagation: { cached: false, note: PROPAGATION_NOTE },
  };
}

// ── Mutation ──────────────────────────────────────────────────────────────────

export interface CostControlsActor {
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ApplyAiCostControlChangesInput {
  /** The raw `changes` array of the PATCH body — validated here. */
  changes: unknown;
  reason: OperatorReason;
  actor: CostControlsActor;
}

export type AiCostControlsMutationResult =
  | { ok: true; model: AiCostControlsReadModel }
  | { ok: false; code: AiCostControlsMutationCode; reason: string; control?: AiCostControlKey; model: AiCostControlsReadModel };

/** The transactional surface: the registry's setting-write client plus the operator-action writer. */
export type CostControlsTx = SettingWriteClient & OperatorActionWriteClient;
export interface CostControlsClient extends CostControlsReadClient {
  $transaction<T>(fn: (tx: CostControlsTx) => Promise<T>): Promise<T>;
}

const DEFAULT_CLIENT = (): CostControlsClient => systemDb as unknown as CostControlsClient;

/** Thrown inside the transaction to abort it without writing anything. */
class ControlConflict extends Error {
  constructor(readonly control: AiCostControlKey, readonly code: "CONFLICT" | "NOT_FOUND", reason: string) {
    super(reason); this.name = "ControlConflict";
  }
}

function versionMatches(expected: string | null, row: { updatedAt: Date } | null): boolean {
  if (expected === null) return row === null;
  if (row === null) return false;
  const t = Date.parse(expected);
  return Number.isFinite(t) && t === row.updatedAt.getTime();
}

interface AuditFacts { value: string | number | boolean | null; origin: ControlOrigin; updatedAt: string | null }

function auditFactsOf(change: ValidatedChange, row: { value: string; updatedAt: Date } | null): AuditFacts {
  const v = resolveControlValue(change.control, row ? { value: row.value, updatedAt: row.updatedAt } : null);
  return { value: row ? row.value : null, origin: v.origin, updatedAt: v.updatedAt };
}

/**
 * Apply one batch of control changes: ONE transaction, all-or-nothing, one
 * audit row per change. Refusals come back with the canonical model (the route
 * maps VALIDATION → 400, CONFLICT → 409, NOT_FOUND → 404).
 */
export async function applyAiCostControlChanges(
  input: ApplyAiCostControlChangesInput,
  client: CostControlsClient = DEFAULT_CLIENT(),
  now: Date = new Date(),
): Promise<AiCostControlsMutationResult> {
  // 2. The whole batch is validated BEFORE any transaction.
  const validated = validateControlChanges(input.changes);
  if (!validated.ok) {
    return { ok: false, code: "VALIDATION", reason: validated.reason, control: validated.control, model: await loadAiCostControlsReadModel(client, now) };
  }
  if (!input.reason) {
    return { ok: false, code: "VALIDATION", reason: "A structured reason is required.", model: await loadAiCostControlsReadModel(client, now) };
  }

  try {
    await client.$transaction(async (tx) => {
      for (const change of validated.changes) {
        const key = change.key;
        const before = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });

        if (change.kind === "RESET") {
          if (!before) throw new ControlConflict(change.control, "NOT_FOUND", `${change.control}: there is no override to reset; the default is already in force.`);
          if (!versionMatches(change.expectedUpdatedAt, before)) throw new ControlConflict(change.control, "CONFLICT", `${change.control} changed since you opened the editor.`);
          const deleted = await deleteSettingIfVersion(tx, key, before.updatedAt);
          if (!deleted) throw new ControlConflict(change.control, "CONFLICT", `${change.control} changed while the reset was being saved.`);
          await recordOperatorAction(tx, {
            actor: { userId: input.actor.id, via: "PLATFORM_GRANT", area: "PLATFORM_OPS" },
            action: AuditAction.PLATFORM_POLICY_RESET,
            target: { kind: "PLATFORM_SETTING", id: key },
            reason: input.reason,
            change: { before: { ...auditFactsOf(change, before) }, after: { ...auditFactsOf(change, null) } },
            detail: { control: change.control, settingKey: key },
            result: "SUCCESS",
            ipAddress: input.actor.ipAddress ?? null,
            userAgent: input.actor.userAgent ?? null,
          });
          continue;
        }

        // 3. The caller's observation must still hold.
        if (!versionMatches(change.expectedUpdatedAt, before)) {
          throw new ControlConflict(change.control, "CONFLICT", before
            ? `${change.control} changed since you opened the editor.`
            : `${change.control} was reset since you opened the editor.`);
        }
        // 4a. The conditional write, predicated on the version.
        const written = before
          ? await updateSettingIfVersion(tx, key, change.stored, before.updatedAt, input.actor.id)
          : await createSettingIfAbsent(tx, key, change.stored, input.actor.id);
        if (!written) throw new ControlConflict(change.control, "CONFLICT", `${change.control} changed while your change was being saved.`);
        const after = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });

        // 4b. The audit row, in the same transaction — policy values only, never a secret.
        await recordOperatorAction(tx, {
          actor: { userId: input.actor.id, via: "PLATFORM_GRANT", area: "PLATFORM_OPS" },
          action: AuditAction.PLATFORM_POLICY_CHANGED,
          target: { kind: "PLATFORM_SETTING", id: key },
          reason: input.reason,
          change: { before: { ...auditFactsOf(change, before) }, after: { ...auditFactsOf(change, after) } },
          detail: { control: change.control, settingKey: key },
          result: "SUCCESS",
          ipAddress: input.actor.ipAddress ?? null,
          userAgent: input.actor.userAgent ?? null,
        });
      }
    });
  } catch (err) {
    if (err instanceof ControlConflict) {
      return { ok: false, code: err.code, reason: err.message, control: err.control, model: await loadAiCostControlsReadModel(client, now) };
    }
    if (err instanceof PlatformSettingValidationError) {
      return { ok: false, code: "VALIDATION", reason: err.reason, model: await loadAiCostControlsReadModel(client, now) };
    }
    throw err;
  }

  // 5. The canonical result.
  return { ok: true, model: await loadAiCostControlsReadModel(client, now) };
}
