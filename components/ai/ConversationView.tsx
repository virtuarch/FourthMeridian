"use client";

/**
 * components/ai/ConversationView.tsx  (AI Experience Convergence — AI-1, conversation-first AI-3)
 *
 * The conversation thread in a centered reading column: user turns as
 * `MessageCard`s, assistant turns as grounded `AnswerCard`s, a "thinking" indicator
 * while a reply is in flight. Per-answer extras (the knowledge-gap prompt) are
 * supplied by the orchestrator through `renderExtras(index)` so this view stays free
 * of any AI domain type. Presentation only.
 *
 * Scrolling happens inside the shell's scroll container, never the document: a new
 * user turn (or the thinking indicator) scrolls to the end; an arriving answer
 * brings the question that prompted it to the top, so a long answer is read from its
 * first line instead of its last.
 */

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AiMark } from "@/components/ai/AiMark";
import { MessageCard } from "@/components/ai/MessageCard";
import { AnswerCard } from "@/components/ai/AnswerCard";
import { FailedTurn } from "@/components/ai/FailedTurn";
import type { AiMessage } from "@/components/ai/types";

export interface ConversationViewProps {
  messages: AiMessage[];
  busy?: boolean;
  /** Extras (e.g. the knowledge-gap prompt) for the assistant message at `index`. */
  renderExtras?: (index: number) => ReactNode;
  /** Re-ask the question the newest failure did not answer. Offered on that failure only. */
  onRetry?: () => void;
  /** The failure (by index) that happened in this session, announced to assistive tech. */
  announceFailureIndex?: number | null;
}

function scrollToTurn(el: HTMLElement | null, align: "start" | "end"): void {
  if (!el) return;
  const container = el.closest<HTMLElement>("[data-ai-scroll]");
  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (!container) {
    el.scrollIntoView({ block: align, behavior });
    return;
  }
  const top =
    align === "end"
      ? container.scrollHeight
      : container.scrollTop + el.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
  container.scrollTo({ top, behavior });
}

/** The in-flight indicator: a pulsing AI mark and three dots, announced as a status. */
export function ThinkingIndicator({ srLabel = "Fourth Meridian AI is thinking…" }: { srLabel?: string }) {
  return (
    <div role="status" className="ai-turn-enter flex gap-3">
      <div className="pt-1.5 shrink-0"><AiMark className="animate-pulse" /></div>
      <div aria-hidden className="flex gap-1.5 items-center h-6">
        <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ animationDelay: "0ms", background: "var(--text-muted)" }} />
        <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ animationDelay: "150ms", background: "var(--text-muted)" }} />
        <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ animationDelay: "300ms", background: "var(--text-muted)" }} />
      </div>
      <span className="sr-only">{srLabel}</span>
    </div>
  );
}

export interface ConversationLogProps {
  /** The rendered turns. */
  children: ReactNode;
  /** Changes whenever the turn list changes; re-runs the auto-scroll. */
  scrollKey: unknown;
  /** Number of turns; nothing scrolls when there are none. */
  turnCount: number;
  /** The newest turn is a settled answer: bring `anchorRef` (its question) to the top. */
  answered: boolean;
  /** The newest user turn. */
  anchorRef: RefObject<HTMLElement | null>;
  busy?: boolean;
  /** Shown while busy. Defaults to the three-dot `ThinkingIndicator`. */
  busyNode?: ReactNode;
}

/**
 * The reading column (`role="log"`) and its auto-scroll: a new question or the
 * busy state scrolls to the end; an arriving answer scrolls its question to the
 * top. Scrolls the nearest `[data-ai-scroll]` container, never the document.
 */
export function ConversationLog({ children, scrollKey, turnCount, answered, anchorRef, busy, busyNode }: ConversationLogProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (turnCount === 0) return;
    if (answered) scrollToTurn(anchorRef.current, "start");
    else scrollToTurn(endRef.current, "end");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same triggers as before the extraction: the turn list and busy
  }, [scrollKey, busy]);

  return (
    <div role="log" aria-label="Conversation" className="max-w-3xl mx-auto w-full space-y-7 px-1 pt-3 pb-10">
      {children}

      {busy && (busyNode ?? <ThinkingIndicator />)}

      <div ref={endRef} />
    </div>
  );
}

export function ConversationView({ messages, busy, renderExtras, onRetry, announceFailureIndex = null }: ConversationViewProps) {
  const lastUserRef = useRef<HTMLDivElement>(null);

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIndex = i; break; }
  }
  const answered = messages.length > 0 && messages[messages.length - 1].role === "assistant" && !busy;

  return (
    <ConversationLog scrollKey={messages} turnCount={messages.length} answered={answered} anchorRef={lastUserRef} busy={busy}>
      {messages.map((m, i) => (
        <div key={i} ref={i === lastUserIndex ? lastUserRef : undefined} className="ai-turn-enter">
          {m.role === "assistant" && m.status === "failed" ? (
            <FailedTurn message={m.content} busy={busy} announce={i === announceFailureIndex}
              onRetry={onRetry && i === messages.length - 1 && i > 0 && messages[i - 1].role === "user" ? onRetry : undefined} />
          ) : m.role === "assistant" ? (
            <AnswerCard message={m.content}>{renderExtras?.(i)}</AnswerCard>
          ) : (
            <MessageCard content={m.content} />
          )}
        </div>
      ))}
    </ConversationLog>
  );
}
