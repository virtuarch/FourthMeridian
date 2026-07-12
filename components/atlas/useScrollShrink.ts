"use client";

/**
 * components/atlas/useScrollShrink.ts
 *
 * SHELL_NAV §2.5 — scroll-driven SHRINK for the floating nav pill. Returns a
 * scale factor (1 = full size) that FloatingNavWrapper applies as a CSS
 * transform. Behaviour, per the literal "shrinks as you scroll" ask:
 *
 *   - scroll DOWN past a small threshold → pill scales down modestly (NOT a
 *     full hide/disappear — the nav stays visible and usable),
 *   - scroll UP, or back near the top → pill returns to full size.
 *
 * Scroll container = the WINDOW. Verified for both surfaces (the rail tabs and
 * the Perspective shell): DashboardChrome is `flex min-h-screen` with no nested
 * overflow scroller in the main content column — its own headers pin via
 * `sticky top-0`, which only works against document scroll — so window.scrollY
 * is the right signal for both. (The one `overflow-y-auto` in the shell is the
 * Sidebar's internal nav, a separate column, not this content.)
 *
 * Motion accessibility: this hook only decides the scale NUMBER; the animated
 * tween lives in FloatingNavWrapper's CSS `transition: transform`. The global
 * `prefers-reduced-motion` rule in globals.css forces that transition to
 * ~0.01ms, so under reduced motion the size change is instantaneous rather than
 * animated — inherited for free, with no bespoke JS reduced-motion branch and
 * no animation loop (plan §2.5 / stop condition — motion must ride the global
 * CSS override).
 */

import { useEffect, useRef, useState } from "react";

/** Default scroll distance (px) below which the pill is always full size. */
export const SHRINK_THRESHOLD = 24;
/** Default shrunk scale — a modest reduction, never a hide. */
export const SHRINK_SCALE = 0.9;

/**
 * Pure shrink decision — extracted so it can be unit-tested against a scripted
 * sequence of scroll positions with no DOM (house test convention). Given the
 * current and previously-processed scrollY, the previous shrunk state, and the
 * near-top threshold, decide whether the pill should be shrunk now.
 */
export function computeShrink(
  scrollY: number,
  prevScrollY: number,
  prevShrunk: boolean,
  threshold: number,
): boolean {
  if (scrollY <= threshold) return false;   // near the top → always full size
  if (scrollY > prevScrollY) return true;    // scrolling down → shrink
  if (scrollY < prevScrollY) return false;   // scrolling up → return to full
  return prevShrunk;                          // no vertical movement → hold
}

interface UseScrollShrinkOptions {
  /** Near-top distance (px) that always renders full size. */
  threshold?: number;
  /** Scale applied while shrunk (1 = no shrink). */
  shrinkScale?: number;
  /** Set false to disable (pill stays full size) — e.g. an opt-out surface. */
  enabled?: boolean;
}

/**
 * Track window scroll and return the current pill scale (shrinkScale while
 * scrolling down past the threshold, 1 otherwise). rAF-throttled, passive
 * listener — no layout thrash, no animation loop.
 */
export function useScrollShrink({
  threshold = SHRINK_THRESHOLD,
  shrinkScale = SHRINK_SCALE,
  enabled = true,
}: UseScrollShrinkOptions = {}): number {
  const [shrunk, setShrunk] = useState(false);
  const prevY = useRef(0);
  const ticking = useRef(false);

  useEffect(() => {
    // When disabled we simply never attach the listener; the return value is
    // forced to 1 below regardless of `shrunk`, so no state reset is needed.
    if (!enabled) return;
    prevY.current = window.scrollY;
    const onScroll = () => {
      if (ticking.current) return;
      ticking.current = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        setShrunk((prev) => computeShrink(y, prevY.current, prev, threshold));
        prevY.current = y;
        ticking.current = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold, enabled]);

  return enabled && shrunk ? shrinkScale : 1;
}
