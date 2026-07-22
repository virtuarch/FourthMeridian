"use client";

/**
 * RecentTransactionsPanel
 *
 * Compact "Recent Transactions" preview for the Overview tab — real rows
 * from lib/data/transactions.ts's getTransactions() (banking transactions,
 * newest first; no new query logic, just a new place reading it), shown
 * as a short glass list with a "View all" affordance instead of a dense
 * table. Mirrors the same preview/"View all" shape as
 * SpaceTimelineWidget's `variant="preview"` so the Overview's two history
 * surfaces (Recent Activity, Recent Transactions) read as siblings.
 *
 * `onViewAll` is a callback (not a Link) so the host can route to whatever
 * its own Transactions tab id is — same pattern SpaceTimelinePanel already
 * uses for "View full timeline".
 */

import { Receipt } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { formatCurrencyExact } from "@/lib/format";
import type { Transaction } from "@/types";

function txDateLabel(iso: string): string {
  // Transaction.date is a plain "YYYY-MM-DD" — parse as UTC noon so the
  // displayed day never shifts backward in negative-UTC-offset timezones.
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function TxRow({ tx }: { tx: Transaction }) {
  const isCredit = tx.amount > 0;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--surface-hover)]">
      <div className="w-7 h-7 rounded-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center shrink-0">
        <Receipt size={13} className="text-[var(--text-muted)]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text-primary)] truncate">{tx.merchantDisplayName ?? tx.merchant}{/* MI M6 — resolved name, raw fallback */}</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          {txDateLabel(tx.date)}
          {tx.pending ? " · Pending" : ""}
        </p>
      </div>
      <p
        className={[
          "text-sm font-semibold tabular-nums shrink-0",
          isCredit ? "text-[var(--emerald-400)]" : "text-[var(--text-primary)]",
        ].join(" ")}
      >
        {isCredit ? "+" : "−"}
        {/* MC1 QA Q4b — itemized row: format in the transaction's own native
            currency (null-residue falls back to the display default). */}
        {formatCurrencyExact(Math.abs(tx.amount), tx.currency ?? undefined)}
      </p>
    </div>
  );
}

export function RecentTransactionsPanel({
  transactions,
  previewCount = 5,
  onViewAll,
  scopeNote,
}: {
  transactions: Transaction[];
  previewCount?: number;
  onViewAll?: () => void;
  /** Honesty label for shared Spaces, where KD-15 makes the list
   *  structurally partial (FULL-visibility shares only) — e.g. "From fully
   *  shared accounts only". Omit on Personal, where the list is complete. */
  scopeNote?: string;
}) {
  const rows = transactions.slice(0, previewCount);

  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
      <div className="flex items-center justify-between gap-2 px-1 mb-1">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--text-primary)]">Recent Transactions</p>
          {scopeNote && (
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate">{scopeNote}</p>
          )}
        </div>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-xs font-medium text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors"
          >
            View all
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Receipt size={18} className="text-[var(--text-muted)] mb-2" />
          <p className="text-sm text-[var(--text-secondary)]">No transactions yet.</p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {rows.map((tx) => (
            <TxRow key={tx.id} tx={tx} />
          ))}
        </div>
      )}
    </GlassPanel>
  );
}
