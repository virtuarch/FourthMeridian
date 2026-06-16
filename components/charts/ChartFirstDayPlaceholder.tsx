"use client";

import { formatCurrency } from "@/lib/format";
import { formatDate } from "@/lib/format";

interface Props {
  /** Real headline figure computed from the single existing snapshot — never fabricated. */
  value: number;
  /** ISO date (YYYY-MM-DD) of that one snapshot. */
  date: string;
  /** Match the height of the chart this replaces so layout doesn't jump once a 2nd point lands. */
  height?: number;
}

/**
 * Shown instead of a line/area chart when a workspace has only one
 * WorkspaceSnapshot row on record (typically right after its first Plaid
 * refresh). A single point can't draw a trend line, so this explains the
 * day-one state with a real number rather than rendering a near-empty chart.
 */
export function ChartFirstDayPlaceholder({ value, date, height = 180 }: Props) {
  const isToday = date === new Date().toISOString().split("T")[0];

  return (
    <div
      className="flex flex-col items-center justify-center text-center gap-1.5"
      style={{ height }}
    >
      <p className="text-3xl font-bold text-white tabular-nums">{formatCurrency(value)}</p>
      <p className="text-sm text-gray-400">
        {isToday ? "Started tracking today." : `Started tracking ${formatDate(date)}.`}
      </p>
      <p className="text-sm text-gray-500">Check back tomorrow to begin seeing trends.</p>
    </div>
  );
}
