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
}

const MOVE_MS = 420;

export function AiShell({ mode, controls, children, composer, lead, aside }: AiShellProps) {
  const empty = mode === "empty";
  const shellRef = useRef<HTMLDivElement>(null);
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

  // Fit the shell to the viewport from where it ACTUALLY starts. The calc() classes
  // assume nothing sits above the page inside <main>; the chrome can render a nudge
  // there (TotpNudgeBanner), which would push a docked composer below the fold. So
  // measure the shell's document offset + the bottom padding it must leave, and
  // refit on resize or whenever the document's size changes (e.g. a banner closes).
  // Written straight to the element — layout, not React state. The classes remain
  // the server-render fallback.
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const parent = el.parentElement;
      const bottomPad = parent ? parseFloat(getComputedStyle(parent).paddingBottom) || 0 : 0;
      const marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const offset = Math.round(top + bottomPad + marginBottom);
      const next = `calc(100dvh - ${offset}px)`;
      if (el.style.height !== next) el.style.height = next;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(document.documentElement);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  // A resize between commits would leave the measured origin stale.
  useEffect(() => {
    const remeasure = () => {
      if (composerRef.current) lastTop.current = composerRef.current.getBoundingClientRect().top;
    };
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, []);

  return (
    // Fallback height (refined by the fit effect above) = viewport minus the dashboard
    // chrome around <main>: GlobalHeader (49px) +
    // main's pt-6 (24px) + its bottom padding — pb-24 on mobile (clears BottomNav and
    // the safe area), pb-16 on lg, of which the shell reclaims 48px so the docked
    // composer sits 16px off the bottom instead of floating 64px up.
    <div
      ref={shellRef}
      data-ai-layout={mode}
      className="flex flex-col h-[calc(100dvh-172px)] lg:h-[calc(100dvh-89px)] lg:-mb-12 min-h-[360px]"
    >
      <header className="shrink-0 flex items-center gap-2.5 pb-3">
        <AiMark />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold leading-tight text-[var(--text-primary)]">
          Fourth Meridian AI
        </h1>
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
