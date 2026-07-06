"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Account, Transaction, TransactionCategory } from "@/types";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { PortfolioHistoryChart, ChartSeries } from "@/components/charts/PortfolioHistoryChart";
import { PlaidLinkButton } from "@/components/plaid/PlaidLinkButton";
import { Search, X, Check, Building2, Landmark, CreditCard, ChevronDown } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { EstimatedChip } from "@/components/ui/EstimatedChip";
import { formatDate } from "@/lib/format";

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtAbs = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(n));
// (fmtTx / module fmtCompact removed — MC1 P4 Slice 1: their call sites were
// all aggregate totals, now formatted by the display-currency locals inside
// the component. fmtAbs remains for itemized per-account rows.)

// ── Chart config ──────────────────────────────────────────────────────────────
type BankingSlice = "cash" | "savings" | "debt" | "netLiquid";

// Chart series colours are data visualisation — preserved.
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

// ── Category badge ─────────────────────────────────────────────────────────────
// Step C: transaction-category colour-coding neutralised to a single ink chip —
// the category name carries the meaning (decorative type colour → neutral, per
// the account-type precedent). Restore as a data-viz palette later if desired.
const CAT_CHIP = "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

const ALL_CATEGORIES: TransactionCategory[] = [
  "Income", "Transfer", "Groceries", "Dining", "Shopping",
  "Travel", "Subscriptions", "Utilities", "Interest", "Payment", "Other",
];

// FlowType P5 Slice 2 — money-out cost flows that count toward the "Spend" chip.
const FLOW_COST = new Set(["SPENDING", "FEE", "INTEREST"]);

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
  /**
   * MC1 Phase 3 Slice 6 (F-1, D-6) — serialized Space conversion context from
   * the server page. Optional: absent => context-less native sums (kill switch).
   */
  moneyCtx?:        SerializedConversionContext;
}

// ── Main component ────────────────────────────────────────────────────────────
export function BankingClient({ accounts, transactions, portfolioHistory, preselectedId, moneyCtx }: Props) {
  // MC1 P3 Slice 6 — rehydrated once. Balances value at the latest close;
  // transaction rows convert at their own dates. Identical math when absent
  // or for all-USD Spaces.
  const conversionCtx = useMemo(
    () => (moneyCtx ? rehydrateContext(moneyCtx) : undefined),
    [moneyCtx],
  );
  // MC1 Phase 4 Slice 1 (D-1) — aggregate totals (cash/debt/net, institution
  // subtotals, flow totals) format in the display currency; per-account and
  // per-transaction rows keep the constant (itemized rule).
  const displayCurrency = useDisplayCurrency();
  const fmtAggCompact = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(n));
  const fmtAggAbs = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, maximumFractionDigits: 2 }).format(Math.abs(n));
  const balanceInTarget = useCallback(
    (a: Account): number =>
      conversionCtx
        ? convertMoney({ amount: a.balance, currency: a.currency ?? null }, yesterdayUTCISO(), conversionCtx).amount
        : a.balance,
    [conversionCtx],
  );
  const [chartSlice, setChartSlice]               = useState<BankingSlice>("cash");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(preselectedId);
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

  // MC1 P4 Slice 3 (D-5) — same sums, same order, plus estimation taint for
  // the quiet "est." indicator (map-then-reduce: no closure mutation, per
  // react-hooks/immutability). Identity conversions never taint.
  const { totalCash, totalDebt, balancesEstimated } = useMemo(() => {
    const conv = (a: Account) =>
      conversionCtx
        ? convertMoney({ amount: a.balance, currency: a.currency ?? null }, yesterdayUTCISO(), conversionCtx)
        : { amount: a.balance, estimated: false };
    const cashConv = [...checking, ...savings].map(conv);
    // Net debt: positive balances = you owe, negative = bank owes you (credit). Sum gives net owed.
    const debtConv = debt.map(conv);
    return {
      totalCash: cashConv.reduce((s, c) => s + c.amount, 0),
      totalDebt: debtConv.reduce((s, c) => s + c.amount, 0),
      balancesEstimated: cashConv.some((c) => c.estimated) || debtConv.some((c) => c.estimated),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, conversionCtx]);
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

  // FlowType P5 Slice 2 — summary totals from flowType (no category/sign).
  // Spend = SPENDING + FEE + INTEREST outflows, minus REFUND (clamped ≥ 0).
  // In = INCOME only. Transfers/debt payments/investments/adjustments/unknowns
  // are excluded from both. JSX/labels/colors below are unchanged.
  // MC1 P4 Slice 3 — flow totals with estimation taint (same populations and
  // order; map-then-reduce, no closure mutation).
  const { totalSpend, totalCredit, flowEstimated } = useMemo(() => {
    const conv = (t: Transaction) =>
      conversionCtx
        ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, conversionCtx)
        : { amount: t.amount, estimated: false };
    const cost    = filteredTxs.filter((t) => t.flowType != null && FLOW_COST.has(t.flowType)).map(conv);
    const refunds = filteredTxs.filter((t) => t.flowType === "REFUND").map(conv);
    const income  = filteredTxs.filter((t) => t.flowType === "INCOME").map(conv);
    const grossSpend   = cost.reduce((s, c) => s + Math.abs(c.amount), 0);
    const spendRefunds = refunds.reduce((s, c) => s + Math.abs(c.amount), 0);
    return {
      totalSpend:  Math.max(0, grossSpend - spendRefunds),
      totalCredit: income.reduce((s, c) => s + Math.abs(c.amount), 0),
      flowEstimated: [...cost, ...refunds, ...income].some((c) => c.estimated),
    };
  }, [filteredTxs, conversionCtx]);

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
          ? "bg-[var(--accent-info)] text-white"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-hairline)]"
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
          ? "bg-[var(--accent-info)] text-white"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
      }`}
    >
      {TIME_LABELS[t]}
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>Banking</h1>
        <div className="flex items-center gap-2">
          <PlaidLinkButton label="Add Account" />
        </div>
      </div>

      {/* ── 1. Summary cards (non-clickable) ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <DataCard>
          <DataCardTitle>Total Cash</DataCardTitle>
          <p className="text-3xl font-bold mt-1" style={{ color: "var(--accent-positive)" }}>{balancesEstimated ? "\u2248 " : ""}{fmtAggCompact(totalCash)}{balancesEstimated && <EstimatedChip />}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Checking + Savings</p>
        </DataCard>
        <DataCard>
          <DataCardTitle>Total Debt</DataCardTitle>
          <p className="text-3xl font-bold mt-1" style={{ color: "var(--accent-negative)" }}>{balancesEstimated ? "\u2248 " : ""}{fmtAggCompact(totalDebt)}{balancesEstimated && <EstimatedChip />}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Cards</p>
        </DataCard>
        <DataCard className="col-span-2 lg:col-span-1">
          <DataCardTitle>Net Liquid</DataCardTitle>
          <p className="text-3xl font-bold mt-1" style={{ color: netLiquid >= 0 ? "var(--text-primary)" : "var(--accent-negative)" }}>
            {balancesEstimated ? "\u2248 " : ""}{fmtAggCompact(netLiquid)}{balancesEstimated && <EstimatedChip />}
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Cash minus card balances</p>
        </DataCard>
      </div>

      {/* ── 2. History chart ── */}
      <section>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-widest mr-1" style={{ color: "var(--text-muted)" }}>Chart:</span>
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
        <p className="text-xs font-semibold uppercase tracking-widest px-1" style={{ color: "var(--text-muted)" }}>Accounts</p>

        {institutionGroups.map(({ institution, accounts: accts }) => {
          const isOpen    = !collapsed[institution];
          const instTotal = accts.reduce((s, a) => s + balanceInTarget(a), 0); // MC1 P3 Slice 6 — aggregate, converted
          const netPos    = instTotal >= 0;
          const newestSync = accts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accts[0].lastUpdated);
          const syncLabel  = formatDate(newestSync);

          return (
            <div key={institution} className="rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}>

              {/* ── Institution header — tap to expand/collapse ── */}
              <button
                onClick={() => toggleInstitution(institution)}
                className="w-full flex items-center justify-between px-4 py-3.5 transition-colors hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover-strong)] touch-manipulation select-none"
              >
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm" style={{ background: "var(--surface-inset)" }}>
                    <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>{institution[0]}</span>
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold leading-tight" style={{ color: "var(--text-primary)" }}>{institution}</p>
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>{accts.length} account{accts.length !== 1 ? "s" : ""} · Updated {syncLabel}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <p className="text-sm font-semibold tabular-nums" style={{ color: netPos ? "var(--text-primary)" : "var(--accent-negative)" }}>
                    {!netPos ? "-" : ""}{fmtAggAbs(Math.abs(instTotal))}
                  </p>
                  <ChevronDown
                    size={16}
                    className={`transition-transform duration-200 shrink-0 ${isOpen ? "rotate-180" : "rotate-0"}`}
                    style={{ color: "var(--text-muted)" }}
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
                  <div className="border-t" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}>
                    {accts.map((a, idx) => {
                      const isSelected = selectedAccountId === a.id;
                      const isDebt     = a.type === "debt";
                      const isSavings  = a.type === "savings";

                      return (
                        <button
                          key={a.id}
                          onClick={() => handleCardClick(a.id)}
                          className="w-full flex items-center justify-between pl-6 pr-4 py-3.5 transition-colors touch-manipulation text-left"
                          style={{
                            background: isSelected ? "var(--surface-hover-strong)" : undefined,
                            borderBottom: idx < accts.length - 1 ? "1px solid var(--border-hairline)" : undefined,
                          }}
                        >
                          {/* Left: type icon + name (type colour neutralised) */}
                          <div className="flex items-center gap-3">
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}>
                              {isDebt                  && <CreditCard size={13} />}
                              {isSavings               && <Landmark   size={13} />}
                              {a.type === "checking"   && <Building2  size={13} />}
                            </div>
                            <div>
                              <p className="text-sm font-medium leading-tight" style={{ color: "var(--text-primary)" }}>{a.name}</p>
                              <p className="text-xs capitalize leading-tight mt-0.5" style={{ color: "var(--text-muted)" }}>
                                {isSavings ? "savings · interest monthly" : a.type}
                              </p>
                            </div>
                          </div>

                          {/* Right: balance + state */}
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-sm font-semibold tabular-nums" style={{
                              color: isDebt
                                ? a.balance > 0 ? "var(--accent-negative)" : "var(--accent-positive)"
                                : "var(--text-primary)",
                            }}>
                              {isDebt ? (a.balance > 0 ? "-" : "+") : ""}{fmtAbs(Math.abs(a.balance))}
                            </p>
                            {isSelected
                              ? <p className="text-xs flex items-center gap-1 justify-end mt-0.5" style={{ color: "var(--accent-info)" }}><Check size={9} /> active</p>
                              : <p className="text-xs mt-0.5" style={{ color: "var(--text-faint)" }}>{formatDate(a.lastUpdated)}</p>
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
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>Transactions</p>
            {selectedAccount && (
              <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--accent-info)", borderColor: "var(--border-hairline)" }}>
                {selectedAccount.name}
                <button onClick={() => setSelectedAccountId(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                  <X size={10} />
                </button>
              </span>
            )}
          </div>
          {/* Time filter */}
          <div className="flex items-center gap-1 border rounded-xl p-1" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
            {(["all", "90d", "30d", "7d"] as TimeFilter[]).map(timeBtn)}
          </div>
        </div>

        {/* Search + category filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text-muted)" }} />
            <input
              type="text"
              placeholder="Search transactions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full border rounded-xl pl-8 pr-3 py-2.5 text-sm placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-info)] transition-colors"
              style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" }}
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-primary)]" style={{ color: "var(--text-muted)" }}>
                <X size={13} />
              </button>
            )}
          </div>
          <select
            value={catFilter ?? ""}
            onChange={(e) => setCatFilter((e.target.value as TransactionCategory) || null)}
            className="border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[var(--accent-info)] transition-colors"
            style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" }}
          >
            <option value="">All categories</option>
            {ALL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Summary strip */}
        <div className="flex items-center gap-4 text-sm flex-wrap px-1">
          <span style={{ color: "var(--text-secondary)" }}>
            <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{filteredTxs.length}</span> transactions
          </span>
          {totalSpend > 0 && (
            <span style={{ color: "var(--text-secondary)" }}>
              Spend: <span className="font-semibold" style={{ color: "var(--accent-negative)" }}>-{flowEstimated ? "\u2248 " : ""}{fmtAggAbs(totalSpend)}{flowEstimated && <EstimatedChip />}</span>
            </span>
          )}
          {totalCredit > 0 && (
            <span style={{ color: "var(--text-secondary)" }}>
              In: <span className="font-semibold" style={{ color: "var(--accent-positive)" }}>+{flowEstimated ? "\u2248 " : ""}{fmtAggAbs(totalCredit)}{flowEstimated && <EstimatedChip />}</span>
            </span>
          )}
        </div>

        {/* Transaction list */}
        <DataCard padding="0" className="overflow-hidden">
          {filteredTxs.length === 0 ? (
            <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>No transactions match your filters.</p>
          ) : (
            <div className="divide-y divide-[var(--border-hairline)]">
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
        </DataCard>
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
          {!hideAccount && (
            <span className="text-xs" style={{ color: "var(--text-faint)" }}>{acctInst} · {acctName}</span>
          )}
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
