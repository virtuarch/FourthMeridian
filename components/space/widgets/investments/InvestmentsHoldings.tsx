"use client";

/**
 * components/space/widgets/investments/InvestmentsHoldings.tsx
 *
 * The Investments holdings surface. The Workspace card shows the TOP 5 holdings
 * (ranked as the DTO ranked them — value desc, unvalued last); a "Show all" opens the
 * COMPLETE list in a GlassModal (SD-4D+ §5). Each row expands to a detail that leads
 * with the customer's INVESTMENT FACTS (value, quantity, native price, and — where the
 * provider supplied it — native cost basis + value-vs-cost) and DEMOTES the valuation
 * evidence (tiers, basis, price date, staleness, account) to a compact secondary
 * region below (§6/§7). Nothing material is hidden; evidence stays one glance away.
 *
 * Honesty machinery is quiet by construction: trust marks render ONLY when something
 * is off. Cost basis / value-vs-cost appear ONLY when a NON-NULL native `costBasis`
 * exists (Plaid-only, current view) and quantity > 0 — never fabricated, never a
 * realized/unrealized claim. `costBasis` is native-currency (the instrument's own
 * currency), so every cost figure is shown in `row.currency`, never mixed with the
 * reporting-currency value.
 */

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, TrendingUp } from "lucide-react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import { formatCurrencyExact, formatPercent } from "@/lib/format";
import { GlassModal } from "@/components/dashboard/widgets/GlassModal";

const TOP_N = 5;

/** Human tier label for the tap-in detail (matches the platform trust vocabulary). */
const TIER_LABEL: Record<CompletenessTier, string> = {
  observed: "Observed", derived: "Derived", estimated: "Estimated", incomplete: "Incomplete", unknown: "Unknown",
};

function tierDotColor(tier: CompletenessTier): string {
  switch (tier) {
    case "derived":   return "var(--accent-info, #60a5fa)";
    case "estimated": return "var(--accent-warning, #f59e0b)";
    case "incomplete":
    case "unknown":   return "var(--accent-danger, #ef4444)";
    default:          return "var(--text-faint)";
  }
}
function isInstitutionBasis(basis: ValuedHoldingRow["basisUsed"]): boolean {
  return basis === "institution-value" || basis === "institution-price";
}
/** Native-currency aggregate cost basis — present only on current-view rows (Plaid). */
function costBasisOf(row: ValuedHoldingRow): number | null {
  const cb = (row as { costBasis?: number | null }).costBasis;
  return cb == null ? null : cb;
}

/** A compact "field: value" line for the tap-in detail. */
function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs" style={{ color: "var(--text-faint)" }}>{label}</span>
      <span className="text-xs tabular-nums text-right" style={{ color: valueColor ?? "var(--text-secondary)" }}>{value}</span>
    </div>
  );
}

function HoldingRow({ row, rank, reportingCurrency, accountName }: {
  row: ValuedHoldingRow; rank: number; reportingCurrency: string; accountName: string;
}) {
  const [open, setOpen] = useState(false);
  const unvalued = row.reportingValue == null;
  const label = row.symbol ?? row.name ?? row.instrumentId;
  const sublabel = row.symbol && row.name ? row.name : null;

  const showTierDot = row.overallTier !== "observed";
  const showStale = (row.staleDays ?? 0) > 0;
  const showInst = isInstitutionBasis(row.basisUsed);
  const sharePct = row.share != null ? Math.max(0, Math.min(1, row.share)) * 100 : 0;

  // Investment facts (native currency): cost basis + value-vs-cost, only when the
  // provider gave a cost basis and quantity is usable. `nativeValue` and `costBasis`
  // are both native-currency, so the difference is currency-consistent.
  const costBasis = costBasisOf(row);
  const nativeCcy = row.currency ?? reportingCurrency;
  const hasBasis = costBasis != null && costBasis !== 0;
  const avgCost = hasBasis && row.quantity != null && row.quantity !== 0 ? costBasis / row.quantity : null;
  const vsCost = hasBasis && row.nativeValue != null ? row.nativeValue - (costBasis as number) : null;
  const vsCostPct = vsCost != null && hasBasis ? (vsCost / (costBasis as number)) * 100 : null;
  const vsColor = vsCost == null ? undefined : vsCost > 0 ? "var(--accent-positive, #34d399)" : vsCost < 0 ? "var(--accent-negative, #f87171)" : "var(--text-secondary)";

  return (
    <div className={unvalued ? "opacity-60" : undefined}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-3 py-2.5 text-left min-w-0">
        <span className="w-5 shrink-0 text-xs tabular-nums text-right" style={{ color: "var(--text-faint)" }}>{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{label}</span>
            {showTierDot && <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tierDotColor(row.overallTier) }} aria-hidden />}
            {row.conflicted && <AlertTriangle size={12} className="shrink-0" style={{ color: "var(--accent-warning, #f59e0b)" }} aria-hidden />}
            {open ? <ChevronDown size={13} className="shrink-0" style={{ color: "var(--text-faint)" }} /> : <ChevronRight size={13} className="shrink-0" style={{ color: "var(--text-faint)" }} />}
          </div>
          {sublabel && <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{sublabel}</p>}
          {row.share != null && (
            <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
              <div className="h-full rounded-full" style={{ width: `${sharePct}%`, background: "var(--meridian-400)" }} />
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>
            {unvalued ? "—" : formatCurrencyExact(row.reportingValue as number, reportingCurrency)}
          </p>
          <p className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
            {row.quantity != null ? row.quantity : "—"}
            {row.nativePrice != null && row.currency && <> × {formatCurrencyExact(row.nativePrice, row.currency)}</>}
          </p>
          <p className="text-xs tabular-nums flex items-center justify-end gap-1" style={{ color: "var(--text-faint)" }}>
            {row.share != null && <span>{(row.share * 100).toFixed(1)}%</span>}
            {showInst && <span title="Valued from an institution-reported figure">inst.</span>}
            {showStale && <span>· {row.staleDays}d</span>}
          </p>
        </div>
      </button>

      {open && (
        <div className="ml-8 mb-2 rounded-lg px-3 py-2.5 flex flex-col gap-2" style={{ background: "var(--surface-inset)" }}>
          {/* ── Investment facts first (§6). ── */}
          <div className="flex flex-col gap-1">
            {!unvalued && <DetailRow label="Current value" value={formatCurrencyExact(row.reportingValue as number, reportingCurrency)} />}
            {row.quantity != null && <DetailRow label="Quantity" value={String(row.quantity)} />}
            {row.nativePrice != null && <DetailRow label="Price" value={formatCurrencyExact(row.nativePrice, nativeCcy)} />}
            {avgCost != null && <DetailRow label="Avg cost / unit" value={formatCurrencyExact(avgCost, nativeCcy)} />}
            {hasBasis && <DetailRow label="Cost basis" value={formatCurrencyExact(costBasis as number, nativeCcy)} />}
            {vsCost != null && (
              <DetailRow label="Value vs cost" valueColor={vsColor}
                value={`${vsCost >= 0 ? "+" : "−"}${formatCurrencyExact(Math.abs(vsCost), nativeCcy)}${vsCostPct != null ? ` (${vsCost >= 0 ? "+" : ""}${formatPercent(vsCostPct)})` : ""}`} />
            )}
            <DetailRow label="Account" value={accountName} />
          </div>

          {/* ── Valuation evidence, demoted (§7). ── */}
          <div className="pt-2 border-t flex flex-col gap-1" style={{ borderColor: "var(--border-hairline)" }}>
            <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Valuation evidence</p>
            <div className="flex flex-wrap gap-1.5">
              {(["Quantity", "Price", "FX", "Overall"] as const).map((k, i) => {
                const tier = [row.quantityTier, row.priceTier, row.fxTier, row.overallTier][i];
                return (
                  <span key={k} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--glass-ultrathin)", color: "var(--text-muted)" }}>
                    {k} {TIER_LABEL[tier]}
                  </span>
                );
              })}
            </div>
            <div className="flex flex-col gap-0.5 mt-0.5">
              {row.basisUsed && <DetailRow label="Price source" value={row.basisUsed} />}
              {row.priceDate && <DetailRow label="Price date" value={row.priceDate} />}
              {(row.staleDays ?? 0) > 0 && <DetailRow label="Staleness" value={`${row.staleDays} day${row.staleDays === 1 ? "" : "s"}`} />}
            </div>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>{row.reason}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders every row given, in DTO order. */
function HoldingsList({ rows, reportingCurrency, accountName }: {
  rows: ValuedHoldingRow[]; reportingCurrency: string; accountName: (id: string) => string;
}) {
  return (
    <div className="divide-y divide-[var(--border-hairline)]">
      {rows.map((row, i) => (
        <HoldingRow key={`${row.instrumentId}:${row.accountId}`} row={row} rank={i + 1}
          reportingCurrency={reportingCurrency} accountName={accountName(row.accountId)} />
      ))}
    </div>
  );
}

export function InvestmentsHoldings({ holdings, reportingCurrency, accounts }: {
  holdings: ValuedHoldingRow[]; reportingCurrency: string; accounts: { id: string; name: string }[];
}) {
  const [showAll, setShowAll] = useState(false);
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? "Unknown account";

  if (holdings.length === 0) {
    return <p className="text-sm text-center py-8" style={{ color: "var(--text-muted)" }}>No holdings to show for this date.</p>;
  }

  const top = holdings.slice(0, TOP_N);

  return (
    <div>
      {/* The card surfaces only the top 5 — the rest live one tap away in the modal. */}
      <HoldingsList rows={top} reportingCurrency={reportingCurrency} accountName={accountName} />

      {holdings.length > TOP_N && (
        <button type="button" onClick={() => setShowAll(true)}
          className="flex items-center justify-center gap-1.5 w-full mt-2 pt-2 border-t text-sm font-medium transition-colors"
          style={{ borderColor: "var(--border-hairline)", color: "var(--meridian-400)" }}>
          Show all {holdings.length} holdings
        </button>
      )}

      {showAll && (
        <GlassModal title="All holdings" subtitle={`${holdings.length} positions`} icon={TrendingUp} size="lg" onClose={() => setShowAll(false)}>
          <HoldingsList rows={holdings} reportingCurrency={reportingCurrency} accountName={accountName} />
        </GlassModal>
      )}
    </div>
  );
}
