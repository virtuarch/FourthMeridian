"use client";

/**
 * SpaceTrendHero
 *
 * The template-contract hero for chartable Space types (Space Template
 * Redesign): headline metric + delta + historical trend as ONE fused unit —
 * never a bare chart, never a bare number. Pure presenter: the host fetches
 * SpaceSnapshot history (GET /api/spaces/[id]/snapshots), selects the
 * category's series via lib/space-hero.ts, and passes points here.
 *
 * Honesty ladder (approved investigation — "the trend earns pixels"):
 *   - loading        → quiet spinner in the hero frame
 *   - 0 points       → renders nothing (host's day-zero state owns the page)
 *   - 1 point        → real headline + "Your history starts today" (the
 *                      ChartFirstDayPlaceholder pattern, hero-sized)
 *   - 2+ points      → headline, honest delta (labeled with its window),
 *                      area trend (stepAfter for manually-updated series),
 *                      scope label, as-of date
 *
 * Delta coloring follows `framing` (down-good for debt payoff) — the line
 * itself stays one neutral color; only the delta text moralizes, and only
 * when a real baseline exists.
 */

import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TrendingDown, TrendingUp, Loader2 } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { formatDate } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import type { HeroFraming } from "@/lib/space-hero";

export interface HeroPoint {
  /** ISO YYYY-MM-DD */
  date: string;
  value: number;
}

// MC1 QA Q4 — the hero's points are this Space's own SpaceSnapshot stamps,
// which are written in Space.reportingCurrency (Phase 3 flip), so the label
// follows the value via the host-supplied `currency` prop. Hosts that don't
// pass one keep the historical USD default (kill switch).
function fmtCurrency(n: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

/** Currency symbol for compact axis ticks (USD → "$", so all-USD renders identically). */
function currencySymbol(currency: string): string {
  const part = new Intl.NumberFormat("en-US", { style: "currency", currency })
    .formatToParts(0)
    .find((p) => p.type === "currency");
  return part?.value ?? "$";
}

function fmtAxis(n: number, currency: string): string {
  const sym = currencySymbol(currency);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${sym}${Math.round(n / 1_000)}k`;
  return `${sym}${Math.round(n)}`;
}

function tickFormat(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SpaceTrendHero({
  title,
  points,
  framing,
  chartType = "monotone",
  scopeLabel,
  loading = false,
  headlineOverride,
  sublineNote,
  currency = DEFAULT_DISPLAY_CURRENCY,
}: {
  title: string;
  points: HeroPoint[];
  framing: HeroFraming;
  chartType?: "monotone" | "stepAfter";
  scopeLabel?: string;
  loading?: boolean;
  /** MC1 QA Q4 — currency of the snapshot values (Space.reportingCurrency).
   *  Defaults to the historical USD label (kill switch). */
  currency?: string;
  /** Optional replacement headline (e.g. Emergency Fund "4.2 months");
   *  the dollar value moves to the subline when set. */
  headlineOverride?: string;
  /** Assumption disclosure line (e.g. "at $3,000/mo expenses — edit in
   *  the Emergency Fund section"). */
  sublineNote?: string;
}) {
  // Delta: latest vs the nearest point ≥30 days back; falls back to the
  // earliest point (with an honest "since <date>" label). No baseline →
  // no delta at all (the KpiRow rule).
  const { latest, delta, deltaLabel } = useMemo(() => {
    if (points.length === 0) return { latest: null, delta: null, deltaLabel: "" };
    const last = points[points.length - 1];
    if (points.length === 1) return { latest: last, delta: null, deltaLabel: "" };
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffIso = cutoff.toISOString().split("T")[0];
    const base = [...points].reverse().find((p) => p.date <= cutoffIso) ?? points[0];
    const label = base.date <= cutoffIso ? "past 30 days" : `since ${formatDate(base.date)}`;
    return { latest: last, delta: last.value - base.value, deltaLabel: label };
  }, [points]);

  if (loading) {
    return (
      <GlassPanel depth="thin" elevation="e3" radius="lg" className="p-5">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
        <div className="flex items-center justify-center py-12 text-[var(--text-muted)]">
          <Loader2 size={16} className="animate-spin" />
        </div>
      </GlassPanel>
    );
  }

  // Day zero — nothing to defend; the host's setup state owns the page.
  if (!latest) return null;

  const goodDirection = framing === "down-good" ? -1 : 1;
  const deltaIsGood   = delta !== null && delta * goodDirection >= 0;
  const DeltaIcon     = delta !== null && delta >= 0 ? TrendingUp : TrendingDown;

  return (
    <GlassPanel depth="thin" elevation="e3" radius="lg" className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
          {scopeLabel && (
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{scopeLabel}</p>
          )}
        </div>
        <p className="text-[11px] text-[var(--text-muted)] shrink-0 mt-0.5">
          Updated {formatDate(latest.date)}
        </p>
      </div>

      <div className="flex items-baseline gap-3 mt-3 flex-wrap">
        <p className="text-3xl font-bold tabular-nums text-[var(--text-primary)]">
          {headlineOverride ?? fmtCurrency(latest.value, currency)}
        </p>
        {delta !== null && delta !== 0 && (
          <span
            className={[
              "inline-flex items-center gap-1 text-xs font-semibold tabular-nums",
              deltaIsGood ? "text-[var(--emerald-400)]" : "text-[var(--coral-400)]",
            ].join(" ")}
          >
            <DeltaIcon size={12} />
            {delta > 0 ? "+" : "−"}{fmtCurrency(Math.abs(delta), currency)}
            <span className="font-normal text-[var(--text-muted)]">{deltaLabel}</span>
          </span>
        )}
      </div>
      {(headlineOverride || sublineNote) && (
        <p className="text-xs text-[var(--text-muted)] mt-1">
          {headlineOverride ? `${fmtCurrency(latest.value, currency)}${sublineNote ? ` · ${sublineNote}` : ""}` : sublineNote}
        </p>
      )}

      {points.length === 1 ? (
        <div className="flex items-center justify-center py-8">
          <p className="text-sm text-[var(--text-secondary)]">
            Your history starts today — this becomes a trend as snapshots accrue.
          </p>
        </div>
      ) : (
        <div className="mt-4">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 4, left: -14 }}>
              <defs>
                <linearGradient id="spaceHeroGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tickFormatter={tickFormat}
                tick={{ fontSize: 10, fill: "#6b7280" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                padding={{ left: 12, right: 4 }}
              />
              <YAxis
                tickFormatter={(v) => fmtAxis(Number(v), currency)}
                tick={{ fontSize: 10, fill: "#6b7280" }}
                tickLine={false}
                axisLine={false}
                width={64}
                domain={["auto", "auto"]}
              />
              <Tooltip
                formatter={(v) => [fmtCurrency(Number(v ?? 0), currency), title]}
                labelFormatter={(l) => formatDate(String(l))}
                contentStyle={{
                  background: "rgba(17,24,39,0.95)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
              />
              <Area
                type={chartType}
                dataKey="value"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#spaceHeroGrad)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </GlassPanel>
  );
}
