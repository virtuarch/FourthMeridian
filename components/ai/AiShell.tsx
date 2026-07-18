"use client";

/**
 * components/ai/AiShell.tsx  (AI Experience Convergence — AI-1)
 *
 * The AI destination frame — a full-height single column that reads as an always-
 * available surface, not a card on a page. A quiet header (the AI mark + identity +
 * an optional context control), the scrolling conversation body (`children`), and a
 * pinned composer at the bottom. Presentation + layout only; the host supplies the
 * conversation and the composer.
 */

import type { ReactNode } from "react";
import { AiMark } from "@/components/ai/AiMark";

export interface AiShellProps {
  /** The Space/scope control shown at the right of the header. */
  contextControl?: ReactNode;
  /** The conversation body (a ConversationView). */
  children: ReactNode;
  /** The composer, pinned to the bottom. */
  composer: ReactNode;
}

export function AiShell({ contextControl, children, composer }: AiShellProps) {
  return (
    <div className="flex flex-col h-[calc(100dvh-172px)] lg:h-[calc(100dvh-108px)] min-h-[420px]">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 pb-4">
        <AiMark />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
            Fourth Meridian AI
          </h1>
          <p className="text-xs leading-tight mt-0.5" style={{ color: "var(--text-muted)" }}>
            Grounded in your financial context.
          </p>
        </div>
        {contextControl && <div className="shrink-0">{contextControl}</div>}
      </div>

      {/* Conversation — the one primary scroll container */}
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>

      {/* Composer — pinned to the bottom of the surface */}
      <div className="shrink-0 border-t pt-3 mt-2" style={{ borderColor: "var(--border-hairline)" }}>
        {composer}
      </div>
    </div>
  );
}
