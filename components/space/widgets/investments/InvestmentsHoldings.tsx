"use client";

/**
 * components/space/widgets/investments/InvestmentsHoldings.tsx
 *
 * The dominant Investments panel: one row per holding, ranked as the DTO ranked
 * them (value desc, unvalued last). Each row shows rank, symbol/name, quantity,
 * native unit price + currency, the reporting-currency value, and a composition
 * weight bar driven by `share` (0..1 of the VALUED subtotal). Unvalued positions
 * are never dropped — they render as dimmed real rows with their quantity and a
 * value of "—".
 *
 * Honesty machinery is quiet by construction (plan §3.4): trust marks render
 * ONLY when something is off — a tier dot when `overallTier !== "observed"`, a
 * "· Nd" staleness mark when `staleDays > 0`, an "inst." mark on an
 * institution-value/-price basis, and a conflict glyph when `conflicted`. A
 * clean row (observed, fresh, market/cash basis, no conflict) shows zero marks.
 * All the detail — the four tiers, the basis, the price date, the staleness, the
 * plain-English reason, and the owning account — lives one tap deep in the
 * expandable row (S2), never as inline caveat prose.
 *
 * Presentation only: every row is always in the DOM; past ~15 rows a "show all"
 * expander collapses the tail, hiding nothing from the honesty model.
 */

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import { formatCurrencyExact } from "@/lib/format";

const COLLAPSE_AFTER = 15;

/** Human tier label for the tap-in detail (matches the platform trust vocabulary). */
const TIER_LABEL: Record<CompletenessTier, string> = {
  observed:   "Observed",
  derived:    "Derived",
  estimated:  "Estimated",
  incomplete: "Incomplete",
  unknown:    "Unknown",
};

/** Dot colour for a non-observed overall tier. Observed rows render no dot. */
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

/** A compact "field: value" line for the tap-in trust detail. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs" style={{ color: "var(--text-faint)" }}>{label}</span>
      <span className="text-xs tabular-nums text-right" style={{ color: "var(--text-secondary)" }}>{value}</span>
    </div>
  );
}

function HoldingRow({
  row,
  rank,
  reportingCurrency,
  accountName,
}: {
  row:               ValuedHoldingRow;
  rank:              number;
  reportingCurrency: string;
  accountName:       string;
}) {
  const [open, setOpen] = useState(false);
  const unvalued = row.reportingValue == null;
  const label = row.symbol ?? row.name ?? row.instrumentId;
  const sublabel = row.symbol && row.name ? row.name : null;

  // Inline trust marks — render ONLY when off (plan §3.4).
  const showTierDot = row.overallTier !== "observed";
  const showStale = (row.staleDays ?? 0) > 0;
  const showInst = isInstitutionBasis(row.basisUsed);

  const sharePct = row.share != null ? Math.max(0, Math.min(1, row.share)) * 100 : 0;

  return (
    <div className={unvalued ? "opacity-60" : undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-2.5 text-left min-w-0"
      >
        <span className="w-5 shrink-0 text-xs tabular-nums text-right" style={{ color: "var(--text-faint)" }}>{rank}</span>

        {/* Identity + weight bar. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{label}</span>
            {showTierDot && (
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: tierDotColor(row.overallTier) }}
                aria-hidden
              />
            )}
            {row.conflicted && <AlertTriangle size={12} className="shrink-0" style={{ color: "var(--accent-warning, #f59e0b)" }} aria-hidden />}
            {open ? <ChevronDown size={13} className="shrink-0" style={{ color: "var(--text-faint)" }} /> : <ChevronRight size={13} className="shrink-0" style={{ color: "var(--text-faint)" }} />}
          </div>
          {sublabel && <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{sublabel}</p>}
          {/* Composition weight bar (valued rows only). */}
          {row.share != null && (
            <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
              <div className="h-full rounded-full" style={{ width: `${sharePct}%`, background: "var(--meridian-400)" }} />
            </div>
          )}
        </div>

        {/* Value + quantity × native price. */}
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>
            {unvalued ? "—" : formatCurrencyExact(row.reportingValue as number, reportingCurrency)}
          </p>
          <p className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
            {row.quantity != null ? row.quantity : "—"}
            {row.nativePrice != null && row.currency && (
              <> × {formatCurrencyExact(row.nativePrice, row.currency)}</>
            )}
          </p>
          <p className="text-xs tabular-nums flex items-center justify-end gap-1" style={{ color: "var(--text-faint)" }}>
            {row.share != null && <span>{(row.share * 100).toFixed(1)}%</span>}
            {showInst && <span title="Valued from an institution-reported figure">inst.</span>}
            {showStale && <span>· {row.staleDays}d</span>}
          </p>
        </div>
      </button>

      {/* S2 — tap-in trust detail: four tiers, basis, price date, staleness,
          reason, owning account. No new data — all from the row. */}
      {open && (
        <div
          className="ml-8 mb-2 rounded-lg px-3 py-2.5 flex flex-col gap-1"
          style={{ background: "var(--surface-inset)" }}
        >
          <DetailRow label="Quantity" value={TIER_LABEL[row.quantityTier]} />
          <DetailRow label="Price" value={TIER_LABEL[row.priceTier]} />
          <DetailRow label="FX" value={TIER_LABEL[row.fxTier]} />
          <DetailRow label="Overall" value={TIER_LABEL[row.overallTier]} />
          {row.basisUsed && <DetailRow label="Basis" value={row.basisUsed} />}
          {row.priceDate && <DetailRow label="Price date" value={row.priceDate} />}
          {(row.staleDays ?? 0) > 0 && <DetailRow label="Staleness" value={`${row.staleDays} day${row.staleDays === 1 ? "" : "s"}`} />}
          <DetailRow label="Account" value={accountName} />
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{row.reason}</p>
        </div>
      )}
    </div>
  );
}

export function InvestmentsHoldings({
  holdings,
  reportingCurrency,
  accounts,
}: {
  holdings:          ValuedHoldingRow[];
  reportingCurrency: string;
  accounts:          { id: string; name: string }[];
}) {
  const [showAll, setShowAll] = useState(false);
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? "Unknown account";

  if (holdings.length === 0) {
    return <p className="text-sm text-center py-8" style={{ color: "var(--text-muted)" }}>No holdings to show for this date.</p>;
  }

  // Every row stays in DOM state; the tail is collapsed for readability only.
  const visible = showAll ? holdings : holdings.slice(0, COLLAPSE_AFTER);

  return (
    <div>
      <div className="divide-y divide-[var(--border-hairline)]">
        {visible.map((row, i) => (
          <HoldingRow
            key={`${row.instrumentId}:${row.accountId}`}
            row={row}
            rank={i + 1}
            reportingCurrency={reportingCurrency}
            accountName={accountName(row.accountId)}
          />
        ))}
      </div>
      {holdings.length > COLLAPSE_AFTER && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="flex items-center justify-center gap-1.5 w-full mt-2 pt-2 border-t text-sm font-medium transition-colors"
          style={{ borderColor: "var(--border-hairline)", color: "var(--meridian-400)" }}
        >
          {showAll ? "Show fewer" : `Show all ${holdings.length} holdings`}
        </button>
      )}
    </div>
  );
}
