"use client";

/**
 * components/dashboard/AnalyzeClient.tsx  (AI Experience Convergence — AI-2)
 *
 * ORCHESTRATION ONLY. This client owns the AI conversation's data + state — the
 * message list, the /api/ai/chat request (unchanged), loading/abort, and the
 * knowledge-gap session state — and composes the presentation from
 * `components/ai/*`. No markup lives here beyond wiring the shells.
 *
 * The surface is now conversation-first: the former ML Review tab is retired (its
 * only real capability — scheduled advice — is preserved via AdviceBanner in the
 * empty state; the other cards were hardcoded/derived descriptive chrome). The
 * backend contract is untouched: request `{spaceId, messages}` → response
 * `{message, knowledgeGaps, knowledgeGapMode}`, non-streaming, stateless.
 *
 * AI-3 (conversation-first layout): the layout is derived from `messages.length`
 * alone — empty ⇒ the composer is centered under a starter line; any turn ⇒ the
 * conversation column with the composer docked. The synthetic opening greeting is
 * gone (the empty state replaces it); it was never sent, so the request body is
 * byte-identical. There is no history restore, so a visit always opens empty and
 * there is no loading state to wait on before choosing the layout.
 *
 * AI-4 (one Space per conversation): there is no Space selector. Its default,
 * "All My Spaces", was never an aggregate — the route resolved it to the user's
 * PERSONAL Space while the rest of the page used the active one, and switching it
 * mid-chat carried one Space's transcript into another. The server page now
 * resolves the dashboard's active Space and passes its id and name; every request
 * posts exactly that id (the route still re-resolves it and refuses a mismatch),
 * and the page keys this client by it, so a different Space is a new conversation.
 * The starter headline and chips arrive already composed — display strings only —
 * and a chip is sent as ordinary prose through `sendMessage`.
 */

import { useState, useRef, useCallback, type ReactNode } from "react";
import { SquarePen } from "lucide-react";
import {
  AiShell,
  ConversationView,
  Composer,
  SuggestedPrompt,
  KnowledgeGapCard,
  StarterLine,
  conversationLayoutMode,
  type StarterModel,
} from "@/components/ai";
import { AdviceBanner } from "@/components/dashboard/AdviceBanner";
import {
  KnowledgeAcquisitionCard,
  KnowledgeClarificationCard,
} from "@/components/dashboard/KnowledgeAcquisitionCard";
import type { GapEntry } from "@/components/dashboard/KnowledgeAcquisitionCard";
import { readKnowledgeGaps } from "@/lib/ai/conversation/knowledge-gaps";
import type { AiAdvice, AiChatResponse } from "@/types";

interface Message {
  role: "user" | "assistant";
  content: string;
  /** Knowledge gaps present in context when this assistant response was generated. */
  knowledgeGaps?: GapEntry[];
  /**
   * How the client should render gaps for this message.
   * "form"          — user explicitly asked to update a field; show full card immediately.
   * "clarification" — gaps exist but user didn't ask to update; show lightweight card first.
   * Absent when there are no gaps.
   */
  knowledgeGapMode?: "clarification" | "form";
}

interface Props {
  advice: AiAdvice | null;
  /** Index into STARTER_LINES, chosen per request by the server page. */
  starterIndex: number;
  /** The active Space this conversation belongs to, resolved by the server page. */
  spaceId: string;
  /** Its name, shown as plain text in the header. */
  spaceName: string;
  /** The empty state's headline + chips (personal where memory supports it). */
  starter: StarterModel;
}

export function AnalyzeClient({ advice, starterIndex, spaceId, spaceName, starter }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  /** Latches once the composer is focused or typed into — the starter line stops swapping. */
  const [composerEngaged, setComposerEngaged] = useState(false);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const [loading, setLoading] = useState(false);
  /** Holds the AbortController for the in-flight /api/ai/chat request, if any. */
  const abortControllerRef = useRef<AbortController | null>(null);

  // ── Knowledge Acquisition session state ────────────────────────────────────
  // All session-only. Nothing is persisted. A page refresh resets them.

  /**
   * Gap keys the user has dismissed ("Not now") for this chat session.
   * Key format: `${accountId}:${field}` — matches KnowledgeAcquisitionCard.
   * Hidden across all messages until the page is refreshed.
   */
  const [snoozedGapKeys, setSnoozedGapKeys] = useState<ReadonlySet<string>>(new Set());

  /** Message indices where the user expanded a clarification card to the full form. */
  const [expandedGapIndices, setExpandedGapIndices] = useState<ReadonlySet<number>>(new Set());

  /**
   * Message indices where the user dismissed an explicit update form ("Not now").
   * Closes only that instance — does NOT snooze, so an explicit ask still shows again.
   */
  const [dismissedFormIndices, setDismissedFormIndices] = useState<ReadonlySet<number>>(new Set());

  function gapKey(g: GapEntry): string {
    return `${g.accountId}:${g.field}`;
  }
  function snoozeGaps(keys: string[]): void {
    setSnoozedGapKeys((prev) => new Set([...prev, ...keys]));
  }
  function expandGapAt(index: number): void {
    setExpandedGapIndices((prev) => new Set([...prev, index]));
  }
  function dismissFormAt(index: number): void {
    setDismissedFormIndices((prev) => new Set([...prev, index]));
  }

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
  }, []);

  /** Clears the (session-only) conversation back to the empty state. Nothing is persisted. */
  function startNewConversation(): void {
    stopGeneration();
    setMessages([]);
    setSnoozedGapKeys(new Set());
    setExpandedGapIndices(new Set());
    setDismissedFormIndices(new Set());
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  async function sendMessage(text?: string) {
    const msg = text ?? input.trim();
    if (!msg || loading) return;
    setInput("");

    const nextMessages: Message[] = [...messages, { role: "user", content: msg }];
    setMessages(nextMessages);
    setLoading(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          spaceId,
          // Only real user/assistant turns exist in state (no UI greeting), so the
          // whole list is the conversation history.
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (res.ok) {
        // One declaration of the response, shared with the route (@/types), so the
        // two cannot drift. The gaps are narrowed rather than trusted wholesale:
        // a malformed extra must cost the user the extra, never the answer.
        const data = (await res.json()) as AiChatResponse;
        const gaps = readKnowledgeGaps(data.knowledgeGaps);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.message,
            // Only attach gaps / mode when the answer actually named missing fields.
            ...(gaps.length
              ? { knowledgeGaps: gaps, knowledgeGapMode: data.knowledgeGapMode }
              : {}),
          },
        ]);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.error ?? "Something went wrong. Please try again." },
        ]);
      }
    } catch (err) {
      // AbortError is intentional — user clicked Stop. Do not push an error message.
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Network error. Please check your connection and try again." },
      ]);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  }

  // Per-answer extras: the knowledge-gap prompt for the assistant message at `index`.
  // Behaviour is unchanged from the pre-reshell IIFE — only the presentation frame
  // (KnowledgeGapCard) is new; the interactive cards are reused verbatim.
  function renderExtras(index: number): ReactNode {
    const m = messages[index];
    if (m.role !== "assistant" || !m.knowledgeGaps?.length) return null;

    // Explicit update: user asked to update a field (mode === "form") or expanded a
    // clarification card. Snooze must NOT suppress explicit requests.
    const isExplicitUpdate = m.knowledgeGapMode === "form" || expandedGapIndices.has(index);
    if (isExplicitUpdate && dismissedFormIndices.has(index)) return null;

    const visibleGaps = isExplicitUpdate
      ? m.knowledgeGaps
      : m.knowledgeGaps.filter((g) => !snoozedGapKeys.has(gapKey(g)));
    if (visibleGaps.length === 0) return null;

    const inner = isExplicitUpdate ? (
      <KnowledgeAcquisitionCard
        gaps={visibleGaps}
        onDismiss={() => dismissFormAt(index)}
        onSaved={() =>
          sendMessage("I saved the missing information. Please recalculate with the updated context.")
        }
      />
    ) : (
      <KnowledgeClarificationCard
        gaps={visibleGaps}
        onExpand={() => expandGapAt(index)}
        onSnooze={() => snoozeGaps(visibleGaps.map(gapKey))}
      />
    );

    return <KnowledgeGapCard>{inner}</KnowledgeGapCard>;
  }

  const mode = conversationLayoutMode(messages.length);

  const suggestions = (
    <div className="max-w-3xl mx-auto w-full">
      <div role="group" aria-label="Suggestions" className="mt-4 flex flex-wrap justify-center gap-2">
        {starter.prompts.map((s) => (
          <SuggestedPrompt key={s.label} label={s.label} onSelect={() => sendMessage(s.prompt)} variant="chip" />
        ))}
      </div>
      {advice && (
        <div className="mx-auto mt-10 max-w-xl">
          <AdviceBanner advice={advice} />
        </div>
      )}
    </div>
  );

  const controls =
    mode === "conversation" ? (
      <button
        type="button"
        onClick={startNewConversation}
        className="inline-flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-xs font-medium transition-colors text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
      >
        <SquarePen size={14} aria-hidden />
        <span className="max-sm:sr-only">New chat</span>
      </button>
    ) : undefined;

  return (
    <AiShell
      mode={mode}
      controls={controls}
      contextLabel={spaceName}
      lead={
        <StarterLine
          initialIndex={starterIndex}
          headline={starter.headline}
          frozen={composerEngaged || input.length > 0}
        />
      }
      aside={suggestions}
      composer={
        <Composer
          value={input}
          onChange={(v) => { setInput(v); setComposerEngaged(true); }}
          onFocus={() => setComposerEngaged(true)}
          onSubmit={() => sendMessage()}
          onStop={stopGeneration}
          busy={loading}
          textareaRef={composerInputRef}
        />
      }
    >
      <ConversationView messages={messages} busy={loading} renderExtras={renderExtras} />
    </AiShell>
  );
}
