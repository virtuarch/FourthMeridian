"use client";

/**
 * components/platform/overview/PlatformOverview.tsx  (Platform Operations 2.0 — R1, plan §4.1)
 *
 * The Platform OVERVIEW command center — `/dashboard/platform`. Summary first:
 *   left   StatusHeader (the verdict, only where an authority issues one) +
 *          AttentionQueue (top items merged across the granted areas);
 *   right  per-Space KPI tiles with their 14-day series and provenance, each a
 *          doorway into its Space.
 * Desktop: two columns. Mobile (375–430): header → 3 attention items → KPI
 * tiles two-up; nothing overflows the page horizontally.
 *
 * AUTHORITY — no cross-area route exists or is added. Each granted area has ONE
 * probe component that reads only that area's OWN existing routes
 * (`/api/platform/<area>/…`), each gated by requirePlatformAccess(area, "READ").
 * A probe is MOUNTED only for an area the page's server-loaded grant rows name,
 * so an ungranted area is never even asked (no refusal is provoked, none is
 * recorded). The merge happens here, client-side, over answers the operator was
 * already entitled to read one area at a time.
 *
 * HONESTY — see overview-model.ts: loading ≠ zero, unavailable ≠ zero, no
 * verdict without an authority, spend is ESTIMATED.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useWidgetFetch } from "@/components/platform/widget-kit";
import { AttentionQueue, KpiTile, ProvenanceChip, StatusHeader } from "@/components/platform/ui";
import {
  LOADING,
  attentionQueue,
  latestAnswerAt,
  overviewStatus,
  spaceTiles,
  tileFormatter,
  toSource,
  type CsIncidentsDailyData,
  type CsSyncIssuesData,
  type SignupAnalyticsData,
  type OpsAiTrendData,
  type OpsAttentionData,
  type OpsOverviewData,
  type OpsRefreshDailyData,
  type OverviewSignals,
  type OverviewSpace,
  type SecurityAnomaliesData,
  type SecurityDailyData,
} from "./overview-model";

type Report = <K extends keyof OverviewSignals>(area: K, value: NonNullable<OverviewSignals[K]>) => void;

/** A fetch result as a Source, stable across renders until the fetch itself changes
 *  (the probes report in an effect; a fresh object each render would loop). */
function useSource<T>(r: { data: T | null; loading: boolean; error: string | null; fetchedAt: string | null }) {
  const { data, loading, error, fetchedAt } = r;
  return useMemo(() => toSource({ data, loading, error, fetchedAt }), [data, loading, error, fetchedAt]);
}

// ── Probes: one per area, each reading ONLY its own area's routes ────────────

function OpsProbe({ report }: { report: Report }) {
  const overview = useSource(useWidgetFetch<OpsOverviewData>("/api/platform/platform-ops/overview"));
  const attention = useSource(useWidgetFetch<OpsAttentionData>("/api/platform/platform-ops/attention"));
  const refreshDaily = useSource(useWidgetFetch<OpsRefreshDailyData>("/api/platform/platform-ops/refresh/daily"));
  const aiTrend = useSource(useWidgetFetch<OpsAiTrendData>("/api/platform/platform-ops/ai-usage-trend"));
  useEffect(() => {
    report("PLATFORM_OPS", { overview, attention, refreshDaily, aiTrend });
  }, [report, overview, attention, refreshDaily, aiTrend]);
  return null;
}

function CustomersProbe({ report }: { report: Report }) {
  const syncIssues = useSource(useWidgetFetch<CsSyncIssuesData>("/api/platform/customer-success/sync-issues"));
  const incidentsDaily = useSource(useWidgetFetch<CsIncidentsDailyData>("/api/platform/customer-success/incidents-daily"));
  useEffect(() => {
    report("CUSTOMER_SUCCESS", { syncIssues, incidentsDaily });
  }, [report, syncIssues, incidentsDaily]);
  return null;
}

function SignupsProbe({ report }: { report: Report }) {
  const analytics = useSource(useWidgetFetch<SignupAnalyticsData>("/api/platform/growth-revenue/product-analytics"));
  useEffect(() => {
    report("GROWTH_REVENUE", { analytics });
  }, [report, analytics]);
  return null;
}

function SecurityProbe({ report }: { report: Report }) {
  const anomalies = useSource(useWidgetFetch<SecurityAnomaliesData>("/api/platform/security-ops/anomalies"));
  const daily = useSource(useWidgetFetch<SecurityDailyData>("/api/platform/security-ops/daily"));
  useEffect(() => {
    report("SECURITY_OPS", { anomalies, daily });
  }, [report, anomalies, daily]);
  return null;
}

/** The areas with an Overview probe (MERCHANT_OPS has no summary route: its Space stays a doorway). */
export const PROBED_AREAS = ["PLATFORM_OPS", "CUSTOMER_SUCCESS", "GROWTH_REVENUE", "SECURITY_OPS"] as const;

/** Every granted, probed area starts LOADING on the first frame (no figure before an answer). */
export function initialSignals(spaces: readonly OverviewSpace[]): OverviewSignals {
  const has = (a: string) => spaces.some((s) => s.area === a);
  return {
    ...(has("PLATFORM_OPS") ? { PLATFORM_OPS: { overview: LOADING, attention: LOADING, refreshDaily: LOADING, aiTrend: LOADING } } : {}),
    ...(has("CUSTOMER_SUCCESS") ? { CUSTOMER_SUCCESS: { syncIssues: LOADING, incidentsDaily: LOADING } } : {}),
    ...(has("GROWTH_REVENUE") ? { GROWTH_REVENUE: { analytics: LOADING } } : {}),
    ...(has("SECURITY_OPS") ? { SECURITY_OPS: { anomalies: LOADING, daily: LOADING } } : {}),
  };
}

// ── The page body ────────────────────────────────────────────────────────────

export function PlatformOverview({ spaces, now }: { spaces: readonly OverviewSpace[]; now?: Date }) {
  const [signals, setSignals] = useState<OverviewSignals>(() => initialSignals(spaces));
  const report = useCallback<Report>((area, value) => setSignals((s) => ({ ...s, [area]: value })), []);
  const has = (a: string) => spaces.some((s) => s.area === a);

  return (
    <>
      {has("PLATFORM_OPS") && <OpsProbe report={report} />}
      {has("CUSTOMER_SUCCESS") && <CustomersProbe report={report} />}
      {has("GROWTH_REVENUE") && <SignupsProbe report={report} />}
      {has("SECURITY_OPS") && <SecurityProbe report={report} />}
      <PlatformOverviewView spaces={spaces} signals={signals} now={now} />
    </>
  );
}

/** Pure over its props (granted rows + what the areas answered) so it renders in a test. */
export function PlatformOverviewView({ spaces, signals, now }: { spaces: readonly OverviewSpace[]; signals: OverviewSignals; now?: Date }) {
  // The queue's relative ages are measured against the newest ANSWER (the instant
  // the data was true), not a render clock; a test pins `now`.
  const clock = now ?? latestAnswerAt(signals);
  const status = overviewStatus(signals);
  const queue = attentionQueue(signals, spaces, clock);
  const tiles = spaceTiles(signals, spaces);

  return (
    <div className="mx-auto w-full max-w-[1280px] pb-10">
      <header className="flex flex-col gap-1 pb-5 pt-1">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-3xl">Overview</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          {spaces.length === 1 ? "1 Platform Space" : `${spaces.length} Platform Spaces`} · granted to you
        </p>
      </header>

      {spaces.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No Platform Space is granted to this account.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4">
            <StatusHeader
              verdict={status.verdict}
              title={status.title}
              checkedAt={status.checkedAt}
              facts={status.facts}
              aside={status.authoritative ? undefined : <ProvenanceChip kind="UNKNOWN" title="No granted area issues an overall verdict" />}
            />
            <AttentionQueue
              items={queue.items.map((it) => ({
                key: it.key,
                severity: { word: it.severityWord, tone: it.tone },
                title: it.title,
                why: it.why,
                meta: it.meta,
                action: { label: it.actionLabel, href: it.href },
              }))}
              loading={queue.loading}
              emptyText={queue.allClear ? "Nothing needs attention in the Spaces you hold." : queue.loading ? null : queue.notes.length === 0 ? "No attention source in the Spaces you hold." : null}
              notes={queue.notes}
              viewAll={queue.totals.map((t) => ({ key: t.area, label: t.label, href: t.href, count: t.count }))}
            />
          </div>

          <section aria-label="Spaces" className="flex min-w-0 flex-col gap-4">
            {tiles.map((s) => (
              <div key={s.area} className="flex min-w-0 flex-col gap-2">
                <Link
                  href={s.href}
                  prefetch={false}
                  className="group inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] sm:min-h-8"
                >
                  {s.name}
                  <ArrowUpRight size={14} aria-hidden className="text-[var(--text-muted)] transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </Link>
                {s.tiles.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">No summary metrics for this Space yet — open it for its full view.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:gap-3">
                    {s.tiles.map((t) => (
                      <KpiTile
                        key={t.key}
                        label={t.label}
                        value={t.state === "ok" ? t.value : null}
                        unavailableReason={t.state === "ok" ? "no observation in the window" : t.reason}
                        points={t.points}
                        format={tileFormatter(t.format)}
                        caption={t.caption}
                        note={t.note}
                        provenance={t.state === "loading" ? undefined : <ProvenanceChip kind={t.provenance} asOf={t.asOf} />}
                        href={t.href}
                        hrefLabel={`open ${t.spaceName}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
