"use client";

import React, { useState, useEffect, useRef } from "react";
import { formatDate } from "@/lib/format";
import { Account, Holding, InvestmentTransaction } from "@/types";

type PortfolioHistoryPoint = {
  date: string; stocks: number; crypto: number; total: number;
  cash: number; savings: number; debt: number; netLiquid: number;
};

interface InvestmentsProps {
  accounts:               Account[];
  holdings:               Holding[];
  portfolioHistory:       PortfolioHistoryPoint[];
  preselectedId:          string | null;
  investmentTransactions: InvestmentTransaction[];
}
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import { AssetDrawer } from "@/components/dashboard/AssetDrawer";
import { Card, CardTitle } from "@/components/ui/Card";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { PortfolioHistoryChart, ChartSeries } from "@/components/charts/PortfolioHistoryChart";
import {
  TrendingUp,
  TrendingDown,
  Plus,
  ChevronDown,
  ChevronUp,
  Check,
  Trash2,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Percent,
  DollarSign,
} from "lucide-react";
import { PlaidLinkButton } from "@/components/plaid/PlaidLinkButton";
import { RemoveAccountModal } from "@/components/dashboard/RemoveAccountModal";
import { exchangeSymbol } from "@/lib/exchangeSymbol";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(n);
const fmtCompact = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 1 }).format(n);
function truncAddr(addr: string) {
  return addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

type InvestmentFilter = "all" | "stocks" | "crypto";
const PREVIEW = 4;

// Unified crypto row — wallet accounts only (no exchange APIs)
interface CryptoRow {
  id: string;
  symbol: string;       // drives the icon (walletChain symbol)
  name: string;         // display label (wallet nickname)
  source: string;
  balance: number;
  quantity?: number;    // native token amount (e.g. 0.085 BTC)
  price?: number;
  change24h?: number;
  walletAddress?: string;
  walletChain?:   string;
  lastUpdated?:   string;
  holdings?:      Holding[];   // present for exchange accounts (Coinbase etc.)
  removable:      boolean;
}

// ── Category badge config ─────────────────────────────────────────────────────
const ACTIVITY_CAT: Record<
  InvestmentTransaction["category"],
  { label: string; cls: string; icon: React.ReactNode }
> = {
  Buy:      { label: "Buy",      cls: "bg-emerald-500/15 text-emerald-400", icon: <ArrowDownCircle size={10} /> },
  Sell:     { label: "Sell",     cls: "bg-red-500/15 text-red-400",         icon: <ArrowUpCircle size={10} />   },
  Dividend: { label: "Dividend", cls: "bg-blue-500/15 text-blue-400",       icon: <DollarSign size={10} />      },
  Split:    { label: "Split",    cls: "bg-purple-500/15 text-purple-400",   icon: <Percent size={10} />         },
  Fee:      { label: "Fee",      cls: "bg-gray-500/15 text-gray-400",       icon: <Trash2 size={10} />          },
};

const COMPACT_ROWS = 4;
const PAGE_ROWS    = 10;

function TxRow({ tx, acct }: { tx: InvestmentTransaction; acct?: Account }) {
  const cat     = ACTIVITY_CAT[tx.category];
  const isBuy   = tx.category === "Buy";
  const dateObj = new Date(tx.date + "T12:00:00");
  const fmtAmt  = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(n));

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800/40 transition-colors">
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold text-gray-300 leading-none">
          {dateObj.toLocaleDateString("en-US", { day: "numeric" })}
        </p>
        <p className="text-xs text-gray-600 mt-0.5">
          {dateObj.toLocaleDateString("en-US", { month: "short" })}
        </p>
      </div>
      <CoinIcon symbol={tx.ticker} size={32} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-white">{tx.ticker}</p>
          <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${cat.cls}`}>
            {cat.icon}{cat.label}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500 truncate">
          <span className="truncate">{tx.description}</span>
          {acct && <span className="shrink-0 text-gray-700">· {acct.name}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-sm font-bold tabular-nums ${
          tx.category === "Sell" || tx.category === "Dividend" ? "text-emerald-400"
          : tx.category === "Buy" ? "text-white"
          : "text-gray-400"
        }`}>
          {isBuy ? "−" : tx.amount > 0 ? "+" : "−"}{fmtAmt(tx.amount)}
        </p>
      </div>
    </div>
  );
}

function InvestmentActivityTable({
  transactions,
  accounts,
  selectedAccountId,
  investmentFilter,
}: {
  transactions:      InvestmentTransaction[];
  accounts:          Account[];
  selectedAccountId: string | null;
  investmentFilter:  InvestmentFilter;
}) {
  const [txFilter,   setTxFilter]   = useState<"all" | InvestmentTransaction["category"]>("all");
  const [modalOpen,  setModalOpen]  = useState(false);
  const [modalPage,  setModalPage]  = useState(0); // 0-indexed

  const acctMap = new Map(accounts.map((a) => [a.id, a]));

  // Filter by stocks/crypto/all (top-level) + selected account + category
  const filtered = transactions.filter((tx) => {
    const acctType = acctMap.get(tx.accountId)?.type;
    if (investmentFilter === "stocks" && acctType !== "investment") return false;
    if (investmentFilter === "crypto"  && acctType !== "crypto")     return false;
    if (selectedAccountId && tx.accountId !== selectedAccountId)     return false;
    if (txFilter !== "all" && tx.category !== txFilter)              return false;
    return true;
  });

  const compact    = filtered.slice(0, COMPACT_ROWS);
  const totalPages = Math.ceil(filtered.length / PAGE_ROWS);
  const pageSlice  = filtered.slice(modalPage * PAGE_ROWS, (modalPage + 1) * PAGE_ROWS);

  // Reset modal page when filter changes
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { setModalPage(0); }, [txFilter, investmentFilter, selectedAccountId]);

  return (
    <>
      {/* ── Modal ── */}
      {modalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88dvh]">
            {/* Modal header */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-800 shrink-0 flex-wrap">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-white">Activity</p>
                <span className="text-xs text-gray-500">{filtered.length} transactions</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-gray-950 border border-gray-700 rounded-xl p-1">
                  {(["all", "Buy", "Sell", "Dividend", "Split", "Fee"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setTxFilter(f)}
                      className={`text-xs font-semibold px-2 py-1 rounded-lg transition-colors ${
                        txFilter === f ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                    >
                      {f === "all" ? "All" : f}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setModalOpen(false)}
                  className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
                >
                  <ChevronUp size={16} />
                </button>
              </div>
            </div>

            {/* Transaction list */}
            <div className="overflow-y-auto flex-1 divide-y divide-gray-800">
              {pageSlice.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-10">No transactions match this filter.</p>
              ) : (
                pageSlice.map((tx) => <TxRow key={tx.id} tx={tx} acct={acctMap.get(tx.accountId)} />)
              )}
            </div>

            {/* Pagination footer */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800 shrink-0">
                <button
                  onClick={() => setModalPage((p) => Math.max(0, p - 1))}
                  disabled={modalPage === 0}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronUp size={14} className="rotate-[-90deg]" /> Prev
                </button>
                <span className="text-xs text-gray-500">
                  {modalPage + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setModalPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={modalPage === totalPages - 1}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next <ChevronDown size={14} className="rotate-[-90deg]" />
                </button>
              </div>
            )}

            {/* Close */}
            <div className="px-4 pb-4 shrink-0">
              <button
                onClick={() => setModalOpen(false)}
                className="w-full text-sm font-medium text-gray-400 hover:text-white border border-gray-700 py-2.5 rounded-xl transition-colors"
              >
                Collapse
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Compact card ── */}
      <Card className="!p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white">Activity</p>
            <span className="text-xs text-gray-500">{filtered.length} transactions</span>
          </div>
          {filtered.length > COMPACT_ROWS && (
            <button
              onClick={() => { setModalOpen(true); setModalPage(0); }}
              className="flex items-center gap-1.5 text-xs font-semibold text-blue-400 border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors"
            >
              <ChevronDown size={13} />
              Show more
            </button>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-gray-500">No transactions yet.</p>
            <p className="text-xs text-gray-600 mt-1">Connect via Plaid to pull live activity.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {compact.map((tx) => <TxRow key={tx.id} tx={tx} acct={acctMap.get(tx.accountId)} />)}
          </div>
        )}
      </Card>
    </>
  );
}

// Chart series definitions
const INVESTMENT_SERIES: ChartSeries[] = [
  { key: "stocks", label: "Stocks & Funds", color: "#8b5cf6" },
  { key: "crypto", label: "Crypto",         color: "#eab308" },
  { key: "total",  label: "Total Portfolio", color: "#60a5fa" },
];

const CHART_TITLE: Record<InvestmentFilter, string> = {
  stocks: "Stocks & Funds History",
  crypto: "Crypto History",
  all:    "Total Portfolio History",
};

export function InvestmentsClient({ accounts, holdings, portfolioHistory, preselectedId, investmentTransactions }: InvestmentsProps) {
  // Seed filter and selection from deep-link
  const preAcct = preselectedId ? accounts.find((a) => a.id === preselectedId) : null;
  const initialFilter: InvestmentFilter =
    preAcct?.type === "investment" ? "stocks" :
    preAcct?.type === "crypto"     ? "crypto" : "all";

  const [filter, setFilter] = useState<InvestmentFilter>(initialFilter);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    preAcct?.type === "investment" ? preselectedId : null
  );

  // Section refs for scroll-to
  const stocksSectionRef = useRef<HTMLElement>(null);
  const cryptoSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!preselectedId || !preAcct) return;
    const ref = preAcct.type === "investment" ? stocksSectionRef : cryptoSectionRef;
    const t = setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [holdingsExpanded, setHoldingsExpanded] = useState(false);
  const [showAddModal, setShowAddModal]         = useState(false);
  const [showRemoveModal, setShowRemoveModal]   = useState(false);
  const [extraWallets] = useState<Account[]>([]);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [selectedAsset, setSelectedAsset] = useState<CryptoRow | null>(null);

  // ── Stock data ──────────────────────────────────────────────────────
  const stocks = accounts.filter((a) => a.type === "investment");
  const allStockHoldings = holdings.filter((h) =>
    stocks.map((a) => a.id).includes(h.accountId)
  );
  const totalStocks = stocks.reduce((s, a) => s + a.balance, 0);

  // ── Crypto data — wallet addresses only ─────────────────────────────
  const baseCryptoAccounts = accounts.filter((a) => a.type === "crypto");
  const allCryptoAccounts = [...baseCryptoAccounts, ...extraWallets].filter(
    (a) => !removedIds.has(a.id)
  );

  // Build crypto rows from wallet accounts only
  const cryptoRows: CryptoRow[] = allCryptoAccounts.map((acct) => {
    const acctHoldings = holdings.filter((h) => h.accountId === acct.id);
    const isExchange   = !acct.walletChain; // exchange = no chain (Coinbase, Gemini etc.)
    return {
      id:            acct.id,
      symbol:        acct.walletChain ?? exchangeSymbol(acct.institution),
      name:          acct.name,
      source:        isExchange ? acct.institution : "Self-custodied",
      balance:       acct.balance,
      quantity:      acct.nativeBalance,
      walletAddress: acct.walletAddress,
      walletChain:   acct.walletChain,
      lastUpdated:   acct.lastUpdated,
      holdings:      isExchange && acctHoldings.length > 0 ? acctHoldings : undefined,
      removable:     !isExchange, // exchanges are linked via Plaid, not manually removable
    };
  });

  // Sort: exchange accounts first (Coinbase etc.), then self-custody wallets by balance descending
  const sortedCryptoRows = [
    ...cryptoRows.filter((r) => !r.removable),              // exchanges on top
    ...cryptoRows.filter((r) =>  r.removable).sort((a, b) => b.balance - a.balance), // wallets by exposure
  ];

  const totalCrypto = allCryptoAccounts.reduce((s, a) => s + (a.balance || 0), 0);

  // ── Chart: which series to show ─────────────────────────────────────
  const chartActiveKeys =
    filter === "stocks" ? ["stocks"] :
    filter === "crypto" ? ["crypto"] :
    ["total"];

  // ── Filter / account selection ───────────────────────────────────────
  function handleFilterChange(f: InvestmentFilter) {
    setFilter(f);
    setSelectedAccountId(null);
    setHoldingsExpanded(false);
  }

  function handleAccountClick(id: string) {
    setSelectedAccountId((prev) => (prev === id ? null : id));
    setHoldingsExpanded(false);
  }

  // ── Stock holdings slice ─────────────────────────────────────────────
  const stockHoldingsFiltered = selectedAccountId
    ? allStockHoldings.filter((h) => h.accountId === selectedAccountId)
    : allStockHoldings;

  const holdingsToShow: Holding[] = filter === "crypto" ? [] : stockHoldingsFiltered;

  const visibleHoldings = holdingsExpanded
    ? holdingsToShow
    : holdingsToShow.slice(0, PREVIEW);

  // ── Remove wallet ────────────────────────────────────────────────────
  function handleRemove(id: string) {
    setRemovedIds((prev) => new Set([...prev, id]));
    setConfirmRemoveId(null);
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  const showStocks = filter === "all" || filter === "stocks";
  const showCrypto = filter === "all" || filter === "crypto";

  const cardActive = (f: InvestmentFilter) =>
    `cursor-pointer transition-all border-2 ${
      filter === f
        ? "border-blue-500 bg-blue-500/10"
        : "border-transparent hover:border-gray-600"
    }`;

  return (
    <div className="space-y-6">
      {showAddModal && (
        <AddWalletModal
          onClose={() => setShowAddModal(false)}
          onAdd={() => {}}
        />
      )}

      {showRemoveModal && (
        <RemoveAccountModal
          accounts={accounts}
          onClose={() => setShowRemoveModal(false)}
        />
      )}

      {selectedAsset && (
        <AssetDrawer
          asset={{
            symbol:       selectedAsset.symbol,
            name:         selectedAsset.name,
            value:        selectedAsset.balance,
            quantity:     selectedAsset.quantity,
            price:        selectedAsset.price,
            change24h:    selectedAsset.change24h,
            source:       selectedAsset.source,
            walletAddress: selectedAsset.walletAddress,
            holdings:     selectedAsset.holdings,
          }}
          onClose={() => setSelectedAsset(null)}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Investments</h1>
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

      {/* ── Summary filter cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Card className={cardActive("stocks")} onClick={() => handleFilterChange(filter === "stocks" ? "all" : "stocks")}>
          <div className="flex items-center justify-between mb-1">
            <CardTitle>Stocks & Funds</CardTitle>
            {filter === "stocks" && <Check size={13} className="text-blue-400" />}
          </div>
          <p className="text-3xl font-bold text-violet-400">{fmtCompact(totalStocks)}</p>
          <p className="text-xs text-gray-500 mt-1">{stocks.length} accounts</p>
        </Card>

        <Card className={cardActive("crypto")} onClick={() => handleFilterChange(filter === "crypto" ? "all" : "crypto")}>
          <div className="flex items-center justify-between mb-1">
            <CardTitle>Crypto</CardTitle>
            {filter === "crypto" && <Check size={13} className="text-blue-400" />}
          </div>
          <p className="text-3xl font-bold text-yellow-400">{fmtCompact(totalCrypto)}</p>
          <p className="text-xs text-gray-500 mt-1">{allCryptoAccounts.length} wallets</p>
        </Card>

        <Card className={`col-span-2 lg:col-span-1 ${cardActive("all")}`} onClick={() => handleFilterChange("all")}>
          <div className="flex items-center justify-between mb-1">
            <CardTitle>Total Portfolio</CardTitle>
            {filter === "all" && <Check size={13} className="text-blue-400" />}
          </div>
          <p className="text-3xl font-bold text-white">{fmtCompact(totalStocks + totalCrypto)}</p>
          <p className="text-xs text-gray-500 mt-1">{stocks.length + allCryptoAccounts.length} accounts</p>
        </Card>
      </div>

      {/* ── Stocks section ── */}
      {showStocks && (
        <section ref={stocksSectionRef} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 px-1">
            Stocks & Funds
            {filter === "stocks" && (
              <span className="ml-2 text-blue-400 normal-case tracking-normal font-normal text-xs">
                — click an account to filter holdings
              </span>
            )}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {stocks.map((a) => {
              const sel = selectedAccountId === a.id;
              return (
                <div
                  key={a.id}
                  onClick={() => handleAccountClick(a.id)}
                  className={`rounded-2xl border-2 transition-all cursor-pointer ${
                    sel ? "border-violet-500 bg-violet-500/5" : "border-transparent hover:border-gray-600"
                  }`}
                >
                  <div className="rounded-[14px] border border-gray-700 bg-gray-900 p-4">
                    <p className="text-xs text-gray-400 truncate">{a.institution}</p>
                    <p className="text-sm font-semibold text-white truncate mb-2">{a.name}</p>
                    <p className="text-2xl font-bold text-violet-400">{fmt(a.balance)}</p>
                    <p className="text-xs text-gray-600 mt-1">Updated {formatDate(a.lastUpdated)}</p>
                  </div>
                  {sel && (
                    <p className="text-xs text-violet-400 text-center py-1.5">
                      ↑ showing holdings for this account
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Stock holdings table */}
          {holdingsToShow.length > 0 && (
            <Card>
              <div className="flex items-center justify-between mb-1">
                <CardTitle>
                  Holdings{selectedAccountId && ` — ${stocks.find((a) => a.id === selectedAccountId)?.name}`}
                </CardTitle>
                <span className="text-xs text-gray-500">{holdingsToShow.length} positions</span>
              </div>
              <div className="divide-y divide-gray-800">
                {visibleHoldings.map((h) => (
                  <div
                    key={h.id}
                    onClick={() =>
                      setSelectedAsset({
                        id: `s-${h.id}`,
                        symbol: h.symbol,
                        name: h.name,
                        source: stocks.find((a) => a.id === h.accountId)?.institution ?? "",
                        balance: h.value,
                        quantity: h.quantity,
                        price: h.price,
                        change24h: h.change24h,
                        removable: false,
                      })
                    }
                    className="flex items-center justify-between py-3 cursor-pointer hover:bg-gray-800/50 rounded-xl px-2 -mx-2 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <CoinIcon symbol={h.symbol} size={36} />
                      <div>
                        <p className="text-sm font-semibold text-white">{h.symbol}</p>
                        <p className="text-xs text-gray-500">
                          {h.quantity} shares · {fmt(h.price)}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-white">{fmt(h.value)}</p>
                      <span
                        className={`flex items-center justify-end gap-0.5 text-xs font-medium ${
                          h.change24h >= 0 ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {h.change24h >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                        {h.change24h >= 0 ? "+" : ""}
                        {h.change24h}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {holdingsToShow.length > PREVIEW && (
                <button
                  onClick={() => setHoldingsExpanded((e) => !e)}
                  className="flex items-center justify-center gap-1.5 w-full mt-3 pt-3 border-t border-gray-800 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
                >
                  {holdingsExpanded ? (
                    <><ChevronUp size={15} /> See Less</>
                  ) : (
                    <><ChevronDown size={15} /> Show {holdingsToShow.length - PREVIEW} More</>
                  )}
                </button>
              )}
            </Card>
          )}
        </section>
      )}

      {/* ── Crypto section — wallet addresses only ── */}
      {showCrypto && (
        <section ref={cryptoSectionRef} className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Crypto</p>
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 text-xs font-semibold text-blue-400 border border-blue-500/30 bg-blue-500/10 px-3 py-2.5 rounded-lg hover:bg-blue-500/20 transition-colors touch-manipulation"
            >
              <Plus size={13} />
              Add Wallet
            </button>
          </div>

          <Card>
            {sortedCryptoRows.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">
                No crypto wallets yet. Add a wallet address to get started.
              </p>
            ) : (
              <div className="divide-y divide-gray-800">
                {sortedCryptoRows.map((row) => {
                  const isConfirming = confirmRemoveId === row.id;

                  return (
                    <div key={row.id} className="py-3">
                      {isConfirming ? (
                        /* ── Confirm remove ── */
                        <div className="flex items-center justify-between gap-3 px-1 py-1 bg-red-500/10 border border-red-500/20 rounded-xl">
                          <div className="flex items-center gap-2 min-w-0">
                            <AlertTriangle size={15} className="text-red-400 shrink-0" />
                            <p className="text-sm text-red-300 truncate">
                              Remove <span className="font-semibold">{row.name}</span>?
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => handleRemove(row.id)}
                              className="text-xs font-semibold text-white bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg transition-colors"
                            >
                              Remove
                            </button>
                            <button
                              onClick={() => setConfirmRemoveId(null)}
                              className="text-xs font-medium text-gray-400 hover:text-white border border-gray-700 px-3 py-1.5 rounded-lg transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* ── Normal row ── */
                        <div className="flex items-center gap-3">
                          {/* Click zone → opens chart drawer */}
                          <div
                            onClick={() => setSelectedAsset(row)}
                            className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer hover:bg-gray-800/50 rounded-xl px-2 py-1 -mx-2 transition-colors"
                          >
                            <CoinIcon symbol={row.symbol} size={36} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-semibold text-white">{row.name}</p>
                                {row.walletChain && (
                                  <span className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
                                    {row.walletChain}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500 truncate mt-0.5">
                                {row.walletAddress ? truncAddr(row.walletAddress) : row.source}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-semibold text-white">{fmt(row.balance)}</p>
                              {row.quantity !== undefined ? (
                                <p className="text-xs text-gray-400">
                                  {row.quantity} {row.walletChain}
                                </p>
                              ) : row.walletChain ? (
                                /* self-custody wallet with no balance synced yet */
                                <span className="text-xs text-yellow-400">pending</span>
                              ) : null /* exchange account — multiple assets, no native balance */}
                              {row.lastUpdated && (
                                <p className="text-xs text-gray-600 mt-0.5">
                                  {formatDate(row.lastUpdated)}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Trash button — only for manually-added self-custody wallets */}
                          {row.removable && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmRemoveId(row.id);
                              }}
                              className="shrink-0 p-2 text-gray-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                              title="Remove wallet"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </section>
      )}

      {/* ── Activity ── */}
      <section className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 px-1">Activity</p>
        <InvestmentActivityTable
          transactions={investmentTransactions}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          investmentFilter={filter}
        />
      </section>

      {/* ── Portfolio History Chart ── */}
      <section>
        <PortfolioHistoryChart
          data={portfolioHistory}
          series={INVESTMENT_SERIES}
          activeKeys={chartActiveKeys}
          title={CHART_TITLE[filter]}
        />
      </section>
    </div>
  );
}
