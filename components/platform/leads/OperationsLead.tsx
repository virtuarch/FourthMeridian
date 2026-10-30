"use client";

/**
 * components/platform/leads/OperationsLead.tsx  (Platform Operations 2.0 — R2, plan §4.2)
 *
 * THE OPERATIONS DEFAULT SCREEN — summary first, ≈ one screen on desktop:
 *
 *   StatusHeader       the overview's worst-domain verdict + when it was checked +
 *                      attention total · open incidents · jobs · pipeline
 *   AttentionQueue     the attention route's top 5 (server order); "View all"
 *                      opens a drawer with the FULL attention list and its
 *                      resync / request-reauth actions (AttentionBlock, unchanged)
 *   Jobs & activity    4 KPIs (scheduler 24 h runs, job-health counts) + the five
 *                      newest executions, each opening the execution panel;
 *                      "All jobs" opens the Jobs detail view
 *   Detail             ≤ 5 doorways: Domains & sources · Incidents · Platform
 *                      health · Pipeline · Activity & usage
 *   Manual operations  ONE deliberate entry ("Run an operation…") that opens the
 *                      existing Manual operations widget in a drawer — its own
 *                      write / fleet gating, reason, confirmation and pre-run
 *                      audit are untouched, and nothing runs from this screen
 *
 * Desktop: two columns (verdict + attention | jobs + detail + operations).
 * Mobile: the same order composed for a phone — 3 attention rows, a 2×2 KPI
 * grid, 3 recent executions, then the doorways.
 *
 * Presentation only. Every word is the answering route's (operations-model.ts);
 * hosted sections render through `renderHosted` (registry widget + DB row +
 * access), and the overview blocks render only when the view hosts ops_overview.
 */

import { useState, type ReactNode } from "react";
import { DetailDrawer, StatusHeader, AttentionQueue, KpiTile, EntityList, EntityRow, ControlledActionSurface, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import { platformViewTarget } from "@/lib/platform/workspaces";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import type { ConvergenceResult } from "@/lib/platform/convergence/types";
import type { PlatformJobHealthResponse } from "@/app/api/platform/platform-ops/job-health/route";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";
import type { ExecutionPageDTO } from "@/lib/platform/refresh/execution-query-core";
import { STATE_TONE, STATE_WORD } from "../widgets/ops-overview-view";
import { ExecutionTimelinePanel } from "../widgets/ExecutionTimelinePanel";
import { StatusBoard } from "../widgets/overview/StatusBoard";
import { AttentionBlock } from "../widgets/overview/AttentionBlock";
import { ConnectionHealthBlock } from "../widgets/overview/ConnectionHealthBlock";
import { JobsMatrixBlock } from "../widgets/overview/JobsMatrixBlock";
import { RefreshActivityBlock } from "../widgets/overview/RefreshActivityBlock";
import { AiActivityBlock } from "../widgets/overview/AiActivityBlock";
import { EconomicsBlock } from "../widgets/overview/EconomicsBlock";
import { ActivityFeedBlock } from "../widgets/overview/ActivityFeedBlock";
import type { PlatformViewLeadProps } from "./lead-contract";
import type { StatusTone } from "../platform-surface";
import { LeadSection } from "./lead-kit";
import {
  attentionNotes,
  attentionRows,
  attentionTotal,
  jobKpis,
  openIncidentCount,
  recentExecutions,
  statusModel,
  type Fetched,
} from "./operations-model";

/** The drawers this lead opens. Each holds detail that used to sit on the page. */
export type OperationsDrawer = "attention" | "board" | "incidents" | "health" | "activity" | "operations";

const JOBS_VIEW = platformViewTarget("platform-overview", "jobs");
const PIPELINE_VIEW = platformViewTarget("platform-overview", "pipeline");
/** The overview blocks are ops_overview's content; they render only where the view hosts it. */
const OVERVIEW_KEY = "ops_overview";

interface ExecutionSelection { id: string; eyebrow: string; title: string }

export interface OperationsLeadSurfaceProps {
  overview: Fetched<OperationsOverview>;
  attention: Fetched<AttentionResponse>;
  convergence: Fetched<ConvergenceResult>;
  jobs: Fetched<PlatformJobHealthResponse>;
  scheduler: Fetched<SchedulerObservationResponse>;
  executions: Fetched<ExecutionPageDTO>;
  nowMs: number;
  hasHosted: (key: string) => boolean;
  onOpenDrawer: (d: OperationsDrawer) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
}

/** The prop-driven default screen (fetch-free, so every state renders in a test). */
export function OperationsLeadSurface(p: OperationsLeadSurfaceProps) {
  const status = statusModel(p.overview, p.attention, p.convergence);
  const board = p.hasHosted(OVERVIEW_KEY);
  const rows = p.attention.data ? attentionRows(p.attention.data, p.nowMs) : [];
  const total = p.attention.data ? attentionTotal(p.attention.data) : 0;
  const kpis = jobKpis(p.jobs, p.scheduler);
  const recent = p.executions.data ? recentExecutions(p.executions.data, p.nowMs) : [];
  const o = p.overview.data;
  const pipeline = o?.domains.find((d) => d.key === "pipeline");
  const incidents = p.convergence.data;

  // ≤ 5 doorways, each only where its detail is hosted (or is a view).
  const detail: { key: string; name: string; status?: { word: string; tone: StatusTone }; summary: string; onSelect: () => void }[] = [];
  if (board) detail.push({
    key: "board", name: "Domains & sources", onSelect: () => p.onOpenDrawer("board"),
    status: o ? { word: STATE_WORD[o.worst], tone: STATE_TONE[o.worst] } : undefined,
    summary: o ? (status.notHealthy.length ? status.notHealthy.join(" · ") : `All ${o.domains.length} domains healthy`) : "Status board, sources and policy",
  });
  if (p.hasHosted("ops_convergence") || p.hasHosted("ops_timeline")) detail.push({
    key: "incidents", name: "Incidents", onSelect: () => p.onOpenDrawer("incidents"),
    status: incidents ? (openIncidentCount(incidents) > 0 ? { word: `${openIncidentCount(incidents)} open`, tone: "warn" } : { word: "None open", tone: "ok" }) : undefined,
    summary: incidents ? `${incidents.episodes.length} episode${incidents.episodes.length === 1 ? "" : "s"} · ${incidents.eventCount} events in the window` : "Convergence episodes and the event timeline",
  });
  if (p.hasHosted("ops_platform_health")) detail.push({
    key: "health", name: "Platform health", onSelect: () => p.onOpenDrawer("health"),
    summary: o ? o.posture.map((c) => `${c.label} ${c.word}`).join(" · ") : "Alerts, providers, freshness, configuration",
  });
  detail.push({
    key: "pipeline", name: "Pipeline", onSelect: () => p.onOpenWorkspace(PIPELINE_VIEW),
    status: pipeline ? { word: STATE_WORD[pipeline.state], tone: STATE_TONE[pipeline.state] } : undefined,
    summary: pipeline ? `${pipeline.figure.value} · ${pipeline.figure.qualifier}` : "Refresh executions, outcomes and coverage",
  });
  if (board) detail.push({
    key: "activity", name: "Activity & usage", onSelect: () => p.onOpenDrawer("activity"),
    summary: "Jobs matrix · refresh activity · AI · economics · operator actions",
  });

  return (
    <div className="grid min-w-0 gap-4 md:gap-6 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-4 md:gap-6 lg:col-span-7">
        <StatusHeader
          verdict={status.verdict}
          title={status.title}
          checkedAt={status.checkedAt}
          facts={status.facts}
          aside={o ? <ProvenanceChip kind="MEASURED" asOf={o.checkedAt} /> : undefined}
        />
        <AttentionQueue
          items={rows.map((r) => ({
            key: r.key, severity: r.severity, title: r.title, why: r.why, meta: r.meta,
            action: board
              ? { label: r.nextLabel, onSelect: () => p.onOpenDrawer("attention") }
              : { label: r.nextLabel, onSelect: () => p.onOpenWorkspace(r.workspace) },
          }))}
          loading={p.attention.loading}
          emptyText={p.attention.data && p.attention.data.authoritiesFailed.length === 0 && rows.length === 0
            ? `Nothing needs attention — ${p.attention.data.authoritiesChecked.count} sources checked.` : null}
          notes={attentionNotes(p.attention)}
          viewAll={board && total > 0 ? [{ key: "all", label: "View all", count: total.toLocaleString("en-US"), onSelect: () => p.onOpenDrawer("attention") }] : []}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-4 md:gap-6 lg:col-span-5">
        <LeadSection title="Jobs & activity" action={{ label: "All jobs", onSelect: () => p.onOpenWorkspace(JOBS_VIEW) }}>
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {kpis.map((k) => (
              <KpiTile key={k.key} label={k.label} value={k.value} unavailableReason={k.unavailableReason} note={k.note}
                provenance={k.value !== null ? <ProvenanceChip kind="MEASURED" /> : undefined} />
            ))}
          </div>
          <EntityList label="Recent executions" empty={p.executions.loading ? null : p.executions.error ? `Executions unavailable — ${p.executions.error}` : "No executions recorded yet."}>
            {recent.map((r, i) => (
              <div key={r.id} className={i >= 3 ? "max-sm:hidden" : undefined}>
                <EntityRow name={r.name} status={r.status} summary={r.summary}
                  onSelect={() => p.onSelectExecution({ id: r.id, eyebrow: r.eyebrow, title: r.name })} />
              </div>
            ))}
          </EntityList>
        </LeadSection>

        <LeadSection title="Detail">
          <EntityList label="Operations detail">
            {detail.slice(0, 5).map((d) => (
              <EntityRow key={d.key} name={d.name} status={d.status} summary={d.summary} onSelect={d.onSelect} />
            ))}
          </EntityList>
        </LeadSection>

        {p.hasHosted("ops_manual_operations") && (
          <ControlledActionSurface
            title="Manual operations"
            actions={[{
              id: "manual-operations",
              label: "Run or dry-run a scheduled job",
              description: "Opens the operations console. Every run asks for confirmation; fleet-wide runs also need elevated access and a reason, and are audited before they start.",
              authority: "Requires write access · fleet-wide runs require elevated access",
              opens: { label: "Run an operation…", onOpen: () => p.onOpenDrawer("operations") },
            }]}
          />
        )}
      </div>
    </div>
  );
}

const DRAWER_TITLE: Record<OperationsDrawer, { eyebrow: string; title: string }> = {
  attention:  { eyebrow: "Operations", title: "Needs attention" },
  board:      { eyebrow: "Operations", title: "Domains & sources" },
  incidents:  { eyebrow: "Operations", title: "Incidents" },
  health:     { eyebrow: "Operations", title: "Platform health" },
  activity:   { eyebrow: "Operations", title: "Activity & usage" },
  operations: { eyebrow: "Operations", title: "Manual operations" },
};

export function OperationsLead({ renderHosted, hasHosted, onOpenWorkspace, access }: PlatformViewLeadProps) {
  const overview = useSharedWidgetFetch<OperationsOverview>("/api/platform/platform-ops/overview");
  const attention = useSharedWidgetFetch<AttentionResponse>("/api/platform/platform-ops/attention");
  const convergence = useSharedWidgetFetch<ConvergenceResult>("/api/platform/platform-ops/convergence");
  const jobs = useSharedWidgetFetch<PlatformJobHealthResponse>("/api/platform/platform-ops/job-health");
  const scheduler = useSharedWidgetFetch<SchedulerObservationResponse>("/api/platform/platform-ops/scheduler");
  const executions = useSharedWidgetFetch<ExecutionPageDTO>("/api/platform/platform-ops/refresh/executions?limit=5");
  // One clock read per mount (relative ages on the summary), never during render.
  const [nowMs] = useState(() => Date.now());
  const [drawer, setDrawer] = useState<OperationsDrawer | null>(null);
  const [execution, setExecution] = useState<ExecutionSelection | null>(null);

  // A doorway inside a drawer closes the drawer, then moves the rail.
  const go = (id: string) => { setDrawer(null); onOpenWorkspace(id); };
  const shared = { onOpenWorkspace: go, access };

  let body: ReactNode = null;
  switch (drawer) {
    case "attention":  body = hasHosted(OVERVIEW_KEY) ? <AttentionBlock {...shared} /> : null; break;
    case "board":      body = hasHosted(OVERVIEW_KEY) ? <div className="flex flex-col gap-8"><StatusBoard title="Status board" {...shared} /><ConnectionHealthBlock {...shared} /></div> : null; break;
    case "incidents":  body = <div className="flex flex-col gap-8">{renderHosted("ops_convergence", go)}{renderHosted("ops_timeline", go)}</div>; break;
    case "health":     body = renderHosted("ops_platform_health", go); break;
    case "activity":   body = hasHosted(OVERVIEW_KEY) ? (
      <div className="flex flex-col gap-8">
        <JobsMatrixBlock {...shared} />
        <RefreshActivityBlock {...shared} />
        <AiActivityBlock {...shared} />
        <EconomicsBlock {...shared} />
        <ActivityFeedBlock {...shared} />
      </div>
    ) : null; break;
    case "operations": body = renderHosted("ops_manual_operations", go); break;
  }

  return (
    <>
      <OperationsLeadSurface
        overview={overview} attention={attention} convergence={convergence}
        jobs={jobs} scheduler={scheduler} executions={executions}
        nowMs={nowMs} hasHosted={hasHosted}
        onOpenDrawer={setDrawer} onOpenWorkspace={onOpenWorkspace} onSelectExecution={setExecution}
      />
      <DetailDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        eyebrow={drawer ? DRAWER_TITLE[drawer].eyebrow : undefined}
        title={drawer ? DRAWER_TITLE[drawer].title : ""}
        size="xl"
      >
        {body}
      </DetailDrawer>
      <ExecutionTimelinePanel
        executionId={execution?.id ?? null}
        eyebrow={execution?.eyebrow ?? ""}
        title={execution?.title ?? ""}
        onClose={() => setExecution(null)}
      />
    </>
  );
}
