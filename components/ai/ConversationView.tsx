"use client";

/**
 * components/ai/ConversationView.tsx  (AI Experience Convergence — AI-1)
 *
 * The conversation thread: user turns as `MessageCard`s, assistant turns as
 * grounded `AnswerCard`s, a "thinking" indicator while a reply is in flight, and an
 * auto-scroll sentinel. Per-answer extras (the knowledge-gap prompt) are supplied by
 * the orchestrator through `renderExtras(index)` so this view stays free of any AI
 * domain type. The `emptyState` shows while only the opening greeting exists.
 * Presentation only.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { AiMark } from "@/components/ai/AiMark";
import { MessageCard } from "@/components/ai/MessageCard";
import { AnswerCard } from "@/components/ai/AnswerCard";
import type { AiMessage } from "@/components/ai/types";

export interface ConversationViewProps {
  messages: AiMessage[];
  busy?: boolean;
  /** Extras (e.g. the knowledge-gap prompt) for the assistant message at `index`. */
  renderExtras?: (index: number) => ReactNode;
  /** Shown after the greeting while the conversation hasn't started. */
  emptyState?: ReactNode;
}

export function ConversationView({ messages, busy, renderExtras, emptyState }: ConversationViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const showEmptyState = messages.length <= 1;

  return (
    <div className="max-w-3xl mx-auto w-full space-y-6 px-1 py-1">
      {messages.map((m, i) =>
        m.role === "assistant" ? (
          <AnswerCard key={i} message={m.content}>{renderExtras?.(i)}</AnswerCard>
        ) : (
          <MessageCard key={i} content={m.content} />
        ),
      )}

      {busy && (
        <div className="flex gap-3">
          <div className="pt-1.5 shrink-0"><AiMark className="animate-pulse" /></div>
          <div className="flex gap-1.5 items-center h-6">
            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: "0ms", background: "var(--text-muted)" }} />
            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: "150ms", background: "var(--text-muted)" }} />
            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: "300ms", background: "var(--text-muted)" }} />
          </div>
        </div>
      )}

      {showEmptyState && emptyState}

      <div ref={endRef} />
    </div>
  );
}
