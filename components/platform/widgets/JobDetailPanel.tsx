"use client";

/**
 * components/platform/widgets/JobDetailPanel.tsx  (S4 · the Jobs surface)
 *
 * JOB DETAIL — inspecting one scheduled job.
 *
 * The prototype's `JobDetail.tsx`, on production primitives: an Atlas
 * `RightPanel` (Panel = inspect, Modal = decide — the fleet stays behind you
 * while you read), a `SegmentedControl` carrying Overview · Controls · Decision
 * log, and one `PanelSection` per group with `KeyRow`s on a single plane.
 *
 * ── NO SECOND FETCH, AND WHY ─────────────────────────────────────────────────
 * Every figure this panel shows is already on the `PlatformJobRow` the operator
 * clicked, so the row is passed down and nothing is requested. That is not a
 * shortcut — it is the honest option. `useWidgetFetch` is contractually
 * STATIC-URL ONLY (widget-fetch-static-url.test.ts), and the sanctioned escape
 * for a per-object resource is `ExecutionTimelinePanel`'s keyed remount. Neither
 * applies here: there is no per-job route to call. Inventing one would be a new
 * API surface, and calling the fleet route again would re-fetch data the caller
 * already holds and let the panel disagree with the table behind it.
 *
 * The panel content is keyed on the job name so selecting another job resets the
 * tab — the same remount discipline, applied to state instead of to a url.
 *
 * ── WHAT IS MISSING, AND WHY IT IS STILL HERE ────────────────────────────────
 * The prototype's Controls tab writes to a `JobControlState`; its Decision log
 * reads an append-only operator record; its Policy section edits a cadence. NONE
 * of those authorities exist. They are not simulated, and the tabs are not
 * deleted either — a two-segment control would be a different surface, and an
 * operator who cannot find "Controls" cannot learn that the capability is
 * missing. Each renders the absence in a sentence instead.
 *
 * The footer's "Run now" is rendered DISABLED for the same reason: the button is
 * part of the shape the lead is comparing against, and a disabled control whose
 * accessible name states the missing authority cannot be mistaken for a live one.
 */

import { useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { GlassButton } from "@/components/atlas/GlassButton";
import {
  KeyRow,
  PanelSection,
  Provenance,
  StatusBadge,
  Unavailable,
  NO_AUTHORITY,
  TONE_COLOR,
} from "../platform-surface";
import { fmtDuration, fmtPercent, relTime } from "./job-health-format";
import {
  NOT_ON_RESPONSE_REASON,
  NO_COMMANDS_REASON,
  NO_CONTROL_AUTHORITY_NOTE,
  NO_RUN_SERIES_NOTE,
  NO_SLOT_REASON,
  NEVER_RAN_REASON,
  POLICY_UNRECORDED_NOTE,
  POLICY_UNRECORDED_REASON,
  cadenceLine,
  fmtUtc,
  jobSource,
} from "./jobs-view";
import type { PlatformJobRow } from "@/app/api/platform/platform-ops/job-health/route";

export type JobDetailTab = "overview" | "controls" | "log";

const TABS: { id: JobDetailTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "controls", label: "Controls" },
  { id: "log", label: "Decision log" },
];

/** A muted sentence — the panel's form of `Unavailable` when a whole group is absent. */
function AbsentNote({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{children}</p>;
}

/**
 * The panel's body: the verdict line plus one tab's sections.
 *
 * Split out and exported for the same reason `ExecutionTimelinePanel` splits
 * `TimelineBody` — `RightPanel` renders through a portal and returns null until
 * it has mounted, so the only way to assert this content is to render it
 * directly. Pure: `nowMs` is injected, nothing is fetched, no clock is read
 * unless the caller declines to supply one.
 */
export function JobDetailBody({
  job,
  tab,
  nowMs,
}: {
  job: PlatformJobRow;
  tab: JobDetailTab;
  /** Injected clock. Omitted in production: the formatter reads the wall clock itself. */
  nowMs?: number;
}) {
  const source = jobSource(job);
  const next = fmtUtc(job.nextExpectedAt, true);
  const last = fmtUtc(job.lastStartedAt, true);

  return (
    <div className="flex flex-col gap-5">
      {/*
        VERDICT. The prototype renders an Operational Policy Resolver's own
        sentence — "will this job run, and when". No resolver exists here, and
        the health status is a different question (what HAPPENED, not what is
        permitted), so the slot states the gap instead of borrowing the status
        word to fill it.
      */}
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="rounded-full"
            style={{ width: 6, height: 6, background: TONE_COLOR.muted }}
          />
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Whether this job may run is not recorded
          </span>
        </span>
        <span className="pl-3.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {POLICY_UNRECORDED_NOTE}
        </span>
        <span className="pl-3.5 text-[10px] text-[var(--text-faint)]">
          No operational policy resolver · health below is observed, from the JobRun ledger
        </span>
      </div>

      {tab === "overview" && (
        <>
          {/*
            POLICY leads, because "will it run" is the first question an operator
            asks — even when, as here, the answer is that nobody records it.
            Cadence sits alongside it: both answer "what has been declared".
          */}
          <PanelSection title="Policy">
            <KeyRow label="Policy" value={<Unavailable reason={POLICY_UNRECORDED_REASON} />} />
            <KeyRow label="Cadence" value={cadenceLine(job)} />
            <KeyRow
              label="Next expected"
              value={next ?? <Unavailable reason={NO_SLOT_REASON} />}
            />
            <KeyRow
              label="Source"
              value={<Provenance source={source ?? NO_AUTHORITY} />}
            />
            <AbsentNote>
              Cadence is declared in code (<span className="font-mono text-[10px]">lib/jobs/registry.ts</span>{" "}
              plus the <span className="font-mono text-[10px]">vercel.json</span> tick) and changing it
              requires a deployment. Holding this job is not possible at all — see Controls.
            </AbsentNote>
          </PanelSection>

          {/* HEALTH — what happened. Every figure is the ledger's. */}
          <PanelSection title="Health">
            <KeyRow label="Status" value={<StatusBadge status={job.status} />} />
            <KeyRow label="Success rate (window)" value={fmtPercent(job.successRate)} />
            {/*
              The route's field is `consecutiveFailures` — the CURRENT leading
              streak, counted from the newest run backwards. The prototype's
              label reads "Longest failure streak", which this number is not.
            */}
            <KeyRow label="Consecutive failures" value={String(job.consecutiveFailures)} />
            <KeyRow label="Last runtime" value={fmtDuration(job.lastRuntimeMs)} />
            <KeyRow label="Average runtime" value={fmtDuration(job.avgRuntimeMs)} />
            <KeyRow
              label="Last error"
              value={
                job.lastFailureAt ? (
                  <span style={{ color: TONE_COLOR.bad }}>
                    {job.lastFailureSummary ?? "no summary recorded"}
                  </span>
                ) : (
                  <Unavailable reason="no failure in window" />
                )
              }
            />
          </PanelSection>

          {/*
            RECENT EXECUTIONS. The prototype draws an execution strip over the
            last N JobRun rows. This response has no run list, so the window's
            aggregates are shown and the chart is refused in words.
          */}
          <PanelSection
            title="Recent executions"
            action={
              <span className="text-[10px] text-[var(--text-muted)]">window {job.totalRuns}</span>
            }
          >
            <KeyRow label="Runs in window" value={`${job.succeededRuns}/${job.totalRuns}`} />
            <KeyRow label="Failed" value={String(job.failedRuns)} />
            <KeyRow label="Manual runs" value={String(job.manualRuns)} />
            <KeyRow
              label="Last recorded execution"
              value={last ?? <Unavailable reason={NEVER_RAN_REASON} />}
            />
            <KeyRow
              label="Last failure"
              value={
                job.lastFailureAt ? (
                  `${fmtUtc(job.lastFailureAt, true)} · ${relTime(job.lastFailureAt, nowMs)}`
                ) : (
                  <Unavailable reason="no failure in window" />
                )
              }
            />
            <AbsentNote>{NO_RUN_SERIES_NOTE}</AbsentNote>
          </PanelSection>

          {/* RUNTIME. Same absence, stated once more where the sparkline would be. */}
          <PanelSection title="Runtime">
            <KeyRow label="Last" value={fmtDuration(job.lastRuntimeMs)} />
            <KeyRow label="Average (succeeded runs)" value={fmtDuration(job.avgRuntimeMs)} />
            <AbsentNote>
              No run-by-run duration series is recorded on this response, so there is no trend to
              draw — only the two figures above.
            </AbsentNote>
          </PanelSection>

          {/* METADATA — the facts an operator needs to go and read the code. */}
          <PanelSection title="Metadata">
            <KeyRow
              label="Job key"
              value={<span className="font-mono text-[11px]">{job.job}</span>}
            />
            <KeyRow label="Handler" value={<Unavailable reason={NOT_ON_RESPONSE_REASON} />} />
            <KeyRow
              label="Declared in"
              value={<Provenance source={source ?? NO_AUTHORITY} />}
            />
            {/*
              Every row on this surface came from `SCHEDULED_JOBS` — the health
              authority iterates the registry and reports nothing else — so
              "registered" is true by construction rather than by a flag. A job
              running outside the registry never reaches this panel; the
              Scheduler surface is where the ledger's unregistered jobs surface.
            */}
            <KeyRow label="Registered" value="Yes — reported by the job registry" />
            <KeyRow label="Last deploy" value={<Unavailable reason={NOT_ON_RESPONSE_REASON} />} />
          </PanelSection>
        </>
      )}

      {tab === "controls" && (
        <>
          <PanelSection title="Blast radius">
            <AbsentNote>
              No blast radius is declared for this job. Scope is a property of a command, and no
              command exists.
            </AbsentNote>
          </PanelSection>

          <PanelSection title="Commands">
            <AbsentNote>{NO_CONTROL_AUTHORITY_NOTE}</AbsentNote>
            <AbsentNote>
              The dispatcher reads the registry at its next tick. Platform Operations never reaches
              into a running scheduler — and today it declares nothing to it either.
            </AbsentNote>
          </PanelSection>
        </>
      )}

      {tab === "log" && (
        <PanelSection title="Decision log">
          <AbsentNote>{NO_CONTROL_AUTHORITY_NOTE}</AbsentNote>
        </PanelSection>
      )}
    </div>
  );
}

/** Tab state + body. Keyed on the job name by the panel, so opening another job resets the tab. */
function JobDetailContent({ job, onClose }: { job: PlatformJobRow; onClose: () => void }) {
  const [tab, setTab] = useState<JobDetailTab>("overview");

  return (
    <>
      <PanelHeader
        eyebrow="Scheduled job"
        title={job.job}
        actions={<StatusBadge status={job.status} />}
      />
      <PanelContent>
        <div className="flex flex-col gap-5">
          <SegmentedControl
            aria-label="Job detail section"
            options={TABS}
            value={tab}
            onChange={setTab}
          />
          <JobDetailBody job={job} tab={tab} />
        </div>
      </PanelContent>
      <PanelFooter>
        <div className="flex gap-2">
          <GlassButton tone="neutral" size="sm" fullWidth onClick={onClose}>
            Close
          </GlassButton>
          <GlassButton
            tone="meridian"
            size="sm"
            fullWidth
            disabled
            title={NO_COMMANDS_REASON}
            aria-label={`Run ${job.job} now — unavailable: ${NO_COMMANDS_REASON}`}
          >
            <Play size={13} aria-hidden /> Run now
          </GlassButton>
        </div>
      </PanelFooter>
    </>
  );
}

export function JobDetailPanel({
  job,
  onClose,
}: {
  /** The job being inspected, or null when the panel is closed. */
  job: PlatformJobRow | null;
  onClose: () => void;
}) {
  return (
    <RightPanel open={job != null} onClose={onClose} size="lg">
      {job && <JobDetailContent key={job.job} job={job} onClose={onClose} />}
    </RightPanel>
  );
}
