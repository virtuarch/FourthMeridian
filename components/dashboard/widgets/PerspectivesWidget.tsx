"use client";

/**
 * PerspectivesWidget
 *
 * Renders the Perspective cards described in the Spaces redesign spec:
 * "different lenses through which the same underlying data is viewed."
 * Pure presenter — reusable across every Space type and across both
 * dashboard implementations (Personal's DashboardClient and the generic
 * SpaceDashboard). The host decides which lenses are real for this
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
 *
 * Perspective Engine (commit 6): a card may now carry an optional
 * `result` — a LensResult computed by lib/perspective-engine (hosts fetch
 * it from /api/spaces/[id]/perspectives and attach it by lensId; this
 * component stays a pure presenter and never fetches). Rendering rules:
 *
 *   result.status === "ok"    → verdict replaces the static description;
 *                               the headline metric renders as a value line
 *                               (tone via components/atlas/tones.ts,
 *                               "est." marker when estimated); an "As of"
 *                               line renders from provenance.dataAsOf.
 *   result.status === "empty" → the lens's own safe empty copy.
 *   result absent / "error"   → today's static description, unchanged —
 *                               a route failure degrades to exactly the
 *                               pre-engine card (rollback property from
 *                               the foundation investigation §7.4).
 *
 * Lens-backed cards (item.lensId set) NEVER show the "Soon" chip: a
 * computed answer — even "nothing to measure yet" — is not a promise.
 * Cards without a lensId keep the exact pre-existing behavior.
 */

import {
  Gem, Waves, TrendingUp, CreditCard, PiggyBank, Target, FileText, Home,
  Briefcase, Compass, Droplets, Sparkles,
} from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { TONE_VALUE } from "@/components/atlas/tones";
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { useDisplayCurrency } from "@/lib/currency-context";
import type { PerspectiveDef } from "@/lib/perspectives";
import type { LensMetric, LensResult } from "@/lib/perspective-engine/types";

// Compass (the "overview"/Atlas lens) is included for completeness, even
// though in practice items passed here should already have "overview"
// filtered out — see lib/perspectives.ts's doc comment on that id never
// being rendered as a card. Keeping it mapped avoids a silent Sparkles
// fallback if a host ever forgets that filter.
const ICON_MAP: Record<string, React.ElementType> = {
  Gem, Waves, TrendingUp, CreditCard, PiggyBank, Target, FileText, Home, Briefcase, Compass, Droplets,
};

export interface PerspectiveCardItem extends PerspectiveDef {
  /** Present only when this lens routes to a real, already-working tab. */
  onSelect?: () => void;
  /**
   * Present when the host fetched a Perspective Engine answer for this
   * card's lensId. Absent → static rendering, exactly as before.
   */
  result?: LensResult;
}

/** Render a LensMetric value per its declared format (shared lib/format).
 *  MC1 QA Q1 — currency metrics carry CONVERTED lens values (Phase 3 Slice 5),
 *  so the caller passes the display currency; USD default preserved for safety. */
function formatMetricValue(m: LensMetric, displayCurrency?: string): string {
  switch (m.format) {
    case "currency": return formatCurrency(Number(m.value), displayCurrency);
    case "percent":  return formatPercent(Number(m.value));
    case "date":     return formatDate(String(m.value));
    case "count":    return String(m.value);
    default:         return String(m.value);
  }
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
  // MC1 QA Q1 — lens currency values are converted (Phase 3 Slice 5); labels follow.
  const displayCurrency = useDisplayCurrency();
  const Icon = ICON_MAP[item.icon] ?? Sparkles;
  const clickable = !!item.onSelect;
  const lensBacked = !!item.lensId;

  // Engine answer, when the host attached one. "error" (and absence)
  // degrade to the static description; "empty" shows the lens's safe copy.
  const result  = item.result;
  const ok      = result?.status === "ok";
  const headline = ok ? result.headline : undefined;
  const bodyText = ok && result.verdict
    ? result.verdict
    : result?.status === "empty" && result.empty
      ? `${result.empty.headline}. ${result.empty.subline}`
      : item.description;
  const asOf = ok && result.provenance.dataAsOf ? formatDate(result.provenance.dataAsOf) : null;

  // A computed answer is never "Soon" — the chip is reserved for cards that
  // are neither clickable nor lens-backed (true placeholders).
  const showSoonChip = !clickable && !lensBacked;

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
        clickable
          ? "cursor-pointer hover:bg-[var(--surface-hover)]"
          : lensBacked
            ? "cursor-default" // an answered card is first-class, not dimmed
            : "opacity-80 cursor-default",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="w-9 h-9 rounded-[var(--radius-sm)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center shrink-0">
          <Icon size={16} className="text-[var(--meridian-400)]" />
        </div>
        {/* No arrow on clickable cards (cleaner) — the whole card is the
            affordance. Coming-soon placeholders keep their "Soon" chip. */}
        {showSoonChip ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-full px-2 py-1 mt-0.5">
            Soon
          </span>
        ) : null}
      </div>
      <p className="text-sm font-semibold text-[var(--text-primary)] mt-3">{item.label}</p>
      {headline && (
        <p className={`text-lg leading-tight mt-1 ${TONE_VALUE[headline.tone ?? "neutral"]}`}>
          {/* MC1 P4 Slice 3 (D-5): result-level currency estimation (LensResult.estimated)
              joins the pre-existing metric-level heuristic marker — one visual language. */}
          {item.result?.estimated ? "\u2248 " : ""}
          {formatMetricValue(headline, displayCurrency)}
          {(headline.estimated || item.result?.estimated) && (
            <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] align-middle">
              est.
            </span>
          )}
        </p>
      )}
      <p className={`text-xs text-[var(--text-secondary)] mt-1 ${compact ? "line-clamp-2" : ""}`}>
        {bodyText}
      </p>
      {asOf && (
        <p className="text-[10px] text-[var(--text-muted)] mt-1.5">As of {asOf}</p>
      )}
    </GlassPanel>
  );
}
