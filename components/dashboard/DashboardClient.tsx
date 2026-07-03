"use client";

import { useState, useMemo, useCallback, useEffect, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { NetWorthCard } from "./NetWorthCard";
import { CashOnHandCard } from "./CashOnHandCard";
import { NetWorthChart, Interval, cutoffForInterval } from "@/components/charts/NetWorthChart";
import { CashChart } from "@/components/charts/CashChart";
import { BankingChart } from "@/components/charts/BankingChart";
import { NetWorthChartModal, type SeriesKey } from "@/components/charts/NetWorthChartModal";
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
  Wallet,
  Pencil,
  Check,
  Loader2,
  Trash2,
  FolderOpen,
  ArrowUpRight,
  Receipt,
  Compass,
  Users,
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
import { ManageSpaceModal } from "@/components/dashboard/ManageSpaceModal";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { exchangeSymbol } from "@/lib/exchangeSymbol";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate, formatRelativeTime, possessive } from "@/lib/format";
import { classifyAccounts } from "@/lib/account-classifier";
import { SPACE_TAB_LABELS, SpaceTabId } from "@/lib/space-nav";
import { getPerspectivesForCategory, getCompositionSwitcherItems, PERSPECTIVE_GROUPS, type PerspectiveGroup } from "@/lib/perspectives";
import type { LensResult } from "@/lib/perspective-engine/types";
import { InlineFilter } from "@/components/atlas/InlineFilter";
import type { TimelineEvent } from "@/lib/timeline-types";
import { PerspectivesWidget, PerspectiveCardItem } from "@/components/dashboard/widgets/PerspectivesWidget";
import { PerspectiveSwitcher, COMPOSITION_ICON_MAP } from "@/components/dashboard/widgets/PerspectiveSwitcher";
import { MoreMenu } from "@/components/dashboard/widgets/MoreMenu";
import { SpaceTimelinePanel } from "@/components/dashboard/widgets/SpaceTimelineWidget";
import { TimelineModal } from "@/components/dashboard/widgets/TimelineModal";
import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { SpaceMembersWidget } from "@/components/dashboard/widgets/SpaceMembersWidget";
import { SpaceComingSoonPanel } from "@/components/dashboard/widgets/SpaceComingSoonPanel";
import { KpiRow } from "@/components/dashboard/widgets/KpiRow";
import { RecentTransactionsPanel } from "@/components/dashboard/widgets/RecentTransactionsPanel";
import { SpaceTransactionsPanel } from "@/components/dashboard/widgets/SpaceTransactionsPanel";

// ── Types ─────────────────────────────────────────────────────────────────────
type PersonalTab =
  // Live, real tabs (some kept as top-level buttons, some now reached only via Perspectives)
  | "dashboard"
  | "banking"
  | "investments"
  | "credit"
  | "goals"
  | "activity"
  | "settings"
  // New fixed-rail tabs introduced by the Spaces dashboard redesign
  | "perspectives"
  | "timeline"
  | "finances"
  | "transactions"
  | "members"
  | "documents";

// Timeline sub-nav — mix of date-range buckets and type buckets, matching
// the redesign spec's chip set (All/Today/Week/Month/AI/Transactions/Documents).
// Client-side filter over the same events array; no new fetching/aggregation.
type TimelineFilterId = "all" | "today" | "week" | "month" | "ai" | "transactions" | "documents";
const TIMELINE_FILTERS: { id: TimelineFilterId; label: string }[] = [
  { id: "all",          label: "All" },
  { id: "today",        label: "Today" },
  { id: "week",         label: "Week" },
  { id: "month",        label: "Month" },
  { id: "ai",           label: "AI" },
  { id: "transactions", label: "Transactions" },
  { id: "documents",    label: "Documents" },
];

interface Props {
  spaceId:       string;
  spaceName:     string;
  category:          string;
  myRole:            string;
  currentUserId:     string;
  accounts:          Account[];
  holdings:          Holding[];
  snapshots:         Snapshot[];
  advice:            AiAdvice | null;
  ficoScore:         number | null;
  ficoUpdatedAt:     string | null;
  debtTransactions:  Transaction[];
  transactions:      Transaction[];
}

// ── Tab config ────────────────────────────────────────────────────────────────
// Fixed-rail tab order/copy comes from lib/space-nav.ts — the same source
// every Space dashboard (Personal here, every other category in
// SpaceDashboard.tsx) draws its top-level tab strip from. Each rail tab
// maps to this dashboard's own internal tab id (preserved from before this
// pass) so existing tab content needs zero changes — only which ids get a
// visible rail control has changed.
const RAIL_TO_INTERNAL: Record<SpaceTabId, PersonalTab> = {
  OVERVIEW:     "dashboard",
  PERSPECTIVES: "perspectives",
  TIMELINE:     "timeline",
  FINANCES:     "finances",
  ACCOUNTS:     "banking",
  TRANSACTIONS: "transactions",
  MEMBERS:      "members",
  DOCUMENTS:    "documents",
  SETTINGS:     "settings",
};

// Personal rail tab-cleanup pass: Overview is now the only primary pill on
// the rail (rendered via the shared Atlas SegmentedControl, same primitive
// as before — just a single-segment track now). Perspectives/Finances/
// Settings have no rail control at all anymore (Perspectives is reached via
// the inline PerspectiveSwitcher + the Overview "Perspectives" row's
// "See all" link; Finances has no real feature yet; Settings is covered by
// the header's Manage control). Accounts/Transactions/Members/Documents
// move into MORE_MENU_ITEMS below instead of their own pills. This trim is
// Personal-only — lib/space-nav.ts's SPACE_TAB_ORDER is untouched, so every
// other Space category (SpaceDashboard.tsx) keeps its full rail.
const PERSONAL_TABS: { key: PersonalTab; label: string }[] = [
  { key: RAIL_TO_INTERNAL.OVERVIEW, label: SPACE_TAB_LABELS.OVERVIEW },
];

// "More" rail menu (far left of the rail) — the data-tabs that used to have
// their own pill and still are fully real/reachable, just consolidated
// behind one menu instead of separate pills. Order matches SPACE_TAB_ORDER:
// Accounts, Transactions, Members. Icons mirror each tab's own
// section/content icon elsewhere in this file (Landmark/Receipt/Users) for
// visual continuity. Documents has no entry (v2.5 honesty slice — no real
// feature exists yet; see PLACEHOLDER_SPACE_TABS / isRailTabVisible in
// lib/space-nav.ts): a menu item whose only content is a coming-soon panel
// is not real content. It re-earns its slot when the feature ships.
const MORE_MENU_ITEMS: { id: PersonalTab; label: string; icon: React.ElementType }[] = [
  { id: RAIL_TO_INTERNAL.ACCOUNTS,     label: SPACE_TAB_LABELS.ACCOUNTS,     icon: Landmark },
  { id: RAIL_TO_INTERNAL.TRANSACTIONS, label: SPACE_TAB_LABELS.TRANSACTIONS, icon: Receipt },
  { id: RAIL_TO_INTERNAL.MEMBERS,      label: SPACE_TAB_LABELS.MEMBERS,      icon: Users },
];

// Investments, Credit ("Debt"), and Goals are real, unmodified features that
// no longer have a top-level button now that Perspectives is their entry
// point (see PERSONAL_PERSPECTIVE_TARGETS below) — but they stay fully
// reachable, not deleted. VALID_TABS keeps deep links (?tab=) working for
// every id with real content behind it. "finances" and "documents" are
// deliberately absent (v2.5 honesty slice): no feature exists yet, so a
// stale ?tab= deep link falls back to Overview instead of landing on a
// coming-soon panel. The PersonalTab type members stay — this is
// presentation-level gating only.
const VALID_TABS: PersonalTab[] = [
  "dashboard", "banking", "investments", "credit", "activity", "settings",
  "perspectives", "timeline", "transactions", "members",
];

// Perspective ids (lib/perspectives.ts) that route to an existing real
// Personal tab. Lenses absent from this map (wealth, cashFlow) render as
// "comingSoon" cards with no click-through — no Perspective business logic
// is implemented in this pass, only routing to what already exists.
const PERSONAL_PERSPECTIVE_TARGETS: Partial<Record<string, PersonalTab>> = {
  investments: "investments",
  debt:        "credit",
  // "goals" deliberately has no target on Personal (v2.5 modal usability
  // pass): the Personal Space has no goals feature yet — the old target
  // opened a modal whose only content was a coming-soon panel, so the card
  // looked available but led nowhere. With no target, PerspectivesWidget
  // renders it with the honest "Soon" badge instead. Goals stays fully
  // real on shared Spaces (SpaceDashboard's GoalsCard). Restore the
  // mapping when Personal goals ship.
};

// ── Filter config ─────────────────────────────────────────────────────────────
const ACCOUNT_TYPES: Record<PersonalTab, string[]> = {
  dashboard:    ["checking", "savings", "investment", "crypto", "debt", "other"],
  banking:      ["checking", "savings", "debt"],
  investments:  ["investment", "crypto"],
  credit:       ["debt"],
  goals:        [],
  activity:     [],
  settings:     [],
  perspectives: [],
  timeline:     [],
  finances:     [],
  transactions: [],
  members:      [],
  documents:    [],
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

// Step C: account-type icon tint neutralised to a single ink chip — colour is
// reserved for financial state (account-type precedent from AccountCard).
const TYPE_ICON_CLS: Record<AccountType, string> = {
  checking:   "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
  savings:    "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
  investment: "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
  crypto:     "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
  debt:       "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
  other:      "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
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
    <div className={`bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-2xl overflow-hidden${fill ? " flex flex-col h-full" : ""}`}>
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

// ── Component ─────────────────────────────────────────────────────────────────
// `advice` stays in Props (the server page still passes it) but is no
// longer destructured — the OverviewBriefPanel that consumed it was removed
// until D5 makes the pipeline real (Space Template Redesign).
export function DashboardClient({
  spaceId, spaceName, category, myRole, currentUserId,
  accounts, holdings, snapshots, ficoScore, ficoUpdatedAt, debtTransactions,
  transactions,
}: Props) {
  const router        = useRouter();
  const searchParams  = useSearchParams();
  const { data: session } = useSession();
  const firstName = session?.user?.name?.split(" ")[0] ?? "";
  const [walletOpen,      setWalletOpen]      = useState(false);
  const [assetOpen,       setAssetOpen]       = useState(false);
  const [manageOpen,      setManageOpen]      = useState(false);
  const [manageSpaceOpen, setManageSpaceOpen] = useState(false);
  const [editingAssetId,  setEditingAssetId]  = useState<string | null>(null);
  const [editingAssetVal, setEditingAssetVal] = useState("");
  const [savingAsset,     setSavingAsset]     = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingAsset,   setDeletingAsset]   = useState(false);
  const [timelineEvents,  setTimelineEvents]  = useState<TimelineEvent[] | null>(null);

  // Perspective Engine results (commit 8) — keyed by lensId, one batch
  // fetch against the membership-gated route (the Personal Space is a
  // Space like any other; same route SpaceDashboard uses). null = not
  // loaded / failed → lens-backed cards render their static description
  // (the widget's graceful-fallback contract).
  const [lensResults, setLensResults] = useState<Record<string, LensResult> | null>(null);
  const [memberCount,     setMemberCount]     = useState<number | null>(null);

  const initialTab = (searchParams.get("tab") ?? "dashboard") as PersonalTab;

  const [filter, setFilter] = useState<PersonalTab>(
    VALID_TABS.includes(initialTab) ? initialTab : "dashboard"
  );
  const [chartInterval, setChartInterval] = useState<Interval>("1M");
  const [chartExpanded, setChartExpanded] = useState(false);
  // Which series the Net Worth chart modal opens focused on — lets the
  // Total Assets/Total Liabilities KPI tiles (IA refactor point 4) reuse
  // this same chart/modal instead of each needing its own.
  const [chartSeries, setChartSeries] = useState<SeriesKey>("netWorth");
  // Cash Flow KPI tile modal — reuses RecentTransactionsPanel (the same
  // real transactions already fetched for the Overview preview) shown in
  // full, no new aggregation logic.
  const [cashFlowModalOpen, setCashFlowModalOpen] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  // Overview composition switcher (IA refactor point 2/3) — which
  // full-canvas lens Overview currently renders. "overview" (Atlas) is the
  // real, always-available composition; any other value is a comingSoon
  // "Financial"-group lens (Wealth, Cash Flow) with no real composition
  // built yet, so the host shows a calm SpaceComingSoonPanel instead of
  // the real Overview content. Local UI state only — never round-trips
  // through the URL the way `filter` does, since switching composition
  // isn't navigation.
  const [composition, setComposition] = useState<string>("overview");

  // Sub-nav state for the full Perspectives and Timeline tabs — placeholder
  // UI pattern for now (client-side filtering only), see project notes.
  const [perspectivesGroup, setPerspectivesGroup] = useState<"All" | PerspectiveGroup>("All");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilterId>("all");
  // "Now" for the today/week/month buckets below, captured at click time
  // (see handleTimelineFilterChange) rather than read during render — same
  // reason SpaceDashboard.tsx's TrashDrawer takes its timestamp from an
  // event handler instead of calling Date.now() inside a render-phase
  // computation (react-hooks/purity).
  const [timelineNow, setTimelineNow] = useState(0);

  const handleTimelineFilterChange = useCallback((id: TimelineFilterId) => {
    setTimelineNow(Date.now());
    setTimelineFilter(id);
  }, []);

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

  // Data freshness for the header subtitle (v2.5 honesty slice) — relative
  // time is client-local (formatRelativeTime is not SSR-safe, see its doc
  // comment), and `accounts` arrives as an SSR prop here, so read it
  // through useSyncExternalStore with a null server snapshot: the server
  // renders nothing, the client fills in "· Updated 2 hr ago" at hydration.
  // Same pattern as OverviewBriefPanel's getGreeting().
  const dataUpdatedAgo = useSyncExternalStore(
    () => () => {},
    () => (newestAccountDate ? formatRelativeTime(newestAccountDate) : null),
    () => null,
  );

  // ── Overview KPI row derived data ─────────────────────────────────────────
  // Net Worth % change — same formula NetWorthCard already used (prevWorth =
  // current − Δ), just computed against the full-portfolio classification
  // instead of the tab-scoped one. null when there's no snapshot history yet
  // (no fabricated "0.0%" on a brand-new Space).
  const netWorthChangePct = useMemo(() => {
    if (!latest) return null;
    const prevWorth = classification.netWorth - changeForInterval;
    return prevWorth !== 0 ? (changeForInterval / Math.abs(prevWorth)) * 100 : 0;
  }, [latest, classification.netWorth, changeForInterval]);

  // Cash Flow (MTD) — real signed sum of this calendar month's transactions
  // (income − spend), with a vs.-last-month % change when last month has any
  // transactions to compare against. No new query: same getTransactions()
  // rows already flowing into the Banking tab's history.
  const cashFlow = useMemo(() => {
    const now = new Date();
    const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
    const thisYm = ym(now.getFullYear(), now.getMonth());
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevYm = ym(prevDate.getFullYear(), prevDate.getMonth());

    const sumForMonth = (label: string) =>
      transactions.filter((t) => t.date.slice(0, 7) === label).reduce((s, t) => s + t.amount, 0);

    const mtd = sumForMonth(thisYm);
    const hasPrevMonth = transactions.some((t) => t.date.slice(0, 7) === prevYm);
    const prev = hasPrevMonth ? sumForMonth(prevYm) : null;
    const changePct = prev !== null && prev !== 0 ? ((mtd - prev) / Math.abs(prev)) * 100 : null;

    return { mtd, changePct };
  }, [transactions]);

  const isBanking      = filter === "banking";
  const isInvestments  = filter === "investments";
  const isCredit       = filter === "credit";
  // "goals" has no is* flag or render block on Personal (v2.5 modal
  // usability pass) — it's absent from VALID_TABS and
  // PERSONAL_PERSPECTIVE_TARGETS, so `filter` can never hold it. The
  // PersonalTab member remains valid.
  const isActivity     = filter === "activity";
  const isSettings     = filter === "settings";
  const isPerspectives = filter === "perspectives";
  const isTimeline     = filter === "timeline";
  // "finances" / "documents" have no is* flag or render block anymore
  // (v2.5 honesty slice) — they're absent from VALID_TABS and MORE_MENU_ITEMS,
  // so `filter` can never hold them. The PersonalTab members remain valid.
  const isTransactions = filter === "transactions";
  const isMembers      = filter === "members";

  const isStaticTab =
    isActivity || isSettings ||
    isPerspectives || isTimeline || isTransactions || isMembers;

  // ── Perspectives (lib/perspectives.ts) ────────────────────────────────────
  // Routes to existing, real Personal tabs — no new business logic. Lenses
  // without a target (wealth, cashFlow) render as non-interactive "Coming
  // soon" cards.
  // "overview" is filtered out here, not in lib/perspectives.ts: it's never
  // a clickable Perspective *card* (see that file's doc comment on the
  // id) — only the PerspectiveSwitcher dropdown above renders it.
  const perspectiveItems: PerspectiveCardItem[] = useMemo(
    () =>
      getPerspectivesForCategory(category)
        .filter((p) => p.id !== "overview")
        .map((p) => {
          const target = PERSONAL_PERSPECTIVE_TARGETS[p.id];
          // Engine answer for lens-backed cards (liquidity, debt). Missing
          // key (fetch pending/failed, or a server-side "error" result) →
          // undefined → static description, exactly as before.
          const result = p.lensId ? lensResults?.[p.lensId] : undefined;
          return target
            ? { ...p, result, onSelect: () => handleFilterChange(target) }
            : { ...p, result };
        }),
    [category, handleFilterChange, lensResults]
  );

  // Perspectives sub-nav filter — client-side only, same items, just scoped
  // to the selected group ("All" shows everything).
  const filteredPerspectiveItems = useMemo(
    () =>
      perspectivesGroup === "All"
        ? perspectiveItems
        : perspectiveItems.filter((p) => p.group === perspectivesGroup),
    [perspectiveItems, perspectivesGroup]
  );

  // Overview composition switcher options (IA refactor point 2/3) — see
  // getCompositionSwitcherItems' doc comment for the inclusion rule.
  const compositionItems = useMemo(() => getCompositionSwitcherItems(category), [category]);
  const activeComposition = compositionItems.find((p) => p.id === composition);

  // Rail/dropdown polish pass: the Perspective control in the rail is
  // placeholder-only for now — selecting an item still updates `composition`
  // (state above), but Overview intentionally keeps rendering its default
  // body regardless, so half-built "coming soon" swaps don't compete with
  // the rail UI work this pass is actually about. The swap logic below is
  // real, not deleted — this is the single toggle that re-enables it.
  // TODO(composition-switching): flip to true (or remove the flag and
  // always branch on `composition`) once a Wealth or Cash Flow composition
  // has real content to show in place of the KPI/chart Overview body.
  const COMPOSITION_SWITCHING_ENABLED: boolean = false;

  // ── Timeline (lib/timeline-types.ts) ───────────────────────────────────────
  // Real events from the existing, unmodified activity route ONLY. v2.5
  // honesty slice: FUTURE_TIMELINE_EVENTS preview rows are no longer merged
  // in — the timeline shows what actually happened, and the presenter's
  // built-in empty state takes over when that's nothing. Event types with
  // no producer yet (document upload, AI recommendation, etc.) simply don't
  // appear until their producers ship.
  useEffect(() => {
    let active = true;
    fetch(`/api/spaces/${spaceId}/activity`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((data) => {
        if (!active) return;
        const real: TimelineEvent[] = data?.events ?? [];
        real.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setTimelineEvents(real);
      })
      .catch(() => { if (active) setTimelineEvents([]); });
    return () => { active = false; };
  }, [spaceId]);

  // Perspective Engine results — mirrors the activity fetch above; any
  // failure (network, 403, malformed) resolves to null and the cards keep
  // their static descriptions.
  useEffect(() => {
    let active = true;
    fetch(`/api/spaces/${spaceId}/perspectives`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active) return;
        const results: LensResult[] = Array.isArray(data?.results) ? data.results : [];
        setLensResults(
          results.length
            ? Object.fromEntries(results.map((res) => [res.lensId, res]))
            : null,
        );
      })
      .catch(() => { if (active) setLensResults(null); });
    return () => { active = false; };
  }, [spaceId]);

  // Timeline sub-nav filter — date-range buckets computed against each
  // event's real `date`; AI/Transactions/Documents bucket by `type` (the
  // same `type` strings the activity route and timeline-placeholder.ts
  // already emit — see TIMELINE_FILTERS above). Client-side only, same
  // events array, no new fetching. Reads timelineNow (captured at click
  // time, see handleTimelineFilterChange above) instead of calling
  // Date.now() here, so this stays a pure render-phase computation.
  const filteredTimelineEvents = useMemo(() => {
    const events = timelineEvents ?? [];
    if (timelineFilter === "all") return events;

    if (timelineFilter === "today" || timelineFilter === "week" || timelineFilter === "month") {
      const days = timelineFilter === "today" ? 1 : timelineFilter === "week" ? 7 : 30;
      const cutoff = timelineNow - days * 24 * 60 * 60 * 1000;
      return events.filter((e) => new Date(e.date).getTime() >= cutoff);
    }

    const typeMatch: Record<"ai" | "transactions" | "documents", (t: string) => boolean> = {
      ai:           (t) => t === "ai_recommendation" || t.toLowerCase().includes("ai"),
      transactions: (t) => t === "transaction",
      documents:    (t) => t === "document_upload",
    };
    return events.filter((e) => typeMatch[timelineFilter](e.type));
  }, [timelineEvents, timelineFilter, timelineNow]);

  // Header subtitle member count — same read-only space-detail endpoint
  // SpaceMembersWidget uses; kept as its own tiny fetch so the header never
  // waits on (or couples to) whichever tab happens to be active.
  useEffect(() => {
    let active = true;
    fetch(`/api/spaces/${spaceId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setMemberCount(data?.members?.length ?? null); })
      .catch(() => { if (active) setMemberCount(null); });
    return () => { active = false; };
  }, [spaceId]);

  // ── Account section rows (shared across tabs) ─────────────────────────────
  const accountSections = (
    <div className="space-y-3">
      {SECTION_ORDER.filter(({ type }) => allowedTypes.includes(type)).map(({ label, type }) => {
        const accts   = filtered.filter((a) => a.type === type).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
        const isEmpty = accts.length === 0;
        const isOpen  = !sectionCollapsed[type];
        const isDebt  = type === "debt";
        const Icon    = TYPE_ICON[type as AccountType] ?? Building2;
        const iconCls = TYPE_ICON_CLS[type as AccountType] ?? "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

        const sectionTotal = accts.reduce((s, a) => s + a.balance, 0);
        const newestSync   = !isEmpty
          ? accts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accts[0].lastUpdated)
          : null;

        return (
          <div
            key={type}
            className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--surface-muted)] overflow-hidden"
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
                  : "hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover-strong)] cursor-pointer"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${iconCls}`}>
                  <Icon size={15} />
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-white leading-tight">{label}</p>
                  <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5">
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
                      ? sectionTotal > 0 ? "text-[var(--accent-negative)]" : "text-[var(--accent-positive)]"
                      : "text-white"
                  }`}>
                    {fmtAbs(Math.abs(sectionTotal))}
                  </p>
                )}
                {/* Real <button> — valid here because the parent is a <div>, not a <button> */}
                {type === "other" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setAssetOpen(true); }}
                    className="text-[11px] font-semibold text-[var(--accent-info)] hover:text-[var(--accent-info)] bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] px-2 py-1 rounded-lg transition-colors leading-none"
                  >
                    + Add
                  </button>
                )}
                {!isEmpty && (
                  isOpen
                    ? <ChevronUp   size={16} className="text-[var(--text-muted)] shrink-0" />
                    : <ChevronDown size={16} className="text-[var(--text-muted)] shrink-0" />
                )}
              </div>
            </div>

            {isEmpty && (
              <div className="border-t border-[var(--border-hairline)] px-4 py-3 flex flex-wrap items-center gap-2">
                {type !== "other" && <ConnectAccountButton />}
                {type === "crypto" && (
                  <button
                    onClick={() => setWalletOpen(true)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] bg-[var(--surface-inset)] hover:bg-[var(--surface-hover-strong)] border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] px-3 py-2 rounded-xl transition-colors"
                  >
                    + Add Wallet
                  </button>
                )}
                {type === "other" && (
                  <button
                    onClick={() => setAssetOpen(true)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-info)] bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] px-3 py-2 rounded-xl transition-colors"
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
                  <div className="border-t border-[var(--border-hairline)] bg-[var(--surface-muted)]">
                    {accts.map((a, idx) => {
                      const coinSymbol  = a.walletChain ?? exchangeSymbol(a.institution);
                      const isManual    = a.syncStatus === "manual";
                      const isEditing   = editingAssetId === a.id;
                      const borderCls   = idx < accts.length - 1 ? "border-b border-[var(--border-hairline)]" : "";

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
                                  <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5">Manual · Updated {formatDate(a.lastUpdated)}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0 ml-3">
                                {!isEditing && !isConfirmingDelete && (
                                  <>
                                    <p className="text-sm font-semibold tabular-nums text-white mr-1">{fmtAbs(a.balance)}</p>
                                    <button
                                      onClick={() => { setEditingAssetId(a.id); setEditingAssetVal(String(a.balance)); }}
                                      className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--accent-info)] hover:bg-[var(--surface-inset)] transition-colors"
                                      title="Update value"
                                    >
                                      <Pencil size={13} />
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteId(a.id)}
                                      className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--accent-negative)] hover:bg-[var(--surface-hover)] transition-colors"
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
                                  className="flex-1 bg-[var(--surface-inset)] border border-[var(--border-hairline)] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-info)] focus:ring-1 focus:ring-[var(--border-hairline-strong)]"
                                  placeholder="New value"
                                  autoFocus
                                />
                                <button
                                  onClick={() => saveAssetBalance(a.id)}
                                  disabled={savingAsset}
                                  className="w-8 h-8 flex items-center justify-center rounded-xl bg-[var(--accent-info)] text-white transition-colors disabled:opacity-50"
                                >
                                  {savingAsset ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                                </button>
                                <button
                                  onClick={() => setEditingAssetId(null)}
                                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] px-2"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                            {/* Inline delete confirmation row */}
                            {isConfirmingDelete && (
                              <div className="pb-3.5 flex items-center justify-between gap-3">
                                <p className="text-xs text-[var(--text-secondary)]">Archive <span className="text-white font-medium">{a.name}</span>? You can restore it from <span className="text-[var(--text-secondary)]">Settings → Archived Assets</span>.</p>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    onClick={() => setConfirmDeleteId(null)}
                                    disabled={deletingAsset}
                                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] transition-colors disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => deleteAsset(a.id)}
                                    disabled={deletingAsset}
                                    className="flex items-center gap-1.5 text-xs font-semibold text-white bg-[var(--accent-negative)] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
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
                          className={`w-full flex items-center justify-between pl-6 pr-4 py-3.5 hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover-strong)] transition-colors touch-manipulation text-left ${borderCls}`}
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
                              <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5">{a.institution}</p>
                            </div>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className={`text-sm font-semibold tabular-nums ${
                              isDebt
                                ? a.balance > 0 ? "text-[var(--accent-negative)]" : "text-[var(--accent-positive)]"
                                : "text-white"
                            }`}>
                              {fmtAbs(Math.abs(a.balance))}
                            </p>
                            <p className="text-xs text-[var(--text-faint)] mt-0.5">{formatDate(a.lastUpdated)}</p>
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
          <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--surface-muted)] overflow-hidden">
            <button
              onClick={() => toggleSection(sectionKey)}
              className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover-strong)] transition-colors touch-manipulation select-none"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: "var(--surface-inset)" }}>
                  <TrendingUp size={15} style={{ color: "var(--text-secondary)" }} />
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-white leading-tight">Brokerage Cash</p>
                  <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5">
                    {investableAccounts.length} account{investableAccounts.length !== 1 ? "s" : ""} · Updated {formatDate(newestSync)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>
                  {fmtAbs(sectionTotal)}
                </p>
                {isOpen
                  ? <ChevronUp   size={16} className="text-[var(--text-muted)] shrink-0" />
                  : <ChevronDown size={16} className="text-[var(--text-muted)] shrink-0" />
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
                <div className="border-t border-[var(--border-hairline)] bg-[var(--surface-muted)]">
                  {investableAccounts.map(({ account: a, cashAmount }, idx) => {
                    const coinSymbol = a.walletChain ?? exchangeSymbol(a.institution);
                    return (
                      <button
                        key={a.id}
                        onClick={() => setSelectedAccount(a)}
                        className={`w-full flex items-center justify-between pl-6 pr-4 py-3.5 hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover-strong)] transition-colors touch-manipulation text-left ${
                          idx < investableAccounts.length - 1 ? "border-b border-[var(--border-hairline)]" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {a.type === "crypto" ? (
                            <CoinIcon symbol={coinSymbol} size={28} />
                          ) : (
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--surface-inset)" }}>
                              <TrendingUp size={13} style={{ color: "var(--text-secondary)" }} />
                            </div>
                          )}
                          <div>
                            <p className="text-sm font-medium text-white leading-tight">{a.name}</p>
                            <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5">{a.institution}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>
                            {fmtAbs(cashAmount)}
                          </p>
                          <p className="text-xs text-[var(--text-faint)] mt-0.5">{formatDate(a.lastUpdated)}</p>
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
            {firstName ? `${possessive(firstName)} Space` : "My Space"}
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Personal{memberCount !== null ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : ""}
            {dataUpdatedAgo ? ` · Updated ${dataUpdatedAgo}` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          <div className="relative">
            <button
              onClick={() => setManageOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:text-white hover:bg-[var(--surface-hover)] transition-colors border border-[var(--border-hairline)] hover:border-[var(--border-hairline)]"
            >
              <FolderOpen size={13} />
              Manage
            </button>

          {manageOpen && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-30" onClick={() => setManageOpen(false)} />
              {/* Dropdown */}
              <div className="absolute right-0 top-full mt-1.5 z-40 w-56 border rounded-2xl shadow-2xl overflow-hidden" style={{ background: "var(--modal-surface)", borderColor: "var(--border-hairline-strong)" }}>
                <Link
                  href="/dashboard/accounts"
                  onClick={() => setManageOpen(false)}
                  className="flex items-center justify-between px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-white">Accounts</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">Manage linked accounts</p>
                  </div>
                  <ArrowUpRight size={14} className="text-[var(--text-muted)] shrink-0" />
                </Link>
                <div className="border-t border-[var(--border-hairline)]">
                  <button
                    onClick={() => { setManageOpen(false); setAssetOpen(true); }}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors"
                  >
                    <div className="text-left">
                      <p className="text-sm font-medium text-white">Add Manual Asset</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">Real estate, vehicles, etc.</p>
                    </div>
                    <ArrowUpRight size={14} className="text-[var(--text-muted)] shrink-0" />
                  </button>
                </div>
                <div className="border-t border-[var(--border-hairline)]">
                  <Link
                    href="/dashboard/settings/archived-assets"
                    onClick={() => setManageOpen(false)}
                    className="flex items-center justify-between px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors"
                  >
                    <div>
                      <p className="text-sm font-medium text-white">Archived Assets</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">Restore or delete</p>
                    </div>
                    <ArrowUpRight size={14} className="text-[var(--text-muted)] shrink-0" />
                  </Link>
                </div>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      {/* Tab navigation — Personal's trimmed rail: the single-segment
          Overview pill, the Perspective switcher + its "Default view"
          caption right after it, and a "More" menu (Accounts/Transactions/
          Members/Documents) pinned to the far right via ml-auto. Both
          dropdowns are absolutely-positioned overlays (see MoreMenu.tsx /
          PerspectiveSwitcher.tsx) — opening one never pushes this row's
          height or the KPI cards below. No overflow-x-auto here: the rail
          is down to 3-4 short controls now, so it no longer needs the
          horizontal-scroll affordance the old 8-pill rail required (that
          also avoids `overflow-x-auto` implicitly clipping the dropdowns'
          vertical overflow via its overflow-y:auto side effect). */}
      <div className="relative flex items-center gap-2 w-full">
        <SegmentedControl
          aria-label="Space section"
          options={PERSONAL_TABS.map((tab) => ({ id: tab.key, label: tab.label }))}
          value={filter}
          onChange={handleFilterChange}
        />

        {/* v2.5 honesty slice: switcher renders only when a second REAL
            composition exists (status "available") — same gate as
            SpaceDashboard. While COMPOSITION_SWITCHING_ENABLED is false the
            control was a no-op anyway; hiding it removes a dead control
            rather than a working one. Re-appears when a Wealth/Cash Flow
            composition ships as "available" in lib/perspectives.ts. */}
        {compositionItems.filter((p) => p.status === "available").length > 1 && (
          <>
            <PerspectiveSwitcher items={compositionItems} value={composition} onChange={setComposition} />
            <span className="hidden sm:inline text-xs font-medium text-[var(--text-muted)] px-1 shrink-0">
              Default view
            </span>
          </>
        )}

        <MoreMenu items={MORE_MENU_ITEMS} onSelect={handleFilterChange} className="ml-auto" align="right" />
      </div>

      {walletOpen && <AddWalletModal onClose={() => setWalletOpen(false)} />}
      {assetOpen  && <AddManualAssetModal onClose={() => setAssetOpen(false)} />}
      {manageSpaceOpen && (
        <ManageSpaceModal
          spaceId={spaceId}
          spaceName={spaceName}
          myRole={myRole}
          currentUserId={currentUserId}
          onClose={() => setManageSpaceOpen(false)}
          onRefresh={() => router.refresh()}
        />
      )}

      {/* Timeline modal — replaces the old inline Timeline tab body. Reuses
          `filter`/isTimeline/isActivity as the open/closed flag instead of
          adding a parallel boolean: it's the same toggle that already
          round-trips through the URL (?tab=timeline, ?tab=activity), so
          deep links and the "View full timeline" affordance below keep
          working unchanged — only the render target moved from a tab body
          to a modal. */}
      {(isTimeline || isActivity) && (
        <TimelineModal
          events={filteredTimelineEvents}
          loading={timelineEvents === null}
          filters={TIMELINE_FILTERS}
          filterValue={timelineFilter}
          onFilterChange={handleTimelineFilterChange}
          onClose={() => handleFilterChange("dashboard")}
        />
      )}

      {/* Credit/Debt — Glass modal (IA refactor points 4 & 5), launched from
          either the Credit Score KPI tile or the Debt Perspective card; both
          just set filter="credit", so there's one render path, not two.
          DebtClient itself is untouched — same FICO state, payoff/interest
          calculators, and debt accounts/transactions it always had, just
          shown in a floating sheet instead of swapping the whole tab. */}
      {isCredit && (
        <GlassModal title="Debt" subtitle="FICO, balances, and payoff pace" icon={CreditCard} size="xl" onClose={() => handleFilterChange("dashboard")}>
          <DebtClient
            initialFico={ficoScore}
            lastUpdatedAt={ficoUpdatedAt}
            accounts={accounts.filter((a) => a.type === "debt")}
            transactions={debtTransactions}
          />
        </GlassModal>
      )}

      {/* Investments — Glass modal (IA refactor points 4 & 5), launched
          from the Investments Perspective card. Portfolio/Holdings/charts
          and the account list below are untouched, just shown in a
          floating sheet instead of swapping the whole tab. */}
      {isInvestments && (
        <GlassModal title="Investments" subtitle="Portfolio, performance, and holdings" icon={TrendingUp} size="xl" onClose={() => handleFilterChange("dashboard")}>
          <div className="space-y-3">
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

            {accountSections}
          </div>
        </GlassModal>
      )}

      {/* Goals — no modal on Personal (v2.5 modal usability pass): the
          Goals Perspective card renders with a "Soon" badge instead of
          opening a coming-soon modal. See PERSONAL_PERSPECTIVE_TARGETS. */}

      {/* Perspectives tab — full grid. Same library/routing as the Overview
          row, just every card instead of a scroller, plus a group sub-nav
          for when a Space accumulates many lenses. */}
      {isPerspectives && (
        <div className="space-y-3">
          <InlineFilter
            options={PERSPECTIVE_GROUPS.map((g) => ({ id: g, label: g }))}
            value={perspectivesGroup}
            onChange={setPerspectivesGroup}
            aria-label="Filter Perspectives"
            align="start"
          />
          <PerspectivesWidget items={filteredPerspectiveItems} variant="grid" />
        </div>
      )}

      {/* Timeline — no longer an inline tab body (point 1 of the IA
          refactor: Timeline is a modal, not a rail page). isTimeline/
          isActivity (stale ?tab=activity deep links land here too) now
          just gate the TimelineModal mount below, instead of switching
          what renders in the tab content area. */}

      {/* Finances / Documents — no render block on this host (v2.5 honesty
          slice): both ids are absent from VALID_TABS and MORE_MENU_ITEMS,
          so `filter` can never hold them. See lib/space-nav.ts
          PLACEHOLDER_SPACE_TABS. */}

      {/* Transactions tab — unified transaction list for this Space.
          Data comes from the existing getTransactions() fetch (same data that
          feeds the Overview's RecentTransactionsPanel and AI context), so no
          additional server request is needed. */}
      {isTransactions && (
        <SpaceTransactionsPanel
          transactions={transactions}
          accounts={accounts}
        />
      )}

      {/* Members tab — real data via the existing space-detail endpoint
          (same one ManageSpaceModal already uses). */}
      {isMembers && (
        <SpaceMembersWidget spaceId={spaceId} onManage={() => setManageSpaceOpen(true)} />
      )}

      {/* Settings tab */}
      {isSettings && (
        <div className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-2xl overflow-hidden divide-y divide-[var(--border-hairline)]">
          {[
            { href: "/dashboard/settings", label: "Settings",  sub: "Profile, password, and account preferences" },
            { href: "/dashboard/advice",   label: "AI Advice", sub: "View your latest financial insights" },
          ].map(({ href, label, sub }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover-strong)] transition-colors"
            >
              <div>
                <p className="text-sm font-medium text-white">{label}</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{sub}</p>
              </div>
              <ArrowUpRight size={15} className="text-[var(--text-muted)] shrink-0" />
            </Link>
          ))}
        </div>
      )}

      {/* Overview / Banking */}
      {!isCredit && !isInvestments && !isStaticTab && (
        <div className="space-y-3">

          {/* ── Dashboard (Overview) — executive summary, not an accordion ── */}
          {filter === "dashboard" && (
            <>
              {/* Composition switcher lives inline in the rail above (right
                  after the Overview pill) — this just reacts to it.
                  COMPOSITION_SWITCHING_ENABLED is currently false (see
                  above), so this always falls through to the real Overview
                  body for now. */}
              {COMPOSITION_SWITCHING_ENABLED && composition !== "overview" && activeComposition ? (
                <SpaceComingSoonPanel
                  icon={(() => {
                    const Icon = COMPOSITION_ICON_MAP[activeComposition.icon] ?? Compass;
                    return <Icon size={20} />;
                  })()}
                  title={activeComposition.label}
                  description={activeComposition.description}
                />
              ) : accounts.length === 0 ? (
                /* Day-zero Overview (v2.5 honesty slice): one consolidated
                   setup card instead of an all-zero KPI strip, empty charts,
                   and empty previews. Uses the existing ConnectAccountButton
                   — no new concepts. */
                <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-8 text-center">
                  <Landmark size={24} className="text-[var(--text-muted)] mx-auto mb-3" />
                  <p className="text-base font-semibold text-[var(--text-primary)]">Connect your first account</p>
                  <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-md mx-auto leading-relaxed">
                    Net worth, cash flow, and activity appear here once an account is
                    connected. Everything on this dashboard is computed from real data —
                    sections appear as their data exists.
                  </p>
                  <div className="flex justify-center mt-5">
                    <ConnectAccountButton />
                  </div>
                </GlassPanel>
              ) : (
              <>
              {/* KPI strip — Net Worth, Assets, Liabilities, Cash Flow, Credit Score */}
              <KpiRow
                netWorth={classification.netWorth}
                netWorthChangePct={netWorthChangePct}
                totalAssets={classification.totalAssets}
                totalLiabilities={classification.totalLiabilities}
                cashFlowMTD={cashFlow.mtd}
                cashFlowChangePct={cashFlow.changePct}
                ficoScore={ficoScore}
                onNetWorthClick={() => { setChartSeries("netWorth"); setChartExpanded(true); }}
                onAssetsClick={() => { setChartSeries("totalAssets"); setChartExpanded(true); }}
                onLiabilitiesClick={() => { setChartSeries("totalDebt"); setChartExpanded(true); }}
                onCashFlowClick={() => setCashFlowModalOpen(true)}
                onCreditClick={() => handleFilterChange("credit")}
              />

              {/* Net Worth / Allocation — two columns on desktop. The AI
                  Daily Brief panel was removed from this row (Space
                  Template Redesign): its pipeline is a stub (D5 —
                  run-ai-advice never runs), and a hero-adjacent slot can't
                  be held by a placeholder. The slot returns as "Briefing"
                  when D5 ships. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
                <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
                  <div className="flex items-center justify-between px-1 mb-2">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">Net Worth</p>
                    <button
                      onClick={() => setChartExpanded(true)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors touch-manipulation"
                    >
                      <Maximize2 size={14} />
                    </button>
                  </div>
                  <NetWorthChart
                    snapshots={snapshots}
                    interval={chartInterval}
                    onIntervalChange={setChartInterval}
                    fill
                  />
                </GlassPanel>

                <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
                  <p className="text-sm font-semibold text-[var(--text-primary)] px-1 mb-2">Allocation</p>
                  <AllocationChart
                    cash={allocation.cash}
                    investments={allocation.investments}
                    crypto={allocation.crypto}
                    debt={allocation.debt}
                    realAssets={allocation.realAssets}
                  />
                </GlassPanel>

              </div>

              {/* Perspectives row — lenses into this Space's data, routed
                  to existing real tabs where one exists. */}
              <div>
                <div className="flex items-center justify-between px-1 mb-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Perspectives</p>
                  <button
                    type="button"
                    onClick={() => handleFilterChange("perspectives")}
                    className="text-xs font-medium text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors"
                  >
                    See all
                  </button>
                </div>
                <PerspectivesWidget items={perspectiveItems} variant="row" />
              </div>

              {/* Compact history previews — Recent Activity + Recent Transactions,
                  small "View all" cards, not giant accordions. */}
              <div className="md:grid md:grid-cols-2 md:gap-3 space-y-3 md:space-y-0">
                <SpaceTimelinePanel
                  title="Recent activity"
                  events={timelineEvents ?? []}
                  loading={timelineEvents === null}
                  variant="preview"
                  previewCount={4}
                  onViewAll={() => handleFilterChange("timeline")}
                />
                <RecentTransactionsPanel
                  transactions={transactions}
                  previewCount={5}
                  onViewAll={() => handleFilterChange("transactions")}
                />
              </div>
              </>
              )}
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

          {/* Account sections — Banking only now; Investments moved into its
              own GlassModal above (IA refactor point 5), Overview is a KPI +
              chart + preview executive summary, not an accordion. */}
          {isBanking && accountSections}
        </div>
      )}

      {/* Net Worth chart modal — also doubles as the Total Assets/Total
          Liabilities KPI tile modal (IA refactor point 4), just opened
          pre-focused on a different series of the same chart. */}
      {chartExpanded && (
        <NetWorthChartModal
          snapshots={snapshots}
          initialInterval={chartInterval}
          initialSeries={chartSeries}
          onClose={() => { setChartExpanded(false); setChartSeries("netWorth"); }}
        />
      )}

      {/* Cash Flow KPI tile modal — the real transactions behind the Cash
          Flow (MTD) number, reusing RecentTransactionsPanel as-is. */}
      {cashFlowModalOpen && (
        <GlassModal
          title="Cash Flow"
          subtitle="Every transaction behind this month's number"
          onClose={() => setCashFlowModalOpen(false)}
          size="lg"
        >
          <RecentTransactionsPanel transactions={transactions} previewCount={transactions.length} />
        </GlassModal>
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
