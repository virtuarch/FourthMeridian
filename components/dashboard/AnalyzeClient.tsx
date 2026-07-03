"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { AdviceBanner } from "@/components/dashboard/AdviceBanner";
import {
  KnowledgeAcquisitionCard,
  KnowledgeClarificationCard,
} from "@/components/dashboard/KnowledgeAcquisitionCard";
import type { GapEntry } from "@/components/dashboard/KnowledgeAcquisitionCard";
import { Brain, Send, X, Clock, Zap, BarChart2, MessageSquare, ChevronDown } from "lucide-react";
import type { AiAdvice, Snapshot } from "@/types";

type Tab = "review" | "chat";

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

interface SpaceOption {
  id: string;
  name: string;
  myRole: string;
}

interface Props {
  advice: AiAdvice | null;
  ficoScore: number | null;
  latestSnapshot: Snapshot | null;
  snapshotCount: number;
  assetClassCount: number;
  cryptoPct: number | null;
  userName: string;
}

const SUGGESTED_PROMPTS = [
  "How is my debt situation?",
  "Where can I cut spending?",
  "Break down my 2026 spending.",
  "Am I ready to invest?",
  "What is my biggest risk?",
];

const ELIGIBLE_ROLES = new Set(["OWNER", "ADMIN", "MEMBER"]);

// ── Markdown component overrides ──────────────────────────────────────────────
// Defined once outside the render tree so the object reference is stable.
// Cast to `any` at the call site — react-markdown@8 component map types are
// incompatible with React 19's JSX namespace changes.
// Colours migrated to Atlas ink tokens; code syntax colours neutralised.
const MD_COMPONENTS = {
  h1: ({ children }: { children: React.ReactNode }) => <p className="font-bold text-base mt-4 first:mt-0 mb-2" style={{ color: "var(--text-primary)" }}>{children}</p>,
  h2: ({ children }: { children: React.ReactNode }) => <p className="font-bold text-[15px] mt-4 first:mt-0 mb-1.5" style={{ color: "var(--text-primary)" }}>{children}</p>,
  h3: ({ children }: { children: React.ReactNode }) => <p className="font-semibold text-sm mt-3 first:mt-0 mb-1" style={{ color: "var(--text-primary)" }}>{children}</p>,
  p:  ({ children }: { children: React.ReactNode }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{children}</strong>,
  em: ({ children }: { children: React.ReactNode }) => <em className="italic" style={{ color: "var(--text-secondary)" }}>{children}</em>,
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-[var(--text-muted)]">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-[var(--text-muted)]">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="leading-relaxed pl-1" style={{ color: "var(--text-secondary)" }}>{children}</li>,
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 pl-3 py-0.5 italic mb-3" style={{ borderColor: "var(--border-hairline-strong)", color: "var(--text-secondary)" }}>{children}</blockquote>
  ),
  // Fenced code blocks come through with a className like "language-js";
  // inline code has no className.
  code: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    className ? (
      <pre className="border rounded-xl p-3 overflow-x-auto mb-3 text-xs font-mono leading-relaxed" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
        <code>{children}</code>
      </pre>
    ) : (
      <code className="rounded px-1.5 py-0.5 text-[13px] font-mono tabular-nums" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}>{children}</code>
    ),
  pre: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  hr: () => <hr className="my-3" style={{ borderColor: "var(--border-hairline)" }} />,
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="overflow-x-auto my-3 rounded-xl border" style={{ borderColor: "var(--border-hairline)" }}>
      <table className="min-w-full text-[13px] border-collapse tabular-nums">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: React.ReactNode }) => <thead style={{ background: "var(--surface-inset)" }}>{children}</thead>,
  tbody: ({ children }: { children: React.ReactNode }) => <tbody className="divide-y divide-[var(--border-hairline)]">{children}</tbody>,
  tr: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-3.5 py-2 text-left font-semibold whitespace-nowrap border-b" style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}>{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-3.5 py-2 align-top whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>{children}</td>,
};

export function AnalyzeClient({ advice, ficoScore: _ficoScore, latestSnapshot, snapshotCount, assetClassCount, cryptoPct, userName }: Props) {
  const [tab, setTab] = useState<Tab>("review");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        `Hi ${userName} — I'm your Fourth Meridian AI advisor. I have access to your financial data. Ask me anything about your portfolio, debt, cash position, or whether now is a good time to make a move.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>("master");
  const [spaces, setSpaces] = useState<SpaceOption[]>([]);
  const bottomRef          = useRef<HTMLDivElement>(null);
  /** Holds the AbortController for the in-flight /api/ai/chat request, if any. */
  const abortControllerRef = useRef<AbortController | null>(null);

  // ── Knowledge Acquisition session state ────────────────────────────────────
  // Both are session-only. Nothing is persisted. A page refresh resets them.

  /**
   * Gap keys the user has dismissed ("Not now") for this chat session.
   * Key format: `${accountId}:${field}` — matches the key used in KnowledgeAcquisitionCard.
   * Gaps in this set are hidden across all messages until the page is refreshed.
   */
  const [snoozedGapKeys, setSnoozedGapKeys] = useState<ReadonlySet<string>>(new Set());

  /**
   * Message indices where the user clicked "Update [field]" on a clarification card,
   * expanding it to the full KnowledgeAcquisitionCard.
   */
  const [expandedGapIndices, setExpandedGapIndices] = useState<ReadonlySet<number>>(new Set());

  /**
   * Message indices where the user dismissed an explicit update form ("Not now" on a
   * mode === "form" or expanded card). This closes only that specific form instance —
   * it does NOT add to snoozedGapKeys, so the user can explicitly ask again and the
   * form will reappear on the new message.
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch spaces once for the selector
  useEffect(() => {
    fetch("/api/spaces")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { mine: SpaceOption[] }) => {
        setSpaces(data.mine.filter((s) => ELIGIBLE_ROLES.has(s.myRole)));
      })
      .catch(() => {
        // Non-fatal: selector will just show "All My Spaces"
      });
  }, []);

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
  }, []);

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
          spaceId: selectedSpaceId,
          // Send only user/assistant turns; skip the initial assistant greeting
          // (index 0) as it is UI copy, not real conversation history.
          messages: nextMessages.slice(1).map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (res.ok) {
        const data = await res.json() as {
          message:          string;
          knowledgeGaps?:   GapEntry[];
          knowledgeGapMode?: "clarification" | "form";
        };
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.message,
            // Only attach gaps / mode when the context actually has missing fields.
            ...(data.knowledgeGaps?.length
              ? {
                  knowledgeGaps:    data.knowledgeGaps,
                  knowledgeGapMode: data.knowledgeGapMode,
                }
              : {}),
          },
        ]);
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.error ?? "Something went wrong. Please try again.",
          },
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

  // Composer key handling: Enter sends, Shift+Enter inserts a newline.
  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const isChat = tab === "chat";

  return (
    // On the AI Chat tab the whole page becomes a native LLM workspace: a single
    // flex column sized to the real remaining viewport height (100dvh minus the
    // shell's top bar + <main>'s own padding — see DashboardChrome.tsx), so the
    // conversation surface fills the space instead of living in a cramped, fixed
    // card. The ML Review tab keeps its natural, scroll-with-the-page flow.
    <div
      className={
        isChat
          ? "flex flex-col gap-4 h-[calc(100dvh-172px)] lg:h-[calc(100dvh-108px)] min-h-[420px]"
          : "space-y-5"
      }
    >
      <div className="shrink-0 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl border flex items-center justify-center" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
          <Brain size={18} style={{ color: "var(--accent-info)" }} />
        </div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>Analyze with AI</h1>
      </div>

      {/* Tab switcher */}
      <div className="shrink-0 flex gap-1 p-1 rounded-xl w-fit" style={{ background: "var(--surface-inset)" }}>
        <button
          onClick={() => setTab("review")}
          className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all touch-manipulation"
          style={tab === "review"
            ? { background: "var(--surface-hover-strong)", color: "var(--text-primary)" }
            : { color: "var(--text-secondary)" }}
        >
          <BarChart2 size={15} />
          ML Review
        </button>
        <button
          onClick={() => setTab("chat")}
          className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all touch-manipulation"
          style={tab === "chat"
            ? { background: "var(--surface-hover-strong)", color: "var(--text-primary)" }
            : { color: "var(--text-secondary)" }}
        >
          <MessageSquare size={15} />
          AI Chat
        </button>
      </div>

      {/* ML Review tab */}
      {tab === "review" && (
        <div className="space-y-4">
          {advice && <AdviceBanner advice={advice} />}

          {/* Schedule info */}
          <DataCard>
            <div className="flex items-center gap-2 mb-3">
              <Clock size={14} style={{ color: "var(--text-secondary)" }} />
              <DataCardTitle>Advice Schedule</DataCardTitle>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl p-3" style={{ background: "var(--surface-inset)" }}>
                <p className="text-xs mb-1" style={{ color: "var(--text-secondary)" }}>Weekdays</p>
                <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>9:00 AM & 4:00 PM</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>After market open + close</p>
              </div>
              <div className="rounded-xl p-3" style={{ background: "var(--surface-inset)" }}>
                <p className="text-xs mb-1" style={{ color: "var(--text-secondary)" }}>Weekends</p>
                <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>9:00 AM</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>Daily portfolio check-in</p>
              </div>
            </div>
          </DataCard>

          {/* What the engine reviews */}
          <DataCard>
            <DataCardTitle>What the Engine Reviews</DataCardTitle>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                { label: "Cash Position", value: latestSnapshot ? `$${latestSnapshot.totalCash.toLocaleString("en-US")}` : "—" },
                { label: "Debt Load", value: latestSnapshot ? `-$${latestSnapshot.totalDebt.toLocaleString("en-US")}` : "—" },
                { label: "Portfolio Allocation", value: assetClassCount > 0 ? `${assetClassCount} asset class${assetClassCount === 1 ? "" : "es"}` : "—" },
                { label: "Crypto Exposure", value: cryptoPct !== null ? `${cryptoPct.toFixed(1)}% of portfolio` : "—" },
                { label: "30-day Snapshots", value: snapshotCount > 0 ? `${snapshotCount} data point${snapshotCount === 1 ? "" : "s"}` : "—" },
                { label: "Market Movement", value: "S&P, BTC, ETH" },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-xl p-3" style={{ background: "var(--surface-inset)" }}>
                  <p className="text-xs" style={{ color: "var(--text-secondary)" }}>{label}</p>
                  <p className="text-sm font-semibold mt-0.5" style={{ color: "var(--text-primary)" }}>{value}</p>
                </div>
              ))}
            </div>
          </DataCard>

          {/* Action readiness */}
          <DataCard>
            <DataCardTitle>Action Readiness</DataCardTitle>
            <div className="flex items-center gap-3 mt-3">
              {advice ? (
                <>
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center border" style={{
                    background: advice.actionReady ? "rgba(34,197,94,0.10)" : "rgba(237,82,71,0.10)",
                    borderColor: advice.actionReady ? "rgba(34,197,94,0.30)" : "rgba(237,82,71,0.30)",
                  }}>
                    <Zap size={22} style={{ color: advice.actionReady ? "var(--accent-positive)" : "var(--accent-negative)" }} fill="currentColor" />
                  </div>
                  <div>
                    <p className="text-lg font-bold" style={{ color: advice.actionReady ? "var(--accent-positive)" : "var(--accent-negative)" }}>
                      {advice.actionReady ? "Ready for Action" : "Hold / Not Ready"}
                    </p>
                    <p className="text-xs" style={{ color: "var(--text-secondary)" }}>{advice.summary}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 rounded-2xl border flex items-center justify-center" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                    <Zap size={22} style={{ color: "var(--text-muted)" }} fill="currentColor" />
                  </div>
                  <div>
                    <p className="text-lg font-bold" style={{ color: "var(--text-secondary)" }}>No advice yet</p>
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>The AI engine will run at the next scheduled interval</p>
                  </div>
                </>
              )}
            </div>
          </DataCard>
        </div>
      )}

      {/* AI Chat tab — the workspace surface itself, filling all remaining
          height. Full-bleed surface; the conversation + composer sit in a
          centered reading column inside it (ChatGPT/Claude pattern) so text
          stays readable while the surface uses the full Analyze content area. */}
      {tab === "chat" && (
        <DataCard padding="0" className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Assistant identity header */}
            <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b backdrop-blur-sm" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}>
              <div className="w-8 h-8 rounded-xl border flex items-center justify-center shrink-0" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                <Brain size={15} style={{ color: "var(--accent-info)" }} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-tight" style={{ color: "var(--text-primary)" }}>Fourth Meridian AI</p>
                <p className="flex items-center gap-1.5 text-xs leading-tight mt-0.5" style={{ color: "var(--text-muted)" }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--accent-positive)" }} />
                  Connected to your financial context
                </p>
              </div>
              {/* Context (Space) selector */}
              <div className="relative shrink-0">
                <select
                  value={selectedSpaceId}
                  onChange={(e) => setSelectedSpaceId(e.target.value)}
                  aria-label="Analysis context"
                  className="max-w-[10rem] appearance-none border rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium focus:outline-none focus:border-[var(--accent-info)] transition-colors truncate"
                  style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}
                >
                  <option value="master">All My Spaces</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <ChevronDown size={13} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text-muted)" }} />
              </div>
            </div>

            {/* Messages — the one primary conversation scroll container. */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5">
              <div className="max-w-3xl mx-auto w-full space-y-5">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" ? (
                    <>
                      {/* Avatar — pinned to the top of the message group */}
                      <div className="w-7 h-7 rounded-lg border flex items-center justify-center mr-2.5 mt-0.5 shrink-0" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                        <Brain size={13} style={{ color: "var(--accent-info)" }} />
                      </div>
                      {/* Message bubble + optional Knowledge Acquisition card */}
                      <div className="flex flex-col gap-2 max-w-[88%]">
                        <div className="border rounded-2xl rounded-tl-sm px-4 py-3 text-sm" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS as any}>
                            {m.content}
                          </ReactMarkdown>
                        </div>
                        {(() => {
                          if (!m.knowledgeGaps?.length) return null;

                          // Explicit update: user asked to update a field (mode === "form")
                          // or clicked "Update [field]" on a clarification card.
                          // Snooze must NOT suppress explicit update requests — it only
                          // hides automatic clarification cards for later passive prompts.
                          const isExplicitUpdate =
                            m.knowledgeGapMode === "form" || expandedGapIndices.has(i);

                          // Explicit form dismissed via "Not now" on THIS instance.
                          // Does not affect snoozedGapKeys, so the user can ask again
                          // and a new message's form will render without restriction.
                          if (isExplicitUpdate && dismissedFormIndices.has(i)) return null;

                          // When explicit, bypass snooze and show all gaps.
                          // When passive, filter out gaps the user already dismissed.
                          const visibleGaps = isExplicitUpdate
                            ? m.knowledgeGaps
                            : m.knowledgeGaps.filter((g) => !snoozedGapKeys.has(gapKey(g)));

                          if (visibleGaps.length === 0) return null;

                          if (isExplicitUpdate) {
                            return (
                              <KnowledgeAcquisitionCard
                                gaps={visibleGaps}
                                // Dismiss closes only this form instance.
                                // Does NOT snooze — explicit asks on future messages still show.
                                onDismiss={() => dismissFormAt(i)}
                                onSaved={() =>
                                  sendMessage(
                                    "I saved the missing information. Please recalculate with the updated context.",
                                  )
                                }
                              />
                            );
                          }

                          // Default: lightweight clarification prompt.
                          // "Not now" snoozes the gap for the rest of this chat session.
                          return (
                            <KnowledgeClarificationCard
                              gaps={visibleGaps}
                              onExpand={() => expandGapAt(i)}
                              onSnooze={() => snoozeGaps(visibleGaps.map(gapKey))}
                            />
                          );
                        })()}
                      </div>
                    </>
                  ) : (
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm whitespace-pre-wrap break-words" style={{ background: "var(--accent-info)" }}>
                      {m.content}
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="w-7 h-7 rounded-lg border flex items-center justify-center mr-2.5 shrink-0" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                    <Brain size={13} style={{ color: "var(--accent-info)" }} />
                  </div>
                  <div className="border rounded-2xl rounded-tl-sm px-4 py-3" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                    <div className="flex gap-1.5 items-center h-4">
                      <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: "0ms", background: "var(--text-muted)" }} />
                      <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: "150ms", background: "var(--text-muted)" }} />
                      <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: "300ms", background: "var(--text-muted)" }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
              </div>
            </div>

            {/* Suggested prompts — empty state */}
            {messages.length <= 1 && (
              <div className="shrink-0 px-4 pb-3">
                <div className="max-w-3xl mx-auto w-full">
                <p className="text-xs font-medium uppercase tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>Try asking</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button
                      key={p}
                      onClick={() => sendMessage(p)}
                      className="text-left text-sm border px-3.5 py-2.5 rounded-xl hover:bg-[var(--surface-hover)] transition-colors"
                      style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                </div>
              </div>
            )}

            {/* Composer — pinned to the bottom of the workspace. */}
            <div className="shrink-0 border-t p-3" style={{ borderColor: "var(--border-hairline)" }}>
              <div className="max-w-3xl mx-auto w-full">
              <div className="flex items-end gap-2 rounded-2xl border focus-within:border-[var(--accent-info)] transition-colors p-1.5 pl-3" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder="Ask about your finances…"
                  className="flex-1 resize-none max-h-40 bg-transparent py-2 text-sm placeholder:text-[var(--text-muted)] focus:outline-none leading-relaxed"
                  style={{ color: "var(--text-primary)" }}
                />
                {loading ? (
                  <button
                    onClick={stopGeneration}
                    className="w-9 h-9 rounded-xl hover:bg-[var(--surface-hover-strong)] flex items-center justify-center transition-colors shrink-0"
                    style={{ background: "var(--surface-inset)" }}
                    aria-label="Stop generation"
                  >
                    <X size={16} style={{ color: "var(--text-primary)" }} />
                  </button>
                ) : (
                  <button
                    onClick={() => sendMessage()}
                    disabled={!input.trim()}
                    aria-label="Send message"
                    className="w-9 h-9 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors shrink-0 text-white"
                    style={{ background: "var(--accent-info)" }}
                  >
                    <Send size={16} />
                  </button>
                )}
              </div>
              <p className="mt-1.5 px-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
                Enter to send · Shift+Enter for a new line
              </p>
              </div>
            </div>
          </DataCard>
      )}
    </div>
  );
}
