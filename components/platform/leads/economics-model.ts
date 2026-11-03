/**
 * components/platform/leads/economics-model.ts  (Platform Economics — Overview view-model)
 *
 * PURE words and numbers for EconomicsOverviewLead. Every value comes from the
 * EconomicsSnapshot (lib/platform/economics/snapshot-core.ts) and keeps its
 * status — this module only says it:
 *
 *   ESTIMATED    "$12.40"            an estimate, never a bill
 *   PARTIAL      "≥ $12.40"          a lower bound; the missing parts are named
 *   MEASURED     "7"                 a count read from a ledger
 *   UNAVAILABLE  "Unavailable"       with its reason — NEVER "$0"
 *
 * No React, no fetch, no clock.
 */

import type { TrendPoint } from "@/components/space/widgets/charts/TrendChart";
import {
  ECONOMICS_DRILL_PATH,
  parseEconomicsDrillQuery,
  type EconomicsFigure,
  type EconomicsFigureKey,
  type EconomicsSnapshot,
  type EconomicsStatus,
  type EconomicsTrendDay,
  type EconomicsWindow,
  type TrendWindow,
} from "@/lib/platform/economics/snapshot-core";
import { usd } from "./ai-costs-model";

const n = (v: number) => v.toLocaleString("en-US");

export const STATUS_WORD: Readonly<Record<EconomicsStatus, string>> = {
  MEASURED: "Measured",
  ESTIMATED: "Estimated",
  PARTIAL: "Partial",
  UNAVAILABLE: "Unavailable",
};

export const UNAVAILABLE_TEXT = "Unavailable";

/** The figure's value as shown. A null value is "Unavailable" — never a number. */
export function figureValueText(f: Pick<EconomicsFigure, "value" | "status" | "unit">): string {
  if (f.value === null || f.status === "UNAVAILABLE") return UNAVAILABLE_TEXT;
  const v = f.unit === "usd" ? usd(f.value) : n(f.value);
  return f.status === "PARTIAL" ? `≥ ${v}` : v;
}

/** The one-line sub-caption: the status word and, when it has one, the reason. */
export function figureSubText(f: Pick<EconomicsFigure, "status" | "reason">): string {
  const w = STATUS_WORD[f.status].toLowerCase();
  return f.reason ? `${w} · ${f.reason}` : f.status === "ESTIMATED" ? `${w} · not a bill` : w;
}

/** "1 Nov – 3 Nov" — a figure's inclusive window. */
export function windowText(f: Pick<EconomicsFigure, "freshness">): string {
  const d = (k: string) => { const t = new Date(`${k}T00:00:00Z`); return `${t.getUTCDate()} ${t.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`; };
  return f.freshness.from === f.freshness.to ? d(f.freshness.from) : `${d(f.freshness.from)} – ${d(f.freshness.to)}`;
}

/** "Checked 14:02 UTC". */
export function checkedText(iso: string): string {
  return `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

/** The cost split shown under the hero: AI · Providers · Infrastructure, each with its own status. */
export const SPLIT_KEYS: readonly EconomicsFigureKey[] = ["ai_cost", "provider_cost", "infra_cost"];
export function splitFigures(s: EconomicsSnapshot): EconomicsFigure[] {
  return SPLIT_KEYS.map((k) => s.figures[k]);
}

/** Share of the PRICED split each part is (for the bar); null for a part without a value. Never a 0% bar for unknown. */
export function splitShares(figs: readonly EconomicsFigure[]): (number | null)[] {
  const priced = figs.reduce((a, f) => a + (f.value ?? 0), 0);
  return figs.map((f) => (f.value === null || priced <= 0 ? null : Math.round((f.value / priced) * 1000) / 10));
}

/** Days of a trend window, the tail of the snapshot's 90 days. */
export function trendDays(s: EconomicsSnapshot, w: TrendWindow): EconomicsTrendDay[] {
  const k = Number(w.replace("d", ""));
  return s.trend.days.slice(-k);
}

/** One point per PRICED day; gap days (no ledger row, or nothing priced) are left out — never drawn as $0. */
export function trendSeries(days: readonly EconomicsTrendDay[]): { points: TrendPoint[]; gaps: number } {
  const points: TrendPoint[] = [];
  let gaps = 0;
  for (const d of days) {
    if (d.totalUsd === null) { gaps++; continue; }
    points.push({ date: d.day, value: d.totalUsd, estimated: d.unpricedInvocations > 0 });
  }
  return { points, gaps };
}

// ── The drill's place in the URL (the PB-9 / ai-budget-calls idiom) ────────────

/** ?econ=<figure>.<window>&econuntil=<epoch ms> — workspace-scoped, REPLACE intent. */
export const ECONOMICS_URL_PARAMS = ["econ", "econuntil"] as const;

export interface EconomicsDrillUrlState { figure: EconomicsFigureKey; window: EconomicsWindow; untilMs: number | null }

/** Read the open drill from a search string, through the route's own parser (an unknown value is dropped). */
export function readEconomicsDrillUrl(search: string, nowMs: number): EconomicsDrillUrlState | null {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const econ = p.get("econ");
  if (!econ) return null;
  const [figure, window] = econ.split(".");
  const probe = new URLSearchParams({ figure: figure ?? "", window: window ?? "cycle" });
  const until = p.get("econuntil");
  if (until) probe.set("until", until);
  const q = parseEconomicsDrillQuery(probe, nowMs);
  if (!q) return null;
  return { figure: q.figure, window: q.window, untilMs: until !== null && q.untilMs !== nowMs ? q.untilMs : null };
}

export function economicsDrillUrlUpdate(s: EconomicsDrillUrlState | null): Record<string, string | null> {
  return { econ: s ? `${s.figure}.${s.window}` : null, econuntil: s && s.untilMs !== null ? String(s.untilMs) : null };
}

/** The drill state a figure opens: its own window, ending at the snapshot's checkedAt. */
export function drillStateOf(f: EconomicsFigure): EconomicsDrillUrlState | null {
  if (!f.drill) return null;
  const t = Date.parse(f.freshness.asOf);
  return { figure: f.drill.figure, window: f.drill.window, untilMs: Number.isFinite(t) ? t : null };
}

/** The records path for a drill state (the route re-validates everything). */
export function economicsDrillApiPath(s: EconomicsDrillUrlState): string {
  const p = new URLSearchParams({ figure: s.figure, window: s.window });
  if (s.untilMs !== null) p.set("until", String(s.untilMs));
  return `${ECONOMICS_DRILL_PATH}?${p.toString()}`;
}

/** "Total ≥ $12.40 · 5 rows" — the drill's own sum, in the figure's words. */
export function drillTotalText(figure: Pick<EconomicsFigure, "status" | "unit">, total: number | null, rows: number): string {
  const noun = figure.unit === "count" ? "customer" : "record";
  const t = total === null ? UNAVAILABLE_TEXT : figureValueText({ value: total, status: figure.status, unit: figure.unit });
  return `Total ${t} · ${n(rows)} ${noun}${rows === 1 ? "" : "s"}`;
}

export function rowValueText(v: number | null, unit: "usd" | "count"): string {
  if (v === null) return UNAVAILABLE_TEXT;
  return unit === "usd" ? usd(v) : n(v);
}
