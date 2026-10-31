/**
 * components/platform/charts/heat-readouts.ts  (Platform Spaces 2.0 — shared heatmap readouts)
 *
 * The readout sentences for the calendar and time-of-week layouts, shared by
 * every Space (Growth, Security, …): exact value, its noun, and — for time of
 * week — the share of the grid's total. Pure.
 */

import { WEEKDAYS, pct, type HeatCell } from "./heatmap-model";

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

const valueOf = (c: HeatCell): number => (c.kind === "value" ? c.v : 0);

export function describeCalendarCell(day: string | null, cell: HeatCell, noun: string): string {
  const when = day ? new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  if (cell.kind === "noData") return `${when} · no data (before recording began)`;
  return `${when} · ${plural(valueOf(cell), noun)}`;
}

export function describeWeekHourCell(r: number, c: number, cell: HeatCell, noun: string, total: number): string {
  const h = String(c).padStart(2, "0");
  const v = valueOf(cell);
  return `${WEEKDAYS[r]} ${h}:00–${h}:59 UTC · ${plural(v, noun)}${total > 0 ? ` · ${pct(v, total)} of ${n(total)}` : ""}`;
}

