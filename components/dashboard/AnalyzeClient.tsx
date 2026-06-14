"use client";

import { useState, useRef, useEffect } from "react";
import { Card, CardTitle } from "@/components/ui/Card";
import { AdviceBanner } from "@/components/dashboard/AdviceBanner";
import { Brain, Send, Clock, Zap, BarChart2, MessageSquare } from "lucide-react";
import type { AiAdvice, Snapshot } from "@/types";

type Tab = "review" | "chat";

interface Message {
  role: "user" | "assistant";
  content: string;
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
  "What should I do with my cash?",
  "How is my debt situation?",
  "Review my crypto exposure",
  "Am I ready to make a play?",
  "What's my biggest risk right now?",
];

function getMockResponse(input: string, ficoScore: number | null): string {
  const lower = input.toLowerCase();
  const MOCK_RESPONSES: Record<string, string> = {
    debt: "Your total debt spans credit cards and other obligations. The highest-APR balances should be your top priority — pay those down aggressively before allocating to investments.",
    crypto: "Your crypto allocation is within a conservative 5-10% band. No immediate action needed, but avoid adding more until cash reserves are fully built up.",
    stocks: "Your stock portfolio has some tech concentration. Consider whether you want to rebalance toward more sectors for diversification.",
    "net worth": "Your net worth has grown steadily over the past 30 days. Keep building cash reserves and paying down high-interest debt to continue the trend.",
    "cash to play": "Your 'cash to play' is discretionary capital after reserving 3 months of estimated expenses. The AI recommends building reserves before deploying capital.",
    fico: ficoScore != null
      ? `Your FICO score is ${ficoScore}, which gives you access to favorable loan rates. Keep paying on time and keep utilization below 30%.`
      : "No FICO score on file yet. Add one in the Credit tab to get personalized credit advice.",
    default: "Based on your current portfolio snapshot, your net worth is trending upward. I'd recommend prioritizing liquidity before deploying new capital.",
  };

  for (const [key, val] of Object.entries(MOCK_RESPONSES)) {
    if (key !== "default" && lower.includes(key)) return val;
  }
  return MOCK_RESPONSES.default;
}

export function AnalyzeClient({ advice, ficoScore, latestSnapshot, snapshotCount, assetClassCount, cryptoPct, userName }: Props) {
  const [tab, setTab] = useState<Tab>("review");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        `Hi ${userName} — I'm your FinTracker AI advisor. I've been trained on your financial snapshot. Ask me anything about your portfolio, debt, cash position, or whether now is a good time to make a move.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function sendMessage(text?: string) {
    const msg = text ?? input.trim();
    if (!msg || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setLoading(true);
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: getMockResponse(msg, ficoScore) },
      ]);
      setLoading(false);
    }, 900);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
          <Brain size={18} className="text-blue-400" />
        </div>
        <h1 className="text-2xl font-bold text-white">Analyze with AI</h1>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 bg-gray-900 rounded-xl w-fit">
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

          {/* Play readiness */}
          <Card>
            <CardTitle>Play Readiness</CardTitle>
            <div className="flex items-center gap-3 mt-3">
              {advice ? (
                <>
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                    advice.playReady
                      ? "bg-green-500/10 border border-green-500/30"
                      : "bg-red-500/10 border border-red-500/30"
                  }`}>
                    <Zap size={22} className={advice.playReady ? "text-green-400" : "text-red-400"} fill="currentColor" />
                  </div>
                  <div>
                    <p className={`text-lg font-bold ${advice.playReady ? "text-green-400" : "text-red-400"}`}>
                      {advice.playReady ? "Ready to Play" : "No Play — Hold"}
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

      {/* AI Chat tab */}
      {tab === "chat" && (
        <div className="flex flex-col h-[calc(100vh-280px)] min-h-[400px]">
          <Card className="flex-1 flex flex-col overflow-hidden p-0">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                      <Brain size={13} className="text-blue-400" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-blue-600 text-white rounded-br-sm"
                        : "bg-gray-800 text-gray-200 rounded-bl-sm"
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mr-2 shrink-0">
                    <Brain size={13} className="text-blue-400" />
                  </div>
                  <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
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

            {/* Suggested prompts */}
            {messages.length <= 1 && (
              <div className="px-4 pb-2 flex gap-2 overflow-x-auto scrollbar-none">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => sendMessage(p)}
                    className="shrink-0 text-xs text-blue-400 border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 rounded-full hover:bg-blue-500/20 transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="border-t border-gray-700 p-3 flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                placeholder="Ask about your finances..."
                className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
                className="w-10 h-10 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
              >
                <Send size={16} className="text-white" />
              </button>
            </div>
          </Card>

          <p className="text-xs text-gray-600 text-center mt-2">
            Mock responses only — live LLM integration coming in Milestone 9.
          </p>
        </div>
      )}
    </div>
  );
}
