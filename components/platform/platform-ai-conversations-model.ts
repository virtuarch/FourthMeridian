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
 * OD-5 — owner-approved operator notice (approved 2026-11-07).
 *
 * The design (§8) flagged that the public AI and privacy pages describe the
 * customer AI only, and that how operators are told their Platform AI
 * conversations are stored is OWNER DECISION OD-5. The owner approved this
 * in-page wording on 2026-11-07, after S2 verified each claim against develop
 * 3451c3a (the claim table is kept privately). It is in-app only; the public
 * pages are unchanged. Change it only with a new owner approval and a fresh S2
 * claim check — the test pins the exact string. 2026-11-08: the owner cut
 * retention to 7 days; ONLY the duration words changed ("90 days" → "7 days").
 */
export const PLATFORM_AI_CONVERSATIONS_DISCLOSURE =
  "The text of your questions and answers is saved encrypted to your operator account. No one else can open your conversations in Fourth Meridian, and you can open them only while you have access to this area. A question and its answer are hidden 7 days after the question was asked, and a conversation you delete is hidden at once; both are then removed from our database at the next retention purge. Copies in database backups, and what was sent to OpenAI to answer you, follow their own retention terms.";

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
  /**
   * `observedAt`: when the figure's value was read, if the server sends it. Today the
   * server does not (handlers.ts RenderedSegment), so every figure of an answer shares
   * the answer's own time (createdAt) — see `staleChips`.
   */
  | { kind: "figure"; text: string; metric: string; window: string | number | null; observedAt?: string }
  | { kind: "link"; text: string; href: string }
  /** S2 F-C1 (ii): the server's period correction — rendered prominently ABOVE the answer. */
  | { kind: "correction"; text: string }
  /** F-1 (S2 2026-11-08): the server's window note — its own quiet note ABOVE the answer, never in the body. */
  | { kind: "note"; text: string }
  /** Platform AI memory: a server-rendered "noted <date>" span (never the note). */
  | { kind: "memory"; text: string };

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
  if (s.kind === "correction" || s.kind === "note") return { kind: s.kind, text: s.text };
  if (s.kind === "memory") return { kind: "memory", text: s.text };
  if (s.kind === "figure" && typeof s.metric === "string") {
    const w = s.window;
    return {
      kind: "figure", text: s.text, metric: s.metric, window: typeof w === "string" || typeof w === "number" ? w : null,
      ...(typeof s.observedAt === "string" && Number.isFinite(Date.parse(s.observedAt)) ? { observedAt: s.observedAt } : {}),
    };
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
  COST_CAP: "Platform AI has reached today's spending limit. It resets at midnight UTC.",
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

/** §4.3: the answer-level chip (every figure of the answer shares one observation time). */
export const answerAsOf = (iso: string, now: Date) => `Figures as of ${relativeTime(iso, now)}`;
/** §4.3: the chip on a figure whose observation time differs from the answer's. */
export const asOfChip = (iso: string, now: Date) => `as of ${relativeTime(iso, now)}`;

/**
 * = PLATFORM_AI_RETENTION_DAYS in lib/platform/intelligence/ai/conversations/constants.ts.
 * DUPLICATED because this module has no imports; pinned equal in
 * platform-ai-conversations.test.ts (the migration-pin pattern). Change both together.
 */
export const PLATFORM_AI_RETENTION_DAYS_CLIENT = 7;
const RETENTION_MS = PLATFORM_AI_RETENTION_DAYS_CLIENT * 24 * 60 * 60 * 1000;

/**
 * R1 option (b): messages expire per pair, so a long-lived thread can lose its
 * oldest exchanges. Retention is the ONLY way a message disappears, and it can't
 * act before PLATFORM_AI_RETENTION_DAYS (S2 on #434). So the note shows only when
 * BOTH hold:
 *   - the conversation is at least the retention window old (now − createdAt ≥ 7 d);
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

// ── Empty state (parity PR3; Personal parity PR6) ───────────────────────────

/**
 * The empty-state headline (rendered by the shared StarterLine at Personal's
 * size) and the starter chips: a SHORT label on the chip, the full question
 * behind it (Personal's StarterPrompt shape). Static, Platform-owned copy about
 * the kinds of evidence Platform AI reads. No figure, no name, no customer data.
 * A chip asks exactly its `prompt` through the normal send path (a fresh
 * clientRequestId). The first chip is the general check-in.
 */
export const PLATFORM_AI_STARTER_HEADLINE = "What would you like to check?";
export interface PlatformAiStarter { label: string; prompt: string }
export const PLATFORM_AI_STARTER_PROMPTS: readonly PlatformAiStarter[] = [
  { label: "How are we looking today?", prompt: "How is the platform looking today? Summarise anything that needs attention." },
  { label: "Customer-impacting issues", prompt: "Is anything affecting customers right now?" },
  { label: "Open incidents", prompt: "Are there any open incidents right now?" },
  { label: "Sync & connection health", prompt: "How healthy are syncs and provider connections this week?" },
  { label: "Jobs & providers", prompt: "Which jobs failed or ran late recently, and how are providers performing?" },
  { label: "Costs this month", prompt: "What is driving operating costs this month?" },
];
/** Screen-reader label for the in-flight indicator (the three dots). */
export const PLATFORM_AI_THINKING_LABEL = "Platform AI is answering…";

// ── Quiet chrome (Personal parity PR6) ──────────────────────────────────────

/**
 * S2 ruling C1 (2026-11-08): the short line, ALWAYS visible beneath the composer
 * (every viewport, never truncated): read-only, the AI provider as the OD-5 notice
 * names it, the retention from the retention constant with the word "hidden"
 * (never "deleted" — removal is the next purge, stated in the full notice), and
 * "don't enter personal details". The test pins the exact string.
 */
export const PLATFORM_AI_PROVIDER = "OpenAI";
export const PLATFORM_AI_CONVERSATIONS_LINE =
  `Read-only · Sent to ${PLATFORM_AI_PROVIDER} · Chats hidden after ${PLATFORM_AI_RETENTION_DAYS_CLIENT} days · Don’t enter personal details`;
/** The same line for v0 (flag on, conversations off): nothing is stored. */
export const PLATFORM_AI_SESSION_LINE = `Read-only · Sent to ${PLATFORM_AI_PROVIDER} · Not saved · Don’t enter personal details`;
/** v0's expanded privacy text adds this sentence (the v0 route stores nothing; platform-ai.test.ts §10 pins the route). */
export const PLATFORM_AI_SESSION_NOT_SAVED =
  "Questions and answers here are not saved. Leaving or reloading the page clears them.";

/**
 * S2 ruling C3: the full OD-5 notice is expanded by default on a first visit —
 * SERVER-derived: the operator's conversation list (from the list route) is
 * empty and nothing is open. It collapses once a conversation exists (after
 * the first message is sent) and expands again when every conversation is
 * deleted. An operator's own toggle wins until one of those transitions.
 */
export function noticeDefaultOpen(conversations: readonly unknown[] | null, hasSelection: boolean): boolean {
  return conversations !== null && conversations.length === 0 && !hasSelection;
}

/** The character counter appears only from here (80 % of the 500 limit). */
export const PLATFORM_AI_COUNTER_FROM = 400;
export const showComposerCounter = (length: number) => length >= PLATFORM_AI_COUNTER_FROM;

/** "N of 50 conversations" appears only this close to the cap. */
export const PLATFORM_AI_LIMIT_WARN_WITHIN = 5;
export const showConversationCount = (limits: ClientLimits | null) =>
  limits !== null && limits.max - limits.used <= PLATFORM_AI_LIMIT_WARN_WITHIN;

/**
 * Stale evidence (§4.3; owner 2026-11-08 + S2 pre-flag 3). Never present a stale
 * figure as current:
 *   - every figure's observation time is its `observedAt`, or the answer's
 *     createdAt when the server sends none (today: always);
 *   - when ALL figures share one observation time, ONE answer-level chip
 *     ("Figures as of …") replaces the per-figure chips;
 *   - otherwise the answer-level chip states the answer's time, and every figure
 *     whose observation time differs keeps its OWN "as of …" chip;
 *   - a chip shows when the answer is a prior (stale) one, or when that time is at
 *     least STALE_AFTER_MS old.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;
export interface StaleChips {
  /** The answer-level chip's time, or null (nothing to show). */
  answer: string | null;
  /** Per-figure chips by the figure's index in the segment list. */
  figures: ReadonlyMap<number, string>;
}
export function staleChips(message: Pick<ClientMessage, "content" | "createdAt" | "stale">, now: Date): StaleChips {
  const segments = Array.isArray(message.content) ? message.content : [];
  const observed: [number, string][] = [];
  segments.forEach((s, i) => { if (s.kind === "figure") observed.push([i, s.observedAt ?? message.createdAt]); });
  const times = new Set(observed.map(([, t]) => Date.parse(t)));
  const answerAt = times.size === 1 ? observed[0][1] : message.createdAt;
  const old = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) && now.getTime() - t >= STALE_AFTER_MS; };
  const show = (iso: string) => message.stale || old(iso);
  const figures = new Map<number, string>();
  if (times.size > 1) for (const [i, t] of observed) if (Date.parse(t) !== Date.parse(answerAt) && show(t)) figures.set(i, t);
  return { answer: observed.length > 0 && show(answerAt) ? answerAt : null, figures };
}

// ── Answer blocks (paragraphs and lists inside typed segments) ──────────────

/** An inline piece of an answer: the typed segment kinds, never markup. A figure carries its index in the segment list (`seg`). */
export type InlineSegment = Exclude<ClientSegment, { kind: "correction" | "note" | "figure" }> | (Extract<ClientSegment, { kind: "figure" }> & { seg: number });
export type AnswerList = { kind: "ul" | "ol"; items: InlineSegment[][] };
export type AnswerBlock =
  | { kind: "p"; lines: InlineSegment[][] }
  /** F-2: a section label ("Incidents:") — a short heading line, never a bullet. */
  | { kind: "label"; line: InlineSegment[] }
  /** `sub[j]`: the ONE nested list under item j (an indented list item), or null. Present only when some item has one. */
  | (AnswerList & { sub?: (AnswerList | null)[] });

const BULLET = /^[ \t]*(?:[-*•])[ \t]+/;
const NUMBERED = /^[ \t]*\d{1,2}[.)][ \t]+/;
/** An indented list line (≥ 2 spaces or a tab before the marker): one nesting level. */
const INDENTED = /^(?: {2,}|\t)/;
/** A section label: short model text ending in ":" and nothing else (no figure, no link). */
const SECTION_LABEL = /^[^:\n]{1,60}:$/;

/**
 * Lay the typed segments out as paragraphs and simple lists — STRUCTURE ONLY.
 * A blank line ends a paragraph; a line that starts with "- ", "* ", "• " or
 * "1. " is a list item (the marker is dropped). Nothing else is interpreted:
 * `**x**`, `<b>`, `[a](b)` stay literal text, a link is still only a server
 * `link` segment, and every piece is still rendered as React text. Correction
 * and note segments are not part of the body (they render above it).
 * F-2 (2026-11-08): a line that is only a short label ending in ":" ("Incidents:",
 * "- Incidents:") directly before list items is a `label` block, never a bullet; an
 * indented list line (≥ 2 spaces / a tab) nests ONE level under the previous item.
 */
export function answerBlocks(segments: readonly ClientSegment[]): AnswerBlock[] {
  const lines: InlineSegment[][] = [[]];
  segments.forEach((s, seg) => {
    if (s.kind === "correction" || s.kind === "note") return;
    // A figure ({{m:}}) and a link are typed server segments: never split, never read as a list marker.
    if (s.kind === "figure") { lines[lines.length - 1].push({ ...s, seg }); return; }
    if (s.kind === "link" || s.kind === "memory") { lines[lines.length - 1].push(s); return; }
    s.text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ kind: "text", text: part });
    });
  });
  const blocks: AnswerBlock[] = [];
  let para: InlineSegment[][] | null = null;
  const lineText = (l: InlineSegment[]) => l.map((x) => x.text).join("");
  const markerOf = (l: InlineSegment[]) => (l[0]?.kind === "text" ? (BULLET.exec(l[0].text) ?? NUMBERED.exec(l[0].text)) : null);
  // F-2: a line that is ONLY a section label — model text, no figure / link, ending in ":".
  const labelOf = (l: InlineSegment[], marker: RegExpExecArray | null): InlineSegment[] | null => {
    if (l.length !== 1 || l[0].kind !== "text") return null;
    const t = l[0].text.slice(marker ? marker[0].length : 0).trim();
    return SECTION_LABEL.test(t) ? [{ kind: "text", text: t }] : null;
  };
  const isListLine = (l: InlineSegment[] | undefined) => !!l && markerOf(l) !== null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (lineText(line).trim() === "") { para = null; continue; }
    const first = line[0];
    const marker = markerOf(line);
    // F-2: "Incidents:" / "- Incidents:" directly followed by list items is a section LABEL — never a bullet.
    const label = isListLine(lines[li + 1]) ? labelOf(line, marker) : null;
    if (label) { blocks.push({ kind: "label", line: label }); para = null; continue; }
    if (marker && first.kind === "text") {
      const kind = BULLET.test(first.text) ? "ul" : "ol";
      const rest = first.text.slice(marker[0].length);
      const item: InlineSegment[] = [...(rest ? [{ kind: "text" as const, text: rest }] : []), ...line.slice(1)];
      const prev = blocks[blocks.length - 1];
      const list = para === null && prev && (prev.kind === "ul" || prev.kind === "ol") ? prev : null;
      // F-2: ONE nesting level — an indented item under the previous item of a list.
      if (list && INDENTED.test(first.text) && list.items.length > 0) {
        const at = list.items.length - 1;
        const sub = list.sub ?? (list.sub = list.items.map(() => null));
        const own = sub[at];
        if (own) own.items.push(item); else sub[at] = { kind, items: [item] };
      } else if (list && list.kind === kind) {
        list.items.push(item);
        if (list.sub) list.sub.push(null);
      } else blocks.push({ kind, items: [item] });
      para = null;
      continue;
    }
    if (para) para.push(line);
    else { para = [line]; blocks.push({ kind: "p", lines: para }); }
  }
  return blocks;
}

// ── History (parity PR4) ────────────────────────────────────────────────────

/**
 * `?c=<conversationId>` — the ONLY thing this surface puts in the URL (S2
 * 2026-11-07, ruling 3): the opaque conversation id. Never a title, a question
 * or an area. The id is a selector, never an authority: the server re-applies
 * every gate (session, grant, the area's fresh guard, ownership, LIVE) and
 * answers ONE 404 for unknown / foreign / deleted / expired alike, and the
 * client shows ONE "not found" for all of them (and for a malformed value).
 * The page sends Referrer-Policy: strict-origin-when-cross-origin
 * (next.config.ts; pinned by lib/security-headers.test.ts), so the query never
 * leaves the origin in a Referer header.
 */
export const PLATFORM_AI_CONVERSATION_PARAM = "c";

/** A lenient opaque-id shape (cuids fit); anything else is "invalid" ⇒ the same not-found, no request. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type ConversationParam = { kind: "none" } | { kind: "id"; id: string } | { kind: "invalid" };

/** Read `?c=` from a location search string. Absent or empty ⇒ none. */
export function readConversationParam(search: string): ConversationParam {
  let v: string | null;
  try { v = new URLSearchParams(search).get(PLATFORM_AI_CONVERSATION_PARAM); } catch { return { kind: "none" }; }
  if (v === null || v === "") return { kind: "none" };
  return OPAQUE_ID.test(v) ? { kind: "id", id: v } : { kind: "invalid" };
}

/** The same location with `?c=` set to `id`, or removed when `id` is null. Other params and the hash are kept. */
export function conversationHref(loc: { pathname: string; search: string; hash?: string }, id: string | null): string {
  const p = new URLSearchParams(loc.search);
  if (id === null) p.delete(PLATFORM_AI_CONVERSATION_PARAM);
  else p.set(PLATFORM_AI_CONVERSATION_PARAM, id);
  const qs = p.toString();
  return `${loc.pathname}${qs ? `?${qs}` : ""}${loc.hash ?? ""}`;
}

/**
 * How a selection reaches browser History (the Space history contract,
 * components/space/shell/useSpaceUrl.ts): the operator OPENING a thread or
 * starting a new chat PUSHES; the client NORMALISING the URL (opening the
 * latest on load, a not-found id, a deleted thread, a new conversation's first
 * id) REPLACES; Back / Forward never write.
 */
export type HistoryIntent = "push" | "replace";

export type ConversationGroupKey = "today" | "earlier";
export interface ConversationGroup { key: ConversationGroupKey; label: "Today" | "Earlier"; conversations: ClientConversation[] }

/**
 * Today / Earlier by `lastActivityAt`, on the UTC calendar day (the same clock
 * as `utcStamp`): Today ⇔ last activity at or after 00:00 UTC of `now`'s day.
 * Order within a group is the input order (the server lists lastActivityAt
 * desc). An unparseable time is Earlier. Empty groups are omitted.
 */
export function groupConversations(conversations: readonly ClientConversation[], now: Date): ConversationGroup[] {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const today: ClientConversation[] = [], earlier: ClientConversation[] = [];
  for (const c of conversations) {
    const t = Date.parse(c.lastActivityAt);
    (Number.isFinite(t) && t >= startOfToday ? today : earlier).push(c);
  }
  const out: ConversationGroup[] = [];
  if (today.length) out.push({ key: "today", label: "Today", conversations: today });
  if (earlier.length) out.push({ key: "earlier", label: "Earlier", conversations: earlier });
  return out;
}

/** After deleting `deletedId`: the most recent remaining conversation (by lastActivityAt; unparseable last), or null. */
export function nextConversationAfterDelete(conversations: readonly ClientConversation[], deletedId: string): string | null {
  const at = (c: ClientConversation) => { const t = Date.parse(c.lastActivityAt); return Number.isFinite(t) ? t : -Infinity; };
  let best: ClientConversation | null = null;
  for (const c of conversations) if (c.id !== deletedId && (best === null || at(c) > at(best))) best = c;
  return best?.id ?? null;
}

/** The one "not found" a missing conversation shows, whatever the reason (no existence oracle). */
export const NOT_FOUND_PROBLEM: Readonly<{ kind: "NOT_FOUND"; text: string }> = Object.freeze({ kind: "NOT_FOUND", text: NOT_FOUND_COPY });
