"use client";

/**
 * components/space/widgets/investments/HoldingsLedger.tsx
 *
 * The Holdings LEDGER — the prototype's holdings idiom. NOT a table, NOT a card grid:
 * an opaque read-Surface of divided rows, each with an inline weight bar whose LENGTH
 * is its share of the portfolio (the bar IS the allocation view, folded in — no legend).
 *
 * The main workspace answers "what matters most?", so it shows only the TOP few by
 * value. "View all holdings →" opens the full, searchable list in a LEFT PANEL (context
 * / exploration — the Atlas panel primitive); picking a holding in either place opens
 * its detail in a RIGHT PANEL (contextual detail). Editorial overview → analytical
 * exploration → contextual detail, expressed as three surfaces.
 *
 * Presentation only — every figure is the InvestmentsSpaceData contract's, already
 * display-converted by the Workspace. Ranking/order is the DTO's, unchanged.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, Search } from "lucide-react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { formatCurrency } from "@/lib/format";
import { Surface } from "@/components/atlas/Surface";
import { LeftPanel, RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { rowKey, rowLabel, tierDotColor } from "./holdings-util";
import { HoldingDetail } from "./HoldingDetail";

const DEFAULT_TOP_N = 4;

export function HoldingsLedger({
  holdings,
  reportingCurrency,
  accounts,
  topN = DEFAULT_TOP_N,
}: {
  holdings:          ValuedHoldingRow[];
  reportingCurrency: string;
  accounts:          { id: string; name: string }[];
  topN?:             number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = selectedId ? holdings.find((r) => rowKey(r) === selectedId) ?? null : null;
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  const top = holdings.slice(0, topN);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return holdings;
    return holdings.filter((r) => (rowLabel(r).toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q)));
  }, [holdings, query]);

  if (holdings.length === 0) {
    return (
      <Surface className="px-4 py-8">
        <p className="text-center text-sm text-[var(--text-muted)]">No holdings to show for this date.</p>
      </Surface>
    );
  }

  const open = (id: string) => setSelectedId(id);
  // From the browser: pick → close the browser and open the detail (one panel at a time).
  const openFromBrowser = (id: string) => { setSelectedId(id); setBrowserOpen(false); };

  return (
    <>
      <Surface className="divide-y divide-[var(--border-hairline)] overflow-hidden">
        {top.map((row) => (
          <HoldingLedgerRow key={rowKey(row)} row={row} reportingCurrency={reportingCurrency} onOpen={() => open(rowKey(row))} />
        ))}
      </Surface>

      {holdings.length > topN && (
        <button
          type="button"
          onClick={() => { setQuery(""); setBrowserOpen(true); }}
          className="mt-2 text-xs font-medium text-[var(--meridian-400)] hover:underline"
        >
          View all {holdings.length} holdings →
        </button>
      )}

      {/* Left panel — the full, searchable holdings browser (context / exploration). */}
      <LeftPanel open={browserOpen} onClose={() => setBrowserOpen(false)} ariaLabel="All holdings">
        <PanelHeader title="Holdings" />
        <PanelContent className="px-0">
          <div className="px-5 pb-3">
            <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-muted)] px-3 py-2">
              <Search size={14} className="shrink-0 text-[var(--text-faint)]" aria-hidden />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search holdings"
                aria-label="Search holdings"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none"
              />
            </div>
          </div>
          <div className="divide-y divide-[var(--border-hairline)]">
            {filtered.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-[var(--text-muted)]">No holdings match “{query}”.</p>
            ) : (
              filtered.map((row) => (
                <HoldingLedgerRow key={rowKey(row)} row={row} reportingCurrency={reportingCurrency} onOpen={() => openFromBrowser(rowKey(row))} />
              ))
            )}
          </div>
        </PanelContent>
      </LeftPanel>

      {/* Right panel — the selected holding's detail (contextual detail). */}
      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel="Holding detail">
        {selected && (
          <>
            <PanelHeader eyebrow={selected.symbol ?? undefined} title={rowLabel(selected)} />
            <PanelContent>
              <HoldingDetail row={selected} reportingCurrency={reportingCurrency} accountName={accountName(selected.accountId)} hideIdentity />
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
