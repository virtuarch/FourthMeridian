"use client";

/**
 * components/platform/leads/OperationsLead.tsx  (Platform Ops visual spec §4 — the representative workspace)
 *
 * THE OPERATIONS DEFAULT SCREEN, rebuilt in the Personal Space visual language
 * (owner rejection of R1/R2: "an old administration console wearing different
 * navigation"). Analytics first, text last; one label, one figure, one chart and
 * at most one caption per card; history and diagnostics in focused detail.
 *
 *   ≥ lg (12-col, Personal grammar: space-y-10, gap-8, symmetric pairs)
 *     A  Health hero (12)            verdict · checked time · 4 KPI figures
 *     B  Execution trend (7)         stacked executions per UTC day (history)
 *        Outcome composition (5)     BreakdownWidget donut (job health)
 *     C  Needs attention (6)         top 3 GROUPED by shared cause
 *        Refresh activity (6)        14-day bars (refresh/daily)
 *     D  Jobs (12)                   the unified list, 5 rows worst first, See all
 *     E  Recent activity (12)        3 executions → the execution timeline
 *   < lg
 *     hero card → 2×2 KPIs → ONE chart card (trend) → attention (3) → jobs (3)
 *     → recent activity (3); the donut and refresh bars are desktop-only.
 *
 * Every former widget stays reachable from a drawer (ops_overview's status board,
 * attention list with its resync / reauth actions and activity blocks;
 * ops_convergence + ops_timeline; ops_platform_health) and the unified jobs card
 * renders only where the view hosts "ops_job_health" (its enabled DB row).
 *
 * Presentation only. Words and figures come from ops-visual-model.ts (pure) and
 * operations-model.ts; reads go through the shared workspace session.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { DetailDrawer } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import { platformViewTarget } from "@/lib/platform/workspaces";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import type { PlatformJobHealthResponse } from "@/app/api/platform/platform-ops/job-health/route";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";
import type { ExecutionPageDTO } from "@/lib/platform/refresh/execution-query-core";
import type { RefreshDailySeries } from "@/lib/platform/refresh/types";
import type { OperationalHistoryResult } from "@/lib/platform/history/types";
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
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import { recentExecutions, type Fetched } from "./operations-model";
import { HealthHero, type HeroModel } from "../ops-visual/HealthHero";
import { goToSection } from "./visual-kit";
import { DayBars, DayBarsLegend, DAY_BAR_COLORS } from "../ops-visual/DayBars";
import { StatusWord, UnifiedJobs, JOBS_URL, SCHEDULER_URL, HISTORY_URL, OPERATIONS_URL, ENV_STATUS_URL } from "../ops-visual/UnifiedJobs";
import {
  attentionTotal,
  executionDays,
  groupAttention,
  healthKpis,
  outcomeComposition,
  refreshDays,
  schedulerEvidence,
  type AttentionGroup,
  type SchedulerEvidence,
} from "../ops-visual/ops-visual-model";

/** The drawers this lead opens. Each holds detail that used to sit on the page. */
export type OperationsDrawer = "attention" | "board" | "incidents" | "health" | "activity";

export const JOBS_VIEW = platformViewTarget("platform-overview", "jobs");
export const PIPELINE_VIEW = platformViewTarget("platform-overview", "pipeline");
/** The overview blocks are ops_overview's content; they render only where the view hosts it. */
const OVERVIEW_KEY = "ops_overview";
/** The unified jobs card renders only where the view hosts the jobs section. */
const JOBS_KEY = "ops_job_health";

/** Default-screen caps (spec §4). */
export const ATTENTION_ROWS = 3;
export const RECENT_ROWS = 3;
export const TREND_DAYS = 14;

interface ExecutionSelection { id: string; eyebrow: string; title: string }

const n = (v: number) => v.toLocaleString("en-US");
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;

const DOORWAY =
  "inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-xs)] text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8";

function Doorway({ label, onSelect, dialog = false }: { label: string; onSelect: () => void; dialog?: boolean }) {
  return (
    <button type="button" onClick={onSelect} aria-haspopup={dialog ? "dialog" : undefined} className={DOORWAY}>
      {label} <ChevronRight size={12} aria-hidden />
    </button>
  );
}

/** One caption line under a chart. */
function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-3 truncate text-[11px] text-[var(--text-muted)]">{children}</p>;
}

// ── The hero model ────────────────────────────────────────────────────────────

export function heroModel(args: {
  overview: Fetched<OperationsOverview>;
  evidence: SchedulerEvidence;
  groups: readonly AttentionGroup[];
  attention: Fetched<AttentionResponse>;
  kpis: HeroModel["kpis"];
}): HeroModel {
  const o = args.overview.data;
  const verdict = o
    ? { word: STATE_WORD[o.worst], tone: STATE_TONE[o.worst] }
    : { word: args.overview.loading ? "Reading" : "Unknown", tone: "muted" as StatusTone };
  const issues = args.attention.data
    ? args.groups.length === 0 ? "Nothing needs attention" : `${n(args.groups.length)} issue${args.groups.length === 1 ? "" : "s"} need${args.groups.length === 1 ? "s" : ""} attention`
    : args.attention.loading ? "Reading attention…" : "Attention unavailable";
  const caption = args.evidence.state !== "inactive" ? issues
    : args.evidence.preview ? `${issues} · scheduled jobs don't run on Preview`
    : `${issues} · scheduler not active on this deployment`;
  return { verdict, checked: o ? hhmm(o.checkedAt) : null, caption, kpis: args.kpis };
}

// ── The surface (prop-driven, fetch-free — every state renders in a test) ────

export interface OperationsLeadSurfaceProps {
  overview: Fetched<OperationsOverview>;
  attention: Fetched<AttentionResponse>;
  jobs: Fetched<PlatformJobHealthResponse>;
  scheduler: Fetched<SchedulerObservationResponse>;
  history: Fetched<OperationalHistoryResult>;
  daily: Fetched<RefreshDailySeries>;
  executions: Fetched<ExecutionPageDTO>;
  nowMs: number;
  hasHosted: (key: string) => boolean;
  /** The unified jobs card (summary mode) — the container renders it, a test passes a stand-in. */
  jobsSlot: ReactNode;
  onOpenDrawer: (d: OperationsDrawer) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
  onSelectJob: (job: string) => void;
  /** Start times of recent manual runs (operations GET) — excluded from wake evidence. */
  manualStarts?: readonly string[] | null;
  /** it2 — env-status `deploymentEnv` (null/absent = unknown): crons fire on Production only. */
  deploymentEnv?: string | null;
}

export function OperationsLeadSurface(p: OperationsLeadSurfaceProps) {
  const evidence = schedulerEvidence(p.jobs, p.scheduler, p.manualStarts ?? null, p.deploymentEnv ?? null);
  const groups = p.attention.data ? groupAttention(p.attention.data, evidence, p.jobs.data) : [];
  const trend = executionDays(p.history.data, p.nowMs, TREND_DAYS);
  const kpis = healthKpis({ jobs: p.jobs, scheduler: p.scheduler, attention: p.attention, groups, days7: trend.slice(-7), manualStarts: p.manualStarts ?? null });
  const hero = heroModel({ overview: p.overview, evidence, groups, attention: p.attention, kpis });
  const composition = p.jobs.data ? outcomeComposition(p.jobs.data) : [];
  const board = p.hasHosted(OVERVIEW_KEY);
  const total = p.attention.data ? attentionTotal(p.attention.data) : 0;
  const recent = p.executions.data ? recentExecutions(p.executions.data, p.nowMs, RECENT_ROWS) : [];
  const refresh = p.daily.data ? refreshDays(p.daily.data, p.nowMs, TREND_DAYS) : null;
  const unobservedDays = trend.filter((d) => !d.observed).length;
  const trendRuns = trend.reduce((a, d) => a + d.succeeded + d.failed + d.other, 0);
  const jobsTotal = composition.reduce((a, c) => a + c.value, 0);

  const openGroup = (g: AttentionGroup) => {
    if (g.action.kind === "job") p.onSelectJob(g.action.job);
    else if (g.action.kind === "jobs") p.onOpenWorkspace(JOBS_VIEW);
    else if (board) p.onOpenDrawer("attention");
    else p.onOpenWorkspace(g.action.workspace);
  };

  // The detail doorways — each only where its detail is hosted.
  const more: { key: OperationsDrawer; label: string }[] = [];
  if (board) more.push({ key: "board", label: "Status board" });
  if (p.hasHosted("ops_convergence") || p.hasHosted("ops_timeline")) more.push({ key: "incidents", label: "Incidents" });
  if (p.hasHosted("ops_platform_health")) more.push({ key: "health", label: "Platform health" });
  if (board) more.push({ key: "activity", label: "Activity & usage" });

  const jobCount = p.jobs.data?.jobs.length ?? null;

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-ops-dashboard>
      {/* A — Health hero. */}
      <HealthHero model={{ ...hero, actions: {
        healthy: { label: "Open the Jobs list", onSelect: () => p.onOpenWorkspace(JOBS_VIEW) },
        attention: { label: "Show what needs attention", onSelect: () => goToSection("ops-attention") },
        runs: { label: "Show the execution trend", onSelect: () => goToSection("ops-trend") },
        success: { label: "Show succeeded and failed executions per day", onSelect: () => goToSection("ops-trend") },
      } }} />

      {/* B — Execution trend (7) · Outcome composition (5). */}
      <div className="grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
        <Block id="ops-trend" label="Execution trend" className="min-w-0 lg:col-span-7"
          action={<DayBarsLegend items={[{ label: "Succeeded", color: DAY_BAR_COLORS.succeeded }, { label: "Failed", color: DAY_BAR_COLORS.failed }]} />}>
          <Surface className="flex-1 p-4 sm:p-5">
            {p.history.data ? (
              <>
                <DayBars days={trend} ariaLabel="Job executions per UTC day" />
                <Caption>
                  {/* it2 — on Preview the bars can only be runs an operator started. */}
                  {evidence.state === "inactive" && evidence.preview
                    ? trendRuns > 0 ? "Manual runs only — scheduled jobs don't run on Preview" : "No executions — scheduled jobs don't run on Preview"
                    : evidence.state === "inactive" && trendRuns === 0
                    ? "No scheduled execution observed on this deployment"
                    : `${n(trendRuns)} executions · ${TREND_DAYS} UTC days${unobservedDays ? ` · ${unobservedDays} without data` : ""}`}
                </Caption>
              </>
            ) : (
              <p className="py-10 text-center text-xs text-[var(--text-muted)]">{p.history.loading ? "Reading execution history…" : `Execution history unavailable${p.history.error ? ` — ${p.history.error}` : ""}`}</p>
            )}
          </Surface>
        </Block>
        <Block id="ops-composition" label="Outcome composition" className="min-w-0 max-lg:hidden lg:col-span-5"
          action={<span className="text-[11px] text-[var(--text-faint)]">Jobs by last run</span>}>
          <Surface className="flex-1 p-4 sm:p-5">
            <BreakdownWidget
              items={composition}
              viewMode="donut"
              itemNoun="job"
              formatValue={(v) => n(v)}
              // it2 — the centre counts JOBS (Σ slices), not slices ("14 / jobs", never "14 / 2 jobs").
              centerTotal={{ value: jobsTotal, label: jobsTotal === 1 ? "job" : "jobs" }}
              centerTone="neutral"
              emptyHeadline={p.jobs.loading ? "Reading job health…" : p.jobs.error ? "Job health unavailable" : "No scheduled jobs reported"}
            />
          </Surface>
        </Block>
      </div>

      {/* C — Needs attention (6) · Refresh activity (6). */}
      <div className="grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
        <Block id="ops-attention" label="Needs attention" className="min-w-0 lg:col-span-6"
          action={board && total > 0 ? <Doorway label={`View all (${n(total)})`} onSelect={() => p.onOpenDrawer("attention")} dialog /> : undefined}>
          <Surface className="flex-1 px-4 py-2 sm:px-5">
            {p.attention.data ? (
              groups.length === 0 ? (
                <p className="py-3 text-xs text-[var(--text-muted)]">Nothing needs attention · {n(p.attention.data.authoritiesChecked.count)} sources checked</p>
              ) : (
                <ul aria-label="Needs attention" className="flex flex-col">
                  {groups.slice(0, ATTENTION_ROWS).map((g) => (
                    <li key={g.key} className="border-t border-[var(--border-hairline)] first:border-t-0">
                      <button type="button" onClick={() => openGroup(g)} aria-haspopup={g.action.kind === "attention" && board ? "dialog" : undefined}
                        className="group flex min-h-11 w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
                        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_COLOR[g.tone] }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{g.title}</span>
                          <span className="block truncate text-[11px] text-[var(--text-muted)]">{g.line}</span>
                        </span>
                        <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <p className="py-3 text-xs text-[var(--text-muted)]">{p.attention.loading ? "Reading attention…" : `Attention unavailable${p.attention.error ? ` — ${p.attention.error}` : ""}`}</p>
            )}
            {p.attention.data && p.attention.data.authoritiesFailed.length > 0 && (
              <p className="truncate border-t border-[var(--border-hairline)] py-2 text-[11px] text-[var(--accent-warning)]">
                {p.attention.data.authoritiesFailed.length} attention source(s) unread
              </p>
            )}
          </Surface>
        </Block>
        <Block id="ops-refresh" label="Refresh activity" className="min-w-0 max-lg:hidden lg:col-span-6"
          action={<Doorway label="Pipeline" onSelect={() => p.onOpenWorkspace(PIPELINE_VIEW)} />}>
          <Surface className="flex-1 p-4 sm:p-5">
            {refresh ? (
              <>
                <DayBars days={refresh} ariaLabel="Refresh executions per UTC day" height={160} />
                <Caption>
                  {`${n(refresh.filter((d) => d.observed).reduce((a, d) => a + d.succeeded + d.failed + d.other, 0))} refresh executions · ${TREND_DAYS} UTC days${p.daily.data!.floor ? " · a floor (capped read)" : ""}`}
                </Caption>
              </>
            ) : (
              <p className="py-10 text-center text-xs text-[var(--text-muted)]">{p.daily.loading ? "Reading refresh activity…" : `Refresh activity unavailable${p.daily.error ? ` — ${p.daily.error}` : ""}`}</p>
            )}
          </Surface>
        </Block>
      </div>

      {/* D — the unified Jobs list. */}
      {p.hasHosted(JOBS_KEY) && (
        <Block id="ops-jobs" label="Jobs"
          action={<Doorway label={jobCount !== null ? `See all ${jobCount}` : "See all"} onSelect={() => p.onOpenWorkspace(JOBS_VIEW)} />}>
          {p.jobsSlot}
        </Block>
      )}

      {/* E — Recent activity. */}
      <Block id="ops-activity" label="Recent activity" action={<Doorway label="Pipeline" onSelect={() => p.onOpenWorkspace(PIPELINE_VIEW)} />}>
        <Surface className="px-4 py-2 sm:px-5">
          {recent.length > 0 ? (
            <ul aria-label="Recent activity" className="flex flex-col">
              {recent.map((r) => (
                <li key={r.id} className="border-t border-[var(--border-hairline)] first:border-t-0">
                  <button type="button" aria-haspopup="dialog" onClick={() => p.onSelectExecution({ id: r.id, eyebrow: r.eyebrow, title: r.name })}
                    className="group flex min-h-11 w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{r.name}</span>
                    <StatusWord word={r.status.word} tone={r.status.tone} className="shrink-0" />
                    <span className="hidden shrink-0 text-[11px] tabular-nums text-[var(--text-muted)] sm:inline">{r.summary}</span>
                    <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-xs text-[var(--text-muted)]">
              {p.executions.loading ? "Reading recent executions…" : p.executions.error ? `Executions unavailable — ${p.executions.error}` : "No executions recorded yet."}
            </p>
          )}
        </Surface>
      </Block>

      {more.length > 0 && (
        <nav aria-label="Operations detail" className="flex flex-wrap items-center gap-x-4">
          {more.map((m) => <Doorway key={m.key} label={m.label} onSelect={() => p.onOpenDrawer(m.key)} dialog />)}
        </nav>
      )}
    </div>
  );
}

const DRAWER_TITLE: Record<OperationsDrawer, string> = {
  attention: "Needs attention",
  board: "Status board",
  incidents: "Incidents",
  health: "Platform health",
  activity: "Activity & usage",
};

export function OperationsLead({ renderHosted, hasHosted, onOpenWorkspace, access }: PlatformViewLeadProps) {
  const overview = useSharedWidgetFetch<OperationsOverview>("/api/platform/platform-ops/overview");
  const attention = useSharedWidgetFetch<AttentionResponse>("/api/platform/platform-ops/attention");
  const jobs = useSharedWidgetFetch<PlatformJobHealthResponse>(JOBS_URL);
  const scheduler = useSharedWidgetFetch<SchedulerObservationResponse>(SCHEDULER_URL);
  const history = useSharedWidgetFetch<OperationalHistoryResult>(HISTORY_URL);
  const daily = useSharedWidgetFetch<RefreshDailySeries>("/api/platform/platform-ops/refresh/daily");
  const executions = useSharedWidgetFetch<ExecutionPageDTO>("/api/platform/platform-ops/refresh/executions?limit=5");
  // Same URL as the unified jobs card (shared session fetch — one request).
  const operations = useSharedWidgetFetch<{ recent?: { startedAt: string }[] }>(OPERATIONS_URL);
  // it2 — the deployment environment (shared with the jobs card: one request).
  const envStatus = useSharedWidgetFetch<{ deploymentEnv?: string }>(ENV_STATUS_URL);
  // One clock read per mount (relative ages + the day axis), never during render.
  const [nowMs] = useState(() => Date.now());
  const [drawer, setDrawer] = useState<OperationsDrawer | null>(null);
  const [execution, setExecution] = useState<ExecutionSelection | null>(null);
  const [job, setJob] = useState<string | null>(null);

  // A doorway inside a drawer closes the drawer, then moves the rail.
  const go = (id: string) => { setDrawer(null); onOpenWorkspace(id); };
  const shared = { onOpenWorkspace: go, access };

  let body: ReactNode = null;
  switch (drawer) {
    case "attention": body = hasHosted(OVERVIEW_KEY) ? <AttentionBlock {...shared} /> : null; break;
    case "board":     body = hasHosted(OVERVIEW_KEY) ? <div className="flex flex-col gap-8"><StatusBoard title="Status board" {...shared} /><ConnectionHealthBlock {...shared} /></div> : null; break;
    case "incidents": body = <div className="flex flex-col gap-8">{renderHosted("ops_convergence", go)}{renderHosted("ops_timeline", go)}</div>; break;
    case "health":    body = renderHosted("ops_platform_health", go); break;
    case "activity":  body = hasHosted(OVERVIEW_KEY) ? (
      <div className="flex flex-col gap-8">
        <JobsMatrixBlock {...shared} />
        <RefreshActivityBlock {...shared} />
        <AiActivityBlock {...shared} />
        <EconomicsBlock {...shared} />
        <ActivityFeedBlock {...shared} />
      </div>
    ) : null; break;
  }

  return (
    <>
      <OperationsLeadSurface
        overview={overview} attention={attention} jobs={jobs} scheduler={scheduler} history={history} daily={daily} executions={executions}
        nowMs={nowMs} hasHosted={hasHosted} manualStarts={operations.data?.recent?.map((r) => r.startedAt) ?? null}
        deploymentEnv={envStatus.data?.deploymentEnv ?? null}
        jobsSlot={<UnifiedJobs mode="summary" access={access} nowMs={nowMs} selected={job} onSelect={setJob} />}
        onOpenDrawer={setDrawer} onOpenWorkspace={onOpenWorkspace} onSelectExecution={setExecution}
        onSelectJob={(j) => (hasHosted(JOBS_KEY) ? setJob(j) : onOpenWorkspace(JOBS_VIEW))}
      />
      <DetailDrawer open={drawer !== null} onClose={() => setDrawer(null)} eyebrow="Operations" title={drawer ? DRAWER_TITLE[drawer] : ""} size="xl">
        {body}
      </DetailDrawer>
      <ExecutionTimelinePanel executionId={execution?.id ?? null} eyebrow={execution?.eyebrow ?? ""} title={execution?.title ?? ""} onClose={() => setExecution(null)} />
    </>
  );
}
