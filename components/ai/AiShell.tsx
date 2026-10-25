"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AiMark } from "@/components/ai/AiMark";
import type { ConversationLayoutMode } from "@/components/ai/conversation-surface";

export interface AiShellProps {
  mode: ConversationLayoutMode;
  controls?: ReactNode;
  children: ReactNode;
  composer: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  contextLabel?: string;
}

/** Three fixed regions: header, a flexible reading area, and the composer.
 * Keep the composer mounted in one slot so submitting preserves focus and draft.
 * The shell reserves the same navigation footprint as DashboardChrome.
 */
export function AiShell({ mode, controls, children, composer, lead, aside, contextLabel }: AiShellProps) {
  const empty = mode === "empty";
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // Mobile keyboards can shrink the visual viewport without changing dvh.
    const resize = () => {
      shellRef.current?.style.setProperty("--ai-viewport-height", `${viewport.height}px`);
    };
    resize();
    viewport.addEventListener("resize", resize);
    return () => viewport.removeEventListener("resize", resize);
  }, []);

  return (
    <div
      ref={shellRef}
      data-ai-layout={mode}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden h-[calc(var(--ai-viewport-height,100dvh)-4.5625rem-3.5rem-1px-env(safe-area-inset-bottom)-var(--fm-notice-rail-h,0px))] lg:h-[calc(var(--ai-viewport-height,100dvh)-5.5625rem-var(--fm-notice-rail-h,0px))]"
    >
      <header className="shrink-0 flex items-center gap-2.5 pb-3">
        <AiMark />
        <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-2">
          <h1 className="text-base font-semibold leading-tight text-[var(--text-primary)]">
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

      <div data-ai-scroll className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {empty ? (
          <div className="flex min-h-full flex-col justify-center max-w-3xl mx-auto w-full px-1 py-4">
            {lead}
            {aside}
          </div>
        ) : children}
      </div>

      <div data-ai-dock={mode} className="shrink-0 relative pt-1">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-8 h-8"
          style={{ background: "linear-gradient(to top, var(--bg-base), transparent)" }}
        />
        {composer}
      </div>
    </div>
  );
}
