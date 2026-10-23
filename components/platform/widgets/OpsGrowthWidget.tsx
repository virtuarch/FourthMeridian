"use client";

/**
 * components/platform/widgets/OpsGrowthWidget.tsx  (OPS-6F · GROWTH-1 · growth_funnel)
 *
 * The Growth funnel as the area's dominant operating surface, over
 * GET /api/platform/growth-revenue/growth (GROWTH_REVENUE READ).
 *
 * GROWTH-1 changes how this is READ, not what it claims. Before, the two funnels
 * were eight right-aligned rows an operator had to subtract in their head. Now
 * each canonical stage is a selectable row with its count, its authority-provided
 * conversion figure, and a bar proportional to its own funnel's first stage — so
 * where movement stops is visible rather than computed. Selecting a stage opens
 * an inspection panel over the same payload.
 *
 * PRESENTATION ONLY. Every count and ratio arrives precomputed from
 * `lib/platform/growth/growth.ts` (`buildGrowthFunnel`, whose `ratio()` returns
 * null on a zero denominator). This file and `growth-funnel-view.ts` decide order,
 * labels and layout — never a figure. No new route, no schema field, no direct
 * `BetaAccessRequest` query, no locally reconstructed rate.
 *
 * ── NAMED-ABSENT, ONCE ────────────────────────────────────────────────────────
 * Revenue, cohort history, trend and acquisition attribution are acknowledged in
 * a single closing line, because an operator arriving at a page called "Growth &
 * Revenue" needs to know the projection does not observe them. They appear as a
 * sentence — never as 0, never as an empty chart, never as a disabled tab
 * implying an authority exists behind it.
 *
 * ── SCOPE BOUNDARY ────────────────────────────────────────────────────────────
 * Selection is local component state, exactly as the shipped ledger surfaces do
 * (SourcesLedger, HoldingsLedger, LiabilitiesLedger). No URL state, no shared
 * panel controller, no panel-from-panel. Those are deliberately not this slice.
 */

import { useMemo, useState } from "react";
import { Filter } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import { FunnelStages } from "./FunnelStages";
import { GrowthStagePanel } from "./GrowthStagePanel";
import { buildFunnelViews, findStage } from "./growth-funnel-view";
import type { GrowthFunnel } from "@/lib/platform/growth/growth";

export function OpsGrowthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<GrowthFunnel>("/api/platform/growth-revenue/growth");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const views = useMemo(() => (data ? buildFunnelViews(data) : []), [data]);
  const selected = findStage(views, selectedId);

  return (
    <PlatformWidgetCard label={section.label} icon={Filter}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          {/* Side by side where there is room; stacked on a phone. Both funnel
              identities and their first stages therefore stay above the fold at
              desktop width without either funnel being scrolled to. */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-8">
            {views.map((view) => (
              <FunnelStages
                key={view.id}
                view={view}
                selectedId={selectedId}
                onSelect={(stage) => setSelectedId(stage.id)}
              />
            ))}
          </div>

          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
            Counts and conversion figures are read from{" "}
            <span className="font-mono text-[10px]">GrowthFunnel</span>; a stage the projection does not measure shows no
            figure, and a ratio with no denominator shows an em-dash rather than 0%.
          </p>

          {/* Named-absent — one line, subordinate to the funnel above it. */}
          <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
            Not observed by this projection: revenue, cohort history, movement over time, and acquisition attribution.
            No figure is shown for any of them.
          </p>
        </>
      )}

      <GrowthStagePanel views={views} stage={selected} onClose={() => setSelectedId(null)} />
    </PlatformWidgetCard>
  );
}
