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
import type { PlatformAiBinding } from "../core";
import type { StoredAnswerV1 } from "./answer";
import {
  PLATFORM_AI_CONVERSATION_MESSAGES_MAX,
  PLATFORM_AI_CONVERSATIONS_MAX,
  PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S,
  PLATFORM_AI_LABEL_MAX,
  PLATFORM_AI_MESSAGE_MAX,
} from "./constants";
import type { HistoryMessage } from "./history";
import type { AppendOutcome, ConversationRecord, ConversationSummary, CreateOutcome, CreateReplayLookup, MessageRecord, SettleOutcome, TurnPair } from "./store";
import type { ConversationTurnOutcome } from "./turn";
import type { MemoryProposalCard } from "../memory/turn";
import type { MemoryReaders } from "../memory/revalidate";

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
  /**
   * The turn's binding, built from THE SAME fresh guard result (retrieveMetric /
   * listNavigationTargets / resolveNavigationTarget with a string-literal surface
   * per area). The ONLY scope a conversation turn can read.
   */
  binding: PlatformAiBinding;
  /** The area this access was granted for (the guard's own area). */
  area?: PlatformArea;
  /** Platform AI memory (design v2 §2): the authorized readers built from THE SAME fresh guard result. */
  memoryReaders?: MemoryReaders;
}

export interface ConversationStoreSeam {
  findLiveConversation(operatorId: string, id: string): Promise<ConversationRecord | null>;
  listLiveConversations(operatorId: string): Promise<ConversationSummary[]>;
  readConversation(operatorId: string, id: string, now: Date): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] } | null>;
  createConversation(input: { operatorId: string; area: PlatformArea; createRequestId: string; scrubbedQuestion: string }): Promise<CreateOutcome>;
  softDeleteConversation(operatorId: string, id: string): Promise<{ deleted: true; messageCount: number } | { deleted: false }>;
}

/** The turn seams of the store (B11 turn integration). */
export interface ConversationTurnStoreSeam {
  /** Metadata only — reads no message and decrypts nothing (the area guard runs before any content read). */
  findCreateConversation(operatorId: string, createRequestId: string): Promise<CreateReplayLookup | null>;
  findTurnPair(operatorId: string, conversationId: string, clientRequestId: string): Promise<TurnPair | null>;
  appendTurn(input: { operatorId: string; conversationId: string; clientRequestId: string; scrubbedQuestion: string; now: Date }): Promise<AppendOutcome>;
  settleTurn(operatorId: string, conversationId: string, assistantId: string, outcome: SettleOutcome): Promise<boolean>;
  loadConversationHistory(operatorId: string, conversationId: string): Promise<HistoryMessage[] | null>;
}

/**
 * Runs the model turn for a stored question (outside any transaction, §5.2):
 * history from the store, the binding from `access` (the conversation's own
 * area, FRESH). Expected never to throw; a throw is treated as PROVIDER.
 */
export interface TurnRunDeps {
  runTurn(input: { operatorId: string; conversationId: string; question: string; access: AreaAccess }): Promise<ConversationTurnOutcome>;
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
  | { kind: "link"; text: string; href: string }
  | { kind: "correction"; text: string }
  | { kind: "note"; text: string }
  | { kind: "memory"; text: string };

/** A stored answer for the client: links re-resolved through the CURRENT token (§3.4); a dead link is plain text. */
export function renderStoredAnswer(a: StoredAnswerV1, access: AreaAccess | null): RenderedSegment[] {
  return a.segments.map((s): RenderedSegment => {
    if (s.kind === "link") {
      const r = access?.resolvePage(s.page, s.params) ?? null;
      return r ? { kind: "link", text: s.text, href: r.href } : { kind: "text", text: s.text };
    }
    if (s.kind === "correction" || s.kind === "note") return { kind: s.kind, text: s.text };
    if (s.kind === "memory") return { kind: "memory", text: s.text };
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
function pairResponse(status: number, conversation: ConversationRecord | null, pair: TurnPair, access: AreaAccess | null, memoryProposal?: MemoryProposalCard | null): ConversationHttp {
  if (pair.assistant.status === "PENDING" && status === 200) {
    return { status: 409, body: { error: "This question is still being answered.", code: "TURN_IN_FLIGHT" }, headers: { "Retry-After": String(PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S) } };
  }
  return {
    status,
    body: {
      ...(conversation ? { conversation: conversationDto(conversation) } : {}),
      userMessage: messageDto(pair.user, access, false),
      assistantMessage: messageDto(pair.assistant, access, false),
      // Memory (design v2 §3): the confirm card of THIS turn only — never stored, never on a replay.
      ...(memoryProposal && pair.assistant.status === "COMPLETE" ? { memoryProposal } : {}),
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

/**
 * The areas an operator's ACTIVE grants reach, from ONE directory read
 * (loadPlatformDirectory: ACTIVE grants only, read fresh as the tenant). Every
 * level is ≥ READ, so an ACTIVE grant is a READ grant. Anything that is not a
 * known area is dropped. PURE.
 */
export function grantedAreasFrom(rows: readonly { area: string }[]): ReadonlySet<PlatformArea> {
  const known = new Set<string>(Object.keys(PLATFORM_AREAS));
  return new Set(rows.map((r) => r.area).filter((a): a is PlatformArea => known.has(a)));
}

/**
 * GET /conversations — conversations of an area the operator no longer holds an
 * ACTIVE grant on are dropped, neither counted nor hinted at.
 *
 * S2 NOTED on #424: the list does NOT run the fresh guard per distinct area.
 * requireFreshPlatformAccess RECORDS every refusal (OBS-009: a
 * SECURITY_ANOMALY_DETECTED "platform_access_denied" audit row per (user,
 * area) per window), so an operator with one old conversation under a revoked
 * area would raise a false Security Ops detection on every list. The route's
 * gate has already run the fresh guard once (session revocation, 2FA, the first
 * area's grant); the per-row filter uses `grantedAreas` — ONE directory read,
 * no denial writes. Opening, replaying or deleting a conversation still
 * fresh-checks its own area (deps.areaAccess).
 */
export async function handleListConversations(v: Viewer, grantedAreas: ReadonlySet<PlatformArea>, deps: Pick<ConversationDeps, "store">): Promise<ConversationHttp> {
  const rows = await deps.store.listLiveConversations(v.operatorId);
  const visible = rows.filter((r) => grantedAreas.has(r.area));
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
 * Run the stored question's turn and settle it (transaction 2), then return the
 * pair as the database now holds it. A run that throws ⇒ FAILED / PROVIDER; a
 * settle that fails leaves the row PENDING (abandoned by the next read).
 */
async function runAndSettle(
  v: Viewer, conversationId: string, pair: TurnPair, clientRequestId: string, question: string, access: AreaAccess,
  deps: { store: ConversationTurnStoreSeam } & TurnRunDeps,
): Promise<{ pair: TurnPair; memoryProposal: MemoryProposalCard | null }> {
  let outcome: ConversationTurnOutcome;
  try { outcome = await deps.runTurn({ operatorId: v.operatorId, conversationId, question, access }); }
  catch { outcome = { status: "FAILED", failureCode: "PROVIDER" }; }
  try { await deps.store.settleTurn(v.operatorId, conversationId, pair.assistant.id, outcome); } catch { /* stays PENDING ⇒ ABANDONED later */ }
  const settled = (await deps.store.findTurnPair(v.operatorId, conversationId, clientRequestId)) ?? pair;
  return { pair: settled, memoryProposal: outcome.status === "COMPLETE" ? outcome.memoryProposal ?? null : null };
}

/** v0's pre-provider gates (§5.3): kill switch → global freeze → daily cap. null = admitted. */
async function admit(v: Viewer, deps: TurnAdmissionDeps & { now(): Date }): Promise<ConversationHttp | null> {
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
  return null;
}

const VALIDATION = (): ConversationHttp =>
  ({ status: 400, body: { error: `Send { clientRequestId: <uuid>, question: 1–${PLATFORM_AI_MESSAGE_MAX} characters }.`, code: "VALIDATION" } });

type TurnDeps = ConversationDeps & TurnAdmissionDeps & TurnRunDeps & { store: ConversationStoreSeam & ConversationTurnStoreSeam };

/**
 * POST /conversations `{ clientRequestId, question }` — create = the first
 * question. The area is the server's (platformAiAreaFor, via the viewer gate).
 *
 * GATE ORDER (pinned in turn.test.ts; S2 on #431). The route has run: the flag
 * (404) → the session → the fresh route guard → the #352 limiter. Then here:
 *   1. body validation (400);
 *   2. replay lookup, METADATA ONLY (findCreateConversation: no message read,
 *      nothing decrypted); a known key ⇒ the conversation's OWN area fresh check
 *      (refused ⇒ the ONE 404) and only THEN the stored pair (findTurnPair);
 *   3. admission gates: kill switch → freeze → daily cap;
 *   4. the area guard for the new conversation's area, then create + the turn.
 *   · a REPLAY of a known createRequestId is answered from the store: no
 *     admission gate, no model call, no daily turn (§5.1);
 *   · v0's gates, then the area's FRESH guard (its binding) — every refusal
 *     BEFORE anything is stored (§5.3);
 *   · transaction 1 stores the conversation, the scrubbed USER row and a PENDING
 *     ASSISTANT row; the turn runs OUTSIDE any transaction; transaction 2 settles
 *     it COMPLETE (answer + evidence refs) or FAILED (a closed code).
 */
export async function handleCreateConversation(v: Viewer, body: unknown, deps: TurnDeps): Promise<ConversationHttp> {
  const parsed = parseTurnBody(body);
  if (!parsed) return VALIDATION();
  const prior = await deps.store.findCreateConversation(v.operatorId, parsed.clientRequestId);
  if (prior) {
    if (prior.kind === "DELETED") return notFound();
    // The replayed conversation's OWN area, fresh (step 6) — BEFORE any content is read or decrypted.
    const access = await deps.areaAccess(prior.conversation.area, v.operatorId);
    if (!access) return notFound();
    const pair = await deps.store.findTurnPair(v.operatorId, prior.conversation.id, parsed.clientRequestId);
    if (!pair) return notFound();
    return pairResponse(200, prior.conversation, pair, access);
  }
  const refused = await admit(v, deps);
  if (refused) return refused;
  const access = await deps.areaAccess(v.area, v.operatorId);
  if (!access) return notFound();
  // One scrub for both sinks (S2 B3): this exact string is stored AND sent.
  const scrubbedQuestion = scrubOperatorText(parsed.question, PLATFORM_AI_MESSAGE_MAX);
  const out = await deps.store.createConversation({ operatorId: v.operatorId, area: v.area, createRequestId: parsed.clientRequestId, scrubbedQuestion });
  switch (out.kind) {
    case "LIMIT":
      return { status: 409, body: { error: "Delete a conversation to start another.", code: "CONVERSATION_LIMIT", limits: { conversations: { max: PLATFORM_AI_CONVERSATIONS_MAX } } } };
    case "DELETED":
      return notFound();
    case "REPLAY": {
      // A concurrent create with the same key won: answer as a replay (no turn here).
      const a = out.conversation.area === v.area ? access : await deps.areaAccess(out.conversation.area, v.operatorId);
      if (!a) return notFound();
      return pairResponse(200, out.conversation, out.pair, a);
    }
    case "CREATED": {
      const r = await runAndSettle(v, out.conversation.id, out.pair, parsed.clientRequestId, scrubbedQuestion, access, deps);
      return pairResponse(201, out.conversation, r.pair, access, r.memoryProposal);
    }
  }
}

/**
 * POST /conversations/[id]/messages `{ clientRequestId, question }` — the next
 * question of a live conversation (design §10).
 *
 * GATE ORDER (pinned in turn.test.ts; S2 on #431). The route has run: the flag
 * (404) → the session → the fresh route guard → the #352 limiter. Then here:
 * id shape → the live OWNED conversation (metadata only) → the conversation's
 * OWN area fresh check (404) → body validation → replay lookup (the only read
 * of stored content) → admission gates (kill → freeze → cap) → append / turn.
 *   steps 5–6  owner-scoped lookup, then the conversation's OWN area FRESH; any
 *              refusal (not found, not the operator's, deleted, area revoked
 *              between turns) ⇒ the ONE 404, and no turn runs;
 *   replay     a known clientRequestId ⇒ the stored pair (COMPLETE / FAILED ⇒
 *              200, PENDING ⇒ 409 TURN_IN_FLIGHT): no gate, no model, no daily turn;
 *   gates      kill switch → freeze → daily cap (nothing stored on refusal);
 *   append     transaction 1 (abandon a stale PENDING, one in-flight turn per
 *              conversation ⇒ 409 TURN_IN_FLIGHT, the 40-message cap ⇒ 409
 *              CONVERSATION_FULL), then the turn, then transaction 2.
 * No audit row (S2 B8): the AiInvocation ledger records the turn's calls.
 */
export async function handleAppendMessage(v: Viewer, id: string, body: unknown, deps: TurnDeps): Promise<ConversationHttp> {
  if (!CONVERSATION_ID.test(id)) return notFound();
  const meta = await deps.store.findLiveConversation(v.operatorId, id);
  if (!meta) return notFound();
  const access = await deps.areaAccess(meta.area, v.operatorId);
  if (!access) return notFound();
  const parsed = parseTurnBody(body);
  if (!parsed) return VALIDATION();
  const prior = await deps.store.findTurnPair(v.operatorId, id, parsed.clientRequestId);
  if (prior) return pairResponse(200, null, prior, access);
  const refused = await admit(v, deps);
  if (refused) return refused;
  const scrubbedQuestion = scrubOperatorText(parsed.question, PLATFORM_AI_MESSAGE_MAX);
  const out = await deps.store.appendTurn({ operatorId: v.operatorId, conversationId: id, clientRequestId: parsed.clientRequestId, scrubbedQuestion, now: deps.now() });
  switch (out.kind) {
    case "NOT_FOUND":
      return notFound();
    case "IN_FLIGHT":
      return { status: 409, body: { error: "This conversation is still answering a question.", code: "TURN_IN_FLIGHT" }, headers: { "Retry-After": String(PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S) } };
    case "FULL":
      return { status: 409, body: { error: "This conversation is full. Start a new one.", code: "CONVERSATION_FULL", limits: { messages: { max: PLATFORM_AI_CONVERSATION_MESSAGES_MAX } } } };
    case "REPLAY":
      return pairResponse(200, null, out.pair, access);
    case "APPENDED": {
      const r = await runAndSettle(v, id, out.pair, parsed.clientRequestId, scrubbedQuestion, access, deps);
      return pairResponse(200, null, r.pair, access, r.memoryProposal);
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
