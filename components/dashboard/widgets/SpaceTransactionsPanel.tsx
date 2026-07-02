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
import { Card } from "@/components/ui/Card";
import { Search, X } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency:              DEFAULT_DISPLAY_CURRENCY,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));

// ── Category colors (matches BankingClient) ─────────────────────────────────
const CAT_COLORS: Record<TransactionCategory, string> = {
  Income:        "bg-emerald-500/15 text-emerald-400",
  Transfer:      "bg-blue-500/15 text-blue-400",
  Groceries:     "bg-lime-500/15 text-lime-400",
  Dining:        "bg-orange-500/15 text-orange-400",
  Shopping:      "bg-purple-500/15 text-purple-400",
  Travel:        "bg-sky-500/15 text-sky-400",
  Subscriptions: "bg-violet-500/15 text-violet-400",
  Utilities:     "bg-slate-500/15 text-slate-400",
  Interest:      "bg-teal-500/15 text-teal-400",
  Payment:       "bg-gray-500/15 text-gray-400",
  Other:         "bg-gray-600/15 text-gray-500",
  // Investment categories — won't appear here (getTransactions excludes them),
  // but required for type completeness.
  Buy:           "bg-emerald-500/15 text-emerald-400",
  Sell:          "bg-red-500/15 text-red-400",
  Dividend:      "bg-blue-500/15 text-blue-400",
  Split:         "bg-purple-500/15 text-purple-400",
  Fee:           "bg-gray-500/15 text-gray-400",
};

const BANKING_CATEGORIES: TransactionCategory[] = [
  "Income", "Transfer", "Groceries", "Dining", "Shopping",
  "Travel", "Subscriptions", "Utilities", "Interest", "Payment", "Other",
];

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

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  transactions: Transaction[];
  accounts:     Account[];
  /** Honesty label for shared Spaces, where KD-15 makes the list
   *  structurally partial (FULL-visibility shares only) — e.g. "Showing
   *  transactions from fully shared accounts only". Omit on Personal. */
  scopeNote?:   string;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function SpaceTransactionsPanel({ transactions, accounts, scopeNote }: Props) {
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
  const totalSpend = filtered
    .filter((t) => t.amount < 0 && t.category !== "Payment" && t.category !== "Transfer")
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const totalIn = filtered
    .filter((t) => t.amount > 0)
    .reduce((s, t) => s + t.amount, 0);

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
        <p className="text-[11px] text-gray-500 px-1">{scopeNote}</p>
      )}
      <div className="flex items-center justify-between flex-wrap gap-2 px-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Transactions
          </p>
          {/* Active filter chips */}
          {selectedAccount && (
            <span className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
              {selectedAccount.institution} · {selectedAccount.name}
              <button onClick={() => setAccountFilter(null)} className="hover:text-white ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {catFilter && (
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_COLORS[catFilter]}`}>
              {catFilter}
              <button onClick={() => setCatFilter(null)} className="hover:text-white ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {pendingFilter !== "all" && (
            <span className="text-xs bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
              {PENDING_LABELS[pendingFilter]}
              <button onClick={() => setPendingFilter("all")} className="hover:text-white ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {hasActiveFilters && (
            <button
              onClick={clearAll}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Date-range pill strip */}
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-700 rounded-xl p-1 shrink-0">
          {(["all", "90d", "30d", "7d"] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              className={`text-xs font-semibold px-2.5 py-2 rounded-lg transition-colors touch-manipulation ${
                dateRange === r
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
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
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search transactions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-8 pr-8 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Category */}
        <select
          value={catFilter ?? ""}
          onChange={(e) => setCatFilter((e.target.value as TransactionCategory) || null)}
          className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
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
          className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
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
          className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
        >
          {(["all", "cleared", "pending"] as PendingFilter[]).map((p) => (
            <option key={p} value={p}>{PENDING_LABELS[p]}</option>
          ))}
        </select>
      </div>

      {/* ── Summary strip ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 text-sm flex-wrap px-1">
        <span className="text-gray-400">
          <span className="font-semibold text-white">{filtered.length}</span>{" "}
          {filtered.length === 1 ? "transaction" : "transactions"}
        </span>
        {totalSpend > 0 && (
          <span className="text-gray-400">
            Spend:{" "}
            <span className="font-semibold text-red-400">-{fmt(totalSpend)}</span>
          </span>
        )}
        {totalIn > 0 && (
          <span className="text-gray-400">
            In:{" "}
            <span className="font-semibold text-emerald-400">+{fmt(totalIn)}</span>
          </span>
        )}
      </div>

      {/* ── Transaction list ─────────────────────────────────────────────────── */}
      {transactions.length === 0 ? (
        <div className="rounded-2xl border border-gray-800 bg-gray-900/60 py-14 text-center">
          <p className="text-sm text-gray-500">No transactions found for this Space.</p>
          <p className="text-xs text-gray-600 mt-1">
            Connect a bank account to start seeing transactions here.
          </p>
        </div>
      ) : (
        <Card className="!p-0 overflow-hidden">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-10">
              No transactions match your filters.
            </p>
          ) : (
            <div className="divide-y divide-gray-800">
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
        </Card>
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
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800/40 transition-colors">
      {/* Date column */}
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold text-gray-300 leading-none">
          {dateObj.toLocaleDateString("en-US", { day: "numeric" })}
        </p>
        <p className="text-xs text-gray-600 mt-0.5">
          {dateObj.toLocaleDateString("en-US", { month: "short" })}
        </p>
      </div>

      {/* Merchant + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-white truncate">{tx.merchant}</p>
          {tx.pending && (
            <span className="text-xs bg-yellow-500/15 text-yellow-400 px-1.5 py-0.5 rounded-full shrink-0">
              Pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${CAT_COLORS[tx.category]}`}>
            {tx.category}
          </span>
          <span className="text-xs text-gray-600 truncate">
            {acctInst}{acctInst && acctName ? " · " : ""}{acctName}
          </span>
        </div>
      </div>

      {/* Amount */}
      <div className="shrink-0 text-right">
        <p className={`text-sm font-bold tabular-nums ${isCredit ? "text-emerald-400" : "text-white"}`}>
          {isCredit ? "+" : "−"}{fmt(tx.amount)}
        </p>
      </div>
    </div>
  );
}
