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
 *   P4 records   a stored RECORD segment is rendered at READ time for THIS viewer by
 *                authz/record-render.ts (AreaAccess.renderRecords: a fresh area check per
 *                render, revalidate, T2 only with a fresh CS tier + the audit row first);
 *                absent ⇒ "[no longer available]" (fail closed). Never the stored id.
 *   P4b areas    a TURN binds the areas the operator holds NOW (deps.heldAccess, ./multi-area.ts):
 *                the own area (step 6, unchanged) + every other held area behind ITS OWN fresh
 *                guard; the boundary rechecks per tool call. An answer that read an area the
 *                operator no longer holds renders "[no longer available]" whole (view, replay,
 *                history) and its records are never rendered. Absent dep ⇒ the pre-P4b single area.
 */

import type { PlatformArea } from "@prisma/client";
import { scrubOperatorText } from "@/lib/ai/privacy/scrub";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import { admitPlatformAiSpend, pickerGuardRefusal, type PlatformAiBinding, type PlatformAiGuardVerdict, type PlatformAiSpendAdmission, type PlatformAiSpendGate } from "../core";
import { RECORD_GONE_TEXT } from "../compose/record";
import type { StoredAnswer, StoredRecordSegment } from "./answer";
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
import type { PlatformAiToolTraceEntry } from "../tools/tool-trace";
import { storedFigureSources, type PlacedSpan } from "../tools/figure-sources";
import type { ScopedArea } from "../authz/boundary";
import { extractSubjects, storedSubjectText, type SubjectFlags, type SubjectIdentifier } from "../authz/subject";
import { answerReadable, type TurnAreaPart } from "./multi-area";

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
  /** P2 — the route-issued scope for `area` (authz/scope.ts); the turn boundary rechecks it per tool call. Absent ⇒ every tool call is refused. */
  scope?: ScopedArea;
  /** Platform AI memory (design v2 §2): the authorized readers built from THE SAME fresh guard result. */
  memoryReaders?: MemoryReaders;
  /**
   * P4 — render stored record segments for THIS viewer (authz/record-render.ts; one fresh
   * check per area per call). Absent ⇒ every record segment renders "[no longer available]".
   */
  renderRecords?(segments: readonly StoredRecordSegment[]): Promise<ReadonlyMap<StoredRecordSegment, string>>;
  /**
   * P4b — the TURN's areas: `scope` first, then every other area the operator holds now, each
   * from its own fresh guard (./multi-area.ts widenConversationAccess). Absent ⇒ [scope] only.
   */
  turnAreas?: readonly TurnAreaPart[];
  /**
   * P4b — the areas this viewer holds NOW (own + widened). A stored answer that read any other
   * area is shown / replayed as "[no longer available]". Absent ⇒ no such filter (pre-P4b).
   */
  heldAreas?: ReadonlySet<PlatformArea>;
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
  /**
   * `subjects` (P5) — present only when the question carried exact customer identifiers and
   * resolution is on: the SLOTTED scrubbed text and the identifiers (memory only; never stored).
   * The runner resolves them through THIS turn's boundary; `question` (the stored text) has `[customer]`.
   */
  runTurn(input: { operatorId: string; conversationId: string; question: string; access: AreaAccess; subjects?: TurnSubjects }): Promise<ConversationTurnOutcome>;
  /** P5 — the customers pack flag (strict, default OFF). Absent / false ⇒ the question is scrubbed exactly as before. */
  subjectsEnabled?(): boolean;
  /**
   * P8 — the customers / incidents flags (authz/subject.server.ts platformAiSubjectFlags): which slots are
   * customer lookups decides the STORED text (an incident id or a passthrough identifier is never `[customer]`).
   * Absent ⇒ every slot stores `[customer]` (P5 behaviour).
   */
  subjectFlags?(): SubjectFlags;
  /**
   * S2 09fc G6 — the bare-username guard (authz/people.ts runPickerGuard) on the RAW question of EVERY turn
   * (create and follow-up), after the admission gates and BEFORE the spend, the scrub, anything stored and
   * the provider. A refusal ⇒ 422 USE_PEOPLE_PICKER / EMAIL_REMINDER: nothing stored, no turn.
   * S2 09fl C1: REQUIRED (type level); absent at run time ⇒ refused fail-closed (503 GUARD_UNAVAILABLE).
   */
  guard(v: Viewer, rawQuestion: string): Promise<PlatformAiGuardVerdict>;
}

/** P5 — the subject slots of one question (authz/subject.ts). Never stored, never logged. */
export interface TurnSubjects { readonly slotted: string; readonly ids: readonly SubjectIdentifier[] }

/**
 * P5 — one scrub for both sinks, with subject resolution: exact identifiers are cut out of the RAW
 * question BEFORE the scrub; the STORED text shows `[customer]` per identifier (no identifier, no
 * handle is ever stored); the slots + identifiers go to the runner. Off / none ⇒ exactly as before.
 * P8 — with `flags`: a full cuid while the incidents flag is ON stores `[id]` (it may be an incident id), and
 * with the customers flag OFF every identifier stores its scrubbed form (authz/subject.ts storedSubjectText).
 */
export function scrubWithSubjects(question: string, enabled: boolean, flags?: SubjectFlags): { stored: string; subjects?: TurnSubjects } {
  if (!enabled) return { stored: scrubOperatorText(question, PLATFORM_AI_MESSAGE_MAX) };
  const ex = extractSubjects(question);
  if (ex.ids.length === 0) return { stored: scrubOperatorText(question, PLATFORM_AI_MESSAGE_MAX) };
  const slotted = scrubOperatorText(ex.text, PLATFORM_AI_MESSAGE_MAX);
  return { stored: storedSubjectText(slotted, ex.ids, flags), subjects: { slotted, ids: ex.ids } };
}

const subjectsOn = (deps: TurnRunDeps): boolean => { try { return deps.subjectsEnabled?.() === true; } catch { return false; } };
const subjectFlagsOf = (deps: TurnRunDeps): SubjectFlags | undefined => { try { return deps.subjectFlags?.(); } catch { return { customers: false, incidents: false }; } };

export interface ConversationDeps {
  /** Step 6: a FRESH guard on `area` for THIS operator; null on any refusal (⇒ 404). */
  areaAccess(area: PlatformArea, operatorId: string): Promise<AreaAccess | null>;
  /**
   * P4b — widen the conversation's OWN access (already fresh) to every other area the operator
   * holds, each behind its own fresh guard (area-access.ts conversationHeldAccess). Absent ⇒ the
   * pre-P4b single-area access; a throw ⇒ the own area only (fail closed).
   */
  heldAccess?(own: AreaAccess, operatorId: string): Promise<AreaAccess>;
  store: ConversationStoreSeam;
  now(): Date;
}

/** The pre-provider gates of a create (v0's order, §5.3): every refusal before anything is stored. */
export interface TurnAdmissionDeps {
  admission(): Promise<{ paused: boolean }>;
  freeze(): Promise<{ frozen: boolean }>;
  turns(operatorId: string, now: Date): Promise<{ allowed: boolean; detail?: string }>;
  /**
   * P2b — the daily $ caps' reservation (lib/platform/ai/platform-ai-spend.ts), AFTER the daily
   * cap. Both conversation routes pass it (pinned in lib/platform/ai/platform-ai-spend.test.ts);
   * absent ⇒ no $ gate (unit tests). An admitted reservation is released after the turn settles.
   */
  spend?(operatorId: string, now: Date): Promise<PlatformAiSpendGate>;
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

/** The rendered text of each record segment (P4), by segment object. */
export type RenderedRecords = ReadonlyMap<StoredRecordSegment, string>;

/**
 * P4 — render the record segments of these messages for this viewer in ONE call (no record
 * segment ⇒ no call, no read). A throw or no renderer ⇒ an empty map (each renders gone).
 */
export async function renderMessageRecords(messages: readonly MessageRecord[], access: AreaAccess | null): Promise<RenderedRecords> {
  // P4b: an answer that read an area the viewer no longer holds is never rendered (no recheck, no audit, no T2).
  const segs = messages.flatMap((m) => (m.role === "ASSISTANT" && m.content !== null && typeof m.content !== "string" && answerReadable(m.evidenceRefs, m.content, access?.heldAreas)
    ? m.content.segments.filter((x): x is StoredRecordSegment => x.kind === "record") : []));
  if (segs.length === 0 || !access?.renderRecords) return new Map();
  try { return await access.renderRecords(segs); } catch { return new Map(); }
}

/** A stored answer for the client: links re-resolved through the CURRENT token (§3.4); a dead link is plain text; P4 records rendered for this viewer. */
export function renderStoredAnswer(a: StoredAnswer, access: AreaAccess | null, records: RenderedRecords = new Map()): RenderedSegment[] {
  return a.segments.map((s): RenderedSegment => {
    if (s.kind === "record") return { kind: "text", text: records.get(s) ?? RECORD_GONE_TEXT };
    if (s.kind === "link") {
      const r = access?.resolvePage(s.page, s.params) ?? null;
      return r ? { kind: "link", text: s.text, href: r.href } : { kind: "text", text: s.text };
    }
    if (s.kind === "correction" || s.kind === "note") return { kind: s.kind, text: s.text };
    if (s.kind === "memory") return { kind: "memory", text: s.text };
    return s.kind === "figure" ? { kind: "figure", text: s.text, metric: s.metric, window: s.window } : { kind: "text", text: s.text };
  });
}

export function messageDto(m: MessageRecord, access: AreaAccess | null, stale: boolean, records: RenderedRecords = new Map()): Record<string, unknown> {
  const stored = m.role === "ASSISTANT" && m.content !== null && typeof m.content !== "string" ? m.content : null;
  // P4b: an answer that read an area the viewer no longer holds ⇒ the one marker, nothing of it (no figure, citation or note).
  const lost = stored !== null && !answerReadable(m.evidenceRefs, stored, access?.heldAreas);
  const answer = lost ? null : stored;
  if (lost) {
    return {
      id: m.id, role: m.role, status: m.status, createdAt: m.createdAt.toISOString(), completedAt: m.completedAt ? m.completedAt.toISOString() : null,
      content: [{ kind: "text", text: RECORD_GONE_TEXT }], citations: [], notes: [], failureCode: m.failureCode, unavailable: m.unreadable, stale: stale && m.role === "ASSISTANT",
    };
  }
  return {
    id: m.id,
    role: m.role,
    status: m.status,
    createdAt: m.createdAt.toISOString(),
    completedAt: m.completedAt ? m.completedAt.toISOString() : null,
    content: m.role === "USER" ? (typeof m.content === "string" ? m.content : null) : answer ? renderStoredAnswer(answer, access, records) : null,
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
async function pairResponse(status: number, conversation: ConversationRecord | null, pair: TurnPair, access: AreaAccess | null, memoryProposal?: MemoryProposalCard | null,
  /** S2 09hu G1 — THIS request's turn trace (metadata only; never stored, so never on a replay). */
  toolTrace?: readonly PlatformAiToolTraceEntry[],
  /** B1 — THIS request's placed spans (metadata only; never stored, so never on a replay), positioned on the content below. */
  figureSources?: readonly PlacedSpan[]): Promise<ConversationHttp> {
  if (pair.assistant.status === "PENDING" && status === 200) {
    return { status: 409, body: { error: "This question is still being answered.", code: "TURN_IN_FLIGHT" }, headers: { "Retry-After": String(PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S) } };
  }
  const records = await renderMessageRecords([pair.assistant], access);
  const assistantMessage = messageDto(pair.assistant, access, false, records);
  // B1: each placed span's segment in assistantMessage.content (1:1 with the stored segments) — fail closed to [].
  const stored = pair.assistant.status === "COMPLETE" && pair.assistant.content !== null && typeof pair.assistant.content !== "string" ? pair.assistant.content.segments : null;
  const content = Array.isArray(assistantMessage.content) ? (assistantMessage.content as { kind: string; text: string }[]) : null;
  const positioned = figureSources ? (stored && content ? storedFigureSources(figureSources, stored, content) : []) : null;
  return {
    status,
    body: {
      ...(conversation ? { conversation: conversationDto(conversation) } : {}),
      userMessage: messageDto(pair.user, access, false),
      assistantMessage,
      // Memory (design v2 §3): the confirm card of THIS turn only — never stored, never on a replay.
      ...(memoryProposal && pair.assistant.status === "COMPLETE" ? { memoryProposal } : {}),
      // S2 09hu G1: the metadata-only tool trace of the turn THIS request ran (tools/tool-trace.ts) — response only.
      ...(toolTrace ? { toolTrace: [...toolTrace] } : {}),
      // B1: the metadata-only figure sources of the turn THIS request ran (tools/figure-sources.ts) — response only.
      ...(positioned ? { figureSources: positioned } : {}),
    },
  };
}

/**
 * P4b — the access for a TURN and for showing its answers: the own access widened to every other
 * held area (deps.heldAccess). Absent ⇒ `own` (pre-P4b). A throw ⇒ the own area only (fail closed:
 * the turn binds one area and any answer that read another renders "[no longer available]").
 */
async function heldAccessFor(deps: Pick<ConversationDeps, "heldAccess">, own: AreaAccess, operatorId: string): Promise<AreaAccess> {
  if (!deps.heldAccess) return own;
  try { return await deps.heldAccess(own, operatorId); } catch { return { ...own, heldAreas: new Set(own.area ? [own.area] : []) }; }
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
  deps: { store: ConversationTurnStoreSeam } & TurnRunDeps, subjects?: TurnSubjects,
): Promise<{ pair: TurnPair; memoryProposal: MemoryProposalCard | null; toolTrace: readonly PlatformAiToolTraceEntry[]; figureSources: readonly PlacedSpan[] }> {
  let run: ConversationTurnOutcome;
  try { run = await deps.runTurn({ operatorId: v.operatorId, conversationId, question, access, ...(subjects ? { subjects } : {}) }); }
  catch { run = { status: "FAILED", failureCode: "PROVIDER" }; }
  // S2 09hu G1: the tool trace is RESPONSE ONLY — it is split off before the settle, so it can never be stored.
  // B1: so are the figure sources (placed spans' closed codes) — split off here, never stored.
  const { toolTrace, figureSources, ...outcome } = run;
  try { await deps.store.settleTurn(v.operatorId, conversationId, pair.assistant.id, outcome); } catch { /* stays PENDING ⇒ ABANDONED later */ }
  const settled = (await deps.store.findTurnPair(v.operatorId, conversationId, clientRequestId)) ?? pair;
  return { pair: settled, memoryProposal: outcome.status === "COMPLETE" ? outcome.memoryProposal ?? null : null, toolTrace: toolTrace ?? [], figureSources: figureSources ?? [] };
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

/**
 * P2b — the daily $ caps (core.ts admitPlatformAiSpend), run right after `admit`: COST_CAP ⇒
 * 429 + Retry-After to UTC midnight; unavailable ⇒ 503 ALLOWANCE_UNAVAILABLE (fail closed).
 * Nothing is stored on a refusal; an admission is released in `finally` by the caller.
 */
async function holdSpend(v: Viewer, deps: TurnAdmissionDeps & { now(): Date }): Promise<{ refused: ConversationHttp | null; held: PlatformAiSpendAdmission }> {
  const held = await admitPlatformAiSpend(deps.spend, v.operatorId, deps.now());
  if (!held.refusal) return { refused: null, held };
  const r = held.refusal;
  return { refused: unavailable(r.status, r.reason, r.retryAfter ? { "Retry-After": String(r.retryAfter) } : undefined), held };
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
    return pairResponse(200, prior.conversation, pair, await heldAccessFor(deps, access, v.operatorId));
  }
  const refused = await admit(v, deps);
  if (refused) return refused;
  // S2 09fc G6 — the bare-username guard on the RAW question, before the spend, the scrub and anything stored.
  const guarded = await pickerGuardRefusal(typeof deps.guard === "function" ? (raw) => deps.guard(v, raw) : undefined, parsed.question);
  if (guarded) return guarded;
  const cost = await holdSpend(v, deps);
  if (cost.refused) return cost.refused;
  try {
    const access = await deps.areaAccess(v.area, v.operatorId);
    if (!access) return notFound();
    // One scrub for both sinks (S2 B3): this exact string is stored AND sent (P5: with subjects, the
    // stored text has `[customer]` and the model text the resolved slot — see scrubWithSubjects).
    const { stored: scrubbedQuestion, subjects } = scrubWithSubjects(parsed.question, subjectsOn(deps), subjectFlagsOf(deps));
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
        return pairResponse(200, out.conversation, out.pair, await heldAccessFor(deps, a, v.operatorId));
      }
      case "CREATED": {
        // P4b: the turn binds the areas the operator holds NOW (own + each other area's own fresh guard).
        const turnAccess = await heldAccessFor(deps, access, v.operatorId);
        const r = await runAndSettle(v, out.conversation.id, out.pair, parsed.clientRequestId, scrubbedQuestion, turnAccess, deps, subjects);
        return pairResponse(201, out.conversation, r.pair, turnAccess, r.memoryProposal, r.toolTrace, r.figureSources);
      }
    }
  } finally {
    await cost.held.release();
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
  if (prior) return pairResponse(200, null, prior, await heldAccessFor(deps, access, v.operatorId));
  const refused = await admit(v, deps);
  if (refused) return refused;
  // S2 09fc G6 — the bare-username guard on the RAW question, before the spend, the scrub and anything stored.
  const guarded = await pickerGuardRefusal(typeof deps.guard === "function" ? (raw) => deps.guard(v, raw) : undefined, parsed.question);
  if (guarded) return guarded;
  const cost = await holdSpend(v, deps);
  if (cost.refused) return cost.refused;
  try {
    const { stored: scrubbedQuestion, subjects } = scrubWithSubjects(parsed.question, subjectsOn(deps), subjectFlagsOf(deps));
    const out = await deps.store.appendTurn({ operatorId: v.operatorId, conversationId: id, clientRequestId: parsed.clientRequestId, scrubbedQuestion, now: deps.now() });
    switch (out.kind) {
      case "NOT_FOUND":
        return notFound();
      case "IN_FLIGHT":
        return { status: 409, body: { error: "This conversation is still answering a question.", code: "TURN_IN_FLIGHT" }, headers: { "Retry-After": String(PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S) } };
      case "FULL":
        return { status: 409, body: { error: "This conversation is full. Start a new one.", code: "CONVERSATION_FULL", limits: { messages: { max: PLATFORM_AI_CONVERSATION_MESSAGES_MAX } } } };
      case "REPLAY":
        return pairResponse(200, null, out.pair, await heldAccessFor(deps, access, v.operatorId));
      case "APPENDED": {
        // P4b: the turn binds the areas the operator holds NOW — fresh guards at turn time; a lost area is simply absent.
        const turnAccess = await heldAccessFor(deps, access, v.operatorId);
        const r = await runAndSettle(v, id, out.pair, parsed.clientRequestId, scrubbedQuestion, turnAccess, deps, subjects);
        return pairResponse(200, null, r.pair, turnAccess, r.memoryProposal, r.toolTrace, r.figureSources);
      }
    }
  } finally {
    await cost.held.release();
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
  // P4b: shown for the areas held NOW (an answer that read a lost area ⇒ "[no longer available]").
  const view = await heldAccessFor(deps, access, v.operatorId);
  const records = await renderMessageRecords(read.messages, view);
  return {
    status: 200,
    body: {
      conversation: { ...conversationDto(read.conversation), messageCount: read.messages.length, full: isFull(read.messages.length) },
      messages: read.messages.map((m) => messageDto(m, view, true, records)),
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
