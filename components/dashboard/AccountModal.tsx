"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  X, Search, ChevronLeft, ChevronRight, Loader2,
  Building2, Landmark, TrendingUp, Bitcoin, CreditCard, ExternalLink, Trash2,
  Pencil, Check,
} from "lucide-react";
import { Account, Holding, Transaction, TransactionCategory, AccountType } from "@/types";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { exchangeSymbol } from "@/lib/exchangeSymbol";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { OverlaySurface } from "@/components/atlas/OverlaySurface";
import { GlassButton } from "@/components/atlas/GlassButton";
import { useTheme } from "@/components/theme/ThemeProvider";

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
      <span className="text-xs font-bold text-[var(--accent-neutral)] leading-none">
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
    style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2,
  }).format(Math.abs(n));

const fmtCompact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 1,
  }).format(Math.abs(n));

// ── Category colors ───────────────────────────────────────────────────────────
const CAT_COLORS: Partial<Record<TransactionCategory, string>> = {
  Income:        "bg-emerald-500/15 text-[var(--accent-positive)]",
  Transfer:      "bg-blue-500/15 text-[var(--accent-info)]",
  Groceries:     "bg-lime-500/15 text-lime-400",
  Dining:        "bg-orange-500/15 text-orange-400",
  Shopping:      "bg-purple-500/15 text-[var(--accent-neutral)]",
  Travel:        "bg-sky-500/15 text-sky-400",
  Subscriptions: "bg-violet-500/15 text-[var(--accent-neutral)]",
  Utilities:     "bg-slate-500/15 text-slate-400",
  Interest:      "bg-teal-500/15 text-teal-400",
  Payment:       "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
  Other:         "bg-[var(--surface-inset)] text-[var(--text-muted)]",
  Buy:           "bg-emerald-500/15 text-[var(--accent-positive)]",
  Sell:          "bg-red-500/15 text-[var(--accent-negative)]",
  Dividend:      "bg-yellow-500/15 text-[var(--accent-warning)]",
  Split:         "bg-blue-500/15 text-[var(--accent-info)]",
  Fee:           "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
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
  checking:   "bg-blue-500/10 text-[var(--accent-info)]",
  savings:    "bg-emerald-500/10 text-[var(--accent-positive)]",
  investment: "bg-violet-500/10 text-[var(--accent-neutral)]",
  crypto:     "bg-yellow-500/10 text-[var(--accent-warning)]",
  debt:       "bg-red-500/10 text-[var(--accent-negative)]",
  other:      "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
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
  const router         = useRouter();
  const { resolvedTheme } = useTheme();
  const isInvestment   = account.type === "investment" || account.type === "crypto";
  const isDebt         = account.type === "debt";

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

  // Display-name rename (Goal 1) — `localName` tracks the resolved name shown
  // in the header so the UI updates instantly on save, without waiting for a
  // full router.refresh() of the parent's account list to land.
  const [localName,    setLocalName]    = useState(account.name);
  const [editingName,  setEditingName]  = useState(false);
  const [nameInput,    setNameInput]    = useState("");
  const [nameSaving,   setNameSaving]   = useState(false);
  const [nameError,    setNameError]    = useState("");
  const originalName = account.officialName ?? account.plaidName; // frozen Plaid value, for the "originally ..." hint

  useEffect(() => {
    // Resyncs the optimistic `localName` override whenever the parent passes
    // a different account (id changed) or a freshly-resolved name for the
    // same account (e.g. after router.refresh() lands) — same accepted
    // suppression already used a few lines below for the transactions-reset
    // effect, since this is the same "resync local state from props" shape.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLocalName(account.name);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [account.id, account.name]);

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

  async function handleSaveName() {
    const trimmed = nameInput.trim();
    setNameSaving(true);
    setNameError("");
    try {
      const res = await fetch(`/api/accounts/${account.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ displayName: trimmed }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setNameError(d.error ?? "Failed to rename account.");
        setNameSaving(false);
        return;
      }
      // Empty input clears the override — fall back to officialName/plaidName/name,
      // mirroring the server's resolution order so the header updates correctly.
      setLocalName(trimmed.length > 0 ? trimmed : (originalName ?? account.name));
      setEditingName(false);
      setNameSaving(false);
      router.refresh();
    } catch {
      setNameError("Network error. Please try again.");
      setNameSaving(false);
    }
  }

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
  const iconCls = TYPE_ICON_CLS[account.type as AccountType] ?? "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

  const isTxView = activeTab === "transactions" || !isInvestment;

  return (
    <OverlaySurface
      open
      intent="workspace"
      size="md"
      className="sm:max-w-2xl"
      onClose={onClose}
      closeOnBackdrop
      hideHeader
      title={localName || account.name}
      toolbar={
        <div className="space-y-3">
          {/* ── Header (title + inline rename + balance + close) ── */}
          <div className="flex items-center gap-3">
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
              {editingName ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); handleSaveName(); }}
                  className="flex items-center gap-1"
                >
                  <input
                    autoFocus
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditingName(false); setNameError(""); } }}
                    maxLength={120}
                    placeholder={originalName ?? account.name}
                    className="flex-1 min-w-0 rounded-[var(--radius-xs)] px-2 py-1 text-sm font-bold text-[var(--text-primary)] focus:outline-none"
                    style={{ background: "var(--surface-muted)", border: "1px solid var(--meridian-400)" }}
                  />
                  <button
                    type="submit"
                    disabled={nameSaving}
                    className="p-1 text-[var(--emerald-400)] hover:text-[var(--emerald-300)] disabled:opacity-50 shrink-0"
                  >
                    {nameSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingName(false); setNameError(""); }}
                    disabled={nameSaving}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0"
                  >
                    <X size={13} />
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => { setNameInput(account.displayName ?? ""); setNameError(""); setEditingName(true); }}
                  className="group flex items-center gap-1.5 max-w-full text-left"
                >
                  <p className="text-sm font-bold text-[var(--text-primary)] leading-tight truncate">{localName}</p>
                  <Pencil size={11} className="text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] shrink-0" />
                </button>
              )}
              <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5 truncate">
                {account.institution}
                {originalName && localName !== originalName && (
                  <span className="text-[var(--text-muted)]"> · originally &quot;{originalName}&quot;</span>
                )}
              </p>
              {nameError && <p className="text-xs text-[var(--coral-400)] leading-tight mt-0.5">{nameError}</p>}
            </div>
            <div className="text-right shrink-0 mr-2">
              <p className={`text-sm font-bold tabular-nums ${isDebt && account.balance > 0 ? "text-[var(--coral-400)]" : "text-[var(--text-primary)]"}`}>
                {isDebt && account.balance > 0 ? "−" : ""}{fmtCompact(account.balance)}
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">balance</p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors shrink-0"
            >
              <X size={16} />
            </button>
          </div>

          {/* ── Tab switcher (investment/crypto only) ── */}
          {isInvestment && (
            <div className="flex gap-1">
              {(["holdings", "transactions"] as ModalTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setActiveTab(t)}
                  className={`px-4 py-2 rounded-[var(--radius-full)] text-xs font-semibold border transition-all capitalize ${
                    activeTab === t
                      ? "text-[var(--meridian-400)]"
                      : "bg-transparent border-[var(--border-hairline-strong)] text-[var(--text-muted)] hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)]"
                  }`}
                  style={
                    activeTab === t
                      ? { background: "rgba(59,130,246,.14)", borderColor: "rgba(125,168,255,.32)" }
                      : undefined
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* ── Transaction filters ── */}
          {isTxView && (
            <div className="space-y-2">
              {/* Date presets */}
              <div className="flex gap-1.5 flex-wrap">
                {(["7D", "1M", "3M", "6M", "1Y", "All"] as DatePreset[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => { setDatePreset(p); resetPage(); }}
                    className={`text-xs font-semibold px-3 py-1.5 rounded-[var(--radius-full)] border transition-colors ${
                      datePreset === p
                        ? "text-[var(--meridian-400)]"
                        : "text-[var(--text-muted)] border-[var(--border-hairline-strong)] hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)]"
                    }`}
                    style={
                      datePreset === p
                        ? { background: "rgba(59,130,246,.14)", borderColor: "rgba(125,168,255,.32)" }
                        : { background: "transparent" }
                    }
                  >
                    {p}
                  </button>
                ))}
              </div>

              {/* Search */}
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search merchant…"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); resetPage(); }}
                  className="w-full rounded-[var(--radius-sm)] pl-7 pr-7 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none transition-colors"
                  style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
                />
                {search && (
                  <button
                    onClick={() => { setSearch(""); resetPage(); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
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
                  className="w-full rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none transition-colors"
                  style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
                >
                  <option value="">All categories</option>
                  {availableCategories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}

              {txs && (
                <p className="text-xs text-[var(--text-muted)]">
                  <span className="font-semibold text-[var(--text-primary)]">{filtered.length}</span> transaction{filtered.length !== 1 ? "s" : ""}
                </p>
              )}
            </div>
          )}
        </div>
      }
      footer={
        <div className="space-y-3">
          {/* Pagination */}
          {isTxView && totalPages > 1 && (
            <div className="flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="flex items-center gap-1 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <span className="text-xs text-[var(--text-muted)]">{page + 1} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page === totalPages - 1}
                className="flex items-center gap-1 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          )}

          {/* Inline remove confirmation */}
          {confirmRemove ? (
            <div
              className="rounded-[var(--radius-lg)] p-4 space-y-3"
              style={{ background: "rgba(237,82,71,.06)", border: "1px solid rgba(237,82,71,.25)" }}
            >
              <p className="text-sm font-semibold text-[var(--text-primary)]">Remove this account?</p>
              <p className="text-xs text-[var(--text-muted)]">
                {account.institution === "Self-custodied"
                  ? "This wallet will be removed from your Space. No on-chain data is affected."
                  : "This account will be disconnected. Transaction history is preserved but the account won't refresh."}
              </p>
              {removeError && <p className="text-xs text-[var(--coral-400)]">{removeError}</p>}
              <div className="flex gap-2">
                <GlassButton
                  tone="neutral"
                  fullWidth
                  onClick={() => { setConfirmRemove(false); setRemoveError(""); }}
                  disabled={removing}
                >
                  Cancel
                </GlassButton>
                <GlassButton
                  tone="danger"
                  fullWidth
                  onClick={handleRemove}
                  disabled={removing}
                >
                  {removing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  {removing ? "Removing…" : "Yes, remove"}
                </GlassButton>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <GlassButton tone="neutral" fullWidth size="md" onClick={onClose}>
                Close
              </GlassButton>
              <GlassButton tone="danger" size="md" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={14} />
                Remove
              </GlassButton>
            </div>
          )}
        </div>
      }
    >
      {/* ── Body: Holdings tab ── */}
      {activeTab === "holdings" && isInvestment && (
        <div className="space-y-1">
          {accountHoldings.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)] text-center py-10">No positions found.</p>
          ) : (
            accountHoldings.map((h) => (
              <button
                key={h.id}
                onClick={() => setChartHolding(h)}
                className="w-full flex items-center gap-3 py-3 border-b border-[var(--border-hairline)] last:border-0 hover:bg-[var(--surface-hover)] -mx-2 px-2 rounded-[var(--radius-sm)] transition-colors touch-manipulation text-left"
              >
                {/* Logo */}
                <AssetLogo symbol={h.symbol} accountType={account.type} size={36} />

                {/* Name + symbol */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold text-[var(--text-primary)] leading-tight">{h.symbol}</p>
                    <ExternalLink size={10} className="text-[var(--text-muted)]" />
                  </div>
                  <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5 truncate">{h.name}</p>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-4 shrink-0 text-right">
                  <div>
                    <p className="text-[10px] text-[var(--text-muted)] mb-0.5">Qty</p>
                    <p className="text-xs font-semibold text-[var(--text-secondary)] tabular-nums">
                      {h.quantity % 1 === 0 ? h.quantity.toFixed(0) : h.quantity.toFixed(4)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-[var(--text-muted)] mb-0.5">Price</p>
                    <p className="text-xs font-semibold text-[var(--text-secondary)] tabular-nums">{fmtCompact(h.price)}</p>
                  </div>
                  {h.change24h !== 0 && (
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] mb-0.5">24h</p>
                      <p className={`text-xs font-semibold tabular-nums ${h.change24h >= 0 ? "text-[var(--emerald-400)]" : "text-[var(--coral-400)]"}`}>
                        {h.change24h >= 0 ? "+" : ""}{h.change24h.toFixed(2)}%
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-[10px] text-[var(--text-muted)] mb-0.5">Value</p>
                    <p className="text-sm font-bold text-[var(--text-primary)] tabular-nums">{fmtCompact(h.value)}</p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {/* ── Body: Transactions tab ── */}
      {isTxView && (
        <div className="divide-y divide-[var(--border-hairline)]">
          {!txs && !loadError && (
            <div className="flex items-center justify-center py-12 gap-2 text-[var(--text-muted)]">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          )}
          {loadError && (
            <p className="text-sm text-[var(--coral-400)] text-center py-10">Failed to load transactions.</p>
          )}
          {txs && filtered.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] text-center py-10">No transactions match your filters.</p>
          )}
          {txs && pageSlice.map((tx) => <TxRow key={tx.id} tx={tx} isDebt={isDebt} />)}
        </div>
      )}

      {/* ── Nested TradingView chart overlay — preserved exactly as-is
           (fixed inset-0 resolves against the OverlaySurface GlassPanel, so it
           still covers the modal panel; z-110 keeps it above the modal). ── */}
      {chartHolding && (
        <div
          className="fixed inset-0 z-[110] flex flex-col overflow-hidden"
          style={{ background: "var(--glass-thick)", backdropFilter: "blur(30px) saturate(160%)", WebkitBackdropFilter: "blur(30px) saturate(160%)" }}
        >
          {/* Chart header */}
          <div
            className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0"
            style={{ borderBottom: "1px solid var(--border-hairline)" }}
          >
            <div>
              <p className="text-sm font-bold text-[var(--text-primary)]">{chartHolding.symbol}</p>
              <p className="text-xs text-[var(--text-muted)] truncate max-w-[200px]">{chartHolding.name}</p>
            </div>
            <button
              onClick={() => setChartHolding(null)}
              className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Position summary row */}
          <div
            className="grid grid-cols-4 divide-x divide-[var(--border-hairline)] shrink-0"
            style={{ borderBottom: "1px solid var(--border-hairline)" }}
          >
            {[
              { label: "Value",  value: fmtUSD(chartHolding.value),  cls: "text-[var(--text-primary)]" },
              { label: "Price",  value: fmtUSD(chartHolding.price),  cls: "text-[var(--text-primary)]" },
              {
                label: "Qty",
                value: chartHolding.quantity % 1 === 0
                  ? chartHolding.quantity.toFixed(0)
                  : chartHolding.quantity.toFixed(4),
                cls: "text-[var(--text-primary)]",
              },
              {
                label: "24h",
                value: chartHolding.change24h !== 0
                  ? `${chartHolding.change24h >= 0 ? "+" : ""}${chartHolding.change24h.toFixed(2)}%`
                  : "—",
                cls: chartHolding.change24h > 0
                  ? "text-[var(--emerald-400)]"
                  : chartHolding.change24h < 0
                    ? "text-[var(--coral-400)]"
                    : "text-[var(--text-muted)]",
              },
            ].map(({ label, value, cls }) => (
              <div key={label} className="flex flex-col items-center justify-center py-3 px-2">
                <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1">{label}</p>
                <p className={`text-sm font-bold tabular-nums ${cls}`}>{value}</p>
              </div>
            ))}
          </div>

          {/* TradingView iframe — theme param tracks the app's own
              Midnight/Light Glass mode (resolvedTheme) instead of a
              hardcoded "dark", so the embedded widget doesn't clash with
              Light Glass. */}
          <div className="flex-1 min-h-0">
            <iframe
              key={`${chartHolding.symbol}-${resolvedTheme}`}
              src={`https://www.tradingview.com/widgetembed/?symbol=${encodeURIComponent(toTVSymbol(chartHolding.symbol, account.type))}&interval=D&theme=${resolvedTheme}&locale=en&style=1&hidesidetoolbar=0&withdateranges=1&saveimage=0&toolbarbg=${resolvedTheme === "light" ? "ffffff" : "1e2130"}`}
              className="w-full h-full border-0"
              allow="clipboard-write"
              title={`${chartHolding.symbol} chart`}
            />
          </div>

          {/* Back button */}
          <div className="px-5 pb-5 pt-2 shrink-0">
            <GlassButton tone="neutral" fullWidth onClick={() => setChartHolding(null)}>
              ← Back to Holdings
            </GlassButton>
          </div>
        </div>
      )}
    </OverlaySurface>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
function TxRow({ tx, isDebt }: { tx: Transaction; isDebt: boolean }) {
  // For debt accounts: spending is positive (you owe more) → show as negative/red
  // amount > 0 = credit (money in / payment received)  → green
  // amount < 0 = debit (money out / charge)             → white
  const isInvestmentTx = ["Buy","Sell","Dividend","Split","Fee"].includes(tx.category);
  const isCredit = isDebt ? tx.amount > 0 : tx.amount > 0;
  const catCls   = CAT_COLORS[tx.category] ?? "bg-[var(--surface-inset)] text-[var(--text-muted)]";
  const dateObj  = new Date(tx.date + "T12:00:00");

  // Investment transactions use merchant as ticker
  const primaryLabel   = tx.merchant;
  const secondaryLabel = tx.description && tx.description !== tx.merchant ? tx.description : null;

  return (
    <div className="flex items-center gap-3 py-3 hover:bg-[var(--surface-hover)] transition-colors">
      {/* Date */}
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold text-[var(--text-secondary)] leading-none">
          {dateObj.toLocaleDateString("en-US", { day: "numeric" })}
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          {dateObj.toLocaleDateString("en-US", { month: "short" })}
        </p>
      </div>

      {/* Description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-[var(--text-primary)] truncate leading-tight">{primaryLabel}</p>
          {tx.pending && (
            <span className="text-xs bg-yellow-500/15 text-[var(--accent-warning)] px-1.5 py-0.5 rounded-full shrink-0">
              Pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${catCls}`}>{tx.category}</span>
          {secondaryLabel && (
            <span className="text-xs text-[var(--text-muted)] truncate">{secondaryLabel}</span>
          )}
        </div>
      </div>

      {/* Amount */}
      <div className="shrink-0 text-right">
        <p className={`text-sm font-bold tabular-nums ${
          isInvestmentTx
            ? tx.amount < 0 ? "text-[var(--coral-400)]" : "text-[var(--emerald-400)]"
            : isCredit ? "text-[var(--emerald-400)]" : "text-[var(--text-primary)]"
        }`}>
          {isCredit ? "+" : "−"}{fmtUSD(tx.amount)}
        </p>
      </div>
    </div>
  );
}
