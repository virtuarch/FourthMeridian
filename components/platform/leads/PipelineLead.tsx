"use client";

/**
 * components/platform/leads/PipelineLead.tsx  (Platform Operations 2.0 — R2, plan §4.2)
 *
 * Operations › Pipeline — the DETAIL view's lead: a KPI row over the refresh
 * projection (executions · failed · partial · running, with the persisted
 * daily series as the trend), the newest failed executions (top 5, from the
 * overview's own `latestFailures`, each opening the execution panel), and
 * three drawers for the long reads: the endpoint roll-up (ops_refresh_summary),
 * connection health and per-account coverage. The paginated execution table
 * (ops_refresh_executions, "Load older" over the seam's cursor) renders inline
 * beneath this lead — it is the view's one long list.
 *
 * Presentation only: every count is the projection's own; a missing read is
 * "—" + its reason, never a zero.
 */

import { useState } from "react";
import { DetailDrawer, EntityList, EntityRow, KpiTile, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import type { RefreshDailySeries, RefreshSummary } from "@/lib/platform/refresh/types";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import { ExecutionTimelinePanel } from "../widgets/ExecutionTimelinePanel";
import { describeCategory, describeSource, describeTrigger } from "../widgets/execution-format";
import { formatDuration, humanizeToken } from "../widgets/refresh-format";
import { statusTone } from "../widgets/refresh-activity-view";
import { trailingPoints } from "../overview/overview-model";
import type { PlatformViewLeadProps } from "./lead-contract";
import { LeadSection } from "./lead-kit";
import type { Fetched } from "./operations-model";

export type PipelineDrawer = "endpoints" | "connections" | "coverage";

const DRAWERS: readonly { id: PipelineDrawer; key: string; name: string; summary: string }[] = [
  { id: "endpoints",   key: "ops_refresh_summary",   name: "Endpoint roll-up",   summary: "Stage outcomes per endpoint, trigger mix, durations" },
  { id: "connections", key: "ops_connection_health", name: "Connection health", summary: "Every source judged against its refresh policy" },
  { id: "coverage",    key: "ops_refresh_coverage",  name: "Coverage",           summary: "Per-account, per-endpoint freshness evidence" },
];

const n = (v: number) => v.toLocaleString("en-US");

export interface PipelineKpi { key: string; label: string; value: string | null; unavailableReason?: string; note?: string }

/** The four KPIs, from the projection's own counts. Pure. */
export function pipelineKpis(summary: Fetched<RefreshSummary>): PipelineKpi[] {
  const s = summary.data;
  const reason = summary.loading ? "reading…" : `summary unavailable${summary.error ? ` — ${summary.error}` : ""}`;
  // A window with no rows is "not observed", never zeros.
  const observed = s && s.executions > 0;
  const v = (x: number | undefined): string | null => (s ? (observed ? n(x ?? 0) : null) : null);
  const r = s && !observed ? "no executions in the window" : reason;
  return [
    { key: "executions", label: "Executions", value: s ? n(s.executions) : null, unavailableReason: reason, note: s ? `${s.window.from.slice(0, 10)} → ${s.window.to.slice(0, 10)}` : undefined },
    { key: "failed", label: "Failed", value: v(s?.byStatus.FAILED), unavailableReason: r },
    { key: "partial", label: "Partial", value: v(s?.byStatus.PARTIAL), unavailableReason: r },
    { key: "running", label: "Running", value: s ? n(s.openExecutions) : null, unavailableReason: reason },
  ];
}

export function PipelineLeadSurface({ summary, daily, overview, hasHosted, onOpenDrawer, onSelectExecution }: {
  summary: Fetched<RefreshSummary>;
  daily: Fetched<RefreshDailySeries>;
  overview: Fetched<OperationsOverview>;
  hasHosted: (key: string) => boolean;
  onOpenDrawer: (d: PipelineDrawer) => void;
  onSelectExecution: (s: { id: string; eyebrow: string; title: string }) => void;
}) {
  const kpis = pipelineKpis(summary);
  const failedPoints = trailingPoints(daily.data?.days, (d) => d.byStatus.FAILED ?? 0, "bad");
  const totalPoints = trailingPoints(daily.data?.days, (d) => d.total);
  const failures = (overview.data?.latestFailures ?? []).slice(0, 5);
  const drawers = DRAWERS.filter((d) => hasHosted(d.key));

  return (
    <div className="grid min-w-0 gap-4 md:gap-6 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-4 md:gap-6 lg:col-span-7">
        <LeadSection title="Refresh pipeline">
          <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
            {kpis.map((k) => (
              <KpiTile
                key={k.key} label={k.label} value={k.value} unavailableReason={k.unavailableReason} note={k.note}
                points={k.key === "failed" ? failedPoints : k.key === "executions" ? totalPoints : []}
                caption={k.key === "failed" || k.key === "executions" ? "UTC days · last 14" : undefined}
                provenance={k.value !== null ? <ProvenanceChip kind="MEASURED" asOf={summary.data?.checkedAt} /> : undefined}
              />
            ))}
          </div>
        </LeadSection>
        {drawers.length > 0 && (
          <LeadSection title="Detail">
            <EntityList label="Pipeline detail">
              {drawers.map((d) => <EntityRow key={d.id} name={d.name} summary={d.summary} onSelect={() => onOpenDrawer(d.id)} />)}
            </EntityList>
          </LeadSection>
        )}
      </div>

      <LeadSection title="Latest failures" className="lg:col-span-5">
        <EntityList
          label="Latest failed executions"
          empty={overview.loading ? null : overview.data ? "None failed or partial in the pipeline window." : `Failures unavailable${overview.error ? ` — ${overview.error}` : ""}`}
        >
          {failures.map((row) => {
            const source = describeSource(row);
            const category = describeCategory(row.failureCategory);
            return (
              <EntityRow
                key={row.id}
                name={source.label}
                status={{ word: humanizeToken(row.overallStatus), tone: statusTone(row.overallStatus) }}
                summary={`${describeTrigger(row.trigger)}${row.failureStage ? ` · at ${row.failureStage}` : ""}${category ? ` · ${category}` : ""} · ${formatDuration(row.durationMs)} · ${row.startedAt.slice(0, 16).replace("T", " ")} UTC`}
                onSelect={() => onSelectExecution({ id: row.id, eyebrow: `${source.kind} · ${describeTrigger(row.trigger)} · ${humanizeToken(row.overallStatus)}`, title: source.label })}
              />
            );
          })}
        </EntityList>
      </LeadSection>
    </div>
  );
}

export function PipelineLead({ renderHosted, hasHosted, onOpenWorkspace }: PlatformViewLeadProps) {
  const summary = useSharedWidgetFetch<RefreshSummary>("/api/platform/platform-ops/refresh/summary");
  const daily = useSharedWidgetFetch<RefreshDailySeries>("/api/platform/platform-ops/refresh/daily");
  const overview = useSharedWidgetFetch<OperationsOverview>("/api/platform/platform-ops/overview");
  const [drawer, setDrawer] = useState<PipelineDrawer | null>(null);
  const [execution, setExecution] = useState<{ id: string; eyebrow: string; title: string } | null>(null);
  const go = (id: string) => { setDrawer(null); onOpenWorkspace(id); };
  const open = DRAWERS.find((d) => d.id === drawer);

  return (
    <>
      <PipelineLeadSurface summary={summary} daily={daily} overview={overview} hasHosted={hasHosted} onOpenDrawer={setDrawer} onSelectExecution={setExecution} />
      <DetailDrawer open={open != null} onClose={() => setDrawer(null)} eyebrow="Pipeline" title={open?.name ?? ""} size="xl">
        {open ? renderHosted(open.key, go) : null}
      </DetailDrawer>
      <ExecutionTimelinePanel executionId={execution?.id ?? null} eyebrow={execution?.eyebrow ?? ""} title={execution?.title ?? ""} onClose={() => setExecution(null)} />
    </>
  );
}
