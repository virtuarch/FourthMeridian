/**
 * lib/platform/cost/cost.ts  (OPS-5 S10)
 *
 * THE single cost/latency authority: `getCostIntelligence`. It consumes ONLY S7
 * Operational History and S9 Convergence — no direct execution/ledger reads, no
 * bespoke collectors, no background workers. Every metric is a PURE reduction over
 * those two upstream authorities, stamped with its provenance and honest trust
 * (a value the upstream marks unknown stays unknown; a projection is estimated).
 *
 * PURE CORE + INJECTED UPSTREAM: `deriveCostMetrics` is a pure function of the two
 * upstream results; the authority just fetches them (injectable in tests).
 */

import "server-only";
import { getOperationalHistory } from "@/lib/platform/history/history";
import { getConvergence } from "@/lib/platform/convergence/convergence";
import { worstTier } from "@/lib/platform/history/sources";
import type { OperationalHistoryResult, OperationalTier } from "@/lib/platform/history/types";
import type { ConvergenceResult } from "@/lib/platform/convergence/types";
import type { CostMetric, CostResult } from "@/lib/platform/cost/types";

const MS_PER_DAY = 86_400_000;

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function windowDays(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY));
}

// ── Pure derivation over S7 + S9 ────────────────────────────────────────────────

export function deriveCostMetrics(hist: OperationalHistoryResult, conv: ConvergenceResult): CostMetric[] {
  const metrics: CostMetric[] = [];

  // Latency (from S7's JobRun latency series — observed durations → derived stats).
  const latency = hist.series.find((s) => s.metric === "latency");
  const durations = (latency?.points ?? []).map((p) => p.value).filter((v): v is number => v != null);
  const avg = mean(durations);
  metrics.push({
    id: "avg-runtime", label: "Average runtime", value: avg != null ? Math.round(avg) : null, unit: "ms",
    tier: durations.length ? "derived" : "unknown",
    provenance: "S7 latency series (JobRun.durationMs) · mean",
  });

  // Latency drift: recent-half mean vs earlier-half mean (chronological points).
  if (durations.length >= 4) {
    const half = Math.floor(durations.length / 2);
    const earlier = mean(durations.slice(0, half))!;
    const recent = mean(durations.slice(half))!;
    metrics.push({
      id: "latency-drift", label: "Latency drift", value: Math.round(recent - earlier), unit: "ms",
      tier: "derived", provenance: "S7 latency series · recent-half minus earlier-half mean",
      detail: recent > earlier ? "runtimes trending up" : "runtimes trending down/flat",
    });
  } else {
    metrics.push({ id: "latency-drift", label: "Latency drift", value: null, unit: "ms", tier: "unknown", provenance: "S7 latency series · insufficient points for a trend" });
  }

  // Operational load: total runtime spent over the window (derived), and a projected
  // daily load (ESTIMATED — a projection, honestly tiered).
  const totalRuntime = durations.reduce((a, b) => a + b, 0);
  metrics.push({
    id: "runtime-load", label: "Runtime load", value: durations.length ? totalRuntime : null, unit: "ms",
    tier: durations.length ? "derived" : "unknown", provenance: "S7 latency series · sum over window",
  });
  const days = windowDays(hist.window.from, hist.window.to);
  metrics.push({
    id: "projected-daily-load", label: "Projected daily load", value: durations.length ? Math.round(totalRuntime / days) : null, unit: "ms",
    tier: durations.length ? "estimated" : "unknown",
    provenance: `S7 runtime load ÷ ${days}-day window · projection (estimated, not a measured future)`,
  });

  // Failure & retry cost (from S9 episodes — observed events → derived counts).
  let failureEvents = 0, retryEvents = 0;
  for (const ep of conv.episodes) {
    for (const e of ep.events) {
      if (e.outcome === "failure" || e.outcome === "degraded") failureEvents++;
      if (e.kind === "manual-run") retryEvents++;
    }
  }
  metrics.push({
    id: "failure-cost", label: "Failure events", value: conv.episodes.length ? failureEvents : null, unit: "count",
    tier: conv.episodes.length ? "derived" : "unknown", provenance: "S9 convergence episodes · failure/degraded event count",
  });
  metrics.push({
    id: "retry-cost", label: "Retry (manual) runs", value: conv.episodes.length ? retryEvents : null, unit: "count",
    tier: conv.episodes.length ? "derived" : "unknown", provenance: "S9 convergence episodes · manual-run event count",
  });
  metrics.push({
    id: "incident-count", label: "Incidents", value: conv.episodes.length, unit: "count",
    tier: "derived", provenance: "S9 convergence · correlated episode count",
  });

  // Dollar spend: HONESTLY UNKNOWN — no unit pricing is configured (UNIT_PRICES_USD
  // ships empty). Never a fabricated figure.
  metrics.push({
    id: "spend-usd", label: "Estimated spend", value: null, unit: "usd", tier: "unknown",
    provenance: "no unit pricing configured (lib/usage/pricing UNIT_PRICES_USD empty) — unknown, not zero",
  });

  return metrics;
}

// ── The authority ─────────────────────────────────────────────────────────────────

export interface CostArgs { asOf?: string; compareTo?: string | null; }
export interface CostDeps {
  now?: Date;
  history?: (args: { asOf?: string; compareTo?: string | null }) => Promise<OperationalHistoryResult>;
  convergence?: (args: { asOf?: string; from?: string }) => Promise<ConvergenceResult>;
}

export async function getCostIntelligence(args: CostArgs = {}, deps: CostDeps = {}): Promise<CostResult> {
  const now = deps.now ?? new Date();
  const history = deps.history ?? ((a) => getOperationalHistory(a));
  const convergence = deps.convergence ?? ((a) => getConvergence(a));

  const hist = await history({ asOf: args.asOf, compareTo: args.compareTo });
  const conv = await convergence({ asOf: hist.window.to, from: hist.window.from });

  const metrics = deriveCostMetrics(hist, conv);
  const valued = metrics.filter((m) => m.value != null).map((m) => m.tier as OperationalTier);
  return {
    asOf: hist.asOf,
    window: hist.window,
    metrics,
    trust: valued.length ? worstTier(valued) : "unknown",
    checkedAt: now.toISOString(),
  };
}
