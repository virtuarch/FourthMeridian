"use client";

/**
 * PerspectivesWidget
 *
 * Renders the Perspective cards described in the Spaces redesign spec:
 * "different lenses through which the same underlying data is viewed."
 * Pure presenter — reusable across every Space type and across both
 * dashboard implementations (Personal's DashboardClient and the generic
 * WorkspaceDashboard). The host decides which lenses are real for this
 * Space (via lib/perspectives.ts) and which internal tab each one routes
 * to; this component only knows how to lay cards out and call back.
 *
 * `variant="row"` is a compact horizontal strip for the Overview tab.
 * `variant="grid"` is the full Perspectives tab — same cards, more room.
 *
 * No Perspective business logic lives here by design (see project scope
 * for this pass) — clicking an "available" card just switches the host's
 * existing internal tab state to wherever that real feature already
 * lives; clicking a "comingSoon" card does nothing but show its copy.
 */

import {
  Gem, Waves, TrendingUp, CreditCard, PiggyBank, Target, FileText, Home,
  Briefcase, Compass, ArrowRight, Sparkles,
} from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { PerspectiveDef } from "@/lib/perspectives";

// Compass (the "overview"/Atlas lens) is included for completeness, even
// though in practice items passed here should already have "overview"
// filtered out — see lib/perspectives.ts's doc comment on that id never
// being rendered as a card. Keeping it mapped avoids a silent Sparkles
// fallback if a host ever forgets that filter.
const ICON_MAP: Record<string, React.ElementType> = {
  Gem, Waves, TrendingUp, CreditCard, PiggyBank, Target, FileText, Home, Briefcase, Compass,
};

export interface PerspectiveCardItem extends PerspectiveDef {
  /** Present only when this lens routes to a real, already-working tab. */
  onSelect?: () => void;
}

export function PerspectivesWidget({
  items,
  variant = "row",
}: {
  items: PerspectiveCardItem[];
  variant?: "row" | "grid";
}) {
  if (items.length === 0) return null;

  return (
    <div
      className={
        variant === "row"
          ? "flex gap-3 overflow-x-auto pb-1 -mb-1 [scrollbar-width:none]"
          : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
      }
    >
      {items.map((item) => (
        <PerspectiveCard key={item.id} item={item} compact={variant === "row"} />
      ))}
    </div>
  );
}

function PerspectiveCard({ item, compact }: { item: PerspectiveCardItem; compact: boolean }) {
  const Icon = ICON_MAP[item.icon] ?? Sparkles;
  const clickable = !!item.onSelect;

  return (
    <GlassPanel
      as={clickable ? "button" : "div"}
      type={clickable ? "button" : undefined}
      onClick={item.onSelect}
      interactive={clickable}
      depth="thin"
      elevation="e2"
      radius="lg"
      className={[
        "text-left shrink-0",
        compact ? "w-[210px] p-4" : "p-5",
        clickable ? "cursor-pointer hover:bg-[var(--surface-hover)]" : "opacity-80 cursor-default",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="w-9 h-9 rounded-[var(--radius-sm)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center shrink-0">
          <Icon size={16} className="text-[var(--meridian-400)]" />
        </div>
        {clickable ? (
          <ArrowRight size={14} className="text-[var(--text-muted)] mt-1.5" />
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-full px-2 py-1 mt-0.5">
            Soon
          </span>
        )}
      </div>
      <p className="text-sm font-semibold text-[var(--text-primary)] mt-3">{item.label}</p>
      <p className={`text-xs text-[var(--text-secondary)] mt-1 ${compact ? "line-clamp-2" : ""}`}>
        {item.description}
      </p>
    </GlassPanel>
  );
}
