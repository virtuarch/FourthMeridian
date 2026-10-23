"use client";

/**
 * components/ai/StarterLine.tsx  (AI Experience Convergence — AI-3, AI-4)
 *
 * The empty-state heading above the centered composer. The line is chosen by the
 * host (per visit, server-side, so there is no hydration mismatch and no flicker).
 * After a long idle stretch it cross-fades to the next approved line; once `frozen`
 * (the composer was focused or typed into) it never changes again. A personal
 * `headline` (from the user's own memory) replaces the generic line and never
 * swaps — a reminder that rotated away would not be one. Not a live region — a
 * swapping heading must not be announced. Presentation only.
 */

import { useEffect, useState } from "react";
import {
  STARTER_IDLE_SWAP_MS,
  STARTER_LINES,
  nextStarterIndex,
  normalizeStarterIndex,
} from "@/components/ai/conversation-surface";

const FADE_MS = 300;

export function StarterLine({
  initialIndex,
  frozen,
  headline,
}: {
  initialIndex: number;
  frozen: boolean;
  /** A personal headline; when present it is shown instead of the generic line. */
  headline?: string | null;
}) {
  const [index, setIndex] = useState(() => normalizeStarterIndex(initialIndex));
  const [fadedOut, setFadedOut] = useState(false);
  const still = frozen || Boolean(headline);

  useEffect(() => {
    if (still) return;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const idle = setInterval(() => {
      setFadedOut(true);
      swap = setTimeout(() => {
        setIndex(nextStarterIndex);
        setFadedOut(false);
      }, FADE_MS);
    }, STARTER_IDLE_SWAP_MS);
    return () => {
      clearInterval(idle);
      clearTimeout(swap);
      setFadedOut(false);
    };
  }, [still]);

  return (
    <h2
      className="mb-6 text-center text-2xl sm:text-[28px] font-semibold tracking-tight text-balance text-[var(--text-primary)] transition-opacity duration-300"
      style={{ opacity: fadedOut && !still ? 0 : 1 }}
    >
      {headline || STARTER_LINES[index]}
    </h2>
  );
}
