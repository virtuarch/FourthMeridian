"use client";

/**
 * components/space/widgets/TransactionSliceDrawer.tsx
 *
 * Cash Flow drill-down (UX-PER-3). A generic slice viewer: given the label of a
 * clicked visual element (a calendar day, a history bucket card, a spending
 * category, an income source) and the transactions that produced it, it shows
 * that slice's income / spending / net totals and the underlying transaction
 * rows.
 *
 * ── Surface (UX-CLOSE-2) ──────────────────────────────────────────────────────
 * This is a PANEL, not a modal. It was a centered GlassModal, which claimed
 * "pause and complete a decision" for what is actually "tell me more about what
 * I selected" — the file has always been named Drawer.
 *
 * The spatial language it now obeys:
 *   LEFT   browse — pick from a set ("all categories")
 *   CENTER the workspace
 *   RIGHT  inspect — what is inside the one thing I selected
 *
 * A transaction slice is INSPECT, so it docks right, exactly like the ledger
 * detail panels. Content does not decide the edge — role does: this renders a
 * LIST, but the question is "what produced this number", not "which one do I
 * want". Opened from inside a category detail it simply stacks one level
 * deeper via the shared PanelStack.
 *
 * It owns NO data of its own — the caller passes the already-loaded, already-
 * filtered Cash Flow rows for the slice, and the drawer only presents them. All
 * money math reuses economicTotals (the economic projection over the single
 * foldEconomicRow authority — same FlowType doctrine), so the drawer's totals
 * always match the visualization that opened it. The row visual mirrors
 * SpaceTransactionsPanel's TxRow. Rendered in-place (portaled modal), so it never
 * navigates away from the Cash Flow Perspective.
 */

import { useState } from "react";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { economicTotals } from "@/lib/transactions/cash-flow";
import { TransactionDate } from "@/components/ui/TransactionDate";
import { Waves, Layers, ListFilter } from "lucide-react";

export interface TransactionSlice {
  title:     string;
  subtitle?: string;
  rows:      Transaction[];
  /** CF-2B — the FULL day/bucket rows behind "Show all activity". When present, a
   *  toggle lets the user switch from the measure-filtered `rows` to every
   *  transaction that day, grouped by canonical FlowType. Display-only: it never
   *  changes any heat-map total and adds no query path. */
  allRows?:      Transaction[];
  /** What the filtered `rows` represent (the active measure), for the toggle label. */
  measureLabel?: string;
  /** An explicit reconciling total for slices whose rows are neither INCOME nor
   *  SPENDING (debt payments, cash-in-by-reason transfers, …), where the
   *  FlowType-based income/spend totals are both zero and would otherwise leave
   *  the drawer showing only a transaction count. Presentation only — it is the
   *  clicked value the caller already computed, so the drawer visibly reconciles
   *  with the row/segment that opened it. Shown only when income and spend are 0. */
  total?:        number;
  totalLabel?:   string;
}

/** Friendly, canonical FlowType group labels (the persisted `flowType` fact). */
const FLOW_GROUP_LABEL: Record<string, string> = {
  SPENDING: "Spending", INCOME: "Income", REFUND: "Refunds", DEBT_PAYMENT: "Debt payments",
  TRANSFER: "Transfers", INVESTMENT: "Investment activity", FEE: "Fees", INTEREST: "Interest",
  ADJUSTMENT: "Adjustments", UNKNOWN: "Unclassified",
};
const FLOW_GROUP_ORDER = ["SPENDING", "FEE", "INTEREST", "REFUND", "INCOME", "DEBT_PAYMENT", "TRANSFER", "INVESTMENT", "ADJUSTMENT", "UNKNOWN"];

function money(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(v));
}

function rowMoney(t: Transaction): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: t.currency ?? DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(t.amount));
}

function TxRow({ t }: { t: Transaction }) {
  const credit = t.amount > 0;
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <TransactionDate date={t.date} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate text-[var(--text-primary)]">{t.merchantDisplayName ?? t.merchant}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-[var(--surface-inset)] text-[var(--text-secondary)]">{t.category}</span>
          {t.pending && <span className="text-xs text-[var(--text-faint)]">Pending</span>}
        </div>
      </div>
      <p className="text-sm font-bold tabular-nums shrink-0" style={{ color: credit ? "var(--accent-positive)" : "var(--text-primary)" }}>
        {credit ? "+" : "−"}{rowMoney(t)}
      </p>
    </div>
  );
}

/** Group rows by canonical FlowType, in a stable, human order. */
function groupByFlow(rows: Transaction[]): { key: string; label: string; rows: Transaction[] }[] {
  const byFlow = new Map<string, Transaction[]>();
  for (const t of rows) {
    const k = t.flowType ?? "UNKNOWN";
    (byFlow.get(k) ?? byFlow.set(k, []).get(k)!).push(t);
  }
  return FLOW_GROUP_ORDER
    .filter((k) => byFlow.has(k))
    .map((k) => ({ key: k, label: FLOW_GROUP_LABEL[k] ?? k, rows: byFlow.get(k)! }));
}

/**
 * Slice state with TIME INVALIDATION (UX-CLOSE-2B).
 *
 * A slice answers a question asked of a specific window ("what moved on Jul 16",
 * "what is in Dining this month"). When TimelineLens moves, that question is no
 * longer the one on screen — the workspace behind the panel now describes a
 * different period while the panel still shows the old one. Selection is not
 * merely stale here, it is wrong.
 *
 * So the invariant is: a change in `invalidationKey` closes the panel. Callers
 * pass whatever identifies their window (`periodKey(period)`); one hook means
 * four call sites cannot each get it subtly different.
 *
 * Uses the sanctioned adjust-state-during-render pattern (no effect, no flash),
 * matching CashFlowHistoryWidget's existing mode reset.
 */
export function useTransactionSlice(
  invalidationKey: string,
): [TransactionSlice | null, (next: TransactionSlice | null) => void] {
  const [slice, setSlice] = useState<TransactionSlice | null>(null);
  const [prevKey, setPrevKey] = useState(invalidationKey);

  if (invalidationKey !== prevKey) {
    setPrevKey(invalidationKey);
    setSlice(null);
  }

  return [slice, setSlice];
}

/**
 * `slice` is now NULLABLE and the component is ALWAYS mounted, because Panel
 * animates on an `open` transition: `usePresence` seeds its settled state from
 * `open`, so a component mounted already-open plays neither entrance nor exit.
 * Conditional mounting would therefore have made the panel appear and vanish
 * instantly — a regression against the modal it replaces.
 *
 * Consequence handled here: with a persistent mount, per-slice state no longer
 * resets via remount. `lastSlice` keeps the previous content painted through the
 * exit (so the panel does not blank as it slides away), and `showAll` is reset
 * whenever the slice identity changes — otherwise "Show all activity" would leak
 * from one day into the next. Both use the sanctioned adjust-state-during-render
 * pattern (no effect, no flash), matching CashFlowHistoryWidget's period reset.
 */
export function TransactionSliceDrawer({
  slice, ctx, onClose,
}: {
  slice:   TransactionSlice | null;
  ctx?:    ConversionContext;
  onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [lastSlice, setLastSlice] = useState<TransactionSlice | null>(slice);

  if (slice && slice !== lastSlice) {
    setLastSlice(slice);
    setShowAll(false);
  }

  const shown = slice ?? lastSlice;

  // "Show all activity" is offered only when the full day/bucket set has MORE rows
  // than the measure-filtered slice (otherwise the toggle is a no-op).
  const canShowAll = !!shown?.allRows && shown.allRows.length > shown.rows.length;
  const viewingAll = showAll && canShowAll;
  const displayRows = shown ? (viewingAll ? shown.allRows! : shown.rows) : [];

  const { income, spend, net } = economicTotals(displayRows, ctx);

  return (
    <RightPanel open={slice != null} onClose={onClose} ariaLabel="Transaction slice">
      {shown && (
      <>
      <PanelHeader eyebrow={shown.subtitle} title={shown.title} />
      <PanelContent>
      {/* Totals — reuse the exact Cash Flow doctrine so they match the source. */}
      <div className="flex items-center gap-4 flex-wrap px-1 pb-2 text-sm">
        {/* Explicit reconciling total for neutral-flow slices (debt payments,
            cash-in-by-reason) where income/spend are both 0. Matches the clicked
            value, so the drawer visibly reconciles with what opened it. */}
        {income <= 0 && spend <= 0 && shown.total != null && !viewingAll && (
          <span className="text-[var(--text-secondary)]">
            {shown.totalLabel ?? "Total"} <span className="font-semibold text-[var(--text-primary)]">{money(shown.total, ctx)}</span>
          </span>
        )}
        {income > 0 && (
          <span className="text-[var(--text-secondary)]">
            Income <span className="font-semibold text-[var(--accent-positive)]">+{money(income, ctx)}</span>
          </span>
        )}
        {spend > 0 && (
          <span className="text-[var(--text-secondary)]">
            Spending <span className="font-semibold text-[var(--accent-negative)]">−{money(spend, ctx)}</span>
          </span>
        )}
        {(income > 0 || spend > 0) && (
          <span className="text-[var(--text-secondary)]">
            Net <span className="font-semibold" style={{ color: net >= 0 ? "var(--accent-positive)" : "var(--accent-negative)" }}>
              {net >= 0 ? "+" : "−"}{money(Math.abs(net), ctx)}
            </span>
          </span>
        )}
        <span className="text-[var(--text-faint)] ml-auto">
          {displayRows.length} {displayRows.length === 1 ? "transaction" : "transactions"}
        </span>
      </div>

      {/* CF-2B — Show all activity / back to the selected measure. Clearly states
          which view is active; display-only, changes no total. */}
      {canShowAll && (
        <div className="flex items-center gap-2 px-1 pb-3">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-full)] px-2.5 py-1 text-[11px] font-semibold text-[var(--meridian-400)] transition-colors"
            style={{ background: "rgba(59,130,246,.12)", border: "1px solid rgba(125,168,255,.32)" }}
          >
            {viewingAll ? <ListFilter size={12} /> : <Layers size={12} />}
            {viewingAll ? `Show only ${shown.measureLabel ?? "the selected measure"}` : "Show all activity"}
          </button>
          <span className="text-[10px] text-[var(--text-faint)]">
            {viewingAll ? "Every transaction this day, grouped by type" : `Filtered to ${shown.measureLabel ?? "the selected measure"}`}
          </span>
        </div>
      )}

      {displayRows.length === 0 ? (
        <div className="text-center py-10">
          <Waves size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-muted)]">No transactions in this slice</p>
        </div>
      ) : viewingAll ? (
        <div className="space-y-3">
          {groupByFlow(displayRows).map((g) => (
            <div key={g.key} className="rounded-xl overflow-hidden border border-[var(--border-hairline)]">
              <p className="px-4 py-1.5 text-[10px] uppercase tracking-wide text-[var(--text-faint)] bg-[var(--surface-inset)]">
                {g.label} · {g.rows.length}
              </p>
              <div className="divide-y divide-[var(--border-hairline)]">
                {g.rows.map((t) => <TxRow key={t.id} t={t} />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-[var(--border-hairline)]">
          <div className="divide-y divide-[var(--border-hairline)]">
            {displayRows.map((t) => <TxRow key={t.id} t={t} />)}
          </div>
        </div>
      )}
      </PanelContent>
      </>
      )}
    </RightPanel>
  );
}
