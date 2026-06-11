"use client";
import { useState } from "react";
import { AiAdvice } from "@/types";
import {
  AlertTriangle, CheckCircle, ChevronRight, X, Brain,
  TrendingUp, TrendingDown, Shield, Zap,
} from "lucide-react";

interface Props {
  advice: AiAdvice;
}

// ── Parse helpers ─────────────────────────────────────────────────────────────
function extractActions(text: string): string[] {
  return text.split("\n")
    .filter((l) => l.match(/^\s*\d+\.\s+/))
    .map((l) => l.replace(/^\s*\d+\.\s+/, "").replace(/\*\*/g, "").trim())
    .slice(0, 6);
}

function extractSection(text: string, header: string): string {
  const idx = text.indexOf(header);
  if (idx === -1) return "";
  const after = text.slice(idx);
  const m = after.match(/\*\*[^*]+\*\*[:\s]*(.*)/);
  if (!m) return "";
  const firstLine = m[1].trim();
  if (firstLine) return firstLine;
  const lines = after.split("\n").slice(1);
  for (const l of lines) { const c = l.replace(/\*\*/g, "").trim(); if (c) return c; }
  return "";
}

function extractRiskFlag(text: string): string {
  const m = text.match(/\*\*Risk Flags?:\*\*[:\s]*(.+)/);
  return m ? m[1].replace(/\*\*/g, "").trim() : "";
}

// ── Style maps ────────────────────────────────────────────────────────────────
const RISK_CONFIG = {
  low:    { bar: "bg-emerald-500", badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", dot: "bg-emerald-400", label: "Low",    icon: CheckCircle,    iconCls: "text-emerald-400" },
  medium: { bar: "bg-yellow-500",  badge: "bg-yellow-500/15  text-yellow-400  border-yellow-500/30",  dot: "bg-yellow-400",  label: "Medium", icon: AlertTriangle,   iconCls: "text-yellow-400"  },
  high:   { bar: "bg-red-500",     badge: "bg-red-500/15     text-red-400     border-red-500/30",     dot: "bg-red-400",     label: "High",   icon: AlertTriangle,   iconCls: "text-red-400"     },
};

// ── Full analysis modal ───────────────────────────────────────────────────────
function AnalysisModal({ advice, onClose }: { advice: AiAdvice; onClose: () => void }) {
  const risk    = RISK_CONFIG[advice.riskLevel];
  const actions = extractActions(advice.adviceText);
  const context = extractSection(advice.adviceText, "**Market Context");
  const riskFlag = extractRiskFlag(advice.adviceText);

  const dateStr = new Date(advice.generatedAt).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-gray-950/95 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex flex-col h-full max-w-lg mx-auto w-full sm:max-w-none">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 pt-5 pb-3 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-gray-400" />
            <span className="text-sm font-bold tracking-wide text-white">FinTracker Intelligence</span>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors touch-manipulation"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* Masthead strip */}
          <div className={`h-0.5 w-full ${risk.bar}`} />
          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-900/60 border-b border-gray-800/60">
            <span className="text-[11px] text-gray-500" suppressHydrationWarning>{dateStr}</span>
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${risk.badge}`}>
                {risk.label} Risk
              </span>
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${advice.playReady ? "bg-emerald-400" : "bg-red-400"} animate-pulse`} />
                <span className={`text-[11px] font-semibold ${advice.playReady ? "text-emerald-400" : "text-red-400"}`}>
                  {advice.playReady ? "Play Ready" : "Not Ready"}
                </span>
              </div>
            </div>
          </div>

          {/* Summary */}
          <div className="px-4 py-4 border-b border-gray-800/60">
            <div className="flex items-start gap-2.5">
              <div className={`mt-0.5 shrink-0 ${advice.playReady ? "text-emerald-400" : "text-yellow-400"}`}>
                {advice.playReady ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
              </div>
              <p className="text-[15px] font-semibold text-white leading-snug">{advice.summary}</p>
            </div>
          </div>

          {/* Highlights */}
          {(context || riskFlag) && (
            <div className="px-4 py-4 grid grid-cols-1 gap-3 border-b border-gray-800/60">
              {context && (
                <div className="rounded-xl bg-gray-800/60 border border-gray-700/40 px-3.5 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">Market Context</p>
                  <p className="text-xs text-gray-300 leading-relaxed">{context}</p>
                </div>
              )}
              {riskFlag && (
                <div className="rounded-xl bg-gray-800/60 border border-gray-700/40 px-3.5 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">Risk Summary</p>
                  <p className="text-xs text-gray-300 leading-relaxed">{riskFlag}</p>
                </div>
              )}
            </div>
          )}

          {/* Action items */}
          {actions.length > 0 && (
            <div className="px-4 py-4 border-b border-gray-800/60">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-3">Recommended Actions</p>
              <div className="space-y-3">
                {actions.map((action, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-[10px] font-bold text-gray-400 mt-0.5">
                      {i + 1}
                    </span>
                    <p className="text-sm text-gray-300 leading-snug pt-0.5">{action}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Full raw analysis */}
          <div className="px-4 py-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-3">Full Analysis</p>
            <div className="space-y-0.5">
              {advice.adviceText.split("\n").map((line, i) => {
                if (!line.trim()) return <div key={i} className="h-2" />;
                if (line.match(/^\*\*[A-Z]/)) {
                  return (
                    <p key={i} className="text-xs font-bold text-white mt-3 mb-1"
                       dangerouslySetInnerHTML={{ __html: line.replace(/\*\*(.*?)\*\*/g, "$1") }}
                    />
                  );
                }
                return (
                  <p key={i} className="text-xs text-gray-400 leading-relaxed"
                     dangerouslySetInnerHTML={{ __html: line.replace(/\*\*(.*?)\*\*/g, "<strong class='text-gray-200'>$1</strong>") }}
                  />
                );
              })}
            </div>
          </div>

          {/* Bottom padding for safe area */}
          <div className="h-6" />
        </div>
      </div>
    </div>
  );
}

// ── Banner ────────────────────────────────────────────────────────────────────
export function AdviceBanner({ advice }: Props) {
  const [open, setOpen] = useState(false);
  const risk = RISK_CONFIG[advice.riskLevel];
  const Icon = risk.icon;

  const dateStr = new Date(advice.generatedAt).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left px-4 py-3 rounded-2xl border border-gray-700/60 bg-gray-900/80 hover:bg-gray-800/80 active:bg-gray-800 transition-colors touch-manipulation"
      >
        {/* Row 1 — label · badge · date · chevron */}
        <div className="flex items-center gap-2 mb-1.5">
          <Icon size={13} className={`shrink-0 ${risk.iconCls}`} />
          <span className="text-[11px] font-bold tracking-widest text-gray-400 uppercase">AI Advice</span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${risk.badge}`}>
            {risk.label} Risk
          </span>
          <span className="text-[11px] text-gray-600 ml-auto shrink-0" suppressHydrationWarning>{dateStr}</span>
          <ChevronRight size={13} className="text-gray-600 shrink-0" />
        </div>

        {/* Row 2 — full summary, wraps on mobile, no ellipsis */}
        <p className="text-sm text-gray-200 leading-snug">{advice.summary}</p>
      </button>

      {open && <AnalysisModal advice={advice} onClose={() => setOpen(false)} />}
    </>
  );
}
