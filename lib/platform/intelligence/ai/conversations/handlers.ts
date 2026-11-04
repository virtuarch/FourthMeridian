/**
 * lib/platform/intelligence/ai/conversations/handlers.ts  (the route logic — dependency-injected)
 *
 * Design §3 (authorization), §5 (idempotency), §6 (caps), §10 (API). The
 * routes under app/api/platform/ai/conversations/ supply the real seams (the
 * session, the FRESH grant guard, the limiter, the store); the unit tests
 * supply fakes. Nothing here imports a database, a key or the provider.
 *
 * THE GATE CHAIN (§3.1), in this order, for every route:
 *   1. flag      PLATFORM_AI_ENABLED && PLATFORM_AI_CONVERSATIONS_ENABLED, else
 *                404 NOT_AVAILABLE — the FIRST statement; nothing else runs.
 *   2–3. viewer  a session and ≥ 1 ACTIVE grant with a Platform Space, then the
 *                FRESH guard on the operator's first area (2FA, live revocation;
 *                break-glass ⇒ 403: a SYSTEM_ADMIN on break-glass holds no grant
 *                and gets nothing). v0's own 401 / 403. This runs BEFORE any
 *                lookup, so it never depends on a row existing.
 *   4. limiter   mutations only (#352).
 *   Steps 1–4 live INLINE in each route handler (the #352 census and the
 *   guard-provenance pins read the handler body); the handlers below receive
 *   the authorized Viewer and run steps 5–7:
 *   5. lookup    owner-scoped (RLS + an explicit operatorUserId), live only.
 *   6. area      a FRESH guard on the conversation's OWN area. ANY refusal ⇒ the
 *                SAME 404 as not-found: same status, body and headers (no
 *                existence oracle, S2 B4). No break-glass.
 *   7. binding   link re-resolution uses step 6's guard result only.
 */

import type { PlatformArea } from "@prisma/client";
import { scrubOperatorText } from "@/lib/ai/privacy/scrub";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import type { StoredAnswerV1 } from "./answer";
import {
  PLATFORM_AI_CONVERSATION_MESSAGES_MAX,
  PLATFORM_AI_CONVERSATIONS_MAX,
  PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S,
  PLATFORM_AI_LABEL_MAX,
  PLATFORM_AI_MESSAGE_MAX,
} from "./constants";
import type { ConversationRecord, ConversationSummary, CreateOutcome, MessageRecord, TurnPair } from "./store";

export interface ConversationHttp { status: number; body: Record<string, unknown> | null; headers?: Record<string, string> }

export const NOT_AVAILABLE_BODY = Object.freeze({ error: "Not available.", code: "NOT_AVAILABLE" });
export const NOT_FOUND_BODY = Object.freeze({ error: "Not found.", code: "NOT_FOUND" });
/** THE one 404: not found, not the operator's, deleted, or the area's fresh guard refused. Identical in every case. */
export const notFound = (): ConversationHttp => ({ status: 404, body: { ...NOT_FOUND_BODY } });

/** The operator who passed steps 1–4, and the area their fresh viewer guard bound (platformAiAreaFor). */
export interface Viewer { operatorId: string; area: PlatformArea }

/** What step 6 hands back when the conversation's area passes its FRESH guard. */
export interface AreaAccess {
  /** Re-resolve a stored link through the CURRENT token (resolveNavigationTarget, string-literal surface). */
  resolvePage(page: string, params: Readonly<Record<string, string>>): { href: string } | null;
}

export interface ConversationStoreSeam {
  findLiveConversation(operatorId: string, id: string): Promise<ConversationRecord | null>;
  listLiveConversations(operatorId: string): Promise<ConversationSummary[]>;
  readConversation(operatorId: string, id: string, now: Date): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] } | null>;
  createConversation(input: { operatorId: string; area: PlatformArea; createRequestId: string; scrubbedQuestion: string }): Promise<CreateOutcome>;
  softDeleteConversation(operatorId: string, id: string): Promise<{ deleted: true; messageCount: number } | { deleted: false }>;
}

export interface ConversationDeps {
  /** Step 6: a FRESH guard on `area` for THIS operator; null on any refusal (⇒ 404). */
  areaAccess(area: PlatformArea, operatorId: string): Promise<AreaAccess | null>;
  store: ConversationStoreSeam;
  now(): Date;
}

/** The pre-provider gates of a create (v0's order, §5.3): every refusal before anything is stored. */
export interface TurnAdmissionDeps {
  admission(): Promise<{ paused: boolean }>;
  freeze(): Promise<{ frozen: boolean }>;
  turns(operatorId: string, now: Date): Promise<{ allowed: boolean; detail?: string }>;
}

// ── Pure pieces ─────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Conversation ids are cuids; anything else is simply not found (same 404). */
export const CONVERSATION_ID = /^[a-z0-9]{20,40}$/;

/** The create / append body: exactly `{ clientRequestId: <uuid>, question: <1–500 chars after trimming> }`. */
export function parseTurnBody(body: unknown): { clientRequestId: string; question: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "clientRequestId" || keys[1] !== "question") return null;
  const { clientRequestId, question } = body as { clientRequestId: unknown; question: unknown };
  if (typeof clientRequestId !== "string" || !UUID.test(clientRequestId)) return null;
  if (typeof question !== "string") return null;
  const q = question.trim();
  return q.length >= 1 && q.length <= PLATFORM_AI_MESSAGE_MAX ? { clientRequestId: clientRequestId.toLowerCase(), question: q } : null;
}

const areaLabel = (area: PlatformArea) => PLATFORM_AREAS[area].label;

/**
 * The list label (S2 Q1): derived at READ time, never stored, logged or
 * audited — the earliest remaining USER message (already scrubbed), truncated
 * to PLATFORM_AI_LABEL_MAX on a word boundary plus "…"; "<area> conversation"
 * when no message remains (option (b) expiry).
 */
export function deriveLabel(firstQuestion: string | null, area: PlatformArea): string {
  const fallback = `${areaLabel(area)} conversation`;
  if (!firstQuestion) return fallback;
  const t = firstQuestion.replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  if (t.length <= PLATFORM_AI_LABEL_MAX) return t;
  const cut = t.slice(0, PLATFORM_AI_LABEL_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space >= PLATFORM_AI_LABEL_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const isFull = (messageCount: number) => messageCount + 2 > PLATFORM_AI_CONVERSATION_MESSAGES_MAX;

export type RenderedSegment =
  | { kind: "text"; text: string }
  | { kind: "figure"; text: string; metric: string; window: string | number | null }
  | { kind: "link"; text: string; href: string };

/** A stored answer for the client: links re-resolved through the CURRENT token (§3.4); a dead link is plain text. */
export function renderStoredAnswer(a: StoredAnswerV1, access: AreaAccess | null): RenderedSegment[] {
  return a.segments.map((s): RenderedSegment => {
    if (s.kind === "link") {
      const r = access?.resolvePage(s.page, s.params) ?? null;
      return r ? { kind: "link", text: s.text, href: r.href } : { kind: "text", text: s.text };
    }
    return s.kind === "figure" ? { kind: "figure", text: s.text, metric: s.metric, window: s.window } : { kind: "text", text: s.text };
  });
}

export function messageDto(m: MessageRecord, access: AreaAccess | null, stale: boolean): Record<string, unknown> {
  const answer = m.role === "ASSISTANT" && m.content !== null && typeof m.content !== "string" ? m.content : null;
  return {
    id: m.id,
    role: m.role,
    status: m.status,
    createdAt: m.createdAt.toISOString(),
    completedAt: m.completedAt ? m.completedAt.toISOString() : null,
    content: m.role === "USER" ? (typeof m.content === "string" ? m.content : null) : answer ? renderStoredAnswer(answer, access) : null,
    citations: answer ? answer.citations : [],
    notes: answer ? answer.notes : [],
    failureCode: m.failureCode,
    unavailable: m.unreadable,
    stale: stale && m.role === "ASSISTANT",
  };
}

const conversationDto = (c: ConversationRecord) => ({
  id: c.id, area: c.area, areaLabel: areaLabel(c.area),
  createdAt: c.createdAt.toISOString(), lastActivityAt: c.lastActivityAt.toISOString(),
});

/** A replay (§5.1): COMPLETE / FAILED ⇒ 200 with the stored pair; PENDING ⇒ 409 TURN_IN_FLIGHT. */
function pairResponse(status: number, conversation: ConversationRecord | null, pair: TurnPair, access: AreaAccess | null): ConversationHttp {
  if (pair.assistant.status === "PENDING" && status === 200) {
    return { status: 409, body: { error: "This question is still being answered.", code: "TURN_IN_FLIGHT" }, headers: { "Retry-After": String(PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S) } };
  }
  return {
    status,
    body: {
      ...(conversation ? { conversation: conversationDto(conversation) } : {}),
      userMessage: messageDto(pair.user, access, false),
      assistantMessage: messageDto(pair.assistant, access, false),
    },
  };
}

/** Seconds to the next UTC midnight (the daily cap's Retry-After, as v0). */
function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
const unavailable = (status: number, reason: string, headers?: Record<string, string>): ConversationHttp =>
  ({ status, body: { error: "Platform AI is unavailable right now.", code: "AI_UNAVAILABLE", reason }, ...(headers ? { headers } : {}) });

// ── Handlers ────────────────────────────────────────────────────────────────

/** GET /conversations — fresh READ per DISTINCT area; conversations of a failing area are dropped, neither counted nor hinted at. */
export async function handleListConversations(v: Viewer, deps: ConversationDeps): Promise<ConversationHttp> {
  const rows = await deps.store.listLiveConversations(v.operatorId);
  const allowed = new Set<PlatformArea>();
  for (const area of new Set(rows.map((r) => r.area))) if (await deps.areaAccess(area, v.operatorId)) allowed.add(area);
  const visible = rows.filter((r) => allowed.has(r.area));
  return {
    status: 200,
    body: {
      conversations: visible.map((r) => ({
        ...conversationDto(r),
        label: deriveLabel(r.firstQuestion, r.area),
        messageCount: r.messageCount,
        full: isFull(r.messageCount),
      })),
      limits: { conversations: { used: visible.length, max: PLATFORM_AI_CONVERSATIONS_MAX } },
    },
  };
}

/**
 * POST /conversations `{ clientRequestId, question }` — create = the first
 * question. The area is the server's (platformAiAreaFor, via the viewer gate).
 * Stores the conversation, the scrubbed USER message and a PENDING ASSISTANT
 * row (transaction 1). Running the turn and settling it (transaction 2) is the
 * turn-integration follow-up (after #418); until then the reply stays PENDING
 * and is ABANDONED by the next read after 2 × the turn timeout.
 */
export async function handleCreateConversation(v: Viewer, body: unknown, deps: ConversationDeps & TurnAdmissionDeps): Promise<ConversationHttp> {
  const parsed = parseTurnBody(body);
  if (!parsed) {
    return { status: 400, body: { error: `Send { clientRequestId: <uuid>, question: 1–${PLATFORM_AI_MESSAGE_MAX} characters }.`, code: "VALIDATION" } };
  }
  // Pre-provider refusals store nothing (§5.3): kill switch → global freeze → daily cap.
  let adm: { paused: boolean };
  try { adm = await deps.admission(); } catch { adm = { paused: true }; }
  if (adm.paused) return unavailable(503, "KILL_SWITCH");
  let fr: { frozen: boolean };
  try { fr = await deps.freeze(); } catch { fr = { frozen: true }; }
  if (fr.frozen) return unavailable(503, "COST_FREEZE");
  const now = deps.now();
  let cap: { allowed: boolean; detail?: string };
  try { cap = await deps.turns(v.operatorId, now); } catch { cap = { allowed: false, detail: "UNAVAILABLE" }; }
  if (!cap.allowed) {
    return cap.detail === "DAILY_TURNS"
      ? unavailable(429, "DAILY_TURNS", { "Retry-After": String(secondsToUtcMidnight(now)) })
      : unavailable(503, "ALLOWANCE_UNAVAILABLE");
  }
  // One scrub for both sinks (S2 B3): this exact string is stored and, in the follow-up, sent.
  const scrubbedQuestion = scrubOperatorText(parsed.question, PLATFORM_AI_MESSAGE_MAX);
  const out = await deps.store.createConversation({ operatorId: v.operatorId, area: v.area, createRequestId: parsed.clientRequestId, scrubbedQuestion });
  switch (out.kind) {
    case "LIMIT":
      return { status: 409, body: { error: "Delete a conversation to start another.", code: "CONVERSATION_LIMIT", limits: { conversations: { max: PLATFORM_AI_CONVERSATIONS_MAX } } } };
    case "DELETED":
      return notFound();
    case "REPLAY": {
      // The replayed conversation's OWN area, fresh (step 6) — its area may differ from today's first area.
      const access = await deps.areaAccess(out.conversation.area, v.operatorId);
      if (!access) return notFound();
      return pairResponse(200, out.conversation, out.pair, access);
    }
    case "CREATED": {
      const access = await deps.areaAccess(out.conversation.area, v.operatorId);
      return pairResponse(201, out.conversation, out.pair, access);
    }
  }
}

/** GET /conversations/[id] — steps 5–6; links re-resolved through the current token; every prior answer stale. */
export async function handleGetConversation(v: Viewer, id: string, deps: ConversationDeps): Promise<ConversationHttp> {
  if (!CONVERSATION_ID.test(id)) return notFound();
  const meta = await deps.store.findLiveConversation(v.operatorId, id);
  if (!meta) return notFound();
  const access = await deps.areaAccess(meta.area, v.operatorId);
  if (!access) return notFound();
  const read = await deps.store.readConversation(v.operatorId, id, deps.now());
  if (!read) return notFound();
  return {
    status: 200,
    body: {
      conversation: { ...conversationDto(read.conversation), messageCount: read.messages.length, full: isFull(read.messages.length) },
      messages: read.messages.map((m) => messageDto(m, access, true)),
    },
  };
}

/** DELETE /conversations/[id] — limiter, steps 5–6, soft delete + audit; 204. Already deleted ⇒ 404 (invisible). */
export async function handleDeleteConversation(v: Viewer, id: string, deps: ConversationDeps): Promise<ConversationHttp> {
  if (!CONVERSATION_ID.test(id)) return notFound();
  const meta = await deps.store.findLiveConversation(v.operatorId, id);
  if (!meta) return notFound();
  if (!(await deps.areaAccess(meta.area, v.operatorId))) return notFound();
  const r = await deps.store.softDeleteConversation(v.operatorId, id);
  return r.deleted ? { status: 204, body: null } : notFound();
}
