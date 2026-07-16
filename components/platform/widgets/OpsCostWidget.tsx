"use client";

/**
 * components/platform/widgets/OpsCostWidget.tsx  (OPS-5 S10 · ops_cost)
 *
 * Cost & Latency Intelligence, over GET /api/platform/platform-ops/cost
 * (requirePlatformAccess PLATFORM_OPS READ). Presentation-only: every metric,
 * value, provenance, and trust tier arrives precomputed from the cost authority —
 * the widget derives nothing. Unknown values render as "—" (never a fake 0).
 */

import { Gauge } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { CostResult } from "@/lib/platform/cost/types";

const TIER_TONE: Record<string, string> = {
  observed: "var(--accent-positive, #34d399)",
  derived: "var(--meridian-400, #7da8ff)",
  estimated: "var(--brass-300, #d9b25a)",
  incomplete: "var(--brass-300, #d9b25a)",
  unknown: "var(--text-muted)",
};

function fmt(value: number | null, unit: string): string {
  if (value == null) return "—";
  if (unit === "ms") return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
  return `${value}${unit === "count" ? "" : ` ${unit}`}`;
}

export function OpsCostWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<CostResult>("/api/platform/platform-ops/cost");

  return (
    <PlatformWidgetCard label={section.label} icon={Gauge}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <p className="text-[11px] text-[var(--text-muted)]">
            As of {data.asOf} · trust {data.trust} · derived from S7 history + S9 convergence
          </p>
          <ul className="flex flex-col gap-1 mt-1">
            {data.metrics.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 text-xs" title={m.provenance}>
                <span className="text-[var(--text-primary)] truncate">{m.label}</span>
                <span className="shrink-0 text-[var(--text-secondary)] tabular-nums">
                  {fmt(m.value, m.unit)}
                  <span style={{ color: TIER_TONE[m.tier] ?? "var(--text-muted)" }}> · {m.tier}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </PlatformWidgetCard>
  );
}
