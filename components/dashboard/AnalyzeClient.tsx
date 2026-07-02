"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardTitle } from "@/components/ui/Card";
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
const MD_COMPONENTS = {
  h1: ({ children }: { children: React.ReactNode }) => <p className="font-bold text-base text-white mt-4 first:mt-0 mb-2">{children}</p>,
  h2: ({ children }: { children: React.ReactNode }) => <p className="font-bold text-[15px] text-white mt-4 first:mt-0 mb-1.5">{children}</p>,
  h3: ({ children }: { children: React.ReactNode }) => <p className="font-semibold text-sm text-gray-100 mt-3 first:mt-0 mb-1">{children}</p>,
  p:  ({ children }: { children: React.ReactNode }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-white tabular-nums">{children}</strong>,
  em: ({ children }: { children: React.ReactNode }) => <em className="italic text-gray-300">{children}</em>,
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-gray-500">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-gray-500">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="text-gray-200 leading-relaxed pl-1">{children}</li>,
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-blue-500/50 pl-3 py-0.5 text-gray-400 italic mb-3">{children}</blockquote>
  ),
  // Fenced code blocks come through with a className like "language-js";
  // inline code has no className.
  code: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    className ? (
      <pre className="bg-gray-950 border border-gray-800 rounded-xl p-3 overflow-x-auto mb-3 text-xs text-green-300 font-mono leading-relaxed">
        <code>{children}</code>
      </pre>
    ) : (
      <code className="bg-gray-950 rounded px-1.5 py-0.5 text-[13px] text-blue-300 font-mono tabular-nums">{children}</code>
    ),
  pre: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  hr: () => <hr className="border-gray-700/70 my-3" />,
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="overflow-x-auto my-3 rounded-xl border border-gray-700/70">
      <table className="min-w-full text-[13px] border-collapse tabular-nums">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: React.ReactNode }) => <thead className="bg-gray-800/80">{children}</thead>,
  tbody: ({ children }: { children: React.ReactNode }) => <tbody className="divide-y divide-gray-700/50">{children}</tbody>,
  tr: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-3.5 py-2 text-left font-semibold text-gray-200 whitespace-nowrap border-b border-gray-700/70">{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-3.5 py-2 text-gray-300 align-top whitespace-nowrap">{children}</td>,
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
        <div className="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
          <Brain size={18} className="text-blue-400" />
        </div>
        <h1 className="text-2xl font-bold text-white">Analyze with AI</h1>
      </div>

      {/* Tab switcher */}
      <div className="shrink-0 flex gap-1 p-1 bg-gray-900 rounded-xl w-fit">
        <button
          onClick={() => setTab("review")}
          className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all touch-manipulation ${
            tab === "review" ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"
          }`}
        >
          <BarChart2 size={15} />
          ML Review
        </button>
        <button
          onClick={() => setTab("chat")}
          className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all touch-manipulation ${
            tab === "chat" ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"
          }`}
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
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Clock size={14} className="text-gray-400" />
              <CardTitle>Advice Schedule</CardTitle>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-800 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-1">Weekdays</p>
                <p className="text-sm font-semibold text-white">9:00 AM & 4:00 PM</p>
                <p className="text-xs text-gray-500">After market open + close</p>
              </div>
              <div className="bg-gray-800 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-1">Weekends</p>
                <p className="text-sm font-semibold text-white">9:00 AM</p>
                <p className="text-xs text-gray-500">Daily portfolio check-in</p>
              </div>
            </div>
          </Card>

          {/* What the engine reviews */}
          <Card>
            <CardTitle>What the Engine Reviews</CardTitle>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                { label: "Cash Position", value: latestSnapshot ? `$${latestSnapshot.totalCash.toLocaleString("en-US")}` : "—" },
                { label: "Debt Load", value: latestSnapshot ? `-$${latestSnapshot.totalDebt.toLocaleString("en-US")}` : "—" },
                { label: "Portfolio Allocation", value: assetClassCount > 0 ? `${assetClassCount} asset class${assetClassCount === 1 ? "" : "es"}` : "—" },
                { label: "Crypto Exposure", value: cryptoPct !== null ? `${cryptoPct.toFixed(1)}% of portfolio` : "—" },
                { label: "30-day Snapshots", value: snapshotCount > 0 ? `${snapshotCount} data point${snapshotCount === 1 ? "" : "s"}` : "—" },
                { label: "Market Movement", value: "S&P, BTC, ETH" },
              ].map(({ label, value }) => (
                <div key={label} className="bg-gray-800 rounded-xl p-3">
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className="text-sm font-semibold text-white mt-0.5">{value}</p>
                </div>
              ))}
            </div>
          </Card>

          {/* Action readiness */}
          <Card>
            <CardTitle>Action Readiness</CardTitle>
            <div className="flex items-center gap-3 mt-3">
              {advice ? (
                <>
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                    advice.actionReady
                      ? "bg-green-500/10 border border-green-500/30"
                      : "bg-red-500/10 border border-red-500/30"
                  }`}>
                    <Zap size={22} className={advice.actionReady ? "text-green-400" : "text-red-400"} fill="currentColor" />
                  </div>
                  <div>
                    <p className={`text-lg font-bold ${advice.actionReady ? "text-green-400" : "text-red-400"}`}>
                      {advice.actionReady ? "Ready for Action" : "Hold / Not Ready"}
                    </p>
                    <p className="text-xs text-gray-400">{advice.summary}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 rounded-2xl bg-gray-700/50 border border-gray-600/30 flex items-center justify-center">
                    <Zap size={22} className="text-gray-500" fill="currentColor" />
                  </div>
                  <div>
                    <p className="text-lg font-bold text-gray-400">No advice yet</p>
                    <p className="text-xs text-gray-500">The AI engine will run at the next scheduled interval</p>
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* AI Chat tab — the workspace surface itself, filling all remaining
          height. Full-bleed surface; the conversation + composer sit in a
          centered reading column inside it (ChatGPT/Claude pattern) so text
          stays readable while the surface uses the full Analyze content area. */}
      {tab === "chat" && (
        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden p-0">
            {/* Assistant identity header */}
            <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/60 backdrop-blur-sm">
              <div className="w-8 h-8 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
                <Brain size={15} className="text-blue-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white leading-tight">Fourth Meridian AI</p>
                <p className="flex items-center gap-1.5 text-xs text-gray-500 leading-tight mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                  Connected to your financial context
                </p>
              </div>
              {/* Context (Space) selector */}
              <div className="relative shrink-0">
                <select
                  value={selectedSpaceId}
                  onChange={(e) => setSelectedSpaceId(e.target.value)}
                  aria-label="Analysis context"
                  className="max-w-[10rem] appearance-none bg-gray-800/80 border border-gray-700 rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-gray-200 focus:outline-none focus:border-blue-500 transition-colors truncate"
                >
                  <option value="master">All My Spaces</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <ChevronDown size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
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
                      <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mr-2.5 mt-0.5 shrink-0">
                        <Brain size={13} className="text-blue-400" />
                      </div>
                      {/* Message bubble + optional Knowledge Acquisition card */}
                      <div className="flex flex-col gap-2 max-w-[88%]">
                        <div className="bg-gray-800/80 border border-gray-700/50 text-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm">
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
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed bg-blue-600 text-white shadow-sm whitespace-pre-wrap break-words">
                      {m.content}
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mr-2.5 shrink-0">
                    <Brain size={13} className="text-blue-400" />
                  </div>
                  <div className="bg-gray-800/80 border border-gray-700/50 rounded-2xl rounded-tl-sm px-4 py-3">
                    <div className="flex gap-1.5 items-center h-4">
                      <span className="w-2 h-2 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "300ms" }} />
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
                <p className="text-xs font-medium uppercase tracking-widest text-gray-500 mb-2">Try asking</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button
                      key={p}
                      onClick={() => sendMessage(p)}
                      className="text-left text-sm text-gray-200 border border-gray-700/70 bg-gray-800/50 px-3.5 py-2.5 rounded-xl hover:bg-gray-800 hover:border-blue-500/40 transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>
                </div>
              </div>
            )}

            {/* Composer — pinned to the bottom of the workspace. */}
            <div className="shrink-0 border-t border-gray-800 p-3">
              <div className="max-w-3xl mx-auto w-full">
              <div className="flex items-end gap-2 rounded-2xl border border-gray-700 bg-gray-800/80 focus-within:border-blue-500 transition-colors p-1.5 pl-3">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder="Ask about your finances…"
                  className="flex-1 resize-none max-h-40 bg-transparent py-2 text-sm text-white placeholder-gray-500 focus:outline-none leading-relaxed"
                />
                {loading ? (
                  <button
                    onClick={stopGeneration}
                    className="w-9 h-9 rounded-xl bg-gray-700 hover:bg-gray-600 flex items-center justify-center transition-colors shrink-0"
                    aria-label="Stop generation"
                  >
                    <X size={16} className="text-white" />
                  </button>
                ) : (
                  <button
                    onClick={() => sendMessage()}
                    disabled={!input.trim()}
                    aria-label="Send message"
                    className="w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors shrink-0"
                  >
                    <Send size={16} className="text-white" />
                  </button>
                )}
              </div>
              <p className="mt-1.5 px-1 text-[11px] text-gray-600">
                Enter to send · Shift+Enter for a new line
              </p>
              </div>
            </div>
          </Card>
      )}
    </div>
  );
}
