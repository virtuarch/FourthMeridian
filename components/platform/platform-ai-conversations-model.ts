/**
 * components/platform/platform-ai-conversations-model.ts  (Platform AI conversations, PR C: the client model, PURE)
 *
 * Design: docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §4.3 (stale labels),
 * §10 (the API this reads), §11 (UX). No React, no fetch, no storage, no clock:
 * every function takes what it needs, so the DOM-less tests can pin it.
 *
 * WHAT THE CLIENT TRUSTS. Nothing about authority: every route re-applies the
 * whole gate chain server-side (§3.1). The response bodies are still parsed
 * DEFENSIVELY here (an unknown segment kind is dropped, a link is a link only
 * when the server re-resolved it to an href this turn, and the renderer then
 * applies `isSameOriginPath` on top). There is no Markdown parser anywhere on
 * this path: an answer is the typed segment list the server stored (§2.5).
 */

// ── The OD-5 disclosure line ────────────────────────────────────────────────

/**
 * ⚠️ OD-5 WORDING PENDING OWNER. Placeholder only — NOT legal or policy text.
 *
 * The design (§8) flags that the public AI and privacy pages describe the
 * customer AI only, and that how operators are told their Platform AI
 * conversations are stored is OWNER DECISION OD-5 (public change, internal
 * operator notice, or this in-page line). PR C ships the one line, in one
 * place, with neutral placeholder wording; the owner's wording replaces this
 * string and nothing else. It states no retention period, no provider term and
 * no policy commitment.
 */
export const PLATFORM_AI_CONVERSATIONS_DISCLOSURE =
  "Conversations are saved to your operator account so you can come back to them. [OD-5: disclosure wording pending owner]";
/** Marker the tests (and a reviewer's grep) use to find the placeholder. */
export const PLATFORM_AI_CONVERSATIONS_DISCLOSURE_PENDING = "OD-5: disclosure wording pending owner";

/**
 * The v0 privacy hint, UNCHANGED (components/platform/PlatformAiAsk.tsx renders
 * the same sentence; the test pins the two equal). It keeps the v0 pattern:
 * `data-platform-ai-privacy-hint`, tied to the question box by aria-describedby.
 */
export const PLATFORM_AI_PRIVACY_HINT =
  "Don’t enter customer names, emails, account numbers or other personal details. Questions are sent to our AI provider.";

// ── The API (PR B / B2 routes; no server change) ────────────────────────────

export const PLATFORM_AI_CONVERSATIONS_URL = "/api/platform/ai/conversations";
export const conversationUrl = (id: string) => `${PLATFORM_AI_CONVERSATIONS_URL}/${encodeURIComponent(id)}`;
export const conversationMessagesUrl = (id: string) => `${conversationUrl(id)}/messages`;
/** v0's question bound (PLATFORM_AI_MESSAGE_MAX = PLATFORM_AI_QUESTION_MAX = 500; pinned equal in the test). */
export const PLATFORM_AI_COMPOSER_MAX = 500;

/** A rendered answer segment as the server sends it (handlers.ts RenderedSegment). */
export type ClientSegment =
  | { kind: "text"; text: string }
  | { kind: "figure"; text: string; metric: string; window: string | number | null }
  | { kind: "link"; text: string; href: string }
  /** S2 F-C1 (ii): the server's period correction — rendered prominently ABOVE the answer. */
  | { kind: "correction"; text: string };

export interface ClientCitation { metric: string; label: string; window: string }

export type ClientMessageStatus = "PENDING" | "COMPLETE" | "FAILED";
export type ClientFailureCode = "TIMEOUT" | "PROVIDER" | "KILL_SWITCH" | "ABANDONED";

export interface ClientMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  status: ClientMessageStatus;
  createdAt: string;
  completedAt: string | null;
  /** USER: the stored (scrubbed) question. ASSISTANT: the typed segments. null when pending / failed / unreadable. */
  content: string | ClientSegment[] | null;
  citations: ClientCitation[];
  notes: string[];
  failureCode: ClientFailureCode | null;
  unavailable: boolean;
  /** Every prior ASSISTANT message read back from the store is stale (§4.3); a just-answered one is not. */
  stale: boolean;
}

export interface ClientConversation {
  id: string;
  area: string;
  areaLabel: string;
  createdAt: string;
  lastActivityAt: string;
  label?: string;
  messageCount?: number;
  full?: boolean;
}

export interface ClientLimits { used: number; max: number }

// ── Defensive parsing ───────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseSegment(s: unknown): ClientSegment | null {
  if (!isObj(s) || typeof s.text !== "string") return null;
  if (s.kind === "text") return { kind: "text", text: s.text };
  if (s.kind === "correction") return { kind: "correction", text: s.text };
  if (s.kind === "figure" && typeof s.metric === "string") {
    const w = s.window;
    return { kind: "figure", text: s.text, metric: s.metric, window: typeof w === "string" || typeof w === "number" ? w : null };
  }
  if (s.kind === "link" && typeof s.href === "string") return { kind: "link", text: s.text, href: s.href };
  return null; // an unknown kind is dropped, never shown as raw text
}

const STATUSES: readonly ClientMessageStatus[] = ["PENDING", "COMPLETE", "FAILED"];
const FAILURES: readonly ClientFailureCode[] = ["TIMEOUT", "PROVIDER", "KILL_SWITCH", "ABANDONED"];

export function parseMessage(m: unknown): ClientMessage | null {
  if (!isObj(m)) return null;
  const id = str(m.id), createdAt = str(m.createdAt);
  const role = m.role === "USER" || m.role === "ASSISTANT" ? m.role : null;
  const status = STATUSES.includes(m.status as ClientMessageStatus) ? (m.status as ClientMessageStatus) : null;
  if (!id || !createdAt || !role || !status) return null;
  let content: ClientMessage["content"] = null;
  if (role === "USER" && typeof m.content === "string") content = m.content;
  if (role === "ASSISTANT" && Array.isArray(m.content)) content = m.content.map(parseSegment).filter((s): s is ClientSegment => s !== null);
  const citations = Array.isArray(m.citations)
    ? m.citations.filter((c): c is ClientCitation => isObj(c) && typeof c.metric === "string" && typeof c.label === "string" && typeof c.window === "string")
      .map((c) => ({ metric: c.metric, label: c.label, window: c.window }))
    : [];
  const notes = Array.isArray(m.notes) ? m.notes.filter((n): n is string => typeof n === "string") : [];
  return {
    id, role, status, createdAt, completedAt: str(m.completedAt), content, citations, notes,
    failureCode: FAILURES.includes(m.failureCode as ClientFailureCode) ? (m.failureCode as ClientFailureCode) : null,
    unavailable: m.unavailable === true,
    stale: m.stale === true && role === "ASSISTANT",
  };
}

export function parseConversation(c: unknown): ClientConversation | null {
  if (!isObj(c)) return null;
  const id = str(c.id), area = str(c.area), areaLabel = str(c.areaLabel), createdAt = str(c.createdAt), lastActivityAt = str(c.lastActivityAt);
  if (!id || !area || !areaLabel || !createdAt || !lastActivityAt) return null;
  return {
    id, area, areaLabel, createdAt, lastActivityAt,
    ...(typeof c.label === "string" ? { label: c.label } : {}),
    ...(typeof c.messageCount === "number" ? { messageCount: c.messageCount } : {}),
    ...(typeof c.full === "boolean" ? { full: c.full } : {}),
  };
}

export function parseList(body: unknown): { conversations: ClientConversation[]; limits: ClientLimits | null } | null {
  if (!isObj(body) || !Array.isArray(body.conversations)) return null;
  const conversations = body.conversations.map(parseConversation).filter((c): c is ClientConversation => c !== null);
  const l = isObj(body.limits) && isObj(body.limits.conversations) ? body.limits.conversations : null;
  const limits = l && typeof l.used === "number" && typeof l.max === "number" ? { used: l.used, max: l.max } : null;
  return { conversations, limits };
}

export function parseThread(body: unknown): { conversation: ClientConversation; messages: ClientMessage[] } | null {
  if (!isObj(body) || !Array.isArray(body.messages)) return null;
  const conversation = parseConversation(body.conversation);
  if (!conversation) return null;
  return { conversation, messages: body.messages.map(parseMessage).filter((m): m is ClientMessage => m !== null) };
}

export function parsePair(body: unknown): { conversation: ClientConversation | null; user: ClientMessage; assistant: ClientMessage } | null {
  if (!isObj(body)) return null;
  const user = parseMessage(body.userMessage), assistant = parseMessage(body.assistantMessage);
  if (!user || !assistant || user.role !== "USER" || assistant.role !== "ASSISTANT") return null;
  return { conversation: body.conversation === undefined ? null : parseConversation(body.conversation), user, assistant };
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** v0's refusal sentences (components/platform/PlatformAiAsk.tsx REFUSAL_COPY; pinned equal in the test). */
export const REFUSAL_COPY: Readonly<Record<string, string>> = {
  KILL_SWITCH: "AI requests are paused on this platform.",
  COST_FREEZE: "Platform costs are frozen, so AI is not running.",
  DAILY_TURNS: "You have used today's Platform AI questions. It resets at midnight UTC.",
  ALLOWANCE_UNAVAILABLE: "Platform AI could not check its limits, so it did not run.",
  TIMEOUT: "That took too long, so it was stopped.",
  PROVIDER: "The AI provider did not answer.",
  NO_SURFACE: "Your access does not include Platform AI.",
};

/** A FAILED assistant turn's sentence, by its closed code (S2 Q6: never provider text). */
export const FAILURE_COPY: Readonly<Record<ClientFailureCode, string>> = {
  TIMEOUT: REFUSAL_COPY.TIMEOUT,
  PROVIDER: REFUSAL_COPY.PROVIDER,
  KILL_SWITCH: REFUSAL_COPY.KILL_SWITCH,
  ABANDONED: "This question was interrupted before it was answered.",
};

export const CONVERSATION_FULL_COPY = "This conversation is full. Start a new conversation to keep asking.";
export const CONVERSATION_LIMIT_COPY = "You have reached the conversation limit. Delete a conversation to start another.";
export const TURN_IN_FLIGHT_COPY = "This conversation is still answering a question.";
export const NOT_FOUND_COPY = "This conversation is no longer available.";
export const EARLIER_EXPIRED_COPY = "Earlier messages in this conversation have expired.";
export const DELETE_CONFIRM_COPY = "Deleted conversations can't be recovered.";
export const UNAVAILABLE_COPY = "Platform AI is unavailable right now.";
export const UNREADABLE_COPY = "This message can't be shown.";

/** What the client does with a non-2xx response (by status and the closed `code` / `reason`). */
export type SendProblem =
  | { kind: "FULL"; text: string }
  | { kind: "LIMIT"; text: string }
  | { kind: "IN_FLIGHT"; text: string }
  | { kind: "NOT_FOUND"; text: string }
  | { kind: "REFUSED"; text: string }
  | { kind: "NETWORK"; text: string };

export function problemFor(status: number, body: unknown): SendProblem {
  const code = isObj(body) ? str(body.code) : null;
  const reason = isObj(body) ? str(body.reason) : null;
  if (status === 409 && code === "CONVERSATION_FULL") return { kind: "FULL", text: CONVERSATION_FULL_COPY };
  if (status === 409 && code === "CONVERSATION_LIMIT") return { kind: "LIMIT", text: CONVERSATION_LIMIT_COPY };
  if (status === 409 && code === "TURN_IN_FLIGHT") return { kind: "IN_FLIGHT", text: TURN_IN_FLIGHT_COPY };
  if (status === 404 && code === "NOT_FOUND") return { kind: "NOT_FOUND", text: NOT_FOUND_COPY };
  if (reason && REFUSAL_COPY[reason]) return { kind: "REFUSED", text: REFUSAL_COPY[reason] };
  if (status === 429) return { kind: "REFUSED", text: "Too many questions — try again shortly." };
  return { kind: "REFUSED", text: UNAVAILABLE_COPY };
}

// ── Time (stale labels go by createdAt, S2 Q7) ──────────────────────────────

/** A short relative time ("just now", "5 min ago", "3 h ago", "2 days ago"); an unparseable value ⇒ "earlier". */
export function relativeTime(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "earlier";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

/** An absolute UTC stamp for a title attribute ("2026-01-02 03:04 UTC"); unparseable ⇒ "". */
export function utcStamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** §4.3: the line over every prior answer. */
export const answeredLine = (iso: string, now: Date) => `Answered ${relativeTime(iso, now)}. Figures are as of then.`;
/** §4.3: the chip on each prior figure. */
export const asOfChip = (iso: string, now: Date) => `as of ${relativeTime(iso, now)}`;

/**
 * = PLATFORM_AI_RETENTION_DAYS in lib/platform/intelligence/ai/conversations/constants.ts.
 * DUPLICATED because this module has no imports; pinned equal in
 * platform-ai-conversations.test.ts (the migration-pin pattern). Change both together.
 */
export const PLATFORM_AI_RETENTION_DAYS_CLIENT = 90;
const RETENTION_MS = PLATFORM_AI_RETENTION_DAYS_CLIENT * 24 * 60 * 60 * 1000;

/**
 * R1 option (b): messages expire per pair, so a long-lived thread can lose its
 * oldest exchanges. Retention is the ONLY way a message disappears, and it can't
 * act before PLATFORM_AI_RETENTION_DAYS (S2 on #434). So the note shows only when
 * BOTH hold:
 *   - the conversation is at least the retention window old (now − createdAt ≥ 90 d);
 *   - its first remaining message was written well after the conversation was
 *     created. The conversation and its first pair share ONE transaction (same
 *     `now()`); a minute of slack absorbs clock rounding.
 * Nothing here is a retention claim.
 */
export function earlierMessagesExpired(conversation: Pick<ClientConversation, "createdAt">, messages: readonly Pick<ClientMessage, "createdAt">[], now: Date): boolean {
  if (messages.length === 0) return false;
  const c = Date.parse(conversation.createdAt), f = Date.parse(messages[0].createdAt);
  if (!Number.isFinite(c) || !Number.isFinite(f)) return false;
  return now.getTime() - c >= RETENTION_MS && f - c > 60_000;
}

/** The newest message is a PENDING answer ⇒ a turn is in flight (the composer is disabled). */
export const hasPendingTurn = (messages: readonly ClientMessage[]) => messages.some((m) => m.role === "ASSISTANT" && m.status === "PENDING");

/** The question a FAILED answer replied to (the USER message just before it), for "Try again" with a NEW id. */
export function questionBefore(messages: readonly ClientMessage[], assistantIndex: number): string | null {
  const prev = messages[assistantIndex - 1];
  return prev && prev.role === "USER" && typeof prev.content === "string" ? prev.content : null;
}

/** Per-viewer convenience only (§11): the desktop rail's collapsed state. Never content, never shared. */
export const RAIL_COLLAPSED_KEY = "fm.platform-ai.rail-collapsed";
