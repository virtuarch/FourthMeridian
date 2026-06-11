"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  X, Search, ChevronLeft, ChevronRight, Loader2,
  Building2, Landmark, TrendingUp, Bitcoin, CreditCard, ExternalLink, Trash2,
} from "lucide-react";
import { Account, Holding, Transaction, TransactionCategory, AccountType } from "@/types";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { exchangeSymbol } from "@/lib/exchangeSymbol";

// ── Stock / crypto logo ───────────────────────────────────────────────────────
function AssetLogo({
  symbol,
  accountType,
  size = 36,
}: {
  symbol: string;
  accountType: AccountType;
  size?: number;
}) {
  const [err, setErr] = useState(false);
  const isCrypto = accountType === "crypto";
  const coinSymbol = symbol.toUpperCase().replace("USD", "");

  if (isCrypto) return <CoinIcon symbol={coinSymbol} size={size} />;

  return err ? (
    // Fallback: coloured letter badge
    <div
      style={{ width: size, height: size }}
      className="rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center shrink-0"
    >
      <span className="text-xs font-bold text-violet-400 leading-none">
        {symbol.slice(0, 2).toUpperCase()}
      </span>
    </div>
  ) : (
    <img
      src={`https://assets.parqet.com/logos/symbol/${symbol.toUpperCase()}?format=png`}
      alt={symbol}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="rounded-xl object-contain bg-white/5 shrink-0"
      onError={() => setErr(true)}
    />
  );
}

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 2,
  }).format(Math.abs(n));

const fmtCompact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  }).format(Math.abs(n));

// ── Category colors ───────────────────────────────────────────────────────────
const CAT_COLORS: Partial<Record<TransactionCategory, string>> = {
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
  Buy:           "bg-emerald-500/15 text-emerald-400",
  Sell:          "bg-red-500/15 text-red-400",
  Dividend:      "bg-yellow-500/15 text-yellow-400",
  Split:         "bg-blue-500/15 text-blue-400",
  Fee:           "bg-gray-500/15 text-gray-400",
};

// ── Account type icons ────────────────────────────────────────────────────────
const TYPE_ICON: Record<AccountType, React.ElementType> = {
  checking:   Building2,
  savings:    Landmark,
  investment: TrendingUp,
  crypto:     Bitcoin,
  debt:       CreditCard,
  other:      Building2,
};

const TYPE_ICON_CLS: Record<AccountType, string> = {
  checking:   "bg-blue-500/10 text-blue-400",
  savings:    "bg-emerald-500/10 text-emerald-400",
  investment: "bg-violet-500/10 text-violet-400",
  crypto:     "bg-yellow-500/10 text-yellow-400",
  debt:       "bg-red-500/10 text-red-400",
  other:      "bg-gray-500/10 text-gray-400",
};

const PAGE_SIZE = 10;

type ModalTab = "transactions" | "holdings";

// ── Date preset helpers ───────────────────────────────────────────────────────
type DatePreset = "7D" | "1M" | "3M" | "6M" | "1Y" | "All";

function presetCutoff(preset: DatePreset): string {
  if (preset === "All") return "";
  const d = new Date();
  if (preset === "7D") d.setDate(d.getDate() - 7);
  if (preset === "1M") d.setMonth(d.getMonth() - 1);
  if (preset === "3M") d.setMonth(d.getMonth() - 3);
  if (preset === "6M") d.setMonth(d.getMonth() - 6);
  if (preset === "1Y") d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

// ── TradingView symbol helper ─────────────────────────────────────────────────
const CRYPTO_TICKERS = new Set([
  "BTC","ETH","SOL","BNB","ADA","XRP","DOGE","MATIC","AVAX","LINK",
  "DOT","LTC","BCH","ALGO","XLM","ATOM","FIL","TRX","EOS","XTZ","UNI",
  "AAVE","CRV","MKR","SNX","COMP","YFI","SUSHI","BAL","1INCH",
]);

function toTVSymbol(symbol: string, accountType: AccountType): string {
  const s = symbol.toUpperCase();
  if (accountType === "crypto" || CRYPTO_TICKERS.has(s)) return `${s}USD`;
  return s;
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  account:  Account;
  holdings: Holding[]; // all app holdings — modal filters to this account
  onClose:  () => void;
  onRemove?: () => void; // called after successful account deletion
}

// ── Main component ────────────────────────────────────────────────────────────
export function AccountModal({ account, holdings, onClose, onRemove }: Props) {
  const router       = useRouter();
  const isInvestment = account.type === "investment" || account.type === "crypto";
  const isDebt       = account.type === "debt";

  const [activeTab,       setActiveTab]       = useState<ModalTab>("holdings");
  const [confirmRemove,   setConfirmRemove]   = useState(false);
  const [removing,        setRemoving]        = useState(false);
  const [removeError,     setRemoveError]     = useState("");
  const [txs,             setTxs]             = useState<Transaction[] | null>(null);
  const [loadError,       setLoadError]       = useState(false);
  const [search,          setSearch]          = useState("");
  const [catFilter,       setCatFilter]       = useState<TransactionCategory | null>(null);
  const [datePreset,      setDatePreset]      = useState<DatePreset>("All");
  const [page,            setPage]            = useState(0);
  const [chartHolding,    setChartHolding]    = useState<Holding | null>(null);

  // Account-level holdings
  const accountHoldings = useMemo(
    () => holdings.filter((h) => h.accountId === account.id && !h.isCash)
                  .sort((a, b) => b.value - a.value),
    [holdings, account.id]
  );

  // Lazy-fetch transactions
  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect */
    setTxs(null);
    setLoadError(false);
    /* eslint-enable react-hooks/set-state-in-effect */

    fetch(`/api/accounts/${account.id}/transactions`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setTxs(data.transactions ?? []);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    return () => { cancelled = true; };
  }, [account.id]);

  // Derive available categories from fetched transactions
  const availableCategories = useMemo(() => {
    if (!txs) return [];
    const seen = new Set<TransactionCategory>();
    txs.forEach((t) => seen.add(t.category));
    return Array.from(seen).sort();
  }, [txs]);

  // Apply filters
  const filtered = useMemo(() => {
    if (!txs) return [];
    const cutoff = presetCutoff(datePreset);
    return txs.filter((t) => {
      if (cutoff && t.date < cutoff) return false;
      if (catFilter && t.category !== catFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !t.merchant.toLowerCase().includes(q) &&
          !(t.description ?? "").toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [txs, datePreset, catFilter, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageSlice  = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset to page 0 on any filter change
  function resetPage() { setPage(0); }

  async function handleRemove() {
    setRemoving(true);
    setRemoveError("");
    try {
      const res = await fetch(`/api/accounts/${account.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setRemoveError(d.error ?? "Failed to remove account.");
        setRemoving(false);
        return;
      }
      onRemove?.();
      onClose();
      router.refresh();
    } catch {
      setRemoveError("Network error. Please try again.");
      setRemoving(false);
    }
  }

  const Icon    = TYPE_ICON[account.type as AccountType] ?? Building2;
  const iconCls = TYPE_ICON_CLS[account.type as AccountType] ?? "bg-gray-500/10 text-gray-400";

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pt-4 pb-40 sm:p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-gray-900 border border-gray-700 rounded-3xl w-full sm:max-w-2xl max-h-[calc(100dvh-180px)] sm:max-h-[85vh] flex flex-col shadow-2xl">

        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-gray-800 shrink-0">
          {account.type === "crypto" ? (
            <CoinIcon
              symbol={account.walletChain ?? exchangeSymbol(account.institution)}
              size={36}
            />
          ) : (
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${iconCls}`}>
              <Icon size={16} />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white leading-tight truncate">{account.name}</p>
            <p className="text-xs text-gray-500 leading-tight mt-0.5">{account.institution}</p>
          </div>
          <div className="text-right shrink-0 mr-2">
            <p className={`text-sm font-bold tabular-nums ${isDebt && account.balance > 0 ? "text-red-400" : "text-white"}`}>
              {isDebt && account.balance > 0 ? "−" : ""}{fmtCompact(account.balance)}
            </p>
            <p className="text-xs text-gray-600 mt-0.5">balance</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-xl transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Tab switcher (investment/crypto only) ── */}
        {isInvestment && (
          <div className="flex px-5 pt-3 pb-0 gap-1 shrink-0">
            {(["holdings", "transactions"] as ModalTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-4 py-2 rounded-full text-xs font-semibold border transition-all capitalize ${
                  activeTab === t
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-transparent border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {/* ── Holdings tab ── */}
        {activeTab === "holdings" && isInvestment && (
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-1">
            {accountHoldings.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-10">No positions found.</p>
            ) : (
              accountHoldings.map((h) => (
                <button
                  key={h.id}
                  onClick={() => setChartHolding(h)}
                  className="w-full flex items-center gap-3 py-3 border-b border-gray-800/60 last:border-0 hover:bg-gray-800/40 -mx-2 px-2 rounded-xl transition-colors touch-manipulation text-left"
                >
                  {/* Logo */}
                  <AssetLogo symbol={h.symbol} accountType={account.type} size={36} />

                  {/* Name + symbol */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-white leading-tight">{h.symbol}</p>
                      <ExternalLink size={10} className="text-gray-600" />
                    </div>
                    <p className="text-xs text-gray-500 leading-tight mt-0.5 truncate">{h.name}</p>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-4 shrink-0 text-right">
                    <div>
                      <p className="text-[10px] text-gray-600 mb-0.5">Qty</p>
                      <p className="text-xs font-semibold text-gray-300 tabular-nums">
                        {h.quantity % 1 === 0 ? h.quantity.toFixed(0) : h.quantity.toFixed(4)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-600 mb-0.5">Price</p>
                      <p className="text-xs font-semibold text-gray-300 tabular-nums">{fmtCompact(h.price)}</p>
                    </div>
                    {h.change24h !== 0 && (
                      <div>
                        <p className="text-[10px] text-gray-600 mb-0.5">24h</p>
                        <p className={`text-xs font-semibold tabular-nums ${h.change24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {h.change24h >= 0 ? "+" : ""}{h.change24h.toFixed(2)}%
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] text-gray-600 mb-0.5">Value</p>
                      <p className="text-sm font-bold text-white tabular-nums">{fmtCompact(h.value)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}

        {/* ── TradingView chart overlay ── */}
        {chartHolding && (
          <div className="fixed inset-0 z-[110] bg-gray-900 flex flex-col overflow-hidden">
            {/* Chart header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-800 shrink-0">
              <div>
                <p className="text-sm font-bold text-white">{chartHolding.symbol}</p>
                <p className="text-xs text-gray-500 truncate max-w-[200px]">{chartHolding.name}</p>
              </div>
              <button
                onClick={() => setChartHolding(null)}
                className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Position summary row */}
            <div className="grid grid-cols-4 divide-x divide-gray-800 border-b border-gray-800 shrink-0">
              {[
                { label: "Value",  value: fmtUSD(chartHolding.value),  cls: "text-white" },
                { label: "Price",  value: fmtUSD(chartHolding.price),  cls: "text-white" },
                {
                  label: "Qty",
                  value: chartHolding.quantity % 1 === 0
                    ? chartHolding.quantity.toFixed(0)
                    : chartHolding.quantity.toFixed(4),
                  cls: "text-white",
                },
                {
                  label: "24h",
                  value: chartHolding.change24h !== 0
                    ? `${chartHolding.change24h >= 0 ? "+" : ""}${chartHolding.change24h.toFixed(2)}%`
                    : "—",
                  cls: chartHolding.change24h > 0
                    ? "text-emerald-400"
                    : chartHolding.change24h < 0
                      ? "text-red-400"
                      : "text-gray-500",
                },
              ].map(({ label, value, cls }) => (
                <div key={label} className="flex flex-col items-center justify-center py-3 px-2">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
                  <p className={`text-sm font-bold tabular-nums ${cls}`}>{value}</p>
                </div>
              ))}
            </div>

            {/* TradingView iframe */}
            <div className="flex-1 min-h-0">
              <iframe
                key={chartHolding.symbol}
                src={`https://www.tradingview.com/widgetembed/?symbol=${encodeURIComponent(toTVSymbol(chartHolding.symbol, account.type))}&interval=D&theme=dark&locale=en&style=1&hidesidetoolbar=0&withdateranges=1&saveimage=0&toolbarbg=1e2130`}
                className="w-full h-full border-0"
                allow="clipboard-write"
                title={`${chartHolding.symbol} chart`}
              />
            </div>

            {/* Back button */}
            <div className="px-5 pb-5 pt-2 shrink-0">
              <button
                onClick={() => setChartHolding(null)}
                className="w-full py-3 rounded-2xl text-sm font-semibold text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors"
              >
                ← Back to Holdings
              </button>
            </div>
          </div>
        )}

        {/* ── Transactions tab ── */}
        {(activeTab === "transactions" || !isInvestment) && (
          <>
            {/* Filters */}
            <div className="px-4 pt-2.5 pb-2 border-b border-gray-800 space-y-2 shrink-0">
              {/* Date presets */}
              <div className="flex gap-1.5 flex-wrap">
                {(["7D", "1M", "3M", "6M", "1Y", "All"] as DatePreset[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => { setDatePreset(p); resetPage(); }}
                    className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                      datePreset === p
                        ? "bg-blue-600 border-blue-500 text-white"
                        : "bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>

              {/* Search */}
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search merchant…"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); resetPage(); }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl pl-7 pr-7 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
                {search && (
                  <button
                    onClick={() => { setSearch(""); resetPage(); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              {/* Category dropdown */}
              {availableCategories.length > 1 && (
                <select
                  value={catFilter ?? ""}
                  onChange={(e) => { setCatFilter((e.target.value as TransactionCategory) || null); resetPage(); }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                >
                  <option value="">All categories</option>
                  {availableCategories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}

              {txs && (
                <p className="text-xs text-gray-500">
                  <span className="font-semibold text-white">{filtered.length}</span> transaction{filtered.length !== 1 ? "s" : ""}
                </p>
              )}
            </div>

            {/* Transaction list */}
            <div className="overflow-y-auto flex-1 divide-y divide-gray-800/40 pt-1">
              {!txs && !loadError && (
                <div className="flex items-center justify-center py-12 gap-2 text-gray-500">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-sm">Loading…</span>
                </div>
              )}
              {loadError && (
                <p className="text-sm text-red-400 text-center py-10">Failed to load transactions.</p>
              )}
              {txs && filtered.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-10">No transactions match your filters.</p>
              )}
              {txs && pageSlice.map((tx) => <TxRow key={tx.id} tx={tx} isDebt={isDebt} />)}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800 shrink-0">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={14} /> Prev
                </button>
                <span className="text-xs text-gray-500">{page + 1} / {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page === totalPages - 1}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            )}
          </>
        )}

        {/* Footer — Close + Remove */}
        <div className="px-5 pb-5 pt-2 shrink-0 space-y-2">
          {/* Inline remove confirmation */}
          {confirmRemove ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 space-y-3">
              <p className="text-sm font-semibold text-white">Remove this account?</p>
              <p className="text-xs text-gray-400">
                {account.institution === "Self-custodied"
                  ? "This wallet will be removed from your workspace. No on-chain data is affected."
                  : "This account will be disconnected. Transaction history is preserved but the account won't refresh."}
              </p>
              {removeError && <p className="text-xs text-red-400">{removeError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => { setConfirmRemove(false); setRemoveError(""); }}
                  disabled={removing}
                  className="flex-1 py-2 rounded-xl text-sm font-medium text-gray-400 border border-gray-700 hover:border-gray-500 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRemove}
                  disabled={removing}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-colors"
                >
                  {removing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  {removing ? "Removing…" : "Yes, remove"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 py-3 rounded-2xl text-sm font-semibold text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => setConfirmRemove(true)}
                className="flex items-center gap-1.5 px-4 py-3 rounded-2xl text-sm font-semibold text-red-400 hover:text-white hover:bg-red-500/15 border border-red-500/20 hover:border-red-500/40 transition-colors"
              >
                <Trash2 size={14} />
                Remove
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
function TxRow({ tx, isDebt }: { tx: Transaction; isDebt: boolean }) {
  // For debt accounts: spending is positive (you owe more) → show as negative/red
  // amount > 0 = credit (money in / payment received)  → green
  // amount < 0 = debit (money out / charge)             → white
  const isInvestmentTx = ["Buy","Sell","Dividend","Split","Fee"].includes(tx.category);
  const isCredit = isDebt ? tx.amount > 0 : tx.amount > 0;
  const catCls   = CAT_COLORS[tx.category] ?? "bg-gray-600/15 text-gray-500";
  const dateObj  = new Date(tx.date + "T12:00:00");

  // Investment transactions use merchant as ticker
  const primaryLabel   = tx.merchant;
  const secondaryLabel = tx.description && tx.description !== tx.merchant ? tx.description : null;

  return (
    <div className="flex items-center gap-3 px-5 py-3 hover:bg-gray-800/40 transition-colors">
      {/* Date */}
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold text-gray-300 leading-none">
          {dateObj.toLocaleDateString("en-US", { day: "numeric" })}
        </p>
        <p className="text-xs text-gray-600 mt-0.5">
          {dateObj.toLocaleDateString("en-US", { month: "short" })}
        </p>
      </div>

      {/* Description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-white truncate leading-tight">{primaryLabel}</p>
          {tx.pending && (
            <span className="text-xs bg-yellow-500/15 text-yellow-400 px-1.5 py-0.5 rounded-full shrink-0">
              Pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${catCls}`}>{tx.category}</span>
          {secondaryLabel && (
            <span className="text-xs text-gray-600 truncate">{secondaryLabel}</span>
          )}
        </div>
      </div>

      {/* Amount */}
      <div className="shrink-0 text-right">
        <p className={`text-sm font-bold tabular-nums ${
          isInvestmentTx
            ? tx.amount < 0 ? "text-red-400" : "text-emerald-400"
            : isCredit ? "text-emerald-400" : "text-white"
        }`}>
          {isCredit ? "+" : "−"}{fmtUSD(tx.amount)}
        </p>
      </div>
    </div>
  );
}
