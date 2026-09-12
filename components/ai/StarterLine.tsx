"use client";

/**
 * components/ai/StarterLine.tsx  (AI Experience Convergence — AI-3)
 *
 * The empty-state heading above the centered composer. The line is chosen by the
 * host (per visit, server-side, so there is no hydration mismatch and no flicker).
 * After a long idle stretch it cross-fades to the next approved line; once `frozen`
 * (the composer was focused or typed into) it never changes again. Not a live
 * region — a swapping heading must not be announced. Presentation only.
 */

import { useEffect, useState } from "react";
import {
  STARTER_IDLE_SWAP_MS,
  STARTER_LINES,
  nextStarterIndex,
  normalizeStarterIndex,
} from "@/components/ai/conversation-surface";

const FADE_MS = 300;

export function StarterLine({ initialIndex, frozen }: { initialIndex: number; frozen: boolean }) {
  const [index, setIndex] = useState(() => normalizeStarterIndex(initialIndex));
  const [fadedOut, setFadedOut] = useState(false);

  useEffect(() => {
    if (frozen) return;
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
  }, [frozen]);

  return (
    <h2
      className="mb-6 text-center text-2xl sm:text-[28px] font-semibold tracking-tight text-balance text-[var(--text-primary)] transition-opacity duration-300"
      style={{ opacity: fadedOut && !frozen ? 0 : 1 }}
    >
      {STARTER_LINES[index]}
    </h2>
  );
}
