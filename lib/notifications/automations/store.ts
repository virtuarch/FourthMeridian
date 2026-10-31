/**
 * lib/notifications/automations/store.ts  (Comms Center B2 — the automation store and its ONE mutation service)
 *
 * Contract v1 §3.5, §4.6–§4.10; v1.1 §0.3 (D5), §6.1–§6.4, §6.8, §9.2. fm_system
 * (systemDb): the automation tables are revoked from fm_app and fm_auth.
 *
 *   createAutomation   COMMS_AUTOMATION_CREATED          a DRAFT (WRITE + reason)
 *   updateAutomation   COMMS_AUTOMATION_UPDATED          DRAFT / PAUSED only; bumps version
 *   recordDryRun       COMMS_AUTOMATION_DRY_RUN          one AutomationRun{DRY_RUN}; no item, no ledger
 *   ownerApprove       COMMS_AUTOMATION_OWNER_APPROVED   SYSTEM_ADMIN; pins (version, definitionVersion)
 *   activate           COMMS_AUTOMATION_ACTIVATED        CONTROL; the §6.3 checks, in order
 *   pause / disable    COMMS_AUTOMATION_PAUSED/DISABLED  WRITE; cancels SCHEDULED items in the same tx
 *
 * THE GUARANTEES (pinned by automations.test.ts):
 *   · ONE transaction per operation with ONE recordOperatorAction row written
 *     FIRST — the change and its audit commit together or not at all (an audit
 *     failure rolls the change back);
 *   · OPTIMISTIC TOKEN (D5): `expectedVersion` ≠ the row's `version` ⇒ CONFLICT
 *     with `current`, nothing written. create / PATCH / every state transition
 *     bumps `version`; owner approval and a dry run do NOT (they are ABOUT a
 *     version, so bumping it would void them at birth);
 *   · nothing here ever SENDS: activation only flips state; the engine sends.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorReason } from "@/lib/audit";
import type { CommsDefinition, RecipientResolver, TriggerKey } from "@/lib/notifications/catalog/types";
import { getCatalogDefinition } from "@/lib/notifications/catalog/definitions";
import { recordDelivery } from "@/lib/notifications/delivery/record";
import type { LedgerWriter } from "@/lib/notifications/delivery/types";
import { ledgerEnvironment, type LedgerEnv } from "@/lib/notifications/delivery/record";
import { EMAIL_TEMPLATE_VERSIONS, IN_APP_TEMPLATE_VERSION } from "@/lib/notifications/catalog/definitions";
import { activationBlockers, blockerCode, countsOf, isCustomerFacing, overlapsExistingDelivery, type AutomationFields } from "./rules";
import type { DryRunEvaluation } from "./dry-run";
import { ACTIVATION_DISABLED_REASON, ACTIVATION_DISABLED_TEXT, automationActivationEnabled } from "./types";
import type {
  ActivationBlocker, AutomationChannel, AutomationDetail, AutomationRunDTO, AutomationRunStatus, AutomationState, AutomationSummary,
  AutoPauseReason, Condition, RetryPolicy,
} from "./types";

type Tx = Prisma.TransactionClient;
export interface AutomationDb { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }
const DB = (): AutomationDb & Tx => systemDb as unknown as AutomationDb & Tx;

export interface AutomationActor { userId: string; via: "PLATFORM_GRANT" | "SYSTEM_ADMIN"; ipAddress?: string | null; userAgent?: string | null }

export type AutomationRefusalCode = "CONFLICT" | "NOT_FOUND" | "INVALID_STATE" | "PROTECTED" | "OWNER_APPROVAL_REQUIRED" | "DRY_RUN_REQUIRED" | typeof ACTIVATION_DISABLED_REASON;
export type AutomationWriteResult<T> =
  | { ok: true; value: T; auditLogId: string }
  | { ok: false; code: AutomationRefusalCode; error: string; current?: number; blockers?: ActivationBlocker[] };
type Refusal = Extract<AutomationWriteResult<never>, { ok: false }>;

class RefusalRollback extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.error); this.name = "RefusalRollback"; }
}
const refuse = (code: AutomationRefusalCode, error: string, extra: { current?: number; blockers?: ActivationBlocker[] } = {}): never => {
  throw new RefusalRollback({ ok: false, code, error, ...extra });
};

export type AutomationRow = Awaited<ReturnType<Tx["automationDefinition"]["findFirstOrThrow"]>>;
export type RunRow = Awaited<ReturnType<Tx["automationRun"]["findFirstOrThrow"]>>;

async function audit(tx: Tx, actor: AutomationActor, action: (typeof AuditAction)[keyof typeof AuditAction], id: string,
  change: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }, detail: Record<string, unknown>, reason: OperatorReason,
  result: "SUCCESS" | "REFUSED" = "SUCCESS"): Promise<string> {
  const { id: auditId } = await recordOperatorAction(tx as unknown as Parameters<typeof recordOperatorAction>[0], {
    actor: { userId: actor.userId, via: actor.via, area: "CUSTOMER_SUCCESS" },
    action,
    target: { kind: "COMMS_AUTOMATION", id },
    reason,
    change,
    result,
    detail,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });
  if (!auditId) throw new Error("comms-automations: the audit row returned no id");
  return auditId;
}

async function run<T>(client: AutomationDb, fn: (tx: Tx) => Promise<{ value: T; auditLogId: string }>): Promise<AutomationWriteResult<T>> {
  try {
    const r = await client.$transaction(fn);
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof RefusalRollback) return e.refusal;
    throw e;
  }
}

/** Read the row and check the token, inside the transaction. */
async function lockRow(tx: Tx, id: string, expectedVersion: number): Promise<AutomationRow> {
  const row = await tx.automationDefinition.findUnique({ where: { id } });
  if (!row) return refuse("NOT_FOUND", "No automation with that id.");
  if (row.version !== expectedVersion) return refuse("CONFLICT", "Someone else changed this automation — reload and review again.", { current: row.version });
  return row;
}

/** Bump under the token; anything but exactly one row is a CONFLICT (rolled back). */
async function bump(tx: Tx, row: AutomationRow, data: Prisma.AutomationDefinitionUpdateManyMutationInput): Promise<AutomationRow> {
  const r = await tx.automationDefinition.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, version: { increment: 1 } } });
  if (r.count !== 1) refuse("CONFLICT", "Someone else changed this automation — reload and review again.", { current: row.version });
  return (await tx.automationDefinition.findUnique({ where: { id: row.id } }))!;
}

const fieldsData = (f: AutomationFields) => ({
  name: f.name, description: f.description, conditions: f.conditions as unknown as Prisma.InputJsonValue,
  recipient: f.recipient as unknown as Prisma.InputJsonValue, delayMinutes: f.delayMinutes, dedupeKeyTemplate: f.dedupeKeyTemplate,
  frequencyCapMax: f.frequencyCapMax, frequencyCapHours: f.frequencyCapHours, retryPolicy: f.retryPolicy,
  maxRecipientsPerRun: f.maxRecipientsPerRun, channels: f.channels, variant: f.variant,
});

export function fieldsOf(row: AutomationRow): AutomationFields {
  return {
    name: row.name, description: row.description, conditions: (Array.isArray(row.conditions) ? row.conditions : []) as Condition[],
    recipient: row.recipient as unknown as RecipientResolver, delayMinutes: row.delayMinutes, dedupeKeyTemplate: row.dedupeKeyTemplate,
    frequencyCapMax: row.frequencyCapMax, frequencyCapHours: row.frequencyCapHours, retryPolicy: row.retryPolicy as RetryPolicy,
    maxRecipientsPerRun: row.maxRecipientsPerRun, channels: row.channels as AutomationChannel[], variant: row.variant,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function createAutomation(input: { def: CommsDefinition; trigger: TriggerKey; fields: AutomationFields; actor: AutomationActor; reason: OperatorReason }, client: AutomationDb = DB()): Promise<AutomationWriteResult<AutomationRow>> {
  return run(client, async (tx) => {
    const row = await tx.automationDefinition.create({
      data: {
        ...fieldsData(input.fields), triggerKey: input.trigger, definitionKey: input.def.key, definitionVersion: input.def.definitionVersion,
        customerFacing: isCustomerFacing(input.def), state: "DRAFT", version: 1, createdById: input.actor.userId, updatedById: input.actor.userId,
      },
    });
    const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_AUTOMATION_CREATED, row.id, { before: null, after: { state: "DRAFT", version: 1 } },
      { definitionKey: input.def.key, triggerKey: input.trigger, channels: input.fields.channels, conditionCount: input.fields.conditions.length }, input.reason);
    return { value: row, auditLogId };
  });
}

export async function updateAutomation(input: { id: string; expectedVersion: number; fields: (row: AutomationRow) => AutomationFields | { error: string }; actor: AutomationActor; reason: OperatorReason }, client: AutomationDb = DB()): Promise<AutomationWriteResult<AutomationRow> | { ok: false; code: "VALIDATION"; error: string }> {
  try {
    return await run(client, async (tx) => {
      const row = await lockRow(tx, input.id, input.expectedVersion);
      if (row.state !== "DRAFT" && row.state !== "PAUSED") refuse("INVALID_STATE", "Only a DRAFT or PAUSED automation can be edited.");
      const f = input.fields(row);
      if ("error" in f) throw new ValidationRollback(f.error);
      const def = getCatalogDefinition(row.definitionKey);
      const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_AUTOMATION_UPDATED, row.id, { before: { version: row.version }, after: { version: row.version + 1 } },
        { channels: f.channels, conditionCount: f.conditions.length }, input.reason);
      // A PATCH re-validates against the CURRENT definition version (and voids any owner approval / dry run by bumping version).
      const next = await bump(tx, row, { ...fieldsData(f), updatedById: input.actor.userId, ...(def ? { definitionVersion: def.definitionVersion, customerFacing: isCustomerFacing(def) } : {}) });
      return { value: next, auditLogId };
    });
  } catch (e) {
    if (e instanceof ValidationRollback) return { ok: false, code: "VALIDATION", error: e.message };
    throw e;
  }
}
class ValidationRollback extends Error { constructor(m: string) { super(m); this.name = "ValidationRollback"; } }

/**
 * Review M1 — `evaluatedVersion` is REQUIRED: the version the evaluation actually
 * read. It is checked INSIDE this transaction, and the pointer write is guarded on
 * it, so a PATCH that lands mid-dry-run makes this a CONFLICT — a run is never
 * stamped with a version it did not evaluate.
 */
export async function recordDryRun(input: { id: string; evaluatedVersion: number; evaluation: DryRunEvaluation; actor: AutomationActor; reason: OperatorReason; now: Date }, client: AutomationDb = DB()): Promise<AutomationWriteResult<{ row: AutomationRow; run: RunRow }>> {
  return run(client, async (tx) => {
    const row = await tx.automationDefinition.findUnique({ where: { id: input.id } });
    if (!row) return refuse("NOT_FOUND", "No automation with that id.");
    if (row.version !== input.evaluatedVersion) refuse("CONFLICT", "The automation changed while it was being dry-run — run it again.", { current: row.version });
    if (row.state === "DISABLED") refuse("INVALID_STATE", "A disabled automation cannot be dry-run; clone it.");
    const e = input.evaluation;
    const status: AutomationRunStatus = e.haltReason ? "HALTED" : "SUCCEEDED";
    const dry = await tx.automationRun.create({
      data: {
        automationId: row.id, automationVersion: row.version, mode: "DRY_RUN", triggerKey: row.triggerKey, triggerRef: null, status,
        counts: e.counts as unknown as Prisma.InputJsonValue, haltReason: e.haltReason, dedupedCount: e.deduped,
        // the EVALUATED version (= row.version, checked above)
        windowFrom: e.window?.from ?? null, windowTo: e.window?.to ?? null, error: e.wouldExceedMaxRecipients ? "WOULD_EXCEED_MAX_RECIPIENTS" : null,
        startedAt: input.now, completedAt: input.now,
      },
    });
    const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_AUTOMATION_DRY_RUN, row.id, { before: null, after: { runId: dry.id, version: row.version } },
      { runId: dry.id, status, eligible: e.counts.eligible, matched: e.counts.matched, wouldExceedMaxRecipients: e.wouldExceedMaxRecipients }, input.reason);
    // lastDryRunId is a pointer, not a write ABOUT the rule: the version is not bumped,
    // but the write is guarded on the evaluated version (a concurrent PATCH ⇒ CONFLICT, rolled back).
    const ptr = await tx.automationDefinition.updateMany({ where: { id: row.id, version: input.evaluatedVersion }, data: { lastDryRunId: dry.id } });
    if (ptr.count !== 1) refuse("CONFLICT", "The automation changed while it was being dry-run — run it again.", { current: row.version });
    const updated = (await tx.automationDefinition.findUnique({ where: { id: row.id } }))!;
    return { value: { row: updated, run: dry }, auditLogId };
  });
}

export async function ownerApprove(input: { id: string; expectedVersion: number; actor: AutomationActor; reason: OperatorReason; now: Date }, client: AutomationDb = DB()): Promise<AutomationWriteResult<AutomationRow>> {
  return run(client, async (tx) => {
    const row = await lockRow(tx, input.id, input.expectedVersion);
    if (row.state !== "DRAFT" && row.state !== "PAUSED") refuse("INVALID_STATE", "Owner approval is recorded on a DRAFT or PAUSED automation.");
    const def = getCatalogDefinition(row.definitionKey);
    if (!def) return refuse("INVALID_STATE", "The automation's definition no longer exists.");
    // Review M2 — never approve against a definition the row was not validated against.
    if (row.definitionVersion !== def.definitionVersion) refuse("INVALID_STATE", "The message definition changed since this automation was validated — edit (PATCH) it to re-validate, then approve.", { blockers: ["DEFINITION_CHANGED"] });
    // …and customer-facing is the LIVE definition's fact, not the stored copy.
    if (!isCustomerFacing(def)) refuse("INVALID_STATE", "This automation is not customer-facing: no owner approval is needed.");
    const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_AUTOMATION_OWNER_APPROVED, row.id,
      { before: { ownerApprovedVersion: row.ownerApprovedVersion, ownerApprovedDefinitionVersion: row.ownerApprovedDefinitionVersion }, after: { ownerApprovedVersion: row.version, ownerApprovedDefinitionVersion: def.definitionVersion } },
      // HARDENING A6 — the owner approves KNOWING whether a code producer already delivers this definition.
      { version: row.version, definitionKey: row.definitionKey, definitionVersion: def.definitionVersion, overlapsExistingDelivery: overlapsExistingDelivery(def) }, input.reason);
    // Guarded on the token; NOT bumped (an approval is ABOUT this version).
    const r = await tx.automationDefinition.updateMany({
      where: { id: row.id, version: row.version },
      data: { ownerApprovedVersion: row.version, ownerApprovedDefinitionVersion: def.definitionVersion, ownerApprovedAt: input.now, ownerApprovedById: input.actor.userId },
    });
    if (r.count !== 1) refuse("CONFLICT", "Someone else changed this automation — reload and review again.", { current: row.version });
    return { value: (await tx.automationDefinition.findUnique({ where: { id: row.id } }))!, auditLogId };
  });
}

async function lastDryRunOf(tx: Tx, row: AutomationRow): Promise<RunRow | null> {
  if (!row.lastDryRunId) return null;
  const r = await tx.automationRun.findUnique({ where: { id: row.lastDryRunId } });
  return r && r.automationId === row.id && r.mode === "DRY_RUN" ? r : null;
}

export async function activate(input: { id: string; expectedVersion: number; actor: AutomationActor; reason: OperatorReason; now: Date; activationEnabled?: boolean }, client: AutomationDb = DB()): Promise<AutomationWriteResult<AutomationRow>> {
  // The ACTIVATION GATE (types.ts) — before any read or write. The caller's decision AND the resolver,
  // read now: the store never opens what the environment has closed (defence in depth).
  if (input.activationEnabled === false || !automationActivationEnabled(process.env)) {
    return { ok: false, code: ACTIVATION_DISABLED_REASON, error: ACTIVATION_DISABLED_TEXT };
  }
  return run(client, async (tx) => {
    const row = await tx.automationDefinition.findUnique({ where: { id: input.id } });
    if (!row) return refuse("NOT_FOUND", "No automation with that id.");
    // §6.3 rule 1 first: state, THEN the token.
    if (row.state !== "DRAFT" && row.state !== "PAUSED") refuse("INVALID_STATE", "Only a DRAFT or PAUSED automation can be activated.", { blockers: ["STATE"] });
    if (row.version !== input.expectedVersion) refuse("CONFLICT", "Someone else changed this automation — reload and review again.", { current: row.version });
    const def = getCatalogDefinition(row.definitionKey);
    if (!def) return refuse("INVALID_STATE", "The automation's definition no longer exists.", { blockers: ["DEFINITION_NOT_ACTIVATABLE"] });
    const dry = await lastDryRunOf(tx, row);
    const blockers = activationBlockers(factsOf(row, dry), def, input.now);
    if (blockers.length > 0) refuse(blockerCode(blockers[0]), BLOCKER_TEXT[blockers[0]], { blockers });
    const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_AUTOMATION_ACTIVATED, row.id,
      { before: { state: row.state, version: row.version }, after: { state: "ACTIVE", activatedVersion: row.version } },
      { definitionKey: row.definitionKey, definitionVersion: def.definitionVersion, dryRunId: dry?.id ?? null, ownerApproved: row.customerFacing }, input.reason);
    // Nothing recorded BEFORE this instant fires: the trigger cursor starts now.
    const next = await bump(tx, row, {
      state: "ACTIVE", activatedVersion: row.version, activatedAt: input.now, autoPausedReason: null,
      triggerCursorAt: input.now, triggerCursorId: null, updatedById: input.actor.userId,
    });
    return { value: next, auditLogId };
  });
}

/**
 * An activation REFUSED by the closed gate (the env kill switch / not Preview): ONE audit row
 * (COMMS_AUTOMATION_ACTIVATION_REFUSED, result REFUSED) with the actor, the reason, the requested and
 * current version and the definitionVersion. Writes nothing else. The decision was made before this
 * read; an unknown id is recorded with nulls (the response is the same 409 either way).
 */
export async function recordActivationRefused(input: { id: string; expectedVersion: number; actor: AutomationActor; reason: OperatorReason; now: Date }, client: AutomationDb = DB()): Promise<string> {
  return client.$transaction(async (tx) => {
    const row = await tx.automationDefinition.findUnique({ where: { id: input.id } });
    const def = row ? getCatalogDefinition(row.definitionKey) : undefined;
    return audit(tx, input.actor, AuditAction.COMMS_AUTOMATION_ACTIVATION_REFUSED, input.id,
      { before: row ? { state: row.state, version: row.version } : null, after: null },
      { code: ACTIVATION_DISABLED_REASON, requestedVersion: input.expectedVersion, definitionKey: row?.definitionKey ?? null,
        definitionVersion: def?.definitionVersion ?? row?.definitionVersion ?? null }, input.reason, "REFUSED");
  });
}

export interface StopResult { row: AutomationRow; cancelled: Array<{ id: string; recipientUserId: string | null; channel: string; attempt: number; runId: string }> }

async function stop(kind: "PAUSE" | "DISABLE", input: { id: string; expectedVersion: number; actor: AutomationActor; reason: OperatorReason; now: Date }, client: AutomationDb): Promise<AutomationWriteResult<StopResult>> {
  return run(client, async (tx) => {
    const row = await lockRow(tx, input.id, input.expectedVersion);
    const allowed: AutomationState[] = kind === "PAUSE" ? ["ACTIVE"] : ["DRAFT", "ACTIVE", "PAUSED"];
    if (!allowed.includes(row.state as AutomationState)) refuse("INVALID_STATE", kind === "PAUSE" ? "Only an ACTIVE automation can be paused." : "This automation is already disabled.");
    const to: AutomationState = kind === "PAUSE" ? "PAUSED" : "DISABLED";
    // v1 §4.9 — every SCHEDULED item of this automation becomes CANCELLED / AUTOMATION_PAUSED in the SAME transaction.
    const scheduled = await tx.automationRunItem.findMany({ where: { automationId: row.id, status: "SCHEDULED" }, select: { id: true, recipientUserId: true, channel: true, attempt: true, runId: true } });
    if (scheduled.length > 0) {
      await tx.automationRunItem.updateMany({ where: { id: { in: scheduled.map((s) => s.id) }, status: "SCHEDULED" }, data: { status: "CANCELLED", reason: "AUTOMATION_PAUSED", lastDeliveryStatus: "CANCELLED" } });
    }
    const auditLogId = await audit(tx, input.actor, kind === "PAUSE" ? AuditAction.COMMS_AUTOMATION_PAUSED : AuditAction.COMMS_AUTOMATION_DISABLED, row.id,
      { before: { state: row.state, version: row.version }, after: { state: to } },
      { cancelledItems: scheduled.length, definitionKey: row.definitionKey, definitionVersion: getCatalogDefinition(row.definitionKey)?.definitionVersion ?? row.definitionVersion }, input.reason);
    const next = await bump(tx, row, { state: to, updatedById: input.actor.userId, ...(kind === "PAUSE" ? { pausedAt: input.now } : { disabledAt: input.now }) });
    return { value: { row: next, cancelled: scheduled }, auditLogId };
  });
}

export const pause = (input: Parameters<typeof stop>[1], client: AutomationDb = DB()) => stop("PAUSE", input, client);
export const disable = (input: Parameters<typeof stop>[1], client: AutomationDb = DB()) => stop("DISABLE", input, client);

/** After a pause / disable COMMITS: one CANCELLED ledger row per cancelled item (the ledger is append-only and best-effort). */
export async function recordCancellations(writer: LedgerWriter, env: LedgerEnv, definitionKey: string, cancelled: StopResult["cancelled"]): Promise<void> {
  const def = getCatalogDefinition(definitionKey);
  if (!def) return;
  for (const it of cancelled) {
    await recordDelivery(writer, {
      messageKey: it.id, definitionKey: def.key, definitionVersion: def.definitionVersion,
      templateVersion: it.channel === "IN_APP" ? IN_APP_TEMPLATE_VERSION : EMAIL_TEMPLATE_VERSIONS.notification,
      channel: it.channel === "IN_APP" ? "IN_APP" : "EMAIL", status: "CANCELLED", reason: "AUTOMATION_PAUSED",
      provider: null, providerMessageId: null, attempt: Math.max(1, it.attempt), errorCode: null, recipientUserId: it.recipientUserId,
      recipientHash: null, notificationId: null, environment: ledgerEnvironment(env), acceptedAt: null, automationRunItemId: it.id,
    });
  }
}

const BLOCKER_TEXT: Record<ActivationBlocker, string> = {
  STATE: "Only a DRAFT or PAUSED automation can be activated.",
  PROTECTED: "This message is protected: it cannot be automated.",
  DEFINITION_NOT_ACTIVATABLE: "This message's definition cannot be activated.",
  DEFINITION_CHANGED: "The message definition changed since this automation was validated — edit (PATCH) it to re-validate.",
  TRIGGER_NOT_AVAILABLE: "This trigger is not available to the automation engine yet.",
  MARKETING_NOT_IN_V1: "Marketing messages cannot be automated in v1.",
  OWNER_APPROVAL_REQUIRED: "A customer-facing automation needs the owner's approval of this exact version first.",
  DRY_RUN_REQUIRED: "Dry-run this version over a 7- or 30-day window successfully (within 7 days, within its recipient cap) before activating.",
};

// ── Reads ─────────────────────────────────────────────────────────────────────

export function factsOf(row: AutomationRow, dry: RunRow | null): Parameters<typeof activationBlockers>[0] {
  return {
    state: row.state as AutomationState, version: row.version, definitionVersion: row.definitionVersion, triggerKey: row.triggerKey as TriggerKey,
    customerFacing: row.customerFacing, ownerApprovedVersion: row.ownerApprovedVersion, ownerApprovedDefinitionVersion: row.ownerApprovedDefinitionVersion,
    lastDryRun: dry ? { automationVersion: dry.automationVersion, status: dry.status, startedAt: dry.startedAt, wouldExceedMaxRecipients: dry.error === "WOULD_EXCEED_MAX_RECIPIENTS", window: dry.windowFrom !== null } : null,
  };
}

export async function readAutomation(id: string, client: Tx = DB()): Promise<AutomationRow | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return client.automationDefinition.findUnique({ where: { id } });
}

export async function readRun(id: string | null, client: Tx = DB()): Promise<RunRow | null> {
  return id ? client.automationRun.findUnique({ where: { id } }) : null;
}

export async function latestRun(automationId: string, client: Tx = DB()): Promise<RunRow | null> {
  return client.automationRun.findFirst({ where: { automationId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
}

export async function listAutomationRows(opts: { state: AutomationState | null; before: { at: Date; id: string } | null; limit: number }, client: Tx = DB()): Promise<AutomationRow[]> {
  return client.automationDefinition.findMany({
    where: {
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.before ? { OR: [{ updatedAt: { lt: opts.before.at } }, { updatedAt: opts.before.at, id: { lt: opts.before.id } }] } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
  });
}

export async function listRunRows(automationId: string, opts: { before: { at: Date; id: string } | null; limit: number }, client: Tx = DB()): Promise<RunRow[]> {
  return client.automationRun.findMany({
    where: { automationId, ...(opts.before ? { OR: [{ startedAt: { lt: opts.before.at } }, { startedAt: opts.before.at, id: { lt: opts.before.id } }] } : {}) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
  });
}

const HISTORY_ACTIONS = [
  AuditAction.COMMS_AUTOMATION_CREATED, AuditAction.COMMS_AUTOMATION_UPDATED, AuditAction.COMMS_AUTOMATION_DRY_RUN,
  AuditAction.COMMS_AUTOMATION_OWNER_APPROVED, AuditAction.COMMS_AUTOMATION_ACTIVATED, AuditAction.COMMS_AUTOMATION_PAUSED, AuditAction.COMMS_AUTOMATION_DISABLED,
];

/** The audited history of one automation: action, time, actor KIND and audit id only (full identity lives in the audit row). */
export async function readHistory(automationId: string, client: Tx = DB()): Promise<AutomationDetail["history"]> {
  // HARDENING N9 — the target is filtered IN THE QUERY (a JSON path on metadata.target.id), so an
  // automation's history is never truncated by 500 newer rows that belong to other automations.
  const rows = await client.auditLog.findMany({
    where: { action: { in: HISTORY_ACTIONS }, metadata: { path: ["target", "id"], equals: automationId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, action: true, createdAt: true, metadata: true },
  });
  return rows
    .filter((r) => { const t = (r.metadata as { target?: { kind?: unknown; id?: unknown } } | null)?.target; return t?.kind === "COMMS_AUTOMATION" && t.id === automationId; })
    .map((r) => ({
      at: r.createdAt.toISOString(),
      action: r.action,
      actorKind: (r.metadata as { actorType?: unknown } | null)?.actorType === "SYSTEM_ADMIN" ? "SYSTEM_ADMIN" as const : "PLATFORM_OPERATOR" as const,
      auditLogId: r.id,
    }));
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

export function toSummary(row: AutomationRow, last: RunRow | null): AutomationSummary {
  return {
    id: row.id, name: row.name, state: row.state as AutomationState, triggerKey: row.triggerKey as TriggerKey,
    definitionKey: row.definitionKey, definitionVersion: row.definitionVersion, channels: row.channels as AutomationChannel[],
    version: row.version, activatedVersion: row.activatedVersion, autoPausedReason: (row.autoPausedReason as AutoPauseReason | null) ?? null,
    lastRun: last ? { id: last.id, at: last.startedAt.toISOString(), status: last.status as AutomationRunStatus } : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRunDTO(r: RunRow): AutomationRunDTO {
  return {
    id: r.id, mode: r.mode === "DRY_RUN" ? "DRY_RUN" : "LIVE", status: r.status as AutomationRunStatus, automationVersion: r.automationVersion,
    triggerRef: r.triggerRef, startedAt: r.startedAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null,
    counts: countsOf(r.counts), haltReason: (r.haltReason as AutomationRunDTO["haltReason"]) ?? null, deduped: r.dedupedCount,
  };
}
