"use client";

/**
 * components/platform/widgets/OpsSchedulerWidget.tsx  (OPS-2C-7 · ops_scheduler)
 *
 * Scheduler OBSERVATION, over GET /api/platform/platform-ops/scheduler
 * (requirePlatformAccess PLATFORM_OPS READ).
 *
 * ── THE THREE GROUPS ARE RENDERED SEPARATELY, ON PURPOSE ──────────────────────
 *
 *     OBSERVED   what the ledger recorded
 *     EXPECTED   what the registry declares should happen
 *     NOTES      explanation — prose only, never a figure
 *
 * They are visually distinct because they have different epistemic status. A
 * "next slot" is not evidence that anything will run; a recorded execution is
 * not a promise that another follows. Mixing their figures into one row is what
 * makes an operator read configuration as observation.
 *
 * ── WHAT THIS WIDGET REFUSES TO RENDER ────────────────────────────────────────
 *   • No scheduler health, no "dispatcher OK", no green roll-up — no such
 *     authority exists, and a green badge over an unmeasured subsystem is the
 *     false-green defect that created Platform Operations.
 *   • No "last tick". Dispatcher invocations are not recorded, so the honest
 *     fact is "last recorded execution", labelled exactly that.
 *   • No controls. Pause / resume / disable / reschedule are OPS-2D.
 *
 * Presentation only: every figure arrives precomputed; nothing is derived here.
 */

import { Timer } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import { useSharedWidgetFetch } from "../workspace-session";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";

function when(iso: string | null): string {
  return iso ? timeAgo(iso) : "not observed";
}

export function OpsSchedulerWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useSharedWidgetFetch<SchedulerObservationResponse>(
    "/api/platform/platform-ops/scheduler",
  );

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Timer}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  const { observed, expected, notes } = data;

  return (
    <PlatformWidgetCard label={section.label} icon={Timer}>
      {/* ── OBSERVED ── every figure here is a recorded row ───────────────── */}
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Observed
      </p>
      <p className="mt-1 text-xs text-[var(--text-secondary)] tabular-nums">
        Last recorded execution {when(observed.lastRecordedExecutionAt)} ·{" "}
        {observed.recordedExecutions} in the last 24h
      </p>

      {observed.overdue.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {observed.overdue.map((o) => (
            <li key={o.job} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-[var(--text-primary)]">{o.job}</span>
              <span className="shrink-0 tabular-nums" style={{ color: "var(--brass-300, #d9b25a)" }}>
                {o.status}
                <span className="text-[var(--text-muted)]"> · last {when(o.lastStartedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {observed.externalCrons.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {observed.externalCrons.map((c) => (
            <li key={c.job} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-[var(--text-primary)]">
                {c.job}
                <span className="ml-1 text-[10px] text-[var(--text-muted)]">external cron</span>
              </span>
              <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                {c.recordedExecutions} in 24h
                <span className="text-[var(--text-muted)]"> · no health report</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* ── EXPECTED ── configuration, not evidence ───────────────────────── */}
      <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Expected
      </p>
      <p className="mt-1 text-xs text-[var(--text-secondary)] tabular-nums">
        {expected.nextSlotAt ? (
          <>
            Next registry slot {new Date(expected.nextSlotAt).toISOString().slice(11, 16)} UTC ·{" "}
            {expected.jobsInNextSlot.length > 0
              ? expected.jobsInNextSlot.join(", ")
              : "no jobs declared"}
          </>
        ) : (
          <>No slot declared by the registry</>
        )}
      </p>
      <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
        {expected.registeredJobs} registered jobs
      </p>

      {/* ── NOTES ── prose only; a figure here would be a smuggled observation ── */}
      <ul className="mt-3 flex flex-col gap-1">
        {notes.map((n) => (
          <li key={n} className="text-[11px] leading-relaxed text-[var(--text-muted)]">
            {n}
          </li>
        ))}
      </ul>
    </PlatformWidgetCard>
  );
}
