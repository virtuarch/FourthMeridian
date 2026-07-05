"use client";

/**
 * SpaceTransactionsPanel
 *
 * Renders the full transaction list for a Space — search, category, account,
 * date-range, and pending/cleared filters — using the transactions and accounts
 * data already fetched by the parent DashboardClient (no extra server round-trip).
 *
 * Data path: getTransactions() → DashboardClient props → this component.
 * Account lookup (name + institution) mirrors BankingClient: match tx.accountId
 * to Account.id, which is FinancialAccount.id for Plaid-synced rows (normalized
 * by getAccounts() and getTransactions()).
 */

import { useState, useMemo, useCallback } from "react";
import { Account, Transaction, TransactionCategory } from "@/types";
import { DataCard } from "@/components/atlas/DataCard";
import { Search, X } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency:              DEFAULT_DISPLAY_CURRENCY,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));

// ── Category badge ──────────────────────────────────────────────────────────
// Step C: category colour-coding neutralised to a single ink chip (matches the
// other transaction surfaces); the label carries the meaning.
const CAT_CHIP = "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

const BANKING_CATEGORIES: TransactionCategory[] = [
  "Income", "Transfer", "Groceries", "Dining", "Shopping",
  "Travel", "Subscriptions", "Utilities", "Interest", "Payment", "Other",
];

// FlowType P5 Slice 2 — money-out cost flows that count toward the "Spend" chip.
const FLOW_COST = new Set(["SPENDING", "FEE", "INTEREST"]);

// ── Date-range filter ─────────────────────────────────────────────────────────
type DateRange = "all" | "90d" | "30d" | "7d";

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  all:  "All Time",
  "90d": "90 Days",
  "30d": "30 Days",
  "7d":  "7 Days",
};

function cutoffForRange(r: DateRange): string | null {
  if (r === "all") return null;
  const d = new Date();
  d.setDate(d.getDate() - (r === "90d" ? 90 : r === "30d" ? 30 : 7));
  return d.toISOString().split("T")[0];
}

// ── Pending filter ────────────────────────────────────────────────────────────
type PendingFilter = "all" | "cleared" | "pending";

const PENDING_LABELS: Record<PendingFilter, string> = {
  all:     "All",
  cleared: "Cleared",
  pending: "Pending",
};

// ── Shared input styling (Atlas tokens) ──────────────────────────────────────
const INPUT_BASE = "border rounded-xl text-sm placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-info)] transition-colors";
const inputStyle: React.CSSProperties = { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" };

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  transactions: Transaction[];
  accounts:     Account[];
  /** Honesty label for shared Spaces, where KD-15 makes the list
   *  structurally partial (FULL-visibility shares only) — e.g. "Showing
   *  transactions from fully shared accounts only". Omit on Personal. */
  scopeNote?:   string;
  /**
   * MC1 Phase 3 Slice 6 (F-1, D-6) — serialized Space conversion context.
   * Optional: absent => context-less native sums (the kill switch; the
   * SpaceDashboard client-fetched instance stays context-less for now —
   * recorded as a Phase 3 closeout finding). Provided by DashboardClient.
   */
  moneyCtx?:    SerializedConversionContext;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function SpaceTransactionsPanel({ transactions, accounts, scopeNote, moneyCtx }: Props) {
  // MC1 P3 Slice 6 — rehydrated once; per-row conversion at each row's own
  // date (identical math for all-USD Spaces / absent context).
  const conversionCtx = useMemo(
    () => (moneyCtx ? rehydrateContext(moneyCtx) : undefined),
    [moneyCtx],
  );
  const rowAmount = useCallback(
    (t: Transaction): number =>
      conversionCtx
        ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, conversionCtx).amount
        : t.amount,
    [conversionCtx],
  );
  const [search,        setSearch]        = useState("");
  const [catFilter,     setCatFilter]     = useState<TransactionCategory | null>(null);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [dateRange,     setDateRange]     = useState<DateRange>("all");
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");

  // ── Account lookup helpers ───────────────────────────────────────────────
  const accountMap = useMemo(() => {
    const m = new Map<string, Account>();
    accounts.forEach((a) => m.set(a.id, a));
    return m;
  }, [accounts]);

  const acctName = useCallback(
    (id: string) => accountMap.get(id)?.name ?? "Unknown Account",
    [accountMap],
  );
  const acctInst = useCallback(
    (id: string) => accountMap.get(id)?.institution ?? "",
    [accountMap],
  );

  // ── Institution groups for account filter dropdown ───────────────────────
  // Only includes institutions that have at least one transaction.
  const txAccountIds = useMemo(
    () => new Set(transactions.map((t) => t.accountId)),
    [transactions],
  );

  const institutionGroups = useMemo(() => {
    const groups = new Map<string, Account[]>();
    accounts
      .filter((a) => txAccountIds.has(a.id))
      .forEach((a) => {
        const inst = a.institution;
        if (!groups.has(inst)) groups.set(inst, []);
        groups.get(inst)!.push(a);
      });
    return groups;
  }, [accounts, txAccountIds]);

  // ── Filtering ────────────────────────────────────────────────────────────
  const cutoff = cutoffForRange(dateRange);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return transactions.filter((tx) => {
      if (catFilter     && tx.category   !== catFilter)     return false;
      if (accountFilter && tx.accountId  !== accountFilter) return false;
      if (cutoff        && tx.date        < cutoff)         return false;
      if (pendingFilter === "cleared" &&  tx.pending)       return false;
      if (pendingFilter === "pending" && !tx.pending)       return false;
      if (q && !tx.merchant.toLowerCase().includes(q) && !(tx.description ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [transactions, catFilter, accountFilter, cutoff, pendingFilter, search]);

  // ── Summary totals ────────────────────────────────────────────────────────
  // FlowType P5 Slice 2 — from flowType (no category/sign). Spend = SPENDING +
  // FEE + INTEREST outflows minus REFUND (clamped ≥ 0); In = INCOME only.
  // Transfers/debt payments/investments/adjustments/unknowns excluded from both.
  const grossSpend = filtered
    .filter((t) => t.flowType != null && FLOW_COST.has(t.flowType))
    .reduce((s, t) => s + Math.abs(rowAmount(t)), 0);
  const spendRefunds = filtered
    .filter((t) => t.flowType === "REFUND")
    .reduce((s, t) => s + Math.abs(rowAmount(t)), 0);
  const totalSpend = Math.max(0, grossSpend - spendRefunds);
  const totalIn = filtered
    .filter((t) => t.flowType === "INCOME")
    .reduce((s, t) => s + Math.abs(rowAmount(t)), 0);

  // ── Active filter chip helpers ─────────────────────────────────────────
  const selectedAccount = accountFilter ? accountMap.get(accountFilter) : null;

  const clearAll = useCallback(() => {
    setSearch("");
    setCatFilter(null);
    setAccountFilter(null);
    setDateRange("all");
    setPendingFilter("all");
  }, []);

  const hasActiveFilters =
    search || catFilter || accountFilter || dateRange !== "all" || pendingFilter !== "all";

  return (
    <div className="space-y-4">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      {scopeNote && (
        <p className="text-[11px] px-1" style={{ color: "var(--text-muted)" }}>{scopeNote}</p>
      )}
      <div className="flex items-center justify-between flex-wrap gap-2 px-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
            Transactions
          </p>
          {/* Active filter chips */}
          {selectedAccount && (
            <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--accent-info)", borderColor: "var(--border-hairline)" }}>
              {selectedAccount.institution} · {selectedAccount.name}
              <button onClick={() => setAccountFilter(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {catFilter && (
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
              {catFilter}
              <button onClick={() => setCatFilter(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {pendingFilter !== "all" && (
            <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}>
              {PENDING_LABELS[pendingFilter]}
              <button onClick={() => setPendingFilter("all")} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {hasActiveFilters && (
            <button
              onClick={clearAll}
              className="text-xs hover:text-[var(--text-secondary)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              Clear all
            </button>
          )}
        </div>

        {/* Date-range pill strip */}
        <div className="flex items-center gap-1 border rounded-xl p-1 shrink-0" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
          {(["all", "90d", "30d", "7d"] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              className="text-xs font-semibold px-2.5 py-2 rounded-lg transition-colors touch-manipulation"
              style={dateRange === r
                ? { background: "var(--accent-info)", color: "#fff" }
                : { color: "var(--text-secondary)" }}
            >
              {DATE_RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {/* ── Search + filters row ────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px]">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }}
          />
          <input
            type="text"
            placeholder="Search transactions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`w-full pl-8 pr-8 py-2.5 ${INPUT_BASE}`}
            style={inputStyle}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-primary)]"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Category */}
        <select
          value={catFilter ?? ""}
          onChange={(e) => setCatFilter((e.target.value as TransactionCategory) || null)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          <option value="">All categories</option>
          {BANKING_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* Account / institution */}
        <select
          value={accountFilter ?? ""}
          onChange={(e) => setAccountFilter(e.target.value || null)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          <option value="">All accounts</option>
          {[...institutionGroups.entries()].map(([inst, accts]) => (
            <optgroup key={inst} label={inst}>
              {accts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Pending / cleared */}
        <select
          value={pendingFilter}
          onChange={(e) => setPendingFilter(e.target.value as PendingFilter)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          {(["all", "cleared", "pending"] as PendingFilter[]).map((p) => (
            <option key={p} value={p}>{PENDING_LABELS[p]}</option>
          ))}
        </select>
      </div>

      {/* ── Summary strip ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 text-sm flex-wrap px-1">
        <span style={{ color: "var(--text-secondary)" }}>
          <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{filtered.length}</span>{" "}
          {filtered.length === 1 ? "transaction" : "transactions"}
        </span>
        {totalSpend > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            Spend:{" "}
            <span className="font-semibold" style={{ color: "var(--accent-negative)" }}>-{fmt(totalSpend)}</span>
          </span>
        )}
        {totalIn > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            In:{" "}
            <span className="font-semibold" style={{ color: "var(--accent-positive)" }}>+{fmt(totalIn)}</span>
          </span>
        )}
      </div>

      {/* ── Transaction list ─────────────────────────────────────────────────── */}
      {transactions.length === 0 ? (
        <div className="rounded-2xl border py-14 text-center" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No transactions found for this Space.</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>
            Connect a bank account to start seeing transactions here.
          </p>
        </div>
      ) : (
        <DataCard padding="0" className="overflow-hidden">
          {filtered.length === 0 ? (
            <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>
              No transactions match your filters.
            </p>
          ) : (
            <div className="divide-y divide-[var(--border-hairline)]">
              {filtered.map((tx) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  acctName={acctName(tx.accountId)}
                  acctInst={acctInst(tx.accountId)}
                />
              ))}
            </div>
          )}
        </DataCard>
      )}
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
function TxRow({
  tx,
  acctName,
  acctInst,
}: {
  tx:       Transaction;
  acctName: string;
  acctInst: string;
}) {
  const isCredit = tx.amount > 0;
  const dateObj  = new Date(tx.date + "T12:00:00");

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors">
      {/* Date column */}
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold leading-none" style={{ color: "var(--text-secondary)" }}>
          {dateObj.toLocaleDateString("en-US", { day: "numeric" })}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-faint)" }}>
          {dateObj.toLocaleDateString("en-US", { month: "short" })}
        </p>
      </div>

      {/* Merchant + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{tx.merchant}</p>
          {tx.pending && (
            <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}>
              Pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${CAT_CHIP}`}>
            {tx.category}
          </span>
          <span className="text-xs truncate" style={{ color: "var(--text-faint)" }}>
            {acctInst}{acctInst && acctName ? " · " : ""}{acctName}
          </span>
        </div>
      </div>

      {/* Amount */}
      <div className="shrink-0 text-right">
        <p className="text-sm font-bold tabular-nums" style={{ color: isCredit ? "var(--accent-positive)" : "var(--text-primary)" }}>
          {isCredit ? "+" : "−"}{fmt(tx.amount)}
        </p>
      </div>
    </div>
  );
}
