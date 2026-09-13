"use client";

/**
 * components/ai/AiShell.tsx  (AI Experience Convergence — AI-1, conversation-first AI-3)
 *
 * The AI destination frame — a full-height single column with a quiet header and
 * two layouts driven by ONE input, `mode`:
 *
 *   empty         the composer is centered in the surface, with `lead` above it
 *                 (the starter line) and `aside` below it (suggestions);
 *   conversation  the conversation (`children`) is the one scroll container and the
 *                 composer is docked beneath it, behind a fade so text never collides.
 *
 * The composer occupies the SAME slot in the tree in both modes, so it is never
 * remounted: focus and the draft survive the switch. The move itself is a FLIP —
 * the composer's position is measured each commit, and when the mode flips it is
 * animated from where it was to where it now is (transform only, skipped under
 * prefers-reduced-motion). Presentation + layout only.
 *
 * AI-4 — HEIGHT IS CSS, NOT MEASUREMENT. The shell is exactly the viewport left
 * over by the chrome around it, so the document never scrolls and the one scroller
 * is the conversation. That is only expressible because DashboardChrome, on this
 * route, mounts nothing variable above the page (no 2FA nudge) and pads <main> by
 * the BottomNav's exact footprint. The former ResizeObserver fit is gone.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { AiMark } from "@/components/ai/AiMark";
import type { ConversationLayoutMode } from "@/components/ai/conversation-surface";

export interface AiShellProps {
  mode: ConversationLayoutMode;
  /** Compact controls at the right of the header (Space selector, new chat). */
  controls?: ReactNode;
  /** The conversation body (a ConversationView). Rendered only in conversation mode. */
  children: ReactNode;
  /** The composer — centered when empty, docked at the bottom in conversation. */
  composer: ReactNode;
  /** Empty mode only: shown above the composer. */
  lead?: ReactNode;
  /** Empty mode only: shown below the composer. */
  aside?: ReactNode;
  /** The Space this conversation belongs to, shown as plain text beside the title. */
  contextLabel?: string;
}

const MOVE_MS = 420;

export function AiShell({ mode, controls, children, composer, lead, aside, contextLabel }: AiShellProps) {
  const empty = mode === "empty";
  const composerRef = useRef<HTMLDivElement>(null);
  const lastTop = useRef<number | null>(null);
  const lastMode = useRef(mode);

  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const from = lastTop.current;
    if (lastMode.current !== mode && from !== null && typeof el.animate === "function") {
      const delta = from - top;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduced && Math.abs(delta) > 1) {
        el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
          { duration: MOVE_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
      }
    }
    lastMode.current = mode;
    lastTop.current = top;
  });

  // A resize between commits would leave the measured origin stale.
  useEffect(() => {
    const remeasure = () => {
      if (composerRef.current) lastTop.current = composerRef.current.getBoundingClientRect().top;
    };
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, []);

  return (
    // Height = the viewport minus the chrome around <main> on this route:
    //   above — GlobalHeader (h-12 + border-b = 49px) + main's pt-6 (24px) = 4.5625rem;
    //   below — mobile: the BottomNav footprint <main> pads by (3.5rem + 1px + safe
    //           area, the SAME expression as DashboardChrome); lg: main's pb-4 (1rem).
    // No min-height: a floor taller than a landscape phone's leftover viewport is
    // what made the document scroll and slid the composer under the bar; below it
    // the conversation (min-h-0) simply gets less room.
    <div
      data-ai-layout={mode}
      className="flex flex-col h-[calc(100dvh-4.5625rem-3.5rem-1px-env(safe-area-inset-bottom))] lg:h-[calc(100dvh-5.5625rem)]"
    >
      <header className="shrink-0 flex items-center gap-2.5 pb-3">
        <AiMark />
        <div className="min-w-0 flex-1 flex items-baseline gap-2">
          <h1 className="shrink-0 text-base font-semibold leading-tight text-[var(--text-primary)]">
            Fourth Meridian AI
          </h1>
          {contextLabel && (
            <p className="min-w-0 truncate text-xs text-[var(--text-muted)]">
              <span className="sr-only">Space: </span>
              {contextLabel}
            </p>
          )}
        </div>
        {controls && <div className="shrink-0 flex items-center gap-1.5">{controls}</div>}
      </header>

      {!empty && (
        <div data-ai-scroll className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {children}
        </div>
      )}

      <div
        data-ai-dock={mode}
        className={empty ? "flex-1 min-h-0 overflow-y-auto flex flex-col" : "shrink-0 relative pt-1"}
      >
        {!empty && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-8 h-8"
            style={{ background: "linear-gradient(to top, var(--bg-base), transparent)" }}
          />
        )}
        <div className={empty ? "my-auto w-full px-1 pt-6 pb-[10vh]" : "w-full"}>
          {empty && lead}
          <div ref={composerRef}>{composer}</div>
          {empty && aside}
        </div>
      </div>
    </div>
  );
}
