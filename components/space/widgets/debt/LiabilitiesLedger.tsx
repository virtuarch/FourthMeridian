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
 * colour). The ledger shows the MOST IMPORTANT liabilities up front; "View all N →"
 * opens the full grouped list in a LeftPanel ("what am I operating in"). A row — in
 * either place — opens its detail in a RightPanel ("tell me more about what I selected"),
 * stacked above the LeftPanel via the shared PanelStack.
 *
 * DUAL-AUTHORITY (plan §1.4): every figure of record is display-converted here from the
 * accounts array (the SAME source as the KPIs / payoff), never the lens. Debt is
 * present-day — these are current balances (the block header says so when historical).
 *
 * ── V25-SIDE-1: this is the PERSISTENT ACCOUNT BROWSER ───────────────────────
 * Two different questions live in the Debt Perspective, and this Surface owns the
 * second one:
 *   • the KPIs / charts / payoff planner answer "HOW MUCH DO I OWE?" — they are
 *     magnitude surfaces and are correct to go quiet at zero;
 *   • this ledger answers "WHAT LIABILITY ACCOUNTS DO I HAVE, AND IN WHAT
 *     STATE?" — a structural question whose answer does not depend on any
 *     amount.
 * So membership here is `type === "debt"` and nothing else, and the workspace
 * renders this Block outside its `hasDebt` gate. Paying every card off must not
 * erase the cards. Each row states its own semantics via the canonical authority
 * (lib/debt/balance-semantics.ts): "$X owed", "$0 owed · Paid off", or
 * "$X credit" in a favourable tone — never a raw negative balance.
 */

import { useMemo, useState } from "react";
import { convertMoney } from "@/lib/money/convert";
import { amountOwed, creditBalance, liabilityState } from "@/lib/debt/balance-semantics";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
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

  // V25-SIDE-1 — MEMBERSHIP is structural (`type === "debt"`) and nothing more.
  // The former `.filter((r) => r.value > 0)` here made a paid-off card VANISH
  // from the ledger: it decided the account did not exist because nothing was
  // currently owed. Balance now decides only how a row PRESENTS (its
  // LiabilityState), never whether it is present.
  const prepared = accounts
    .filter((a) => a.type === "debt")
    .map((a) => {
      const bal = conv(a.balance, a.currency);
      const owed = amountOwed(bal.amount);
      const credit = creditBalance(bal.amount);
      const limit = a.creditLimit != null ? conv(a.creditLimit, a.currency) : null;
      const min = a.minimumPayment != null ? conv(a.minimumPayment, a.currency) : null;
      // No principal ⇒ no interest. A credit balance accrues nothing.
      const estInterest =
        a.interestRate != null && a.interestRate > 0 && owed > 0
          ? owed * (a.interestRate / 100) / 12
          : null;
      const estimated = bal.estimated || (limit?.estimated ?? false) || (min?.estimated ?? false);
      return {
        account: a,
        cls: classifyDebt(a),
        state: liabilityState(bal.amount),
        value: owed,
        credit,
        limit: limit?.amount ?? null,
        // Nothing is due on a settled or credit-balance account.
        minPayment: owed > 0 ? min?.amount ?? null : null,
        estInterest,
        utilizationPct: accountUtilization(a),
        estimated,
        share: 0, // filled after the total is known
      } as LiabilityRow;
    });

  const total = prepared.reduce((s, r) => s + r.value, 0);
  for (const r of prepared) r.share = total > 0 ? Math.max(0, Math.min(1, r.value / total)) : 0;

  // Most important first (largest amount owed), stable across groups. Rows with
  // nothing owed sort last among themselves by credit size — they remain
  // visible, they are simply not what the workspace is about.
  return prepared.sort((x, y) => (y.value - x.value) || (y.credit - x.credit));
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
        {/* V25-SIDE-1 — reachable ONLY when the Space has no debt-type account at
            all. "Nothing owed" is no longer a reason for absence: a paid-off or
            credit-balance card is a liability account and still renders a row. */}
        <p className="text-center text-sm text-[var(--text-muted)]">No liability accounts in this Space.</p>
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
            View all {rows.length} liability accounts
            <span aria-hidden>→</span>
          </button>
        )}
      </Surface>

      {/* Full list — the context surface ("what am I operating in"). */}
      <LeftPanel open={allOpen} onClose={() => setAllOpen(false)} ariaLabel="All liabilities">
        <PanelHeader eyebrow="Liabilities" title={`All ${rows.length} liability accounts`} />
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
        {/* V25-SIDE-1 — the meta line names WHAT this account is (subtype), so a
            settled or credit row still identifies itself when it carries no
            amount to describe it. APR is shown only where it bites: a rate on an
            account owing nothing costs the user nothing this month. */}
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          <span>{debtSubtypeLabel(a)}</span>
          {a.institution && <span className="text-[var(--text-faint)]"> · {a.institution}</span>}
          {a.interestRate != null && row.state === "owed" && (
            <span className="text-[var(--text-faint)]"> · {a.interestRate.toFixed(2)}% APR</span>
          )}
        </p>
      </div>

      <div className="relative shrink-0 text-right">
        {/* V25-SIDE-1 — the amount states its MEANING, never the provider's raw
            sign. A credit is money in the user's favour, so it is positive-toned
            and never rendered as "−$124.04" in the negative/problem colour. */}
        {row.state === "credit" ? (
          // EXACT, not the ledger's usual whole-dollar rounding: an issuer credit
          // is characteristically a small amount, where rounding destroys the
          // figure ($25.77 would read "$26"). Debt balances are large enough that
          // the house rounding costs nothing, so they keep it.
          <p className="tabular-nums text-sm text-[var(--accent-positive)]">
            {approx}{formatCurrencyExact(row.credit, currency)} credit
          </p>
        ) : row.state === "settled" ? (
          // Paid off — stated in the ledger's own money column so the row still
          // reads as an account with a balance, in a NEUTRAL tone (nothing owed
          // is neither a problem nor a gain).
          <p className="tabular-nums text-sm text-[var(--text-secondary)]">
            {formatCurrency(0, currency)} owed
          </p>
        ) : (
          <p className="tabular-nums text-sm text-[var(--accent-negative)]">
            {approx}{formatCurrency(row.value, currency)} owed
          </p>
        )}
        {row.state === "owed" && util != null ? (
          <p className="mt-0.5 tabular-nums text-[11px]" style={{ color: UTIL_COLOR[utilLevel(util)] }}>{util.toFixed(0)}% used</p>
        ) : row.state === "owed" ? (
          <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">{(row.share * 100).toFixed(0)}%</p>
        ) : (
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            {row.state === "settled" ? "Paid off" : "Nothing owed"}
          </p>
        )}
      </div>
    </button>
  );
}

// Local import kept at the bottom to avoid a circular-looking header block; the detail
// body is a sibling presentational component.
import { DebtAccountDetail as DetailBody } from "./DebtAccountDetail";
