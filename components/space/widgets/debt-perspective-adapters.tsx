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
 *   renderDebtCost            — estimated monthly interest per debt (APR × balance / 12)
 *   renderCreditUtilization   — balance / creditLimit for revolving lines
 */

import { useState } from "react";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { debtColor } from "@/components/space/widgets/debt-adapters";
import { KnowledgeAcquisitionCard, type GapEntry } from "@/components/dashboard/KnowledgeAcquisitionCard";
import { FicoCard } from "@/components/dashboard/FicoCard";
import { creditUtilization } from "@/lib/accounts/credit-utilization";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
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
  interestRate?:   number;  // APR, e.g. 19.99
  minimumPayment?: number;  // monthly minimum
  creditLimit?:    number;
  // Presentation-only metadata already carried on the runtime Account object
  // (types/index.ts). Widened here so the editorial ledger can GROUP liabilities
  // by kind and label an estimated minimum — no data-layer / authority change.
  debtSubtype?:               string;   // credit_card | line_of_credit | heloc | auto_loan | mortgage | personal_loan | student_loan
  minimumPaymentIsEstimated?: boolean;  // true ⇒ minimum was computed, not entered/issuer-provided
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
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
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
  const debts = debtAccounts(accounts)
    .map((a) => ({ a, bal: inDisp(a.balance, a.currency, ctx) }))
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
    meta2: [
      a.interestRate   != null ? `${a.interestRate.toFixed(2)}% APR` : null,
      a.minimumPayment != null ? `${fmtMoney(inDisp(a.minimumPayment, a.currency, ctx), ctx)}/mo min` : null,
    ].filter(Boolean).join(" · ") || undefined,
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

// ─── 2. Debt Cost / Interest Exposure ─────────────────────────────────────────

/** Estimated monthly interest per debt (balance × APR/12), most expensive first.
 *  Only accounts WITH a rate are shown; the footer discloses any missing APR.
 *  No APR anywhere ⇒ honest data-thin empty state (we never invent a rate). */
export function renderDebtCost(
  accounts: DebtPerspectiveAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const debts = debtAccounts(accounts).map((a) => ({ a, bal: inDisp(a.balance, a.currency, ctx) })).filter((x) => x.bal > 0);
  const rated = debts.filter((x) => x.a.interestRate != null && x.a.interestRate > 0);
  const missing = debts.length - rated.length;

  const items: BreakdownItem[] = rated
    .map(({ a, bal }) => ({ a, monthly: bal * ((a.interestRate as number) / 100) / 12 }))
    .filter((x) => x.monthly > 0)
    .sort((x, y) => y.monthly - x.monthly)
    .map(({ a, monthly }, i, arr) => ({
      id:    a.id,
      label: a.name,
      value: monthly,
      color: debtColor(i, arr.length),
      meta:  `${(a.interestRate as number).toFixed(2)}% APR`,
    }));

  const totalMonthly = items.reduce((s, i) => s + i.value, 0);

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="account"
      emptyHeadline="Interest cost unavailable"
      emptySubline="Add an APR to your debt accounts to estimate monthly interest."
      {...valueFormatterProps(ctx)}
      footer={items.length > 0 ? (
        <div className="text-center">
          <p className="text-[11px] text-[var(--text-muted)]">Estimated interest</p>
          <p className="text-sm font-semibold text-[var(--accent-negative)]">{fmtMoney(totalMonthly, ctx)}/mo</p>
          {missing > 0 && (
            <p className="text-[10px] text-[var(--text-faint)] mt-0.5">
              {missing} debt{missing === 1 ? "" : "s"} without an APR not shown
            </p>
          )}
        </div>
      ) : undefined}
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
    const limit = Number(draft.replace(/[^0-9.]/g, ""));
    if (!(limit > 0)) return;
    setSavingId(id);
    try {
      await fetch(`/api/accounts/${id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ creditLimit: limit }),
      });
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
      setEditingId(null); setDraft("");
    } finally {
      setSavingId(null);
    }
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

// ─── 6. Credit Score (manual credit-health signal — reuses FicoCard) ──────────

/** Manual-entry credit-health companion (NOT a computed debt fact, and never
 *  drives debt math). Reuses the existing FicoCard, including its "add score"
 *  affordance when none is on file. */
export function renderCreditScore(
  score:       number | null | undefined,
  lastUpdated: string | undefined,
): React.ReactElement {
  return <FicoCard score={score ?? null} lastUpdated={lastUpdated || "—"} />;
}

// ─── 7. Complete Missing Info (inline edit — reuses KnowledgeAcquisitionCard) ──

/** Inline editor for missing APR / minimum payment on debt accounts, reusing
 *  the existing KnowledgeAcquisitionCard (PATCH /api/accounts/[id]/debt-profile).
 *  On save it broadcasts SPACE_ACCOUNTS_CHANGED_EVENT so the workspace refreshes.
 *  Nothing missing ⇒ a quiet "all set" state (no fake fields). */
export function renderDebtCompleteInfo(
  accounts: DebtPerspectiveAccount[],
): React.ReactElement {
  const gaps: GapEntry[] = [];
  for (const a of debtAccounts(accounts)) {
    if (a.interestRate == null)   gaps.push({ accountId: a.id, accountName: a.name, field: "apr",            label: "APR" });
    if (a.minimumPayment == null) gaps.push({ accountId: a.id, accountName: a.name, field: "minimumPayment", label: "Minimum payment" });
  }

  if (gaps.length === 0) {
    return (
      <div className="text-center py-6">
        <CreditCard size={20} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">All debt details are filled in</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">APR and minimum payments are set on every debt.</p>
      </div>
    );
  }

  return (
    <KnowledgeAcquisitionCard
      gaps={gaps}
      onSaved={() => window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT))}
    />
  );
}
