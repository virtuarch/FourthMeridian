"use client";

/**
 * components/space/widgets/cashflow/CashFlowCategoryLedger.tsx  (CF-4)
 *
 * Cash Flow category/source EXPLORATION in the established Fourth Meridian idiom:
 *
 *   Preview  →  LeftPanel browser  →  RightPanel detail
 *
 * The main workspace answers "where does most of it go?", so the preview shows only
 * the TOP few contributions (with the Cash Flow allocation strip — the composition at
 * a glance) and a "View all N …" affordance. "View all" opens the FULL, searchable
 * list in a LEFT PANEL (context / exploration); picking any item — in the preview or
 * the browser — opens its DETAIL in a RIGHT PANEL (contextual detail), which composes
 * the EXISTING TransactionSliceDrawer for the underlying rows.
 *
 * Generic over `CashFlowContribution[]`, so ONE component serves Spending by Category
 * AND Income by Source (consistency). Presentation only — every figure is the
 * CashFlowSpaceData contract's, already display-converted by the Workspace, ordering
 * unchanged. It performs NO cash-flow calculation and opens NO new data path; the
 * transactions come from the caller's `sliceFor` (the same rows the drawer always
 * used). NOT an Atlas panel primitive — it COMPOSES LeftPanel/RightPanel.
 */

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ConversionContext } from "@/lib/money/types";
import type { CashFlowContribution } from "@/lib/transactions/cash-flow";
import type { Transaction } from "@/types";
import { formatCurrency } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { LeftPanel, RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { TransactionSliceDrawer, type TransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";
import { CashFlowCategoryDetail } from "./CashFlowCategoryDetail";

// Matches CashFlowCategoryBreakdown's palette so spend/income colours stay consistent
// with the rest of the product; cycles for >8 items.
const PALETTE = [
  "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#84cc16",
];

const DEFAULT_TOP_N = 5;

interface ColoredItem extends CashFlowContribution {
  color: string;
  pct:   number;
}

export function CashFlowCategoryLedger({
  items,
  ctx,
  totalLabel = "Total spending",
  browserTitle,
  browserEyebrow,
  noun,
  detailEyebrow,
  detailValueLabel = "this period",
  shareLabel = "Share of spending",
  sliceFor,
  sliceSubtitle,
  emptyHeadline = "No spending in this period",
  emptySubline = "Spending by category appears once you have outflows.",
  topN = DEFAULT_TOP_N,
}: {
  items:          CashFlowContribution[];   // descending, value > 0
  ctx?:           ConversionContext;
  totalLabel?:    string;
  /** Panel header title, e.g. "Spending categories" / "Income sources". */
  browserTitle:   string;
  /** Panel header eyebrow, e.g. "Spending" / "Income". */
  browserEyebrow: string;
  /** Plural unit for the "View all N {noun} →" affordance + search placeholder,
   *  e.g. "categories" / "sources". */
  noun:           string;
  /** RightPanel detail eyebrow, e.g. "Spending category" / "Income source". */
  detailEyebrow:  string;
  detailValueLabel?: string;
  shareLabel?:    string;
  /** The transactions behind one item — the SAME rows the drawer always used. */
  sliceFor:       (item: CashFlowContribution) => Transaction[];
  /** Drawer subtitle for the composed TransactionSliceDrawer. */
  sliceSubtitle?: string;
  emptyHeadline?: string;
  emptySubline?:  string;
  topN?:          number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [slice, setSlice] = useState<TransactionSlice | null>(null);

  const fmt = (v: number) => (ctx ? formatCurrency(v, ctx.target) : formatCurrency(v, DEFAULT_DISPLAY_CURRENCY));

  const total = items.reduce((s, c) => s + c.value, 0);

  const colored: ColoredItem[] = useMemo(
    () => items.map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length], pct: total > 0 ? (c.value / total) * 100 : 0 })),
    [items, total],
  );

  const selected = selectedId ? colored.find((c) => c.id === selectedId) ?? null : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return colored;
    return colored.filter((c) => c.label.toLowerCase().includes(q));
  }, [colored, query]);

  if (items.length === 0 || total <= 0) {
    return (
      <div className="py-5 space-y-1 text-center">
        <p className="text-sm text-[var(--text-secondary)]">{emptyHeadline}</p>
        <p className="text-xs text-[var(--text-faint)]">{emptySubline}</p>
      </div>
    );
  }

  const top = colored.slice(0, topN);

  const openDetail = (id: string) => setSelectedId(id);
  // From the browser: pick → close the browser and open the detail (one panel at a time).
  const openFromBrowser = (id: string) => { setSelectedId(id); setBrowserOpen(false); };

  const openTransactions = (c: ColoredItem) =>
    setSlice({ title: c.label, subtitle: sliceSubtitle, rows: sliceFor(c), total: c.value, totalLabel: "Total" });

  return (
    <div className="space-y-3">
      {/* Total header. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{totalLabel}</span>
        <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{fmt(total)}</span>
      </div>

      {/* Allocation strip — the Cash Flow composition-at-a-glance (identity signal). */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-inset)" }}>
        {colored.map((c) => (
          <span key={c.id} title={`${c.label} · ${fmt(c.value)} · ${c.pct.toFixed(1)}%`} style={{ width: `${c.pct}%`, backgroundColor: c.color }} />
        ))}
      </div>

      {/* Preview — the TOP few contributions as ledger rows. */}
      <div className="divide-y divide-[var(--border-hairline)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
        {top.map((c) => (
          <LedgerRow key={c.id} item={c} fmt={fmt} onOpen={() => openDetail(c.id)} />
        ))}
      </div>

      {colored.length > topN && (
        <button
          type="button"
          onClick={() => { setQuery(""); setBrowserOpen(true); }}
          className="text-xs font-medium text-[var(--meridian-400)] hover:underline"
        >
          View all {colored.length} {noun} →
        </button>
      )}

      {/* Left panel — the full, searchable browser (context / exploration). */}
      <LeftPanel open={browserOpen} onClose={() => setBrowserOpen(false)} ariaLabel={browserTitle}>
        <PanelHeader eyebrow={browserEyebrow} title={browserTitle} />
        <PanelContent className="px-0">
          <div className="px-5 pb-3">
            <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-2">
              <Search size={14} className="shrink-0 text-[var(--text-faint)]" aria-hidden />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${noun}`}
                aria-label={`Search ${noun}`}
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none"
              />
            </div>
          </div>
          <div className="divide-y divide-[var(--border-hairline)]">
            {filtered.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-[var(--text-muted)]">No {noun} match “{query}”.</p>
            ) : (
              filtered.map((c) => (
                <LedgerRow key={c.id} item={c} fmt={fmt} onOpen={() => openFromBrowser(c.id)} />
              ))
            )}
          </div>
        </PanelContent>
      </LeftPanel>

      {/* Right panel — the selected item's detail (contextual detail). */}
      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel={`${detailEyebrow} detail`}>
        {selected && (
          <>
            <PanelHeader eyebrow={detailEyebrow} title={selected.label} />
            <PanelContent>
              <CashFlowCategoryDetail
                label={selected.label}
                value={selected.value}
                total={total}
                color={selected.color}
                rows={sliceFor(selected)}
                ctx={ctx}
                valueLabel={detailValueLabel}
                shareLabel={shareLabel}
                onOpenTransactions={() => openTransactions(selected)}
              />
            </PanelContent>
          </>
        )}
      </RightPanel>

      {/* The EXISTING drill surface — composed, not re-implemented. */}
      {slice && <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />}
    </div>
  );
}

/** One contribution row — colour dot + label (left), value + share (right), with a
 *  bottom weight bar (share of total, tinted by the category colour) and a hover accent
 *  rail signalling "opens a detail". The ledger-row anatomy, tuned for Cash Flow. */
function LedgerRow({
  item,
  fmt,
  onOpen,
}: {
  item:   ColoredItem;
  fmt:    (v: number) => string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex w-full items-center gap-3 overflow-hidden px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
    >
      {/* Weight bar — length = share of total, tinted by the category colour (Cash Flow
          identity), sitting on the row baseline. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 transition-[width] duration-500"
        style={{ width: `${item.pct}%`, background: item.color, opacity: 0.55 }}
      />
      {/* Hover accent rail — the affordance that this row opens a detail. */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />

      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
      <span className="relative min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">{item.label}</span>

      <div className="relative shrink-0 text-right">
        <p className="text-sm tabular-nums text-[var(--text-primary)]">{fmt(item.value)}</p>
        <p className="mt-0.5 text-[11px] tabular-nums text-[var(--text-faint)]">{item.pct.toFixed(1)}%</p>
      </div>
    </button>
  );
}
