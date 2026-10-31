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
 *
 * HARDENING (review of #187 — A1–A9, N1–N11):
 *   A1  the provider Idempotency-Key is the item id (no attempt suffix); every
 *       post-send write is wrapped, so a bookkeeping failure never re-sends; an
 *       expired SENDING lease whose ACCEPTED/CAPTURED ledger row exists is SENT,
 *       never re-sent (step 0);
 *   A2  the frequency cap counts this automation's own SENT items (written inline)
 *       and, at ingest, its pending claims — the ledger is written after the
 *       response and is blind within a pass;
 *   A3  a per-trigger at-send predicate (factStillHolds): the membership / invite /
 *       Space the fact describes still holds, else CANCELLED / OBSOLETE;
 *   A4  ingest AND send require definitionSendable() (not protected, automatable,
 *       same definitionVersion), else auto-pause DEFINITION_CHANGED;
 *   A5  platform admission (COMMS_AUTOMATION_SEND) at trigger and before every
 *       send: a denial SKIPS (nothing sent, nothing cancelled);
 *   A6  the IN_APP leg dedupes against the EV-1 handler's bell for the same fact;
 *   N1  the breaker counts SENT items + this pass's sends, before every send;
 *   N2  facts younger than FACT_SETTLE_MS wait for the next wake;
 *   N3  per-automation and per-item try/catch (`errors`);
 *   N4  facts older than MAX_FACT_AGE_MS are skipped; items later than
 *       MAX_SEND_LATENESS_MS are OBSOLETE; haltAll also cancels FAILED items;
 *   N5  automations are taken least-recently-scanned first (cursor order);
 *   N6  DEDUPE_OPEN never looks back further than the 90-day retention.
 *
 * PRE-FLIP (Session 2's re-review of #190 — R1–R4; preflip.test.ts):
 *   R1  at send the recipient must still be one the resolver picks (recipientStillResolves): a
 *       SPACE_ROLE recipient still holds one of its roles, an EVENT_ACTOR_USER still a member;
 *   R2  the frequency cap counts EVERY automation of the same definition, not only this one;
 *   R3  lease recovery also accepts the IN_APP bell itself (auditLogId = the fact) — the in-app
 *       ledger row is deferred, so a kill after createNotification leaves none;
 *   R4  a provider idempotency conflict on a retry (Resend 409 invalid_idempotent_request) is SENT
 *       with reason UNCERTAIN_ACCEPTANCE — never DEAD, never re-sent.
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
  automatableChannels, countsOf, definitionSendable, emptyCounts, engineTriggerAvailable, evaluateConditions, fillDedupeKey, idempotencyKey, isServiceOwnData,
  lifecycleAllows, liveKey, retryDelayMs, type RecipientFacts,
} from "./rules";
import {
  ACTIVATION_DISABLED_REASON, AUTOMATION_ACTIVATION_ENABLED, AUTOMATION_LIMITS, AUTOMATION_RETENTION_DAYS, ERROR_RATE_BREAKER, FACT_SETTLE_MS, GLOBAL_BREAKER,
  HANDLER_BELL_WINDOW, MAX_FACT_AGE_MS, MAX_SEND_LATENESS_MS, SEND_LEASE_MS,
  type AutomationChannel, type AutomationRunCounts, type Condition, type RetryPolicy, type RunItemStatus,
} from "./types";

// ── Ports ─────────────────────────────────────────────────────────────────────

export type EngineDb = Pick<PrismaClient,
  "automationDefinition" | "automationRun" | "automationRunItem" | "auditLog" | "user" | "spaceMember"
  | "platformGrant" | "notificationPreference" | "commsDelivery" | "space" | "spaceInvite" | "notification">;

/** HARDENING A5 — the admission port's verdict (lib/notifications/automations/admission.ts in production). */
export interface EngineAdmission { admitted: boolean; reason: string | null }

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
  /**
   * HARDENING A5 — platform admission for COMMS_AUTOMATION_SEND (maintenance / an unreadable control
   * plane deny). Asked at trigger (before ingest) and before every send. A throw counts as a denial.
   */
  admission(): Promise<EngineAdmission>;
  /** The ACTIVATION HARD GATE (types.ts); absent ⇒ the code constant. While false the engine sends nothing. */
  activationEnabled?: boolean;
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
  /** HARDENING A1 — expired SENDING leases whose provider acceptance was already recorded: marked SENT, not re-sent. */
  recovered: number;
  /** HARDENING N4 — facts skipped because they were older than MAX_FACT_AGE_MS when first read. */
  staleFacts: number;
  /** HARDENING N3 — units of work (an automation's scan, one item) that threw; the rest of the batch continued. */
  errors: number;
  /**
   * Session 2's request — the pass did nothing because the ACTIVATION HARD GATE is closed and nothing is
   * ACTIVE or pending. Reported as a NOTE (outcome COMPLETE), not a SKIPPED run: a skip would pin the ops
   * overview's jobs domain at DEGRADED for as long as the gate stays closed by design.
   */
  note?: "ACTIVATION_DISABLED";
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

/**
 * The §6.6 step-4 checks in order; null = eligible. Reads only (fact still holds, dedupe, frequency cap).
 *
 * Two phases: INGEST (no `selfItemId`) and SEND (the item's own id). The frequency cap counts,
 * besides the ledger's LIVE ACCEPTED rows for the definition (registry / direct sends and other
 * automations), this automation's OWN SENT items in the window (A2 — written inline, so a pass
 * sees its own earlier sends), and at INGEST also its pending claims (they are about to send).
 */
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
  // A3 — the state the fact describes still holds (membership, invite, Space).
  if (!(await factStillHolds(db, e.fact, e.recipientId, now))) return "OBSOLETE";
  // PRE-FLIP R1 — the recipient is still one the resolver would pick (a demoted admin, a removed inviter: OBSOLETE).
  if (!(await recipientStillResolves(db, e.automation.recipient, e.fact, e.recipientId))) return "OBSOLETE";
  const dedupeKey = dedupeKeyFor(e);
  const open = await db.automationRunItem.count({
    where: {
      automationId: e.automation.id, dedupeKey, channel: e.channel,
      status: { in: ["SCHEDULED", "SENDING", "SENT", "FAILED"] },
      // N6 — never older than the retention window (the run and its items are deleted then anyway).
      createdAt: { gte: new Date(now.getTime() - AUTOMATION_RETENTION_DAYS * 86_400_000) },
      ...(e.selfItemId ? { id: { not: e.selfItemId } } : {}),
    },
  });
  if (open > 0) return "DEDUPE_OPEN";
  if ((await frequencyCount(db, e, now)) >= e.automation.frequencyCapMax) return "FREQUENCY_CAP";
  return null;
}

/**
 * A2 — sends of this definition to this recipient on this channel in the cap window (see evaluateEligibility).
 *
 * PRE-FLIP R2 — the cap is per DEFINITION, not per automation: the SENT items (and, at ingest, the pending
 * claims) of EVERY automation on the same definitionKey count — any state, so a sibling paused after it sent
 * still holds the cap. Chosen over "one ACTIVE automation per definition × channel at activation" because
 * that refusal alone would not see a sibling's sends that are still inside the window after it was paused
 * (or a second activation racing the first); the count is the cap's actual meaning and covers both.
 */
async function frequencyCount(db: EngineDb, e: EvalInput, now: Date): Promise<number> {
  const since = new Date(now.getTime() - e.automation.frequencyCapHours * 3_600_000);
  const siblings = await db.automationDefinition.findMany({ where: { definitionKey: e.def.key }, select: { id: true } });
  const automationIds = [...new Set([e.automation.id, ...siblings.map((r) => r.id)])];
  const mine = { automationId: { in: automationIds }, recipientUserId: e.recipientId, channel: e.channel };
  const ownSent = await db.automationRunItem.findMany({
    where: { ...mine, status: "SENT", updatedAt: { gte: since } },
    select: { id: true }, take: AUTOMATION_LIMITS.frequencyMaxCeiling + 1,
  });
  const pending = e.selfItemId ? 0 : await db.automationRunItem.count({ where: { ...mine, status: { in: ["SCHEDULED", "SENDING", "FAILED"] } } });
  // The ledger rows of these automations' own sends are already counted above (never twice).
  const ownIds = ownSent.map((r) => r.id);
  const ledger = await db.commsDelivery.count({
    where: {
      recipientUserId: e.recipientId, definitionKey: e.def.key, channel: e.channel, status: "ACCEPTED", mode: "LIVE", createdAt: { gte: since },
      ...(ownIds.length > 0 ? { OR: [{ automationRunItemId: null }, { automationRunItemId: { notIn: ownIds } }] } : {}),
    },
  });
  return ownSent.length + pending + ledger;
}

/**
 * A3 — PER-TRIGGER at-send predicate: is the state this fact describes still true? false ⇒ OBSOLETE.
 * A delayed "your role changed" after the member was removed, an invitation reminder after the
 * invite was accepted / declined / expired, anything about a trashed or deleted Space — never sent.
 */
export async function factStillHolds(db: EngineDb, fact: TriggerFact, recipientId: string, now: Date): Promise<boolean> {
  if (!fact.spaceId || !fact.subjectUserId) return false;
  const space = await db.space.findUnique({ where: { id: fact.spaceId }, select: { id: true, deletedAt: true } });
  if (!space || space.deletedAt) return false;
  const member = async (userId: string) =>
    db.spaceMember.findFirst({ where: { spaceId: fact.spaceId!, userId, status: "ACTIVE" }, select: { role: true } });
  switch (fact.triggerKey) {
    case "space.member.invited": {
      const inv = await db.spaceInvite.findFirst({ where: { spaceId: fact.spaceId, invitedUserId: fact.subjectUserId }, select: { status: true, expiresAt: true } });
      return !!inv && inv.status === "PENDING" && (inv.expiresAt === null || inv.expiresAt > now);
    }
    case "space.member.joined": {
      if (!(await member(fact.subjectUserId))) return false;
      return recipientId === fact.subjectUserId || !!(await member(recipientId));
    }
    case "space.member.role_changed": {
      const m = await member(fact.subjectUserId);
      if (!m) return false;
      const newRole = fact.payload.newRole;
      if (typeof newRole === "string" && String(m.role) !== newRole) return false;
      return recipientId === fact.subjectUserId || !!(await member(recipientId));
    }
    case "space.member.removed":
      // Re-added since ⇒ "you were removed" is no longer true.
      return !(await member(fact.subjectUserId));
    default:
      // A trigger without a predicate here is never sent (fail closed): add its predicate with its fact source.
      return false;
  }
}

/**
 * PRE-FLIP R1 — the recipient must STILL be one the resolver would pick, at send as at ingest:
 *   SPACE_ROLE          an ACTIVE member of the fact's Space whose CURRENT role is in resolver.roles
 *                       (an admin demoted during the delay no longer gets "X joined");
 *   EVENT_ACTOR_USER    the fact's actor, still an ACTIVE member of the Space (a removed inviter gets nothing);
 *   EVENT_SUBJECT_USER  the fact's subject (the per-trigger predicate above judges their membership).
 * Any other kind resolves to nobody (fail closed), as resolveRecipients does.
 */
export async function recipientStillResolves(db: EngineDb, resolver: RecipientResolver, fact: TriggerFact, recipientId: string): Promise<boolean> {
  if (!fact.spaceId) return false;
  const active = () => db.spaceMember.findFirst({ where: { spaceId: fact.spaceId!, userId: recipientId, status: "ACTIVE" }, select: { role: true } });
  switch (resolver.kind) {
    case "EVENT_SUBJECT_USER": return recipientId === fact.subjectUserId;
    case "EVENT_ACTOR_USER": return recipientId === fact.actorUserId && !!(await active());
    case "SPACE_ROLE": {
      const m = await active();
      return !!m && (resolver.roles as readonly string[]).includes(String(m.role));
    }
    default: return false;
  }
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
  return { outcome: "COMPLETE", automations: 0, facts: 0, runs: 0, claimed: 0, deduped: 0, scheduled: 0, sent: 0, suppressed: 0, cancelled: 0, failed: 0, dead: 0, halted: 0, autoPaused: 0, deferred: 0, recovered: 0, staleFacts: 0, errors: 0 };
}

const isP2002 = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
const asConditions = (v: unknown): Condition[] => (Array.isArray(v) ? (v as Condition[]) : []);
const asResolver = (v: unknown): RecipientResolver => (typeof v === "object" && v !== null ? (v as RecipientResolver) : { kind: "EVENT_SUBJECT_USER" });
/** One fixed, redacted line per swallowed error: the error CLASS only (a driver message can quote values). */
const errName = (e: unknown) => (e instanceof Error ? e.name : "Error");
const logOf = (deps: EngineDeps) => deps.log ?? ((l: string) => console.error(l));

async function bumpRun(db: EngineDb, runId: string, f: (c: AutomationRunCounts) => void): Promise<void> {
  const run = await db.automationRun.findUnique({ where: { id: runId }, select: { counts: true } });
  if (!run) return;
  const c = countsOf(run.counts);
  f(c);
  await db.automationRun.update({ where: { id: runId }, data: { counts: c as never } });
}

/** A1 — run counts are bookkeeping: a failure to bump them never fails (or repeats) a send. */
async function safeBump(deps: EngineDeps, runId: string, f: (c: AutomationRunCounts) => void, s: EngineSummary): Promise<void> {
  try { await bumpRun(deps.db, runId, f); } catch (e) { s.errors++; logOf(deps)(`[comms-automations] run counts not updated (non-fatal): ${errName(e)}`); }
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

/**
 * Cancel SCHEDULED items — and, for a run-level halt (N4), FAILED items awaiting a retry — one
 * ledger row each. Bounded per call; anything left is cancelled at send time anyway.
 */
export async function cancelScheduled(deps: EngineDeps, where: { automationId?: string }, reason: SuppressionReason, s?: EngineSummary, statuses: readonly ("SCHEDULED" | "FAILED")[] = ["SCHEDULED"]): Promise<number> {
  const items = await deps.db.automationRunItem.findMany({ where: { status: { in: [...statuses] }, ...where }, take: 500 });
  let n = 0;
  for (const it of items) {
    const r = await deps.db.automationRunItem.updateMany({ where: { id: it.id, status: it.status }, data: { status: "CANCELLED", reason, leaseUntil: null, nextAttemptAt: null, lastDeliveryStatus: "CANCELLED", updatedAt: deps.now() } });
    if (r.count !== 1) continue;
    n++;
    const def = getCatalogDefinition((await deps.db.automationDefinition.findUnique({ where: { id: it.automationId }, select: { definitionKey: true } }))?.definitionKey ?? "");
    if (def) await recordDelivery(deps.ledger, engineLedgerRow(deps, it, def, "CANCELLED", reason));
    await bumpRun(deps.db, it.runId, (c) => { c.cancelled++; });
  }
  if (s) s.cancelled += n;
  return n;
}

/** Halt every RUNNING LIVE run and cancel every SCHEDULED item and every FAILED item awaiting retry (freeze / global breaker). */
async function haltAll(deps: EngineDeps, reason: "PROVIDER_FREEZE" | "STORM_BREAKER", s: EngineSummary): Promise<void> {
  const now = deps.now();
  const runs = await deps.db.automationRun.updateMany({ where: { mode: "LIVE", status: "RUNNING" }, data: { status: "HALTED", haltReason: reason, completedAt: now } });
  s.halted += runs.count;
  await cancelScheduled(deps, {}, reason, s, ["SCHEDULED", "FAILED"]);
}

/** A5 — the admission port, fail closed (a throw is a denial). */
async function admitted(deps: EngineDeps): Promise<EngineAdmission> {
  try { return await deps.admission(); } catch { return { admitted: false, reason: "UNAVAILABLE" }; }
}

/** N1 — accepted automation sends in the breaker window: the engine's own SENT items (written inline, so never blind). */
async function breakerCount(db: EngineDb, now: Date): Promise<number> {
  const since = new Date(now.getTime() - GLOBAL_BREAKER.windowMinutes * 60_000);
  return db.automationRunItem.count({ where: { status: "SENT", lastDeliveryStatus: "ACCEPTED", updatedAt: { gte: since } } });
}

async function tripBreaker(deps: EngineDeps, accepted: number, s: EngineSummary): Promise<void> {
  const active = await deps.db.automationDefinition.findMany({ where: { state: "ACTIVE" }, select: { id: true, definitionKey: true } });
  for (const a of active) await autoPause(deps, a, "STORM_BREAKER", s);
  await haltAll(deps, "STORM_BREAKER", s);
  try { await deps.alert?.("COMMS_AUTOMATION_STORM_BREAKER", { accepted, paused: s.autoPaused }); } catch { /* an alert failure never fails the pass */ }
}

/**
 * Step 0 (A1) — an expired SENDING lease: if the provider's acceptance was already RECORDED for
 * this item (an ACCEPTED / CAPTURED ledger row tagged with it), the send happened and only the
 * bookkeeping was lost (finish threw, or the function was killed at its limit) ⇒ SENT, never
 * re-sent. Otherwise it returns to SCHEDULED; the re-send carries the SAME provider
 * Idempotency-Key (the item id), so a provider acceptance the ledger never saw is not repeated.
 */
async function recoverLeases(deps: EngineDeps, s: EngineSummary): Promise<void> {
  const db = deps.db;
  const now = deps.now();
  const expired = await db.automationRunItem.findMany({ where: { status: "SENDING", leaseUntil: { lt: now } }, take: 500 });
  for (const it of expired) {
    try {
      const done = await db.commsDelivery.findFirst({
        where: { automationRunItemId: it.id, status: { in: ["ACCEPTED", "CAPTURED"] } },
        select: { status: true },
      });
      // PRE-FLIP R3 — the in-app ledger row is DEFERRED (after the response): a kill right after
      // createNotification leaves no row, but the bell itself exists — linked by auditLogId = the fact.
      const accepted: "ACCEPTED" | "CAPTURED" | null = done ? (done.status as "ACCEPTED" | "CAPTURED") : (await inAppBellExists(db, it)) ? "ACCEPTED" : null;
      if (accepted) {
        const r = await db.automationRunItem.updateMany({
          where: { id: it.id, status: "SENDING" },
          data: { status: "SENT", reason: null, leaseUntil: null, lastDeliveryStatus: accepted, nextAttemptAt: null, updatedAt: now },
        });
        if (r.count === 1) {
          s.recovered++;
          await safeBump(deps, it.runId, (c) => { if (accepted === "ACCEPTED") c.accepted++; else c.captured++; }, s);
        }
      } else {
        await db.automationRunItem.updateMany({ where: { id: it.id, status: "SENDING" }, data: { status: "SCHEDULED", leaseUntil: null } });
      }
    } catch (e) {
      s.errors++;
      logOf(deps)(`[comms-automations] lease recovery failed for one item (retried next wake): ${errName(e)}`);
    }
  }
}

/**
 * PRE-FLIP R3 — an IN_APP item's bell already exists: the Notification createNotification wrote for it
 * (same recipient, the definition's type, auditLogId = the item's triggerRef — deliverItem passes the
 * fact as auditLogId, and EV-1 handler bells carry none, so a handler bell never matches here).
 */
async function inAppBellExists(db: EngineDb, it: ItemRow): Promise<boolean> {
  if (it.channel !== "IN_APP" || !it.recipientUserId || !it.triggerRef) return false;
  const a = await db.automationDefinition.findUnique({ where: { id: it.automationId }, select: { definitionKey: true } });
  const def = a ? getCatalogDefinition(a.definitionKey) : undefined;
  if (!def?.notificationTypeId) return false;
  const bell = await db.notification.findFirst({ where: { userId: it.recipientUserId, type: def.notificationTypeId, auditLogId: it.triggerRef }, select: { id: true } });
  return bell !== null;
}

export async function runAutomationEngine(deps: EngineDeps, budget: EngineBudget = DEFAULT_BUDGET): Promise<EngineSummary> {
  const s = newSummary();
  const started = deps.now().getTime();
  const outOfTime = () => deps.now().getTime() - started > budget.timeBudgetMs;
  const db = deps.db;
  const done = (): EngineSummary => ({ ...s, outcome: s.deferred > 0 || s.errors > 0 ? "PARTIAL" : "COMPLETE" });

  // The ACTIVATION HARD GATE: while activation is disabled the engine WRITES NOTHING and
  // SENDS NOTHING — even if an ACTIVE row or a pending item exists (it never should).
  if (!(deps.activationEnabled ?? AUTOMATION_ACTIVATION_ENABLED)) {
    const [active, pending] = await Promise.all([
      db.automationDefinition.count({ where: { state: "ACTIVE" } }),
      db.automationRunItem.count({ where: { status: { in: ["SCHEDULED", "SENDING", "FAILED"] } } }),
    ]);
    if (active > 0 || pending > 0) {
      (deps.log ?? ((l: string) => console.warn(l)))(`[comms-automations] activation is disabled (${ACTIVATION_DISABLED_REASON}): ${active} ACTIVE automation(s), ${pending} pending item(s) held; nothing sent`);
      return { ...s, outcome: "SKIPPED", skipReason: ACTIVATION_DISABLED_REASON };
    }
    // Nothing to hold: a COMPLETE run that SAYS the engine is off (never read as "working").
    return { ...s, note: "ACTIVATION_DISABLED" };
  }

  // 0. Resume: expired leases — SENT when the acceptance was recorded (A1), otherwise back to SCHEDULED.
  await recoverLeases(deps, s);

  // 1. The GLOBAL cost freeze halts live runs (D1) — before anything is resolved or sent.
  let fr: GlobalCostFreezeVerdict;
  try { fr = await deps.freeze(); } catch { fr = { frozen: true, state: "UNAVAILABLE", reason: "POLICY_UNAVAILABLE" }; }
  if (fr.frozen) {
    await haltAll(deps, "PROVIDER_FREEZE", s);
    return { ...s, outcome: "SKIPPED", skipReason: `BILLABLE_${fr.reason ?? "POLICY_UNAVAILABLE"}` };
  }

  // 1b. Platform ADMISSION at trigger (A5, §6.6 at-trigger step 4): maintenance / an unreadable
  // control plane ⇒ the pass is SKIPPED — nothing ingested, nothing sent, nothing cancelled (a
  // maintenance window is transient; items keep their schedule and are re-judged at send).
  const adm = await admitted(deps);
  if (!adm.admitted) return { ...s, outcome: "SKIPPED", skipReason: `ADMISSION_${adm.reason ?? "UNAVAILABLE"}` };

  // 2. The global breaker (v1.1 §6.7; N1 — counted from the engine's own SENT items).
  const accepted = await breakerCount(db, deps.now());
  if (accepted > GLOBAL_BREAKER.maxAccepted) {
    await tripBreaker(deps, accepted, s);
    return { ...s, outcome: "PARTIAL" };
  }

  // 3. Ingest — least-recently-scanned first (N5): a completed scan moves an automation's cursor
  // to the scan bound, so the next pass starts with the ones that were not reached.
  const active = await db.automationDefinition.findMany({
    where: { state: "ACTIVE" },
    orderBy: [{ triggerCursorAt: "asc" }, { id: "asc" }],
    take: budget.maxAutomations + 1,
  });
  if (active.length > budget.maxAutomations) s.deferred++;
  for (const a of active.slice(0, budget.maxAutomations)) {
    if (outOfTime()) { s.deferred++; break; }
    s.automations++;
    try {
      await ingestAutomation(deps, a, budget, s, outOfTime);
    } catch (e) {
      // N3 — one automation's failure never aborts the others.
      s.errors++;
      logOf(deps)(`[comms-automations] ingest failed for one automation (the others continue): ${errName(e)}`);
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
    // A5 — admission again before EVERY send (a maintenance declared mid-pass stops the rest).
    const at = await admitted(deps);
    if (!at.admitted) { s.deferred++; return { ...s, outcome: "SKIPPED", skipReason: `ADMISSION_${at.reason ?? "UNAVAILABLE"}` }; }
    // N1 — the breaker before every send: the window's SENT items (this pass's included, written inline).
    const n = await breakerCount(db, deps.now());
    if (n > GLOBAL_BREAKER.maxAccepted) { await tripBreaker(deps, n, s); return { ...s, outcome: "PARTIAL" }; }
    try {
      await deliverItem(deps, item, lifecycle, s);
    } catch (e) {
      // N3 — one item's failure never aborts the batch; an item left SENDING is recovered by its lease (A1).
      s.errors++;
      logOf(deps)(`[comms-automations] delivery failed for one item (its lease recovers it): ${errName(e)}`);
    }
  }
  return done();
}

/** Ingest ONE automation's new facts (bounded). Throws only on an unexpected store error (the caller isolates it). */
async function ingestAutomation(deps: EngineDeps, a: AutomationRow, budget: EngineBudget, s: EngineSummary, outOfTime: () => boolean): Promise<void> {
  const db = deps.db;
  const def = getCatalogDefinition(a.definitionKey);
  // A4 — protected / no longer automatable / a moved definitionVersion ⇒ DEFINITION_CHANGED.
  if (definitionSendable(def, a.definitionVersion) !== null || !def) { await autoPause(deps, a, "DEFINITION_CHANGED", s); return; }
  const trigger = a.triggerKey as TriggerFact["triggerKey"];
  if (!engineTriggerAvailable(trigger) || !FACT_SOURCES[trigger]) { await autoPause(deps, a, "TRIGGER_RETIRED", s); return; }
  if (await errorRateTripped(db, a.id, deps.now())) { await autoPause(deps, a, "ERROR_RATE", s); return; }
  const cursor = { at: a.triggerCursorAt ?? a.activatedAt ?? deps.now(), id: a.triggerCursorId };
  // N2 — only facts that have had FACT_SETTLE_MS to commit: a late-committing row is never jumped by the cursor.
  const until = new Date(deps.now().getTime() - FACT_SETTLE_MS);
  if (until.getTime() < cursor.at.getTime()) return;
  const facts = await readFactsAfter(db as unknown as FactReadClient, trigger, cursor, budget.maxFactsPerAutomation, until);
  const full = facts.length === budget.maxFactsPerAutomation;
  if (full) s.deferred++;
  const advance = (at: Date, id: string | null) => db.automationDefinition.updateMany({
    // Advance the cursor ONLY while this activation is still the live one (a pause / re-activation resets it).
    where: { id: a.id, state: "ACTIVE", activatedVersion: a.activatedVersion },
    data: { triggerCursorAt: at, triggerCursorId: id },
  });
  let stopped = false;
  let interrupted = false;
  for (const fact of facts) {
    if (outOfTime()) { s.deferred++; interrupted = true; break; }
    s.facts++;
    // N4 — a fact first read long after it happened (a backlog after a freeze / maintenance) is skipped.
    if (deps.now().getTime() - fact.occurredAt.getTime() > MAX_FACT_AGE_MS) {
      s.staleFacts++;
      await advance(fact.occurredAt, fact.ref);
      continue;
    }
    const stop = await ingestFact(deps, a, def, fact, s);
    await advance(fact.occurredAt, fact.ref);
    if (stop) { stopped = true; break; }
  }
  // N5 — the scan read everything up to `until`: the cursor moves to the bound, so this automation
  // goes to the back of the next pass's order. (A fact exactly AT the bound may be re-read; its
  // liveKey run makes that a no-op.)
  if (!full && !stopped && !interrupted) await advance(until, null);
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

/** A6 — the EV-1 handler already rang this bell for this fact (same type, recipient, Space; no auditLogId; around the fact). */
async function handlerBellExists(db: EngineDb, type: string, userId: string, fact: TriggerFact): Promise<boolean> {
  const at = fact.occurredAt.getTime();
  const bell = await db.notification.findFirst({
    where: {
      userId, type, auditLogId: null,
      ...(fact.spaceId ? { spaceId: fact.spaceId } : {}),
      createdAt: { gte: new Date(at - HANDLER_BELL_WINDOW.beforeMs), lte: new Date(at + HANDLER_BELL_WINDOW.afterMs) },
    },
    select: { id: true },
  });
  return bell !== null;
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

  // `updatedAt` is written with the ENGINE clock: the frequency cap and the breaker window read it (A2, N1).
  const finish = async (status: RunItemStatus, data: { reason?: SuppressionReason | typeof UNCERTAIN_ACCEPTANCE | null; lastDeliveryStatus: string; nextAttemptAt?: Date | null }) => {
    await db.automationRunItem.update({
      where: { id: item.id },
      data: { status, reason: data.reason ?? null, leaseUntil: null, lastDeliveryStatus: data.lastDeliveryStatus, nextAttemptAt: data.nextAttemptAt ?? null, updatedAt: now },
    });
  };

  const a = await db.automationDefinition.findUnique({ where: { id: item.automationId } });
  const def = a ? getCatalogDefinition(a.definitionKey) : undefined;
  const cancel = async (reason: SuppressionReason) => {
    await finish("CANCELLED", { reason, lastDeliveryStatus: "CANCELLED" });
    if (def) await recordDelivery(deps.ledger, engineLedgerRow(deps, cur, def, "CANCELLED", reason));
    await safeBump(deps, item.runId, (c) => { c.cancelled++; }, s);
    s.cancelled++;
  };
  const suppress = async (reason: SuppressionReason, ledgerWritten: boolean) => {
    await finish("SUPPRESSED", { reason, lastDeliveryStatus: "SUPPRESSED" });
    if (def && !ledgerWritten) await recordDelivery(deps.ledger, engineLedgerRow(deps, cur, def, "SUPPRESSED", reason));
    await safeBump(deps, item.runId, (c) => { c.suppressed[reason]++; }, s);
    s.suppressed++;
  };
  /**
   * A1 — AFTER the provider (or createNotification) accepted: the bookkeeping may fail, but it must
   * never make the item sendable again. A failed finish leaves it SENDING under its lease; step 0 of a
   * later pass finds the ACCEPTED ledger row and marks it SENT (and a re-send would carry the same
   * provider Idempotency-Key anyway).
   */
  const delivered = async (lastDeliveryStatus: "ACCEPTED" | "CAPTURED", uncertain = false) => {
    s.sent++;
    try { await finish("SENT", { lastDeliveryStatus, ...(uncertain ? { reason: UNCERTAIN_ACCEPTANCE } : {}) }); } catch (e) {
      s.errors++;
      logOf(deps)(`[comms-automations] a delivered item could not be marked SENT (its lease recovers it; never re-sent): ${errName(e)}`);
      return;
    }
    await safeBump(deps, item.runId, (c) => { if (lastDeliveryStatus === "ACCEPTED") c.accepted++; else c.captured++; }, s);
  };

  // ── Re-evaluate everything, freshly (§6.6 at-send step 2) ──
  if (!a || a.state !== "ACTIVE" || a.activatedVersion !== item.automationVersion) return cancel("AUTOMATION_PAUSED");
  // A4 — the definition must still be sendable at the version the automation was validated against.
  if (definitionSendable(def, a.definitionVersion) !== null || !def || !automatableChannels(def).includes(item.channel as AutomationChannel)) {
    await autoPause(deps, a, "DEFINITION_CHANGED", s);
    return cancel("AUTOMATION_PAUSED");
  }
  let fr: GlobalCostFreezeVerdict;
  try { fr = await deps.freeze(); } catch { fr = { frozen: true, state: "UNAVAILABLE", reason: "POLICY_UNAVAILABLE" }; }
  if (fr.frozen) return cancel("PROVIDER_FREEZE");
  // N4 — far past its time (a backlog after a freeze / maintenance): what it says is no longer timely.
  if (now.getTime() - item.notBefore.getTime() > MAX_SEND_LATENESS_MS) return cancel("OBSOLETE");
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
      await safeBump(deps, item.runId, (c) => { c.failed++; }, s);
      s.dead++;
    } else {
      await finish("FAILED", { lastDeliveryStatus: "FAILED", nextAttemptAt: new Date(now.getTime() + nextDelay) });
      s.failed++;
    }
  };

  if (channel === "IN_APP") {
    // A6 — the EV-1 handler delivers this definition too: never a second bell for the same fact.
    if (await handlerBellExists(db, type, item.recipientUserId, fact)) return suppress("DEDUPE_OPEN", false);
    const res = await deps.createNotification(
      { type, userId: item.recipientUserId, spaceId: fact.spaceId, data, auditLogId: fact.ref },
      { inAppOnly: true, ledgerTag: { messageKey: item.id, automationRunItemId: item.id, attempt }, ledger: deps.ledger, content: deps.content },
    );
    if (res.status === "created") return delivered("ACCEPTED");
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
    // A1 — the provider Idempotency-Key is the ITEM (no attempt suffix): every attempt of one item is one message.
    idempotencyKey: item.id,
  });
  // PRE-FLIP R4 — the provider refused a retry whose content changed under the SAME Idempotency-Key (the item
  // id): an earlier attempt was accepted under it (and timed out on our side). SENT, flagged uncertain — never DEAD,
  // never re-sent.
  if (result.status === "sent" && result.uncertain === "IDEMPOTENCY_CONFLICT") {
    logOf(deps)("[comms-automations] provider reported an idempotency conflict: an earlier attempt was accepted under this key; marked SENT (uncertain), not re-sent");
    return delivered("ACCEPTED", true);
  }
  if (result.status === "sent" || result.status === "captured") return delivered(result.status === "sent" ? "ACCEPTED" : "CAPTURED");
  // The storm limit (RATE_LIMITED / RATE_LIMIT_UNVERIFIED): SUPPRESSED, never retried. sendEmail recorded the row.
  if (result.status === "skipped") return suppress(result.reason ?? "NO_RECIPIENT", true);
  return failed();
}

/** PRE-FLIP R4 — the reason on a SENT item whose acceptance is known only from a provider idempotency conflict. */
export const UNCERTAIN_ACCEPTANCE = "ACCEPTED_UNCERTAIN_IDEMPOTENCY_CONFLICT" as const;

/** Bounds used by the job, exported for the job health / tests. */
export const ENGINE_LIMITS = { ...DEFAULT_BUDGET, maxRecipientsCeiling: AUTOMATION_LIMITS.maxRecipientsCeiling };
