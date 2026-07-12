"use client";

/**
 * components/space/widgets/debt/DebtKpiStrip.tsx
 *
 * S2 — the Debt Perspective KPI band (plan §3.4): Total Debt · Est. Interest /
 * month · Utilization · Minimum Payments. One GlassPanel with a
 * grid-cols-2 sm:grid-cols-4 band (the mockup's KPI row — NOT four separate
 * section cards). Every figure comes from computeDebtKpis over the SAME client
 * accounts array the panels render (never the lens — plan §1.4), so the strip
 * always agrees with the bars beneath it. `≈` prefixes a figure whose sums were
 * FX-estimated. Each honest dash carries its own reason; no fabricated 0%.
 *
 * No debt in the Space ⇒ one no-debt headline instead of four dashes (plan §3.3).
 */

import type { ReactNode } from "react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { UtilizationLevel } from "@/lib/accounts/credit-utilization";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { computeDebtKpis } from "./debt-kpis";

// Utilization → colour by LEVEL (mirrors debt-perspective-adapters' UTIL_COLOR;
// low is never red).
const UTIL_COLOR: Record<UtilizationLevel, string> = {
  low:      "var(--accent-positive)",
  moderate: "#f59e0b",
  high:     "#f97316",
  over:     "var(--accent-negative)",
};

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

function Tile({
  label,
  value,
  valueColor,
  caption,
  meta,
}: {
  label: string;
  value: ReactNode;
  valueColor?: string;
  caption?: string;
  meta?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-widest text-[var(--text-faint)] truncate">{label}</p>
      <p className="text-lg sm:text-xl font-semibold tabular-nums mt-0.5 truncate" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </p>
      {caption && <p className="text-[11px] text-[var(--text-muted)] leading-tight">{caption}</p>}
      {meta && <p className="text-[10px] text-[var(--text-faint)] leading-tight mt-0.5">{meta}</p>}
    </div>
  );
}

const DASH = "—";

export function DebtKpiStrip({
  accounts,
  ctx,
}: {
  accounts: DebtPerspectiveAccount[];
  ctx?: ConversionContext;
}) {
  const k = computeDebtKpis(accounts, ctx);
  const approx = k.estimated ? "≈ " : "";

  // No debt ⇒ a single honest headline, not four dashes.
  if (k.totalDebt <= 0) {
    return (
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
        <p className="text-sm font-semibold text-[var(--text-primary)]">No debt</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">Nothing owed in this Space — nice.</p>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Total Debt */}
        <Tile
          label="Total Debt"
          value={`${approx}${fmtMoney(k.totalDebt, ctx)}`}
          valueColor="var(--accent-negative)"
          caption="across all liabilities"
        />

        {/* Est. Interest / month */}
        {k.ratedCount > 0 ? (
          <Tile
            label="Est. Interest"
            value={`${approx}${fmtMoney(k.estMonthlyInterest, ctx)}`}
            valueColor="var(--accent-negative)"
            caption="/ month"
            meta={k.unratedCount > 0 ? `${k.unratedCount} without an APR excluded` : undefined}
          />
        ) : (
          <Tile label="Est. Interest" value={DASH} caption="Add APRs to estimate interest" />
        )}

        {/* Utilization */}
        {k.utilizationPct != null && k.utilizationLevel != null ? (
          <Tile
            label="Utilization"
            value={`${k.utilizationPct.toFixed(0)}%`}
            valueColor={UTIL_COLOR[k.utilizationLevel]}
            caption="revolving balance / limit"
          />
        ) : (
          <Tile label="Utilization" value={DASH} caption="No credit limits on file" />
        )}

        {/* Minimum Payments */}
        {k.minPayments > 0 ? (
          <Tile
            label="Min. Payments"
            value={`${approx}${fmtMoney(k.minPayments, ctx)}`}
            caption="/ month"
            meta={k.missingMinCount > 0 ? `${k.missingMinCount} without a minimum` : undefined}
          />
        ) : (
          <Tile label="Min. Payments" value={DASH} caption="Add minimum payments" />
        )}
      </div>
    </GlassPanel>
  );
}
