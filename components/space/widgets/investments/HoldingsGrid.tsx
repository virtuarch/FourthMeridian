"use client";

/**
 * components/space/widgets/investments/HoldingsGrid.tsx
 *
 * The shared Holdings GRID + CARD — one domain-local presentation reused verbatim by
 * both the inline HoldingsSection and the HoldingsModal (SD-4 §10). Responsive:
 * 1 column on mobile, 2 on md, 3 on xl (§3/§17). Each card is a button that selects
 * the holding (grid → detail); the parent owns the mode/selection state.
 *
 * Quiet honesty: a non-observed tier dot and a conflict glyph render only when off; a
 * clean row shows none. Values are reporting/display currency (already converted by the
 * Workspace); the native unit price stays native.
 */

import { AlertTriangle } from "lucide-react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { formatCurrencyExact } from "@/lib/format";
import { rowKey, rowLabel, tierDotColor, isInstitutionBasis } from "./holdings-util";

export function HoldingCard({ row, reportingCurrency, onSelect }: {
  row: ValuedHoldingRow; reportingCurrency: string; onSelect: (id: string) => void;
}) {
  const unvalued = row.reportingValue == null;
  const label = rowLabel(row);
  const sublabel = row.symbol && row.name ? row.name : null;
  const sharePct = row.share != null ? Math.max(0, Math.min(1, row.share)) * 100 : 0;
  const showTierDot = row.overallTier !== "observed";

  return (
    <button
      type="button"
      onClick={() => onSelect(rowKey(row))}
      className={`text-left rounded-[var(--radius-lg)] border p-3 min-w-0 flex flex-col gap-2 transition-colors hover:border-[var(--meridian-400)] ${unvalued ? "opacity-60" : ""}`}
      style={{ background: "var(--surface-muted)", borderColor: "var(--border-hairline)" }}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{label}</span>
            {showTierDot && <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tierDotColor(row.overallTier) }} aria-hidden />}
            {row.conflicted && <AlertTriangle size={11} className="shrink-0" style={{ color: "var(--accent-warning, #f59e0b)" }} aria-hidden />}
          </div>
          {sublabel && <p className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{sublabel}</p>}
        </div>
        {row.share != null && (
          <span className="text-[11px] tabular-nums shrink-0" style={{ color: "var(--text-faint)" }}>{(row.share * 100).toFixed(1)}%</span>
        )}
      </div>

      <p className="text-base font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>
        {unvalued ? "—" : formatCurrencyExact(row.reportingValue as number, reportingCurrency)}
      </p>

      {row.share != null && (
        <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
          <div className="h-full rounded-full" style={{ width: `${sharePct}%`, background: "var(--meridian-400)" }} />
        </div>
      )}

      <p className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
        {row.quantity != null ? row.quantity : "—"}
        {row.nativePrice != null && row.currency && <> × {formatCurrencyExact(row.nativePrice, row.currency)}</>}
        {isInstitutionBasis(row.basisUsed) && <span title="Valued from an institution-reported figure"> · inst.</span>}
        {(row.staleDays ?? 0) > 0 && <span> · {row.staleDays}d</span>}
      </p>
    </button>
  );
}

export function HoldingsGrid({ rows, reportingCurrency, onSelect }: {
  rows: ValuedHoldingRow[]; reportingCurrency: string; onSelect: (id: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-center py-8" style={{ color: "var(--text-muted)" }}>No holdings to show for this date.</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 min-w-0">
      {rows.map((row) => (
        <HoldingCard key={rowKey(row)} row={row} reportingCurrency={reportingCurrency} onSelect={onSelect} />
      ))}
    </div>
  );
}
