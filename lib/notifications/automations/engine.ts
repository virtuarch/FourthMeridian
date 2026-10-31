/**
 * lib/notifications/automations/engine.ts  (Comms Center B2 — the EXECUTION ENGINE)
 *
 * Contract v1.1 §6.5–§6.8 (v1 §5.4–§5.8). One bounded, idempotent, resumable
 * pass, run by the `comms-automations` job on the dispatcher wake
 * (jobs/comms-automations.ts). Every port is injected (EngineDeps), so the
 * tests run THIS code over the in-memory Prisma fake with fake transports.
 *
 * ONE PASS, IN ORDER
 *   0. Expired send leases return to SCHEDULED (a crashed pass is resumed).
 *   1. GLOBAL COST FREEZE (readGlobalCostFreeze, uncached; ON / INVALID /
 *      UNAVAILABLE = frozen, MISSING / OFF = not): every LIVE run HALTS
 *      (PROVIDER_FREEZE), every SCHEDULED item is CANCELLED / PROVIDER_FREEZE
 *      (one ledger row each), nothing is sent, and the job reports SKIPPED
 *      (`outcome: "SKIPPED"`, `skipReason: "BILLABLE_<reason>"` — the job
 *      runner's skipped semantics, lib/jobs/health.ts).
 *   2. GLOBAL BREAKER: > 200 accepted automation sends in 10 min auto-pauses
 *      EVERY automation (STORM_BREAKER) and halts their runs. Registry and
 *      direct sends are untouched.
 *   3. INGEST: for each ACTIVE automation, the recorded trigger facts after its
 *      keyset cursor (facts.ts), oldest first, bounded. Per fact: ONE LIVE run
 *      (unique liveKey — a second wake resumes it, never duplicates it),
 *      recipients resolved and capped (over maxRecipientsPerRun ⇒ HALTED +
 *      auto-pause STORM_BREAKER), then ONE claim per (recipient, channel) —
 *      the unique idempotencyKey insert IS the claim; a duplicate is `deduped`,
 *      not a suppression. Each claim is evaluated (conditions, account
 *      restriction, the §6.5 lifecycle matrix, dedupe, frequency cap) and is
 *      SUPPRESSED (+ one ledger row) or SCHEDULED at notBefore (delay).
 *   4. DELIVER: due items (SCHEDULED past notBefore, FAILED past nextAttemptAt),
 *      bounded. Each is LEASED (updateMany … WHERE status = its status — count
 *      must be 1, so two passes can never both send it), then EVERYTHING is
 *      re-evaluated fresh — the automation still ACTIVE at the same activated
 *      version, the global freeze (uncached), the fact still readable, the
 *      lifecycle batch, conditions, dedupe, the frequency cap, preferences —
 *      a failure is CANCELLED with its reason. Then IN_APP → createNotification
 *      (in-app only), EMAIL → sendEmail (the environment guard and the
 *      5/hour storm limit apply there; RATE_LIMITED is SUPPRESSED, never
 *      retried). STANDARD retry: 3 attempts (+15 min, +4 h), then DEAD.
 *
 * LOOP PREVENTION: facts are domain AuditLog actions only (facts.ts refuses a
 * comms action); this module writes no AuditLog row and emits no domain event.
 */

import type { PrismaClient } from "@prisma/client";
import type { CommsDefinition, RecipientResolver } from "@/lib/notifications/catalog/types";
import { getCatalogDefinition } from "@/lib/notifications/catalog/definitions";
import { getNotificationDefinition, type NotificationTypeId } from "@/lib/notifications/registry";
import type { NotificationRenderData } from "@/lib/notifications/types";
import { resolveChannelEnabled, type PreferenceOverride } from "@/lib/notifications/preferences";
import type { CommsDeliveryRow, LedgerWriter, SuppressionReason } from "@/lib/notifications/delivery/types";
import { ledgerEnvironment, recordDelivery, type LedgerEnv } from "@/lib/notifications/delivery/record";
import { EMAIL_TEMPLATE_VERSIONS, IN_APP_TEMPLATE_VERSION } from "@/lib/notifications/catalog/definitions";
import type { GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze.core";
import type { UserLifecycleState } from "@/lib/entitlements/beta-lifecycle";
import type { SendEmailFn } from "@/lib/email/send";
import type { CreateNotificationResult, LedgerTag } from "@/lib/notifications/create";
import { liveRenderFor, type LiveContentResolver } from "@/lib/notifications/content/send";
import { emailDataFor } from "@/lib/notifications/channels/email";
import { FACT_SOURCES, readFact, readFactsAfter, type FactReadClient, type TriggerFact } from "./facts";
import {
  countsOf, emptyCounts, engineTriggerAvailable, evaluateConditions, fillDedupeKey, idempotencyKey, isServiceOwnData,
  lifecycleAllows, liveKey, retryDelayMs, type RecipientFacts,
} from "./rules";
import {
  AUTOMATION_LIMITS, ERROR_RATE_BREAKER, GLOBAL_BREAKER, SEND_LEASE_MS,
  type AutomationChannel, type AutomationRunCounts, type Condition, type RetryPolicy, type RunItemStatus,
} from "./types";

// ── Ports ─────────────────────────────────────────────────────────────────────

export type EngineDb = Pick<PrismaClient,
  "automationDefinition" | "automationRun" | "automationRunItem" | "auditLog" | "user" | "spaceMember"
  | "platformGrant" | "notificationPreference" | "commsDelivery" | "space">;

export interface EngineDeps {
  db: EngineDb;
  /** readGlobalCostFreeze() — uncached; never throws. */
  freeze(): Promise<GlobalCostFreezeVerdict>;
  /** getBetaLifecycleStatesForUsers — one batch read; never throws (UNKNOWN on failure). */
  lifecycle(userIds: readonly string[]): Promise<Map<string, UserLifecycleState>>;
  /** The email chokepoint (environment guard + storm limit inside). */
  sendEmail: SendEmailFn;
  /** The in-app chokepoint. Called with { inAppOnly, ledgerTag, ledger, content }. */
  createNotification(
    input: { type: NotificationTypeId; userId: string; spaceId?: string | null; data?: NotificationRenderData; auditLogId?: string | null },
    ctx: { inAppOnly: true; ledgerTag: LedgerTag; ledger?: LedgerWriter; content?: LiveContentResolver | null },
  ): Promise<CreateNotificationResult>;
  /** The ledger writer for the engine's own SUPPRESSED / CANCELLED rows. */
  ledger: LedgerWriter;
  /** The live-content resolver (B1). */
  content: LiveContentResolver | null;
  /** Raised once when the global breaker trips (a Platform Ops alert). Never throws. */
  alert?(kind: "COMMS_AUTOMATION_STORM_BREAKER", detail: { accepted: number; paused: number }): Promise<void>;
  env: LedgerEnv;
  appBaseUrl: string | undefined;
  now(): Date;
  /** JobRun id to stamp on LIVE runs (lib/jobs/run.ts currentJobRun). */
  jobRunId?: string | null;
  log?(line: string): void;
}

export interface EngineBudget {
  maxAutomations: number;
  maxFactsPerAutomation: number;
  maxItems: number;
  /** Wall-clock budget for the whole pass; the pass stops between units of work. */
  timeBudgetMs: number;
}

export const DEFAULT_BUDGET: EngineBudget = { maxAutomations: 50, maxFactsPerAutomation: 100, maxItems: 200, timeBudgetMs: 120_000 };

export interface EngineSummary {
  outcome: "COMPLETE" | "PARTIAL" | "SKIPPED";
  skipReason?: string;
  automations: number;
  facts: number;
  runs: number;
  claimed: number;
  deduped: number;
  scheduled: number;
  sent: number;
  suppressed: number;
  cancelled: number;
  failed: number;
  dead: number;
  halted: number;
  autoPaused: number;
  /** > 0 ⇒ work was left for the next wake (the job self-continues). */
  deferred: number;
}

type AutomationRow = Awaited<ReturnType<EngineDb["automationDefinition"]["findFirstOrThrow"]>>;
type ItemRow = Awaited<ReturnType<EngineDb["automationRunItem"]["findFirstOrThrow"]>>;

// ── Shared evaluation (ingest, send-time re-check and the dry run) ────────────

export interface RecipientRow { id: string; email: string | null; emailVerifiedAt: Date | null; createdAt: Date | null; deactivatedAt: Date | null; deletionScheduledAt: Date | null; username?: string | null }

export interface EvalInput {
  automation: Pick<AutomationRow, "id" | "dedupeKeyTemplate" | "frequencyCapMax" | "frequencyCapHours" | "definitionKey"> & { conditions: Condition[]; recipient: RecipientResolver };
  def: CommsDefinition;
  fact: TriggerFact;
  recipientId: string;
  channel: AutomationChannel;
  user: RecipientRow | null;
  grants: readonly string[];
  lifecycle: UserLifecycleState;
  /** Exclude this item from the dedupe check (send-time re-evaluation). */
  selfItemId?: string;
}

/** The §6.6 step-4 checks in order; null = eligible. Reads only (dedupe, frequency cap). */
export async function evaluateEligibility(db: EngineDb, e: EvalInput, now: Date): Promise<SuppressionReason | null> {
  if (!e.user) return "NO_RECIPIENT";
  if (e.user.deactivatedAt || e.user.deletionScheduledAt) return "ACCOUNT_RESTRICTED";
  const facts: RecipientFacts = { emailVerified: e.user.emailVerifiedAt !== null, createdAt: e.user.createdAt, platformGrantAreas: e.grants };
  if (!evaluateConditions(e.automation.conditions, e.fact, facts, now)) return "ELIGIBILITY_FAILED";
  const allowed = lifecycleAllows(
    { consentClass: e.def.consentClass, origin: "AUTOMATION", channel: e.channel, serviceOwnData: isServiceOwnData(e.def, e.automation.recipient) },
    e.lifecycle,
  );
  if (!allowed) return "BETA_LIFECYCLE";
  const dedupeKey = dedupeKeyFor(e);
  const open = await db.automationRunItem.count({
    where: {
      automationId: e.automation.id, dedupeKey, channel: e.channel,
      status: { in: ["SCHEDULED", "SENDING", "SENT", "FAILED"] },
      ...(e.selfItemId ? { id: { not: e.selfItemId } } : {}),
    },
  });
  if (open > 0) return "DEDUPE_OPEN";
  const since = new Date(now.getTime() - e.automation.frequencyCapHours * 3_600_000);
  const recent = await db.commsDelivery.count({
    where: { recipientUserId: e.recipientId, definitionKey: e.def.key, channel: e.channel, status: "ACCEPTED", mode: "LIVE", createdAt: { gte: since } },
  });
  if (recent >= e.automation.frequencyCapMax) return "FREQUENCY_CAP";
  return null;
}

export const dedupeKeyFor = (e: Pick<EvalInput, "automation" | "fact" | "recipientId">) =>
  fillDedupeKey(e.automation.dedupeKeyTemplate, { ...e.fact.payload, recipientId: e.recipientId, definitionKey: e.automation.definitionKey });

/** Resolve the trigger's recipients (bounded at cap + 1, so "over the cap" is observable without reading more). */
export async function resolveRecipients(db: EngineDb, resolver: RecipientResolver, fact: TriggerFact, cap: number): Promise<string[]> {
  switch (resolver.kind) {
    case "EVENT_SUBJECT_USER": return fact.subjectUserId ? [fact.subjectUserId] : [];
    case "EVENT_ACTOR_USER": return fact.actorUserId ? [fact.actorUserId] : [];
    case "SPACE_ROLE": {
      if (!fact.spaceId) return [];
      const rows = await db.spaceMember.findMany({
        where: { spaceId: fact.spaceId, status: "ACTIVE", role: { in: resolver.roles } },
        select: { userId: true }, orderBy: { userId: "asc" }, take: cap + 1,
      });
      return [...new Set(rows.map((r) => r.userId))];
    }
    default:
      // Staff / inbox resolvers are refused on write (rules.ts); an unknown kind resolves to nobody.
      return [];
  }
}

export async function readRecipients(db: EngineDb, ids: readonly string[]): Promise<Map<string, RecipientRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, email: true, emailVerifiedAt: true, createdAt: true, deactivatedAt: true, deletionScheduledAt: true, username: true },
  });
  return new Map(rows.map((r) => [r.id, r as RecipientRow]));
}

export async function readGrantAreas(db: EngineDb, ids: readonly string[], needed: boolean): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!needed || ids.length === 0) return out;
  const rows = await db.platformGrant.findMany({ where: { userId: { in: [...ids] }, status: "ACTIVE" }, select: { userId: true, area: true } });
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), String(r.area)]);
  return out;
}

/** The render data the registry render reads, from the fact (names resolved at send time only, never stored on the item). */
export async function renderDataFor(db: EngineDb, fact: TriggerFact, users: Map<string, RecipientRow>): Promise<NotificationRenderData> {
  const data: Record<string, unknown> = {};
  if (fact.spaceId) {
    const s = await db.space.findUnique({ where: { id: fact.spaceId }, select: { name: true } });
    if (s?.name) data.spaceName = s.name;
  }
  const handle = (id: string | null) => (id ? users.get(id)?.username ?? null : null);
  const actor = handle(fact.actorUserId);
  const subject = handle(fact.subjectUserId);
  if (actor) data.inviterName = actor;
  if (subject) data.memberName = subject;
  for (const k of ["oldRole", "newRole", "role"] as const) if (typeof fact.payload[k] === "string") data[k] = fact.payload[k] as string;
  return data as NotificationRenderData;
}

// ── Ledger rows the engine itself writes (SUPPRESSED / CANCELLED) ─────────────

function engineLedgerRow(deps: EngineDeps, item: { id: string; recipientUserId: string | null; channel: string; attempt: number }, def: CommsDefinition,
  status: "SUPPRESSED" | "CANCELLED", reason: SuppressionReason): CommsDeliveryRow {
  return {
    messageKey: item.id,
    definitionKey: def.key,
    definitionVersion: def.definitionVersion,
    templateVersion: item.channel === "IN_APP" ? IN_APP_TEMPLATE_VERSION : EMAIL_TEMPLATE_VERSIONS.notification,
    channel: item.channel === "IN_APP" ? "IN_APP" : "EMAIL",
    status, reason,
    provider: null, providerMessageId: null,
    attempt: Math.max(1, item.attempt),
    errorCode: null,
    recipientUserId: item.recipientUserId,
    recipientHash: null,
    notificationId: null,
    environment: ledgerEnvironment(deps.env),
    acceptedAt: null,
    automationRunItemId: item.id,
  };
}

// ── The pass ─────────────────────────────────────────────────────────────────

function newSummary(): EngineSummary {
  return { outcome: "COMPLETE", automations: 0, facts: 0, runs: 0, claimed: 0, deduped: 0, scheduled: 0, sent: 0, suppressed: 0, cancelled: 0, failed: 0, dead: 0, halted: 0, autoPaused: 0, deferred: 0 };
}

const isP2002 = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
const asConditions = (v: unknown): Condition[] => (Array.isArray(v) ? (v as Condition[]) : []);
const asResolver = (v: unknown): RecipientResolver => (typeof v === "object" && v !== null ? (v as RecipientResolver) : { kind: "EVENT_SUBJECT_USER" });

async function bumpRun(db: EngineDb, runId: string, f: (c: AutomationRunCounts) => void): Promise<void> {
  const run = await db.automationRun.findUnique({ where: { id: runId }, select: { counts: true } });
  if (!run) return;
  const c = countsOf(run.counts);
  f(c);
  await db.automationRun.update({ where: { id: runId }, data: { counts: c as never } });
}

/** Auto-pause ONE automation (system action: no operator, no audit row — v1 §5.8). Cancels its SCHEDULED items. */
async function autoPause(deps: EngineDeps, a: Pick<AutomationRow, "id" | "definitionKey">, reason: "DEFINITION_CHANGED" | "STORM_BREAKER" | "ERROR_RATE" | "TRIGGER_RETIRED", s: EngineSummary): Promise<void> {
  const now = deps.now();
  const r = await deps.db.automationDefinition.updateMany({
    where: { id: a.id, state: "ACTIVE" },
    data: { state: "PAUSED", autoPausedReason: reason, pausedAt: now, version: { increment: 1 } },
  });
  if (r.count === 1) {
    s.autoPaused++;
    await cancelScheduled(deps, { automationId: a.id }, "AUTOMATION_PAUSED", s);
  }
}

/** Cancel SCHEDULED items (one ledger row each). Bounded per call; the rest is cancelled at send time anyway. */
export async function cancelScheduled(deps: EngineDeps, where: { automationId?: string }, reason: SuppressionReason, s?: EngineSummary): Promise<number> {
  const items = await deps.db.automationRunItem.findMany({ where: { status: "SCHEDULED", ...where }, take: 500 });
  let n = 0;
  for (const it of items) {
    const r = await deps.db.automationRunItem.updateMany({ where: { id: it.id, status: "SCHEDULED" }, data: { status: "CANCELLED", reason, leaseUntil: null, lastDeliveryStatus: "CANCELLED" } });
    if (r.count !== 1) continue;
    n++;
    const def = getCatalogDefinition((await deps.db.automationDefinition.findUnique({ where: { id: it.automationId }, select: { definitionKey: true } }))?.definitionKey ?? "");
    if (def) await recordDelivery(deps.ledger, engineLedgerRow(deps, it, def, "CANCELLED", reason));
    await bumpRun(deps.db, it.runId, (c) => { c.cancelled++; });
  }
  if (s) s.cancelled += n;
  return n;
}

/** Halt every RUNNING LIVE run and cancel every SCHEDULED item (freeze / global breaker). */
async function haltAll(deps: EngineDeps, reason: "PROVIDER_FREEZE" | "STORM_BREAKER", s: EngineSummary): Promise<void> {
  const now = deps.now();
  const runs = await deps.db.automationRun.updateMany({ where: { mode: "LIVE", status: "RUNNING" }, data: { status: "HALTED", haltReason: reason, completedAt: now } });
  s.halted += runs.count;
  await cancelScheduled(deps, {}, reason, s);
}

export async function runAutomationEngine(deps: EngineDeps, budget: EngineBudget = DEFAULT_BUDGET): Promise<EngineSummary> {
  const s = newSummary();
  const started = deps.now().getTime();
  const outOfTime = () => deps.now().getTime() - started > budget.timeBudgetMs;
  const db = deps.db;

  // 0. Resume: expired leases go back to SCHEDULED (a crash mid-send never strands an item).
  await db.automationRunItem.updateMany({ where: { status: "SENDING", leaseUntil: { lt: deps.now() } }, data: { status: "SCHEDULED", leaseUntil: null } });

  // 1. The GLOBAL cost freeze halts live runs (D1) — before anything is resolved or sent.
  let fr: GlobalCostFreezeVerdict;
  try { fr = await deps.freeze(); } catch { fr = { frozen: true, state: "UNAVAILABLE", reason: "POLICY_UNAVAILABLE" }; }
  if (fr.frozen) {
    await haltAll(deps, "PROVIDER_FREEZE", s);
    return { ...s, outcome: "SKIPPED", skipReason: `BILLABLE_${fr.reason ?? "POLICY_UNAVAILABLE"}` };
  }

  // 2. The global breaker (v1.1 §6.7).
  const windowStart = new Date(deps.now().getTime() - GLOBAL_BREAKER.windowMinutes * 60_000);
  const accepted = await db.commsDelivery.count({ where: { automationRunItemId: { not: null }, status: "ACCEPTED", mode: "LIVE", createdAt: { gte: windowStart } } });
  if (accepted > GLOBAL_BREAKER.maxAccepted) {
    const active = await db.automationDefinition.findMany({ where: { state: "ACTIVE" }, select: { id: true, definitionKey: true } });
    for (const a of active) await autoPause(deps, a, "STORM_BREAKER", s);
    await haltAll(deps, "STORM_BREAKER", s);
    try { await deps.alert?.("COMMS_AUTOMATION_STORM_BREAKER", { accepted, paused: s.autoPaused }); } catch { /* an alert failure never fails the pass */ }
    return { ...s, outcome: "PARTIAL" };
  }

  // 3. Ingest.
  const active = await db.automationDefinition.findMany({ where: { state: "ACTIVE" }, orderBy: [{ activatedAt: "asc" }, { id: "asc" }], take: budget.maxAutomations + 1 });
  if (active.length > budget.maxAutomations) s.deferred++;
  for (const a of active.slice(0, budget.maxAutomations)) {
    if (outOfTime()) { s.deferred++; break; }
    s.automations++;
    const def = getCatalogDefinition(a.definitionKey);
    if (!def || def.definitionVersion !== a.definitionVersion) { await autoPause(deps, a, "DEFINITION_CHANGED", s); continue; }
    const trigger = a.triggerKey as TriggerFact["triggerKey"];
    if (!engineTriggerAvailable(trigger) || !FACT_SOURCES[trigger]) { await autoPause(deps, a, "TRIGGER_RETIRED", s); continue; }
    if (await errorRateTripped(db, a.id, deps.now())) { await autoPause(deps, a, "ERROR_RATE", s); continue; }
    const cursor = { at: a.triggerCursorAt ?? a.activatedAt ?? deps.now(), id: a.triggerCursorId };
    const facts = await readFactsAfter(db as unknown as FactReadClient, trigger, cursor, budget.maxFactsPerAutomation);
    if (facts.length === budget.maxFactsPerAutomation) s.deferred++;
    for (const fact of facts) {
      if (outOfTime()) { s.deferred++; break; }
      s.facts++;
      const stop = await ingestFact(deps, a, def, fact, s);
      // Advance the cursor ONLY while this activation is still the live one (a pause / re-activation resets it).
      await db.automationDefinition.updateMany({
        where: { id: a.id, state: "ACTIVE", activatedVersion: a.activatedVersion },
        data: { triggerCursorAt: fact.occurredAt, triggerCursorId: fact.ref },
      });
      if (stop) break;
    }
  }

  // 4. Deliver.
  const due = await db.automationRunItem.findMany({
    where: { OR: [{ status: "SCHEDULED", notBefore: { lte: deps.now() } }, { status: "FAILED", nextAttemptAt: { lte: deps.now() } }] },
    orderBy: [{ notBefore: "asc" }, { id: "asc" }],
    take: budget.maxItems + 1,
  });
  if (due.length > budget.maxItems) s.deferred++;
  const batch = due.slice(0, budget.maxItems);
  // ONE lifecycle read for the delivery batch, immediately before it (§6.6 at-send step 2).
  const lifecycle = await deps.lifecycle([...new Set(batch.map((i) => i.recipientUserId).filter((x): x is string => !!x))]);
  for (const item of batch) {
    if (outOfTime()) { s.deferred++; break; }
    await deliverItem(deps, item, lifecycle, s);
  }

  return { ...s, outcome: s.deferred > 0 ? "PARTIAL" : "COMPLETE" };
}

async function errorRateTripped(db: EngineDb, automationId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - ERROR_RATE_BREAKER.windowMinutes * 60_000);
  const attempts = await db.automationRunItem.count({ where: { automationId, attempt: { gt: 0 }, updatedAt: { gte: since } } });
  if (attempts < ERROR_RATE_BREAKER.minAttempts) return false;
  const failed = await db.automationRunItem.count({ where: { automationId, status: { in: ["FAILED", "DEAD"] }, updatedAt: { gte: since } } });
  return failed / attempts > ERROR_RATE_BREAKER.maxFailedFraction;
}

/** Ingest ONE fact for ONE automation. Returns true when the automation was paused (stop its scan). */
async function ingestFact(deps: EngineDeps, a: AutomationRow, def: CommsDefinition, fact: TriggerFact, s: EngineSummary): Promise<boolean> {
  const db = deps.db;
  const now = deps.now();
  const activated = a.activatedVersion ?? a.version;
  const key = liveKey({ automationId: a.id, activatedVersion: activated, triggerRef: fact.ref });
  let run = await db.automationRun.findUnique({ where: { liveKey: key } });
  if (run && run.status !== "RUNNING") return false; // this fact was fully ingested by an earlier wake
  if (!run) {
    try {
      run = await db.automationRun.create({
        data: { automationId: a.id, automationVersion: activated, mode: "LIVE", triggerKey: a.triggerKey, triggerRef: fact.ref, liveKey: key, status: "RUNNING", counts: emptyCounts() as never, jobRunId: deps.jobRunId ?? null },
      });
      s.runs++;
    } catch (e) {
      if (!isP2002(e)) throw e;
      run = await db.automationRun.findUnique({ where: { liveKey: key } });
      if (!run || run.status !== "RUNNING") return false;
    }
  }
  const counts = countsOf(run.counts);
  const resolver = asResolver(a.recipient);
  const conditions = asConditions(a.conditions);
  const recipients = await resolveRecipients(db, resolver, fact, a.maxRecipientsPerRun);
  counts.matched = recipients.length;
  if (recipients.length > a.maxRecipientsPerRun) {
    await db.automationRun.update({ where: { id: run.id }, data: { status: "HALTED", haltReason: "STORM_BREAKER", counts: counts as never, completedAt: now } });
    s.halted++;
    await autoPause(deps, a, "STORM_BREAKER", s);
    return true;
  }
  const lifecycle = await deps.lifecycle(recipients);
  const users = await readRecipients(db, recipients);
  const grants = await readGrantAreas(db, recipients, conditions.some((c) => c.op === "recipient.has_platform_grant"));
  const channels = (a.channels as AutomationChannel[]).filter((c) => c === "EMAIL" || c === "IN_APP");
  let deduped = 0;
  for (const r of recipients) {
    for (const channel of channels) {
      const evalIn: EvalInput = {
        automation: { ...a, conditions, recipient: resolver }, def, fact, recipientId: r, channel,
        user: users.get(r) ?? null, grants: grants.get(r) ?? [], lifecycle: lifecycle.get(r) ?? "UNKNOWN",
      };
      const idem = idempotencyKey({ automationId: a.id, activatedVersion: activated, triggerRef: fact.ref, recipientId: r, channel });
      // A claim that already exists (a resumed run, a replayed fact) is a no-op BEFORE any evaluation.
      if (await db.automationRunItem.findUnique({ where: { idempotencyKey: idem }, select: { id: true } })) { deduped++; continue; }
      const reason = await evaluateEligibility(db, evalIn, now);
      const notBefore = a.delayMinutes ? new Date(Math.max(now.getTime(), fact.occurredAt.getTime() + a.delayMinutes * 60_000)) : now;
      let item: ItemRow;
      try {
        item = await db.automationRunItem.create({
          data: {
            runId: run.id, automationId: a.id, automationVersion: activated, channel, recipientUserId: r, idempotencyKey: idem,
            dedupeKey: dedupeKeyFor(evalIn), triggerRef: fact.ref,
            status: reason ? "SUPPRESSED" : "SCHEDULED", reason, notBefore, lastDeliveryStatus: reason ? "SUPPRESSED" : "SCHEDULED",
          },
        });
      } catch (e) {
        if (!isP2002(e)) throw e;
        deduped++; // a concurrent pass took the claim: counted as deduped, never as a suppression
        continue;
      }
      s.claimed++;
      if (reason) {
        counts.suppressed[reason]++;
        s.suppressed++;
        await recordDelivery(deps.ledger, engineLedgerRow(deps, { ...item, attempt: 1 }, def, "SUPPRESSED", reason));
      } else {
        counts.eligible++;
        counts.scheduled++;
        s.scheduled++;
      }
    }
  }
  s.deduped += deduped;
  await db.automationRun.update({
    where: { id: run.id },
    data: { status: "SUCCEEDED", counts: counts as never, dedupedCount: { increment: deduped }, completedAt: now },
  });
  return false;
}

/** Deliver (or cancel) ONE due item. Never throws for a send outcome. */
async function deliverItem(deps: EngineDeps, item: ItemRow, lifecycle: Map<string, UserLifecycleState>, s: EngineSummary): Promise<void> {
  const db = deps.db;
  const now = deps.now();
  // Lease: exactly one pass may take it.
  const leased = await db.automationRunItem.updateMany({
    where: { id: item.id, status: item.status, attempt: item.attempt },
    data: { status: "SENDING", leaseUntil: new Date(now.getTime() + SEND_LEASE_MS), attempt: { increment: 1 } },
  });
  if (leased.count !== 1) return;
  const attempt = item.attempt + 1;
  const cur = { ...item, attempt };

  const finish = async (status: RunItemStatus, data: { reason?: SuppressionReason | null; lastDeliveryStatus: string; nextAttemptAt?: Date | null }) => {
    await db.automationRunItem.update({
      where: { id: item.id },
      data: { status, reason: data.reason ?? null, leaseUntil: null, lastDeliveryStatus: data.lastDeliveryStatus, nextAttemptAt: data.nextAttemptAt ?? null },
    });
  };

  const a = await db.automationDefinition.findUnique({ where: { id: item.automationId } });
  const def = a ? getCatalogDefinition(a.definitionKey) : undefined;
  const cancel = async (reason: SuppressionReason) => {
    await finish("CANCELLED", { reason, lastDeliveryStatus: "CANCELLED" });
    if (def) await recordDelivery(deps.ledger, engineLedgerRow(deps, cur, def, "CANCELLED", reason));
    await bumpRun(db, item.runId, (c) => { c.cancelled++; });
    s.cancelled++;
  };
  const suppress = async (reason: SuppressionReason, ledgerWritten: boolean) => {
    await finish("SUPPRESSED", { reason, lastDeliveryStatus: "SUPPRESSED" });
    if (def && !ledgerWritten) await recordDelivery(deps.ledger, engineLedgerRow(deps, cur, def, "SUPPRESSED", reason));
    await bumpRun(db, item.runId, (c) => { c.suppressed[reason]++; });
    s.suppressed++;
  };

  // ── Re-evaluate everything, freshly (§6.6 at-send step 2) ──
  if (!a || !def || a.state !== "ACTIVE" || a.activatedVersion !== item.automationVersion) return cancel("AUTOMATION_PAUSED");
  let fr: GlobalCostFreezeVerdict;
  try { fr = await deps.freeze(); } catch { fr = { frozen: true, state: "UNAVAILABLE", reason: "POLICY_UNAVAILABLE" }; }
  if (fr.frozen) return cancel("PROVIDER_FREEZE");
  if (!item.recipientUserId || !item.triggerRef) return cancel("NO_RECIPIENT");
  const fact = await readFact(db as unknown as FactReadClient, a.triggerKey as TriggerFact["triggerKey"], item.triggerRef);
  if (!fact) return cancel("OBSOLETE");
  const resolver = asResolver(a.recipient);
  const conditions = asConditions(a.conditions);
  const users = await readRecipients(db, [item.recipientUserId, ...(fact.actorUserId ? [fact.actorUserId] : []), ...(fact.subjectUserId ? [fact.subjectUserId] : [])]);
  const grants = await readGrantAreas(db, [item.recipientUserId], conditions.some((c) => c.op === "recipient.has_platform_grant"));
  const channel = item.channel as AutomationChannel;
  const reason = await evaluateEligibility(db, {
    automation: { ...a, conditions, recipient: resolver }, def, fact, recipientId: item.recipientUserId, channel,
    user: users.get(item.recipientUserId) ?? null, grants: grants.get(item.recipientUserId) ?? [],
    lifecycle: lifecycle.get(item.recipientUserId) ?? "UNKNOWN", selfItemId: item.id,
  }, now);
  if (reason) return cancel(reason);

  const type = def.notificationTypeId as NotificationTypeId;
  const reg = getNotificationDefinition(type);
  if (!reg) return cancel("OBSOLETE");
  const data = await renderDataFor(db, fact, users);
  const policy = (a.retryPolicy === "NONE" ? "NONE" : "STANDARD") as RetryPolicy;
  const nextDelay = retryDelayMs(policy, attempt);
  const failed = async () => {
    if (nextDelay === null) {
      await finish("DEAD", { lastDeliveryStatus: "DEAD" });
      await bumpRun(db, item.runId, (c) => { c.failed++; });
      s.dead++;
    } else {
      await finish("FAILED", { lastDeliveryStatus: "FAILED", nextAttemptAt: new Date(now.getTime() + nextDelay) });
      s.failed++;
    }
  };

  if (channel === "IN_APP") {
    const res = await deps.createNotification(
      { type, userId: item.recipientUserId, spaceId: fact.spaceId, data, auditLogId: fact.ref },
      { inAppOnly: true, ledgerTag: { messageKey: item.id, automationRunItemId: item.id, attempt }, ledger: deps.ledger, content: deps.content },
    );
    if (res.status === "created") {
      await finish("SENT", { lastDeliveryStatus: "ACCEPTED" });
      await bumpRun(db, item.runId, (c) => { c.accepted++; });
      s.sent++;
      return;
    }
    // createNotification recorded these outcomes itself (tagged with this item).
    if (res.status === "suppressed") return suppress("DEDUPE_OPEN", true);
    if (res.status === "skipped") return suppress("PREFERENCE_OFF", true);
    return failed();
  }

  // EMAIL: the category's EMAIL preference (AWARENESS / SERVICE), then the address, then the chokepoint.
  let overrides: PreferenceOverride[] = [];
  if (!reg.locked) {
    try {
      overrides = await db.notificationPreference.findMany({ where: { userId: item.recipientUserId }, select: { category: true, channel: true, enabled: true } }) as PreferenceOverride[];
    } catch {
      await finish("FAILED", { lastDeliveryStatus: "FAILED", nextAttemptAt: nextDelay === null ? null : new Date(now.getTime() + nextDelay) });
      s.failed++;
      return;
    }
  }
  if (!resolveChannelEnabled(reg, "EMAIL", overrides)) return suppress("PREFERENCE_OFF", false);
  const email = users.get(item.recipientUserId)?.email ?? null;
  if (!email) return suppress("NO_RECIPIENT", false);
  const code = reg.render(data);
  const live = await liveRenderFor({ type, data, codeRendered: code, resolver: deps.content, appBaseUrl: deps.appBaseUrl });
  const { data: emailData, contentVersionId } = emailDataFor({
    userId: item.recipientUserId, email, type, category: reg.category, priority: reg.priority,
    title: code.title, ...(code.body ? { body: code.body } : {}), ...(code.href ? { href: code.href } : {}),
    ...(code.actionLabel ? { actionLabel: code.actionLabel } : {}), ...(live.email ? { emailContent: live.email } : {}),
  }, deps.appBaseUrl);
  const result = await deps.sendEmail("notification", email, { ...emailData }, {
    key: def.key, recipientUserId: item.recipientUserId, messageKey: item.id, attempt,
    ...(nextDelay === null ? { terminalOnError: true } : {}),
    ...(contentVersionId ? { contentVersionId } : {}),
    automationRunItemId: item.id,
  });
  if (result.status === "sent" || result.status === "captured") {
    await finish("SENT", { lastDeliveryStatus: result.status === "sent" ? "ACCEPTED" : "CAPTURED" });
    await bumpRun(db, item.runId, (c) => { if (result.status === "sent") c.accepted++; else c.captured++; });
    s.sent++;
    return;
  }
  // The storm limit (RATE_LIMITED / RATE_LIMIT_UNVERIFIED): SUPPRESSED, never retried. sendEmail recorded the row.
  if (result.status === "skipped") return suppress(result.reason ?? "NO_RECIPIENT", true);
  return failed();
}

/** Bounds used by the job, exported for the job health / tests. */
export const ENGINE_LIMITS = { ...DEFAULT_BUDGET, maxRecipientsCeiling: AUTOMATION_LIMITS.maxRecipientsCeiling };
