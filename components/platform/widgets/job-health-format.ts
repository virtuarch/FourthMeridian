/**
 * components/platform/widgets/job-health-format.ts  (OPS-5 S2)
 *
 * Pure presentation helpers for OpsJobHealthWidget — extracted from the client
 * component so they can be unit-tested without a DOM (house pattern: a
 * standalone tsx *.test.ts). NO React, no "use client": formatting and ordering
 * only. Every formatter maps a null metric to an em-dash — the widget never
 * fabricates a value the ledger did not provide.
 */

import type { JobHealthStatus } from "@/lib/jobs/health";

const EM_DASH = "—";

/** Per-status display metadata: label, severity rank (0 = worst), colour tone. */
export type StatusTone = "ok" | "info" | "warn" | "bad" | "muted";

export const JOB_STATUS_META: Record<JobHealthStatus, { label: string; rank: number; tone: StatusTone }> = {
  dead:        { label: "Dead",      rank: 0, tone: "bad" },
  failing:     { label: "Failing",   rank: 1, tone: "bad" },
  overdue:     { label: "Overdue",   rank: 2, tone: "warn" },
  "never-ran": { label: "Never ran", rank: 3, tone: "muted" },
  running:     { label: "Running",   rank: 4, tone: "info" },
  healthy:     { label: "Healthy",   rank: 5, tone: "ok" },
};

/** Severity rank for worst-first ordering (unknown status sorts last). */
export function severityRank(status: string): number {
  return JOB_STATUS_META[status as JobHealthStatus]?.rank ?? 99;
}

/** Human label for a status (falls back to the raw value). */
export function statusLabel(status: string): string {
  return JOB_STATUS_META[status as JobHealthStatus]?.label ?? status;
}

/** Colour tone for a status (falls back to muted). */
export function statusTone(status: string): StatusTone {
  return JOB_STATUS_META[status as JobHealthStatus]?.tone ?? "muted";
}

/** Compact wall-clock duration: "840ms", "3.2s", "2m 5s", "1h 4m". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${Math.round(totalSec % 60)}s`;
  const h = Math.floor(totalMin / 60);
  return `${h}h ${totalMin % 60}m`;
}

/** Success rate (0..1) as a whole-percent string, or em-dash. */
export function fmtPercent(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return EM_DASH;
  return `${Math.round(rate * 100)}%`;
}

/** Cadence in hours as a friendly interval: "daily", "every 6h", "every 30m". */
export function fmtCadence(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return EM_DASH;
  if (hours === 24) return "daily";
  if (hours < 1) return `every ${Math.round(hours * 60)}m`;
  return `every ${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

/**
 * Signed relative time. Past → "3h ago", future → "in 5h", within a minute →
 * "now". `nowMs` defaults to the wall clock so callers in React render stay
 * pure (the impure read lives here, a plain util — the widget-kit timeAgo
 * idiom); tests pass an explicit clock for determinism.
 */
export function relTime(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return EM_DASH;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return EM_DASH;
  const diffMs = t - nowMs;
  const absSec = Math.floor(Math.abs(diffMs) / 1000);
  if (absSec < 60) return "now";
  const mag = magnitude(absSec);
  return diffMs >= 0 ? `in ${mag}` : `${mag} ago`;
}

function magnitude(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
