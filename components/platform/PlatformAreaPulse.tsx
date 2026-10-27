"use client";

/**
 * components/platform/PlatformAreaPulse.tsx  (Platform redesign §4.1 — cross-area Overview)
 *
 * The live strip inside each Platform directory card: two or three facts that
 * answer "is anything wrong in this area, and how much?" before the operator
 * opens it.
 *
 * AUTHORITY — no cross-area route exists or is added. Each card fetches ONE of
 * its own area's existing routes, under the viewer's own grant (the route's
 * requirePlatformAccess(area, "READ") decides; a refusal renders an honest
 * "unavailable", never a zero). The directory only renders cards for granted
 * areas, so an ungranted area is never fetched.
 *
 * HONESTY — counts from one authority each, no score, no derived health word:
 *   PLATFORM_OPS      /platform-ops/attention        items by severity
 *   CUSTOMER_SUCCESS  /customer-success/sync-issues  open incidents by severity
 *   GROWTH_REVENUE    /growth-revenue/signups        sign-ups 7 d / 30 d
 *   SECURITY_OPS      /security-ops/anomalies        failed sign-ins in the window, trips 24 h
 *   MERCHANT_OPS      — (no count route; the card stays a plain doorway)
 * Fetched after mount (the server page stays a pure directory).
 */

import { DistributionBar, type DistributionSegment } from "./platform-surface";
import { useWidgetFetch } from "./widget-kit";

type Severity = "critical" | "error" | "warning" | "info";
const SEVERITY_ORDER: readonly Severity[] = ["critical", "error", "warning", "info"];
const SEVERITY_WORD: Record<Severity, string> = { critical: "critical", error: "error", warning: "warning", info: "info" };
const SEVERITY_TONE: Record<Severity, DistributionSegment["tone"]> = { critical: "bad", error: "bad", warning: "warn", info: "muted" };

/** Pure: severity counts → bar segments (zero segments dropped; words always beside counts). */
export function severitySegments(counts: Partial<Record<Severity, number>> | null | undefined): DistributionSegment[] {
  return SEVERITY_ORDER
    .map((s) => ({ word: SEVERITY_WORD[s], count: counts?.[s] ?? 0, tone: SEVERITY_TONE[s] }))
    .filter((seg) => seg.count > 0);
}

/** Which areas carry a pulse (MERCHANT_OPS has no count route). */
export const PULSE_AREAS = ["PLATFORM_OPS", "CUSTOMER_SUCCESS", "GROWTH_REVENUE", "SECURITY_OPS"] as const;

function Fact({ value, label }: { value: number | string; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{value}</span>
      <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
    </span>
  );
}

function Pending({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <p role="status" className="text-[11px] text-[var(--text-muted)]">Reading…</p>;
  return <p role="status" className="text-[11px] text-[var(--text-muted)]">Unavailable{error ? ` — ${error}` : ""}</p>;
}

function OpsPulse() {
  const { data, loading, error } = useWidgetFetch<{ counts: Record<Severity, number> }>("/api/platform/platform-ops/attention");
  if (!data) return <Pending loading={loading} error={error} />;
  const total = SEVERITY_ORDER.reduce((n, s) => n + (data.counts[s] ?? 0), 0);
  return (
    <div className="flex flex-col gap-2">
      <Fact value={total} label={total === 1 ? "item needs attention" : "items need attention"} />
      {total > 0 && <DistributionBar label="Attention by severity" segments={severitySegments(data.counts)} />}
    </div>
  );
}

function CustomersPulse() {
  const { data, loading, error } = useWidgetFetch<{ activeTotal: number; truncated: boolean; severityCounts: Record<Severity, number> }>("/api/platform/customer-success/sync-issues");
  if (!data) return <Pending loading={loading} error={error} />;
  return (
    <div className="flex flex-col gap-2">
      <Fact value={data.truncated ? `≥${data.activeTotal}` : data.activeTotal} label={data.activeTotal === 1 ? "open sync incident" : "open sync incidents"} />
      {data.activeTotal > 0 && <DistributionBar label="Open incidents by severity" segments={severitySegments(data.severityCounts)} floor={data.truncated} />}
    </div>
  );
}

function GrowthPulse() {
  const { data, loading, error } = useWidgetFetch<{ signups7: number; signups30: number }>("/api/platform/growth-revenue/signups");
  if (!data) return <Pending loading={loading} error={error} />;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      <Fact value={data.signups7} label="sign-ups · 7 d" />
      <Fact value={data.signups30} label="sign-ups · 30 d" />
    </div>
  );
}

function SecurityPulse() {
  const { data, loading, error } = useWidgetFetch<{ summary: { failedLoginsWindow: number; windowMinutes: number; tripsLast24h: number } }>("/api/platform/security-ops/anomalies");
  if (!data) return <Pending loading={loading} error={error} />;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      <Fact value={data.summary.failedLoginsWindow} label={`failed sign-ins · ${data.summary.windowMinutes} m`} />
      <Fact value={data.summary.tripsLast24h} label="anomaly trips · 24 h" />
    </div>
  );
}

/** The pulse for one granted area, or nothing when the area has no count route. */
export function PlatformAreaPulse({ area }: { area: string }) {
  switch (area) {
    case "PLATFORM_OPS":     return <OpsPulse />;
    case "CUSTOMER_SUCCESS": return <CustomersPulse />;
    case "GROWTH_REVENUE":   return <GrowthPulse />;
    case "SECURITY_OPS":     return <SecurityPulse />;
    default:                 return null;
  }
}
