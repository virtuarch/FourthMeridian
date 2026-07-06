"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
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
  /** MC1 P4 Slice 5 (F-5, D-6) — serialized Space conversion context; absent => native sums (kill switch). */
  moneyCtx?:              SerializedConversionContext;
}
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import { AssetDrawer } from "@/components/dashboard/AssetDrawer";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
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
import { exchangeSymbol } from "@/lib/exchangeSymbol";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { EstimatedChip } from "@/components/ui/EstimatedChip";

// MC1 QA Q3 — itemized rows pass the ROW's own currency; default preserved.
const fmt = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);
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
  /** MC1 QA Q3 — native currency of balance (optional; USD fallback). */
  currency?: string | null;
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
// Step C: category colour-coding neutralised to a single ink chip; the icon +
// label carry the meaning. Amount direction is still state-coloured in TxRow.
const CAT_CHIP = "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

const ACTIVITY_CAT: Record<
  InvestmentTransaction["category"],
  { label: string; icon: React.ReactNode }
> = {
  Buy:      { label: "Buy",      icon: <ArrowDownCircle size={10} /> },
  Sell:     { label: "Sell",     icon: <ArrowUpCircle size={10} />   },
  Dividend: { label: "Dividend", icon: <DollarSign size={10} />      },
  Split:    { label: "Split",    icon: <Percent size={10} />         },
  Fee:      { label: "Fee",      icon: <Trash2 size={10} />          },
};

const COMPACT_ROWS = 4;
const PAGE_ROWS    = 10;

function TxRow({ tx, acct }: { tx: InvestmentTransaction; acct?: Account }) {
  const cat     = ACTIVITY_CAT[tx.category];
  const isBuy   = tx.category === "Buy";
  const dateObj = new Date(tx.date + "T12:00:00");
  const fmtAmt  = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(n));

  const amountColor =
    tx.category === "Sell" || tx.category === "Dividend" ? "var(--accent-positive)"
    : tx.category === "Buy" ? "var(--text-primary)"
    : "var(--text-muted)";

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors">
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold leading-none" style={{ color: "var(--text-secondary)" }}>
          {dateObj.toLocaleDateString("en-US", { day: "numeric" })}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-faint)" }}>
          {dateObj.toLocaleDateString("en-US", { month: "short" })}
        </p>
      </div>
      <CoinIcon symbol={tx.ticker} size={32} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{tx.ticker}</p>
          <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${CAT_CHIP}`}>
            {cat.icon}{cat.label}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs truncate" style={{ color: "var(--text-muted)" }}>
          <span className="truncate">{tx.description}</span>
          {acct && <span className="shrink-0" style={{ color: "var(--text-faint)" }}>· {acct.name}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-bold tabular-nums" style={{ color: amountColor }}>
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm" style={{ background: "var(--scrim)" }}>
          <div className="w-full max-w-lg border rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88dvh]" style={{ background: "var(--modal-surface)", borderColor: "var(--border-hairline-strong)" }}>
            {/* Modal header */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b shrink-0 flex-wrap" style={{ borderColor: "var(--border-hairline)" }}>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Activity</p>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{filtered.length} transactions</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 border rounded-xl p-1" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                  {(["all", "Buy", "Sell", "Dividend", "Split", "Fee"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setTxFilter(f)}
                      className="text-xs font-semibold px-2 py-1 rounded-lg transition-colors"
                      style={txFilter === f
                        ? { background: "var(--accent-info)", color: "#fff" }
                        : { color: "var(--text-secondary)" }}
                    >
                      {f === "all" ? "All" : f}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setModalOpen(false)}
                  className="p-1.5 hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors"
                  style={{ color: "var(--text-muted)" }}
                >
                  <ChevronUp size={16} />
                </button>
              </div>
            </div>

            {/* Transaction list */}
            <div className="overflow-y-auto flex-1 divide-y divide-[var(--border-hairline)]">
              {pageSlice.length === 0 ? (
                <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>No transactions match this filter.</p>
              ) : (
                pageSlice.map((tx) => <TxRow key={tx.id} tx={tx} acct={acctMap.get(tx.accountId)} />)
              )}
            </div>

            {/* Pagination footer */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t shrink-0" style={{ borderColor: "var(--border-hairline)" }}>
                <button
                  onClick={() => setModalPage((p) => Math.max(0, p - 1))}
                  disabled={modalPage === 0}
                  className="flex items-center gap-1 text-xs font-semibold hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <ChevronUp size={14} className="rotate-[-90deg]" /> Prev
                </button>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {modalPage + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setModalPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={modalPage === totalPages - 1}
                  className="flex items-center gap-1 text-xs font-semibold hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Next <ChevronDown size={14} className="rotate-[-90deg]" />
                </button>
              </div>
            )}

            {/* Close */}
            <div className="px-4 pb-4 shrink-0">
              <button
                onClick={() => setModalOpen(false)}
                className="w-full text-sm font-medium hover:text-[var(--text-primary)] border py-2.5 rounded-xl transition-colors"
                style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}
              >
                Collapse
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Compact card ── */}
      <DataCard padding="0" className="overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b" style={{ borderColor: "var(--border-hairline)" }}>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Activity</p>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{filtered.length} transactions</span>
          </div>
          {filtered.length > COMPACT_ROWS && (
            <button
              onClick={() => { setModalOpen(true); setModalPage(0); }}
              className="flex items-center gap-1.5 text-xs font-semibold border px-3 py-1.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors"
              style={{ color: "var(--accent-info)", borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
            >
              <ChevronDown size={13} />
              Show more
            </button>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>No transactions yet.</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>Connect via Plaid to pull live activity.</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-hairline)]">
            {compact.map((tx) => <TxRow key={tx.id} tx={tx} acct={acctMap.get(tx.accountId)} />)}
          </div>
        )}
      </DataCard>
    </>
  );
}

// Chart series definitions — data-viz colours preserved.
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

export function InvestmentsClient({ accounts, holdings, portfolioHistory, preselectedId, investmentTransactions, moneyCtx }: InvestmentsProps) {
  // MC1 P4 Slice 5 — rehydrated context + display-currency aggregate formatter.
  const conversionCtx = useMemo(() => (moneyCtx ? rehydrateContext(moneyCtx) : undefined), [moneyCtx]);
  const displayCurrency = useDisplayCurrency();
  const fmtAggCompact = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, notation: "compact", maximumFractionDigits: 1 }).format(n);
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
  const [extraWallets] = useState<Account[]>([]);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [selectedAsset, setSelectedAsset] = useState<CryptoRow | null>(null);

  // ── Stock data ──────────────────────────────────────────────────────
  const stocks = accounts.filter((a) => a.type === "investment");
  const allStockHoldings = holdings.filter((h) =>
    stocks.map((a) => a.id).includes(h.accountId)
  );
  // MC1 P4 Slice 5 — aggregate totals converted at the latest close; taint
  // drives the quiet "est." indicator (map-then-reduce, same order).
  const stockConv = stocks.map((a) =>
    conversionCtx
      ? convertMoney({ amount: a.balance, currency: a.currency ?? null }, yesterdayUTCISO(), conversionCtx)
      : { amount: a.balance, estimated: false },
  );
  const totalStocks = stockConv.reduce((s, c) => s + c.amount, 0);

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
      currency:      acct.currency ?? null, // MC1 QA Q3 — itemized row label
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

  const cryptoConv = allCryptoAccounts.map((a) =>
    conversionCtx
      ? convertMoney({ amount: a.balance || 0, currency: a.currency ?? null }, yesterdayUTCISO(), conversionCtx)
      : { amount: a.balance || 0, estimated: false },
  );
  const totalCrypto = cryptoConv.reduce((s, c) => s + c.amount, 0);
  const investTotalsEstimated = stockConv.some((c) => c.estimated) || cryptoConv.some((c) => c.estimated);

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

  // Selection ring for the summary filter cards (accent when active).
  const filterCardStyle = (f: InvestmentFilter): React.CSSProperties | undefined =>
    filter === f ? { boxShadow: "0 0 0 2px var(--accent-info)" } : undefined;

  return (
    <div className="space-y-6">
      {showAddModal && (
        <AddWalletModal
          onClose={() => setShowAddModal(false)}
          onAdd={() => {}}
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
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>Investments</h1>
        <div className="flex items-center gap-2">
          <PlaidLinkButton label="Add Account" />
        </div>
      </div>

      {/* ── Summary filter cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <DataCard interactive onClick={() => handleFilterChange(filter === "stocks" ? "all" : "stocks")} className="cursor-pointer" style={filterCardStyle("stocks")}>
          <div className="flex items-center justify-between mb-1">
            <DataCardTitle>Stocks & Funds</DataCardTitle>
            {filter === "stocks" && <Check size={13} style={{ color: "var(--accent-info)" }} />}
          </div>
          <p className="text-3xl font-bold" style={{ color: "var(--text-primary)" }}>{investTotalsEstimated ? "\u2248 " : ""}{fmtAggCompact(totalStocks)}{investTotalsEstimated && <EstimatedChip />}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{stocks.length} accounts</p>
        </DataCard>

        <DataCard interactive onClick={() => handleFilterChange(filter === "crypto" ? "all" : "crypto")} className="cursor-pointer" style={filterCardStyle("crypto")}>
          <div className="flex items-center justify-between mb-1">
            <DataCardTitle>Crypto</DataCardTitle>
            {filter === "crypto" && <Check size={13} style={{ color: "var(--accent-info)" }} />}
          </div>
          <p className="text-3xl font-bold" style={{ color: "var(--text-primary)" }}>{investTotalsEstimated ? "\u2248 " : ""}{fmtAggCompact(totalCrypto)}{investTotalsEstimated && <EstimatedChip />}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{allCryptoAccounts.length} wallets</p>
        </DataCard>

        <DataCard interactive onClick={() => handleFilterChange("all")} className="col-span-2 lg:col-span-1 cursor-pointer" style={filterCardStyle("all")}>
          <div className="flex items-center justify-between mb-1">
            <DataCardTitle>Total Portfolio</DataCardTitle>
            {filter === "all" && <Check size={13} style={{ color: "var(--accent-info)" }} />}
          </div>
          <p className="text-3xl font-bold" style={{ color: "var(--text-primary)" }}>{investTotalsEstimated ? "\u2248 " : ""}{fmtAggCompact(totalStocks + totalCrypto)}{investTotalsEstimated && <EstimatedChip />}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{stocks.length + allCryptoAccounts.length} accounts</p>
        </DataCard>
      </div>

      {/* ── Stocks section ── */}
      {showStocks && (
        <section ref={stocksSectionRef} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest px-1" style={{ color: "var(--text-muted)" }}>
            Stocks & Funds
            {filter === "stocks" && (
              <span className="ml-2 normal-case tracking-normal font-normal text-xs" style={{ color: "var(--accent-info)" }}>
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
                  className="rounded-2xl border-2 transition-all cursor-pointer"
                  style={{ borderColor: sel ? "var(--accent-info)" : "transparent", background: sel ? "var(--surface-muted)" : undefined }}
                >
                  <div className="rounded-[14px] border p-4" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
                    <p className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>{a.institution}</p>
                    <p className="text-sm font-semibold truncate mb-2" style={{ color: "var(--text-primary)" }}>{a.name}</p>
                    <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>{fmt(a.balance, a.currency ?? DEFAULT_DISPLAY_CURRENCY)}</p>
                    <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>Updated {formatDate(a.lastUpdated)}</p>
                  </div>
                  {sel && (
                    <p className="text-xs text-center py-1.5" style={{ color: "var(--accent-info)" }}>
                      ↑ showing holdings for this account
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Stock holdings table */}
          {holdingsToShow.length > 0 && (
            <DataCard>
              <div className="flex items-center justify-between mb-1">
                <DataCardTitle>
                  Holdings{selectedAccountId && ` — ${stocks.find((a) => a.id === selectedAccountId)?.name}`}
                </DataCardTitle>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{holdingsToShow.length} positions</span>
              </div>
              <div className="divide-y divide-[var(--border-hairline)]">
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
                    className="flex items-center justify-between py-3 cursor-pointer hover:bg-[var(--surface-hover)] rounded-xl px-2 -mx-2 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <CoinIcon symbol={h.symbol} size={36} />
                      <div>
                        <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{h.symbol}</p>
                        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                          {h.quantity} shares · {fmt(h.price, h.currency ?? DEFAULT_DISPLAY_CURRENCY)}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(h.value, h.currency ?? DEFAULT_DISPLAY_CURRENCY)}</p>
                      <span
                        className="flex items-center justify-end gap-0.5 text-xs font-medium"
                        style={{ color: h.change24h >= 0 ? "var(--accent-positive)" : "var(--accent-negative)" }}
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
                  className="flex items-center justify-center gap-1.5 w-full mt-3 pt-3 border-t text-sm font-medium transition-colors"
                  style={{ borderColor: "var(--border-hairline)", color: "var(--accent-info)" }}
                >
                  {holdingsExpanded ? (
                    <><ChevronUp size={15} /> See Less</>
                  ) : (
                    <><ChevronDown size={15} /> Show {holdingsToShow.length - PREVIEW} More</>
                  )}
                </button>
              )}
            </DataCard>
          )}
        </section>
      )}

      {/* ── Crypto section — wallet addresses only ── */}
      {showCrypto && (
        <section ref={cryptoSectionRef} className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>Crypto</p>
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 text-xs font-semibold border px-3 py-2.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors touch-manipulation"
              style={{ color: "var(--accent-info)", borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
            >
              <Plus size={13} />
              Add Wallet
            </button>
          </div>

          <DataCard>
            {sortedCryptoRows.length === 0 ? (
              <p className="text-sm text-center py-6" style={{ color: "var(--text-muted)" }}>
                No crypto wallets yet. Add a wallet address to get started.
              </p>
            ) : (
              <div className="divide-y divide-[var(--border-hairline)]">
                {sortedCryptoRows.map((row) => {
                  const isConfirming = confirmRemoveId === row.id;

                  return (
                    <div key={row.id} className="py-3">
                      {isConfirming ? (
                        /* ── Confirm remove ── */
                        <div className="flex items-center justify-between gap-3 px-1 py-1 rounded-xl border" style={{ background: "rgba(237,82,71,0.10)", borderColor: "rgba(237,82,71,0.20)" }}>
                          <div className="flex items-center gap-2 min-w-0">
                            <AlertTriangle size={15} className="shrink-0" style={{ color: "var(--accent-negative)" }} />
                            <p className="text-sm truncate" style={{ color: "var(--accent-negative)" }}>
                              Remove <span className="font-semibold">{row.name}</span>?
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => handleRemove(row.id)}
                              className="text-xs font-semibold text-white px-3 py-1.5 rounded-lg transition-colors"
                              style={{ background: "var(--accent-negative)" }}
                            >
                              Remove
                            </button>
                            <button
                              onClick={() => setConfirmRemoveId(null)}
                              className="text-xs font-medium hover:text-[var(--text-primary)] border px-3 py-1.5 rounded-lg transition-colors"
                              style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}
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
                            className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer hover:bg-[var(--surface-hover)] rounded-xl px-2 py-1 -mx-2 transition-colors"
                          >
                            <CoinIcon symbol={row.symbol} size={36} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{row.name}</p>
                                {row.walletChain && (
                                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}>
                                    {row.walletChain}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs truncate mt-0.5" style={{ color: "var(--text-muted)" }}>
                                {row.walletAddress ? truncAddr(row.walletAddress) : row.source}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(row.balance, row.currency ?? DEFAULT_DISPLAY_CURRENCY)}</p>
                              {row.quantity !== undefined ? (
                                <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                                  {row.quantity} {row.walletChain}
                                </p>
                              ) : row.walletChain ? (
                                /* self-custody wallet with no balance synced yet */
                                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>pending</span>
                              ) : null /* exchange account — multiple assets, no native balance */}
                              {row.lastUpdated && (
                                <p className="text-xs mt-0.5" style={{ color: "var(--text-faint)" }}>
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
                              className="shrink-0 p-2 hover:text-[var(--accent-negative)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors"
                              style={{ color: "var(--text-faint)" }}
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
          </DataCard>
        </section>
      )}

      {/* ── Activity ── */}
      <section className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest px-1" style={{ color: "var(--text-muted)" }}>Activity</p>
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
