"use client";

/**
 * components/space/widgets/debt-perspective-adapters.tsx
 *
 * Debt Perspective widgets (UX-PER-3). The Debt workspace answers ONE question —
 * "What do I owe?" — and is LIABILITIES ONLY. No assets, net worth, allocation,
 * investment performance, spending, or goals. It explains the shape, cost, and
 * risk of liabilities.
 *
 * Mirrors the wealth/liquidity/cash-flow adapters: pure presentational render
 * functions over the EXISTING BreakdownWidget presenter (no new chart system).
 * Reuses the existing `debtColor` scale rather than reinventing it.
 *
 * Exports:
 *   renderDebtByAccount       — ranked bars, highest-APR (else largest) first (hero)
 *   CreditUtilizationWidget   — balance / creditLimit for revolving lines
 *   renderDebtHistory         — total debt over time
 *
 * Interest cost + APR editing live in ONE component —
 * `debt/InterestCostWidget.tsx` — and credit-health inputs in
 * `debt/CreditHealthInputs.tsx`. The former `renderDebtCost` (read-only interest
 * bars), `renderDebtCompleteInfo` (a second APR / minimum-payment editor) and
 * `renderCreditScore` (a score card that linked away to edit) were retired so an
 * APR has exactly one management surface.
 */

import { useState } from "react";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { debtColor } from "@/components/space/widgets/debt-adapters";
import { creditUtilization } from "@/lib/accounts/credit-utilization";
import { amountOwed } from "@/lib/debt/balance-semantics";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { parseCreditLimitInput, saveAccountCreditLimit } from "@/lib/debt/user-terms";
import { formatAggregateMoney } from "@/components/space/widgets/display-money";
import { formatCurrency } from "@/lib/currency";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";
import { CreditCard, Plus, Loader2 } from "lucide-react";

// ─── Shared account shape ─────────────────────────────────────────────────────
export interface DebtPerspectiveAccount {
  id:              string;
  name:            string;
  type:            string;
  institution:     string;
  balance:         number;
  currency:        string;
  interestRate?:   number;  // APR, e.g. 19.99 — undefined = UNKNOWN, never 0
  /** Still carried by the loader for other consumers (lens / privacy proof /
   *  legacy KPI fields). NOT surfaced anywhere in this debt experience. */
  minimumPayment?: number;
  creditLimit?:    number;
  // Presentation-only metadata already carried on the runtime Account object
  // (types/index.ts). Widened here so the editorial ledger can GROUP liabilities
  // by kind — no data-layer / authority change.
  debtSubtype?:               string;   // credit_card | line_of_credit | heloc | auto_loan | mortgage | personal_loan | student_loan
  /** Present ONLY on a privacy-aggregated row (synthetic id, several accounts
   *  behind it) — such a row has no single liability to attach a rate or limit to. */
  aggregate?: { memberAccountIds: string[]; memberCount: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inDisp(amount: number, currency: string | null | undefined, ctx?: ConversionContext): number {
  if (!ctx) return amount;
  // V25-FINAL-1 — unavailable conversion excluded from the visual breakdown (0
  // contribution, never a native magnitude); the Debt lens carries the
  // authoritative total + `unconverted` disclosure.
  return convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx).amount ?? 0;
}
function fmtMoney(v: number, ctx?: ConversionContext): string {
  // REVIEW-3 B-5 — no context ⇒ no currency claim, never a USD relabel of
  // native amounts (display-money.ts).
  return formatAggregateMoney(v, ctx);
}
function valueFormatterProps(ctx?: ConversionContext) {
  return ctx ? { formatValue: (v: number) => formatCurrency(v, ctx.target) } : {};
}
function debtAccounts(accounts: DebtPerspectiveAccount[]): DebtPerspectiveAccount[] {
  return accounts.filter((a) => a.type === "debt");
}
const NO_DEBT_HEADLINE = "No debt";
const NO_DEBT_SUBLINE  = "Nothing owed in this Space — nice.";

// ─── 1. Debt by Account (hero) ────────────────────────────────────────────────

/** Ranked bars of every liability. Sorted by APR (highest cost first) when any
 *  rate exists, else by balance; colour ranks by that order so the most
 *  expensive/largest debt is the deepest red. */
export function renderDebtByAccount(
  accounts: DebtPerspectiveAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  // V25-SIDE-1 — this is a MAGNITUDE surface (ranked bars of what is owed), not
  // the membership surface: a zero-length bar says nothing. Accounts with no
  // outstanding debt are therefore absent HERE by design — they remain fully
  // visible as rows in LiabilitiesLedger, which is where account identity lives.
  // The exclusion is decided by the canonical helper, never a local sign rule.
  const debts = debtAccounts(accounts)
    .map((a) => ({ a, bal: amountOwed(inDisp(a.balance, a.currency, ctx)) }))
    .filter((x) => x.bal > 0);

  const anyApr = debts.some((x) => x.a.interestRate != null);
  const sorted = [...debts].sort((x, y) =>
    anyApr ? (y.a.interestRate ?? -1) - (x.a.interestRate ?? -1) : y.bal - x.bal,
  );
  const n = sorted.length;

  const items: BreakdownItem[] = sorted.map(({ a, bal }, i) => ({
    id:    a.id,
    label: a.name,
    value: bal,
    color: debtColor(i, n),
    meta:  a.institution || undefined,
    meta2: a.interestRate != null ? `${a.interestRate.toFixed(2)}% APR` : undefined,
  }));

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="account"
      emptyHeadline={NO_DEBT_HEADLINE}
      emptySubline={NO_DEBT_SUBLINE}
      {...valueFormatterProps(ctx)}
    />
  );
}

// ─── 3. Credit Utilization ────────────────────────────────────────────────────

// Utilization → bar colour by LEVEL (never rank; low is never red).
const UTIL_COLOR: Record<string, string> = {
  low:      "var(--accent-positive)",
  moderate: "#f59e0b",
  high:     "#f97316",
  over:     "var(--accent-negative)",
};

/** balance / creditLimit for revolving lines, highest first. Bar width is the
 *  clamped utilization (0–100%), the % text is the TRUE value (may exceed 100%),
 *  and colour is by level. Debts missing a limit get an inline "add limit"
 *  affordance (PATCH /api/accounts/[id]). No limits at all ⇒ honest empty state. */
export function CreditUtilizationWidget({
  accounts,
  ctx,
}: {
  accounts: DebtPerspectiveAccount[];
  ctx?:     ConversionContext;
}): React.ReactElement {
  const { rows, missingLimit } = creditUtilization(accounts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function saveLimit(id: string) {
    // Same parse + write path as Credit health's limit editor (lib/debt/user-terms.ts).
    const parsed = parseCreditLimitInput(draft);
    if (!parsed.ok) return;
    setSavingId(id);
    const res = await saveAccountCreditLimit(id, parsed.value);
    setSavingId(null);
    if (!res.ok) return;
    window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
    setEditingId(null); setDraft("");
  }

  if (rows.length === 0 && missingLimit.length === 0) {
    return (
      <div className="text-center py-8">
        <CreditCard size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No revolving credit</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">Utilization appears for debts that carry a credit limit.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.id} className="space-y-1">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--text-secondary)] truncate">{r.name}</span>
            <span className="font-semibold" style={{ color: UTIL_COLOR[r.level] }}>{r.pct.toFixed(0)}%</span>
          </div>
          <div className="h-2 rounded-full bg-[var(--surface-inset)] overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${r.barPct}%`, backgroundColor: UTIL_COLOR[r.level] }} />
          </div>
          <p className="text-[10px] text-[var(--text-faint)]">
            {fmtMoney(r.balance, ctx)} of {fmtMoney(r.limit, ctx)}
            {r.level === "over" ? " · over limit" : ""}
          </p>
        </div>
      ))}

      {missingLimit.length > 0 && (
        <div className="pt-1 space-y-1.5 border-t border-[var(--border-hairline)]">
          <p className="text-[10px] text-[var(--text-faint)] uppercase tracking-widest">Missing credit limit</p>
          {missingLimit.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-[var(--text-muted)] truncate">{m.name}</span>
              {editingId === m.id ? (
                <div className="flex items-center gap-1 shrink-0">
                  <input
                    autoFocus
                    inputMode="decimal"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveLimit(m.id); if (e.key === "Escape") setEditingId(null); }}
                    placeholder="Limit"
                    className="w-24 bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-lg px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-info)]"
                  />
                  <button onClick={() => saveLimit(m.id)} disabled={savingId === m.id} className="p-1 rounded text-[var(--accent-info)] disabled:opacity-50">
                    {savingId === m.id ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  </button>
                </div>
              ) : (
                <button onClick={() => { setEditingId(m.id); setDraft(""); }} className="flex items-center gap-1 text-[11px] font-medium text-[var(--accent-info)] shrink-0">
                  <Plus size={12} /> Add limit
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 4. Debt History (total debt over time, from snapshots) ───────────────────

/** Total debt over time from SpaceSnapshot history (the `debt` series). Honest
 *  balance history — NOT reconstructed from transactions. Data-thin until enough
 *  snapshots exist. */
export function renderDebtHistory(
  snapshots: Snapshot[] | null | undefined,
  ctx?:      ConversionContext,
): React.ReactElement {
  if (snapshots == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading history…</p>;
  }
  const series = [...snapshots]
    .filter((s) => typeof s.totalDebt === "number")
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const points = series.slice(-24);

  if (points.length < 2 || points.every((p) => p.totalDebt === 0)) {
    return (
      <div className="text-center py-8">
        <CreditCard size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">Not enough history yet</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">Total debt over time appears as daily snapshots accumulate.</p>
      </div>
    );
  }

  const max = Math.max(1, ...points.map((p) => p.totalDebt));
  const current = points[points.length - 1].totalDebt;
  const first = points[0].totalDebt;
  const delta = current - first;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-2xl font-semibold text-[var(--accent-negative)]">{fmtMoney(current, ctx)}</p>
          <p className="text-[11px] text-[var(--text-muted)]">total debt now</p>
        </div>
        <p className={`text-xs font-medium ${delta <= 0 ? "text-[var(--accent-positive)]" : "text-[var(--accent-negative)]"}`}>
          {delta <= 0 ? "−" : "+"}{fmtMoney(Math.abs(delta), ctx)} over {points.length} snapshots
        </p>
      </div>
      <div className="flex items-end gap-0.5 h-16">
        {points.map((p, i) => (
          <div
            key={`${p.date}-${i}`}
            className="flex-1 rounded-t-sm"
            style={{ height: `${Math.max(2, (p.totalDebt / max) * 100)}%`, backgroundColor: "var(--accent-negative)", opacity: 0.35 + 0.65 * (p.totalDebt / max) }}
            title={`${p.date}: ${fmtMoney(p.totalDebt, ctx)}`}
          />
        ))}
      </div>
    </div>
  );
}
