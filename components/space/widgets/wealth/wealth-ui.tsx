"use client";

/**
 * components/space/widgets/wealth/wealth-ui.tsx
 *
 * Shared presentational primitives for the Wealth Perspective (A6). No data
 * logic — purely visual, in the existing dark Atlas/Liquid language (surface
 * tokens, hairline borders, tabular numerals). Everything the Wealth cards need
 * that would otherwise be duplicated lives here: the card shell, a signed delta
 * badge, and a compact sparkline.
 */

import { formatCurrency } from "@/lib/format";

/** Question-led card shell matching the app's rounded-2xl / surface-inset cards. */
export function WealthCard({
  title,
  subtitle,
  right,
  className = "",
  children,
}: {
  title:     string;
  subtitle?: React.ReactNode;
  right?:    React.ReactNode;
  className?: string;
  children:  React.ReactNode;
}) {
  return (
    <section
      className={["rounded-2xl border p-4 sm:p-5", className].join(" ")}
      style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
    >
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
          {subtitle && <p className="text-[11px] text-[var(--text-faint)] mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

/** Signed money string, e.g. "+$24,130" / "−$5,730". */
export function formatSigned(value: number, currency: string): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(value), currency)}`;
}

/**
 * A delta badge: "↑ $24,130 · 14.9% vs Jan 1, 2025". Direction color follows
 * `goodDirection` (liabilities are good when they go DOWN). A null delta or a
 * missing comparison renders nothing.
 */
export function DeltaBadge({
  abs,
  pct,
  currency,
  goodDirection = "up",
  compareLabel,
  className = "",
}: {
  abs:           number;
  pct:           number | null;
  currency:      string;
  goodDirection?: "up" | "down";
  compareLabel?: string;
  className?:    string;
}) {
  if (abs === 0 && (pct === null || pct === 0)) {
    return (
      <span className={["text-[11px] text-[var(--text-faint)]", className].join(" ")}>
        No change{compareLabel ? ` vs ${compareLabel}` : ""}
      </span>
    );
  }
  const up   = abs >= 0;
  const good = up ? goodDirection === "up" : goodDirection === "down";
  const color = good ? "var(--accent-positive)" : "var(--accent-negative)";
  const arrow = up ? "↑" : "↓";
  return (
    <span className={["inline-flex items-baseline gap-1 text-[11px] tabular-nums", className].join(" ")} style={{ color }}>
      <span aria-hidden>{arrow}</span>
      <span>{formatCurrency(Math.abs(abs), currency)}</span>
      {pct !== null && <span className="text-[var(--text-faint)]">· {Math.abs(pct).toFixed(1)}%</span>}
      {compareLabel && <span className="text-[var(--text-faint)]">vs {compareLabel}</span>}
    </span>
  );
}

/**
 * Compact trend sparkline. Renders only when ≥2 real points exist — a single
 * point or none renders nothing (no fabricated trend). Time order is the caller's
 * responsibility (values are already in series order).
 */
export function Sparkline({
  values,
  width = 72,
  height = 22,
  goodDirection = "up",
}: {
  values:        number[];
  width?:        number;
  height?:       number;
  goodDirection?: "up" | "down";
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pts = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(" ");
  const rising = values[values.length - 1] >= values[0];
  const good = rising ? goodDirection === "up" : goodDirection === "down";
  const color = good ? "var(--accent-positive)" : "var(--accent-negative)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
    </svg>
  );
}

/** Shaped "no historical data for this date" body, reused by every card. */
export function WealthUnavailable({ message }: { message: string }) {
  return (
    <div className="py-6 text-center">
      <p className="text-xs text-[var(--text-faint)] max-w-xs mx-auto leading-relaxed">{message}</p>
    </div>
  );
}
