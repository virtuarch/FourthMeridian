/**
 * components/platform/widgets/refresh-activity-view.ts  (UX-P1 · Agent 4)
 *
 * THE ONE VIEW MAP for refresh execution composition — shared by the Pipeline
 * summary surface and the Overview's Refresh activity block, so the two never
 * disagree about which word a status gets or which tone it owns. Pure: no
 * React, no fetch, no clock (callers pass `nowMs`), no Prisma.
 *
 * ── TWO VOCABULARIES, ONE OWNS COLOUR ────────────────────────────────────────
 * `overallStatus` is a verdict and carries a tone (SUCCEEDED ok · PARTIAL warn
 * · FAILED bad · SKIPPED muted · RUNNING info). `trigger` is provenance — a
 * trigger is not a verdict — so its segments carry no tone and render in the
 * muted ramp. Mixing the two would let a scheduled run look "green".
 *
 * ── HONESTY ──────────────────────────────────────────────────────────────────
 * The day series emits every day of its window; a day the series omitted is a
 * day the fact cap made unknowable, and it renders as a GAP (`value: null`),
 * never as zero. A settled day with zero executions is a real zero and renders
 * as one. Both are stated in the captions this module builds.
 */

import type { StatusTone } from "./job-health-format";
import { describeTrigger } from "./execution-format";
import { describeWindow, humanizeToken } from "./refresh-format";
import { fmtUtc } from "./jobs-view";
import type { ProjectionEnvelope, RefreshDailySeries, RefreshDayBucket } from "@/lib/platform/refresh/types";

/** Structural twin of platform-surface's `DistributionSegment` (this file stays React-free). */
export interface Segment {
  word: string;
  count: number;
  tone?: StatusTone;
}

/** Structural twin of platform-surface's `MiniBarPoint`. */
export interface Point {
  key: string;
  value: number | null;
  tone?: StatusTone;
  title?: string;
}

// ── Status vocabulary ─────────────────────────────────────────────────────────

/** The closed status vocabulary, in the order every strip renders it. */
export const EXECUTION_STATUS_ORDER = ["SUCCEEDED", "PARTIAL", "FAILED", "SKIPPED", "RUNNING"] as const;

/** Status → tone. Presentation only; the status itself is the ledger's own value. */
export const EXECUTION_STATUS_TONE: Record<(typeof EXECUTION_STATUS_ORDER)[number], StatusTone> = {
  SUCCEEDED: "ok",
  PARTIAL: "warn",
  FAILED: "bad",
  SKIPPED: "muted",
  RUNNING: "info",
};

/** Tone for any status string: the vocabulary's own, or muted for one it does not know. */
export function statusTone(status: string): StatusTone {
  return (EXECUTION_STATUS_TONE as Record<string, StatusTone>)[status] ?? "muted";
}

/**
 * Status segments for a DistributionBar. The five known statuses ALWAYS appear
 * (a counted zero over real rows is a fact: "Failed 0" is the good news); a
 * status the vocabulary does not know is appended, sorted, in the muted ramp
 * rather than dropped.
 */
export function statusSegments(byStatus: Readonly<Record<string, number>>): Segment[] {
  const known: Segment[] = EXECUTION_STATUS_ORDER.map((s) => ({
    word: humanizeToken(s),
    count: byStatus[s] ?? 0,
    tone: EXECUTION_STATUS_TONE[s],
  }));
  const unknown = Object.keys(byStatus)
    .filter((k) => !(EXECUTION_STATUS_ORDER as readonly string[]).includes(k))
    .sort()
    .map((k) => ({ word: humanizeToken(k), count: byStatus[k] }));
  return [...known, ...unknown];
}

/** Trigger segments: provenance words, no tone. Key order is the projection's (stable). */
export function triggerSegments(byTrigger: Readonly<Record<string, number>>): Segment[] {
  return Object.keys(byTrigger).map((k) => ({ word: describeTrigger(k), count: byTrigger[k] }));
}

// ── Day series ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The window's day axis, inclusive, ascending — the presentation's own list. */
export function windowDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return [];
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "not loaded" — the only reason a day inside the window can be missing from the series. */
export const DAY_NOT_LOADED = "not loaded — the fact cap cut the window here";

function byDay(series: RefreshDailySeries): Map<string, RefreshDayBucket> {
  return new Map(series.days.map((d) => [d.day, d]));
}

/** Executions per UTC day. A missing day is a GAP (fact cap), a settled empty day is a zero. */
export function executionPoints(series: RefreshDailySeries): Point[] {
  const days = byDay(series);
  return windowDays(series.envelope.window.from, series.envelope.window.to).map((day) => {
    const d = days.get(day);
    if (!d) return { key: day, value: null, title: `${day}: ${DAY_NOT_LOADED}` };
    return {
      key: day,
      value: d.total,
      title: `${day}: ${plural(d.total, "execution")}${d.settled ? "" : " so far (not settled)"}`,
    };
  });
}

/** Failed executions per UTC day, in the bad tone. Same gap/zero rule. */
export function failurePoints(series: RefreshDailySeries): Point[] {
  const days = byDay(series);
  return windowDays(series.envelope.window.from, series.envelope.window.to).map((day) => {
    const d = days.get(day);
    if (!d) return { key: day, value: null, title: `${day}: ${DAY_NOT_LOADED}` };
    return {
      key: day,
      value: d.byStatus.FAILED,
      tone: "bad",
      title: `${day}: ${plural(d.byStatus.FAILED, "failed execution")}${d.settled ? "" : " so far (not settled)"}`,
    };
  });
}

/** Executions the admission authority refused, over the whole series. */
export function admissionDeniedTotal(series: RefreshDailySeries): number {
  return series.days.reduce((n, d) => n + d.admissionDenied, 0);
}

// ── Captions ──────────────────────────────────────────────────────────────────

/** "2026-09-30 → 2026-10-14 · reproducible — … · checked 14 Oct 10:12 UTC". */
export function envelopeCaption(env: ProjectionEnvelope): string {
  const w = describeWindow(env);
  const checked = fmtUtc(env.checkedAt, true);
  return `${w.window} · ${w.detail}${checked ? ` · checked ${checked}` : ""}`;
}

/** The day-series caption: interval, bucket count, the zero rule, the floor. */
export function seriesCaption(series: RefreshDailySeries): string {
  const parts = [
    "UTC days",
    `${series.windowDays} in window`,
    "a settled day with no rows is a true zero (the ledger is the authority)",
  ];
  if (series.floor) parts.push("floor — the fact cap cut older days");
  return parts.join(" · ");
}

/** The refusals line: what the ledger records, and what it cannot. */
export function refusalNote(series: RefreshDailySeries): string {
  const denied = admissionDeniedTotal(series);
  return (
    `${plural(denied, "execution")} refused by admission policy in the window (recorded as Skipped). ` +
    "Customer cooldown refusals write no row and cannot appear here."
  );
}

/** The one sentence shown when a summary observed no rows. */
export const SUMMARY_UNOBSERVED =
  "No refresh executions recorded in this window — not observed. This is an absence of evidence, not a healthy result.";
