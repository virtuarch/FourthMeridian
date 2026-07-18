"use client";

/**
 * components/space/widgets/investments/HoldingsLedger.tsx
 *
 * The Holdings LEDGER — the prototype's holdings idiom brought to production. NOT a
 * table and NOT a card grid: an opaque read-Surface of divided rows, each carrying an
 * inline weight bar whose LENGTH is its share of the portfolio.
 *
 * The bar IS the allocation view, folded into the ledger where it's already relevant:
 * "these few positions carry most of this" is visible in one glance — no second chart,
 * no donut, no legend. Length is the only variable; the bar is a NEUTRAL rule (share of
 * portfolio is neither gain nor loss nor a category, so it carries no colour — colour is
 * a claim). Clicking a row opens the detail in a RightPanel (the Atlas panel primitive:
 * "tell me more about what I selected", workspace stays put behind it).
 *
 * Presentation only — every figure is the InvestmentsSpaceData contract's, already
 * display-converted by the Workspace. Ranking/order is the DTO's, unchanged.
 */

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { formatCurrency } from "@/lib/format";
import { Surface } from "@/components/atlas/Surface";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { rowKey, rowLabel, tierDotColor } from "./holdings-util";
import { HoldingDetail } from "./HoldingDetail";

export function HoldingsLedger({
  holdings,
  reportingCurrency,
  accounts,
}: {
  holdings:          ValuedHoldingRow[];
  reportingCurrency: string;
  accounts:          { id: string; name: string }[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? holdings.find((r) => rowKey(r) === selectedId) ?? null : null;
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? "Unknown account";

  if (holdings.length === 0) {
    return (
      <Surface className="px-4 py-8">
        <p className="text-center text-sm text-[var(--text-muted)]">No holdings to show for this date.</p>
      </Surface>
    );
  }

  return (
    <>
      <Surface className="divide-y divide-[var(--border-hairline)] overflow-hidden">
        {holdings.map((row) => (
          <HoldingLedgerRow
            key={rowKey(row)}
            row={row}
            reportingCurrency={reportingCurrency}
            onOpen={() => setSelectedId(rowKey(row))}
          />
        ))}
      </Surface>

      {/* Detail — the Atlas RightPanel (kept mounted through its exit animation; a
          holding stays "held" so closing animates out rather than hard-cutting). */}
      <RightPanel
        open={selected != null}
        onClose={() => setSelectedId(null)}
        ariaLabel="Holding detail"
      >
        {selected && (
          <>
            <PanelHeader eyebrow={selected.symbol ?? undefined} title={rowLabel(selected)} />
            <PanelContent>
              <HoldingDetail
                row={selected}
                reportingCurrency={reportingCurrency}
                accountName={accountName(selected.accountId)}
                hideIdentity
              />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </>
  );
}

function HoldingLedgerRow({
  row,
  reportingCurrency,
  onOpen,
}: {
  row:               ValuedHoldingRow;
  reportingCurrency: string;
  onOpen:            () => void;
}) {
  const unvalued = row.reportingValue == null;
  const label = rowLabel(row);
  const sublabel = row.symbol && row.name ? row.name : null;
  const share = row.share != null ? Math.max(0, Math.min(1, row.share)) : 0;
  const showTierDot = row.overallTier !== "observed";
  const staleDays = row.staleDays ?? 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative flex w-full items-center gap-3 overflow-hidden px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] ${
        unvalued ? "opacity-60" : ""
      }`}
    >
      {/* Weight bar — a 2px NEUTRAL rule on the row's baseline; length = share of
          portfolio. No colour (share is neither gain nor loss nor a category). */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 transition-[width] duration-500"
        style={{ width: `${share * 100}%`, background: "var(--border-hairline-strong)" }}
      />
      {/* Hover accent rail — the affordance that this row opens a detail. */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />

      <div className="relative min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-[var(--text-primary)]">
          {label}
          {showTierDot && (
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tierDotColor(row.overallTier) }} aria-hidden />
          )}
          {row.conflicted && <AlertTriangle size={11} className="shrink-0 text-[var(--accent-warning,#f59e0b)]" aria-hidden />}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          {sublabel && <span className="hidden sm:inline">{sublabel} · </span>}
          <span className="tabular-nums">{row.quantity != null ? row.quantity : "—"}</span> units
          {staleDays > 0 && <span className="text-[var(--text-faint)]"> · {staleDays}d stale</span>}
        </p>
      </div>

      <div className="relative shrink-0 text-right">
        <p className={`tabular-nums text-sm ${unvalued ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
          {unvalued ? "—" : formatCurrency(row.reportingValue as number, reportingCurrency)}
        </p>
        {row.share != null && (
          <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">{(row.share * 100).toFixed(1)}%</p>
        )}
      </div>
    </button>
  );
}
