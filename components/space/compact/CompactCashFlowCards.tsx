"use client";

/**
 * components/space/compact/CompactCashFlowCards.tsx  (COMPACT DASHBOARD — P4)
 *
 * The compact (<1024px) second row of Cash Flow summary cards, under the existing
 * Cash In / Cash Out (or Income / Spending) tiles — together the 2×2 summary.
 * Presentation only: every value and handler comes from CashFlowSummaryWidget's
 * existing facts, context projection and slice drawer.
 *
 *   Charged on credit — the canonical facts.creditCardSpending and its existing
 *                       drill-down; liquidity view only (in the economic view card
 *                       purchases are already inside Spending — unchanged).
 *   Moved, not spent  — NO total, on purpose: the context rows are per-disposition
 *                       Σ|amount| and are never summed. The card says how many kinds
 *                       of movement there are and discloses the existing rows.
 *
 * Desktop never renders it (root lg:hidden).
 */

import { ChevronDown } from "lucide-react";

const CARD = "flex min-h-[96px] flex-col items-start justify-between rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)] touch-manipulation";
const EYEBROW = "text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]";

export function CompactCashFlowCards({ economic, charged, onOpenCharged, movedKinds, movedOpen, onToggleMoved }: {
  economic: boolean;
  /** Formatted facts.creditCardSpending, or null when nothing was charged. */
  charged: string | null;
  onOpenCharged: () => void;
  /** How many "Moved, not spent" categories the existing projection holds. */
  movedKinds: number;
  movedOpen: boolean;
  onToggleMoved: () => void;
}) {
  return (
    <div className={`lg:hidden grid gap-3 ${economic ? "grid-cols-1" : "grid-cols-2"}`} data-compact-cashflow-cards>
      {!economic && (
        <button type="button" onClick={onOpenCharged} disabled={charged === null} className={`${CARD} enabled:hover:bg-[var(--surface-hover)]`}>
          <span className={EYEBROW}>Charged on credit</span>
          <span className="text-[17px] font-semibold tabular-nums text-[var(--text-primary)]">{charged ?? "None"}</span>
          <span className="text-[11px] leading-snug text-[var(--text-muted)]">No cash moved at purchase</span>
        </button>
      )}
      <button type="button" onClick={onToggleMoved} aria-expanded={movedOpen} className={`${CARD} border-dashed hover:bg-[var(--surface-hover)]`}>
        <span className={EYEBROW}>Moved, not spent</span>
        <span className="text-[17px] font-semibold text-[var(--text-primary)]">
          {movedKinds > 0 ? `${movedKinds} ${movedKinds === 1 ? "kind" : "kinds"}` : "None"}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
          {movedOpen ? "Hide details" : "Show details"}
          <ChevronDown size={12} aria-hidden className={movedOpen ? "rotate-180" : ""} />
        </span>
      </button>
    </div>
  );
}
