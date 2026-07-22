"use client";

/**
 * components/space/widgets/debt/LiabilitiesLedger.tsx
 *
 * Surface ③ of the Debt Workspace — the LIABILITIES ledger, the debt analogue of the
 * Investments HoldingsLedger. NOT a card grid and NOT a ranked-bar chart: an opaque
 * read-Surface of divided rows GROUPED by liability class (Credit cards / Loans / Other),
 * each carrying an inline weight bar whose LENGTH is its share of total debt.
 *
 * The bar IS the concentration view, folded into the ledger where it's already relevant
 * ("a few cards carry most of this" is visible at a glance — no second chart). It is a
 * NEUTRAL rule (share of debt is neither good nor bad nor a category, so it carries no
 * colour). The ledger shows the MOST IMPORTANT liabilities up front; "View all N debts →"
 * opens the full grouped list in a LeftPanel ("what am I operating in"). A row — in
 * either place — opens its detail in a RightPanel ("tell me more about what I selected"),
 * stacked above the LeftPanel via the shared PanelStack.
 *
 * DUAL-AUTHORITY (plan §1.4): every figure of record is display-converted here from the
 * accounts array (the SAME source as the KPIs / payoff), never the lens. Debt is
 * present-day — these are current balances (the block header says so when historical).
 */

import { useMemo, useState } from "react";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import { Surface } from "@/components/atlas/Surface";
import {
  WorkspaceLayout, LeftPanel, RightPanel, PanelHeader, PanelContent,
} from "@/components/atlas/panels";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import {
  classifyDebt, accountUtilization, debtSubtypeLabel,
  DEBT_CLASS_LABEL, DEBT_CLASS_ORDER,
  type DebtClass, type LiabilityRow,
} from "./debt-ledger-util";

/** How many liabilities to show inline before folding the rest behind "View all". */
const MAX_INLINE = 5;

const UTIL_COLOR: Record<string, string> = {
  low:      "var(--accent-positive)",
  moderate: "#f59e0b",
  high:     "#f97316",
  over:     "var(--accent-negative)",
};
function utilLevel(pct: number): keyof typeof UTIL_COLOR {
  if (pct > 100) return "over";
  if (pct >= 70) return "high";
  if (pct >= 30) return "moderate";
  return "low";
}

/** One display-currency FX pass over the debt rows (mirrors debt-kpis' inDisp). */
function buildRows(accounts: DebtPerspectiveAccount[], ctx?: ConversionContext): LiabilityRow[] {
  const asOf = yesterdayUTCISO();
  const conv = (amount: number, currency: string | null | undefined) => {
    if (!ctx) return { amount, estimated: false };
    const c = convertMoney({ amount, currency: currency ?? null }, asOf, ctx);
    // V25-FINAL-1 — unavailable conversion excluded (0) from the ledger's share math,
    // never a native magnitude; `estimated` (true on a miss) discloses the partial.
    return { amount: c.amount ?? 0, estimated: c.estimated };
  };

  const prepared = accounts
    .filter((a) => a.type === "debt")
    .map((a) => {
      const bal = conv(a.balance, a.currency);
      const limit = a.creditLimit != null ? conv(a.creditLimit, a.currency) : null;
      const min = a.minimumPayment != null ? conv(a.minimumPayment, a.currency) : null;
      const estInterest =
        a.interestRate != null && a.interestRate > 0 && bal.amount > 0
          ? bal.amount * (a.interestRate / 100) / 12
          : null;
      const estimated = bal.estimated || (limit?.estimated ?? false) || (min?.estimated ?? false);
      return {
        account: a,
        cls: classifyDebt(a),
        value: bal.amount,
        limit: limit?.amount ?? null,
        minPayment: min?.amount ?? null,
        estInterest,
        utilizationPct: accountUtilization(a),
        estimated,
        share: 0, // filled after the total is known
      } as LiabilityRow;
    })
    .filter((r) => r.value > 0);

  const total = prepared.reduce((s, r) => s + r.value, 0);
  for (const r of prepared) r.share = total > 0 ? Math.max(0, Math.min(1, r.value / total)) : 0;

  // Most important first (largest balance), stable across groups.
  return prepared.sort((x, y) => y.value - x.value);
}

export function LiabilitiesLedger({
  accounts,
  ctx,
  currency,
}: {
  accounts: DebtPerspectiveAccount[];
  ctx?:     ConversionContext;
  currency: string;
}) {
  const rows = useMemo(() => buildRows(accounts, ctx), [accounts, ctx]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const selected = selectedId ? rows.find((r) => r.account.id === selectedId) ?? null : null;

  if (rows.length === 0) {
    return (
      <Surface className="px-4 py-8">
        <p className="text-center text-sm text-[var(--text-muted)]">No liabilities to show — nothing owed in this Space.</p>
      </Surface>
    );
  }

  const inline = rows.slice(0, MAX_INLINE);
  const hidden = rows.length - inline.length;

  return (
    <WorkspaceLayout>
      <Surface className="overflow-hidden">
        <GroupedRows rows={inline} currency={currency} onOpen={setSelectedId} />
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setAllOpen(true)}
            className="flex w-full items-center justify-between border-t border-[var(--border-hairline)] px-4 py-3 text-left text-[13px] font-medium text-[var(--meridian-400)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            View all {rows.length} debts
            <span aria-hidden>→</span>
          </button>
        )}
      </Surface>

      {/* Full list — the context surface ("what am I operating in"). */}
      <LeftPanel open={allOpen} onClose={() => setAllOpen(false)} ariaLabel="All liabilities">
        <PanelHeader eyebrow="Liabilities" title={`All ${rows.length} debts`} />
        <PanelContent>
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-hairline)]">
            <GroupedRows rows={rows} currency={currency} onOpen={setSelectedId} />
          </div>
        </PanelContent>
      </LeftPanel>

      {/* Per-liability detail — the drill surface, stacked above the list. */}
      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel="Liability detail">
        {selected && (
          <>
            <PanelHeader eyebrow={debtSubtypeLabel(selected.account)} title={selected.account.name} />
            <PanelContent>
              <DetailBody row={selected} currency={currency} />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </WorkspaceLayout>
  );
}

/** Rows split under their class headings, in the canonical class order. */
function GroupedRows({ rows, currency, onOpen }: { rows: LiabilityRow[]; currency: string; onOpen: (id: string) => void }) {
  const groups = DEBT_CLASS_ORDER
    .map((cls) => ({ cls, rows: rows.filter((r) => r.cls === cls) }))
    .filter((g) => g.rows.length > 0);

  return (
    <>
      {groups.map((g, gi) => (
        <div key={g.cls} className={gi > 0 ? "border-t border-[var(--border-hairline)]" : ""}>
          <GroupHeading cls={g.cls} count={g.rows.length} />
          <div className="divide-y divide-[var(--border-hairline)]">
            {g.rows.map((r) => (
              <LedgerRow key={r.account.id} row={r} currency={currency} onOpen={() => onOpen(r.account.id)} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function GroupHeading({ cls, count }: { cls: DebtClass; count: number }) {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{DEBT_CLASS_LABEL[cls]}</span>
      <span className="text-[10px] tabular-nums text-[var(--text-faint)]">{count}</span>
    </div>
  );
}

function LedgerRow({ row, currency, onOpen }: { row: LiabilityRow; currency: string; onOpen: () => void }) {
  const a = row.account;
  const approx = row.estimated ? "≈ " : "";
  const util = row.utilizationPct;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex w-full items-center gap-3 overflow-hidden px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      {/* Weight bar — a 2px NEUTRAL rule on the row baseline; length = share of debt. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 transition-[width] duration-500"
        style={{ width: `${row.share * 100}%`, background: "var(--border-hairline-strong)" }}
      />
      {/* Hover accent rail — the affordance that this row opens a detail. */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />

      <div className="relative min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">{a.name}</p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          {a.institution && <span>{a.institution}</span>}
          {a.interestRate != null && <span className="text-[var(--text-faint)]">{a.institution ? " · " : ""}{a.interestRate.toFixed(2)}% APR</span>}
        </p>
      </div>

      <div className="relative shrink-0 text-right">
        <p className="tabular-nums text-sm text-[var(--accent-negative)]">{approx}{formatCurrency(row.value, currency)}</p>
        {util != null ? (
          <p className="mt-0.5 tabular-nums text-[11px]" style={{ color: UTIL_COLOR[utilLevel(util)] }}>{util.toFixed(0)}% used</p>
        ) : (
          <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">{(row.share * 100).toFixed(0)}%</p>
        )}
      </div>
    </button>
  );
}

// Local import kept at the bottom to avoid a circular-looking header block; the detail
// body is a sibling presentational component.
import { DebtAccountDetail as DetailBody } from "./DebtAccountDetail";
