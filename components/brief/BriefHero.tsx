"use client";

/**
 * BriefHero
 *
 * Cinematic Daily Brief hero with Earth backdrop.
 *
 * Hierarchy (pinned to lower portion of hero):
 *   DAILY BRIEF · timestamp
 *   Good afternoon, Jane.
 *   You're up to date.
 *   Here's what changed since your last visit.
 *   [Continue to Dashboard]  [View AI Analysis]   ← primary CTAs live here
 *
 * CTAs are placed directly under the hero status line so users who
 * already know their intent don't need to scroll past the brief cards.
 * Not shown for new_user (they use BriefNewUser CTAs instead).
 */

import Link from "next/link";
import { LayoutDashboard, Brain, ArrowRight } from "lucide-react";
import { EarthBackground } from "./EarthBackground";
import type { VisitState } from "@/lib/brief-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month:   "short",
    day:     "numeric",
    year:    "numeric",
    hour:    "numeric",
    minute:  "2-digit",
  });
}

function greetVerb(state: VisitState): string {
  if (state === "new_user") return "Welcome to FinTracker";
  const h = new Date().getHours();
  if (h < 12) return "Good morning,";
  if (h < 17) return "Good afternoon,";
  return "Good evening,";
}

function extractFirstName(contextLine: string): string | null {
  const m = contextLine.match(/,\s+([A-Z][a-z]+)/);
  return m ? m[1] : null;
}

function statusLine(state: VisitState): string {
  switch (state) {
    case "new_user":   return "Let's build your financial picture.";
    case "immediate":  return "You're up to date.";
    case "short":      return "You're up to date.";
    case "day":        return "Here's your daily check-in.";
    case "away":       return "Welcome back.";
  }
}

function subLine(state: VisitState): string | null {
  if (state === "new_user" || state === "immediate") return null;
  return "Here's what happened since your last visit.";
}

// ── Hero CTAs ─────────────────────────────────────────────────────────────────
// Placed in the hero so the user never has to scroll to act.
// Intentionally lighter/smaller than a full CTA block — they live on the backdrop.

function HeroCTAs() {
  return (
    <div className="flex flex-col sm:flex-row gap-2.5 mt-7">
      {/* Primary */}
      <Link
        href="/dashboard"
        className="relative group inline-flex items-center justify-center gap-2 py-3 px-6 rounded-xl text-white text-sm font-semibold transition-all duration-200 hover:-translate-y-0.5 bg-blue-600 hover:bg-blue-500"
        style={{ boxShadow: "0 0 0 1px rgba(59,130,246,0.5), 0 4px 20px rgba(37,99,235,0.35)" }}
      >
        {/* Hover glow */}
        <span
          className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{ boxShadow: "0 0 24px 6px rgba(59,130,246,0.40)" }}
        />
        <LayoutDashboard className="w-4 h-4 relative z-10" />
        <span className="relative z-10">Continue to Dashboard</span>
        <ArrowRight className="w-3.5 h-3.5 relative z-10 transition-transform group-hover:translate-x-0.5" />
      </Link>

      {/* Secondary — glass over the earth */}
      <Link
        href="/dashboard/analyze"
        className="inline-flex items-center justify-center gap-2 py-3 px-6 rounded-xl text-gray-200 hover:text-white text-sm font-medium transition-all duration-200 hover:-translate-y-0.5"
        style={{
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          background: "rgba(8,14,28,0.45)",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
        }}
      >
        <Brain className="w-4 h-4" />
        View AI Analysis
      </Link>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface BriefHeroProps {
  visitState:  VisitState;
  contextLine: string;
  generatedAt: string;
}

export function BriefHero({ visitState, contextLine, generatedAt }: BriefHeroProps) {
  const firstName = extractFirstName(contextLine);
  const verb      = greetVerb(visitState);
  const isNewUser = visitState === "new_user";
  const status    = statusLine(visitState);
  const sub       = subLine(visitState);

  return (
    <div
      className="relative w-full"
      style={{ height: "clamp(420px, 58vh, 680px)" }}
    >
      {/* Earth — bleeds to all four edges */}
      <EarthBackground />

      {/* Hero text — pinned to the lower portion */}
      <div className="absolute inset-0 flex flex-col justify-end">
        <div className="px-6 md:px-10 xl:px-16 pb-10 md:pb-14 max-w-[1400px] mx-auto w-full">

          {/* DAILY BRIEF label + timestamp */}
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[10px] font-bold tracking-[0.22em] uppercase text-cyan-400/90">
              Daily Brief
            </span>
            <span className="w-px h-3 bg-white/20" />
            <span className="text-[10px] text-gray-400/70 tracking-wide">
              {formatTimestamp(generatedAt)}
            </span>
          </div>

          {/* Primary greeting */}
          {isNewUser ? (
            <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-none tracking-tight mb-4">
              <span className="text-white">Welcome to </span>
              <span className="text-amber-400">FinTracker</span>
            </h1>
          ) : (
            <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-none tracking-tight mb-4">
              <span className="text-white">{verb}</span>
              {firstName && (
                <>
                  {" "}
                  <span className="text-amber-400">{firstName}.</span>
                </>
              )}
              {!firstName && <span className="text-white">.</span>}
            </h1>
          )}

          {/* Status line */}
          <p className="text-2xl md:text-3xl font-medium text-white/90 mb-2 leading-snug">
            {status}
          </p>

          {/* Sub line */}
          {sub && (
            <p className="text-sm md:text-base text-gray-400 leading-relaxed">
              {sub}
            </p>
          )}

          {/* Hero CTAs — only for returning users */}
          {!isNewUser && <HeroCTAs />}
        </div>
      </div>
    </div>
  );
}
