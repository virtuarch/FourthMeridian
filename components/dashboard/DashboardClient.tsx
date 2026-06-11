"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { FilterBar, FilterSlice } from "./FilterBar";
import { NetWorthCard } from "./NetWorthCard";
import { CashToPlayCard } from "./CashToPlayCard";
import { FicoCard } from "./FicoCard";
import { AdviceBanner } from "./AdviceBanner";
import { NetWorthChart, Interval, cutoffForInterval } from "@/components/charts/NetWorthChart";
import { CashChart } from "@/components/charts/CashChart";
import { BankingChart } from "@/components/charts/BankingChart";
import { NetWorthChartModal } from "@/components/charts/NetWorthChartModal";
import { AllocationChart } from "@/components/charts/AllocationChart";
import { Card, CardTitle } from "@/components/ui/Card";
import { Account, Holding, Snapshot, AiAdvice, Transaction } from "@/types";
import {
  ChevronDown,
  Building2,
  Landmark,
  CreditCard,
  Bitcoin,
  TrendingUp,
  Maximize2,
} from "lucide-react";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { DebtCard }  from "@/components/dashboard/DebtCard";
import { InvestmentsCard } from "@/components/dashboard/InvestmentsCard";
import { AccountGroupCard } from "@/components/dashboard/AccountGroupCard";
import { InvestmentsChart } from "@/components/charts/InvestmentsChart";
import { HoldingsDonutChart } from "@/components/charts/HoldingsDonutChart";
import { AccountModal } from "@/components/dashboard/AccountModal";
import { CreditClient } from "@/components/dashboard/CreditClient";
import { ConnectAccountButton } from "@/components/dashboard/ConnectAccountButton";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import { exchangeSymbol } from "@/lib/exchangeSymbol";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Props {
  accounts:          Account[];
  holdings:          Holding[];
  snapshots:         Snapshot[];
  advice:            AiAdvice | null;
  ficoScore:         number | null;
  ficoUpdatedAt:     string | null;
  debtTransactions:  Transaction[];
}

// ── Filter config ─────────────────────────────────────────────────────────────
const ACCOUNT_TYPES: Record<FilterSlice, string[]> = {
  all:         ["checking", "savings", "investment", "crypto", "debt"],
  cash:        ["checking", "savings"],
  banking:     ["checking", "savings", "debt"],
  investments: ["investment", "crypto"],
  credit:      ["debt"],
};

const SECTION_ORDER = [
  { label: "Checking",    type: "checking"   },
  { label: "Savings",     type: "savings"    },
  { label: "Investments", type: "investment" },
  { label: "Crypto",      type: "crypto"     },
  { label: "Debt",        type: "debt"       },
] as const;

// ── Per-type visual config ────────────────────────────────────────────────────
type AccountType = "checking" | "savings" | "investment" | "crypto" | "debt";

const TYPE_ICON: Record<AccountType, React.ElementType> = {
  checking:   Building2,
  savings:    Landmark,
  investment: TrendingUp,
  crypto:     Bitcoin,
  debt:       CreditCard,
};

const TYPE_ICON_CLS: Record<AccountType, string> = {
  checking:   "bg-blue-500/10 text-blue-400",
  savings:    "bg-emerald-500/10 text-emerald-400",
  investment: "bg-violet-500/10 text-violet-400",
  crypto:     "bg-yellow-500/10 text-yellow-400",
  debt:       "bg-red-500/10 text-red-400",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtAbs = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 2,
  }).format(Math.abs(n));

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function formatFicoDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ── Component ─────────────────────────────────────────────────────────────────
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function DashboardClient({
  accounts, holdings, snapshots, advice, ficoScore, ficoUpdatedAt, debtTransactions,
}: Props) {
  const router        = useRouter();
  const searchParams  = useSearchParams();
  const { data: session } = useSession();
  const [walletOpen, setWalletOpen] = useState(false);

  // Parse first name from session (e.g. "Jane Smith" → "Jane")
  const firstName = session?.user?.name?.split(" ")[0] ?? session?.user?.username ?? "";

  const VALID_TABS: FilterSlice[] = ["all", "cash", "banking", "investments", "credit"];
  const initialTab = (searchParams.get("tab") ?? "all") as FilterSlice;

  const [filter, setFilter] = useState<FilterSlice>(
    VALID_TABS.includes(initialTab) ? initialTab : "all"
  );
  const [chartInterval, setChartInterval] = useState<Interval>("1M");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const handleFilterChange = useCallback((f: FilterSlice) => {
    setFilter(f);
    router.replace(`/dashboard?tab=${f}`, { scroll: false });
  }, [router]);

  // All sections start collapsed — tap to open
  const [sectionCollapsed, setSectionCollapsed] = useState<Record<string, boolean>>(() => ({
    ...Object.fromEntries(SECTION_ORDER.map(({ type }) => [type, true])),
    investable: true,
  }));

  const toggleSection = useCallback((type: string) => {
    setSectionCollapsed((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  // ── Derived data ─────────────────────────────────────────────────────────
  const allowedTypes = ACCOUNT_TYPES[filter];

  const filtered = useMemo(
    () => accounts.filter((a) => allowedTypes.includes(a.type)),
    [accounts, allowedTypes]
  );

  const stats = useMemo(() => {
    const debtAccts  = filtered.filter((a) => a.type === "debt");
    const allNonDebt = filtered.filter((a) => a.type !== "debt");
    const totalNonDebt  = allNonDebt.reduce((s, a) => s + a.balance, 0);
    // Investments = stocks/funds + crypto only
    const investments = filtered
      .filter((a) => a.type === "investment" || a.type === "crypto")
      .reduce((s, a) => s + a.balance, 0);
    // Net debt: positive = you owe, negative = credit. Matches Banking page.
    const debt = Math.max(0, debtAccts.reduce((s, a) => s + a.balance, 0));
    return { netWorth: totalNonDebt - debt, assets: investments, debt };
  }, [filtered]);

  // Fresh allocation values from all accounts (bypasses potentially stale snapshots)
  const allocation = useMemo(() => {
    const cash        = accounts.filter((a) => ["checking","savings"].includes(a.type)).reduce((s, a) => s + a.balance, 0);
    const investments = accounts.filter((a) => a.type === "investment").reduce((s, a) => s + a.balance, 0);
    const crypto      = accounts.filter((a) => a.type === "crypto").reduce((s, a) => s + a.balance, 0);
    const debt        = accounts.filter((a) => a.type === "debt" && a.balance > 0).reduce((s, a) => s + a.balance, 0);
    return { cash, investments, crypto, debt };
  }, [accounts]);

  const latest = snapshots[snapshots.length - 1];

  // Change tied to whatever interval the chart is showing
  const changeForInterval = useMemo(() => {
    if (!latest) return 0;
    const cutoff = cutoffForInterval(chartInterval);
    const snap = snapshots.find((s) => s.date >= cutoff) ?? snapshots[0];
    return snap ? latest.netWorth - snap.netWorth : 0;
  }, [snapshots, latest, chartInterval]);

  // Cash-specific change (checking + savings) over selected interval
  const cashChangeForInterval = useMemo(() => {
    if (!latest) return 0;
    const cutoff = cutoffForInterval(chartInterval);
    const snap = snapshots.find((s) => s.date >= cutoff) ?? snapshots[0];
    if (!snap) return 0;
    return (latest.totalCash + latest.totalSavings) - (snap.totalCash + snap.totalSavings);
  }, [snapshots, latest, chartInterval]);

  // Investments change (stocks + crypto) over selected interval
  const investmentsChangeForInterval = useMemo(() => {
    if (!latest) return 0;
    const cutoff = cutoffForInterval(chartInterval);
    const snap = snapshots.find((s) => s.date >= cutoff) ?? snapshots[0];
    if (!snap) return 0;
    return (latest.totalInvestments + latest.totalCrypto) - (snap.totalInvestments + snap.totalCrypto);
  }, [snapshots, latest, chartInterval]);

  const cashChecking = useMemo(
    () => accounts.filter((a) => a.type === "checking").reduce((s, a) => s + a.balance, 0),
    [accounts]
  );
  const cashSavings = useMemo(
    () => accounts.filter((a) => a.type === "savings").reduce((s, a) => s + a.balance, 0),
    [accounts]
  );
  // Cash sitting inside investment accounts (e.g. Schwab settlement, Robinhood)
  const investmentCash = useMemo(() => {
    const ids = new Set(accounts.filter((a) => a.type === "investment").map((a) => a.id));
    return holdings.filter((h) => h.isCash && ids.has(h.accountId)).reduce((s, h) => s + h.value, 0);
  }, [accounts, holdings]);

  // Cash sitting inside crypto accounts (e.g. Coinbase USD idle)
  const cryptoCash = useMemo(() => {
    const ids = new Set(accounts.filter((a) => a.type === "crypto").map((a) => a.id));
    return holdings.filter((h) => h.isCash && ids.has(h.accountId)).reduce((s, h) => s + h.value, 0);
  }, [accounts, holdings]);

  // Total investable cash across all investment/crypto accounts
  const investableAccountCash = investmentCash + cryptoCash;

  // Accounts that hold uninvested cash — shown in Cash tab's Investable section
  const investableAccounts = useMemo(() => {
    const candidates = accounts.filter((a) => a.type === "investment" || a.type === "crypto");
    return candidates
      .map((a) => ({
        account:     a,
        cashAmount:  holdings.filter((h) => h.isCash && h.accountId === a.id).reduce((s, h) => s + h.value, 0),
      }))
      .filter(({ cashAmount }) => cashAmount > 0)
      .sort((a, b) => b.cashAmount - a.cashAmount);
  }, [accounts, holdings]);

  // Dates for summary cards
  const newestAccountDate = accounts.length
    ? accounts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accounts[0].lastUpdated)
    : null;
  const fmtAccountDate = newestAccountDate ? fmtDate(newestAccountDate) : undefined;
  const snapshotDate   = latest?.date
    ? new Date(latest.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;

  const isCash         = filter === "cash";
  const isBanking      = filter === "banking";
  const isInvestments  = filter === "investments";
  const isCredit       = filter === "credit";
  const showChart      = filter === "all" || isCash || isBanking || isInvestments;
  const showAllocation = filter === "all";

  // ── Render ────────────────────────────────────────────────────────────────

  // Credit tab — full CreditClient with its own layout
  if (isCredit) {
    return (
      <div className="space-y-5">
        {advice && <AdviceBanner advice={advice} />}
        <FilterBar active={filter} onChange={handleFilterChange} />
        <CreditClient
          initialFico={ficoScore}
          lastUpdatedAt={ficoUpdatedAt}
          accounts={accounts.filter((a) => a.type === "debt")}
          transactions={debtTransactions}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Welcome header ── */}
      <div>
        {firstName && (
          <h1 className="text-xl font-bold text-white leading-tight">
            {`${getGreeting()}, ${firstName}`}
          </h1>
        )}
      </div>
      {walletOpen && (
        <AddWalletModal onClose={() => setWalletOpen(false)} />
      )}

      {/* AI Advice always visible */}
      {advice && <AdviceBanner advice={advice} />}

      <FilterBar active={filter} onChange={handleFilterChange} />

      {/* ── Summary cards ── */}
      {isCash ? (
        /* Cash view: Cash on Hand is the hero full-width card */
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <CashToPlayCard
              hero
              checking={cashChecking}
              savings={cashSavings}
              debt={allocation.debt}
              playReady={(cashChecking + cashSavings + investableAccountCash) > 0}
              investable={investableAccountCash}
              change={cashChangeForInterval}
              changeLabel={chartInterval}
              lastUpdated={fmtAccountDate}
            />
          </div>
        </div>
      ) : isInvestments ? (
        /* Investments view */
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <InvestmentsCard
              stocks={allocation.investments - investmentCash}
              crypto={allocation.crypto - cryptoCash}
              cash={investableAccountCash}
              change={investmentsChangeForInterval}
              changeLabel={chartInterval}
              lastUpdated={fmtAccountDate}
            />
          </div>
          <AccountGroupCard
            compact
            title={investmentCash > 0 ? "Stocks, Cash & Funds" : "Stocks & Funds"}
            accounts={accounts.filter((a) => a.type === "investment")}
            color="text-violet-400"
            maxItems={5}
          />
          <AccountGroupCard
            compact
            title="Crypto"
            accounts={accounts.filter((a) => a.type === "crypto")}
            color="text-yellow-400"
            maxItems={3}
          />
        </div>
      ) : isBanking ? (
        /* Banking view */
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
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
          </div>
          <CashToPlayCard
            checking={cashChecking}
            savings={cashSavings}
            debt={allocation.debt}
            playReady={(cashChecking + cashSavings + investableAccountCash) > 0}
            change={cashChangeForInterval}
            changeLabel={chartInterval}
            lastUpdated={fmtAccountDate}
          />
          <DebtCard
            accounts={accounts.filter((a) => a.type === "debt")}
            lastUpdated={fmtAccountDate}
          />
        </div>
      ) : (
        /* All / other tabs */
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <NetWorthCard
            netWorth={stats.netWorth}
            totalAssets={stats.assets}
            totalDebt={stats.debt}
            liquid={cashChecking + cashSavings}
            change30d={filter === "all" ? changeForInterval : 0}
            changeLabel={chartInterval}
            lastUpdated={fmtAccountDate}
          />
          {filter === "all" && (
            <CashToPlayCard
              checking={cashChecking}
              savings={cashSavings}
              debt={allocation.debt}
              playReady={(cashChecking + cashSavings + investableAccountCash) > 0}
              investable={investableAccountCash}
              change={cashChangeForInterval}
              changeLabel={chartInterval}
              lastUpdated={fmtAccountDate}
            />
          )}
          {filter === "all" && (
            <FicoCard score={ficoScore} lastUpdated={formatFicoDate(ficoUpdatedAt)} />
          )}
        </div>
      )}

      {/* ── Charts ── */}
      <div className={`grid gap-4 ${(showChart && showAllocation) || isInvestments ? "lg:grid-cols-2" : "grid-cols-1"}`}>
        {showChart && (
          <Card>
            {isCash ? (
              <CashChart
                snapshots={snapshots}
                interval={chartInterval}
                onIntervalChange={setChartInterval}
                investableCash={investableAccountCash}
              />
            ) : isInvestments ? (
              <>
                <CardTitle>Portfolio History</CardTitle>
                <div className="mt-3">
                  <InvestmentsChart
                    snapshots={snapshots}
                    interval={chartInterval}
                    onIntervalChange={setChartInterval}
                  />
                </div>
              </>
            ) : isBanking ? (
              <>
                <CardTitle>Banking History</CardTitle>
                <BankingChart
                  snapshots={snapshots}
                  interval={chartInterval}
                  onIntervalChange={setChartInterval}
                />
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <CardTitle>Net Worth</CardTitle>
                  <button
                    onClick={() => setChartExpanded(true)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors touch-manipulation"
                  >
                    <Maximize2 size={14} />
                  </button>
                </div>
                <div className="mt-3">
                  <NetWorthChart
                    snapshots={snapshots}
                    interval={chartInterval}
                    onIntervalChange={setChartInterval}
                  />
                </div>
              </>
            )}
          </Card>
        )}

        {isInvestments && (
          <Card>
            <CardTitle>Holdings</CardTitle>
            <div className="mt-3">
              <HoldingsDonutChart
                holdings={holdings}
                cryptoAccounts={accounts.filter((a) =>
                  a.type === "crypto" &&
                  !holdings.some((h) => h.accountId === a.id && !h.isCash)
                )}
                accountTotal={allocation.investments + allocation.crypto}
              />
            </div>
          </Card>
        )}

        {chartExpanded && (
          <NetWorthChartModal
            snapshots={snapshots}
            initialInterval={chartInterval}
            onClose={() => setChartExpanded(false)}
          />
        )}
        {showAllocation && (
          <Card>
            <CardTitle>Allocation</CardTitle>
            <AllocationChart
              cash={allocation.cash}
              investments={allocation.investments}
              crypto={allocation.crypto}
              debt={allocation.debt}
            />
          </Card>
        )}
      </div>

      {/* ── Account sections — banking-style collapsible ── */}
      <div className="space-y-3">
        {SECTION_ORDER.filter(({ type }) => allowedTypes.includes(type)).map(({ label, type }) => {
          const accts    = filtered.filter((a) => a.type === type).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
          const isEmpty  = accts.length === 0;
          const isOpen   = !sectionCollapsed[type];
          const isDebt   = type === "debt";
          const Icon     = TYPE_ICON[type as AccountType] ?? Building2;
          const iconCls  = TYPE_ICON_CLS[type as AccountType] ?? "bg-gray-500/10 text-gray-400";

          const sectionTotal = accts.reduce((s, a) => s + a.balance, 0);
          const newestSync   = !isEmpty
            ? accts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accts[0].lastUpdated)
            : null;

          return (
            <div
              key={type}
              className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden"
            >
              {/* Section header — tap to expand/collapse */}
              <button
                onClick={() => !isEmpty && toggleSection(type)}
                className={`w-full flex items-center justify-between px-4 py-3.5 transition-colors touch-manipulation select-none ${
                  isEmpty
                    ? "cursor-default"
                    : "hover:bg-gray-800/70 active:bg-gray-800"
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
                        : `${accts.length} account${accts.length !== 1 ? "s" : ""} · Updated ${fmtDate(newestSync!)}`
                      }
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {!isEmpty && (
                    <p className={`text-sm font-semibold tabular-nums ${
                      isDebt
                        ? sectionTotal > 0 ? "text-red-400" : "text-emerald-400"
                        : "text-white"
                    }`}>
                      {fmtAbs(Math.abs(sectionTotal))}
                    </p>
                  )}
                  {!isEmpty && (
                    <ChevronDown
                      size={16}
                      className={`text-gray-500 transition-transform duration-200 shrink-0 ${isOpen ? "rotate-180" : "rotate-0"}`}
                    />
                  )}
                </div>
              </button>

              {/* Empty-state CTA — only shown when no accounts exist */}
              {isEmpty && (
                <div className="border-t border-gray-800/60 px-4 py-3 flex flex-wrap items-center gap-2">
                  <ConnectAccountButton />
                  {type === "crypto" && (
                    <button
                      onClick={() => setWalletOpen(true)}
                      className="flex items-center gap-1.5 text-xs font-semibold text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 px-3 py-2 rounded-xl transition-colors"
                    >
                      + Add Wallet
                    </button>
                  )}
                </div>
              )}

              {/* Sliding account rows — only rendered when accounts exist */}
              {!isEmpty && (
                <div
                  style={{
                    display:          "grid",
                    gridTemplateRows: isOpen ? "1fr" : "0fr",
                    transition:       "grid-template-rows 0.2s ease",
                  }}
                >
                  {/* minHeight:0 required for grid-template-rows:0fr to collapse in Safari */}
                  <div className="overflow-hidden" style={{ minHeight: 0 }}>
                    <div className="border-t border-gray-700/60 bg-gray-950/60">
                      {accts.map((a, idx) => {
                        const coinSymbol = a.walletChain ?? exchangeSymbol(a.institution);
                        return (
                          <button
                            key={a.id}
                            onClick={() => setSelectedAccount(a)}
                            className={`w-full flex items-center justify-between pl-6 pr-4 py-3.5 hover:bg-gray-800/40 active:bg-gray-800 transition-colors touch-manipulation text-left ${
                              idx < accts.length - 1 ? "border-b border-gray-800/50" : ""
                            }`}
                          >
                            {/* Left: icon + name + institution */}
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

                            {/* Right: balance + date */}
                            <div className="text-right shrink-0 ml-3">
                              <p className={`text-sm font-semibold tabular-nums ${
                                isDebt
                                  ? a.balance > 0 ? "text-red-400" : "text-emerald-400"
                                  : "text-white"
                              }`}>
                                {fmtAbs(Math.abs(a.balance))}
                              </p>
                              <p className="text-xs text-gray-600 mt-0.5">{fmtDate(a.lastUpdated)}</p>
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

        {/* ── Investable section (Cash tab only) ── */}
        {isCash && investableAccounts.length > 0 && (() => {
          const sectionKey  = "investable";
          const isOpen      = !sectionCollapsed[sectionKey];
          const sectionTotal = investableAccounts.reduce((s, { cashAmount }) => s + cashAmount, 0);
          const newestSync   = investableAccounts.reduce(
            (best, { account: a }) => (a.lastUpdated > best ? a.lastUpdated : best),
            investableAccounts[0].account.lastUpdated
          );

          return (
            <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
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
                      {investableAccounts.length} account{investableAccounts.length !== 1 ? "s" : ""} · Updated {fmtDate(newestSync)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-semibold tabular-nums text-violet-400">
                    {fmtAbs(sectionTotal)}
                  </p>
                  <ChevronDown
                    size={16}
                    className={`text-gray-500 transition-transform duration-200 shrink-0 ${isOpen ? "rotate-180" : "rotate-0"}`}
                  />
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
                            <p className="text-xs text-gray-600 mt-0.5">{fmtDate(a.lastUpdated)}</p>
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
