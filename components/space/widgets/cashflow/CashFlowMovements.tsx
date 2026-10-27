"use client";

/**
 * components/space/widgets/cashflow/CashFlowMovements.tsx  (v2.7 final perspective UX pass)
 *
 * Cash Flow's "Transfers & movements" reconciliation section — WHAT moved that is
 * not in Cash In / Cash Out, stated as what it actually is, with its status. It
 * replaces the compact "Moved, not spent — N kinds" card (owner decision) and the
 * inline context blocks under the summary tiles:
 *
 *   Unresolved transfers · $6,879.22 · 4 transactions
 *     destination not confirmed — not counted as cash in or out        [Review]
 *
 * WORDING DISCIPLINE — every line says what the classifier established and no
 * more. An unresolved transfer is never called internal or spent; "Review" is the
 * neutral action and opens the EXISTING slice drawer on the exact rows.
 *
 * Every figure comes from existing authorities: the context projection
 * (groupCashFlowContext — per-disposition Σ|amount|, never summed across kinds),
 * the canonical facts (creditCardSpending), and the debt-payment authority (via
 * DebtPaymentsWidget). Nothing is folded here. A period with no movements renders
 * NOTHING (no empty card).
 */

import type { ReactNode } from "react";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { formatAggregateMoney } from "@/components/space/widgets/display-money";
import type { CashFlowContext } from "@/lib/transactions/cash-flow-context";
import { TransactionSliceDrawer, useTransactionSlice, type TransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";

/** One reconciliation line, ready to render (pure — see movementLines). */
export interface MovementLine {
  key:         string;
  label:       string;
  /** Σ|amount| of the line's rows, or null for a count-first line (needs classification). */
  amount:      number | null;
  count:       number;
  /** "transaction" / "purchase" — singular noun for the count. */
  noun:        string;
  /** What it is + whether it is in Cash In/Out. Never asserts more than the classifier did. */
  description: string;
  slice:       Omit<TransactionSlice, "title">;
}

/** Per-disposition descriptions (keys from groupCashFlowContext). */
export const MOVEMENT_DESCRIPTIONS: Record<string, string> = {
  "unresolved-transfers": "destination not confirmed — not counted as cash in or out",
  "between-accounts":     "moved between your own accounts — not counted as cash in or out",
  "cash-withdrawals":     "taken out as physical cash — not counted as cash out",
  "cash-deposited":       "physical cash paid in — not counted as cash in",
};
const DEFAULT_DESCRIPTION = "not counted as cash in or out";

export const CHARGED_ON_CREDIT_DESCRIPTION =
  "no cash moved at purchase — counted in Spending; cash leaves when the card is paid";
export const NEEDS_CLASSIFICATION_DESCRIPTION =
  "we can see this arrived, but not yet where from — not counted until it's identified";

/**
 * The reconciliation lines, in display order: card charges (the gap between Cash
 * Flow and Spending), then each moved-not-spent kind (largest first, as the
 * projection orders them), then the needs-classification review flags.
 */
export function movementLines(args: {
  context:      CashFlowContext;
  /** facts.creditCardSpending — GROSS card charges in the window. */
  charged:      number;
  /** The card cost-flow rows behind `charged` (the existing drill predicate). */
  chargedRows:  Transaction[];
}): MovementLine[] {
  const out: MovementLine[] = [];
  if (args.charged > 0) {
    out.push({
      key: "charged-on-credit", label: "Charged on credit", amount: args.charged,
      count: args.chargedRows.length, noun: "purchase", description: CHARGED_ON_CREDIT_DESCRIPTION,
      slice: { subtitle: "Bought on credit this period", spendLabel: "Charged", rows: args.chargedRows },
    });
  }
  for (const r of args.context.movedNotSpent) {
    out.push({
      key: r.key, label: r.label, amount: r.amount, count: r.count, noun: "transaction",
      description: MOVEMENT_DESCRIPTIONS[r.key] ?? DEFAULT_DESCRIPTION,
      slice: { subtitle: MOVEMENT_DESCRIPTIONS[r.key] ?? DEFAULT_DESCRIPTION, rows: r.rows, total: r.amount, totalLabel: "Total" },
    });
  }
  for (const r of args.context.needsClassification) {
    out.push({
      key: r.key, label: r.label, amount: null, count: r.count, noun: "transaction",
      description: NEEDS_CLASSIFICATION_DESCRIPTION,
      slice: { subtitle: "We can see this moved, but not yet why", rows: r.rows },
    });
  }
  return out;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function CashFlowMovements({
  lines,
  ctx,
  invalidationKey,
  children,
}: {
  lines:           MovementLine[];
  ctx?:            ConversionContext;
  /** The period key — an open drawer closes when the window moves. */
  invalidationKey: string;
  /** Extra reconciliation content (the debt-payments panel when there are payments). */
  children?:       ReactNode;
}) {
  const [slice, setSlice] = useTransactionSlice(invalidationKey);
  return (
    <div className="space-y-3">
      {lines.length > 0 && (
        <ul className="divide-y divide-[var(--border-hairline)]" data-movement-lines>
          {lines.map((l) => (
            <li key={l.key} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0 min-w-0" data-movement={l.key}>
              <div className="min-w-0">
                <p className="text-sm text-[var(--text-primary)]">
                  <span className="font-medium">{l.label}</span>
                  {l.amount != null && <span className="tabular-nums"> · {formatAggregateMoney(l.amount, ctx, 2)}</span>}
                  <span className="text-[var(--text-muted)]"> · {plural(l.count, l.noun)}</span>
                </p>
                <p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">{l.description}</p>
              </div>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setSlice({ title: l.label, ...l.slice })}
                aria-label={`Review ${l.label}`}
                className="shrink-0 rounded-[var(--radius-full)] px-3 py-1 text-[11px] font-semibold text-[var(--meridian-400)] max-lg:min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
                style={{ background: "var(--glass-ultrathin)", border: "1px solid var(--border-hairline)" }}
              >
                Review
              </button>
            </li>
          ))}
        </ul>
      )}
      {children}
      <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />
    </div>
  );
}
