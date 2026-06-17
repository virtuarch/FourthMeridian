"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { NetWorthCard } from "./NetWorthCard";
import { CashOnHandCard } from "./CashOnHandCard";
import { FicoCard } from "./FicoCard";
import { NetWorthChart, Interval, cutoffForInterval } from "@/components/charts/NetWorthChart";
import { CashChart } from "@/components/charts/CashChart";
import { BankingChart } from "@/components/charts/BankingChart";
import { NetWorthChartModal } from "@/components/charts/NetWorthChartModal";
import { AllocationChart } from "@/components/charts/AllocationChart";
import { Account, Holding, Snapshot, AiAdvice, Transaction } from "@/types";
import {
  ChevronDown,
  ChevronUp,
  Building2,
  Landmark,
  CreditCard,
  Bitcoin,
  TrendingUp,
  Maximize2,
  LayoutDashboard,
  Wallet,
  Pencil,
  Check,
  Loader2,
  Trash2,
  Target,
  Clock,
  Settings,
  FolderOpen,
  ArrowUpRight,
} from "lucide-react";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { DebtCard }  from "@/components/dashboard/DebtCard";
import { InvestmentsCard } from "@/components/dashboard/InvestmentsCard";
import { InvestmentsChart } from "@/components/charts/InvestmentsChart";
import { HoldingsDonutChart } from "@/components/charts/HoldingsDonutChart";
import { AccountModal } from "@/components/dashboard/AccountModal";
import { DebtClient } from "@/components/dashboard/DebtClient";
import { ConnectAccountButton } from "@/components/dashboard/ConnectAccountButton";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import { AddManualAssetModal } from "@/components/dashboard/AddManualAssetModal";
import { exchangeSymbol } from "@/lib/exchangeSymbol";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate } from "@/lib/format";
import { classifyAccounts } from "@/lib/account-classifier";

// ── Types ─────────────────────────────────────────────────────────────────────
type PersonalTab =
  | "dashboard"
  | "banking"
  | "investments"
  | "credit"
  | "goals"
  | "activity"
  | "settings";

interface Props {
  accounts:          Account[];
  holdings:          Holding[];
  snapshots:         Snapshot[];
  advice:            AiAdvice | null;
  ficoScore:         number | null;
  ficoUpdatedAt:     string | null;
  debtTransactions:  Transaction[];
}

// ── Tab config ────────────────────────────────────────────────────────────────
const PERSONAL_TABS: { key: PersonalTab; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard",   label: "Dashboard",   icon: <LayoutDashboard size={14} /> },
  { key: "banking",     label: "Banking",     icon: <Building2        size={14} /> },
  { key: "investments", label: "Investments", icon: <TrendingUp       size={14} /> },
  { key: "credit",      label: "Credit",      icon: <CreditCard       size={14} /> },
  { key: "goals",       label: "Goals",       icon: <Target           size={14} /> },
  { key: "activity",    label: "Activity",    icon: <Clock            size={14} /> },
  { key: "settings",    label: "Settings",    icon: <Settings         size={14} /> },
];

// ── Filter config ─────────────────────────────────────────────────────────────
const ACCOUNT_TYPES: Record<PersonalTab, string[]> = {
  dashboard:   ["checking", "savings", "investment", "crypto", "debt", "other"],
  banking:     ["checking", "savings", "debt"],
  investments: ["investment", "crypto"],
  credit:      ["debt"],
  goals:       [],
  activity:    [],
  settings:    [],
};

const SECTION_ORDER = [
  { label: "Checking",    type: "checking"   },
  { label: "Savings",     type: "savings"    },
  { label: "Investments", type: "investment" },
  { label: "Crypto",      type: "crypto"     },
  { label: "Debt",        type: "debt"       },
  { label: "Assets",      type: "other"      },
] as const;

// ── Per-type visual config ────────────────────────────────────────────────────
type AccountType = "checking" | "savings" | "investment" | "crypto" | "debt" | "other";

const TYPE_ICON: Record<AccountType, React.ElementType> = {
  checking:   Building2,
  savings:    Landmark,
  investment: TrendingUp,
  crypto:     Bitcoin,
  debt:       CreditCard,
  other:      Wallet,
};

const TYPE_ICON_CLS: Record<AccountType, string> = {
  checking:   "bg-blue-500/10 text-blue-400",
  savings:    "bg-emerald-500/10 text-emerald-400",
  investment: "bg-violet-500/10 text-violet-400",
  crypto:     "bg-yellow-500/10 text-yellow-400",
  debt:       "bg-red-500/10 text-red-400",
  other:      "bg-teal-500/10 text-teal-400",
};

// ── Section card wrapper ──────────────────────────────────────────────────────
function PersonalSectionCard({
  title,
  children,
  rightSlot,
  fill,
}: {
  title:      string;
  children:   React.ReactNode;
  rightSlot?: React.ReactNode;
  fill?:      boolean;
}) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden${fill ? " flex flex-col h-full" : ""}`}>
      <div className="flex items-center justify-between px-4 pt-3.5 pb-0 shrink-0">
        <p className="text-sm font-semibold text-white">{title}</p>
        {rightSlot}
      </div>
      <div className={`px-4 pb-4 pt-2${fill ? " flex-1 flex flex-col min-h-0" : ""}`}>
        {children}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtAbs = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2,
  }).format(Math.abs(n));

function formatFicoDate(iso: string | null): string {
  if (!iso) return "Never";
  return formatDate(iso);
}

// ── Component ─────────────────────────────────────────────────────────────────
export function DashboardClient({
  accounts, holdings, snapshots, ficoScore, ficoUpdatedAt, debtTransactions,
}: Props) {
  const router        = useRouter();
  const searchParams  = useSearchParams();
  const { data: session } = useSession();
  const firstName = session?.user?.name?.split(" ")[0] ?? "";
  const [walletOpen,      setWalletOpen]      = useState(false);
  const [assetOpen,       setAssetOpen]       = useState(false);
  const [manageOpen,      setManageOpen]      = useState(false);
  const [editingAssetId,  setEditingAssetId]  = useState<string | null>(null);
  const [editingAssetVal, setEditingAssetVal] = useState("");
  const [savingAsset,     setSavingAsset]     = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingAsset,   setDeletingAsset]   = useState(false);

  const VALID_TABS: PersonalTab[] = ["dashboard", "banking", "investments", "credit", "goals", "activity", "settings"];
  const initialTab = (searchParams.get("tab") ?? "dashboard") as PersonalTab;

  const [filter, setFilter] = useState<PersonalTab>(
    VALID_TABS.includes(initialTab) ? initialTab : "dashboard"
  );
  const [chartInterval, setChartInterval] = useState<Interval>("1M");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const handleFilterChange = useCallback((f: PersonalTab) => {
    setFilter(f);
    router.replace(`/dashboard?tab=${f}`, { scroll: false });
  }, [router]);

  const [sectionCollapsed, setSectionCollapsed] = useState<Record<string, boolean>>(() => ({
    ...Object.fromEntries(SECTION_ORDER.map(({ type }) => [type, true])),
    investable: true,
  }));

  const toggleSection = useCallback((type: string) => {
    setSectionCollapsed((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  const saveAssetBalance = useCallback(async (accountId: string) => {
    const parsed = parseFloat(editingAssetVal.replace(/,/g, ""));
    if (isNaN(parsed) || parsed < 0) return;
    setSavingAsset(true);
    try {
      const res = await fetch(`/api/accounts/manual/${accountId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ balance: parsed }),
      });
      if (res.ok) {
        setEditingAssetId(null);
        setEditingAssetVal("");
        router.refresh();
      }
    } finally {
      setSavingAsset(false);
    }
  }, [editingAssetVal, router]);

  const deleteAsset = useCallback(async (accountId: string) => {
    setDeletingAsset(true);
    try {
      const res = await fetch(`/api/accounts/manual/${accountId}`, { method: "DELETE" });
      if (res.ok) {
        setConfirmDeleteId(null);
        router.refresh();
      }
    } finally {
      setDeletingAsset(false);
    }
  }, [router]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const allowedTypes = ACCOUNT_TYPES[filter];

  const filtered = useMemo(
    () => accounts.filter((a) => allowedTypes.includes(a.type)),
    [accounts, allowedTypes]
  );

  // Full-portfolio classification (all accounts, for allocation donut + cash/investment totals)
  const classification = useMemo(() => classifyAccounts(accounts), [accounts]);

  // Tab-scoped classification (filtered accounts, for NetWorthCard headline stats)
  const tabClassification = useMemo(() => classifyAccounts(filtered), [filtered]);

  const stats = useMemo(() => ({
    netWorth: tabClassification.netWorth,
    assets:   tabClassification.totalInvestments + tabClassification.totalDigitalAssets,
    debt:     tabClassification.totalLiabilities,
  }), [tabClassification]);

  const allocation = {
    cash:        classification.totalLiquid,
    investments: classification.totalInvestments,
    crypto:      classification.totalDigitalAssets,
    debt:        classification.totalLiabilities,
    realAssets:  classification.totalRealAssets,
  };

  const latest = snapshots[snapshots.length - 1];

  const changeForInterval = useMemo(() => {
    if (!latest) return 0;
    const cutoff = cutoffForInterval(chartInterval);
    const snap = snapshots.find((s) => s.date >= cutoff) ?? snapshots[0];
    return snap ? latest.netWorth - snap.netWorth : 0;
  }, [snapshots, latest, chartInterval]);

  const investmentsChangeForInterval = useMemo(() => {
    if (!latest) return 0;
    const cutoff = cutoffForInterval(chartInterval);
    const snap = snapshots.find((s) => s.date >= cutoff) ?? snapshots[0];
    if (!snap) return 0;
    return (latest.totalInvestments + latest.totalCrypto) - (snap.totalInvestments + snap.totalCrypto);
  }, [snapshots, latest, chartInterval]);

  const cashChecking = classification.totalChecking;
  const cashSavings  = classification.totalSavings;

  // Checking + savings accounts, for the Cash on Hand card's per-account rows.
  const cashAccounts = useMemo(
    () => accounts.filter((a) => a.type === "checking" || a.type === "savings"),
    [accounts]
  );

  const investmentCash = useMemo(() => {
    const ids = new Set(classification.investments.map((a) => a.id));
    return holdings.filter((h) => h.isCash && ids.has(h.accountId)).reduce((s, h) => s + h.value, 0);
  }, [classification.investments, holdings]);

  const cryptoCash = useMemo(() => {
    const ids = new Set(classification.digitalAssets.map((a) => a.id));
    return holdings.filter((h) => h.isCash && ids.has(h.accountId)).reduce((s, h) => s + h.value, 0);
  }, [classification.digitalAssets, holdings]);

  const investableAccountCash = investmentCash + cryptoCash;

  const investableAccounts = useMemo(() => {
    const candidates = [...classification.investments, ...classification.digitalAssets];
    return candidates
      .map((a) => ({
        account:     a,
        cashAmount:  holdings.filter((h) => h.isCash && h.accountId === a.id).reduce((s, h) => s + h.value, 0),
      }))
      .filter(({ cashAmount }) => cashAmount > 0)
      .sort((a, b) => b.cashAmount - a.cashAmount);
  }, [classification.investments, classification.digitalAssets, holdings]);

  const newestAccountDate = accounts.length
    ? accounts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accounts[0].lastUpdated)
    : null;
  const fmtAccountDate = newestAccountDate ? formatDate(newestAccountDate) : undefined;

  const isBanking     = filter === "banking";
  const isInvestments = filter === "investments";
  const isCredit      = filter === "credit";
  const isGoals       = filter === "goals";
  const isActivity    = filter === "activity";
  const isSettings    = filter === "settings";

  const isStaticTab = isGoals || isActivity || isSettings;

  // ── Account section rows (shared across tabs) ─────────────────────────────
  const accountSections = (
    <div className="space-y-3">
      {SECTION_ORDER.filter(({ type }) => allowedTypes.includes(type)).map(({ label, type }) => {
        const accts   = filtered.filter((a) => a.type === type).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
        const isEmpty = accts.length === 0;
        const isOpen  = !sectionCollapsed[type];
        const isDebt  = type === "debt";
        const Icon    = TYPE_ICON[type as AccountType] ?? Building2;
        const iconCls = TYPE_ICON_CLS[type as AccountType] ?? "bg-gray-500/10 text-gray-400";

        const sectionTotal = accts.reduce((s, a) => s + a.balance, 0);
        const newestSync   = !isEmpty
          ? accts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accts[0].lastUpdated)
          : null;

        return (
          <div
            key={type}
            className="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden"
          >
            {/*
              Section header — a <div> rather than <button> so we can embed
              a real <button> (Add Asset) without violating the HTML spec
              (button-in-button is invalid). Role + keyboard handler preserves
              full keyboard accessibility for the expand/collapse action.
            */}
            <div
              role={isEmpty ? undefined : "button"}
              tabIndex={isEmpty ? undefined : 0}
              onClick={() => !isEmpty && toggleSection(type)}
              onKeyDown={(e) => {
                if (!isEmpty && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  toggleSection(type);
                }
              }}
              className={`w-full flex items-center justify-between px-4 py-3.5 transition-colors touch-manipulation select-none ${
                isEmpty
                  ? "cursor-default"
                  : "hover:bg-gray-800/70 active:bg-gray-800 cursor-pointer"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${iconCls}`}>
                  <Icon size={15} />
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-white leading-tight">{label}</p>
                  <p className="text-xs text-gray-500 leading-tight mt-0.5">
                    {isEmpty
                      ? "No accounts linked yet"
                      : `${accts.length} account${accts.length !== 1 ? "s" : ""} · Updated ${formatDate(newestSync!)}`
                    }
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {!isEmpty && (
                  <p className={`text-sm font-semibold tabular-nums ${
                    isDebt
                      ? sectionTotal > 0 ? "text-red-400" : "text-emerald-400"
                      : "text-white"
                  }`}>
                    {fmtAbs(Math.abs(sectionTotal))}
                  </p>
                )}
                {/* Real <button> — valid here because the parent is a <div>, not a <button> */}
                {type === "other" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setAssetOpen(true); }}
                    className="text-[11px] font-semibold text-teal-400 hover:text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/20 hover:border-teal-500/40 px-2 py-1 rounded-lg transition-colors leading-none"
                  >
                    + Add
                  </button>
                )}
                {!isEmpty && (
                  isOpen
                    ? <ChevronUp   size={16} className="text-gray-500 shrink-0" />
                    : <ChevronDown size={16} className="text-gray-500 shrink-0" />
                )}
              </div>
            </div>

            {isEmpty && (
              <div className="border-t border-gray-800/60 px-4 py-3 flex flex-wrap items-center gap-2">
                {type !== "other" && <ConnectAccountButton />}
                {type === "crypto" && (
                  <button
                    onClick={() => setWalletOpen(true)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 px-3 py-2 rounded-xl transition-colors"
                  >
                    + Add Wallet
                  </button>
                )}
                {type === "other" && (
                  <button
                    onClick={() => setAssetOpen(true)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/30 hover:border-teal-500/50 px-3 py-2 rounded-xl transition-colors"
                  >
                    + Add Asset
                  </button>
                )}
              </div>
            )}

            {!isEmpty && (
              <div
                style={{
                  display:          "grid",
                  gridTemplateRows: isOpen ? "1fr" : "0fr",
                  transition:       "grid-template-rows 0.2s ease",
                }}
              >
                <div className="overflow-hidden" style={{ minHeight: 0 }}>
                  <div className="border-t border-gray-700/60 bg-gray-950/60">
                    {accts.map((a, idx) => {
                      const coinSymbol  = a.walletChain ?? exchangeSymbol(a.institution);
                      const isManual    = a.syncStatus === "manual";
                      const isEditing   = editingAssetId === a.id;
                      const borderCls   = idx < accts.length - 1 ? "border-b border-gray-800/50" : "";

                      // Manual asset row — shows inline "Update value" editor instead of AccountModal
                      if (isManual) {
                        const isConfirmingDelete = confirmDeleteId === a.id;
                        return (
                          <div key={a.id} className={`pl-6 pr-4 ${borderCls}`}>
                            {/* Normal row — click pencil to edit, trash to delete */}
                            <div className="flex items-center justify-between py-3.5">
                              <div className="flex items-center gap-3">
                                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${iconCls}`}>
                                  <Icon size={13} />
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-white leading-tight">{a.name}</p>
                                  <p className="text-xs text-gray-500 leading-tight mt-0.5">Manual · Updated {formatDate(a.lastUpdated)}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0 ml-3">
                                {!isEditing && !isConfirmingDelete && (
                                  <>
                                    <p className="text-sm font-semibold tabular-nums text-white mr-1">{fmtAbs(a.balance)}</p>
                                    <button
                                      onClick={() => { setEditingAssetId(a.id); setEditingAssetVal(String(a.balance)); }}
                                      className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-teal-400 hover:bg-teal-500/10 transition-colors"
                                      title="Update value"
                                    >
                                      <Pencil size={13} />
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteId(a.id)}
                                      className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                      title="Delete asset"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            {/* Inline balance edit row */}
                            {isEditing && (
                              <div className="pb-3.5 flex items-center gap-2">
                                <input
                                  type="text"
                                  value={editingAssetVal}
                                  onChange={(e) => setEditingAssetVal(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") saveAssetBalance(a.id); if (e.key === "Escape") { setEditingAssetId(null); } }}
                                  className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/30"
                                  placeholder="New value"
                                  autoFocus
                                />
                                <button
                                  onClick={() => saveAssetBalance(a.id)}
                                  disabled={savingAsset}
                                  className="w-8 h-8 flex items-center justify-center rounded-xl bg-teal-600 hover:bg-teal-500 text-white transition-colors disabled:opacity-50"
                                >
                                  {savingAsset ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                                </button>
                                <button
                                  onClick={() => setEditingAssetId(null)}
                                  className="text-xs text-gray-500 hover:text-gray-400 px-2"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                            {/* Inline delete confirmation row */}
                            {isConfirmingDelete && (
                              <div className="pb-3.5 flex items-center justify-between gap-3">
                                <p className="text-xs text-gray-400">Archive <span className="text-white font-medium">{a.name}</span>? You can restore it from <span className="text-gray-300">Settings → Archived Assets</span>.</p>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    onClick={() => setConfirmDeleteId(null)}
                                    disabled={deletingAsset}
                                    className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => deleteAsset(a.id)}
                                    disabled={deletingAsset}
                                    className="flex items-center gap-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                                  >
                                    {deletingAsset ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                                    {deletingAsset ? "Archiving…" : "Archive"}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      }

                      // Standard Plaid-synced account row
                      return (
                        <button
                          key={a.id}
                          onClick={() => setSelectedAccount(a)}
                          className={`w-full flex items-center justify-between pl-6 pr-4 py-3.5 hover:bg-gray-800/40 active:bg-gray-800 transition-colors touch-manipulation text-left ${borderCls}`}
                        >
                          <div className="flex items-center gap-3">
                            {type === "crypto" ? (
                              <CoinIcon symbol={coinSymbol} size={28} />
                            ) : (
                              <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${iconCls}`}>
                                <Icon size={13} />
                              </div>
                            )}
                            <div>
                              <p className="text-sm font-medium text-white leading-tight">{a.name}</p>
                              <p className="text-xs text-gray-500 leading-tight mt-0.5">{a.institution}</p>
                            </div>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className={`text-sm font-semibold tabular-nums ${
                              isDebt
                                ? a.balance > 0 ? "text-red-400" : "text-emerald-400"
                                : "text-white"
                            }`}>
                              {fmtAbs(Math.abs(a.balance))}
                            </p>
                            <p className="text-xs text-gray-600 mt-0.5">{formatDate(a.lastUpdated)}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Investable brokerage cash section (Banking tab) */}
      {isBanking && investableAccounts.length > 0 && (() => {
        const sectionKey   = "investable";
        const isOpen       = !sectionCollapsed[sectionKey];
        const sectionTotal = investableAccounts.reduce((s, { cashAmount }) => s + cashAmount, 0);
        const newestSync   = investableAccounts.reduce(
          (best, { account: a }) => (a.lastUpdated > best ? a.lastUpdated : best),
          investableAccounts[0].account.lastUpdated
        );

        return (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
            <button
              onClick={() => toggleSection(sectionKey)}
              className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-800/70 active:bg-gray-800 transition-colors touch-manipulation select-none"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-violet-500/10">
                  <TrendingUp size={15} className="text-violet-400" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-white leading-tight">Brokerage Cash</p>
                  <p className="text-xs text-gray-500 leading-tight mt-0.5">
                    {investableAccounts.length} account{investableAccounts.length !== 1 ? "s" : ""} · Updated {formatDate(newestSync)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <p className="text-sm font-semibold tabular-nums text-violet-400">
                  {fmtAbs(sectionTotal)}
                </p>
                {isOpen
                  ? <ChevronUp   size={16} className="text-gray-500 shrink-0" />
                  : <ChevronDown size={16} className="text-gray-500 shrink-0" />
                }
              </div>
            </button>

            <div
              style={{
                display:          "grid",
                gridTemplateRows: isOpen ? "1fr" : "0fr",
                transition:       "grid-template-rows 0.2s ease",
              }}
            >
              <div className="overflow-hidden" style={{ minHeight: 0 }}>
                <div className="border-t border-gray-700/60 bg-gray-950/60">
                  {investableAccounts.map(({ account: a, cashAmount }, idx) => {
                    const coinSymbol = a.walletChain ?? exchangeSymbol(a.institution);
                    return (
                      <button
                        key={a.id}
                        onClick={() => setSelectedAccount(a)}
                        className={`w-full flex items-center justify-between pl-6 pr-4 py-3.5 hover:bg-gray-800/40 active:bg-gray-800 transition-colors touch-manipulation text-left ${
                          idx < investableAccounts.length - 1 ? "border-b border-gray-800/50" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {a.type === "crypto" ? (
                            <CoinIcon symbol={coinSymbol} size={28} />
                          ) : (
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-violet-500/10">
                              <TrendingUp size={13} className="text-violet-400" />
                            </div>
                          )}
                          <div>
                            <p className="text-sm font-medium text-white leading-tight">{a.name}</p>
                            <p className="text-xs text-gray-500 leading-tight mt-0.5">{a.institution}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="text-sm font-semibold tabular-nums text-violet-400">
                            {fmtAbs(cashAmount)}
                          </p>
                          <p className="text-xs text-gray-600 mt-0.5">{formatDate(a.lastUpdated)}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between mb-0">
        <div>
          <h1 className="text-xl font-bold text-white">
            {firstName ? `${firstName}'s Dashboard` : "My Dashboard"}
          </h1>
          <p className="text-sm text-gray-500">Personal</p>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          <div className="relative">
            <button
              onClick={() => setManageOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors border border-gray-800 hover:border-gray-700"
            >
              <FolderOpen size={13} />
              Manage
            </button>

          {manageOpen && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-30" onClick={() => setManageOpen(false)} />
              {/* Dropdown */}
              <div className="absolute right-0 top-full mt-1.5 z-40 w-56 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
                <Link
                  href="/dashboard/accounts"
                  onClick={() => setManageOpen(false)}
                  className="flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-white">Accounts</p>
                    <p className="text-xs text-gray-500 mt-0.5">Manage linked accounts</p>
                  </div>
                  <ArrowUpRight size={14} className="text-gray-500 shrink-0" />
                </Link>
                <div className="border-t border-gray-800">
                  <button
                    onClick={() => { setManageOpen(false); setAssetOpen(true); }}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition-colors"
                  >
                    <div className="text-left">
                      <p className="text-sm font-medium text-white">Add Manual Asset</p>
                      <p className="text-xs text-gray-500 mt-0.5">Real estate, vehicles, etc.</p>
                    </div>
                    <ArrowUpRight size={14} className="text-gray-500 shrink-0" />
                  </button>
                </div>
                <div className="border-t border-gray-800">
                  <Link
                    href="/dashboard/settings/archived-assets"
                    onClick={() => setManageOpen(false)}
                    className="flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition-colors"
                  >
                    <div>
                      <p className="text-sm font-medium text-white">Archived Assets</p>
                      <p className="text-xs text-gray-500 mt-0.5">Restore or delete</p>
                    </div>
                    <ArrowUpRight size={14} className="text-gray-500 shrink-0" />
                  </Link>
                </div>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 overflow-x-auto bg-gray-900 border border-gray-800 rounded-2xl p-1 scrollbar-hide">
        {PERSONAL_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleFilterChange(tab.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors shrink-0 touch-manipulation ${
              filter === tab.key
                ? "bg-gray-700 text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {walletOpen && <AddWalletModal onClose={() => setWalletOpen(false)} />}
      {assetOpen  && <AddManualAssetModal onClose={() => setAssetOpen(false)} />}

      {/* Credit tab — full DebtClient */}
      {isCredit && (
        <DebtClient
          initialFico={ficoScore}
          lastUpdatedAt={ficoUpdatedAt}
          accounts={accounts.filter((a) => a.type === "debt")}
          transactions={debtTransactions}
        />
      )}

      {/* Goals tab */}
      {isGoals && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
            <Target size={20} className="text-blue-400" />
          </div>
          <p className="text-sm font-semibold text-white mb-1">Goals</p>
          <p className="text-sm text-gray-400">Financial goals are coming soon.</p>
        </div>
      )}

      {/* Activity tab */}
      {isActivity && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
          <div className="w-12 h-12 rounded-2xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center mx-auto mb-4">
            <Clock size={20} className="text-teal-400" />
          </div>
          <p className="text-sm font-semibold text-white mb-1">Activity</p>
          <p className="text-sm text-gray-400">Personal activity feed coming soon.</p>
        </div>
      )}

      {/* Settings tab */}
      {isSettings && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden divide-y divide-gray-800">
          {[
            { href: "/dashboard/settings", label: "Settings",  sub: "Profile, password, and account preferences" },
            { href: "/dashboard/advice",   label: "AI Advice", sub: "View your latest financial insights" },
          ].map(({ href, label, sub }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-gray-800/60 active:bg-gray-800 transition-colors"
            >
              <div>
                <p className="text-sm font-medium text-white">{label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
              </div>
              <ArrowUpRight size={15} className="text-gray-500 shrink-0" />
            </Link>
          ))}
        </div>
      )}

      {/* Overview / Banking / Investments */}
      {!isCredit && !isStaticTab && (
        <div className="space-y-3">

          {/* ── Dashboard (Overview) ── */}
          {filter === "dashboard" && (
            <>
              <PersonalSectionCard title="Overview">
                <div className="space-y-3">
                  <NetWorthCard
                    netWorth={stats.netWorth}
                    totalAssets={stats.assets}
                    totalDebt={stats.debt}
                    liquid={cashChecking + cashSavings}
                    change30d={changeForInterval}
                    changeLabel={chartInterval}
                    lastUpdated={fmtAccountDate}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <CashOnHandCard
                      accounts={cashAccounts}
                      investable={investableAccountCash}
                      lastUpdated={fmtAccountDate}
                    />
                    <FicoCard score={ficoScore} lastUpdated={formatFicoDate(ficoUpdatedAt)} compact />
                  </div>
                </div>
              </PersonalSectionCard>

              <div className="md:grid md:grid-cols-2 md:gap-3 space-y-3 md:space-y-0">
                <PersonalSectionCard
                  title="Net Worth"
                  rightSlot={
                    <button
                      onClick={() => setChartExpanded(true)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors touch-manipulation"
                    >
                      <Maximize2 size={14} />
                    </button>
                  }
                >
                  <NetWorthChart
                    snapshots={snapshots}
                    interval={chartInterval}
                    onIntervalChange={setChartInterval}
                    fill
                  />
                </PersonalSectionCard>

                <PersonalSectionCard title="Allocation">
                  <AllocationChart
                    cash={allocation.cash}
                    investments={allocation.investments}
                    crypto={allocation.crypto}
                    debt={allocation.debt}
                    realAssets={allocation.realAssets}
                  />
                </PersonalSectionCard>
              </div>
            </>
          )}

          {/* ── Banking (absorbs Cash) ── */}
          {isBanking && (
            <>
              <PersonalSectionCard title="Banking">
                <div className="space-y-3">
                  <NetWorthCard
                    title="Banking"
                    hideInvestments
                    netWorth={stats.netWorth}
                    totalAssets={stats.assets}
                    totalDebt={stats.debt}
                    liquid={cashChecking + cashSavings}
                    change30d={0}
                    changeLabel={chartInterval}
                    lastUpdated={fmtAccountDate}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <CashOnHandCard
                      accounts={cashAccounts}
                      lastUpdated={fmtAccountDate}
                    />
                    <DebtCard
                      accounts={accounts.filter((a) => a.type === "debt")}
                      lastUpdated={fmtAccountDate}
                    />
                  </div>
                </div>
              </PersonalSectionCard>

              <PersonalSectionCard title="Cash History">
                <CashChart
                  snapshots={snapshots}
                  interval={chartInterval}
                  onIntervalChange={setChartInterval}
                  investableCash={investableAccountCash}
                />
              </PersonalSectionCard>

              <PersonalSectionCard title="Banking History">
                <BankingChart
                  snapshots={snapshots}
                  interval={chartInterval}
                  onIntervalChange={setChartInterval}
                />
              </PersonalSectionCard>
            </>
          )}

          {/* ── Investments ── */}
          {isInvestments && (
            <>
              <PersonalSectionCard title="Portfolio">
                <InvestmentsCard
                  stocks={allocation.investments - investmentCash}
                  crypto={allocation.crypto - cryptoCash}
                  cash={investableAccountCash}
                  change={investmentsChangeForInterval}
                  changeLabel={chartInterval}
                  lastUpdated={fmtAccountDate}
                />
              </PersonalSectionCard>

              <PersonalSectionCard title="Portfolio History">
                <InvestmentsChart
                  snapshots={snapshots}
                  interval={chartInterval}
                  onIntervalChange={setChartInterval}
                />
              </PersonalSectionCard>

              <PersonalSectionCard title="Holdings">
                <HoldingsDonutChart
                  holdings={holdings}
                  cryptoAccounts={accounts.filter((a) =>
                    a.type === "crypto" &&
                    !holdings.some((h) => h.accountId === a.id && !h.isCash)
                  )}
                  accountTotal={allocation.investments + allocation.crypto}
                />
              </PersonalSectionCard>
            </>
          )}

          {/* Account sections */}
          {accountSections}
        </div>
      )}

      {/* Net Worth chart modal */}
      {chartExpanded && (
        <NetWorthChartModal
          snapshots={snapshots}
          initialInterval={chartInterval}
          onClose={() => setChartExpanded(false)}
        />
      )}

      {/* Account detail modal */}
      {selectedAccount && (
        <AccountModal
          account={selectedAccount}
          holdings={holdings}
          onClose={() => setSelectedAccount(null)}
          onRemove={() => setSelectedAccount(null)}
        />
      )}
    </div>
  );
}
