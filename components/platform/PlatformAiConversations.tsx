"use client";

/**
 * components/platform/PlatformAiConversations.tsx  (Platform AI conversations, PR C: the UX)
 *
 * Design: docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §4.3, §8, §11. Mounted
 * ONLY by app/(shell)/dashboard/platform/ai/page.tsx, and only when
 * `env.isPlatformAiConversationsEnabled` is true SERVER-SIDE (PLATFORM_AI_ENABLED
 * + PLATFORM_AI_CONVERSATIONS_ENABLED + PLATFORM_AI_PURGE_ENABLED, all default
 * OFF). Off, the page is exactly v0 (PlatformAiAsk) or the placeholder; this
 * file is never rendered.
 *
 * It talks only to the PR B / B2 routes (list, create, read, append, delete).
 * Every authority decision is the server's; this is presentation and input.
 *
 * LAYOUT (parity PR3; Personal parity PR6, owner 2026-11-08). The shared
 * conversation shell (`AiShell`), laid out like Personal Space AI: a full-height
 * page, the reading region scrolls inside itself, the composer (integrated send)
 * is docked above the bottom bar with ONE disclosure line beneath it. The header
 * holds the title, the area as its context label, ONE "New chat" and — below
 * `lg` — a "History" control that opens the list in the shared Panel. From
 * `lg`, the same list sits in a left rail in the shell's `side` slot, COLLAPSED
 * by default (a per-viewer localStorage convenience, read and written in
 * try/catch; only "0" = opened is remembered as open).
 *
 * ⚠️ OUTPUT SINK FOR STORED MODEL TEXT. No Markdown parser: an answer is the
 * typed segment list the server stored (§2.5), laid out into paragraphs / lists
 * by the pure `answerBlocks` (structure only) and rendered as React text
 * (platform-ai-presentation). A link renders only when the server re-resolved
 * its stored page id through the CURRENT token on this read (§3.4) AND its href
 * passes `isSameOriginPath` (the AI Markdown renderer's own boundary). Stored
 * URLs do not exist.
 *
 * Stale evidence (§4.3; owner 2026-11-08 + S2): ONE answer-level "Figures as of
 * <time>" chip when every figure shares one observation time, and a per-figure
 * "as of" chip on any figure whose time differs (`staleChips`). A figure is
 * never refreshed in place. Sources and notes sit in a collapsed
 * "Sources" disclosure under each answer.
 *
 * Privacy: no draft persistence, no keystroke handling beyond the controlled
 * textarea, no analytics, no logging. The v0 privacy hint and the OD-5 notice
 * are each ONE exported constant (platform-ai-conversations-model). S2 rulings
 * C1–C4 (2026-11-08): a short line is always visible under the composer; its
 * "Privacy & retention" control expands the full notice inline; the notice is
 * expanded by default on a first visit (server-derived: no conversations); the
 * full text is always in the DOM as the composer's aria-describedby target.
 *
 * REUSE (§11; parity PR3/PR6). Shared PRESENTATION only, all props-driven:
 * `AiShell` (frame), `ConversationLog` + `ThinkingIndicator` (reading column,
 * auto-scroll, the three dots), the answer frame (AI-mark gutter + prose; it
 * wraps Platform's OWN typed-segment renderer — never the Markdown answer),
 * `MessageCard`, `FailedTurn`, and — through platform-ai-presentation (shared
 * with v0) — `ComposerFrame` (NO Stop: an abort would not cancel the server
 * turn — S2 accepted), `StarterLine` and `SuggestedPrompt`. NOT reused: `ConversationView` (it renders
 * Markdown answers), `Composer` and `AiDisclosure` (the customer disclosure copy). Neither the
 * transcript cache, Space context nor Talk-about-this is imported anywhere on
 * this path (no barrel import either).
 *
 * HISTORY (parity PR4). Conversations are server-stored, so they survive a
 * refresh, a sign-out and a new session already; `?c=<id>` keeps the
 * SELECTION too. Only the opaque id goes in the URL (S2 ruling 3, 2026-11-07):
 * it is a selector, never an authority — the read route re-applies every gate
 * and answers ONE 404 for unknown / foreign / deleted / expired, and this
 * client shows ONE not-found for every one of them (and for a malformed id,
 * without a request), then REPLACES the URL to the cleared state. Writes follow
 * the Space history contract (useSpaceUrl): opening a thread or "New chat"
 * PUSHES, normalising REPLACES, Back / Forward never write, and every write
 * passes `null` state (Next 16 skips its router sync for a state carrying its
 * private `__NA` marker). The id is never written to browser storage.
 * While the list and the thread load, the shell shows a skeleton in its
 * conversation layout — never the empty state first.
 */

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Brain, MessagesSquare, PanelLeftClose, PanelLeftOpen, SquarePen, Trash2 } from "lucide-react";
import { AiShell } from "@/components/ai/AiShell";
import { AnswerFrame } from "@/components/ai/answer-frame";
import { ConversationLog, ThinkingIndicator } from "@/components/ai/ConversationView";
import { MessageCard } from "@/components/ai/MessageCard";
import { FailedTurn } from "@/components/ai/FailedTurn";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { Panel } from "@/components/atlas/panels/Panel";
import { PanelContent, PanelHeader } from "@/components/atlas/panels/PanelParts";
import { PLATFORM_AI_TITLE } from "./PlatformAiPlaceholder";
import { PlatformAiMemoryConfirmCard, PlatformAiMemoryPanel } from "./PlatformAiMemory";
import { parseProposal, type ClientMemoryProposal } from "./platform-ai-memory-model";
import { usePeoplePicker, type PeoplePickerBinding } from "./platform-ai-people-picker";
import { AnswerNotes, AnswerSources, PlatformAiComposer, PlatformAiLead, PlatformAiNotice, PlatformAiStarters, TypedAnswerSegments } from "./platform-ai-presentation";
import {
  CONVERSATION_FULL_COPY, CONVERSATION_LIMIT_COPY, DELETE_CONFIRM_COPY, EARLIER_EXPIRED_COPY, FAILURE_COPY, NOT_FOUND_PROBLEM,
  PLATFORM_AI_CONVERSATIONS_URL, PLATFORM_AI_THINKING_LABEL,
  RAIL_COLLAPSED_KEY, UNAVAILABLE_COPY, UNREADABLE_COPY,
  answerAsOf, asOfChip, conversationHref, conversationMessagesUrl, conversationUrl, earlierMessagesExpired, groupConversations, hasPendingTurn,
  nextConversationAfterDelete, parseList, parsePair, parseThread, problemFor, questionBefore, readConversationParam, relativeTime,
  noticeDefaultOpen, showConversationCount, staleChips, utcStamp,
  type ClientConversation, type ClientLimits, type ClientMessage, type HistoryIntent, type SendProblem,
} from "./platform-ai-conversations-model";

// ── Presentation (pure; DOM-less tested) ────────────────────────────────────

/**
 * One answer in the shared answer frame (AI-mark gutter + prose): Platform's
 * typed segments, then — collapsed — its sources and notes. Stale evidence
 * (§4.3, `staleChips`): ONE answer-level "Figures as of …" chip when every
 * figure shares one observation time, plus an "as of …" chip on any figure
 * whose time differs. A prior answer always says when it was true.
 */
export function AssistantAnswer({ message, now }: { message: ClientMessage; now: Date }) {
  const segments = Array.isArray(message.content) ? message.content : null;
  const stale = staleChips(message, now);
  const figureChips = new Map([...stale.figures].map(([i, iso]) => [i, { chip: asOfChip(iso, now), title: utcStamp(iso) }]));
  const sources = message.citations.length + message.notes.length > 0 ? (
    <AnswerSources count={message.citations.length}>
      {message.citations.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {message.citations.map((c) => (
            <li key={c.metric} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">{c.label}</span>
              <span className="min-w-0 break-words">{c.window}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <AnswerNotes notes={message.notes} />
    </AnswerSources>
  ) : null;
  return (
    <section aria-label="Answer" data-platform-ai-answer={message.stale ? "stale" : "current"} title={message.stale ? utcStamp(message.createdAt) : undefined} className="min-w-0">
      <AnswerFrame extras={sources}>
        {stale.answer && segments && !message.unavailable ? (
          <p className="mb-2 min-w-0">
            <span data-platform-ai-stale-chip="answer" title={utcStamp(stale.answer)}
              className="inline-flex items-center rounded-full border border-[var(--border-hairline)] px-2 text-[11px] leading-5 text-[var(--text-secondary)]">
              {answerAsOf(stale.answer, now)}
            </span>
          </p>
        ) : null}
        {segments && !message.unavailable
          ? <TypedAnswerSegments segments={segments} chips={figureChips} />
          : <p className="min-w-0 break-words text-[var(--text-secondary)]">{UNREADABLE_COPY}</p>}
      </AnswerFrame>
    </section>
  );
}

/** The in-flight state: the shared three-dot indicator; a stored PENDING turn adds "Check again". */
export function InFlight({ onCheck }: { onCheck?: () => void }) {
  return (
    <div data-platform-ai-in-flight="" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <ThinkingIndicator srLabel={PLATFORM_AI_THINKING_LABEL} />
      {onCheck ? (
        <button type="button" onClick={onCheck} className="shrink-0 text-xs underline underline-offset-2 text-[var(--text-secondary)]">Check again</button>
      ) : null}
    </div>
  );
}

export interface ThreadProps {
  messages: readonly ClientMessage[];
  now: Date;
  /** A question sent but not yet answered by the server (shown as the operator's bubble + the in-flight state). */
  sendingQuestion: string | null;
  earlierExpired: boolean;
  /** "Try again" on the newest FAILED answer — sends the same question with a NEW clientRequestId (§5.1). */
  onRetryFailed?: (question: string) => void;
  /** Re-read the thread when a PENDING answer is shown (another tab, or a lost response). */
  onCheckPending?: () => void;
  busy: boolean;
}

/** The thread in the shared reading column (`ConversationLog`: role=log, auto-scroll inside the shell). */
export function Thread({ messages, now, sendingQuestion, earlierExpired, onRetryFailed, onCheckPending, busy }: ThreadProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const sending = sendingQuestion !== null;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "USER") { lastUser = i; break; }
  const last = messages[messages.length - 1];
  const answered = !sending && !!last && last.role === "ASSISTANT" && last.status !== "PENDING";
  return (
    <ConversationLog scrollKey={messages} turnCount={messages.length + (sending ? 1 : 0)} answered={answered} anchorRef={anchorRef}
      busy={sending} busyNode={<InFlight />}>
      {earlierExpired ? <p data-platform-ai-expired="" className="min-w-0 break-words text-center text-xs text-[var(--text-muted)]">{EARLIER_EXPIRED_COPY}</p> : null}
      {messages.map((m, i) => {
        if (m.role === "USER") {
          return (
            <div key={m.id} ref={!sending && i === lastUser ? anchorRef : undefined} className="ai-turn-enter min-w-0">
              <MessageCard content={typeof m.content === "string" ? m.content : UNREADABLE_COPY} />
            </div>
          );
        }
        if (m.status === "PENDING") return <div key={m.id} className="ai-turn-enter min-w-0"><InFlight onCheck={onCheckPending} /></div>;
        if (m.status === "FAILED") {
          const newest = i === messages.length - 1;
          const q = questionBefore(messages, i);
          return (
            <div key={m.id} className="ai-turn-enter min-w-0">
              <FailedTurn message={FAILURE_COPY[m.failureCode ?? "PROVIDER"]} busy={busy}
                onRetry={newest && q && onRetryFailed ? () => onRetryFailed(q) : undefined} />
            </div>
          );
        }
        return <div key={m.id} className="ai-turn-enter min-w-0"><AssistantAnswer message={m} now={now} /></div>;
      })}
      {sending ? (
        <div ref={anchorRef} className="ai-turn-enter min-w-0"><MessageCard content={sendingQuestion} /></div>
      ) : null}
    </ConversationLog>
  );
}

export interface ConversationListProps {
  conversations: readonly ClientConversation[] | null;
  selectedId: string | null;
  now: Date;
  limits: ClientLimits | null;
  error: string | null;
  onSelect: (id: string) => void;
  onDelete: (c: ClientConversation) => void;
}

/** The list while it loads: quiet placeholder rows (no "No conversations yet." before the list is known). */
function ListSkeleton() {
  return (
    <div data-platform-ai-list-loading="" aria-busy="true" className="flex min-w-0 flex-col gap-1.5">
      <span className="sr-only">Loading conversations</span>
      {[0, 1, 2].map((i) => <div key={i} aria-hidden className="h-11 w-full min-w-0 animate-pulse rounded-lg bg-[var(--surface-hover)]" />)}
    </div>
  );
}

/** The reading column while a thread (or the first list) loads: a skeleton, never the empty state. */
function ThreadSkeleton() {
  return (
    <div data-platform-ai-thread-loading="" aria-busy="true" className="mt-4 flex min-w-0 flex-col gap-3">
      <span className="sr-only">Loading conversation</span>
      <div aria-hidden className="ml-auto h-9 w-2/3 min-w-0 animate-pulse rounded-2xl bg-[var(--surface-hover)]" />
      <div aria-hidden className="h-4 w-full min-w-0 animate-pulse rounded bg-[var(--surface-hover)]" />
      <div aria-hidden className="h-4 w-5/6 min-w-0 animate-pulse rounded bg-[var(--surface-hover)]" />
    </div>
  );
}

/** History: Today / Earlier. "New chat" lives in the header only; the count shows only near the cap. */
export function ConversationList({ conversations, selectedId, now, limits, error, onSelect, onDelete }: ConversationListProps) {
  return (
    <div data-platform-ai-conversation-list="" className="flex min-w-0 flex-col gap-2">
      {showConversationCount(limits) && limits ? (
        <p data-platform-ai-count="" className="px-2.5 text-[11px] tabular-nums text-[var(--text-secondary)]">{limits.used} of {limits.max} conversations</p>
      ) : null}
      {error ? <p role="status" className="min-w-0 break-words text-xs text-[var(--text-secondary)]">{error}</p> : null}
      {conversations === null && !error ? <ListSkeleton /> : null}
      {conversations !== null && conversations.length === 0 ? <p className="px-2.5 text-xs text-[var(--text-muted)]">No conversations yet.</p> : null}
      {conversations && conversations.length > 0 ? groupConversations(conversations, now).map((g) => (
        <section key={g.key} data-platform-ai-group={g.key} aria-labelledby={`platform-ai-group-${g.key}`} className="flex min-w-0 flex-col gap-1">
          <h3 id={`platform-ai-group-${g.key}`} className="px-2.5 pt-1 text-[11px] font-medium text-[var(--text-muted)]">{g.label}</h3>
          <ul className="flex min-w-0 flex-col gap-1">
            {g.conversations.map((c) => {
              const title = c.label ?? `${c.areaLabel} conversation`;
              return (
                <li key={c.id} className="group/row flex min-w-0 items-stretch gap-1">
                  <button type="button" onClick={() => onSelect(c.id)} aria-current={c.id === selectedId ? "true" : undefined}
                    className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left ${c.id === selectedId ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-hover)]"}`}>
                    <span title={title} className="w-full min-w-0 truncate text-sm text-[var(--text-primary)]">{title}</span>
                    <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-muted)]">
                      <span data-platform-ai-area-chip="" className="min-w-0 truncate">{c.areaLabel}</span>
                      <span data-platform-ai-last-activity="" title={utcStamp(c.lastActivityAt)}>{relativeTime(c.lastActivityAt, now)}</span>
                      {c.full ? <span>Full</span> : null}
                    </span>
                  </button>
                  <button type="button" onClick={() => onDelete(c)} aria-label={`Delete conversation: ${c.label ?? c.areaLabel}`}
                    className="inline-flex w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]">
                    <Trash2 size={14} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )) : null}
    </div>
  );
}

export interface PlatformAiConversationsViewProps {
  /** The area a NEW conversation answers from (platformAiAreaFor, decided by the page). */
  areaLabel: string;
  /** P5 (S2 09dp) — the customers pack is offered (the page decides): the customer-lookup notice. */
  subjectNotice?: boolean;
  now: Date;
  conversations: readonly ClientConversation[] | null;
  limits: ClientLimits | null;
  listError: string | null;
  selected: { conversation: ClientConversation; messages: readonly ClientMessage[] } | null;
  threadLoading: boolean;
  draft: string;
  sendingQuestion: string | null;
  problem: SendProblem | null;
  /** A transport failure whose send can be retried with the SAME clientRequestId (an idempotent replay). */
  canRetrySend: boolean;
  sheetOpen: boolean;
  railCollapsed: boolean;
  confirmDelete: ClientConversation | null;
  deleting: boolean;
  onDraft: (v: string) => void;
  onSend: () => void;
  /** A starter chip: asks its full prompt through the normal send path. */
  onStarter: (question: string) => void;
  onRetrySend: () => void;
  onRetryFailed: (question: string) => void;
  onCheckPending: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onAskDelete: (c: ClientConversation) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onSheet: (open: boolean) => void;
  onRail: (collapsed: boolean) => void;
  /** The operator's own toggle of the full notice; null ⇒ the server-derived default (noticeDefaultOpen, S2 C3). */
  noticeOpen?: boolean | null;
  onNotice?: (open: boolean) => void;
  /** Platform AI memory is effective (the page decides it server-side). Absent / false ⇒ exactly as before. */
  memory?: boolean;
  /** The confirm card THIS turn's answer ended with (never stored); null ⇒ none. */
  memoryProposal?: ClientMemoryProposal | null;
  onMemoryDone?: (saved: boolean) => void;
  memoryOpen?: boolean;
  onMemoryOpen?: (open: boolean) => void;
  /** The @ people picker (offered with the customer notice). */
  picker?: PeoplePickerBinding;
  /** The server's USE_PEOPLE_PICKER refusal, inline under the kept draft. */
  guardNotice?: string | null;
}

/** Header action: the same quiet "New chat" control Personal Space AI shows. */
export const NEW_CHAT_CLASS = "inline-flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-xs font-medium transition-colors text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]";

/** A status line above the composer (Personal's position for transient problems). */
export function ProblemLine({ text, kind, onRetry, busy }: { text: string; kind: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <div role="status" data-platform-ai-problem={kind} className="mx-auto mb-2 flex w-full min-w-0 max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm text-[var(--text-secondary)]">
      <span className="min-w-0 break-words">{text}</span>
      {onRetry ? <button type="button" onClick={onRetry} disabled={busy} className="shrink-0 text-xs underline underline-offset-2">Try again</button> : null}
    </div>
  );
}

/** Pure (no hooks): every state renders from props, so the DOM-less tests can walk it. */
export function PlatformAiConversationsView(p: PlatformAiConversationsViewProps) {
  const messages = p.selected?.messages ?? [];
  const busy = p.sendingQuestion !== null;
  const pending = hasPendingTurn(messages);
  const full = p.selected?.conversation.full === true || p.problem?.kind === "FULL";
  const atLimit = !p.selected && (p.problem?.kind === "LIMIT" || (p.limits !== null && p.limits.used >= p.limits.max));
  const label = p.selected?.conversation.areaLabel ?? p.areaLabel;
  // Parity PR4: the first list read counts as loading too, so the shell starts in its
  // conversation layout (a skeleton) and never flashes the empty state first.
  const listLoading = p.conversations === null && p.listError === null;
  const loading = p.threadLoading || (listLoading && !p.selected && !busy);
  const conversationMode = messages.length > 0 || busy || loading;
  const list = (
    <ConversationList conversations={p.conversations} selectedId={p.selected?.conversation.id ?? null} now={p.now}
      limits={p.limits} error={p.listError} onSelect={p.onSelect} onDelete={p.onAskDelete} />
  );

  // ONE "New chat" (header); the history opens in a sheet below lg.
  const controls = (
    <>
      {conversationMode || p.selected ? (
        <button type="button" data-platform-ai-new-chat="" onClick={p.onNew} disabled={busy} className={NEW_CHAT_CLASS}>
          <SquarePen size={14} aria-hidden />
          <span className="max-sm:sr-only">New chat</span>
        </button>
      ) : null}
      {p.memory ? (
        <button type="button" data-platform-ai-memory-toggle="" onClick={() => p.onMemoryOpen?.(true)} aria-haspopup="dialog" aria-expanded={p.memoryOpen === true}
          aria-label="Memory" className={NEW_CHAT_CLASS}>
          <Brain size={14} aria-hidden />
          <span className="max-sm:sr-only" aria-hidden>Memory</span>
        </button>
      ) : null}
      <button type="button" data-platform-ai-sheet-toggle="" onClick={() => p.onSheet(true)} aria-haspopup="dialog" aria-expanded={p.sheetOpen}
        aria-label="History" className={`${NEW_CHAT_CLASS} lg:hidden`}>
        <MessagesSquare size={14} aria-hidden />
        <span className="max-sm:sr-only" aria-hidden>History</span>
      </button>
    </>
  );

  // The desktop rail, in the shell's `side` slot: collapsed by default (a toggle only), scrolling on its own when open.
  const side = (
    <aside data-platform-ai-rail={p.railCollapsed ? "collapsed" : "open"} aria-label="Conversation history"
      className={`hidden min-h-0 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain lg:flex ${p.railCollapsed ? "w-10" : "w-64 border-r border-[var(--border-hairline)] pr-3"}`}>
      <button type="button" onClick={() => p.onRail(!p.railCollapsed)} aria-expanded={!p.railCollapsed}
        aria-label={p.railCollapsed ? "Show history" : "Hide history"} title={p.railCollapsed ? "Show history" : "Hide history"}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
        {p.railCollapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
      </button>
      {p.railCollapsed ? null : list}
    </aside>
  );

  const starters = atLimit || full ? null : <PlatformAiStarters onStarter={p.onStarter} />;
  // S2 C3: expanded on a first visit (the server's list is empty, nothing open); the operator's toggle wins.
  const noticeOpen = p.noticeOpen ?? noticeDefaultOpen(p.conversations, p.selected !== null);
  // In the empty state the full notice sits at the top of the reading region (never clipped by the dock);
  // in a conversation it sits under the short line. Either way it is rendered exactly once.
  const noticeIn = conversationMode ? "footer" : "lead";
  const lead = (
    <>
      {noticeIn === "lead" ? <div data-platform-ai-notice-lead="" className="mx-auto mb-6 w-full min-w-0 max-w-xl"><PlatformAiNotice open={noticeOpen} saved /></div> : null}
      <PlatformAiLead subjectNotice={p.subjectNotice === true} />
    </>
  );

  const problemLine = p.problem && p.problem.kind !== "FULL" && p.problem.kind !== "LIMIT" ? (
    <ProblemLine text={p.problem.text} kind={p.problem.kind} busy={busy}
      onRetry={p.problem.kind === "NETWORK" && p.canRetrySend ? p.onRetrySend : undefined} />
  ) : null;

  const composer = (
    <>
      {problemLine}
      {full ? (
        <div data-platform-ai-full="" className="mx-auto flex w-full min-w-0 max-w-3xl flex-col items-start gap-2 rounded-xl border border-[var(--border-hairline)] p-3 text-sm text-[var(--text-secondary)]">
          <p className="min-w-0 break-words">{CONVERSATION_FULL_COPY}</p>
          <button type="button" onClick={p.onNew} className="rounded-full border border-[var(--border-hairline-strong)] px-3 py-1 text-sm font-medium text-[var(--text-primary)]">Start a new conversation</button>
        </div>
      ) : (
        <>
          {atLimit ? (
            <p data-platform-ai-limit="" role="status" className="mx-auto mb-2 w-full min-w-0 max-w-3xl break-words rounded-xl border border-[var(--border-hairline)] p-3 text-sm text-[var(--text-secondary)]">{CONVERSATION_LIMIT_COPY}</p>
          ) : null}
          {p.memory && p.memoryProposal ? (
            <PlatformAiMemoryConfirmCard key={p.memoryProposal.token} proposal={p.memoryProposal} onDone={(saved) => p.onMemoryDone?.(saved)} />
          ) : null}
          <PlatformAiComposer value={p.draft} onChange={p.onDraft} onSubmit={p.onSend} busy={busy} disabled={pending || atLimit || loading}
            noticeOpen={noticeOpen} onNotice={p.onNotice} noticeIn={noticeIn} memory={p.memory === true} subjectNotice={p.subjectNotice === true}
            {...(p.picker ? { picker: p.picker } : {})} guardNotice={p.guardNotice ?? null} />
        </>
      )}
    </>
  );

  return (
    <div data-platform-ai-conversations="" className="min-w-0">
      <AiShell
        mode={conversationMode ? "conversation" : "empty"}
        title={PLATFORM_AI_TITLE}
        contextLabel={label}
        contextPrefix="Answering from: "
        controls={controls}
        side={side}
        lead={lead}
        aside={starters}
        composer={composer}
      >
        {loading && messages.length === 0 ? (
          <div className="mx-auto w-full min-w-0 max-w-3xl px-1 pt-3">
            <ThreadSkeleton />
          </div>
        ) : (
          <Thread messages={messages} now={p.now} sendingQuestion={p.sendingQuestion}
            earlierExpired={p.selected ? earlierMessagesExpired(p.selected.conversation, messages, p.now) : false}
            onRetryFailed={full || pending ? undefined : p.onRetryFailed} onCheckPending={p.onCheckPending} busy={busy} />
        )}
      </AiShell>

      <Panel open={p.sheetOpen} onClose={() => p.onSheet(false)} side="left" size="sm" ariaLabel="Conversation history">
        <PanelHeader title="History" />
        <PanelContent>{list}</PanelContent>
      </Panel>

      {p.memory ? (
        <Panel open={p.memoryOpen === true} onClose={() => p.onMemoryOpen?.(false)} side="right" size="sm" ariaLabel="Platform AI memory">
          <PanelHeader title="Memory" />
          <PanelContent>{p.memoryOpen ? <PlatformAiMemoryPanel /> : null}</PanelContent>
        </Panel>
      ) : null}

      <ConfirmDialog open={p.confirmDelete !== null} onClose={p.onCancelDelete} onConfirm={p.onConfirmDelete}
        title="Delete this conversation?" message={DELETE_CONFIRM_COPY} confirmLabel="Delete" busy={p.deleting} />
    </div>
  );
}

// ── The orchestrator (state + the five API calls) ───────────────────────────

type CallResult = { status: number; body: unknown } | null;

async function call(url: string, init?: RequestInit): Promise<CallResult> {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    return { status: r.status, body };
  } catch {
    return null; // a transport failure; never logged (no content in logs)
  }
}

const postJson = (url: string, payload: unknown) =>
  call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

/** `question` = what is SENT (chips as tokens); `display` = this operator's own draft (chips as `@label`, memory only). */
interface PendingSend { conversationId: string | null; clientRequestId: string; question: string; display?: string }

/** Collapsed unless this viewer opened it before ("0"); storage unavailable ⇒ the default (collapsed). */
function readRailCollapsed(): boolean {
  try { return window.localStorage.getItem(RAIL_COLLAPSED_KEY) !== "0"; } catch { return true; }
}
function writeRailCollapsed(v: boolean): void {
  try { window.localStorage.setItem(RAIL_COLLAPSED_KEY, v ? "1" : "0"); } catch { /* a convenience only */ }
}

/**
 * The ONE writer of `?c=` (parity PR4). `null` state on every write: Next 16
 * treats a state carrying its private `__NA` marker as its own and skips the
 * router sync, after which its HistoryUpdater rewrites the entry back to the
 * stale URL (components/space/shell/useSpaceUrl.ts). No write when the URL
 * would not change.
 */
function writeConversationParam(id: string | null, intent: HistoryIntent): void {
  const loc = window.location;
  const next = conversationHref(loc, id);
  if (next === `${loc.pathname}${loc.search}${loc.hash}`) return;
  if (intent === "replace") window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}

export interface PlatformAiConversationsProps {
  areaLabel: string;
  /** Platform AI memory is effective (decided by the page, server-side, after every gate). */
  memory?: boolean;
  /** P5 (S2 09dp) — the customers pack is offered (decided by the page, server-side). */
  subjectNotice?: boolean;
  /**
   * Test seam only (the page never passes it): the presentation the state is
   * handed to. Defaults to PlatformAiConversationsView; the history test passes
   * a capturing component so the REAL orchestrator runs without a DOM.
   */
  View?: ComponentType<PlatformAiConversationsViewProps>;
}

export function PlatformAiConversations({ areaLabel, memory = false, subjectNotice = false, View = PlatformAiConversationsView }: PlatformAiConversationsProps) {
  const [memoryProposal, setMemoryProposal] = useState<ClientMemoryProposal | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [conversations, setConversations] = useState<ClientConversation[] | null>(null);
  const [limits, setLimits] = useState<ClientLimits | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ conversation: ClientConversation; messages: ClientMessage[] } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [guardNotice, setGuardNotice] = useState<string | null>(null);
  // The @ people picker: offered exactly where the customer notice is (the page decides, server-side).
  const people = usePeoplePicker({ enabled: subjectNotice, draft, setDraft });
  const [sending, setSending] = useState<PendingSend | null>(null);
  const [retry, setRetry] = useState<PendingSend | null>(null);
  const [problem, setProblem] = useState<SendProblem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(true);
  /** null ⇒ the server-derived default (S2 C3); reset when a first message lands or every conversation is deleted. */
  const [noticeOpen, setNoticeOpen] = useState<boolean | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ClientConversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The latest selection request: a slower, older read never overwrites a newer choice. */
  const openSeq = useRef(0);

  // Relative times tick once a minute (no other timer).
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Read after mount (localStorage is browser-only; the server render is the default, collapsed).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setRailCollapsed(readRailCollapsed()); }, []);

  /** Nothing selected (New chat, a deleted last thread, a not-found id): the empty composer, `?c=` removed. */
  const clearSelection = useCallback((intent: HistoryIntent | null) => {
    openSeq.current++;
    setSelected(null); setThreadLoading(false); setRetry(null);
    if (intent) writeConversationParam(null, intent);
  }, []);

  /** ONE not-found for every missing conversation (unknown, foreign, deleted, expired, malformed): no oracle. */
  const showNotFound = useCallback((id: string | null) => {
    clearSelection("replace");
    if (id) setConversations((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
    setProblem(NOT_FOUND_PROBLEM);
  }, [clearSelection]);

  /** Open a thread. `intent` writes `?c=` first (push: the operator chose it; replace: normalising); null = traversal / re-read. */
  const openConversation = useCallback(async (id: string, intent: HistoryIntent | null = null) => {
    const seq = ++openSeq.current;
    if (intent) writeConversationParam(id, intent);
    setThreadLoading(true); setProblem(null); setRetry(null);
    const r = await call(conversationUrl(id));
    if (seq !== openSeq.current) return; // superseded by a newer selection
    setThreadLoading(false);
    const parsed = r && r.status === 200 ? parseThread(r.body) : null;
    if (parsed) { setSelected(parsed); setNow(new Date()); return; }
    if (r && r.status === 404) { showNotFound(id); return; }
    setSelected(null);
    setProblem(r ? problemFor(r.status, r.body) : { kind: "NETWORK", text: UNAVAILABLE_COPY });
  }, [showNotFound]);

  const loadList = useCallback(async (openLatest: boolean) => {
    const seq = openSeq.current;
    const r = await call(PLATFORM_AI_CONVERSATIONS_URL);
    const parsed = r && r.status === 200 ? parseList(r.body) : null;
    if (!parsed) { setListError(UNAVAILABLE_COPY); setConversations((cs) => cs ?? []); return; }
    setListError(null); setConversations(parsed.conversations); setLimits(parsed.limits);
    if (seq !== openSeq.current) return; // the operator chose something while the list loaded
    if (openLatest && parsed.conversations.length > 0) await openConversation(parsed.conversations[0].id, "replace");
  }, [openConversation]);

  /** Apply the URL's `?c=` (the first load, and Back / Forward). Never writes, except to normalise a malformed id. */
  const applyParam = useCallback((first: boolean) => {
    const param = readConversationParam(window.location.search);
    if (param.kind === "id") { void openConversation(param.id); if (first) void loadList(false); return; }
    if (param.kind === "invalid") { showNotFound(null); if (first) void loadList(false); return; }
    // No `?c=`: §11 — the page opens on the latest conversation (REPLACE), or on an empty composer.
    if (first) void loadList(true);
    else { clearSelection(null); setProblem(null); }
  }, [openConversation, loadList, showNotFound, clearSelection]);

  // The first read (an external system); every setState in it runs after the awaited fetch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { applyParam(true); }, [applyParam]);
  // Back / Forward between threads: re-apply the URL, write nothing.
  useEffect(() => {
    const onPop = () => applyParam(false);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyParam]);

  async function send(s: PendingSend) {
    setSending(s); setProblem(null); setRetry(null); setMemoryProposal(null); setGuardNotice(null);
    const r = s.conversationId
      ? await postJson(conversationMessagesUrl(s.conversationId), { clientRequestId: s.clientRequestId, question: s.question })
      : await postJson(PLATFORM_AI_CONVERSATIONS_URL, { clientRequestId: s.clientRequestId, question: s.question });
    setSending(null);
    if (!r) {
      // Transport failure: the server may or may not have stored it. Retrying with the SAME id is an idempotent replay (§5.1).
      setRetry(s); setProblem({ kind: "NETWORK", text: "Couldn’t reach Platform AI." });
      return;
    }
    if (people.isGuardRefusal(r.body)) {
      // S2 09fc — nothing was stored and no turn ran: give the draft back (with its chips) and say why inline.
      setDraft((d) => (d.length === 0 ? (s.display ?? s.question) : d));
      setGuardNotice(people.guardReminder);
      return;
    }
    const pair = r.status === 200 || r.status === 201 ? parsePair(r.body) : null;
    if (pair) {
      if (s.display !== undefined) people.reset();
      setNow(new Date());
      if (memory) setMemoryProposal(parseProposal((r.body as { memoryProposal?: unknown } | null)?.memoryProposal));
      if (!s.conversationId) setNoticeOpen(null); // a new conversation exists: back to the default (collapsed)
      setSelected((cur) => {
        if (!s.conversationId) {
          return pair.conversation ? { conversation: pair.conversation, messages: [pair.user, pair.assistant] } : cur;
        }
        if (!cur || cur.conversation.id !== s.conversationId) return cur;
        // Every earlier answer becomes "prior" (§4.3), as a re-read would label it.
        const prior = cur.messages.filter((m) => m.id !== pair.user.id && m.id !== pair.assistant.id).map((m) => (m.role === "ASSISTANT" ? { ...m, stale: true } : m));
        return { ...cur, messages: [...prior, pair.user, pair.assistant] };
      });
      // A new conversation now has an id: the cleared URL is normalised to it (REPLACE).
      if (!s.conversationId && pair.conversation) writeConversationParam(pair.conversation.id, "replace");
      void loadList(false);
      return;
    }
    const pr = problemFor(r.status, r.body);
    setProblem(pr);
    // A refusal stores nothing (§5.3): give the question back to the operator.
    if (pr.kind === "REFUSED" || pr.kind === "LIMIT" || pr.kind === "FULL") setDraft((d) => (d.length === 0 ? (s.display ?? s.question) : d));
    if (pr.kind === "FULL") setSelected((cur) => (cur ? { ...cur, conversation: { ...cur.conversation, full: true } } : cur));
    if (pr.kind === "IN_FLIGHT" && s.conversationId) void openConversation(s.conversationId);
    if (pr.kind === "NOT_FOUND") { showNotFound(s.conversationId); void loadList(false); }
  }

  function onSend() {
    if (ask(draft)) setDraft("");
  }

  /**
   * A fresh question — typed (onSend) or a starter chip: ONE path, a NEW clientRequestId. The @ picker's chips
   * are serialised to `[[cust:…]]` tokens HERE (the label is never sent); `display` keeps this operator's own text.
   */
  function ask(question: string): boolean {
    const q = question.trim();
    if (!q || sending) return false;
    const wire = people.serializeText(q);
    void send({ conversationId: selected?.conversation.id ?? null, clientRequestId: crypto.randomUUID(), question: wire, ...(wire !== q ? { display: q } : {}) });
    return true;
  }

  /** "New chat": the operator's navigation ⇒ PUSH the cleared URL (Back returns to the thread). */
  function onNew() {
    clearSelection("push"); setProblem(null); setSheetOpen(false);
  }

  async function onConfirmDelete() {
    const c = confirmDelete;
    if (!c) return;
    setDeleting(true);
    const r = await call(conversationUrl(c.id), { method: "DELETE" });
    setDeleting(false); setConfirmDelete(null);
    if (r && (r.status === 204 || r.status === 404)) {
      const next = nextConversationAfterDelete(conversations ?? [], c.id);
      if (!next) setNoticeOpen(null); // every conversation deleted: the first-visit default (expanded) again
      setConversations((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs));
      // The open thread was deleted: open the next most recent, or the empty state — REPLACE (the deleted id is gone from History's current entry).
      if (selected?.conversation.id === c.id) {
        if (next) void openConversation(next, "replace");
        else { clearSelection("replace"); setProblem(null); }
      }
      void loadList(false);
    } else {
      setProblem(r ? problemFor(r.status, r.body) : { kind: "NETWORK", text: UNAVAILABLE_COPY });
    }
  }

  return (
    <View
      areaLabel={areaLabel} now={now} subjectNotice={subjectNotice}
      conversations={conversations} limits={limits} listError={listError}
      selected={selected} threadLoading={threadLoading}
      draft={draft} sendingQuestion={sending ? (sending.display ?? sending.question) : null} problem={problem} canRetrySend={retry !== null}
      sheetOpen={sheetOpen} railCollapsed={railCollapsed} confirmDelete={confirmDelete} deleting={deleting}
      onDraft={(v) => { setDraft(v); if (guardNotice) setGuardNotice(null); }}
      onSend={onSend}
      onStarter={(q) => { ask(q); }}
      onRetrySend={() => { if (retry) void send(retry); }}
      onRetryFailed={(q) => { void send({ conversationId: selected?.conversation.id ?? null, clientRequestId: crypto.randomUUID(), question: q }); }}
      onCheckPending={() => { if (selected) void openConversation(selected.conversation.id); }}
      onSelect={(id) => { setSheetOpen(false); void openConversation(id, "push"); }}
      onNew={onNew}
      onAskDelete={setConfirmDelete}
      onConfirmDelete={() => { void onConfirmDelete(); }}
      onCancelDelete={() => { if (!deleting) setConfirmDelete(null); }}
      onSheet={setSheetOpen}
      onRail={(v) => { setRailCollapsed(v); writeRailCollapsed(v); }}
      noticeOpen={noticeOpen} onNotice={setNoticeOpen}
      memory={memory} memoryProposal={memoryProposal} onMemoryDone={() => setMemoryProposal(null)}
      memoryOpen={memoryOpen} onMemoryOpen={setMemoryOpen}
      picker={people.binding} guardNotice={guardNotice}
    />
  );
}
