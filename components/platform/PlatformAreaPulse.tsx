"use client";

/**
 * components/platform/PlatformAreaPulse.tsx  (Platform redesign §4.1 — analytics-first Overview)
 *
 * The body of each Platform directory card: a HEADLINE number, a 14-day TREND
 * where a persisted day series exists, then the BREAKDOWN — "is anything wrong
 * in this area, how much, and is it getting better or worse?" before the
 * operator opens it. Summary → Trend → Breakdown, the redesign's hierarchy.
 *
 * AUTHORITY — no cross-area route exists or is added. Each card reads only its
 * OWN area's existing routes, under the viewer's own grant (each route's
 * requirePlatformAccess(area, "READ") decides; a refusal renders "Unavailable",
 * never a zero). The directory only renders cards for granted areas.
 *
 * HONESTY — one authority per figure, no score, no verdict word:
 *   PLATFORM_OPS      headline  attention items (/platform-ops/attention)
 *                     trend     refresh FAILED executions per UTC day (/platform-ops/refresh/daily)
 *                     breakdown attention by severity
 *   CUSTOMER_SUCCESS  headline  open sync incidents, floor-aware (/customer-success/sync-issues)
 *                     breakdown open incidents by severity     (trend: V2 — needs a day projection)
 *   GROWTH_REVENUE    headline  sign-ups in 7 d, with 30 d    (/growth-revenue/product-analytics)
 *                     trend     registrations per UTC day
 *   SECURITY_OPS      headline  failed sign-ins in the detector window, trips 24 h (/security-ops/anomalies)
 *                                                               (trend: V2 — needs a day projection)
 *   MERCHANT_OPS      — (no count route; the card stays a doorway)
 * A day series renders only when it has ≥ 1 bucket; a missing day is a gap,
 * never zero (MiniBars). Fetched after mount (the directory stays server HTML).
 */

import { DistributionBar, MiniBars, type DistributionSegment, type MiniBarPoint } from "./platform-surface";
import { useWidgetFetch } from "./widget-kit";

type Severity = "critical" | "error" | "warning" | "info";
const SEVERITY_ORDER: readonly Severity[] = ["critical", "error", "warning", "info"];
const SEVERITY_TONE: Record<Severity, DistributionSegment["tone"]> = { critical: "bad", error: "bad", warning: "warn", info: "muted" };

/** How many trailing UTC days a card's trend shows. */
export const TREND_DAYS = 14;

/** Pure: severity counts → bar segments (zero segments dropped; words always beside counts). */
export function severitySegments(counts: Partial<Record<Severity, number>> | null | undefined): DistributionSegment[] {
  return SEVERITY_ORDER
    .map((s) => ({ word: s, count: counts?.[s] ?? 0, tone: SEVERITY_TONE[s] }))
    .filter((seg) => seg.count > 0);
}

/** Pure: the trailing `TREND_DAYS` of a day series as bar points (ascending input kept ascending). */
export function trailingPoints<T extends { day: string }>(days: readonly T[] | null | undefined, value: (d: T) => number | null, tone?: MiniBarPoint["tone"]): MiniBarPoint[] {
  return (days ?? []).slice(-TREND_DAYS).map((d) => ({ key: d.day, value: value(d), ...(tone ? { tone } : {}) }));
}

/** Which areas carry a pulse (MERCHANT_OPS has no count route). */
export const PULSE_AREAS = ["PLATFORM_OPS", "CUSTOMER_SUCCESS", "GROWTH_REVENUE", "SECURITY_OPS"] as const;

const count = (n: number) => n.toLocaleString("en-US");

function Headline({ value, label, aside }: { value: string; label: string; aside?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-[var(--text-primary)]">{value}</span>
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      {aside && <span className="text-[11px] text-[var(--text-muted)]">· {aside}</span>}
    </div>
  );
}

function Pending({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <p role="status" className="text-[11px] text-[var(--text-muted)]">Reading…</p>;
  return <p role="status" className="text-[11px] text-[var(--text-muted)]">Unavailable{error ? ` — ${error}` : ""}</p>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

function OpsPulse() {
  const attention = useWidgetFetch<{ counts: Record<Severity, number> }>("/api/platform/platform-ops/attention");
  const daily = useWidgetFetch<{ days: readonly { day: string; byStatus: Record<string, number> }[]; floor?: boolean }>("/api/platform/platform-ops/refresh/daily");
  if (!attention.data) return <Pending loading={attention.loading} error={attention.error} />;
  const total = SEVERITY_ORDER.reduce((n, s) => n + (attention.data!.counts[s] ?? 0), 0);
  const failures = trailingPoints(daily.data?.days, (d) => d.byStatus.FAILED ?? 0, "bad");
  return (
    <Body>
      <Headline value={count(total)} label={total === 1 ? "item needs attention" : "items need attention"} />
      {daily.data
        ? failures.length > 0 && <MiniBars label="Failed refreshes per day" points={failures} format={count} caption={`UTC days · last ${failures.length} · refresh ledger`} height={36} />
        : <Pending loading={daily.loading} error={daily.error} />}
      {total > 0 && <DistributionBar label="Attention by severity" segments={severitySegments(attention.data.counts)} />}
    </Body>
  );
}

function CustomersPulse() {
  const { data, loading, error } = useWidgetFetch<{ activeTotal: number; truncated: boolean; severityCounts: Record<Severity, number> }>("/api/platform/customer-success/sync-issues");
  if (!data) return <Pending loading={loading} error={error} />;
  return (
    <Body>
      <Headline value={data.truncated ? `≥${count(data.activeTotal)}` : count(data.activeTotal)} label={data.activeTotal === 1 ? "open sync incident" : "open sync incidents"} />
      {data.activeTotal > 0 && <DistributionBar label="Open incidents by severity" segments={severitySegments(data.severityCounts)} floor={data.truncated} />}
    </Body>
  );
}

function GrowthPulse() {
  const { data, loading, error } = useWidgetFetch<{ registrations: { last7d: number; last30d: number; perDay: readonly { day: string; count: number }[] } }>("/api/platform/growth-revenue/product-analytics");
  if (!data) return <Pending loading={loading} error={error} />;
  const r = data.registrations;
  const perDay = trailingPoints(r.perDay, (d) => d.count);
  return (
    <Body>
      <Headline value={count(r.last7d)} label="sign-ups · 7 d" aside={`${count(r.last30d)} in 30 d`} />
      {perDay.length > 0 && <MiniBars label="Sign-ups per day" points={perDay} format={count} caption={`UTC days · last ${perDay.length} · observed`} height={36} />}
    </Body>
  );
}

function SecurityPulse() {
  const { data, loading, error } = useWidgetFetch<{ summary: { failedLoginsWindow: number; windowMinutes: number; tripsLast24h: number } }>("/api/platform/security-ops/anomalies");
  if (!data) return <Pending loading={loading} error={error} />;
  return (
    <Body>
      <Headline value={count(data.summary.failedLoginsWindow)} label={`failed sign-ins · ${data.summary.windowMinutes} m`} aside={`${count(data.summary.tripsLast24h)} anomaly trips · 24 h`} />
    </Body>
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
