"use client";

/**
 * components/space/widgets/investments/HoldingDetail.tsx
 *
 * The shared Holding DETAIL view — one domain-local presentation reused verbatim by
 * both the inline HoldingsSection and the HoldingsModal (SD-4 §10). It leads with the
 * customer's INVESTMENT FACTS and demotes valuation EVIDENCE to a compact block (§12).
 *
 * Honesty (unchanged rules): cost basis / avg cost / "Value vs cost" render ONLY when
 * a NON-NULL native `costBasis` exists (Plaid, current view) and quantity > 0 — native
 * currency throughout (never reporting − native), never a realized/unrealized claim, no
 * fabricated acquisition date. Time-held is omitted (no canonical acquisition date; only
 * earliest-observed exists, which would need a separate read and an "Observed since"
 * label — deliberately not surfaced here).
 */

import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { formatCurrencyExact, formatPercent } from "@/lib/format";
import { costBasisOf, rowLabel, TIER_LABEL } from "./holdings-util";

function Row({ label, value, valueColor }: { label: string; value: ReactNode; valueColor?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs" style={{ color: "var(--text-faint)" }}>{label}</span>
      <span className="text-sm tabular-nums text-right" style={{ color: valueColor ?? "var(--text-secondary)" }}>{value}</span>
    </div>
  );
}

export function HoldingDetail({ row, reportingCurrency, accountName, onBack, backLabel = "Back to holdings" }: {
  row: ValuedHoldingRow; reportingCurrency: string; accountName: string;
  onBack: () => void; backLabel?: string;
}) {
  const unvalued = row.reportingValue == null;
  const nativeCcy = row.currency ?? reportingCurrency;
  const costBasis = costBasisOf(row);
  const hasBasis = costBasis != null && costBasis !== 0;
  const avgCost = hasBasis && row.quantity != null && row.quantity !== 0 ? (costBasis as number) / row.quantity : null;
  const vsCost = hasBasis && row.nativeValue != null ? row.nativeValue - (costBasis as number) : null;
  const vsCostPct = vsCost != null && hasBasis ? (vsCost / (costBasis as number)) * 100 : null;
  const vsColor = vsCost == null ? undefined : vsCost > 0 ? "var(--accent-positive, #34d399)" : vsCost < 0 ? "var(--accent-negative, #f87171)" : "var(--text-secondary)";

  return (
    <div className="min-w-0">
      {/* Back control — concise (§6/§9). */}
      <button type="button" onClick={onBack}
        className="flex items-center gap-1 text-xs font-medium mb-3 hover:underline" style={{ color: "var(--meridian-400)" }}>
        <ArrowLeft size={13} /> {backLabel}
      </button>

      {/* Identity + headline value. */}
      <p className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>{rowLabel(row)}</p>
      {row.symbol && row.name && <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>{row.name}</p>}

      {/* ── Investment facts first. ── */}
      <div className="flex flex-col gap-1.5 mt-2">
        {!unvalued && <Row label="Current value" value={formatCurrencyExact(row.reportingValue as number, reportingCurrency)} />}
        {row.quantity != null && <Row label="Quantity" value={String(row.quantity)} />}
        {row.nativePrice != null && <Row label="Price" value={formatCurrencyExact(row.nativePrice, nativeCcy)} />}
        {avgCost != null && <Row label="Avg cost / unit" value={formatCurrencyExact(avgCost, nativeCcy)} />}
        {hasBasis && <Row label="Total cost basis" value={formatCurrencyExact(costBasis as number, nativeCcy)} />}
        {vsCost != null && (
          <Row label="Value vs cost" valueColor={vsColor}
            value={`${vsCost >= 0 ? "+" : "−"}${formatCurrencyExact(Math.abs(vsCost), nativeCcy)}${vsCostPct != null ? ` (${vsCost >= 0 ? "+" : ""}${formatPercent(vsCostPct)})` : ""}`} />
        )}
        <Row label="Account" value={accountName} />
      </div>

      {/* ── Valuation evidence, demoted (§12). ── */}
      <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--border-hairline)" }}>
        <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--text-faint)" }}>Valuation evidence</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(["Quantity", "Price", "FX", "Overall"] as const).map((k, i) => {
            const tier = [row.quantityTier, row.priceTier, row.fxTier, row.overallTier][i];
            return (
              <span key={k} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--glass-ultrathin)", color: "var(--text-muted)" }}>
                {k} {TIER_LABEL[tier]}
              </span>
            );
          })}
        </div>
        <div className="flex flex-col gap-0.5">
          {row.basisUsed && <Row label="Price source" value={row.basisUsed} />}
          {row.priceDate && <Row label="Price date" value={row.priceDate} />}
          {(row.staleDays ?? 0) > 0 && <Row label="Staleness" value={`${row.staleDays} day${row.staleDays === 1 ? "" : "s"}`} />}
        </div>
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>{row.reason}</p>
      </div>
    </div>
  );
}
