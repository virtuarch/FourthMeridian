"use client";

/**
 * components/platform/widgets/OpsSchedulerWidget.tsx  (OPS-2C-7 · PM-1 S3)
 *
 * Scheduler OBSERVATION, over GET /api/platform/platform-ops/scheduler
 * (requirePlatformAccess PLATFORM_OPS READ).
 *
 * ── THIS SLICE: THE PROTOTYPE'S LAYOUT, THE PRODUCTION ROUTE'S DATA ──────────
 * The prototype (`prototype-ops-control-plane/Scheduler.tsx`) is the UI
 * authority; this route is the DATA authority. The widget is now the
 * prototype's surface — ONE `SectionSurface` holding THREE columns separated by
 * `VRule`, each column led by a headline `BigStat` — rather than the paragraph
 * stack that rendered the same facts at the same weight as their own captions.
 * Nothing about what may be claimed changed; only what the eye lands on first.
 *
 * ── THE THREE COLUMNS ARE AN EPISTEMIC CLAIM, NOT A LAYOUT PREFERENCE ────────
 *
 *     OBSERVED   values read out of a ledger. Nothing derived may appear here.
 *     EXPECTED   values derived from configuration. Nothing recorded may appear.
 *     NOTES      prose, where prose is what actually prevents the mistake.
 *
 * The dispatcher does not record its own invocations, so "last recorded
 * execution" is MAX(JobRun.startedAt) — a run, not a tick — and a dispatcher
 * that silently stopped looks identical to one that fired with nothing due.
 * Putting that time beside "next dispatcher slot" without saying which is
 * measured and which is predicted is exactly how an operator concludes the
 * scheduler is alive when it is not. Every figure carries its derivation.
 *
 * ── WHAT THIS WIDGET REFUSES TO RENDER ───────────────────────────────────────
 *   • No scheduler health, no "dispatcher OK", no green roll-up — no such
 *     authority exists, and a green badge over an unmeasured subsystem is the
 *     false-green defect that created Platform Operations.
 *   • No "last tick". Dispatcher invocations are not recorded.
 *   • No policy count. The prototype's header note counts DECLARED job policies
 *     (`JobControlState`); this route serves none, so the slot carries the
 *     registry count it does serve rather than a figure invented for the shape.
 *   • No cron expression. Nothing here reads `vercel.json`; the cadence is
 *     stated as absent, with its reason.
 *   • No controls. Pause / resume / disable / reschedule are OPS-2D.
 *   • No per-job overdue list. The prototype puts it in the Jobs table, which is
 *     composed directly below this surface in BOTH workspaces that render it
 *     (`platform-overview`, `platform-jobs`) — so it is a move, not a loss, and
 *     the notes already say a silent dispatcher surfaces there and not here.
 *
 * ── FOUR STATES, NEVER COLLAPSED ─────────────────────────────────────────────
 * loading ≠ empty ≠ error ≠ unknown. A failed fetch says the platform could not
 * be asked; it never renders as zero, as a time, or as nothing-to-see. An
 * absent instant renders `Unavailable` with its reason, never `00:00`.
 *
 * ── THE SPLIT ────────────────────────────────────────────────────────────────
 * `OpsSchedulerWidget` fetches; `SchedulerSurface` renders. That is the
 * PlatformHealthSurface precedent, and it is what makes loading / failed /
 * populated / absent each PROVABLE by rendering the real component (server
 * rendering never runs an effect, so a self-fetching component can only ever
 * demonstrate its first frame).
 */

import { useState } from "react";
import { AlertTriangle, CalendarClock, Info, Loader2 } from "lucide-react";
import type { PlatformSection } from "../widget-kit";
import { useSharedWidgetFetch, type SharedFetchState } from "../workspace-session";
import {
  BigStat,
  GroupLabel,
  Provenance,
  SectionSurface,
  Unavailable,
  VRule,
} from "../platform-surface";
import { relTime } from "./job-health-format";

import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import {
  CRON_CADENCE_REASON,
  EXPECTED_HINT,
  EXPECTED_PROVENANCE,
  EXPECTED_PROVENANCE_DETAIL,
  EXTERNAL_CRON_DERIVATION,
  EXTERNAL_CRON_HINT,
  JOBS_IN_SLOT_DERIVATION,
  NEXT_SLOT_DERIVATION,
  NO_EXECUTION_REASON,
  NO_EXTERNAL_CRONS_QUALIFIER,
  NO_SLOT_REASON,
  OBSERVED_HINT,
  SCHEDULER_SUBJECT,
  UNREADABLE_TIME_REASON,
  clockQualifier,
  externalCronNames,
  isUnreadable,
  jobsInSlotQualifier,
  lastExecutionDerivation,
  registeredJobsNote,
  utcClock,
} from "./scheduler-view";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";

/**
 * The COLUMN heading tier — one step above `GroupLabel`, one below the section
 * title (11px semibold vs the eyebrow's 10px medium; same casing, same tracking,
 * same token).
 *
 * WHY IT IS LOCAL. The prototype defines this inside its own Scheduler for the
 * same reason: "Observed" and "Expected" are the only two headings in the whole
 * area that name a COLUMN rather than label a group, and the surface's own
 * "Scheduler notes" deliberately stays at the eyebrow tier. Promoting an
 * 11px variant into platform-surface.tsx would ship a shared primitive with one
 * consumer and invite every eyebrow to drift up a step — the shared module's own
 * extraction rule (extract on demonstrated repetition) rejects that.
 *
 * Spacing is NOT part of this component: the prototype carries `mb-4` here while
 * production spaces from the content side (`mt-4` on the stack below). Adding
 * both would double the gap, so only the type tier moves.
 */
function GroupHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {children}
      </span>
      {hint && (
        // Same accessible treatment production's GroupLabel already ships: the
        // hint reaches assistive tech, not just a pointer tooltip.
        <span
          role="img"
          aria-label={hint}
          title={hint}
          className="inline-flex text-[var(--text-faint)]"
          style={{ cursor: "help" }}
        >
          <Info size={11} strokeWidth={2} aria-hidden />
        </span>
      )}
    </div>
  );
}

/**
 * The surface's honesty line. The prototype names `vercel.json` here as a source
 * of expected slots; production derives them from the registry alone, so the
 * sentence names the module that actually answered.
 */
function SurfaceFootnote() {
  return (
    <>
      Observed values are read from the JobRun ledger. Expected values are derived from{" "}
      <span className="font-mono text-[10px]">lib/jobs/registry.ts</span> at read time and are never
      stored. Nothing here is a verdict on whether the scheduler is alive — no such observation
      exists.
    </>
  );
}

/**
 * The presentational surface. Prop-driven and fetch-free, so every state is
 * reachable in a test by handing it props.
 */
export function SchedulerSurface({
  section,
  state,
  nowMs,
}: {
  section: PlatformSection;
  state: SharedFetchState<SchedulerObservationResponse>;
  /** Injected clock — every relative age below is deterministic under test. */
  nowMs: number;
}) {
  const data = state.error ? null : state.data;

  // The header note is a figure, so it exists only where a figure does. A
  // loading or failed surface carries no count at all.
  const actions = data ? (
    <span className="text-[11px] text-[var(--text-muted)]">
      {registeredJobsNote(data.expected.registeredJobs)}
    </span>
  ) : undefined;

  return (
    <SectionSurface
      icon={CalendarClock}
      title={section.label}
      actions={actions}
      footnote={<SurfaceFootnote />}
    >
      {state.loading ? (
        // LOADING. Deliberately not the empty state: "nothing recorded" while a
        // request is still in flight is a claim we cannot support yet.
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}
        </p>
      ) : !data ? (
        // FAILED. An error wins over any data we happen to be holding — showing
        // the last answer as if it were current is how an outage reads as calm.
        <p
          className="flex items-start gap-1.5 text-xs"
          style={{ color: "var(--coral-400)" }}
          role="alert"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>{unavailableText(SCHEDULER_SUBJECT)}</span>
        </p>
      ) : (
        <SchedulerColumns data={data} nowMs={nowMs} />
      )}
    </SectionSurface>
  );
}

/** OBSERVED | EXPECTED | NOTES — one frame, three groups, two hairlines. */
function SchedulerColumns({
  data,
  nowMs,
}: {
  data: SchedulerObservationResponse;
  nowMs: number;
}) {
  const { observed, expected, notes } = data;

  const lastClock = utcClock(observed.lastRecordedExecutionAt);
  const nextClock = utcClock(expected.nextSlotAt);
  const cronNames = externalCronNames(observed.externalCrons);

  return (
    // The columns collapse at the real `md` breakpoint, by class, along with the
    // hairlines between them (VRule is `hidden md:block`). No viewport hook: a
    // JS read here would fork the breakpoint away from the grid it separates.
    <div className="flex flex-col gap-8 md:flex-row">
      {/* ── OBSERVED ── every figure here is a row that exists ─────────────── */}
      <div className="min-w-0 flex-1">
        <GroupHeading hint={OBSERVED_HINT}>Observed</GroupHeading>
        <div className="mt-4 flex flex-col gap-6">
          <BigStat
            label="Last recorded execution"
            value={
              lastClock ?? (
                <Unavailable
                  reason={
                    isUnreadable(observed.lastRecordedExecutionAt)
                      ? UNREADABLE_TIME_REASON
                      : NO_EXECUTION_REASON
                  }
                />
              )
            }
            qualifier={
              lastClock ? clockQualifier(relTime(observed.lastRecordedExecutionAt, nowMs)) : undefined
            }
            derivation={lastExecutionDerivation(observed.recordedExecutions)}
          />
          <BigStat
            label="External crons"
            value={observed.externalCrons.length}
            qualifier={cronNames ?? NO_EXTERNAL_CRONS_QUALIFIER}
            derivation={EXTERNAL_CRON_DERIVATION}
            hint={EXTERNAL_CRON_HINT}
          />
        </div>
      </div>

      <VRule />

      {/* ── EXPECTED ── configuration, and evidence of nothing ─────────────── */}
      <div className="min-w-0 flex-1">
        <GroupHeading hint={EXPECTED_HINT}>Expected</GroupHeading>
        <div className="mt-4 flex flex-col gap-6">
          <BigStat
            label="Next dispatcher slot"
            value={
              nextClock ?? (
                <Unavailable
                  reason={
                    isUnreadable(expected.nextSlotAt) ? UNREADABLE_TIME_REASON : NO_SLOT_REASON
                  }
                />
              )
            }
            qualifier={nextClock ? clockQualifier(relTime(expected.nextSlotAt, nowMs)) : undefined}
            derivation={NEXT_SLOT_DERIVATION}
          />
          <BigStat
            label="Jobs expected in that slot"
            value={expected.jobsInNextSlot.length}
            qualifier={jobsInSlotQualifier(expected.jobsInNextSlot)}
            derivation={JOBS_IN_SLOT_DERIVATION}
          />
        </div>
      </div>

      <VRule />

      {/* ── NOTES ── documentation embedded in the workspace. This column
          deliberately carries no figure: a third metric here would be worth less
          than the sentences that stop an operator misreading the four beside it.
          The prose is the ROUTE's (SCHEDULER_NOTES), not this file's. */}
      <div className="min-w-0 flex-1 md:max-w-[15rem]">
        <GroupLabel>Scheduler notes</GroupLabel>
        <div className="mt-3 flex flex-col gap-3">
          {notes.map((n) => (
            <p key={n} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {n}
            </p>
          ))}
          <div className="flex flex-col gap-2 pt-1">
            <Provenance source={EXPECTED_PROVENANCE}>{EXPECTED_PROVENANCE_DETAIL}</Provenance>
            <Unavailable reason={CRON_CADENCE_REASON} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function OpsSchedulerWidget({ section }: { section: PlatformSection }) {
  // ONE literal url, one workspace-shared read (OPS-2C-6): `ops_scheduler` is
  // composed into both platform-overview and platform-jobs, and the session is
  // what keeps two mounts from observing two different operational moments.
  const state = useSharedWidgetFetch<SchedulerObservationResponse>(
    "/api/platform/platform-ops/scheduler",
  );

  // ONE instant for the whole surface, captured at mount, so "1h ago" and "in
  // 2h" cannot disagree about now. Read once rather than per render: a clock
  // read during render is impure and would make the same data render
  // differently on an unrelated re-render.
  const [nowMs] = useState(() => Date.now());

  return <SchedulerSurface section={section} state={state} nowMs={nowMs} />;
}
