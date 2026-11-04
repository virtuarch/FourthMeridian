/**
 * lib/platform/intelligence/ai/conversations/store.ts  (Platform AI conversations — the ONE data module)
 *
 * Design: docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §2, §5, §7.1. B11.
 *
 * ── AUTHORITY ────────────────────────────────────────────────────────────────
 * Every statement runs inside `withTenantDb(operatorId, …)` as fm_app with
 * `app.user_id` bound transaction-locally: owner-only RLS (operatorUserId =
 * current_fm_user_id()) scopes every row, and every query ALSO names the owner
 * (belt and braces). There is NO fm_system path to these tables (S2 B4): this
 * module never imports `systemDb` (source-pinned), and retention runs through
 * the one purge function (./purge.ts).
 *
 * The caller (the route) has ALREADY run the gate chain and the FRESH area
 * guard for the conversation's area (§3.1 steps 1–6). This module decides
 * nothing about grants; it returns `null` / NOT_FOUND for a row the operator
 * does not own or that is soft-deleted, and the route maps that to the same
 * 404 as a revoked grant.
 *
 * ── WRITERS NEVER CHOOSE TIME (S2 REQUIRED 1) ────────────────────────────────
 * No statement here writes createdAt, lastActivityAt, purgeAfter or
 * completedAt (they are not even in fm_app's grants; source-pinned). The soft
 * delete writes `deletedAt` ONLY, and the trigger replaces the value with
 * now(). Reads, lists, deletes and replays never move lastActivityAt — only a
 * USER-message INSERT does, through the trigger.
 *
 * ── CONTENT ──────────────────────────────────────────────────────────────────
 * The two encryptWithPurpose(…, PLATFORM_AI_MESSAGE) writer sites of
 * PlatformAiMessage.contentEncrypted are here and only here (the
 * lib/plaid/encrypted-fields.test.ts census): the USER question (already
 * SCRUBBED by the caller — exactly the string the provider receives) and the
 * ASSISTANT completion. Nothing here logs content, ids or labels.
 */

import "server-only";

import { Prisma, type PlatformArea } from "@prisma/client";
import { withTenantDb, type TenantClient } from "@/lib/db/tenant-context";
import { encryptWithPurpose, decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { AuditAction } from "@/lib/audit-actions";
import { auditInsert, type OperatorActionWriteClient, recordOperatorAction } from "@/lib/audit";
import { parseEvidenceRefs, parseStoredAnswer, serializeStoredAnswer, validateEvidenceRefs, type EvidenceRef, type StoredAnswerV1 } from "./answer";
import {
  PLATFORM_AI_ABANDON_AFTER_MS,
  PLATFORM_AI_CONVERSATION_MESSAGES_MAX,
  PLATFORM_AI_CONVERSATIONS_MAX,
} from "./constants";
import type { HistoryMessage } from "./history";

export type MessageRole = "USER" | "ASSISTANT";
/** PlatformAiMessage.role values, named (they are message roles — not User.role population predicates). */
const QUESTION: MessageRole = "USER";
const ANSWER: MessageRole = "ASSISTANT";
export type MessageStatus = "PENDING" | "COMPLETE" | "FAILED";
export type FailureCode = "TIMEOUT" | "PROVIDER" | "KILL_SWITCH" | "ABANDONED";

export interface ConversationRecord {
  id: string;
  area: PlatformArea;
  createdAt: Date;
  lastActivityAt: Date;
}

/** One decrypted message. `content` is null while PENDING, for a FAILED reply, or when the stored value cannot be read. */
export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  status: MessageStatus;
  createdAt: Date;
  completedAt: Date | null;
  replyToId: string | null;
  content: string | StoredAnswerV1 | null;
  /** True when a stored value exists but could not be decrypted / parsed (shown as unavailable, never as text). */
  unreadable: boolean;
  failureCode: FailureCode | null;
  evidenceRefs: EvidenceRef[];
}

export interface TurnPair { user: MessageRecord; assistant: MessageRecord }

const CONVERSATION_SELECT = { id: true, area: true, createdAt: true, lastActivityAt: true } as const;
const MESSAGE_SELECT = {
  id: true, conversationId: true, role: true, status: true, createdAt: true, completedAt: true,
  replyToId: true, contentEncrypted: true, failureCode: true, evidenceRefs: true,
} as const;

type MessageRow = Prisma.PlatformAiMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

/** Decrypt one row. Never throws: an unreadable value is reported, never shown, never logged. */
export function toMessageRecord(row: MessageRow): MessageRecord {
  let content: string | StoredAnswerV1 | null = null;
  let unreadable = false;
  if (row.contentEncrypted) {
    try {
      const plain = decryptWithPurpose(row.contentEncrypted, EncryptionPurpose.PLATFORM_AI_MESSAGE);
      if (row.role === QUESTION) content = plain;
      else { content = parseStoredAnswer(plain); unreadable = content === null; }
    } catch {
      unreadable = true;
    }
  }
  return {
    id: row.id, conversationId: row.conversationId, role: row.role, status: row.status,
    createdAt: row.createdAt, completedAt: row.completedAt, replyToId: row.replyToId,
    content, unreadable, failureCode: row.failureCode, evidenceRefs: parseEvidenceRefs(row.evidenceRefs),
  };
}

/** Message order: by createdAt, the question before its answer (equal createdAt — one transaction). */
const MESSAGE_ORDER = [{ createdAt: "asc" as const }, { role: "asc" as const }, { id: "asc" as const }];

/** The audit client: a plain INSERT (no RETURNING — fm_app's AuditLog SELECT policy cannot see an operator row). */
function auditClient(tx: TenantClient): OperatorActionWriteClient {
  return { auditLog: { create: async ({ data }) => { await auditInsert(tx, data).write; return null; } } };
}

/** Transaction-scoped per-key serialisation (the house pattern: lib/platform/growth/beta-blocklist.ts). */
async function lockKey(tx: TenantClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const violated = (e: Prisma.PrismaClientKnownRequestError, name: string) => JSON.stringify(e.meta ?? {}).includes(name) || e.message.includes(name);

// ── Reads ────────────────────────────────────────────────────────────────────

/** The live (not soft-deleted) conversation the operator owns, or null. */
export async function findLiveConversation(operatorId: string, id: string): Promise<ConversationRecord | null> {
  return withTenantDb(operatorId, (tx) => tx.platformAiConversation.findFirst({
    where: { id, operatorUserId: operatorId, deletedAt: null },
    select: CONVERSATION_SELECT,
  }));
}

export interface ConversationSummary extends ConversationRecord {
  messageCount: number;
  /** The earliest remaining USER message, decrypted (already scrubbed) — the label's source. Null when none remains. */
  firstQuestion: string | null;
}

/** The operator's live conversations, most recent activity first. */
export async function listLiveConversations(operatorId: string): Promise<ConversationSummary[]> {
  const rows = await withTenantDb(operatorId, (tx) => tx.platformAiConversation.findMany({
    where: { operatorUserId: operatorId, deletedAt: null },
    orderBy: [{ lastActivityAt: "desc" }, { id: "asc" }],
    take: PLATFORM_AI_CONVERSATIONS_MAX,
    select: {
      ...CONVERSATION_SELECT,
      _count: { select: { messages: true } },
      messages: { where: { role: QUESTION }, orderBy: MESSAGE_ORDER, take: 1, select: MESSAGE_SELECT },
    },
  }));
  return rows.map((r) => {
    const first = r.messages[0] ? toMessageRecord(r.messages[0]) : null;
    return {
      id: r.id, area: r.area, createdAt: r.createdAt, lastActivityAt: r.lastActivityAt,
      messageCount: r._count.messages,
      firstQuestion: first && typeof first.content === "string" ? first.content : null,
    };
  });
}

/** Mark this conversation's PENDING reply FAILED / ABANDONED when older than 2 × the turn timeout (§5.2). */
async function abandonStale(tx: TenantClient, conversationId: string, now: Date): Promise<number> {
  const r = await tx.platformAiMessage.updateMany({
    where: { conversationId, status: "PENDING", createdAt: { lt: new Date(now.getTime() - PLATFORM_AI_ABANDON_AFTER_MS) } },
    data: { status: "FAILED", failureCode: "ABANDONED" },
  });
  return r.count;
}

/** The live conversation and its messages (oldest first), with a stale PENDING turn abandoned first. Null when not the operator's / deleted. */
export async function readConversation(operatorId: string, id: string, now: Date): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] } | null> {
  return withTenantDb(operatorId, async (tx) => {
    const conversation = await tx.platformAiConversation.findFirst({ where: { id, operatorUserId: operatorId, deletedAt: null }, select: CONVERSATION_SELECT });
    if (!conversation) return null;
    await abandonStale(tx, id, now);
    const rows = await tx.platformAiMessage.findMany({ where: { conversationId: id }, orderBy: MESSAGE_ORDER, select: MESSAGE_SELECT });
    return { conversation, messages: rows.map(toMessageRecord) };
  });
}

/** The decrypted messages of ONE conversation for history assembly (./history.ts). Null when not the operator's / deleted. */
export async function loadConversationHistory(operatorId: string, conversationId: string): Promise<HistoryMessage[] | null> {
  const read = await withTenantDb(operatorId, async (tx) => {
    const c = await tx.platformAiConversation.findFirst({ where: { id: conversationId, operatorUserId: operatorId, deletedAt: null }, select: { id: true } });
    if (!c) return null;
    return tx.platformAiMessage.findMany({ where: { conversationId, status: "COMPLETE" }, orderBy: MESSAGE_ORDER, select: MESSAGE_SELECT });
  });
  if (!read) return null;
  return read.map(toMessageRecord).filter((m) => !m.unreadable).map((m) => ({
    id: m.id, conversationId: m.conversationId, role: m.role, status: m.status, createdAt: m.createdAt,
    replyToId: m.replyToId, content: m.content, evidenceRefs: m.evidenceRefs,
  }));
}

// ── Turn writes (transaction 1 / transaction 2, design §5.2) ─────────────────

/** Insert the USER row (COMPLETE, the scrubbed question) and its PENDING ASSISTANT row. No timestamp is named. */
async function insertPair(tx: TenantClient, conversationId: string, clientRequestId: string, scrubbedQuestion: string): Promise<TurnPair> {
  const user = await tx.platformAiMessage.create({
    data: {
      conversationId, role: QUESTION, status: "COMPLETE", clientRequestId,
      contentEncrypted: encryptWithPurpose(scrubbedQuestion, EncryptionPurpose.PLATFORM_AI_MESSAGE),
    },
    select: MESSAGE_SELECT,
  });
  const assistant = await tx.platformAiMessage.create({
    data: { conversationId, role: ANSWER, status: "PENDING", replyToId: user.id },
    select: MESSAGE_SELECT,
  });
  return { user: toMessageRecord(user), assistant: toMessageRecord(assistant) };
}

/** The pair a USER clientRequestId already produced in this conversation, or null. */
async function existingPair(tx: TenantClient, conversationId: string, clientRequestId: string): Promise<TurnPair | null> {
  const user = await tx.platformAiMessage.findFirst({ where: { conversationId, clientRequestId, role: QUESTION }, select: MESSAGE_SELECT });
  if (!user) return null;
  const assistant = await tx.platformAiMessage.findFirst({ where: { conversationId, replyToId: user.id }, select: MESSAGE_SELECT });
  if (!assistant) return null;
  return { user: toMessageRecord(user), assistant: toMessageRecord(assistant) };
}

export type CreateOutcome =
  | { kind: "CREATED" | "REPLAY"; conversation: ConversationRecord; pair: TurnPair }
  /** A replay of a create whose conversation the operator has since deleted: invisible (404). */
  | { kind: "DELETED" }
  | { kind: "LIMIT"; used: number };

/**
 * CREATE = the first question (design §10). One transaction: the cap, the
 * conversation, the USER + PENDING ASSISTANT pair, and the CREATED audit row
 * (no content: `area` only). Idempotent on (operator, createRequestId): a
 * replay returns the existing conversation and pair and writes nothing.
 */
export async function createConversation(input: {
  operatorId: string;
  area: PlatformArea;
  createRequestId: string;
  scrubbedQuestion: string;
}): Promise<CreateOutcome> {
  const { operatorId, area, createRequestId } = input;
  const replay = async (tx: TenantClient): Promise<CreateOutcome | null> => {
    const c = await tx.platformAiConversation.findFirst({ where: { operatorUserId: operatorId, createRequestId }, select: { ...CONVERSATION_SELECT, deletedAt: true } });
    if (!c) return null;
    if (c.deletedAt) return { kind: "DELETED" };
    const pair = await existingPair(tx, c.id, createRequestId);
    return pair ? { kind: "REPLAY", conversation: { id: c.id, area: c.area, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt }, pair } : { kind: "DELETED" };
  };
  try {
    return await withTenantDb(operatorId, async (tx) => {
      await lockKey(tx, `platform-ai-conversation-create:${operatorId}`);
      const prior = await replay(tx);
      if (prior) return prior;
      const used = await tx.platformAiConversation.count({ where: { operatorUserId: operatorId, deletedAt: null } });
      if (used >= PLATFORM_AI_CONVERSATIONS_MAX) return { kind: "LIMIT", used };
      const conversation = await tx.platformAiConversation.create({
        data: { operatorUserId: operatorId, area, createRequestId },
        select: CONVERSATION_SELECT,
      });
      const pair = await insertPair(tx, conversation.id, createRequestId, input.scrubbedQuestion);
      await recordOperatorAction(auditClient(tx), {
        actor: { userId: operatorId, via: "PLATFORM_GRANT", area },
        action: AuditAction.PLATFORM_AI_CONVERSATION_CREATED,
        target: { kind: "PLATFORM_AI_CONVERSATION", id: conversation.id },
        result: "SUCCESS",
        detail: { area },
      });
      return { kind: "CREATED", conversation, pair };
    });
  } catch (e) {
    // A concurrent create with the same key won the unique index: re-read it (a new transaction).
    if (isUniqueViolation(e)) {
      const again = await withTenantDb(operatorId, (tx) => replay(tx));
      if (again) return again;
    }
    throw e;
  }
}

export type AppendOutcome =
  | { kind: "APPENDED" | "REPLAY"; pair: TurnPair }
  | { kind: "NOT_FOUND" }
  | { kind: "IN_FLIGHT" }
  | { kind: "FULL"; used: number };

/**
 * APPEND a question to a live conversation (transaction 1). Idempotent on
 * (conversation, clientRequestId); one in-flight turn per conversation (the
 * partial unique index; P2002 on it ⇒ IN_FLIGHT); a stale PENDING turn is
 * abandoned first; the 40-message cap counts FAILED rows.
 */
export async function appendTurn(input: {
  operatorId: string;
  conversationId: string;
  clientRequestId: string;
  scrubbedQuestion: string;
  now: Date;
}): Promise<AppendOutcome> {
  const { operatorId, conversationId, clientRequestId } = input;
  try {
    return await withTenantDb(operatorId, async (tx) => {
      const c = await tx.platformAiConversation.findFirst({ where: { id: conversationId, operatorUserId: operatorId, deletedAt: null }, select: { id: true } });
      if (!c) return { kind: "NOT_FOUND" };
      await abandonStale(tx, conversationId, input.now);
      const prior = await existingPair(tx, conversationId, clientRequestId);
      if (prior) return { kind: "REPLAY", pair: prior };
      const pending = await tx.platformAiMessage.count({ where: { conversationId, status: "PENDING" } });
      if (pending > 0) return { kind: "IN_FLIGHT" };
      const used = await tx.platformAiMessage.count({ where: { conversationId } });
      if (used + 2 > PLATFORM_AI_CONVERSATION_MESSAGES_MAX) return { kind: "FULL", used };
      return { kind: "APPENDED", pair: await insertPair(tx, conversationId, clientRequestId, input.scrubbedQuestion) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      if (violated(e, "one_pending_per_conversation")) return { kind: "IN_FLIGHT" };
      const again = await withTenantDb(operatorId, (tx) => existingPair(tx, conversationId, clientRequestId));
      if (again) return { kind: "REPLAY", pair: again };
      return { kind: "IN_FLIGHT" };
    }
    throw e;
  }
}

export type SettleOutcome =
  | { status: "COMPLETE"; answer: StoredAnswerV1; evidenceRefs: readonly EvidenceRef[] }
  | { status: "FAILED"; failureCode: Exclude<FailureCode, "ABANDONED"> };

/**
 * Transaction 2: the PENDING ASSISTANT row becomes COMPLETE (the rendered
 * answer, encrypted, plus evidence refs) or FAILED (a closed code). The settle
 * trigger sets completedAt and makes the row immutable afterwards. Returns
 * false when the row was no longer PENDING (abandoned meanwhile) — nothing written.
 */
export async function settleTurn(operatorId: string, conversationId: string, assistantId: string, outcome: SettleOutcome): Promise<boolean> {
  const data: Prisma.PlatformAiMessageUpdateManyMutationInput = outcome.status === "COMPLETE"
    ? {
        status: "COMPLETE",
        contentEncrypted: encryptWithPurpose(serializeStoredAnswer(outcome.answer), EncryptionPurpose.PLATFORM_AI_MESSAGE),
        evidenceRefs: validateEvidenceRefs(outcome.evidenceRefs) as unknown as Prisma.InputJsonValue,
      }
    : { status: "FAILED", failureCode: outcome.failureCode };
  const r = await withTenantDb(operatorId, (tx) => tx.platformAiMessage.updateMany({
    where: { id: assistantId, conversationId, role: ANSWER, status: "PENDING", conversation: { operatorUserId: operatorId, deletedAt: null } },
    data,
  }));
  return r.count === 1;
}

// ── Soft delete (§7.1) ───────────────────────────────────────────────────────

/**
 * Hide a live conversation at once: `deletedAt` ONLY (the trigger stores now()
 * whatever value is sent, and refuses a second delete or an un-delete), in one
 * transaction with the DELETED audit row (area + messageCount, no content).
 * Hard deletion is the purge's (after PLATFORM_AI_DELETE_GRACE_DAYS).
 */
export async function softDeleteConversation(operatorId: string, id: string): Promise<{ deleted: true; messageCount: number } | { deleted: false }> {
  return withTenantDb(operatorId, async (tx) => {
    const c = await tx.platformAiConversation.findFirst({ where: { id, operatorUserId: operatorId, deletedAt: null }, select: { id: true, area: true } });
    if (!c) return { deleted: false };
    const messageCount = await tx.platformAiMessage.count({ where: { conversationId: id } });
    const r = await tx.platformAiConversation.updateMany({ where: { id, operatorUserId: operatorId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (r.count !== 1) return { deleted: false };
    await recordOperatorAction(auditClient(tx), {
      actor: { userId: operatorId, via: "PLATFORM_GRANT", area: c.area },
      action: AuditAction.PLATFORM_AI_CONVERSATION_DELETED,
      target: { kind: "PLATFORM_AI_CONVERSATION", id },
      result: "SUCCESS",
      detail: { area: c.area, messageCount },
    });
    return { deleted: true, messageCount };
  });
}
