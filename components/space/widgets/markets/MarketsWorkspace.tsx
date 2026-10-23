"use client";

/**
 * components/space/widgets/markets/MarketsWorkspace.tsx
 *
 * MARKETS (skeleton) — the third customer workspace: "How are my investments and
 * potential investments behaving, and what should I understand about them?"
 * Read through five views (lib/markets/markets-mode): Portfolio · Research ·
 * Fundamentals · Technicals · Watchlist.
 *
 * THIS IS A SHELL. It owns the view selector and one honest empty state per
 * view — nothing is fetched, computed, stored or invented: no quotes, no
 * holdings, no charts, no tickers. The views mark where future work belongs:
 *   portfolio     — owned positions: performance, allocation, attribution, risk
 *   research      — security / company discovery and deep dives
 *   fundamentals  — statements, earnings, margins, valuation
 *   technicals    — price action, trends, momentum, indicators
 *   watchlist     — securities followed regardless of ownership
 * Net Worth → Assets still VALUES investment holdings as wealth; nothing moved.
 *
 * The view selector is the Net Worth pattern exactly: the SAME `mode` state the
 * sidebar's nested children drive (host-owned, URL-backed ?view=), shown below
 * lg only when the host's desktop sidebar carries those children
 * (`modeSelectorVisibility="belowLg"`). Five chips hold ONE scrollable line on a
 * phone (Chips `wrap={false}` + safe centring) instead of wrapping to two rows.
 */

import { useEffect } from "react";
import { Chips } from "@/components/atlas/Chips";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { MARKETS_MODES, MARKETS_MODE_LABELS, type MarketsMode } from "@/lib/markets/markets-mode";

/** One line per view — where it belongs, never that it works. */
export const MARKETS_EMPTY_COPY: Record<MarketsMode, string> = {
  portfolio:    "Analysis of the securities you own will live here.",
  research:     "Research into securities and companies will live here.",
  fundamentals: "Analysis of company financials will live here.",
  technicals:   "Analysis of price behaviour will live here.",
  watchlist:    "Securities you follow will live here.",
};

export function MarketsWorkspace({
  mode,
  onModeChange,
  modeSelectorVisibility = "always",
  onEnvelopeChange,
}: {
  /** The Markets view — URL-synced by the host (?view=). */
  mode: MarketsMode;
  onModeChange: (m: MarketsMode) => void;
  /** Where the view selector is SHOWN — see WealthWorkspace's identical prop. */
  modeSelectorVisibility?: "always" | "belowLg";
  onEnvelopeChange?: (env: PerspectiveEnvelope) => void;
}) {
  // A workspace-backed lens owns the shell's trust slot. Markets makes no claim
  // yet, so it publishes the EMPTY envelope — never leaving the previous
  // workspace's completeness/evidence on screen above an empty page.
  useEffect(() => {
    onEnvelopeChange?.({});
  }, [onEnvelopeChange]);

  return (
    <div className="space-y-6 min-w-0">
      <div
        data-markets-mode-row
        className={["px-1", modeSelectorVisibility === "belowLg" ? "lg:hidden" : ""].join(" ").trim()}
      >
        <Chips
          options={MARKETS_MODES.map((m) => ({ id: m, label: MARKETS_MODE_LABELS[m] }))}
          value={mode}
          onChange={onModeChange}
          ariaLabel="Markets view"
          wrap={false}
          className="justify-center-safe"
        />
      </div>

      <div className="py-12 text-center">
        <h2 className="text-sm text-[var(--text-muted)]">{MARKETS_MODE_LABELS[mode]}</h2>
        <p className="mt-1 text-xs text-[var(--text-faint)]">{MARKETS_EMPTY_COPY[mode]}</p>
      </div>
    </div>
  );
}
