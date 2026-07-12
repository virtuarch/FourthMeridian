"use client";

/**
 * components/atlas/FloatingNavWrapper.tsx
 *
 * SHELL_NAV redesign (§2.4) — turns a plain in-flow tab track into a centered,
 * FLOATING glass pill: narrower than the content column, horizontally centered,
 * and pinned (position: sticky) beneath the app header so it stays reachable
 * while the page scrolls under it. The pill's glass/blur material is the wrapped
 * SegmentedControl's own — this wrapper adds ONLY positioning + centering, never
 * a second background, so the primitive stays a plain, reusable control (stop
 * condition #5: the floating/scroll behavior lives here, not in SegmentedControl).
 *
 * The scroll-driven SHRINK (useScrollShrink, S5) is consumed here: the pill
 * scales down modestly on scroll-down and returns to full size on scroll-up /
 * near the top. Disable per-surface with `shrinkOnScroll={false}`.
 *
 * Applied at exactly two call sites (the Space rail tabs and the Perspective tab
 * track). The other four SegmentedControl consumers keep their in-flow render and
 * never touch this wrapper.
 *
 * The scroll container under both surfaces is the WINDOW (the dashboard chrome
 * uses min-h-screen with no nested overflow scroller; its own headers are
 * `sticky top-0`), so `position: sticky` here pins against document scroll.
 *
 * Stacking: the app header is `sticky top-0 z-40` (h-14 = 56px). This pill sits
 * at z-30 (under the header) and pins at `top` px. When two pills coexist (the
 * rail + the Perspective track on the Perspectives tab), the lower one takes a
 * larger `top` so it pins just beneath the one above it rather than overlapping.
 */

import type { CSSProperties, ReactNode } from "react";
import { useScrollShrink } from "./useScrollShrink";

/** Height of the app header (DashboardChrome's `sticky top-0 z-40` h-14 bar). */
export const APP_HEADER_H = 56;

/** Approx pinned height of one SegmentedControl pill (p-1.5 track + py-2 text-xs
 *  button + hairline borders). Used only to stack the two coexisting pills. */
export const PILL_H = 46;

/** Rail-tab pill pins just below the app header. */
export const RAIL_PILL_TOP = APP_HEADER_H;

/** Perspective pill pins below the (always-present) pinned rail on the
 *  Perspectives tab, with a small gap so the two never touch. These offsets are
 *  the one bit of pixel math worth eyeballing at review — see STATUS.md. */
export const PERSPECTIVE_PILL_TOP = APP_HEADER_H + PILL_H + 6;

interface FloatingNavWrapperProps {
  children: ReactNode;
  /**
   * px offset from the viewport top where the pill pins. Sits below the app
   * header, and below any pill already pinned above it (see Stacking above).
   */
  top?: number;
  /** Set false to keep the pill full-size regardless of scroll (opt out of S5). */
  shrinkOnScroll?: boolean;
  /** Extra classes on the sticky centering row (e.g. bottom margin). */
  className?: string;
}

export function FloatingNavWrapper({
  children,
  top = 0,
  shrinkOnScroll = true,
  className = "",
}: FloatingNavWrapperProps) {
  // Scroll-driven scale (1 = full). The animated tween lives in the CSS
  // transition below, so it inherits the global prefers-reduced-motion override.
  const scale = useScrollShrink({ enabled: shrinkOnScroll });
  // The pill scales toward its TOP edge so it shrinks "upward" toward the header
  // rather than drifting away from it; the transform transition rides the global
  // CSS duration (near-zero under prefers-reduced-motion) — no JS animation loop.
  const pillStyle: CSSProperties = {
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: "top center",
    transition: "transform var(--dur-base) var(--ease-spring)",
    willChange: scale === 1 ? undefined : "transform",
  };

  return (
    <div
      className={["sticky z-30 flex justify-center", className].join(" ")}
      style={{ top }}
    >
      <div style={pillStyle}>{children}</div>
    </div>
  );
}
