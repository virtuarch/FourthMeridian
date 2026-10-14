"use client";

/**
 * components/platform/widgets/OpsCostWidget.tsx  (OPS-5 S10 · ops_cost · UX-P1 grain)
 *
 * Cost & Latency Intelligence, over GET /api/platform/platform-ops/cost
 * (requirePlatformAccess PLATFORM_OPS READ). Presentation-only: every metric,
 * value, provenance, and trust tier arrives precomputed from the cost authority —
 * the widget derives nothing. Unknown values render through `Unavailable` with
 * the tier as the reason (never a fake 0); every dollar metric is labelled by
 * its tier, and the surface says there is no actual-charge ledger. UX-P1 moved
 * it from the card grain to the SectionSurface its Economics neighbours use;
 * the metric list, provenance and trust line are unchanged.
 */

import { Gauge } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { KeyRow, Provenance, SectionSurface, Unavailable } from "../platform-surface";
import type { CostResult } from "@/lib/platform/cost/types";
import { NO_LEDGER_NOTE } from "./overview/ai-economics-view";

function fmt(value: number | null, unit: string): string | null {
  if (value == null) return null;
  if (unit === "ms") return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
  if (unit === "usd") return `$${value.toFixed(2)} (estimate)`;
  return `${value}${unit === "count" ? "" : ` ${unit}`}`;
}

export function OpsCostWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<CostResult>("/api/platform/platform-ops/cost");
  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Gauge}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }
  return (
    <SectionSurface
      icon={Gauge}
      title={section.label}
      actions={<Provenance source="S7 history + S9 convergence">as of {data.asOf} · trust {data.trust}</Provenance>}
      footnote={`${NO_LEDGER_NOTE} Each metric carries its own provenance (the title on the row) and tier: observed, derived, estimated, incomplete or unknown.`}
    >
      <div className="flex flex-col gap-2">
        {data.metrics.map((m) => (
          <div key={m.id} title={m.provenance}>
            <KeyRow
              label={m.label}
              value={fmt(m.value, m.unit) === null
                ? <Unavailable reason={m.tier === "unknown" ? "not observed" : m.tier} />
                : <span className="tabular-nums">{fmt(m.value, m.unit)} <span className="text-[10px] text-[var(--text-faint)]">· {m.tier}</span></span>}
            />
          </div>
        ))}
      </div>
    </SectionSurface>
  );
}
