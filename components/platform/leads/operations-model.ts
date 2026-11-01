/**
 * components/platform/leads/operations-model.ts  (Platform Operations 2.0 — R2, plan §4.2)
 *
 * PURE view-model behind the Operations lead. No React, no fetch, no clock
 * (the caller injects `nowMs`). Every verdict, word and count is the answering
 * route's own:
 *
 *   status header   /platform-ops/overview  (worst domain state + its words),
 *                   /platform-ops/attention (counts), /platform-ops/convergence
 *                   (episodes without a recorded recovery = "open incidents")
 *   attention       /platform-ops/attention — the server's order, top N, never re-sorted
 *   jobs KPIs       /platform-ops/scheduler (runs recorded in its 24 h window) and
 *                   /platform-ops/job-health (the route's own status counts)
 *   recent          /platform-ops/refresh/executions?limit=5 (newest first)
 *
 * A source that did not answer yields `null` (rendered as "—" + the reason),
 * never a zero and never a healthy word.
 */

import type { StatusTone } from "../platform-surface";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import type { AttentionItem } from "@/lib/platform/ops/attention-core";
import type { ConvergenceResult } from "@/lib/platform/convergence/types";
import type { PlatformJobHealthResponse } from "@/app/api/platform/platform-ops/job-health/route";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";
import type { ExecutionPageDTO, ExecutionRowDTO } from "@/lib/platform/refresh/execution-query-core";
import { STATE_TONE, STATE_WORD, overallWord } from "../widgets/ops-overview-view";
import { SEVERITY_TONE, SEVERITY_WORD, actionLabel } from "../widgets/overview/attention-view";
import { resolvePlatformDestination } from "@/lib/platform/workspaces";
import { describeSource, describeTrigger } from "../widgets/execution-format";
import { formatDuration } from "../widgets/refresh-format";
import { executionDisplayStatus } from "../widgets/refresh-activity-view";
import { relTime } from "../widgets/job-health-format";

/** A fetched source as the house hooks return it. */
export interface Fetched<T> { data: T | null; loading: boolean; error: string | null }

/** Default-screen caps (plan §3: default sections show 3–5 items). */
export const ATTENTION_LIMIT = 5;
export const RECENT_LIMIT = 5;

/** The scheduler's bounded ledger read (lib/platform/scheduler/observation.ts MAX_RUNS):
 *  a window count equal to it is a FLOOR, worded "≥". */
export const SCHEDULER_RUN_CAP = 2_000;

const n = (v: number) => v.toLocaleString("en-US");
const unread = <T,>(f: Fetched<T>, what: string): string =>
  f.loading ? "reading…" : `${what} unavailable${f.error ? ` — ${f.error}` : ""}`;

// ── Status header ────────────────────────────────────────────────────────────

export interface StatusModel {
  verdict: { word: string; tone: StatusTone };
  title: string;
  checkedAt: string | null;
  facts: { label: string; value: string; tone?: StatusTone }[];
  /** Domains that are not HEALTHY, worded "Brief: Failed" — the drill-down's teaser. */
  notHealthy: string[];
}

/** Episodes without a recorded recovery — the convergence authority's own field, counted. */
export function openIncidentCount(c: ConvergenceResult): number {
  return c.episodes.filter((e) => !e.narrative.recovered).length;
}

export function attentionTotal(a: AttentionResponse): number {
  return Object.values(a.counts).reduce<number>((x, y) => x + (y ?? 0), 0);
}

export function statusModel(
  overview: Fetched<OperationsOverview>,
  attention: Fetched<AttentionResponse>,
  convergence: Fetched<ConvergenceResult>,
): StatusModel {
  const o = overview.data;
  const verdict = o
    ? { word: STATE_WORD[o.worst], tone: STATE_TONE[o.worst] }
    : { word: overview.loading ? "Reading" : "Unknown", tone: "muted" as StatusTone };
  const title = o ? overallWord(o.worst) : overview.loading ? "Reading the platform's verdicts…" : `Health cannot be established — ${unread(overview, "the overview")}`;

  const facts: StatusModel["facts"] = [];
  if (attention.data) {
    const t = attentionTotal(attention.data);
    facts.push({ label: "Needs attention", value: n(t), tone: t > 0 ? "warn" : undefined });
  } else facts.push({ label: "Needs attention", value: "—", tone: "muted" });
  if (convergence.data) {
    const open = openIncidentCount(convergence.data);
    facts.push({ label: "Open incidents", value: n(open), tone: open > 0 ? "warn" : undefined });
  } else facts.push({ label: "Open incidents", value: "—", tone: "muted" });
  for (const key of ["jobs", "pipeline"] as const) {
    const d = o?.domains.find((x) => x.key === key);
    facts.push(d
      ? { label: key === "jobs" ? "Scheduled jobs" : "Refresh pipeline", value: d.figure.value, tone: STATE_TONE[d.state] === "ok" ? undefined : STATE_TONE[d.state] }
      : { label: key === "jobs" ? "Scheduled jobs" : "Refresh pipeline", value: "—", tone: "muted" });
  }
  const notHealthy = (o?.domains ?? []).filter((d) => d.state !== "HEALTHY").map((d) => `${d.title}: ${STATE_WORD[d.state]}`);
  return { verdict, title, checkedAt: o?.checkedAt ?? null, facts, notHealthy };
}

// ── Attention queue ──────────────────────────────────────────────────────────

export interface AttentionRowModel {
  key: string;
  severity: { word: string; tone: StatusTone };
  title: string;
  why: string;
  meta?: string;
  /** The ONE next action, worded from the item's first action (the server's order). */
  nextLabel: string;
  /** Where the item's evidence lives (a workspace / view id, possibly a retired alias). */
  workspace: string;
}

/** The server's order, top `limit`. The label names the item's own first action. */
export function attentionRows(a: AttentionResponse, nowMs: number, limit = ATTENTION_LIMIT): AttentionRowModel[] {
  return a.items.slice(0, limit).map((it: AttentionItem) => {
    const first = it.actions[0];
    const label = first
      ? actionLabel(first, first.kind === "open-workspace" ? resolvePlatformDestination(first.workspace)?.label ?? null : null)
      : "Review";
    return {
      key: it.id,
      severity: { word: SEVERITY_WORD[it.severity], tone: SEVERITY_TONE[it.severity] },
      title: it.entity.label,
      why: it.problem,
      meta: it.since ? `since ${relTime(it.since, nowMs)}` : undefined,
      nextLabel: label,
      workspace: it.evidence.workspace,
    };
  });
}

/** "Attention sources that could not be read" — never folded into "nothing to do". */
export function attentionNotes(a: Fetched<AttentionResponse>): string[] {
  if (!a.data) return a.loading ? [] : [unread(a, "Attention")];
  const out: string[] = [];
  if (a.data.authoritiesFailed.length > 0) out.push(`${a.data.authoritiesFailed.length} attention source(s) could not be read (${a.data.authoritiesFailed.join(", ")}).`);
  return out;
}

// ── Jobs & activity ──────────────────────────────────────────────────────────

export interface KpiModel {
  key: string;
  label: string;
  value: string | null;
  unavailableReason?: string;
  note?: string;
  tone?: StatusTone;
}

export function jobKpis(jobs: Fetched<PlatformJobHealthResponse>, scheduler: Fetched<SchedulerObservationResponse>): KpiModel[] {
  const s = scheduler.data;
  const c = jobs.data?.counts;
  const jobsReason = unread(jobs, "job health");
  const runs = s?.observed.recordedExecutions ?? null;
  return [
    {
      key: "runs",
      label: "Runs · 24 h",
      value: runs === null ? null : runs >= SCHEDULER_RUN_CAP ? `≥${n(SCHEDULER_RUN_CAP)}` : n(runs),
      unavailableReason: unread(scheduler, "scheduler"),
      note: s ? "recorded job executions" : undefined,
    },
    { key: "failing", label: "Failing", value: c ? n(c.failing + c.dead) : null, unavailableReason: jobsReason, note: c ? "failing or dead jobs" : undefined, tone: c && c.failing + c.dead > 0 ? "bad" : undefined },
    { key: "overdue", label: "Overdue", value: c ? n(c.overdue) : null, unavailableReason: jobsReason, note: c ? "against their cadence" : undefined, tone: c && c.overdue > 0 ? "warn" : undefined },
    { key: "running", label: "Running", value: c ? n(c.running) : null, unavailableReason: jobsReason, note: c ? `${n(c.neverRan)} never ran` : undefined },
  ];
}

export interface RecentExecutionModel {
  id: string;
  name: string;
  status: { word: string; tone: StatusTone };
  summary: string;
  eyebrow: string;
}

export function recentExecutions(page: ExecutionPageDTO, nowMs: number, limit = RECENT_LIMIT): RecentExecutionModel[] {
  return page.rows.slice(0, limit).map((row: ExecutionRowDTO) => {
    const source = describeSource(row);
    const trigger = describeTrigger(row.trigger);
    // PB-7 — a reaped execution a later success superseded reads Recovered, not Failed.
    const shown = executionDisplayStatus(row);
    return {
      id: row.id,
      name: source.label,
      status: { word: shown.word, tone: shown.tone },
      summary: `${trigger} · ${relTime(row.startedAt, nowMs)} · ${formatDuration(row.durationMs)}`,
      eyebrow: `${source.kind} · ${trigger} · ${shown.word}`,
    };
  });
}
