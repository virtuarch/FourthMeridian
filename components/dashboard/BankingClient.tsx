"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Account, Transaction, TransactionCategory } from "@/types";
import { Card, CardTitle } from "@/components/ui/Card";
import { PortfolioHistoryChart, ChartSeries } from "@/components/charts/PortfolioHistoryChart";
import { PlaidLinkButton } from "@/components/plaid/PlaidLinkButton";
import { Search, X, Check, Building2, Landmark, CreditCard, ChevronDown, Trash2 } from "lucide-react";
import { RemoveAccountModal } from "@/components/dashboard/RemoveAccountModal";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate } from "@/lib/format";

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtAbs = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(n));
const fmtTx = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(n));
// Compact formatter for summary card headlines — keeps 6–8-figure numbers on one line
const fmtCompact = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(n));

// ── Chart config ──────────────────────────────────────────────────────────────
type BankingSlice = "cash" | "savings" | "debt" | "netLiquid";

const BANKING_SERIES: ChartSeries[] = [
  { key: "cash",      label: "Cash",       color: "#10b981" },
  { key: "savings",   label: "Savings",    color: "#3b82f6" },
  { key: "debt",      label: "Debt",       color: "#ef4444" },
  { key: "netLiquid", label: "Net Liquid", color: "#a78bfa" },
];

const SLICE_KEYS: Record<BankingSlice, string[]> = {
  cash:      ["cash"],
  savings:   ["savings"],
  debt:      ["debt"],
  netLiquid: ["netLiquid"],
};

const CHART_TITLES: Record<BankingSlice, string> = {
  cash:      "Cash History",
  savings:   "Savings History",
  debt:      "Debt History",
  netLiquid: "Net Liquid History",
};

// ── Category badge colors ─────────────────────────────────────────────────────
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
  // Investment categories (won't appear in banking, but needed for type safety)
  Buy:           "bg-emerald-500/15 text-emerald-400",
  Sell:          "bg-red-500/15 text-red-400",
  Dividend:      "bg-blue-500/15 text-blue-400",
  Split:         "bg-purple-500/15 text-purple-400",
  Fee:           "bg-gray-500/15 text-gray-400",
};

const ALL_CATEGORIES: TransactionCategory[] = [
  "Income", "Transfer", "Groceries", "Dining", "Shopping",
  "Travel", "Subscriptions", "Utilities", "Interest", "Payment", "Other",
];

type TimeFilter = "all" | "90d" | "30d" | "7d";

const TIME_LABELS: Record<TimeFilter, string> = {
  all: "All Time",
  "90d": "90 Days",
  "30d": "30 Days",
  "7d": "7 Days",
};

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

// ── Props ─────────────────────────────────────────────────────────────────────
type PortfolioHistoryPoint = {
  date: string; stocks: number; crypto: number; total: number;
  cash: number; savings: number; debt: number; netLiquid: number;
};

interface Props {
  accounts:         Account[];
  transactions:     Transaction[];
  portfolioHistory: PortfolioHistoryPoint[];
  preselectedId:    string | null;
}

// ── Main component ────────────────────────────────────────────────────────────
export function BankingClient({ accounts, transactions, portfolioHistory, preselectedId }: Props) {
  const [chartSlice, setChartSlice]               = useState<BankingSlice>("cash");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(preselectedId);
  const [showRemoveModal, setShowRemoveModal]      = useState(false);
  const [timeFilter, setTimeFilter]               = useState<TimeFilter>("all");
  const [search, setSearch]                       = useState("");
  const [catFilter, setCatFilter]                 = useState<TransactionCategory | null>(null);

  // Pre-expand the institution that contains the deep-linked account
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const preAcct = preselectedId ? accounts.find((a) => a.id === preselectedId) : null;
    return Object.fromEntries(
      [...new Set(accounts.filter((a) => ["checking","savings","debt"].includes(a.type)).map((a) => a.institution))]
        .map((inst) => [inst, preAcct?.institution === inst ? false : true])
    );
  });

  // Scroll the accounts section into view when deep-linked
  const accountsSectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!preselectedId) return;
    const t = setTimeout(() => {
      accountsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleInstitution = useCallback((inst: string) => {
    setCollapsed((prev) => ({ ...prev, [inst]: !prev[inst] }));
  }, []);

  // ── Account buckets ──────────────────────────────────────────────────────
  const checking = accounts.filter((a) => a.type === "checking");
  const savings  = accounts.filter((a) => a.type === "savings");
  const debt     = accounts.filter((a) => a.type === "debt");

  // ── Institution groups (preserves order from DB) ─────────────────────────
  const institutionGroups = useMemo(() => {
    const all = [...checking, ...savings, ...debt];
    const order: string[] = [];
    const groups: Record<string, Account[]> = {};
    all.forEach((a) => {
      if (!groups[a.institution]) { groups[a.institution] = []; order.push(a.institution); }
      groups[a.institution].push(a);
    });
    return order.map((inst) => ({ institution: inst, accounts: groups[inst] }));
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalCash  = [...checking, ...savings].reduce((s, a) => s + a.balance, 0);
  // Net debt: positive balances = you owe, negative = bank owes you (credit). Sum gives net owed.
  const totalDebt  = debt.reduce((s, a) => s + a.balance, 0);
  const netLiquid  = totalCash - totalDebt;

  // ── Transaction filtering ────────────────────────────────────────────────
  const cutoff = timeFilter === "all" ? null
    : timeFilter === "90d" ? daysAgo(90)
    : timeFilter === "30d" ? daysAgo(30)
    : daysAgo(7);

  const filteredTxs = useMemo(() => {
    return transactions
      .filter((tx) => {
        if (selectedAccountId && tx.accountId !== selectedAccountId) return false;
        if (catFilter && tx.category !== catFilter) return false;
        if (cutoff && tx.date < cutoff) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !tx.merchant.toLowerCase().includes(q) &&
            !(tx.description ?? "").toLowerCase().includes(q)
          ) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [selectedAccountId, catFilter, cutoff, search, transactions]);

  const totalSpend = filteredTxs
    .filter((t) => t.amount < 0 && t.category !== "Payment" && t.category !== "Transfer")
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const totalCredit = filteredTxs.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const acctName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const acctInst = (id: string) => accounts.find((a) => a.id === id)?.institution ?? "";

  function handleCardClick(id: string) {
    setSelectedAccountId((prev) => (prev === id ? null : id));
  }

  const selectedAccount = selectedAccountId
    ? accounts.find((a) => a.id === selectedAccountId)
    : null;

  const sliceBtn = (s: BankingSlice) => (
    <button
      key={s}
      onClick={() => setChartSlice(s)}
      className={`text-xs font-semibold px-3 py-2.5 rounded-lg transition-colors touch-manipulation ${
        chartSlice === s
          ? "bg-blue-600 text-white"
          : "text-gray-400 hover:text-white hover:bg-gray-800 border border-gray-700"
      }`}
    >
      {s === "netLiquid" ? "Net Liquid" : s.charAt(0).toUpperCase() + s.slice(1)}
    </button>
  );

  const timeBtn = (t: TimeFilter) => (
    <button
      key={t}
      onClick={() => setTimeFilter(t)}
      className={`text-xs font-semibold px-2.5 py-2.5 rounded-lg transition-colors touch-manipulation ${
        timeFilter === t
          ? "bg-blue-600 text-white"
          : "text-gray-400 hover:text-white hover:bg-gray-800"
      }`}
    >
      {TIME_LABELS[t]}
    </button>
  );

  return (
    <div className="space-y-6">
      {showRemoveModal && (
        <RemoveAccountModal
          accounts={accounts}
          onClose={() => setShowRemoveModal(false)}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Banking</h1>
        <div className="flex items-center gap-2">
          {accounts.length > 0 && (
            <button
              onClick={() => setShowRemoveModal(true)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-400 border border-gray-700 hover:border-red-500/40 bg-gray-900 hover:bg-red-500/10 px-3 py-2 rounded-xl transition-colors"
            >
              <Trash2 size={13} />
              Remove
            </button>
          )}
          <PlaidLinkButton label="Add Account" />
        </div>
      </div>

      {/* ── 1. Summary cards (non-clickable) ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Card>
          <CardTitle>Total Cash</CardTitle>
          <p className="text-3xl font-bold text-emerald-400 mt-1">{fmtCompact(totalCash)}</p>
          <p className="text-xs text-gray-500 mt-1">Checking + Savings</p>
        </Card>
        <Card>
          <CardTitle>Total Debt</CardTitle>
          <p className="text-3xl font-bold text-red-400 mt-1">{fmtCompact(totalDebt)}</p>
          <p className="text-xs text-gray-500 mt-1">Cards</p>
        </Card>
        <Card className="col-span-2 lg:col-span-1">
          <CardTitle>Net Liquid</CardTitle>
          <p className={`text-3xl font-bold mt-1 ${netLiquid >= 0 ? "text-white" : "text-red-400"}`}>
            {fmtCompact(netLiquid)}
          </p>
          <p className="text-xs text-gray-500 mt-1">Cash minus card balances</p>
        </Card>
      </div>

      {/* ── 2. History chart ── */}
      <section>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-widest text-gray-500 mr-1">Chart:</span>
          {(["cash", "savings", "debt", "netLiquid"] as BankingSlice[]).map(sliceBtn)}
        </div>
        <PortfolioHistoryChart
          data={portfolioHistory}
          series={BANKING_SERIES}
          activeKeys={SLICE_KEYS[chartSlice]}
          title={CHART_TITLES[chartSlice]}
        />
      </section>

      {/* ── 3. Collapsible institution groups ── */}
      <section ref={accountsSectionRef} className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 px-1">Accounts</p>

        {institutionGroups.map(({ institution, accounts: accts }) => {
          const isOpen    = !collapsed[institution];
          const instTotal = accts.reduce((s, a) => s + a.balance, 0);
          const netPos    = instTotal >= 0;
          const newestSync = accts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accts[0].lastUpdated);
          const syncLabel  = formatDate(newestSync);

          return (
            <div key={institution} className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">

              {/* ── Institution header — tap to expand/collapse ── */}
              <button
                onClick={() => toggleInstitution(institution)}
                className="w-full flex items-center justify-between px-4 py-3.5 transition-colors hover:bg-gray-800/70 active:bg-gray-800 touch-manipulation select-none"
              >
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-gray-700 to-gray-600 flex items-center justify-center shrink-0 shadow-sm">
                    <span className="text-sm font-bold text-white">{institution[0]}</span>
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-white leading-tight">{institution}</p>
                    <p className="text-xs text-gray-500">{accts.length} account{accts.length !== 1 ? "s" : ""} · Updated {syncLabel}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <p className={`text-sm font-semibold tabular-nums ${netPos ? "text-white" : "text-red-400"}`}>
                    {!netPos ? "-" : ""}{fmtAbs(Math.abs(instTotal))}
                  </p>
                  <ChevronDown
                    size={16}
                    className={`text-gray-500 transition-transform duration-200 shrink-0 ${isOpen ? "rotate-180" : "rotate-0"}`}
                  />
                </div>
              </button>

              {/* ── Sliding account rows ── */}
              <div
                style={{
                  display:           "grid",
                  gridTemplateRows:  isOpen ? "1fr" : "0fr",
                  transition:        "grid-template-rows 0.2s ease",
                }}
              >
                {/* minHeight:0 required for 0fr to collapse in Safari */}
                <div className="overflow-hidden" style={{ minHeight: 0 }}>
                  <div className="border-t border-gray-700/60 bg-gray-950/60">
                    {accts.map((a, idx) => {
                      const isSelected = selectedAccountId === a.id;
                      const isDebt     = a.type === "debt";
                      const isSavings  = a.type === "savings";

                      return (
                        <button
                          key={a.id}
                          onClick={() => handleCardClick(a.id)}
                          className={`w-full flex items-center justify-between pl-6 pr-4 py-3.5 transition-colors touch-manipulation text-left ${
                            isSelected ? "bg-blue-500/10" : "hover:bg-gray-800/40 active:bg-gray-800"
                          } ${idx < accts.length - 1 ? "border-b border-gray-800/50" : ""}`}
                        >
                          {/* Left: type icon + name */}
                          <div className="flex items-center gap-3">
                            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                              isDebt    ? "bg-red-500/10"     :
                              isSavings ? "bg-emerald-500/10" :
                                          "bg-blue-500/10"
                            }`}>
                              {isDebt                  && <CreditCard size={13} className="text-red-400"     />}
                              {isSavings               && <Landmark   size={13} className="text-emerald-400" />}
                              {a.type === "checking"   && <Building2  size={13} className="text-blue-400"    />}
                            </div>
                            <div>
                              <p className="text-sm font-medium text-white leading-tight">{a.name}</p>
                              <p className="text-xs text-gray-500 capitalize leading-tight mt-0.5">
                                {isSavings ? "savings · interest monthly" : a.type}
                              </p>
                            </div>
                          </div>

                          {/* Right: balance + state */}
                          <div className="text-right shrink-0 ml-3">
                            <p className={`text-sm font-semibold tabular-nums ${
                              isDebt
                                ? a.balance > 0 ? "text-red-400" : "text-emerald-400"
                                : "text-white"
                            }`}>
                              {isDebt ? (a.balance > 0 ? "-" : "+") : ""}{fmtAbs(Math.abs(a.balance))}
                            </p>
                            {isSelected
                              ? <p className="text-xs text-blue-400 flex items-center gap-1 justify-end mt-0.5"><Check size={9} /> active</p>
                              : <p className="text-xs text-gray-600 mt-0.5">{formatDate(a.lastUpdated)}</p>
                            }
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

            </div>
          );
        })}
      </section>

      {/* ── 4. Transactions ── */}
      <section className="space-y-3">
        {/* Section header */}
        <div className="flex items-center justify-between flex-wrap gap-2 px-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Transactions</p>
            {selectedAccount && (
              <span className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
                {selectedAccount.name}
                <button onClick={() => setSelectedAccountId(null)} className="hover:text-white ml-0.5">
                  <X size={10} />
                </button>
              </span>
            )}
          </div>
          {/* Time filter */}
          <div className="flex items-center gap-1 bg-gray-900 border border-gray-700 rounded-xl p-1">
            {(["all", "90d", "30d", "7d"] as TimeFilter[]).map(timeBtn)}
          </div>
        </div>

        {/* Search + category filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input
              type="text"
              placeholder="Search transactions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-8 pr-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                <X size={13} />
              </button>
            )}
          </div>
          <select
            value={catFilter ?? ""}
            onChange={(e) => setCatFilter((e.target.value as TransactionCategory) || null)}
            className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
          >
            <option value="">All categories</option>
            {ALL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Summary strip */}
        <div className="flex items-center gap-4 text-sm flex-wrap px-1">
          <span className="text-gray-400">
            <span className="font-semibold text-white">{filteredTxs.length}</span> transactions
          </span>
          {totalSpend > 0 && (
            <span className="text-gray-400">
              Spend: <span className="font-semibold text-red-400">-{fmtTx(totalSpend)}</span>
            </span>
          )}
          {totalCredit > 0 && (
            <span className="text-gray-400">
              In: <span className="font-semibold text-emerald-400">+{fmtTx(totalCredit)}</span>
            </span>
          )}
        </div>

        {/* Transaction list */}
        <Card className="!p-0 overflow-hidden">
          {filteredTxs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-10">No transactions match your filters.</p>
          ) : (
            <div className="divide-y divide-gray-800">
              {filteredTxs.map((tx) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  acctName={acctName(tx.accountId)}
                  acctInst={acctInst(tx.accountId)}
                  hideAccount={!!selectedAccountId}
                />
              ))}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
function TxRow({
  tx,
  acctName,
  acctInst,
  hideAccount,
}: {
  tx: Transaction;
  acctName: string;
  acctInst: string;
  hideAccount: boolean;
}) {
  const isCredit = tx.amount > 0;
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(n));

  const dateObj = new Date(tx.date + "T12:00:00");

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
          {!hideAccount && (
            <span className="text-xs text-gray-600">{acctInst} · {acctName}</span>
          )}
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
