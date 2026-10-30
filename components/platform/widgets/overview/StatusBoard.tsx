"use client";

/**
 * components/platform/widgets/overview/StatusBoard.tsx  (UX-P1 · Agent 2)
 *
 * IS FOURTH MERIDIAN HEALTHY? — the Overview's first block, over the ONE
 * request GET /api/platform/platform-ops/overview.
 *
 * Six domain tiles (pipeline · sources · jobs · Brief · AI · Plaid), each a
 * verdict WORD in its tone, ONE server-chosen figure, one qualifier and a
 * doorway; then a posture row (Alerts · Providers · Freshness · Configuration)
 * folded from the four Platform Health groups; then a "Technical details"
 * disclosure holding every basis string, window, headline and the newest
 * failed executions (each opening the same inspection panel the Pipeline
 * workspace uses). Nothing on the board outside that disclosure names a table,
 * a module or a path.
 *
 * Presentation only: every word, tone, figure and qualifier is the server's
 * (lib/platform/ops/overview-core.ts). This file folds nothing, never turns
 * absence into zero, and never paints UNKNOWN green. `StatusBoardSurface` is
 * prop-driven so every state is renderable in a test; `StatusBoard` fetches.
 */

import { useState } from "react";
import { Activity, ArrowUpRight } from "lucide-react";
import { WidgetMessage, timeAgo, useWidgetFetch } from "../../widget-kit";
import { GroupLabel, SectionSurface, StatusTile, StatusWord, ToneBadge } from "../../platform-surface";
import { platformViewTarget, resolvePlatformDestination } from "@/lib/platform/workspaces";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import { OVERVIEW_FOOTNOTE, POSTURE_TONE, STATE_TOKEN, STATE_TONE, STATE_WORD, overallWord, policyStrip, postureDoorwayLabel } from "../ops-overview-view";
import { ExecutionTimelinePanel } from "../ExecutionTimelinePanel";
import { formatDuration, humanizeToken } from "../refresh-format";
import { describeCategory, describeSource, describeTrigger } from "../execution-format";
import type { StatusBoardProps } from "./block-contract";

interface ExecutionSelection { id: string; eyebrow: string; title: string }

const DOORWAY_CLASS =
  "inline-flex items-center gap-1 rounded-[var(--radius-xs)] text-[11px] text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]";

/** The prop-driven board. `checkedAgo` is injected so the surface reads no clock. */
export function StatusBoardSurface({
  title,
  data,
  checkedAgo,
  onOpenWorkspace,
  onSelectExecution,
}: {
  title: string;
  data: OperationsOverview;
  /** "12s" / "3m" — the caller's clock, never read here. */
  checkedAgo: string;
  onOpenWorkspace?: (workspaceId: string) => void;
  onSelectExecution?: (selection: ExecutionSelection) => void;
}) {
  // PLATFORM OPS PHASE 1 UX — the refresh policy lives in Policies › Platform defaults.
  const policiesTarget = platformViewTarget("platform-policies", "defaults");
  const policiesWorkspace = resolvePlatformDestination(policiesTarget);

  return (
    <SectionSurface icon={Activity} title={title} footnote={OVERVIEW_FOOTNOTE}>
      {/* The one-line answer; the policy in force beside it with its doorway. */}
      <div className="mb-8 flex flex-col gap-3 md:flex-row md:items-baseline md:justify-between md:gap-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <StatusWord word={STATE_WORD[data.worst]} token={STATE_TOKEN[data.worst]} />
          <span className="text-sm text-[var(--text-secondary)]">{overallWord(data.worst)}</span>
          <span className="text-[11px] text-[var(--text-muted)]">checked {checkedAgo} ago</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-muted)]">
          <span>{policyStrip(data.policies)}</span>
          {onOpenWorkspace && policiesWorkspace && (
            <button
              type="button"
              onClick={() => onOpenWorkspace(policiesTarget)}
              aria-label={`${policiesWorkspace.label} — open the workspace behind the refresh policy`}
              className={DOORWAY_CLASS}
            >
              {policiesWorkspace.label} <ArrowUpRight size={11} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* Six domains. Word + tone from the state; figure + qualifier from the server. */}
      <div className="grid gap-x-8 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
        {data.domains.map((d) => {
          const target = resolvePlatformDestination(d.workspace);
          const wired = onOpenWorkspace && target;
          return (
            <StatusTile
              key={d.key}
              label={d.title}
              word={STATE_WORD[d.state]}
              tone={STATE_TONE[d.state]}
              figure={d.figure.value}
              qualifier={d.figure.qualifier}
              hint={d.headline}
              onOpen={wired ? () => onOpenWorkspace(d.workspace) : undefined}
              openLabel={wired ? target.label : undefined}
            />
          );
        })}
      </div>

      {/* Posture: the four Platform Health groups as word + count + doorway. */}
      <div className="mt-10 grid gap-x-8 gap-y-5 border-t pt-6 sm:grid-cols-2 xl:grid-cols-4" style={{ borderColor: "var(--border-hairline)" }}>
        {data.posture.map((chip) => {
          const target = resolvePlatformDestination(chip.workspace);
          return (
            <div key={chip.key} className="flex min-w-0 flex-col gap-1.5">
              <GroupLabel>{chip.label}</GroupLabel>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <ToneBadge word={chip.word} tone={POSTURE_TONE[chip.tone]} />
                <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{chip.count}</span>
              </div>
              {onOpenWorkspace && target && (
                <button
                  type="button"
                  onClick={() => onOpenWorkspace(chip.workspace)}
                  aria-label={postureDoorwayLabel(target.label, chip)}
                  className={`${DOORWAY_CLASS} self-start`}
                >
                  {target.label} <ArrowUpRight size={11} aria-hidden />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Everything an operator asks "what says that?" about, in one disclosure. */}
      <details className="mt-8">
        <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]">
          Technical details
        </summary>
        <div className="mt-3 flex flex-col gap-4 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          <p>
            Windows: pipeline {data.windows.pipeline} · AI {data.windows.ai} · Brief {data.windows.brief} ·
            next due slot {data.nextSlotAt ? `${data.nextSlotAt.slice(0, 16).replace("T", " ")} UTC` : "not derivable"} ·
            policy origin bank {data.policies.bankOrigin} / wallet {data.policies.walletOrigin}.
          </p>
          <ul className="flex flex-col gap-1.5">
            {data.domains.map((d) => (
              <li key={d.key}>
                <span className="font-medium text-[var(--text-primary)]">{d.title}</span> — {d.headline}{" "}
                <span className="text-[var(--text-faint)]">from {d.basis}</span>
              </li>
            ))}
            {data.posture.map((chip) => (
              <li key={chip.key}>
                <span className="font-medium text-[var(--text-primary)]">{chip.label}</span> — {chip.word}, {chip.count}
                {chip.state === "unavailable" ? " (the authority could not be asked; this is not a report that nothing is wrong)" : ""}{" "}
                <span className="text-[var(--text-faint)]">from {chip.basis}</span>
              </li>
            ))}
          </ul>
          <div>
            <span className="font-medium text-[var(--text-primary)]">Latest failed executions</span>
            {data.latestFailures.length === 0 ? (
              <p className="mt-1">None failed or partial in the pipeline window.</p>
            ) : (
              <ul className="mt-1 flex flex-col">
                {data.latestFailures.map((row) => {
                  const source = describeSource(row);
                  const category = describeCategory(row.failureCategory);
                  const detail = `${row.failureStage ? `failed at ${row.failureStage}` : humanizeToken(row.overallStatus)}${category ? ` · ${category}` : ""} · ${formatDuration(row.durationMs)} · ${row.startedAt.slice(0, 16).replace("T", " ")} UTC`;
                  return (
                    <li key={row.id} className="border-b py-1.5 last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
                      {onSelectExecution ? (
                        <button
                          type="button"
                          onClick={() => onSelectExecution({ id: row.id, eyebrow: `${source.kind} · ${describeTrigger(row.trigger)} · ${humanizeToken(row.overallStatus)}`, title: source.label })}
                          aria-label={`Inspect failed execution of ${source.label}`}
                          className="w-full rounded-[var(--radius-xs)] text-left transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
                        >
                          <span className="font-medium text-[var(--text-primary)]">{source.label}</span> · {describeTrigger(row.trigger)} · {detail}
                        </button>
                      ) : (
                        <span><span className="font-medium text-[var(--text-primary)]">{source.label}</span> · {describeTrigger(row.trigger)} · {detail}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </details>
    </SectionSurface>
  );
}

export function StatusBoard({ title, onOpenWorkspace }: StatusBoardProps) {
  const { data, loading, error } = useWidgetFetch<OperationsOverview>("/api/platform/platform-ops/overview");
  const [selected, setSelected] = useState<ExecutionSelection | null>(null);

  if (loading || error || !data) {
    return (
      <SectionSurface icon={Activity} title={title}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }

  return (
    <>
      <StatusBoardSurface
        title={title}
        data={data}
        checkedAgo={timeAgo(data.checkedAt)}
        onOpenWorkspace={onOpenWorkspace}
        onSelectExecution={setSelected}
      />
      <ExecutionTimelinePanel
        executionId={selected?.id ?? null}
        eyebrow={selected?.eyebrow ?? ""}
        title={selected?.title ?? ""}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
