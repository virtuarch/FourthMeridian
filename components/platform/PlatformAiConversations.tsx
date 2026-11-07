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
 * LAYOUT (parity PR3). The shared conversation shell (`AiShell`): a full-height
 * page (DashboardChrome treats this route as a conversation page, PR2), the
 * reading region scrolls inside itself, and the composer is docked above the
 * bottom bar. Mobile first (375 px): one reading column; a header
 * "Conversations" control opens the list in the shared Panel (a bottom sheet on
 * a phone). From `lg`, a collapsible left rail in the shell's `side` slot holds
 * the same list (its collapsed state is a per-viewer localStorage convenience,
 * read and written in try/catch).
 *
 * ⚠️ OUTPUT SINK FOR STORED MODEL TEXT. No Markdown parser: an answer is the
 * typed segment list the server stored (§2.5), rendered as React text. A link
 * renders only when the server re-resolved its stored page id through the
 * CURRENT token on this read (§3.4) AND its href passes `isSameOriginPath`
 * (the AI Markdown renderer's own boundary). Stored URLs do not exist.
 *
 * Stale evidence (§4.3): every prior answer says "Answered <time>. Figures are
 * as of then." and every prior figure carries an "as of" chip. A figure is never
 * refreshed in place.
 *
 * Privacy: no draft persistence, no keystroke handling beyond the controlled
 * textarea, no analytics, no logging. The v0 privacy hint is kept verbatim
 * (`data-platform-ai-privacy-hint`), and the OD-5 disclosure line is ONE
 * exported constant with the owner-approved wording (platform-ai-conversations-model).
 *
 * REUSE (§11; parity PR3). Shared PRESENTATION only, all props-driven:
 * `AiShell` (frame), `ConversationLog` + `ThinkingIndicator` (reading column,
 * auto-scroll, the three dots), the answer frame (AI-mark gutter + prose; it
 * wraps Platform's OWN typed-segment renderer — never the Markdown answer),
 * `ComposerFrame` (docked pill, auto-grow, Enter-to-send; NO Stop: an abort
 * would not cancel the server turn — S2 accepted), `SuggestedPrompt` (starter
 * chips), `MessageCard` and `FailedTurn`. NOT reused: `ConversationView` (it
 * renders Markdown answers), `Composer` (the customer `AiDisclosure`, label
 * and placeholder). Neither the transcript cache, Space context nor
 * Talk-about-this is imported anywhere on this path (no barrel import either).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, SquarePen, Trash2 } from "lucide-react";
import { AiShell } from "@/components/ai/AiShell";
import { AnswerFrame } from "@/components/ai/answer-frame";
import { ComposerFrame } from "@/components/ai/Composer";
import { ConversationLog, ThinkingIndicator } from "@/components/ai/ConversationView";
import { isSameOriginPath } from "@/components/ai/Markdown";
import { MessageCard } from "@/components/ai/MessageCard";
import { FailedTurn } from "@/components/ai/FailedTurn";
import { SuggestedPrompt } from "@/components/ai/SuggestedPrompt";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { Panel } from "@/components/atlas/panels/Panel";
import { PanelContent, PanelHeader } from "@/components/atlas/panels/PanelParts";
import { ToneBadge } from "@/components/platform/platform-surface";
import { PeriodCorrections, answeringFrom } from "./PlatformAiAsk";
import { PLATFORM_AI_TITLE } from "./PlatformAiPlaceholder";
import {
  CONVERSATION_FULL_COPY, CONVERSATION_LIMIT_COPY, DELETE_CONFIRM_COPY, EARLIER_EXPIRED_COPY, FAILURE_COPY,
  PLATFORM_AI_COMPOSER_MAX, PLATFORM_AI_CONVERSATIONS_DISCLOSURE, PLATFORM_AI_CONVERSATIONS_URL, PLATFORM_AI_PRIVACY_HINT,
  PLATFORM_AI_STARTER_HEADLINE, PLATFORM_AI_STARTER_PROMPTS, PLATFORM_AI_THINKING_LABEL,
  RAIL_COLLAPSED_KEY, UNAVAILABLE_COPY, UNREADABLE_COPY,
  answeredLine, asOfChip, conversationMessagesUrl, conversationUrl, earlierMessagesExpired, hasPendingTurn,
  parseList, parsePair, parseThread, problemFor, questionBefore, relativeTime, utcStamp,
  type ClientConversation, type ClientLimits, type ClientMessage, type ClientSegment, type SendProblem,
} from "./platform-ai-conversations-model";

// ── Presentation (pure; DOM-less tested) ────────────────────────────────────

/** A typed answer: text as text, a figure with its stale chip, a link only when same-origin. */
export function TypedAnswerSegments({ segments, staleAsOf }: { segments: readonly ClientSegment[]; staleAsOf: { chip: string; title: string } | null }) {
  return (
    <>
      <PeriodCorrections segments={segments} />
      <p className="min-w-0 whitespace-pre-wrap break-words leading-relaxed text-[var(--text-primary)]">
        {segments.map((s, i) => {
          if (s.kind === "correction") return null; // rendered ABOVE the answer (PeriodCorrections)
          if (s.kind === "link") {
            return isSameOriginPath(s.href)
              ? <a key={i} href={s.href} className="underline underline-offset-2">{s.text}</a>
              : <span key={i}>{s.text}</span>;
          }
          if (s.kind === "figure") {
            return (
              <span key={i}>
                <span data-platform-ai-figure="" className="tabular-nums font-medium">{s.text}</span>
                {staleAsOf ? (
                  <span data-platform-ai-stale-chip="" title={staleAsOf.title}
                    className="ml-1 inline-flex items-center rounded-full border border-[var(--border-hairline)] px-1.5 align-middle text-[10px] font-normal leading-4 text-[var(--text-muted)]">
                    {staleAsOf.chip}
                  </span>
                ) : null}
              </span>
            );
          }
          return <span key={i}>{s.text}</span>;
        })}
      </p>
    </>
  );
}

/** One answer in the shared answer frame (AI-mark gutter + prose). The body is Platform's typed segments. */
export function AssistantAnswer({ message, areaLabel, now }: { message: ClientMessage; areaLabel: string; now: Date }) {
  const staleAsOf = message.stale ? { chip: asOfChip(message.createdAt, now), title: utcStamp(message.createdAt) } : null;
  const segments = Array.isArray(message.content) ? message.content : null;
  const extras = (
    <>
      {message.notes.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]">
          {message.notes.map((n, i) => <li key={i} className="min-w-0 break-words">{n}</li>)}
        </ul>
      ) : null}
      {message.citations.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1.5 border-t border-[var(--border-hairline)] pt-3">
          {message.citations.map((c) => (
            <li key={c.metric} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">{c.label}</span>
              <span className="min-w-0 break-words text-[var(--text-secondary)]">{c.window}</span>
              {staleAsOf ? <span data-platform-ai-stale-chip="" title={staleAsOf.title} className="text-[var(--text-muted)]">{staleAsOf.chip}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] text-[var(--text-muted)]">{answeringFrom(areaLabel)}.</p>
    </>
  );
  return (
    <section aria-label="Answer" data-platform-ai-answer={message.stale ? "stale" : "current"} className="min-w-0">
      <AnswerFrame extras={extras}>
        {message.stale ? (
          <p data-platform-ai-stale-line="" title={utcStamp(message.createdAt)} className="mb-2 min-w-0 break-words text-[11px] text-[var(--text-muted)]">
            {answeredLine(message.createdAt, now)}
          </p>
        ) : null}
        {segments && !message.unavailable
          ? <TypedAnswerSegments segments={segments} staleAsOf={staleAsOf} />
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
  areaLabel: string;
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
export function Thread({ messages, areaLabel, now, sendingQuestion, earlierExpired, onRetryFailed, onCheckPending, busy }: ThreadProps) {
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
        return <div key={m.id} className="ai-turn-enter min-w-0"><AssistantAnswer message={m} areaLabel={areaLabel} now={now} /></div>;
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
  onNew: () => void;
  onDelete: (c: ClientConversation) => void;
}

export function ConversationList({ conversations, selectedId, now, limits, error, onSelect, onNew, onDelete }: ConversationListProps) {
  return (
    <div data-platform-ai-conversation-list="" className="flex min-w-0 flex-col gap-2">
      <button type="button" onClick={onNew}
        className="inline-flex min-h-9 w-full min-w-0 items-center justify-center gap-1.5 rounded-full border border-[var(--border-hairline-strong)] px-3 text-sm font-medium text-[var(--text-primary)]">
        <Plus size={14} aria-hidden /> New conversation
      </button>
      {limits ? (
        <p className="text-[11px] tabular-nums text-[var(--text-muted)]">{limits.used} of {limits.max} conversations</p>
      ) : null}
      {error ? <p role="status" className="min-w-0 break-words text-xs text-[var(--text-secondary)]">{error}</p> : null}
      {conversations === null && !error ? <p className="text-xs text-[var(--text-muted)]">Loading…</p> : null}
      {conversations !== null && conversations.length === 0 ? <p className="text-xs text-[var(--text-muted)]">No conversations yet.</p> : null}
      {conversations && conversations.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {conversations.map((c) => (
            <li key={c.id} className="flex min-w-0 items-stretch gap-1">
              <button type="button" onClick={() => onSelect(c.id)} aria-current={c.id === selectedId ? "true" : undefined}
                className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left ${c.id === selectedId ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-hover)]"}`}>
                <span className="w-full min-w-0 truncate text-sm text-[var(--text-primary)]">{c.label ?? `${c.areaLabel} conversation`}</span>
                <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-muted)]">
                  <span data-platform-ai-area-chip="" className="min-w-0 truncate">{c.areaLabel}</span>
                  <span title={utcStamp(c.lastActivityAt)}>{relativeTime(c.lastActivityAt, now)}</span>
                  {c.full ? <span>Full</span> : null}
                </span>
              </button>
              <button type="button" onClick={() => onDelete(c)} aria-label={`Delete conversation: ${c.label ?? c.areaLabel}`}
                className="inline-flex w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]">
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  busy: boolean;
}

/** While a send is in flight the send button shows, disabled. There is NO Stop (S2: an abort would not cancel the server turn). */
const BUSY_SEND_CLASS = "w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-white bg-[var(--accent-info)] opacity-35 cursor-not-allowed";

/**
 * The Platform composer: the shared `ComposerFrame` (docked pill, auto-grow,
 * Enter-to-send, IME-safe) bound to v0's question box contract — the
 * `platform-ai-question` id, 500 characters, the privacy hint and the OD-5
 * line tied by aria-describedby — with a character counter beneath.
 */
export function PlatformAiComposer({ value, onChange, onSubmit, disabled, busy }: ComposerProps) {
  return (
    <ComposerFrame
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      label="Ask Platform AI"
      inputId="platform-ai-question"
      maxLength={PLATFORM_AI_COMPOSER_MAX}
      placeholder="Ask about jobs, providers, costs, incidents or customers"
      describedBy="platform-ai-privacy-hint platform-ai-conversations-disclosure"
      disabled={disabled}
      trailing={busy && !disabled ? (
        <button type="submit" disabled aria-label="Send message" aria-busy="true" className={BUSY_SEND_CLASS}>
          <ArrowUp size={17} strokeWidth={2.25} />
        </button>
      ) : undefined}
      footer={
        <div data-platform-ai-composer-footer="" className="mt-2 flex min-w-0 flex-col gap-0.5 px-1 text-[11px] text-[var(--text-muted)]">
          <p id="platform-ai-privacy-hint" data-platform-ai-privacy-hint="" className="min-w-0 break-words text-[var(--text-secondary)]">
            {PLATFORM_AI_PRIVACY_HINT}
          </p>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <p id="platform-ai-conversations-disclosure" data-platform-ai-conversations-disclosure="" className="min-w-0 break-words">
              {PLATFORM_AI_CONVERSATIONS_DISCLOSURE}
            </p>
            <span data-platform-ai-counter="" className="shrink-0 tabular-nums">{value.length}/{PLATFORM_AI_COMPOSER_MAX}</span>
          </div>
        </div>
      }
    />
  );
}

export interface PlatformAiConversationsViewProps {
  /** The area a NEW conversation answers from (platformAiAreaFor, decided by the page). */
  areaLabel: string;
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
  /** A starter chip: asks exactly its text through the normal send path. */
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
}

/** Header action: the same quiet "New chat" control Personal Space AI shows. */
const NEW_CHAT_CLASS = "inline-flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-xs font-medium transition-colors text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]";

/** Pure (no hooks): every state renders from props, so the DOM-less tests can walk it. */
export function PlatformAiConversationsView(p: PlatformAiConversationsViewProps) {
  const messages = p.selected?.messages ?? [];
  const busy = p.sendingQuestion !== null;
  const pending = hasPendingTurn(messages);
  const full = p.selected?.conversation.full === true || p.problem?.kind === "FULL";
  const atLimit = !p.selected && (p.problem?.kind === "LIMIT" || (p.limits !== null && p.limits.used >= p.limits.max));
  const label = p.selected?.conversation.areaLabel ?? p.areaLabel;
  const conversationMode = messages.length > 0 || busy || p.threadLoading;
  const list = (
    <ConversationList conversations={p.conversations} selectedId={p.selected?.conversation.id ?? null} now={p.now}
      limits={p.limits} error={p.listError} onSelect={p.onSelect} onNew={p.onNew} onDelete={p.onAskDelete} />
  );
  const areaNotice = (
    <p data-platform-ai-area="" className="min-w-0 break-words px-1 text-xs text-[var(--text-secondary)]">{answeringFrom(label)} only.</p>
  );

  const controls = (
    <>
      <ToneBadge word="Read-only" tone="info" />
      {conversationMode || p.selected ? (
        <button type="button" data-platform-ai-new-chat="" onClick={p.onNew} disabled={busy} className={NEW_CHAT_CLASS}>
          <SquarePen size={14} aria-hidden />
          <span className="max-sm:sr-only">New chat</span>
        </button>
      ) : null}
      <button type="button" data-platform-ai-sheet-toggle="" onClick={() => p.onSheet(true)} aria-haspopup="dialog" aria-expanded={p.sheetOpen}
        className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-hairline)] px-3 text-sm text-[var(--text-primary)] lg:hidden">
        <MessagesSquare size={14} aria-hidden /> <span className="max-sm:sr-only">Conversations</span>
      </button>
    </>
  );

  // The desktop rail, in the shell's `side` slot: beside the reading region, scrolling on its own.
  const side = (
    <aside data-platform-ai-rail={p.railCollapsed ? "collapsed" : "open"} aria-label="Conversations"
      className={`hidden min-h-0 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-r border-[var(--border-hairline)] pr-3 lg:flex ${p.railCollapsed ? "w-12" : "w-64"}`}>
      <button type="button" onClick={() => p.onRail(!p.railCollapsed)} aria-expanded={!p.railCollapsed}
        aria-label={p.railCollapsed ? "Show conversations" : "Hide conversations"}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]">
        {p.railCollapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
      </button>
      {p.railCollapsed ? null : list}
    </aside>
  );

  const starters = atLimit || full ? null : (
    <div data-platform-ai-starters="" className="mt-5 flex min-w-0 flex-wrap justify-center gap-2">
      {PLATFORM_AI_STARTER_PROMPTS.map((q) => <SuggestedPrompt key={q} label={q} onSelect={() => p.onStarter(q)} />)}
    </div>
  );
  const lead = (
    <div data-platform-ai-empty="" className="flex min-w-0 flex-col items-center gap-2 text-center">
      <h2 className="text-xl font-semibold text-[var(--text-primary)]">{PLATFORM_AI_STARTER_HEADLINE}</h2>
      {areaNotice}
    </div>
  );

  const problemLine = p.problem && p.problem.kind !== "FULL" && p.problem.kind !== "LIMIT" ? (
    <div role="status" data-platform-ai-problem={p.problem.kind} className="mx-auto mb-2 flex w-full min-w-0 max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm text-[var(--text-secondary)]">
      <span className="min-w-0 break-words">{p.problem.text}</span>
      {p.problem.kind === "NETWORK" && p.canRetrySend ? (
        <button type="button" onClick={p.onRetrySend} disabled={busy} className="shrink-0 text-xs underline underline-offset-2">Try again</button>
      ) : null}
    </div>
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
          <PlatformAiComposer value={p.draft} onChange={p.onDraft} onSubmit={p.onSend} busy={busy} disabled={pending || atLimit || p.threadLoading} />
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
        contextPrefix="Area: "
        controls={controls}
        side={side}
        lead={lead}
        aside={starters}
        composer={composer}
      >
        {p.threadLoading && messages.length === 0 ? (
          <div className="mx-auto w-full min-w-0 max-w-3xl px-1 pt-3">
            {areaNotice}
            <p className="mt-3 text-xs text-[var(--text-muted)]">Loading…</p>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="mx-auto w-full min-w-0 max-w-3xl pt-3">{areaNotice}</div>
            <Thread messages={messages} areaLabel={label} now={p.now} sendingQuestion={p.sendingQuestion}
              earlierExpired={p.selected ? earlierMessagesExpired(p.selected.conversation, messages, p.now) : false}
              onRetryFailed={full || pending ? undefined : p.onRetryFailed} onCheckPending={p.onCheckPending} busy={busy} />
          </div>
        )}
      </AiShell>

      <Panel open={p.sheetOpen} onClose={() => p.onSheet(false)} side="left" size="sm" ariaLabel="Conversations">
        <PanelHeader title="Conversations" />
        <PanelContent>{list}</PanelContent>
      </Panel>

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

interface PendingSend { conversationId: string | null; clientRequestId: string; question: string }

function readRailCollapsed(): boolean {
  try { return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1"; } catch { return false; }
}
function writeRailCollapsed(v: boolean): void {
  try { window.localStorage.setItem(RAIL_COLLAPSED_KEY, v ? "1" : "0"); } catch { /* a convenience only */ }
}

export function PlatformAiConversations({ areaLabel }: { areaLabel: string }) {
  const [now, setNow] = useState(() => new Date());
  const [conversations, setConversations] = useState<ClientConversation[] | null>(null);
  const [limits, setLimits] = useState<ClientLimits | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ conversation: ClientConversation; messages: ClientMessage[] } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<PendingSend | null>(null);
  const [retry, setRetry] = useState<PendingSend | null>(null);
  const [problem, setProblem] = useState<SendProblem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ClientConversation | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Relative times tick once a minute (no other timer).
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Read after mount (localStorage is browser-only; the server render is "open").
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setRailCollapsed(readRailCollapsed()); }, []);

  const openConversation = useCallback(async (id: string) => {
    setThreadLoading(true); setProblem(null); setRetry(null);
    const r = await call(conversationUrl(id));
    setThreadLoading(false);
    const parsed = r && r.status === 200 ? parseThread(r.body) : null;
    if (parsed) { setSelected(parsed); setNow(new Date()); return; }
    setSelected(null);
    if (r && r.status === 404) setConversations((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
    setProblem(r ? problemFor(r.status, r.body) : { kind: "NETWORK", text: UNAVAILABLE_COPY });
  }, []);

  const loadList = useCallback(async (openLatest: boolean) => {
    const r = await call(PLATFORM_AI_CONVERSATIONS_URL);
    const parsed = r && r.status === 200 ? parseList(r.body) : null;
    if (!parsed) { setListError(UNAVAILABLE_COPY); setConversations((cs) => cs ?? []); return; }
    setListError(null); setConversations(parsed.conversations); setLimits(parsed.limits);
    if (openLatest && parsed.conversations.length > 0) await openConversation(parsed.conversations[0].id);
  }, [openConversation]);

  // §11: the page opens on the latest conversation, or on an empty composer.
  // The first read (an external system); every setState in it runs after the awaited fetch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadList(true); }, [loadList]);

  async function send(s: PendingSend) {
    setSending(s); setProblem(null); setRetry(null);
    const r = s.conversationId
      ? await postJson(conversationMessagesUrl(s.conversationId), { clientRequestId: s.clientRequestId, question: s.question })
      : await postJson(PLATFORM_AI_CONVERSATIONS_URL, { clientRequestId: s.clientRequestId, question: s.question });
    setSending(null);
    if (!r) {
      // Transport failure: the server may or may not have stored it. Retrying with the SAME id is an idempotent replay (§5.1).
      setRetry(s); setProblem({ kind: "NETWORK", text: "Couldn’t reach Platform AI." });
      return;
    }
    const pair = r.status === 200 || r.status === 201 ? parsePair(r.body) : null;
    if (pair) {
      setNow(new Date());
      setSelected((cur) => {
        if (!s.conversationId) {
          return pair.conversation ? { conversation: pair.conversation, messages: [pair.user, pair.assistant] } : cur;
        }
        if (!cur || cur.conversation.id !== s.conversationId) return cur;
        // Every earlier answer becomes "prior" (§4.3), as a re-read would label it.
        const prior = cur.messages.filter((m) => m.id !== pair.user.id && m.id !== pair.assistant.id).map((m) => (m.role === "ASSISTANT" ? { ...m, stale: true } : m));
        return { ...cur, messages: [...prior, pair.user, pair.assistant] };
      });
      void loadList(false);
      return;
    }
    const pr = problemFor(r.status, r.body);
    setProblem(pr);
    // A refusal stores nothing (§5.3): give the question back to the operator.
    if (pr.kind === "REFUSED" || pr.kind === "LIMIT" || pr.kind === "FULL") setDraft((d) => (d.length === 0 ? s.question : d));
    if (pr.kind === "FULL") setSelected((cur) => (cur ? { ...cur, conversation: { ...cur.conversation, full: true } } : cur));
    if (pr.kind === "IN_FLIGHT" && s.conversationId) void openConversation(s.conversationId);
    if (pr.kind === "NOT_FOUND") { setSelected(null); void loadList(false); }
  }

  function onSend() {
    if (ask(draft)) setDraft("");
  }

  /** A fresh question — typed (onSend) or a starter chip: ONE path, a NEW clientRequestId. */
  function ask(question: string): boolean {
    const q = question.trim();
    if (!q || sending) return false;
    void send({ conversationId: selected?.conversation.id ?? null, clientRequestId: crypto.randomUUID(), question: q });
    return true;
  }

  function onNew() {
    setSelected(null); setProblem(null); setRetry(null); setSheetOpen(false);
  }

  async function onConfirmDelete() {
    const c = confirmDelete;
    if (!c) return;
    setDeleting(true);
    const r = await call(conversationUrl(c.id), { method: "DELETE" });
    setDeleting(false); setConfirmDelete(null);
    if (r && (r.status === 204 || r.status === 404)) {
      setConversations((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs));
      if (selected?.conversation.id === c.id) onNew();
      void loadList(false);
    } else {
      setProblem(r ? problemFor(r.status, r.body) : { kind: "NETWORK", text: UNAVAILABLE_COPY });
    }
  }

  return (
    <PlatformAiConversationsView
      areaLabel={areaLabel} now={now}
      conversations={conversations} limits={limits} listError={listError}
      selected={selected} threadLoading={threadLoading}
      draft={draft} sendingQuestion={sending?.question ?? null} problem={problem} canRetrySend={retry !== null}
      sheetOpen={sheetOpen} railCollapsed={railCollapsed} confirmDelete={confirmDelete} deleting={deleting}
      onDraft={setDraft}
      onSend={onSend}
      onStarter={(q) => { ask(q); }}
      onRetrySend={() => { if (retry) void send(retry); }}
      onRetryFailed={(q) => { void send({ conversationId: selected?.conversation.id ?? null, clientRequestId: crypto.randomUUID(), question: q }); }}
      onCheckPending={() => { if (selected) void openConversation(selected.conversation.id); }}
      onSelect={(id) => { setSheetOpen(false); void openConversation(id); }}
      onNew={onNew}
      onAskDelete={setConfirmDelete}
      onConfirmDelete={() => { void onConfirmDelete(); }}
      onCancelDelete={() => { if (!deleting) setConfirmDelete(null); }}
      onSheet={setSheetOpen}
      onRail={(v) => { setRailCollapsed(v); writeRailCollapsed(v); }}
    />
  );
}
