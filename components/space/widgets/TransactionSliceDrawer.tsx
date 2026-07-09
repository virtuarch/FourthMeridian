"use client";

/**
 * components/space/widgets/TransactionSliceDrawer.tsx
 *
 * Cash Flow drill-down (UX-PER-3). A generic slice viewer: given the label of a
 * clicked visual element (a calendar day, a history bucket card, a spending
 * category, an income source) and the transactions that produced it, it opens a
 * GlassModal showing that slice's income / spending / net totals and the
 * underlying transaction rows.
 *
 * It owns NO data of its own — the caller passes the already-loaded, already-
 * filtered Cash Flow rows for the slice, and the drawer only presents them. All
 * money math reuses aggregateCashFlow (the same FlowType doctrine), so the
 * drawer's totals always match the visualization that opened it. The row visual
 * mirrors SpaceTransactionsPanel's TxRow. Rendered in-place (portaled modal), so
 * it never navigates away from the Cash Flow Perspective.
 */

import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { aggregateCashFlow } from "@/lib/transactions/cash-flow";
import { Waves } from "lucide-react";

export interface TransactionSlice {
  title:     string;
  subtitle?: string;
  rows:      Transaction[];
}

function money(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(v));
}

function rowMoney(t: Transaction): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: t.currency ?? DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(t.amount));
}

export function TransactionSliceDrawer({
  slice, ctx, onClose,
}: {
  slice:   TransactionSlice;
  ctx?:    ConversionContext;
  onClose: () => void;
}) {
  const { income, spend, net } = aggregateCashFlow(slice.rows, ctx);

  return (
    <GlassModal title={slice.title} subtitle={slice.subtitle} icon={Waves} onClose={onClose} size="md">
      {/* Totals — reuse the exact Cash Flow doctrine so they match the source. */}
      <div className="flex items-center gap-4 flex-wrap px-1 pb-3 text-sm">
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
          {slice.rows.length} {slice.rows.length === 1 ? "transaction" : "transactions"}
        </span>
      </div>

      {slice.rows.length === 0 ? (
        <div className="text-center py-10">
          <Waves size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-muted)]">No transactions in this slice</p>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-[var(--border-hairline)]">
          <div className="divide-y divide-[var(--border-hairline)]">
            {slice.rows.map((t) => {
              const credit = t.amount > 0;
              const d = new Date(`${t.date}T12:00:00`);
              return (
                <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 shrink-0 text-center">
                    <p className="text-xs font-semibold leading-none text-[var(--text-secondary)]">{d.toLocaleDateString("en-US", { day: "numeric" })}</p>
                    <p className="text-xs mt-0.5 text-[var(--text-faint)]">{d.toLocaleDateString("en-US", { month: "short" })}</p>
                  </div>
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
            })}
          </div>
        </div>
      )}
    </GlassModal>
  );
}
