"use client";

/**
 * SpaceDashboard
 *
 * Rendered for any non-PERSONAL space. Driven by SpaceDashboardSection
 * rows fetched from GET /api/spaces/[id]/sections.
 *
 * - Tabs are derived from enabled sections in TAB_ORDER
 * - Default tab is the first tab that has enabled sections (never SETTINGS by default)
 * - OWNER/ADMIN can toggle sections via the Settings tab
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, LayoutDashboard, Target, Landmark,
  CreditCard, TrendingUp, Settings, Plus,
  ChevronDown, ChevronUp,
  CheckCircle2, Circle, Calendar, AlertCircle,
  X, MoreHorizontal, Archive, Trash2, RotateCcw, LogOut,
  Compass, PiggyBank, GripVertical, Maximize2,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, arrayMove,
  useSortable, sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CATEGORY_LABELS, SpaceCategory } from "@/lib/space-presets";
import { getWidgetMeta } from "@/lib/widget-registry";
import { AssetValueWidget, type AssetValueConfig } from "@/components/space/widgets/AssetValueWidget";
import { ProgressWidget, type ProgressStat } from "@/components/space/widgets/ProgressWidget";
import { type BreakdownViewMode } from "@/components/space/widgets/BreakdownWidget";
import { SummaryWidget } from "@/components/space/widgets/SummaryWidget";
import { InvestmentAccountsWidget } from "@/components/space/widgets/InvestmentAccountsWidget";
// Unified Space Widget Layout (slice 1) — Personal Overview lede widgets, now
// section-backed (net_worth_chart + allocation).
import { NetWorthChart, type Interval } from "@/components/charts/NetWorthChart";
import { NetWorthChartModal } from "@/components/charts/NetWorthChartModal";
import { AllocationChart } from "@/components/charts/AllocationChart";
import { classifyAccounts } from "@/lib/account-classifier";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate, formatRelativeTime, displaySpaceName } from "@/lib/format";
import { ManageSpaceModal } from "@/components/dashboard/ManageSpaceModal";
import { simulatePayoff } from "@/components/space/sections/DebtPayoffSection";
import { renderDebtBreakdownChart, renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import {
  renderWealthByAccount,
  renderWealthAccountCards,
  renderInstitutionAllocation,
  renderAssetAllocation,
  renderWealthAllocationChart,
  renderWealthConcentration,
} from "@/components/space/widgets/wealth-adapters";
import {
  renderLiquidityLadder,
  renderAccessibleCash,
  renderEmergencyFundReadiness,
  renderLiquidityConcentration,
} from "@/components/space/widgets/liquidity-adapters";
import {
  renderCashFlowSummary,
  renderCashFlowHistory,
  renderIncomeVsSpending,
  renderCashFlowByCategory,
  renderIncomeBySource,
  renderDebtPayments,
} from "@/components/space/widgets/cash-flow-adapters";
import {
  renderDebtByAccount,
  renderDebtCost,
  CreditUtilizationWidget,
  renderDebtHistory,
  renderCreditScore,
  renderDebtCompleteInfo,
} from "@/components/space/widgets/debt-perspective-adapters";
import {
  renderGoalProgress,
  renderGoalOnTrack,
  renderGoalRequiredPace,
  renderGoalFundingGap,
} from "@/components/space/widgets/goals-perspective-adapters";
import {
  DEFAULT_CASH_FLOW_PERIOD,
  periodLabel,
  isExplicitPeriod,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { usePerspectiveShellState } from "@/components/space/shell/usePerspectiveShellState";
import { inferPerspectiveTimePreset } from "@/lib/perspectives/time-range";
import { resolvePerspectiveEnvelope } from "@/lib/perspectives/envelope";
import type { CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import { cashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import type { LiquidityTx } from "@/lib/transactions/liquidity";
import { DEFAULT_FILTER_ID } from "@/components/space/widgets/CashFlowFilterControls";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";
import { EvidenceDrawer } from "@/components/space/shell/EvidenceDrawer";
import { WealthPerspective } from "@/components/space/widgets/wealth/WealthPerspective";
import { CashFlowPerspective as CashFlowPerspectiveWorkspace } from "@/components/space/widgets/cashflow/CashFlowPerspective";
import { LiquidityPerspective } from "@/components/space/widgets/liquidity/LiquidityPerspective";
import { InvestmentsPerspective } from "@/components/space/widgets/investments/InvestmentsPerspective";
import { useInvestmentsTimeMachine } from "@/components/space/widgets/investments/useInvestmentsTimeMachine";
import { DebtPerspective } from "@/components/space/widgets/debt/DebtPerspective";
import { AccountsPerspective } from "@/components/space/widgets/accounts/AccountsPerspective";
import type { WealthMetricKey } from "@/components/space/widgets/wealth/WealthTrendChart";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { TimelineWidget } from "@/components/space/widgets/TimelineWidget";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { FloatingNavWrapper, RAIL_PILL_TOP } from "@/components/atlas/FloatingNavWrapper";
import { SPACE_TAB_ICON_MAP, SPACE_TAB_ICON_FALLBACK } from "@/lib/space-nav-icons";
import {
  railVisibleTabs,
  SPACE_TAB_LABELS,
  SPACE_GOALS_CHANGED_EVENT,
  SPACE_ACCOUNTS_CHANGED_EVENT,
  SPACE_CURRENCY_CHANGED_EVENT,
} from "@/lib/space-nav";
import { getPerspectivesForCategory, getCompositionSwitcherItems, PERSPECTIVE_LIBRARY } from "@/lib/perspectives";
import { toVirtualSections } from "@/lib/perspectives/virtual-sections";
import type { LensResult } from "@/lib/perspective-engine/types";
import { PerspectiveSwitcher, COMPOSITION_ICON_MAP } from "@/components/dashboard/widgets/PerspectiveSwitcher";
import { PerspectivesWidget, type PerspectiveCardItem } from "@/components/dashboard/widgets/PerspectivesWidget";
import { SpaceMembersWidget } from "@/components/dashboard/widgets/SpaceMembersWidget";
import { SpaceComingSoonPanel } from "@/components/dashboard/widgets/SpaceComingSoonPanel";
import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { SpaceTrendHero, type HeroPoint } from "@/components/dashboard/widgets/SpaceTrendHero";
import { RecentTransactionsPanel } from "@/components/dashboard/widgets/RecentTransactionsPanel";
import { SpaceTransactionsPanel } from "@/components/dashboard/widgets/SpaceTransactionsPanel";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import { useDisplayCurrency } from "@/lib/currency-context";
import { getSpaceHeroDef } from "@/lib/space-hero";
import type { Snapshot, Transaction, Account as PersonalAccount } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

type DashboardSection = {
  id:          string;
  key:         string;
  label:       string;
  tab:         string;
  enabled:     boolean;
  order:       number;
  config:      Record<string, unknown> | null;
};

type SpaceAccount = {
  id:             string;
  name:           string;
  type:           string;
  institution:    string;
  balance:        number;
  currency:       string;
  lastUpdated:    string;
  creditLimit?:   number;
  interestRate?:  number;  // APR, e.g. 19.99
  minimumPayment?: number; // monthly minimum
};

type SpaceGoal = {
  id:                    string;
  name:                  string;
  description:           string | null;
  category:              string;
  goalType:              "FINANCIAL" | "HABIT" | "SPENDING_LIMIT" | "DEBT_REDUCTION";
  status:                string;
  targetAmount:          number | null;
  currentAmount:         number;
  targetDate:            string | null;
  completedAt:           string | null;
  archivedAt:            string | null;
  deletedAt:             string | null;
  // HABIT
  habitFrequency:        string | null;
  currentStreak:         number;
  longestStreak:         number;
  lastCheckIn:           string | null;
  checkIns:              { id: string; checkedAt: string; note: string | null }[];
  // SPENDING_LIMIT
  spendingCategory:      string | null;
  // DEBT_REDUCTION
  linkedAccountId:       string | null;
  targetReductionAmount: number | null;
  targetReductionPct:    number | null;
  snapshotBalance:       number | null;
};

interface Props {
  spaceId:   string;
  spaceName: string;
  spaceType: string;
  category:      string;
  myRole:        string;
  currentUserId?: string;
  /**
   * SP-2A-4a — initial rail tab override (e.g. mapped from a legacy
   * /dashboard?tab= deep link by the caller). No URL synchronization.
   * Omitted ⇒ existing section-derived default. Applied once, after the
   * first data load, exactly where the default would have been chosen.
   */
  initialTab?: string;
  /**
   * SP Overview refinement — additive slot rendered at the very top of the
   * OVERVIEW tab, above the section cards / custom hero. The Personal host uses
   * it for the "view as" currency control (which must sit above the Net Worth
   * card). Omitted ⇒ nothing rendered ⇒ shared Spaces unchanged.
   */
  overviewTopSlot?: React.ReactNode;
  /**
   * Unified Space Widget Layout (slice 1) — the currency the Space's
   * SpaceSnapshot totals are stamped in (its reporting currency), forwarded to
   * the snapshot-backed `net_worth_chart` section as the conversion "from"
   * side. The Personal host passes its reporting currency (read outside the
   * "view as" provider) so the chart converts correctly under an override.
   * Omitted ⇒ falls back to the shell's display currency (shared Spaces, where
   * display === reporting).
   */
  snapshotCurrency?: string;
  /**
   * UX-PER-3 Debt — the user's manual FICO score (user-level), passed by the
   * Personal host for the Debt workspace's credit-health companion. Absent ⇒
   * the widget shows its "add score" affordance. Never drives debt math.
   */
  ficoScore?: number | null;
  ficoUpdatedAt?: string;
  /**
   * MC1 — when set (Personal "view as" override active), Perspective lenses are
   * fetched with this display-currency target so their metrics + verdict
   * convert. Omitted (shared Spaces, or no override) ⇒ computed in the Space's
   * reporting currency — today's behavior, byte-identical.
   */
  perspectiveTargetCurrency?: string;
  /**
   * MC1 — when set (Personal "view as" override active), the Transactions-tab
   * SUMMARY totals (Spend / In) convert through THIS context instead of the
   * Space's saved-reporting-currency context, so the aggregates match the
   * override symbol. Transaction ROWS stay native regardless. Omitted (shared
   * Spaces, or no override) ⇒ the saved-currency context — today's behavior.
   */
  transactionsMoneyCtxOverride?: SerializedConversionContext;
}

// ─── URL-backed tab state (?tab=…&perspective=…) ────────────────────────────────
// Persist the active Space tab (and, on Perspectives, the selected Perspective)
// in the query string via window.history — no server re-run, no full reload.
// Only these rail tabs are URL-synced; modal-routed tabs (GOALS/DEBT/…) are not.
const URL_SYNCED_TABS = new Set(["OVERVIEW", "PERSPECTIVES", "ACCOUNTS", "ACTIVITY", "TRANSACTIONS", "MEMBERS"]);
// URL "tab" value → activeTab. Includes rail tabs, the modal-routed tabs, and
// legacy aliases (timeline/banking/credit) so existing deep links keep working.
const URL_TAB_ALIAS: Record<string, string> = {
  overview: "OVERVIEW", perspectives: "PERSPECTIVES", accounts: "ACCOUNTS", banking: "ACCOUNTS",
  activity: "ACTIVITY", timeline: "ACTIVITY", transactions: "TRANSACTIONS", members: "MEMBERS",
  goals: "GOALS", debt: "DEBT", credit: "DEBT", investments: "INVESTMENTS", retirement: "RETIREMENT",
};

/** URL "tab" param → activeTab. Present-but-invalid ⇒ OVERVIEW. Absent ⇒ null. */
function parseTabParam(raw: string | null): string | null {
  if (!raw) return null;
  return URL_TAB_ALIAS[raw.toLowerCase()] ?? "OVERVIEW";
}
/** cashFlow → "cash-flow"; wealth → "wealth". */
function perspectiveIdToSlug(id: string): string {
  return id.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}
/** "cash-flow" → cashFlow. */
function slugToPerspectiveId(slug: string): string {
  return slug.toLowerCase().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}
/** URL "perspective" param → id. Present-but-invalid ⇒ "wealth". Absent ⇒ null. */
function parsePerspectiveParam(raw: string | null): string | null {
  if (!raw) return null;
  const id = slugToPerspectiveId(raw);
  return id in PERSPECTIVE_LIBRARY ? id : "wealth";
}
function readUrlTabState(): { tab: string | null; perspective: string | null } {
  if (typeof window === "undefined") return { tab: null, perspective: null };
  const p = new URLSearchParams(window.location.search);
  return { tab: parseTabParam(p.get("tab")), perspective: parsePerspectiveParam(p.get("perspective")) };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TAB_ORDER = ["OVERVIEW", "GOALS", "ACCOUNTS", "DEBT", "INVESTMENTS", "RETIREMENT", "ACTIVITY"];

// (TAB_LABELS removed with the in-space Settings tab — UX-CUST-1A correction.
//  Rail labels come from SPACE_TAB_LABELS in lib/space-nav.ts.)

// ─── Fixed Spaces rail (lib/space-nav.ts) ──────────────────────────────────────
//
// The legacy data-driven tabs above (GOALS/ACCOUNTS/DEBT/INVESTMENTS/
// RETIREMENT/ACTIVITY/SETTINGS) stay exactly as they are — this dashboard is
// still section-template-driven underneath. What changes is which of them
// get their own button on the new fixed top rail (OVERVIEW, ACCOUNTS, and
// SETTINGS keep direct buttons; everything else routes through Perspectives
// or the new Timeline tab) vs. which become reachable only as a Perspective
// card, so nothing real is lost, just re-entered through one calm front door.

/**
 * Resolve a rail tab id to its Lucide glyph at the tab scale — same static-
 * component shape as PerspectiveTabs' TabIcon (so the icon type is never
 * "created during render"). Decorative: the tab's label (visible, or its
 * aria-label when collapsed under labelVisibility="activeOnly") is the
 * accessible name, so the glyph is aria-hidden.
 */
function RailTabIcon({ id }: { id: string }) {
  const Icon = SPACE_TAB_ICON_MAP[id] ?? SPACE_TAB_ICON_FALLBACK;
  return <Icon size={14} aria-hidden />;
}

/** Perspective id -> the existing, unmodified data-tab it routes to. */
const PERSPECTIVE_TARGET_TAB: Partial<Record<string, string>> = {
  investments: "INVESTMENTS",
  debt:        "DEBT",
  retirement:  "RETIREMENT",
  goals:       "GOALS",
};

/** Legacy data-tabs with no button of their own on the fixed rail anymore —
 *  still fully real, just one click behind the Perspectives tab now, and
 *  (IA refactor point 5) rendered as a GlassModal instead of a tab swap. */
const PERSPECTIVE_ROUTED_TABS = ["GOALS", "DEBT", "INVESTMENTS", "RETIREMENT"];

/** Title + icon for each PERSPECTIVE_ROUTED_TABS modal — mirrors the label/
 *  icon each already has as a Perspective card (lib/perspectives.ts). */
const PERSPECTIVE_MODAL_META: Record<string, { title: string; icon: React.ElementType }> = {
  GOALS:       { title: "Goals",       icon: Target },
  DEBT:        { title: "Debt",        icon: CreditCard },
  INVESTMENTS: { title: "Investments", icon: TrendingUp },
  RETIREMENT:  { title: "Retirement",  icon: PiggyBank },
};

/** New tab ids that live entirely on the fixed rail (not section-driven).
 *  ACTIVITY is NOT here: it renders its recent_activity section inline through
 *  the normal section system (Unified Space Widget Layout — Activity slice). */
const NEW_SPACE_TABS = ["PERSPECTIVES", "FINANCES", "TRANSACTIONS", "MEMBERS", "DOCUMENTS"];

/** Flow-identified templates (Space Template Redesign): money movement is
 *  part of these Spaces' story, so Transactions is a first-class Overview
 *  preview module. Stock-identified categories (Investment / Property /
 *  Goal / value trackers) reach transactions through the Transactions tab
 *  doorway instead — never on the Overview. */
const FLOW_TX_CATEGORIES = ["HOUSEHOLD", "FAMILY", "BUSINESS", "DEBT_PAYOFF"];

/** Scope honesty label for shared-Space transaction lists — KD-15 filters
 *  rows to FULL-visibility shares, so the list is structurally partial. */
const TX_SCOPE_NOTE = "From fully shared accounts only";

const GOAL_CATEGORY_LABELS: Record<string, string> = {
  EMERGENCY_FUND:   "Emergency Fund",
  DEBT_PAYOFF:      "Debt Payoff",
  HOME_PURCHASE:    "Home Purchase",
  VEHICLE_PURCHASE: "Vehicle",
  TRIP:             "Travel / Trip",
  BUSINESS:         "Business",
  INVESTMENT:       "Investment",
  EQUIPMENT:        "Equipment",
  EDUCATION:        "Education",
  GENERAL:          "General",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBalance(amount: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

// MC1 QA Q4b — the bare currency symbol for a form-toggle glyph (e.g. "$",
// "€", "﷼"). USD ⇒ "$", so all-USD Spaces render the toggle unchanged.
function currencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? currency;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking:   "Checking",
  savings:    "Savings",
  investment: "Investment",
  crypto:     "Crypto",
  debt:       "Debt",
  other:      "Other",
};

// ─── Section cards ────────────────────────────────────────────────────────────


function AccountsCard({ accounts }: { accounts: SpaceAccount[] }) {
  if (accounts.length === 0) {
    return (
      <div className="text-center py-4">
        <Landmark size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No accounts shared yet</p>
        <p className="text-xs text-[var(--text-faint)] mt-0.5">Share accounts from the Spaces page.</p>
      </div>
    );
  }

  const grouped = accounts.reduce<Record<string, SpaceAccount[]>>((acc, a) => {
    (acc[a.type] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([type, items]) => (
        <div key={type}>
          <p className="text-[10px] font-semibold text-[var(--text-faint)] uppercase tracking-widest mb-1">
            {ACCOUNT_TYPE_LABELS[type] ?? type}
          </p>
          <div className="space-y-1">
            {items.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-inset)]">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{a.name}</p>
                  <p className="text-xs text-[var(--text-muted)] truncate">{a.institution}</p>
                </div>
                <p className="text-sm font-medium text-white shrink-0">
                  {formatBalance(a.balance, a.currency)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}



// ── Trash drawer (top-level so React Compiler doesn't flag it as a component created during render) ──

interface TrashDrawerProps {
  trashedGoals: SpaceGoal[];
  trashLoading: boolean;
  openedAt:     number; // timestamp from event handler — keeps Date.now() out of render
  onClose:      () => void;
  onRestore:    (goalId: string) => void;
  onDelete:     (goalId: string) => void;
}

function TrashDrawer({ trashedGoals, trashLoading, openedAt, onClose, onRestore, onDelete }: TrashDrawerProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-[var(--modal-surface)] border border-[var(--border-hairline-strong)] rounded-t-2xl shadow-2xl max-h-[70dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-hairline)] shrink-0">
          <p className="font-semibold text-white flex items-center gap-2">
            <Trash2 size={14} className="text-[var(--text-muted)]" /> Trash
          </p>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-2">
          {trashLoading ? (
            <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--text-faint)]" /></div>
          ) : trashedGoals.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)] text-center py-6">Trash is empty</p>
          ) : trashedGoals.map((g) => {
            const daysLeft = g.deletedAt
              ? Math.max(0, 7 - Math.floor((openedAt - new Date(g.deletedAt).getTime()) / 86_400_000))
              : 7;
            return (
              <div key={g.id} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--surface-inset)]">
                <p className="text-sm text-[var(--text-secondary)] flex-1 truncate">{g.name}</p>
                <p className="text-[10px] text-[var(--text-faint)] shrink-0">{daysLeft}d left</p>
                <button
                  onClick={() => onRestore(g.id)}
                  title="Restore"
                  className="p-1 rounded text-[var(--text-faint)] hover:text-[var(--accent-info)] transition-colors"
                >
                  <RotateCcw size={12} />
                </button>
                <button
                  onClick={() => onDelete(g.id)}
                  title="Delete permanently"
                  className="p-1 rounded text-[var(--text-faint)] hover:text-[var(--accent-negative)] transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-[var(--text-faint)] text-center pb-3 shrink-0">
          Goals are permanently deleted after 7 days
        </p>
      </div>
    </div>
  );
}

// ─── Goals card ───────────────────────────────────────────────────────────────

function GoalsCard({
  spaceId,
  canManage,
  onAddGoal,
}: {
  spaceId: string;
  canManage:   boolean;
  onAddGoal?:  () => void;
}) {
  // MC1 QA Q4b — goal config values are Space-native aggregates (no row stamp);
  // labels follow the Space's display currency.
  const displayCurrency = useDisplayCurrency();
  const [goals,        setGoals]        = useState<SpaceGoal[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [openMenuId,   setOpenMenuId]   = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showTrash,    setShowTrash]    = useState(false);
  const [trashOpenedAt,setTrashOpenedAt]= useState(0);
  const [trashedGoals, setTrashedGoals] = useState<SpaceGoal[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);

  const loadGoals = useCallback(() => {
    fetch(`/api/spaces/${spaceId}/goals`)
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { setGoals(data); setLoading(false); });
  }, [spaceId]);

  const loadTrash = useCallback(() => {
    setTrashLoading(true);
    fetch(`/api/spaces/${spaceId}/goals?trash=true`)
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { setTrashedGoals(data); setTrashLoading(false); });
  }, [spaceId]);

  useEffect(() => { loadGoals(); }, [loadGoals]);

  useEffect(() => {
    window.addEventListener(SPACE_GOALS_CHANGED_EVENT, loadGoals);
    return () => window.removeEventListener(SPACE_GOALS_CHANGED_EVENT, loadGoals);
  }, [loadGoals]);

  // Close ⋯ menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    function close() { setOpenMenuId(null); }
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openMenuId]);

  // ── Goal lifecycle actions ─────────────────────────────────────────────────
  async function patchGoal(goalId: string, data: Record<string, unknown>) {
    await fetch(`/api/spaces/${spaceId}/goals/${goalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setOpenMenuId(null);
  }

  async function completeGoal(goalId: string) {
    await patchGoal(goalId, { status: "COMPLETED" });
    window.dispatchEvent(new Event(SPACE_GOALS_CHANGED_EVENT));
  }

  async function archiveGoal(goalId: string) {
    await patchGoal(goalId, { archivedAt: new Date().toISOString() });
    window.dispatchEvent(new Event(SPACE_GOALS_CHANGED_EVENT));
  }

  async function unarchiveGoal(goalId: string) {
    await patchGoal(goalId, { archivedAt: null });
    window.dispatchEvent(new Event(SPACE_GOALS_CHANGED_EVENT));
  }

  async function trashGoal(goalId: string) {
    await patchGoal(goalId, { deletedAt: new Date().toISOString() });
    window.dispatchEvent(new Event(SPACE_GOALS_CHANGED_EVENT));
  }

  async function restoreGoal(goalId: string) {
    await fetch(`/api/spaces/${spaceId}/goals/${goalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deletedAt: null }),
    });
    loadTrash();
    window.dispatchEvent(new Event(SPACE_GOALS_CHANGED_EVENT));
  }

  async function permanentDelete(goalId: string) {
    await fetch(`/api/spaces/${spaceId}/goals/${goalId}?permanent=true`, { method: "DELETE" });
    loadTrash();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 size={16} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
  }

  // Partition goals
  const active    = goals.filter((g) => g.status === "ACTIVE" && !g.archivedAt);
  const archived  = goals.filter((g) => !!g.archivedAt);
  const completed = goals.filter((g) => g.status === "COMPLETED" && !g.archivedAt);

  if (goals.length === 0 && archived.length === 0) {
    return (
      <div className="text-center py-5">
        <Target size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No goals yet</p>
        {canManage && (
          <button
            onClick={onAddGoal}
            className="mt-2 flex items-center gap-1 text-xs text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors mx-auto"
          >
            <Plus size={12} /> Add a goal
          </button>
        )}
      </div>
    );
  }

  // ── ⋯ Action menu ──────────────────────────────────────────────────────────
  function GoalMenu({ g, isArchived = false }: { g: SpaceGoal; isArchived?: boolean }) {
    if (!canManage) return null;
    const menuOpen = openMenuId === g.id;
    const menuBtnCls = "flex items-center gap-2 w-full px-3 py-2 text-left text-xs hover:bg-[var(--surface-hover)] transition-colors";
    return (
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setOpenMenuId(menuOpen ? null : g.id)}
          className="p-1 rounded text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
        >
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-44 bg-[var(--modal-surface)] border border-[var(--border-hairline-strong)] rounded-xl shadow-xl z-30 overflow-hidden py-1">
            {!isArchived && g.status !== "COMPLETED" && (
              <button onClick={() => completeGoal(g.id)} className={`${menuBtnCls} text-[var(--accent-positive)]`}>
                <CheckCircle2 size={12} /> Mark complete
              </button>
            )}
            {!isArchived ? (
              <button onClick={() => archiveGoal(g.id)} className={`${menuBtnCls} text-[var(--text-secondary)]`}>
                <Archive size={12} /> Archive
              </button>
            ) : (
              <button onClick={() => unarchiveGoal(g.id)} className={`${menuBtnCls} text-[var(--text-secondary)]`}>
                <RotateCcw size={12} /> Unarchive
              </button>
            )}
            <button onClick={() => trashGoal(g.id)} className={`${menuBtnCls} text-[var(--accent-negative)]`}>
              <Trash2 size={12} /> Move to trash
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Goal row body (type-specific content) ─────────────────────────────────
  function GoalRowBody({ g }: { g: SpaceGoal }) {
    const isOverdue = g.targetDate && new Date(g.targetDate) < new Date() && g.status === "ACTIVE";
    const [checkingIn, setCheckingIn] = useState(false);

    async function handleCheckIn() {
      setCheckingIn(true);
      try {
        const res = await fetch(`/api/spaces/${spaceId}/goals/${g.id}/check-in`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
        });
        if (res.ok) window.dispatchEvent(new Event(SPACE_GOALS_CHANGED_EVENT));
      } finally { setCheckingIn(false); }
    }

    // ── FINANCIAL ──────────────────────────────────────────────────────────
    if (!g.goalType || g.goalType === "FINANCIAL") {
      const pct = Math.min(100, (g.targetAmount ?? 0) > 0 ? (g.currentAmount / (g.targetAmount ?? 1)) * 100 : 0);
      return (
        <div className="space-y-2 flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Circle size={14} className="text-[var(--accent-info)] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{g.name}</p>
                {g.targetDate && (
                  <p className={`text-[10px] flex items-center gap-1 mt-0.5 ${isOverdue ? "text-[var(--accent-negative)]" : "text-[var(--text-muted)]"}`}>
                    {isOverdue && <AlertCircle size={10} />}<Calendar size={10} />{formatDate(g.targetDate)}
                  </p>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-medium text-white">{formatBalance(g.currentAmount, displayCurrency)}</p>
              <p className="text-[10px] text-[var(--text-muted)]">of {formatBalance(g.targetAmount ?? 0, displayCurrency)}</p>
            </div>
          </div>
          <div className="h-1.5 bg-[var(--surface-inset)] rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-green-500" : isOverdue ? "bg-red-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[10px] text-[var(--text-faint)] text-right">{pct.toFixed(0)}% complete</p>
        </div>
      );
    }

    // ── HABIT ──────────────────────────────────────────────────────────────
    if (g.goalType === "HABIT") {
      const freq = g.habitFrequency ?? "DAILY";
      const freqLabel = freq === "DAILY" ? "day" : freq === "WEEKLY" ? "week" : "month";
      return (
        <div className="space-y-2 flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base shrink-0">🔁</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{g.name}</p>
                <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Check in every {freqLabel}</p>
              </div>
            </div>
            <button
              onClick={handleCheckIn}
              disabled={checkingIn}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-500/10 border border-blue-500/30 text-[var(--accent-info)] hover:bg-blue-500/20 transition-colors shrink-0 disabled:opacity-50"
            >
              {checkingIn ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
              Check in
            </button>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-inset)]">
            <div className="text-center">
              <p className="text-base font-bold text-white">{g.currentStreak}</p>
              <p className="text-[10px] text-[var(--text-muted)]">{g.currentStreak === 1 ? freqLabel : freqLabel + "s"} streak</p>
            </div>
            <div className="w-px h-6 bg-[var(--border-hairline-strong)]" />
            <div className="text-center">
              <p className="text-base font-bold text-[var(--text-secondary)]">{g.longestStreak}</p>
              <p className="text-[10px] text-[var(--text-muted)]">best streak</p>
            </div>
            {g.lastCheckIn && (
              <>
                <div className="w-px h-6 bg-[var(--border-hairline-strong)]" />
                <div className="text-center">
                  <p className="text-[10px] text-[var(--text-secondary)]">Last check-in</p>
                  <p className="text-[10px] text-[var(--text-secondary)]">{formatDate(g.lastCheckIn)}</p>
                </div>
              </>
            )}
          </div>
          {g.targetDate && (
            <p className={`text-[10px] flex items-center gap-1 ${isOverdue ? "text-[var(--accent-negative)]" : "text-[var(--text-muted)]"}`}>
              {isOverdue && <AlertCircle size={10} />}<Calendar size={10} />{formatDate(g.targetDate)}
            </p>
          )}
        </div>
      );
    }

    // ── SPENDING_LIMIT ─────────────────────────────────────────────────────
    if (g.goalType === "SPENDING_LIMIT") {
      const limit      = g.targetAmount ?? 0;
      const spent      = g.currentAmount;
      const pct        = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
      const overBudget = spent > limit && limit > 0;
      return (
        <div className="space-y-2 flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base shrink-0">🚦</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{g.name}</p>
                {g.spendingCategory && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{g.spendingCategory}</p>}
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className={`text-sm font-medium ${overBudget ? "text-[var(--accent-negative)]" : "text-white"}`}>{formatBalance(spent, displayCurrency)}</p>
              <p className="text-[10px] text-[var(--text-muted)]">of {formatBalance(limit, displayCurrency)}/mo</p>
            </div>
          </div>
          <div className="h-1.5 bg-[var(--surface-inset)] rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${overBudget ? "bg-red-500" : pct > 80 ? "bg-yellow-500" : "bg-green-500"}`} style={{ width: `${pct}%` }} />
          </div>
          <p className={`text-[10px] text-right ${overBudget ? "text-[var(--accent-negative)]" : "text-[var(--text-faint)]"}`}>
            {overBudget ? `${formatBalance(spent - limit, displayCurrency)} over budget` : `${formatBalance(limit - spent, displayCurrency)} remaining`}
          </p>
        </div>
      );
    }

    // ── DEBT_REDUCTION ─────────────────────────────────────────────────────
    if (g.goalType === "DEBT_REDUCTION") {
      const snapshot = g.snapshotBalance ?? 0;
      const current  = g.currentAmount;
      const paid     = Math.max(0, snapshot - current);
      let target = 0;
      let pct    = 0;
      if (g.targetReductionAmount) {
        target = g.targetReductionAmount;
        pct    = target > 0 ? Math.min(100, (paid / target) * 100) : 0;
      } else if (g.targetReductionPct && snapshot > 0) {
        target = snapshot * (g.targetReductionPct / 100);
        pct    = target > 0 ? Math.min(100, (paid / target) * 100) : 0;
      }
      return (
        <div className="space-y-2 flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base shrink-0">📉</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{g.name}</p>
                {snapshot > 0 && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Started at {formatBalance(snapshot, displayCurrency)}</p>}
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-medium text-[var(--accent-positive)]">−{formatBalance(paid, displayCurrency)}</p>
              {target > 0 && <p className="text-[10px] text-[var(--text-muted)]">goal: −{formatBalance(target, displayCurrency)}</p>}
            </div>
          </div>
          {target > 0 && (
            <>
              <div className="h-1.5 bg-[var(--surface-inset)] rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-green-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <p className="text-[10px] text-[var(--text-faint)] text-right">{pct.toFixed(0)}% paid down</p>
            </>
          )}
          {g.targetDate && (
            <p className={`text-[10px] flex items-center gap-1 ${isOverdue ? "text-[var(--accent-negative)]" : "text-[var(--text-muted)]"}`}>
              {isOverdue && <AlertCircle size={10} />}<Calendar size={10} />{formatDate(g.targetDate)}
            </p>
          )}
        </div>
      );
    }

    return null;
  }

  return (
    <>
      <div className="space-y-3">
        {/* Active goals */}
        {active.map((g) => (
          <div key={g.id} className="flex items-start gap-1">
            <GoalRowBody g={g} />
            <GoalMenu g={g} />
          </div>
        ))}

        {/* Completed goals */}
        {completed.length > 0 && (
          <div className="pt-1 border-t border-[var(--border-hairline)]">
            <p className="text-[10px] font-semibold text-[var(--text-faint)] uppercase tracking-widest mb-2">Completed</p>
            {completed.map((g) => (
              <div key={g.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface-inset)]">
                <CheckCircle2 size={13} className="text-[var(--accent-positive)] shrink-0" />
                <p className="text-sm text-[var(--text-secondary)] flex-1 truncate">{g.name}</p>
                {g.goalType === "HABIT" ? (
                  <p className="text-xs text-[var(--accent-positive)] shrink-0">{g.longestStreak} streak</p>
                ) : g.targetAmount ? (
                  <p className="text-xs text-[var(--accent-positive)] shrink-0">{formatBalance(g.targetAmount, displayCurrency)}</p>
                ) : null}
                <GoalMenu g={g} />
              </div>
            ))}
          </div>
        )}

        {/* Archived goals */}
        {archived.length > 0 && (
          <div className="pt-1 border-t border-[var(--border-hairline)]">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--text-faint)] uppercase tracking-widest mb-2 hover:text-[var(--text-muted)] transition-colors w-full"
            >
              <Archive size={10} />
              Archived ({archived.length})
              {showArchived ? <ChevronUp size={10} className="ml-auto" /> : <ChevronDown size={10} className="ml-auto" />}
            </button>
            {showArchived && (
              <div className="space-y-1.5">
                {archived.map((g) => (
                  <div key={g.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface-inset)]">
                    <Archive size={12} className="text-[var(--text-faint)] shrink-0" />
                    <p className="text-sm text-[var(--text-faint)] flex-1 truncate">{g.name}</p>
                    <GoalMenu g={g} isArchived />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer row: Add goal + Trash */}
        <div className="flex items-center justify-between pt-1">
          {canManage && (
            <button
              onClick={onAddGoal}
              className="flex items-center gap-1 text-xs text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors"
            >
              <Plus size={12} /> Add a goal
            </button>
          )}
          {canManage && (
            <button
              onClick={() => { setShowTrash(true); setTrashOpenedAt(Date.now()); loadTrash(); }}
              className="flex items-center gap-1 text-[11px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors"
            >
              <Trash2 size={11} /> Trash
            </button>
          )}
        </div>
      </div>

      {showTrash && (
        <TrashDrawer
          trashedGoals={trashedGoals}
          trashLoading={trashLoading}
          openedAt={trashOpenedAt}
          onClose={() => setShowTrash(false)}
          onRestore={restoreGoal}
          onDelete={permanentDelete}
        />
      )}
    </>
  );
}

function ActivityCard({ spaceId }: { spaceId: string }) {
  return <TimelineWidget spaceId={spaceId} pageSize={10} />;
}

/**
 * Day-zero Overview state (v2.5 honesty slice) — shown INSTEAD of the
 * section-card stack when the Space has no shared accounts yet. Without
 * this, a fresh Space renders a column of per-widget "share accounts to
 * see X" cards that all say the same thing; one calm setup card is more
 * honest and less inventory-like. Uses only existing affordances:
 * ManageSpaceModal for adding accounts, AddGoalModal for goals.
 */
function OverviewSetupCard({
  canManage,
  onAddAccounts,
  onAddGoal,
}: {
  canManage:     boolean;
  onAddAccounts: () => void;
  onAddGoal:     () => void;
}) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-8 text-center">
      <Landmark size={24} className="text-[var(--text-muted)] mx-auto mb-3" />
      <p className="text-base font-semibold text-[var(--text-primary)]">No accounts shared yet</p>
      <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-md mx-auto leading-relaxed">
        {canManage
          ? "Share accounts with this Space to see balances, net worth, and activity here. Everything on this dashboard is computed from real data — sections appear as their data exists."
          : "Once an Owner or Admin shares accounts with this Space, balances and activity appear here."}
      </p>
      {canManage && (
        <div className="flex items-center justify-center gap-2 mt-5">
          <button
            onClick={onAddAccounts}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-[var(--accent-info)] text-white transition-colors"
          >
            <Plus size={13} /> Add accounts
          </button>
          <button
            onClick={onAddGoal}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:text-white hover:bg-[var(--surface-hover)] border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] transition-colors"
          >
            <Target size={13} /> Add a goal
          </button>
        </div>
      )}
    </GlassPanel>
  );
}


/**
 * Contextual empty state for section keys that have no real component yet.
 *
 * Hint text is sourced from the widget registry (meta.description +
 * meta.requires[0].reason) when available, with a hardcoded override table
 * for keys that need friendlier user-facing copy.
 */
function ContextualCard({ sectionKey, label }: { sectionKey: string; label: string }) {
  // Friendly user-facing override messages (shown instead of raw registry description)
  const messages: Record<string, { body: string; hint: string }> = {
    cash_flow:               { body: "No cash flow data yet",          hint: "Connect your accounts to track income and expenses." },
    savings_rate:            { body: "Savings rate not available",     hint: "Connect accounts to calculate your monthly savings rate." },
    business_cash_flow:      { body: "Business cash flow",             hint: "Share your business accounts to track cash flow." },
    property_value:          { body: "Property value not set",         hint: "Add your property value manually or connect an integration." },
    vehicle_value:            { body: "Vehicle value not set",          hint: "Add your vehicle's current market value to track depreciation." },
    trip_budget:             { body: "No trip budget set",             hint: "Set a trip budget to start tracking expenses." },
    trip_savings:            { body: "No trip savings tracked",        hint: "Share a savings account to track progress toward your trip." },
    emergency_fund_progress: { body: "Emergency fund not set",         hint: "Set a target to track your emergency fund progress." },
    monthly_expenses:        { body: "No expense data",                hint: "Connect accounts to track monthly expenses." },
    retirement_progress:     { body: "Retirement progress",            hint: "Set a retirement target to track your progress." },
    equipment_value:         { body: "Equipment value not set",        hint: "Add your equipment's current value to track depreciation." },
  };

  const msg = messages[sectionKey];
  if (msg) {
    return (
      <div className="text-center py-5">
        <LayoutDashboard size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">{msg.body}</p>
        <p className="text-xs text-[var(--text-faint)] mt-0.5">{msg.hint}</p>
      </div>
    );
  }

  // Fall back to registry description if available
  const widgetMeta = getWidgetMeta(sectionKey);
  const hint = widgetMeta?.requires[0]?.reason ?? "This section is in development.";

  return (
    <div className="text-center py-5">
      <LayoutDashboard size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
      <p className="text-sm text-[var(--text-muted)]">{widgetMeta?.label ?? label}</p>
      <p className="text-xs text-[var(--text-faint)] mt-0.5">{hint}</p>
    </div>
  );
}

// ─── Section registry ─────────────────────────────────────────────────────────
//
// Maps section keys to their render functions.
// Adding a new section type requires ONE entry here — no switch modifications.
//
// Runtime compositor contract (implemented progressively):
//
//   section row
//     → WIDGET_REGISTRY entry  (lib/widget-registry.ts)
//     → component              (entries below)
//     → widget meta            (entry.meta)
//     → data contract          (entry.meta.dataTier / entry.meta.requires)
//     → render
//
// Phase 1 (current): SectionRegistry maps key → render fn.
//                    WIDGET_REGISTRY knows metadata + implementation status.
// Phase 2:           SectionRegistry entries are co-located with components;
//                    this map is auto-built from the registry.
// Phase 3:           SpaceDashboard becomes a pure compositor — it reads
//                    WIDGET_REGISTRY and dispatches to components generically.
//
// Keys without an entry here fall back to ContextualCard.
// Keys with implemented:false in WIDGET_REGISTRY also fall back to ContextualCard.

type SectionRenderProps = {
  accounts:              SpaceAccount[];
  spaceId:           string;
  canManage:             boolean;
  onAddGoal?:            () => void;
  payoffFullscreen:      boolean;
  closePayoffFullscreen: () => void;
  /** Parsed section.config — passed through to config-driven widgets */
  config:                Record<string, unknown> | null;
  /**
   * MC1 QA Q4 — conversion context targeting the Space's reporting currency
   * (rehydrated from GET /api/money/view-context in the host). Present ⇒
   * section aggregates convert per-row at the latest close and labels follow
   * ctx.target; absent (fetch pending/failed) ⇒ the original raw sums with
   * the historical default label, byte-for-byte (kill switch). Itemized
   * per-account rows stay native either way.
   */
  ctx?:                  ConversionContext;
  /**
   * Unified Space Widget Layout (slice 1) — SpaceSnapshot history for
   * snapshot-backed widgets (net_worth_chart). Host-fetched once; null while
   * loading. `snapshotCurrency` is the currency the snapshot totals are stamped
   * in (the Space's reporting currency) — the "from" currency for the chart's
   * conversion (ctx.target is the display/"view as" currency).
   */
  snapshots?:            Snapshot[] | null;
  snapshotCurrency?:     string;
  /**
   * UX-PER-3 Cash Flow — transaction history + the transactions' conversion
   * context (rehydrated spaceMoneyCtx / "view as" override, which converts each
   * row at its own date — distinct from the latest-close `ctx`) and the
   * workspace-selected period. Only the Cash Flow widgets read these; every
   * other widget ignores them. null transactions = still loading.
   */
  transactions?:         Transaction[] | null;
  txCtx?:                ConversionContext;
  period?:               CashFlowPeriod;
  /** UX-PER-3 Cash Flow — move the whole Perspective to an explicit historical
   *  period from inside a widget (Cash Flow History's Month/Quarter/Year
   *  selectors). Only the Cash Flow History widget uses it. */
  onSelectPeriod?:       (period: CashFlowPeriod) => void;
  /** CF-3 — the workspace-shared Cash Flow / Spending perspective + measure filter.
   *  Every Cash Flow widget (Summary, History, Calendar, Income/Cash In by Source)
   *  reads the SAME perspective so they never disagree. Set from the History
   *  widget's mounted selector. */
  perspective?:          CashFlowPerspective;
  filterId?:             string;
  onPerspectiveChange?:  (perspective: CashFlowPerspective, filterId: string) => void;
  /**
   * UX-PER-3 Debt — the user's manual credit score for the Debt workspace's
   * credit-health companion (FicoCard). User-level, threaded from the Personal
   * host; absent ⇒ FicoCard's "add score" affordance. Never drives debt math.
   */
  ficoScore?:            number | null;
  ficoUpdatedAt?:        string;
  /**
   * UX-PER-3 Goals — the Space's goals for the Goals workspace ("Am I on
   * track?"). Host-fetched when the workspace opens; null = loading. Only the
   * Goals widgets read this.
   */
  goals?:                SpaceGoal[] | null;
};

// ─── ProgressWidget adapter helpers ──────────────────────────────────────────
//
// These live here (not in ProgressWidget.tsx) to keep the presenter pure.
// Each adapter converts raw section.config + accounts into typed presenter props.

/** Extract a number from an unknown config value (handles string-encoded JSON). */
function cfgNum(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

/** Extract a string from an unknown config value. */
function cfgStr(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

/**
 * MC1 QA Q4 — row amount in the display currency, valued at the latest close.
 * Without a context this is the identity pass-through (kill switch); with one,
 * unresolvable rows keep their native amount and taint the sum (plan D-3).
 */
function toDisplay(
  amount:   number,
  currency: string | null | undefined,
  ctx?:     ConversionContext,
): { amount: number; estimated: boolean } {
  if (!ctx) return { amount, estimated: false };
  const c = convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx);
  return { amount: c.amount, estimated: c.estimated };
}

/** Sum balances (in the display currency when a context is supplied) from
 *  accounts matching any of the given type strings — map-then-reduce so the
 *  estimated taint survives the sum. */
function sumAccounts(
  accounts: SpaceAccount[],
  ctx:      ConversionContext | undefined,
  ...types: string[]
): { sum: number; estimated: boolean } {
  const set  = new Set(types);
  const conv = accounts.filter((a) => set.has(a.type)).map((a) => toDisplay(a.balance, a.currency, ctx));
  return {
    sum:       conv.reduce((s, c) => s + c.amount, 0),
    estimated: conv.some((c) => c.estimated),
  };
}

/**
 * Future Value of a lump sum plus an annuity — simplified annual compounding.
 * Used for the retirement projection stat.
 *
 *   FV = PV × (1+r)^n  +  PMT × ((1+r)^n − 1) / r
 *
 * where r = annualReturnPct / 100, n = years, PMT = annualContribution.
 */
function projectFV(
  currentBalance:    number,
  annualContrib:     number,
  annualReturnPct:   number,
  years:             number,
): number {
  if (years <= 0) return currentBalance;
  const r       = annualReturnPct / 100;
  const growth  = Math.pow(1 + r, years);
  const fvLump  = currentBalance * growth;
  const fvAnnuity = r > 0
    ? annualContrib * ((growth - 1) / r)
    : annualContrib * years;
  return fvLump + fvAnnuity;
}

// ─── SectionRegistry adapter helpers ─────────────────────────────────────────
// These are reused across multiple section keys that share the same data shape.

const renderNetWorth = (p: SectionRenderProps): React.ReactElement => {
  // MC1 QA Q4 — aggregates convert into the Space's reporting currency
  // (map-then-reduce keeps the taint); labels follow via ctx.target.
  const assetConv = p.accounts.filter((a) => a.type !== "debt").map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const debtConv  = p.accounts.filter((a) => a.type === "debt").map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const assets = assetConv.reduce((s, c) => s + c.amount, 0);
  const debt   = debtConv.reduce((s, c) => s + c.amount, 0);
  const net    = assets - debt;
  const est    = assetConv.some((c) => c.estimated) || debtConv.some((c) => c.estimated) ? "≈ " : "";
  return (
    <SummaryWidget
      primary={p.accounts.length > 0 ? {
        value: `${est}${formatBalance(net, p.ctx?.target)}`,
        label: "Net worth across all shared accounts",
        color: net >= 0 ? "white" : "red",
        size:  "3xl",
      } : undefined}
      stats={p.accounts.length > 0 ? [
        { label: "Total assets", value: `${est}${formatBalance(assets, p.ctx?.target)}`, accent: "green" },
        { label: "Total debt",   value: `${est}${formatBalance(debt, p.ctx?.target)}`,   accent: "red"   },
      ] : undefined}
      emptyHeadline="No accounts shared yet"
      emptySubline="Share accounts on the Spaces page to see net worth."
      emptyIcon={<LayoutDashboard size={22} className="text-[var(--text-faint)]" />}
    />
  );
};

const renderDebtSummary = (p: SectionRenderProps): React.ReactElement => {
  const debts = p.accounts.filter((a) => a.type === "debt");
  // MC1 QA Q4 — headline total converts (labels follow); per-account rows
  // below stay native (itemized doctrine, already labeled with a.currency).
  const conv  = debts.map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const total = conv.reduce((s, c) => s + c.amount, 0);
  const est   = conv.some((c) => c.estimated) ? "≈ " : "";
  return (
    <SummaryWidget
      primary={debts.length > 0 ? {
        value: `${est}${formatBalance(total, p.ctx?.target)}`,
        label: "Total outstanding debt",
        color: "red",
        size:  "2xl",
      } : undefined}
      rows={debts.map((a) => ({
        id:         a.id,
        label:      a.name,
        sublabel:   a.institution || undefined,
        value:      formatBalance(a.balance, a.currency),
        valueColor: "red" as const,
      }))}
      emptyHeadline="No debt accounts shared"
      emptySubline="Share debt accounts from the Spaces page."
      emptyIcon={<CreditCard size={22} className="text-[var(--text-faint)]" />}
    />
  );
};

const renderInvestmentSummary = (p: SectionRenderProps): React.ReactElement => {
  const investments = p.accounts.filter((a) => a.type === "investment");
  // MC1 QA Q4 — headline total converts (labels follow); rows stay native.
  const conv  = investments.map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const total = conv.reduce((s, c) => s + c.amount, 0);
  const est   = conv.some((c) => c.estimated) ? "≈ " : "";
  return (
    <SummaryWidget
      primary={investments.length > 0 ? {
        value: `${est}${formatBalance(total, p.ctx?.target)}`,
        label: "Total investments",
        color: "blue",
        size:  "2xl",
      } : undefined}
      rows={investments.map((a) => ({
        id:         a.id,
        label:      a.name,
        sublabel:   a.institution || undefined,
        value:      formatBalance(a.balance, a.currency),
        valueColor: "blue" as const,
      }))}
      emptyHeadline="No investment accounts shared"
      emptySubline="Share investment accounts from the Spaces page."
      emptyIcon={<TrendingUp size={22} className="text-[var(--text-faint)]" />}
    />
  );
};

// ── Unified Space Widget Layout (slice 1) — Overview lede sections ───────────
// Formerly hardcoded in PersonalHero; now section-backed so they order/drag/
// persist like any widget. Body-only: SectionCard supplies the card chrome +
// title (the section label). Currency conversion follows the host's ctx
// (ctx.target = the display / "view as" currency); the chart also needs the
// snapshot stamp currency as the "from" side.

function NetWorthChartSection({
  snapshots,
  ctx,
  snapshotCurrency,
}: {
  snapshots?:        Snapshot[] | null;
  ctx?:              ConversionContext;
  snapshotCurrency?: string;
}): React.ReactElement {
  const [chartInterval, setChartInterval] = useState<Interval>("1M");
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="flex justify-end mb-1">
        <button
          onClick={() => setExpanded(true)}
          aria-label="Expand chart"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors touch-manipulation"
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <NetWorthChart
        snapshots={snapshots ?? []}
        interval={chartInterval}
        onIntervalChange={setChartInterval}
        ctx={ctx}
        snapshotCurrency={snapshotCurrency}
        fill
      />
      {expanded && (
        <NetWorthChartModal
          snapshots={snapshots ?? []}
          initialInterval={chartInterval}
          initialSeries="netWorth"
          ctx={ctx}
          snapshotCurrency={snapshotCurrency}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

function AllocationSection({
  accounts,
  ctx,
}: {
  accounts: SpaceAccount[];
  ctx?:     ConversionContext;
}): React.ReactElement {
  // classifyAccounts accepts SpaceAccount[] and converts through ctx when
  // present (identical math for all-USD Spaces).
  const c = classifyAccounts(accounts, ctx);
  return (
    <AllocationChart
      cash={c.totalLiquid}
      investments={c.totalInvestments}
      crypto={c.totalDigitalAssets}
      debt={c.totalLiabilities}
      realAssets={c.totalRealAssets}
      size="responsive"
    />
  );
}

const SectionRegistry: Record<string, (p: SectionRenderProps) => React.ReactElement> = {
  "net_worth":              renderNetWorth,
  "net_worth_chart":        (p) => <NetWorthChartSection snapshots={p.snapshots} ctx={p.ctx} snapshotCurrency={p.snapshotCurrency} />,
  "allocation":             (p) => <AllocationSection accounts={p.accounts} ctx={p.ctx} />,
  // ── Wealth Perspective (UX-PER-3) — assets-only analytical widgets ──────────
  // EXPERIMENT (UX): temporarily render "Wealth by Account" as a two-column
  // account-card grid instead of ranked bars. Reversible — restore
  // renderWealthByAccount to end the experiment. renderWealthByAccount and its
  // widget key/registry entry are intentionally left untouched.
  "wealth_by_account":       (p) => renderWealthAccountCards(p.accounts, p.ctx),
  "institution_allocation":  (p) => renderInstitutionAllocation(p.accounts, p.ctx),
  // EXPERIMENT (UX): temporarily render "Asset Allocation" as a multi-mode chart
  // (treemap default / donut / strip). Donut mode reuses renderAssetAllocation
  // verbatim. Reversible — restore renderAssetAllocation to end the experiment.
  "asset_allocation":        (p) => renderWealthAllocationChart(p.accounts, p.ctx),
  "wealth_concentration":    (p) => renderWealthConcentration(p.accounts, p.ctx),
  // ── Liquidity Perspective (UX-PER-3) — access/readiness widgets ─────────────
  "liquidity_ladder":        (p) => renderLiquidityLadder(p.accounts, p.ctx),
  "accessible_cash":         (p) => renderAccessibleCash(p.accounts, p.ctx),
  "emergency_fund_readiness":(p) => renderEmergencyFundReadiness(p.accounts, p.ctx),
  "liquidity_concentration": (p) => renderLiquidityConcentration(p.accounts, p.ctx),
  // ── Cash Flow Perspective (UX-PER-3) — movement over time (FlowType-aware) ──
  "cash_flow_summary":       (p) => renderCashFlowSummary(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.accounts, p.perspective, p.onPerspectiveChange),
  "cash_flow_history":       (p) => renderCashFlowHistory(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.onSelectPeriod, p.accounts, p.perspective, p.filterId, p.onPerspectiveChange),
  "income_vs_spending":      (p) => renderIncomeVsSpending(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx),
  "cash_flow_by_category":   (p) => renderCashFlowByCategory(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx),
  "income_by_source":        (p) => renderIncomeBySource(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.accounts, p.perspective),
  "debt_payments":           (p) => renderDebtPayments(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.accounts),
  // ── Debt Perspective (UX-PER-3) — liabilities-only (shape/cost/risk) ────────
  "debt_by_account":         (p) => renderDebtByAccount(p.accounts, p.ctx),
  "debt_cost":               (p) => renderDebtCost(p.accounts, p.ctx),
  "credit_utilization":      (p) => <CreditUtilizationWidget accounts={p.accounts} ctx={p.ctx} />,
  "debt_history":            (p) => renderDebtHistory(p.snapshots, p.ctx),
  "credit_score":            (p) => renderCreditScore(p.ficoScore, p.ficoUpdatedAt),
  "debt_complete_info":      (p) => renderDebtCompleteInfo(p.accounts),
  // debt_payoff_calculator is already registered above (reused from the Debt tab).
  // ── Goals Perspective (UX-PER-3) — trajectory vs target ─────────────────────
  "goal_progress":           (p) => renderGoalProgress(p.goals, p.ctx),
  "goal_on_track":           (p) => renderGoalOnTrack(p.goals),
  "goal_required_pace":      (p) => renderGoalRequiredPace(p.goals, p.ctx),
  "goal_funding_gap":        (p) => renderGoalFundingGap(p.goals, p.ctx),
  "net_worth_section":      renderNetWorth,       // deprecated alias — seeded pre-v2
  "accounts_overview":      (p) => <AccountsPerspective spaceId={p.spaceId} accounts={p.accounts} />,
  "business_accounts":      (p) => <AccountsCard accounts={p.accounts} />,
  "debt_summary":           renderDebtSummary,
  "debt_payoff_tracker":    renderDebtSummary,    // TODO: Progress/Timeline hybrid when payoff simulation is ready
  "mortgage_tracker":       renderDebtSummary,
  "auto_loan_tracker":      renderDebtSummary,
  "debt_breakdown_chart": (p) => {
    const viewMode = (cfgStr(p.config?.viewMode) as BreakdownViewMode | undefined) ?? "donut";
    return renderDebtBreakdownChart(
      p.accounts,
      viewMode,
      "Share your debt accounts from Manage → Add Accounts to see your debt breakdown.",
      p.ctx,
    );
  },
  "debt_payoff_calculator": (p) => renderDebtPayoffCalculator(p.accounts, p.payoffFullscreen, p.closePayoffFullscreen, p.ctx),
  "investment_summary":     renderInvestmentSummary,
  "investment_allocation":  renderInvestmentSummary, // TODO: replace with BreakdownWidget when adapter is ready
  // ── Investments Perspective (Slice B) — current holdings grouped by account ──
  // Self-fetching (owns its data via GET /api/spaces/[id]/investments), so it
  // needs only spaceId — no host lazy-fetch/prop threading, same pattern as
  // recent_activity (ActivityCard) and goals_progress (GoalsCard).
  "investment_accounts":    (p) => <InvestmentAccountsWidget spaceId={p.spaceId} />,
  "retirement_accounts":    renderInvestmentSummary,
  // retirement_progress — moved to ProgressWidget family below
  "goals_progress":         (p) => <GoalsCard spaceId={p.spaceId} canManage={p.canManage} onAddGoal={p.onAddGoal} />,
  "recent_activity":        (p) => <ActivityCard spaceId={p.spaceId} />,
  // ── Config-driven asset value widgets (all powered by AssetValueWidget) ──────
  // Account resolution order:
  //   1. config.accountId — explicit pin (set via ManageSpaceModal, stored in section.config)
  //   2. Name heuristic   — regex on account.name, catches common naming conventions
  //   3. First type=other — fallback when space has only one manual asset account
  "property_value": (p) => {
    const cfg    = p.config as AssetValueConfig | null;
    const others = p.accounts.filter((a) => a.type === "other");
    const match  =
      (cfg?.accountId ? others.find((a) => a.id === cfg.accountId) : undefined) ??
      others.find((a) => /home|house|property|real.?estate|condo|apt|cabin|cottage|villa/i.test(a.name)) ??
      others[0];
    // MC1 QA Q4 — the live balance is a Space aggregate: convert into the
    // reporting currency and label to match. An explicit config.currency is
    // the legacy per-section override — respect it untouched (no conversion).
    const hasCfgCur = cfgStr(cfg?.currency) != null;
    return (
      <AssetValueWidget
        title="Property Value"
        assetType="property"
        config={cfg}
        accountBalance={match && !hasCfgCur ? toDisplay(match.balance, match.currency, p.ctx).amount : match?.balance}
        currency={hasCfgCur ? undefined : p.ctx?.target}
      />
    );
  },
  "vehicle_value": (p) => {
    const cfg    = p.config as AssetValueConfig | null;
    const others = p.accounts.filter((a) => a.type === "other");
    const match  =
      (cfg?.accountId ? others.find((a) => a.id === cfg.accountId) : undefined) ??
      others.find((a) => /car|vehicle|truck|suv|van|motor|rv|boat|cr-v|camry|f-150|tesla|bmw|audi/i.test(a.name)) ??
      others[0];
    const hasCfgCur = cfgStr(cfg?.currency) != null;
    return (
      <AssetValueWidget
        title="Vehicle Value"
        assetType="vehicle"
        config={cfg}
        accountBalance={match && !hasCfgCur ? toDisplay(match.balance, match.currency, p.ctx).amount : match?.balance}
        currency={hasCfgCur ? undefined : p.ctx?.target}
      />
    );
  },
  "equipment_value": (p) => {
    const cfg    = p.config as AssetValueConfig | null;
    const others = p.accounts.filter((a) => a.type === "other");
    const match  =
      (cfg?.accountId ? others.find((a) => a.id === cfg.accountId) : undefined) ??
      others.find((a) => /equip|tool|machine|laptop|computer|hardware|gear|camera|studio/i.test(a.name)) ??
      others[0];
    const hasCfgCur = cfgStr(cfg?.currency) != null;
    return (
      <AssetValueWidget
        title="Equipment Value"
        assetType="equipment"
        config={cfg}
        accountBalance={match && !hasCfgCur ? toDisplay(match.balance, match.currency, p.ctx).amount : match?.balance}
        currency={hasCfgCur ? undefined : p.ctx?.target}
      />
    );
  },

  // ── ProgressWidget family ─────────────────────────────────────────────────
  // Adapters compute currentAmount + targetAmount from config / accounts,
  // then pass pre-resolved numbers to the pure ProgressWidget presenter.

  "trip_budget": (p) => {
    const cfg           = p.config ?? {};
    const targetAmount  = cfgNum(cfg.totalBudget)  ?? null;
    const currentAmount = cfgNum(cfg.amountSpent)  ?? 0;
    const deadline      = cfgStr(cfg.departureDate);
    // MC1 QA Q4 — config amounts carry no currency stamp: they are entered in
    // the Space's own currency, so no conversion — labels follow ctx.target.
    const stats: ProgressStat[] = [];
    if (targetAmount != null) {
      const rem = targetAmount - currentAmount;
      stats.push({
        label:  rem >= 0 ? "Remaining" : "Over budget",
        value:  formatBalance(Math.abs(rem), p.ctx?.target),
        accent: rem >= 0 ? "green" : "red",
      });
    }
    return (
      <ProgressWidget
        currentAmount={targetAmount != null ? currentAmount : null}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Spent so far"
        targetLabel="Budget"
        progressLabel="of budget used"
        mode="spending"
        theme="orange"
        stats={stats}
        deadline={deadline}
        deadlineLabel="Departure"
        emptyHeadline="Trip budget not configured"
        emptySubline="Set a total budget in Settings to start tracking your trip spending."
      />
    );
  },

  "trip_savings": (p) => {
    const cfg           = p.config ?? {};
    const targetAmount  = cfgNum(cfg.totalBudget) ?? null;
    const deadline      = cfgStr(cfg.departureDate);
    // Live balance from shared savings/checking accounts — MC1 QA Q4:
    // converted into the reporting currency so the sum is honest across
    // mixed-currency accounts; the config target is Space-native already.
    const { sum: currentAmount, estimated } = sumAccounts(p.accounts, p.ctx, "savings", "checking");
    const est = estimated ? "≈ " : "";
    const stats: ProgressStat[] = [];
    if (targetAmount != null) {
      const remaining = targetAmount - currentAmount;
      if (remaining > 0) {
        stats.push({
          label:  "Still needed",
          value:  `${est}${formatBalance(remaining, p.ctx?.target)}`,
          accent: "orange",
        });
      } else {
        stats.push({ label: "Status", value: "Goal reached! ✓", accent: "green" });
      }
    }
    return (
      <ProgressWidget
        currentAmount={currentAmount}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Saved (from shared accounts)"
        targetLabel="Goal"
        progressLabel="funded"
        mode="savings"
        theme="blue"
        stats={stats}
        deadline={deadline}
        deadlineLabel="Departure"
        emptyHeadline="Trip savings target not configured"
        emptySubline="Set a savings goal in Settings to track your trip progress."
      />
    );
  },

  "emergency_fund_progress": (p) => {
    const cfg            = p.config ?? {};
    const targetMonths   = cfgNum(cfg.targetMonths)   ?? 6;
    const monthlyExp     = cfgNum(cfg.monthlyExpenses) ?? null;
    const targetAmount   = monthlyExp != null ? targetMonths * monthlyExp : null;
    // MC1 QA Q4 — converted savings vs. a Space-native expense figure keeps
    // the months-covered ratio in one currency.
    const { sum: currentAmount } = sumAccounts(p.accounts, p.ctx, "savings");
    const monthsCovered  = monthlyExp != null && monthlyExp > 0
      ? currentAmount / monthlyExp
      : null;
    const stats: ProgressStat[] = [];
    if (monthsCovered != null) {
      stats.push({
        label:  "Months covered",
        value:  monthsCovered.toFixed(1),
        accent: monthsCovered >= targetMonths ? "green" : "orange",
      });
    }
    stats.push({
      label:  "Target",
      value:  `${targetMonths} months`,
      accent: "default",
    });
    return (
      <ProgressWidget
        currentAmount={currentAmount}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Current savings balance"
        targetLabel={`${targetMonths}-month target`}
        progressLabel="funded"
        mode="savings"
        theme="green"
        stats={stats}
        emptyHeadline="Emergency fund target not configured"
        emptySubline="Add your monthly expenses in Settings to calculate how much you need."
      />
    );
  },

  "retirement_progress": (p) => {
    const cfg            = p.config ?? {};
    const targetAmount   = cfgNum(cfg.targetAmount)       ?? null;
    const retirementAge  = cfgNum(cfg.retirementAge)      ?? null;
    const currentAge     = cfgNum(cfg.currentAge)         ?? null;
    const expectedReturn = cfgNum(cfg.expectedReturn)     ?? 7;
    const annualContrib  = cfgNum(cfg.annualContribution) ?? 0;
    // Live investment account balances — MC1 QA Q4: converted, so the FV
    // projection (a planner aggregate) is computed and labeled in the
    // Space's reporting currency.
    const { sum: currentAmount, estimated } = sumAccounts(p.accounts, p.ctx, "investment");
    const yearsLeft      = retirementAge != null && currentAge != null
      ? Math.max(0, retirementAge - currentAge)
      : null;
    const stats: ProgressStat[] = [];
    if (yearsLeft != null) {
      stats.push({ label: "Years to retirement", value: String(yearsLeft), accent: "default" });
    }
    if (yearsLeft != null && yearsLeft > 0) {
      const projected = projectFV(currentAmount, annualContrib, expectedReturn, yearsLeft);
      const onTrack   = targetAmount != null && projected >= targetAmount;
      stats.push({
        label:  "Projected at retirement",
        value:  `${estimated ? "≈ " : ""}${formatBalance(projected, p.ctx?.target)}`,
        accent: onTrack ? "green" : targetAmount != null ? "orange" : "default",
      });
    }
    return (
      <ProgressWidget
        currentAmount={currentAmount}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Current investments"
        targetLabel="Retirement target"
        progressLabel="of goal"
        mode="savings"
        theme="purple"
        stats={stats}
        emptyHeadline="Retirement target not configured"
        emptySubline="Set a retirement target in Settings to track your investment progress."
      />
    );
  },
};

// ─── Section renderer ─────────────────────────────────────────────────────────

// Solid/frosted, non-collapsible cards. Two families use this treatment:
//  - the Overview lede widgets (formerly PersonalHero cards A/B/C), and
//  - the Wealth Perspective's analytical widgets (UX-PER-3),
// so the workspace reads as intentional analytical cards, not the faint
// ~5%-opacity SectionCard surface. Keyed by section key; any Space rendering
// these exact keys gets the treatment.
const SOLID_LEDE_KEYS = new Set([
  "net_worth", "net_worth_chart", "allocation",
  "wealth_by_account", "institution_allocation", "asset_allocation", "wealth_concentration",
  "liquidity_ladder", "accessible_cash", "emergency_fund_readiness", "liquidity_concentration",
  "cash_flow_summary", "cash_flow_history", "income_vs_spending", "cash_flow_by_category", "income_by_source", "debt_payments",
  "debt_by_account", "debt_cost", "credit_utilization", "debt_payoff_snapshot",
  "debt_history", "credit_score", "debt_complete_info", "debt_payoff_calculator",
  "goal_progress", "goal_on_track", "goal_required_pace", "goal_funding_gap",
]);

function SectionCard({
  section,
  accounts,
  spaceId,
  category,
  canManage,
  onAddGoal,
  ctx,
  perspective,
  filterId,
  onPerspectiveChange,
  snapshots,
  snapshotCurrency,
  transactions,
  txCtx,
  period,
  onSelectPeriod,
  ficoScore,
  ficoUpdatedAt,
  goals,
}: {
  section:     DashboardSection;
  accounts:    SpaceAccount[];
  spaceId: string;
  category:    string;
  canManage:   boolean;
  onAddGoal?:  () => void;
  /** MC1 QA Q4 — see SectionRenderProps.ctx. */
  ctx?:        ConversionContext;
  /** Unified Space Widget Layout (slice 1) — see SectionRenderProps.snapshots. */
  snapshots?:        Snapshot[] | null;
  snapshotCurrency?: string;
  /** UX-PER-3 Cash Flow — see SectionRenderProps.transactions/txCtx/period. */
  transactions?:     Transaction[] | null;
  txCtx?:            ConversionContext;
  period?:           CashFlowPeriod;
  onSelectPeriod?:   (period: CashFlowPeriod) => void;
  perspective?:          CashFlowPerspective;
  filterId?:             string;
  onPerspectiveChange?:  (perspective: CashFlowPerspective, filterId: string) => void;
  // (SectionRenderProps mirror — perspective threaded to Cash Flow widgets)
  /** UX-PER-3 Debt — see SectionRenderProps.ficoScore/ficoUpdatedAt. */
  ficoScore?:        number | null;
  ficoUpdatedAt?:    string;
  /** UX-PER-3 Goals — see SectionRenderProps.goals. */
  goals?:            SpaceGoal[] | null;
}) {
  const [collapsed,        setCollapsed]        = useState(false);
  const [payoffFullscreen, setPayoffFullscreen] = useState(false);
  const isDebtSpace = category === "DEBT_PAYOFF";

  // Scroll-position preservation now lives in DebtPayoffSection's shared
  // useBodyScrollLock (doctrine §14), so the former manual scrollY save/restore
  // workaround here is redundant and has been removed.
  function openPayoffFullscreen() {
    setPayoffFullscreen(true);
  }

  function closePayoffFullscreen() {
    setPayoffFullscreen(false);
  }

  // Override stale section labels for existing seeded debt spaces
  const displayLabel = isDebtSpace && section.key === "cash_flow"    ? "Debt Breakdown"
                     : isDebtSpace && section.key === "savings_rate" ? "Payoff Planner"
                     : section.label;

  // Debt Breakdown and Activity feed are never collapsible
  const isDebtBreakdown = (isDebtSpace && section.key === "cash_flow") || section.key === "debt_breakdown_chart" || section.key === "recent_activity";
  // Payoff Planner shows a summary when collapsed
  const isDebtPayoff    = (isDebtSpace && section.key === "savings_rate") || section.key === "debt_payoff_calculator";
  // Overview lede widgets: solid/frosted card, not collapsible (see SOLID_LEDE_KEYS).
  const isSolidLede     = SOLID_LEDE_KEYS.has(section.key);

  // ── Payoff summary for collapsed state ─────────────────────────────────────
  let payoffSummary: string | null = null;
  if (isDebtPayoff) {
    // MC1 QA Q4 — the collapsed summary simulates over aggregates, so the
    // sums (and APR weights) use display-currency amounts; the resulting
    // copy is time-only, so no label change is involved.
    const debtAccs = accounts.filter((a) => a.type === "debt");
    const balConv  = debtAccs.map((a) => toDisplay(a.balance, a.currency, ctx));
    const totalBal = balConv.reduce((s, c) => s + c.amount, 0);
    const totalMin = debtAccs
      .map((a) => toDisplay(a.minimumPayment ?? 0, a.currency, ctx))
      .reduce((s, c) => s + c.amount, 0);
    if (totalBal > 0 && totalMin > 0) {
      const avgApr      = debtAccs.reduce((s, a, i) => s + (a.interestRate ?? 0) * balConv[i].amount, 0) / totalBal;
      const monthlyRate = avgApr / 100 / 12;
      const result      = simulatePayoff(totalBal, monthlyRate, totalMin);
      if (result) {
        const yrs = Math.floor(result.months / 12);
        const mos = result.months % 12;
        const timeStr = yrs > 0 && mos > 0
          ? `${yrs} year${yrs !== 1 ? "s" : ""} and ${mos} month${mos !== 1 ? "s" : ""}`
          : yrs > 0
          ? `${yrs} year${yrs !== 1 ? "s" : ""}`
          : `${mos} month${mos !== 1 ? "s" : ""}`;
        payoffSummary = `At your minimum monthly payments, you could be debt-free in approximately ${timeStr}. Expand to simulate different payoff timelines.`;
      } else {
        payoffSummary = "Your minimum payments may not be enough to cover the interest charges. Expand to build a realistic payoff plan.";
      }
    } else if (totalBal > 0) {
      payoffSummary = "Expand to simulate your debt payoff timeline.";
    }
  }

  function renderBody() {
    // Legacy key overrides — DEBT_PAYOFF spaces seeded before v2 section keys were stable
    // TODO: one-time migration to rename these rows to their canonical keys, then remove these guards
    if (isDebtSpace && section.key === "cash_flow") {
      // Legacy: DEBT_PAYOFF spaces seeded before v2 used "cash_flow" for the debt breakdown.
      // TODO: one-time migration to rename these rows to debt_breakdown_chart, then remove this guard.
      return renderDebtBreakdownChart(
        accounts,
        "donut",
        "Share your debt accounts from Manage → Add Accounts to see your debt breakdown.",
        ctx,
      );
    }
    if (isDebtSpace && section.key === "savings_rate") return renderDebtPayoffCalculator(accounts, payoffFullscreen, closePayoffFullscreen, ctx);

    const render = SectionRegistry[section.key];
    if (render) return render({ accounts, spaceId, canManage, onAddGoal, payoffFullscreen, closePayoffFullscreen, config: section.config, ctx, snapshots, snapshotCurrency, transactions, txCtx, period, onSelectPeriod, perspective, filterId, onPerspectiveChange, ficoScore, ficoUpdatedAt, goals });
    return <ContextualCard sectionKey={section.key} label={section.label} />;
  }

  // ── Solid Overview lede (Net Worth / chart / allocation) — frosted card,
  //    NOT collapsible. Preserves the pre-section-backed PersonalHero card
  //    treatment (GlassPanel) so these never use the faint SectionCard fill,
  //    and keeps the drag handle legible. Left padding leaves room for the
  //    Edit-Layout grip that overlays the card's top-left corner. */
  if (isSolidLede) {
    // Phase 7 — the Cash Flow Summary header names the active analytical time
    // slice, read from the SAME authoritative `period` every widget consumes
    // (no separate period logic here). Other lede widgets keep their bare label.
    const headerLabel = section.key === "cash_flow_summary" && period
      ? `${displayLabel} · ${periodLabel(period)}`
      : displayLabel;
    return (
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
        <p className="text-sm font-semibold text-[var(--text-primary)] px-1 mb-2">{headerLabel}</p>
        {renderBody()}
      </GlassPanel>
    );
  }

  // ── Non-collapsible header (Debt Breakdown) ─────────────────────────────────
  if (isDebtBreakdown) {
    return (
      <div className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-2xl overflow-hidden">
        <div className="px-4 py-3">
          <p className="text-sm font-semibold text-white">{displayLabel}</p>
        </div>
        <div className="px-4 pb-4 pt-0">
          {renderBody()}
        </div>
      </div>
    );
  }

  // ── Collapsible header (all others) ────────────────────────────────────────
  return (
    <div className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-2xl overflow-hidden">
      <div className="flex items-start px-4 py-3">
        {/* Title + collapsed summary — clicking toggles collapse */}
        <button
          type="button"
          onClick={() => setCollapsed((p) => !p)}
          className="flex-1 text-left min-w-0 hover:opacity-80 transition-opacity"
        >
          <p className="text-sm font-semibold text-white">{displayLabel}</p>
          {collapsed && payoffSummary && (
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-snug">{payoffSummary}</p>
          )}
        </button>

        {/* Right-side controls */}
        <div className="flex items-center gap-2 shrink-0 ml-3 mt-0.5">
          {isDebtPayoff && !collapsed && (
            <button
              type="button"
              onClick={openPayoffFullscreen}
              className="text-[11px] font-medium text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors"
            >
              Expand
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((p) => !p)}
            className="text-[var(--text-faint)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {collapsed
              ? <ChevronDown size={14} />
              : <ChevronUp   size={14} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="px-4 pb-4 pt-0">
          {renderBody()}
        </div>
      )}
    </div>
  );
}

// ─── Visible-surface reorder (UX-CUST-1A) ───────────────────────────────────────

/**
 * SortableSectionCard — wraps the *existing* SectionCard rendering path with a
 * drag handle so section cards can be reordered directly on the visible
 * dashboard while Edit Layout mode is active. It does not alter SectionCard;
 * the card renders unchanged as children.
 *
 * Layout: this only mounts inside the Edit-Layout SortableContext, so it always
 * insets the card into a left gutter (`pl-8`) and drops the grip into that
 * gutter (`left-0`). That way the handle never overlaps the card's title/content
 * for ANY section type, and reverts to full width the moment Edit Layout exits
 * (this wrapper is no longer rendered).
 *
 * Module-level (not created during render) so the React Compiler doesn't flag
 * it. Tab-scoping is structural: the single SortableContext that mounts this
 * only ever contains the active tab's visible cards, so a card can never be
 * dropped into another tab.
 */
function SortableSectionCard({
  section,
  children,
}: {
  section:  DashboardSection;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: section.id });

  const style: React.CSSProperties = {
    transform:  CSS.Transform.toString(transform),
    transition,
    opacity:    isDragging ? 0.6 : 1,
    zIndex:     isDragging ? 20 : undefined,
    position:   "relative",
  };

  return (
    <div ref={setNodeRef} style={style} className="relative pl-8 touch-none">
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${section.label}`}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--modal-surface)] border border-[var(--border-hairline-strong)] shadow-sm cursor-grab active:cursor-grabbing transition-colors touch-none"
      >
        <GripVertical size={14} />
      </button>
      {children}
    </div>
  );
}

// ─── Settings tab (REMOVED — UX-CUST-1A correction) ─────────────────────────────
//
// Settings is no longer an in-space tab. Section show/hide already lives in
// ManageSpaceModal → Overview (DashboardTab), which is also the home for the
// layout controls (reset-to-default, saved layouts). The former in-space
// SettingsTab component has been deleted; nothing renders SETTINGS here now.

// ─── Add Goal inline modal ────────────────────────────────────────────────────

// Map space category → valid Prisma GoalCategory value.
// Only space categories that have a meaningful 1:1 mapping are listed;
// everything else falls back to "GENERAL" and shows the category picker.
const SPACE_TO_GOAL_CATEGORY: Record<string, string> = {
  DEBT_PAYOFF:    "DEBT_PAYOFF",
  INVESTMENT:     "INVESTMENT",
  EMERGENCY_FUND: "EMERGENCY_FUND",
  BUSINESS:       "BUSINESS",
  TRIP:           "TRIP",
  VEHICLE:        "VEHICLE_PURCHASE",
  PROPERTY:       "HOME_PURCHASE",
  EQUIPMENT:      "EQUIPMENT",
};

const GOAL_TYPE_META: Record<string, { label: string; description: string; icon: string }> = {
  FINANCIAL:      { label: "Financial",      description: "Save toward a dollar target",       icon: "💰" },
  HABIT:          { label: "Habit",           description: "Build or break a behavior",         icon: "🔁" },
  SPENDING_LIMIT: { label: "Spending limit",  description: "Cap a spending category per month", icon: "🚦" },
  DEBT_REDUCTION: { label: "Debt reduction",  description: "Pay down a specific account",       icon: "📉" },
};

const HABIT_FREQ_LABELS: Record<string, string> = {
  DAILY:   "Daily",
  WEEKLY:  "Weekly",
  MONTHLY: "Monthly",
};

function cleanAmount(raw: string) {
  const digits = raw.replace(/[^0-9.]/g, "");
  const parts  = digits.split(".");
  return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : digits;
}

function AddGoalModal({
  spaceId,
  spaceCategory,
  accounts,
  onClose,
  onCreated,
}: {
  spaceId:       string;
  spaceCategory: string;
  accounts:          SpaceAccount[];
  onClose:           () => void;
  onCreated:         () => void;
}) {
  // MC1 QA Q4b — form labels describe Space-native amounts; follow the Space's
  // display currency instead of the hardcoded USD constant.
  const displayCurrency = useDisplayCurrency();

  const showCategoryPicker = !(spaceCategory in SPACE_TO_GOAL_CATEGORY);
  const defaultCategory    = SPACE_TO_GOAL_CATEGORY[spaceCategory] ?? "GENERAL";

  const debtAccounts = accounts.filter((a) => a.type === "debt");

  const [goalType,              setGoalType]              = useState("FINANCIAL");
  const [name,                  setName]                  = useState("");
  const [category,              setCategory]              = useState(defaultCategory);
  const [targetAmount,          setTargetAmount]          = useState("");
  const [targetDate,            setTargetDate]            = useState("");
  // HABIT
  const [habitFrequency,        setHabitFrequency]        = useState("DAILY");
  // SPENDING_LIMIT
  const [spendingCategory,      setSpendingCategory]      = useState("");
  const [monthlyLimit,          setMonthlyLimit]          = useState("");
  // DEBT_REDUCTION
  const [linkedAccountId,       setLinkedAccountId]       = useState(debtAccounts[0]?.id ?? "");
  const [reductionMode,         setReductionMode]         = useState<"amount" | "pct">("amount");
  const [reductionValue,        setReductionValue]        = useState("");

  const [error, setError] = useState("");
  const [busy,  setBusy]  = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Goal name is required."); return; }

    // Type-specific validation
    if (goalType === "FINANCIAL" && !targetAmount) {
      setError("Target amount is required."); return;
    }
    if (goalType === "SPENDING_LIMIT" && !monthlyLimit) {
      setError("Monthly limit is required."); return;
    }
    if (goalType === "DEBT_REDUCTION" && !linkedAccountId) {
      setError("Select a debt account."); return;
    }

    // Build snapshot balance for debt reduction
    const linkedAccount = debtAccounts.find((a) => a.id === linkedAccountId);

    setBusy(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/goals`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:         name.trim(),
          category,
          goalType,
          targetDate:   targetDate || null,
          // FINANCIAL
          ...(goalType === "FINANCIAL" && {
            targetAmount: parseFloat(targetAmount),
          }),
          // HABIT
          ...(goalType === "HABIT" && { habitFrequency }),
          // SPENDING_LIMIT
          ...(goalType === "SPENDING_LIMIT" && {
            spendingCategory: spendingCategory.trim() || null,
            targetAmount:     parseFloat(monthlyLimit),
          }),
          // DEBT_REDUCTION
          ...(goalType === "DEBT_REDUCTION" && {
            linkedAccountId,
            snapshotBalance:       linkedAccount?.balance ?? null,
            targetReductionAmount: reductionMode === "amount" ? parseFloat(reductionValue) : null,
            targetReductionPct:    reductionMode === "pct"    ? parseFloat(reductionValue) : null,
          }),
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to create goal");
      } else {
        window.dispatchEvent(new Event(SPACE_GOALS_CHANGED_EVENT));
        onCreated();
        onClose();
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "w-full bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[var(--accent-info)]";
  const selectCls = "w-full bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--accent-info)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:max-w-md bg-[var(--modal-surface)] border border-[var(--border-hairline-strong)] rounded-2xl shadow-2xl max-h-[88dvh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-hairline)] shrink-0">
          <p className="font-semibold text-white">Add a goal</p>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="overflow-y-auto flex-1 px-5 pt-4 pb-6 space-y-4">

            {/* Goal type picker */}
            <div>
              <label className="text-xs font-medium text-[var(--text-secondary)] block mb-2">Goal type</label>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(GOAL_TYPE_META).map(([key, meta]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setGoalType(key)}
                    className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                      goalType === key
                        ? "bg-blue-500/10 border-blue-500/40 text-white"
                        : "bg-[var(--surface-inset)] border-[var(--border-hairline-strong)] text-[var(--text-secondary)] hover:border-[var(--border-hairline-strong)]"
                    }`}
                  >
                    <span className="text-base leading-none">{meta.icon}</span>
                    <span className="text-xs font-semibold mt-1">{meta.label}</span>
                    <span className="text-[10px] text-[var(--text-muted)] leading-snug">{meta.description}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Goal name */}
            <div>
              <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Goal name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  goalType === "HABIT"          ? "e.g. Eat out less" :
                  goalType === "SPENDING_LIMIT" ? "e.g. Dining budget" :
                  goalType === "DEBT_REDUCTION" ? "e.g. Pay off credit card" :
                  "e.g. Emergency fund"
                }
                className={inputCls}
              />
            </div>

            {/* Category — only for non-specific spaces */}
            {showCategoryPicker && (
              <div>
                <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={selectCls}>
                  {Object.entries(GOAL_CATEGORY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            )}

            {/* ── FINANCIAL fields ─────────────────────────── */}
            {goalType === "FINANCIAL" && (
              <>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Target amount ({displayCurrency})</label>
                  <input
                    type="text" inputMode="decimal"
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(cleanAmount(e.target.value))}
                    placeholder="10000"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Target date <span className="text-[var(--text-faint)]">(optional)</span></label>
                  <div className="w-full bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-xl overflow-hidden focus-within:border-[var(--accent-info)] transition-colors">
                    <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
                      className="block w-full bg-transparent px-3 py-2.5 text-sm text-white focus:outline-none" />
                  </div>
                </div>
              </>
            )}

            {/* ── HABIT fields ─────────────────────────────── */}
            {goalType === "HABIT" && (
              <>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Check-in frequency</label>
                  <div className="flex rounded-xl overflow-hidden border border-[var(--border-hairline-strong)]">
                    {Object.entries(HABIT_FREQ_LABELS).map(([k, v]) => (
                      <button
                        key={k} type="button"
                        onClick={() => setHabitFrequency(k)}
                        className={`flex-1 py-2 text-xs font-semibold transition-colors ${
                          habitFrequency === k
                            ? "bg-blue-500/15 text-[var(--accent-info)]"
                            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                        }`}
                      >{v}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Target date <span className="text-[var(--text-faint)]">(optional)</span></label>
                  <div className="w-full bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-xl overflow-hidden focus-within:border-[var(--accent-info)] transition-colors">
                    <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
                      className="block w-full bg-transparent px-3 py-2.5 text-sm text-white focus:outline-none" />
                  </div>
                </div>
              </>
            )}

            {/* ── SPENDING_LIMIT fields ────────────────────── */}
            {goalType === "SPENDING_LIMIT" && (
              <>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Spending category <span className="text-[var(--text-faint)]">(optional)</span></label>
                  <input
                    value={spendingCategory}
                    onChange={(e) => setSpendingCategory(e.target.value)}
                    placeholder="e.g. Dining, Subscriptions"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Monthly limit ({displayCurrency})</label>
                  <input
                    type="text" inputMode="decimal"
                    value={monthlyLimit}
                    onChange={(e) => setMonthlyLimit(cleanAmount(e.target.value))}
                    placeholder="200"
                    className={inputCls}
                  />
                </div>
              </>
            )}

            {/* ── DEBT_REDUCTION fields ────────────────────── */}
            {goalType === "DEBT_REDUCTION" && (
              <>
                {debtAccounts.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)] bg-[var(--surface-inset)] rounded-xl px-3 py-3">
                    No debt accounts found in this Space. Add a debt account first.
                  </p>
                ) : (
                  <div>
                    <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Account to pay down</label>
                    <select value={linkedAccountId} onChange={(e) => setLinkedAccountId(e.target.value)} className={selectCls}>
                      {debtAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name} — {formatBalance(a.balance, a.currency)}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-2">Reduction target</label>
                  <div className="flex rounded-xl overflow-hidden border border-[var(--border-hairline-strong)] mb-2">
                    {(["amount", "pct"] as const).map((m) => (
                      <button key={m} type="button" onClick={() => setReductionMode(m)}
                        className={`flex-1 py-2 text-xs font-semibold transition-colors ${
                          reductionMode === m ? "bg-blue-500/15 text-[var(--accent-info)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                        }`}
                      >{m === "amount" ? `${currencySymbol(displayCurrency)} Amount` : "% Percent"}</button>
                    ))}
                  </div>
                  <input
                    type="text" inputMode="decimal"
                    value={reductionValue}
                    onChange={(e) => setReductionValue(cleanAmount(e.target.value))}
                    placeholder={reductionMode === "amount" ? "e.g. 1000" : "e.g. 25"}
                    className={inputCls}
                  />
                  {reductionMode === "pct" && (
                    <p className="text-[10px] text-[var(--text-faint)] mt-1">Enter a number between 1 and 100</p>
                  )}
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Target date <span className="text-[var(--text-faint)]">(optional)</span></label>
                  <div className="w-full bg-[var(--surface-inset)] border border-[var(--border-hairline-strong)] rounded-xl overflow-hidden focus-within:border-[var(--accent-info)] transition-colors">
                    <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
                      className="block w-full bg-transparent px-3 py-2.5 text-sm text-white focus:outline-none" />
                  </div>
                </div>
              </>
            )}

            {error && <p className="text-xs text-[var(--accent-negative)]">{error}</p>}
          </div>

          {/* Pinned buttons */}
          <div className="px-5 py-4 border-t border-[var(--border-hairline)] flex gap-2 shrink-0">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-[var(--border-hairline-strong)] text-sm font-medium text-[var(--text-secondary)] hover:text-white hover:border-[var(--border-hairline-strong)] transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--accent-info)] text-sm font-medium text-white disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              Create goal
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SpaceDashboard({
  spaceId,
  spaceName,
  spaceType,
  category,
  myRole,
  currentUserId = "",
  initialTab,
  overviewTopSlot,
  snapshotCurrency,
  ficoScore,
  ficoUpdatedAt,
  perspectiveTargetCurrency,
  transactionsMoneyCtxOverride,
}: Props) {
  const router = useRouter();

  const [sections,      setSections]      = useState<DashboardSection[]>([]);
  const [accounts,      setAccounts]      = useState<SpaceAccount[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [activeTab,     setActiveTab]     = useState("");
  const [showAddGoal,   setShowAddGoal]   = useState(false);
  const [showManage,    setShowManage]    = useState(false);
  const [confirmLeave,  setConfirmLeave]  = useState(false);
  const [leaveBusy,     setLeaveBusy]    = useState(false);
  // Track whether we've set the initial tab from real data
  const initialTabSet = useRef(false);

  // Header member count — read-only fetch against an existing endpoint.
  const [memberCount,    setMemberCount]    = useState<number | null>(null);

  // Perspective Engine results (commit 7) — keyed by lensId, fetched once
  // per Space from the batch route. null = not loaded / fetch failed; the
  // cards then render their static description (graceful fallback is the
  // widget's contract, not this host's job).
  const [lensResults, setLensResults] = useState<Record<string, LensResult> | null>(null);

  // ── Space Template Redesign state ─────────────────────────────────────────
  // SpaceSnapshot history for the trend hero (chartable categories only)
  // and the KD-15-filtered transaction list (flow categories' Overview
  // preview + every shared Space's Transactions tab doorway).
  const [snapshots,         setSnapshots]         = useState<Snapshot[] | null>(null);
  const [spaceTransactions, setSpaceTransactions] = useState<Transaction[] | null>(null);
  // MC1 P4 Slice 6 (F-6) — serialized conversion context from the same fetch;
  // undefined => the panel's context-less native sums (kill switch).
  const [spaceMoneyCtx, setSpaceMoneyCtx] = useState<SerializedConversionContext | undefined>(undefined);

  // ── MC1 QA Q4 — widget/planner conversion context ──────────────────────────
  // The dashboard layout mounts DisplayCurrencyProvider with this Space's
  // reportingCurrency (this component only renders as the active Space), so
  // the hook IS the Space's currency. The view-context route covers exactly
  // what the section widgets aggregate: account balances at the latest close.
  // Fetch failure ⇒ undefined ⇒ every consumer's kill switch (today's render).
  const displayCurrency = useDisplayCurrency();
  const [widgetMoneyCtx, setWidgetMoneyCtx] = useState<SerializedConversionContext | undefined>(undefined);
  useEffect(() => {
    let active = true;
    fetch(`/api/money/view-context?target=${encodeURIComponent(displayCurrency)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setWidgetMoneyCtx(data?.moneyCtx ?? undefined); })
      .catch(() => { if (active) setWidgetMoneyCtx(undefined); });
    return () => { active = false; };
  }, [displayCurrency]);
  const widgetCtx = useMemo(
    () => (widgetMoneyCtx ? rehydrateContext(widgetMoneyCtx) : undefined),
    [widgetMoneyCtx],
  );

  // ── MC1 QA Q6 — live-update after a reporting-currency change ───────────────
  // The dashboard layout's DisplayCurrencyProvider and the /view-context fetch
  // above already follow `displayCurrency` (updated by the modal's
  // router.refresh()). But this host's OWN fetched data — snapshots (hero),
  // perspectives (converted lens metrics) and space transactions (F-6 context)
  // — keys on spaceId and would keep the old currency's values. A bump of this
  // nonce re-runs those three fetches; the tx fetch also needs its cached list
  // cleared so its "already loaded" guard lets it re-run. All server routes
  // read the Space's now-persisted reportingCurrency, so the refetch is
  // currency-correct regardless of refresh timing. All-USD: the event never
  // fires (currencyChanged is false), so nothing here ever runs.
  const [currencyNonce, setCurrencyNonce] = useState(0);
  useEffect(() => {
    function onCurrencyChanged(e: Event) {
      const detail = (e as CustomEvent<{ spaceId?: string }>).detail;
      // Ignore currency changes for other Spaces (e.g. edited from the Spaces list).
      if (detail?.spaceId && detail.spaceId !== spaceId) return;
      setSpaceTransactions(null);       // clear the tx fetch's "already loaded" guard
      setSpaceMoneyCtx(undefined);
      setCurrencyNonce((n) => n + 1);
    }
    window.addEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
    return () => window.removeEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
  }, [spaceId]);

  // Overview composition switcher (IA refactor point 2/3) — which
  // full-canvas Overview composition is shown. "overview" is the default,
  // real, always-available composition; any other value is a comingSoon
  // "Financial"-group lens (Wealth, Cash Flow) with no real composition
  // built yet, so the host shows a calm SpaceComingSoonPanel instead.
  const [composition, setComposition] = useState<string>("overview");

  const canManage = ["OWNER", "ADMIN"].includes(myRole);
  const canLeave  = !canManage; // MEMBER and VIEWER can leave

  // Data freshness — newest lastUpdated across this Space's shared accounts
  // (existing field, no new fetch). Surfaced in the header subtitle so no
  // balance is ever read without knowing how old it is (v2.5 honesty
  // slice). Client-only by construction: `accounts` starts [] and is
  // populated by a post-mount fetch, so formatRelativeTime (not SSR-safe,
  // see its doc comment in lib/format.ts) never runs during SSR.
  const newestAccountUpdate = accounts.length
    ? accounts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accounts[0].lastUpdated)
    : null;

  // Fixed rail options — starts from railVisibleTabs(railHost) (v2.5
  // honesty slice: placeholder tabs — Finances/Documents — get no rail control
  // until real; see lib/space-nav.ts). On top of that, SETTINGS only renders a
  // button for managers. ACTIVITY is now a real rail tab (Unified Space Widget
  // Layout — Activity slice): clicking it sets activeTab="ACTIVITY", which
  // renders the recent_activity section inline. Order is inherited from
  // SPACE_TAB_ORDER — these filters never reorder.
  // SP-2A-4a — host derives from spaceType instead of the previous hardcoded
  // "shared". railVisibleTabs("personal") and ("shared") return identical
  // lists today (SHARED_ONLY_PLACEHOLDER_TABS is empty), so shared Spaces —
  // and any future Personal mount — inherit the same fixed rail order.
  const railHost = spaceType === "PERSONAL" ? ("personal" as const) : ("shared" as const);
  const railOptions: { id: string; label: string; icon: React.ReactNode }[] = railVisibleTabs(railHost)
    // UX-CUST-1A correction: Settings is no longer an in-space rail tab.
    // Space-level settings (incl. section show/hide and layout controls) live
    // in ManageSpaceModal → Overview. "SETTINGS" stays a valid tab id in
    // lib/space-nav for types/back-compat, but it renders no rail button here.
    .filter((id) => id !== "SETTINGS")
    .map((id) => ({ id, label: SPACE_TAB_LABELS[id], icon: <RailTabIcon id={id} /> }));

  // "overview" is filtered out here, not in lib/perspectives.ts: it's never
  // a clickable Perspective *card* (see that file's doc comment on the
  // id) — only the PerspectiveSwitcher dropdown on Overview renders it.
  const perspectiveItems: PerspectiveCardItem[] = useMemo(
    () =>
      getPerspectivesForCategory(category)
        .filter((p) => p.id !== "overview")
        .map((p) => {
          const target = PERSPECTIVE_TARGET_TAB[p.id];
          // Engine answer for lens-backed cards (liquidity, debt). Missing
          // key (fetch pending/failed, or a lens that errored server-side
          // returns status "error") → undefined → the widget renders the
          // static description exactly as before.
          const result = p.lensId ? lensResults?.[p.lensId] : undefined;
          return target
            ? { ...p, result, onSelect: () => setActiveTab(target) }
            : { ...p, result };
        }),
    [category, lensResults]
  );

  // Overview composition switcher options (IA refactor point 2/3) — see
  // getCompositionSwitcherItems' doc comment for the inclusion rule.
  const compositionItems = useMemo(() => getCompositionSwitcherItems(category), [category]);
  const activeComposition = compositionItems.find((p) => p.id === composition);

  // ── Perspective Workspace (UX-PER-3) ───────────────────────────────────────
  // The Perspectives TAB is selector-driven (free-form tabs, not cards). The
  // selector lists the category's Perspectives (overview already excluded from
  // perspectiveItems); the selected one renders its workspace (widgets[] →
  // virtual sections → existing SectionCard) or an honest placeholder below.
  // Default = the first workspace-backed Perspective (Wealth) so the tab opens
  // on a real workspace. The Overview doorway keeps `perspectiveItems` intact.
  const [selectedPerspectiveId, setSelectedPerspectiveId] = useState<string | null>(null);
  const defaultPerspectiveId =
    perspectiveItems.find((p) => p.widgets && p.widgets.length > 0)?.id ??
    perspectiveItems[0]?.id ??
    null;
  const activePerspectiveId = selectedPerspectiveId ?? defaultPerspectiveId;
  const activePerspective = activePerspectiveId
    ? perspectiveItems.find((p) => p.id === activePerspectiveId) ?? null
    : null;

  // Overview Perspectives doorway — each workspace-backed card deep-links into
  // its Perspective workspace (tab=PERSPECTIVES + that perspective selected; the
  // URL sync then writes ?tab=perspectives&perspective=<slug>). Perspectives
  // without a workspace (e.g. Investments — coming soon) stay non-clickable
  // "Soon" placeholders. This replaces the old modal-tab routing on the doorway.
  const perspectiveDoorwayItems = useMemo(
    () =>
      perspectiveItems.map((p) =>
        p.widgets && p.widgets.length > 0
          ? { ...p, onSelect: () => { setSelectedPerspectiveId(p.id); setActiveTab("PERSPECTIVES"); } }
          : { ...p, onSelect: undefined },
      ),
    [perspectiveItems],
  );

  // ── URL-backed tab state (write) ────────────────────────────────────────────
  // Mirror activeTab (+ selected Perspective) into ?tab=…&perspective=… via
  // window.history — no server re-run, no reload. First sync canonicalizes with
  // replaceState; later user changes pushState so browser back/forward works.
  // Only rail tabs are synced; modal-routed tabs (GOALS/DEBT/…) leave the URL.
  const urlInitDone = useRef(false);
  useEffect(() => {
    if (!activeTab || typeof window === "undefined") return;
    if (!URL_SYNCED_TABS.has(activeTab)) return;
    const params = new URLSearchParams(window.location.search);
    params.set("tab", activeTab.toLowerCase());
    if (activeTab === "PERSPECTIVES" && activePerspectiveId) {
      params.set("perspective", perspectiveIdToSlug(activePerspectiveId));
    } else {
      params.delete("perspective");
    }
    const next = `${window.location.pathname}?${params.toString()}`;
    const current = `${window.location.pathname}${window.location.search}`;
    if (next === current) return;                 // already in sync (incl. after popstate)
    if (!urlInitDone.current) {
      urlInitDone.current = true;
      window.history.replaceState(window.history.state, "", next);
    } else {
      window.history.pushState(window.history.state, "", next);
    }
  }, [activeTab, activePerspectiveId]);

  // ── URL-backed tab state (read: browser back/forward) ───────────────────────
  useEffect(() => {
    function onPopState() {
      const { tab, perspective } = readUrlTabState();
      if (perspective) setSelectedPerspectiveId(perspective);
      if (tab) setActiveTab(tab);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // ── Cash Flow workspace (UX-PER-3) ─────────────────────────────────────────
  // Workspace-local period state shared by every Cash Flow widget, and the
  // transactions conversion context (rehydrated F-6 / "view as" override) that
  // converts each row at its own date. `cashFlowActive` also triggers the
  // transaction fetch below when the workspace is open in a non-flow Space.
  const [cashFlowPeriod, setCashFlowPeriod] = useState<CashFlowPeriod>(DEFAULT_CASH_FLOW_PERIOD);

  // Shared Perspective shell TIME state — the ONE canonical {preset, asOf,
  // compareTo} triple, owned by usePerspectiveShellState (the lib/perspectives/
  // time-range.ts reducer + URL sync). Defaults to MTD (As Of today, Compare To
  // the first of this month). `cashFlowPeriod` (above) follows the shell slice
  // via the sync effect below, while the Cash Flow history widget can still drill
  // to explicit calendar periods through onSelectPeriod without disturbing the
  // shell. earliestDefensibleDate = the oldest non-fxMiss snapshot (Space-level,
  // lens-independent) → powers the ALL slice's Compare To; null ⇒ never fabricated.
  const shellToday = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const earliestDefensibleDate = useMemo(
    () => snapshots?.find((s) => !s.fxMiss)?.date ?? null,
    [snapshots],
  );
  const shell = usePerspectiveShellState({ spaceId, today: shellToday, earliestDefensibleDate });
  const { asOf, compareTo, preset: timePreset } = shell.state;

  // Cash Flow follows the shell slice — synced event-driven (not via a render
  // effect): selecting a slice, or a manual Compare To that infers a preset, maps
  // to Cash Flow's relative period. The Cash Flow history widget's own explicit-
  // period drill sets cashFlowPeriod directly; under CUSTOM nothing overrides it,
  // so Cash Flow HOLDS its last period (§3.5).
  const handleAsOfChange      = (next: string)        => shell.actions.setAsOf(next);
  const handleCompareToChange = (next: string | null) => {
    shell.actions.setCompareTo(next);
    const inferred = inferPerspectiveTimePreset({ asOf, compareTo: next, coverageFrom: earliestDefensibleDate, currentPreset: timePreset });
    if (inferred !== "CUSTOM") setCashFlowPeriod(inferred);
  };
  const handleSelectSlice = (slice: CashFlowPeriod) => {
    if (isExplicitPeriod(slice)) { setCashFlowPeriod(slice); return; } // defensive; Row 2 emits relative ids
    shell.actions.selectPreset(slice);
    setCashFlowPeriod(slice);
  };

  // Wealth Time Machine read model (A6). Pure derivation over the already-fetched
  // SpaceSnapshot series + the shared shell context — no new fetch, no historical
  // computation in this component. Drives the Wealth workspace AND the shell's
  // completeness/evidence surfaces when Wealth is the active Perspective. Cheap
  // to keep memoized regardless of the active tab.
  const wealthCurrency = snapshotCurrency ?? displayCurrency;
  const wealthResult = useMemo(
    () => computeWealthTimeMachine({
      snapshots: snapshots ?? [],
      asOf,
      compareTo,
      currency: wealthCurrency,
    }),
    [snapshots, asOf, compareTo, wealthCurrency],
  );

  // Wealth chart metric (Net Worth default) — a wealth-only view toggle kept OUT
  // of the canonical time model. URL-synced with the same replaceState mechanism
  // the shell hook uses (?metric=), so a copied Perspectives URL restores it.
  // SSR-safe: default on server + first client render, hydrated post-mount.
  const WEALTH_METRICS: WealthMetricKey[] = ["netWorth", "totalAssets", "totalLiabilities", "liquidNetWorth"];
  const [chartMetric, setChartMetric] = useState<WealthMetricKey>("netWorth");
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Read on mount and re-read on back/forward — a subscription to the URL as an
    // external system (mirrors the shell hook's popstate hydration).
    const syncFromUrl = () => {
      const m = new URLSearchParams(window.location.search).get("metric");
      setChartMetric(m && (WEALTH_METRICS as string[]).includes(m) ? (m as WealthMetricKey) : "netWorth");
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleMetricChange = (m: WealthMetricKey) => {
    setChartMetric(m);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (m === "netWorth") params.delete("metric"); else params.set("metric", m);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
  };

  // Switching lens from within a workspace (e.g. Wealth's Liquid Net Worth →
  // Liquidity) changes only the active perspective — the shell's time context
  // (As Of / Compare To / preset) stays fixed (P1).
  const handleSwitchLens = (lensId: string) => setSelectedPerspectiveId(lensId);

  // The Wealth Explanation card's "View explanation and evidence" opens the same
  // Evidence drawer the shell chip does, built from the Wealth envelope's real
  // snapshot rows. Host-owned so the perspective needs no drawer of its own.
  const wealthEnvelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult, currency: wealthCurrency }),
    [wealthResult, wealthCurrency],
  );
  const [wealthEvidenceOpen, setWealthEvidenceOpen] = useState(false);
  // CF-3 — the workspace-shared Cash Flow / Spending perspective + measure filter,
  // driven by the Cash Flow History widget's selector and consumed by every Cash
  // Flow widget so they never disagree.
  const [cashFlowPerspective, setCashFlowPerspective] = useState<CashFlowPerspective>("liquidity");
  const [cashFlowFilterId, setCashFlowFilterId] = useState<string>(DEFAULT_FILTER_ID);
  const onCashFlowPerspectiveChange = (p: CashFlowPerspective, id: string) => {
    setCashFlowPerspective(p);
    setCashFlowFilterId(id);
  };
  const cashFlowActive = activeTab === "PERSPECTIVES" && activePerspectiveId === "cashFlow";
  // The Liquidity workspace's What Changed panel needs the same transaction
  // history Cash Flow uses (windowed by cashFlowPeriod). Trigger the same lazy
  // fetch when Liquidity opens first (below), and thread the rows into its branch.
  const liquidityWorkspaceActive = activeTab === "PERSPECTIVES" && activePerspectiveId === "liquidity";
  // Debt workspace needs SpaceSnapshot history (the `debt` series) for its
  // Debt History widget — trigger the snapshot fetch when it's open.
  const debtWorkspaceActive = activeTab === "PERSPECTIVES" && activePerspectiveId === "debt";
  // Goals workspace needs the Space's goals ("Am I on track?"). Fetch once when
  // it opens (mirrors the transactions/snapshots pattern).
  const goalsWorkspaceActive = activeTab === "PERSPECTIVES" && activePerspectiveId === "goals";
  // Wealth workspace needs SpaceSnapshot history for its Time Machine — trigger
  // the snapshot fetch when it's open (mirrors debtWorkspaceActive).
  const wealthWorkspaceActive = activeTab === "PERSPECTIVES" && activePerspectiveId === "wealth";
  // Investments Time Machine (A10). Unlike Wealth (a pure host memo over the
  // already-fetched snapshots), Investments' read model is server-side, so it is
  // FETCHED — keyed on the shell's resolved (asOf, compareTo), gated on the tab
  // being open (mirrors wealthWorkspaceActive / liquidityWorkspaceActive).
  // compareTo is sent only when it defines a valid strictly-earlier window (the
  // route 400s on compareTo >= asOf); the same guarded value drives the header's
  // "vs" label so it always matches the data actually fetched.
  const investmentsActive = activeTab === "PERSPECTIVES" && activePerspectiveId === "investments";
  const investmentsCompareTo = compareTo && compareTo < asOf ? compareTo : null;
  const investments = useInvestmentsTimeMachine(spaceId, asOf, investmentsCompareTo, investmentsActive);
  const [spaceGoals, setSpaceGoals] = useState<SpaceGoal[] | null>(null);
  useEffect(() => {
    if (!goalsWorkspaceActive || spaceGoals !== null) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/goals`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (active) setSpaceGoals(Array.isArray(data) ? data : []); })
      .catch(() => { if (active) setSpaceGoals([]); });
    return () => { active = false; };
  }, [spaceId, goalsWorkspaceActive, spaceGoals]);
  const txConversionCtx = useMemo(() => {
    const serialized = transactionsMoneyCtxOverride ?? spaceMoneyCtx;
    return serialized ? rehydrateContext(serialized) : undefined;
  }, [transactionsMoneyCtxOverride, spaceMoneyCtx]);

  // S4 — the Cash Flow completeness stamp (cash-flow-compare.ts), computed once
  // and shared: it drives the shell's Completeness chip (via
  // resolvePerspectiveEnvelope) AND the Key Insights caveat, so the calendar and
  // every Cash Flow panel sit under the SAME shell trust envelope. Only computed
  // when the perspective is open with data (coverage is a property of the data,
  // so the FULL history is passed, not a period slice).
  const cashFlowStampValue = useMemo(
    () => (cashFlowActive && spaceTransactions
      ? cashFlowStamp({ transactions: spaceTransactions as unknown as LiquidityTx[], period: cashFlowPeriod, now: () => new Date() })
      : null),
    [cashFlowActive, spaceTransactions, cashFlowPeriod],
  );

  async function handleLeave() {
    setLeaveBusy(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/members/${currentUserId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.push(`/dashboard/spaces?left=${encodeURIComponent(displaySpaceName(spaceName))}`);
      }
    } finally {
      setLeaveBusy(false);
    }
  }

  const loadSections = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/sections`);
    if (res.ok) {
      const secs: DashboardSection[] = await res.json();
      setSections(secs);
      return secs;
    }
    return sections;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  const loadAccounts = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/accounts`);
    if (res.ok) setAccounts(await res.json());
  }, [spaceId]);

  // ── Edit Layout mode (UX-CUST-1A) ──────────────────────────────────────────
  // Lives on the visible dashboard surface: while active, the active tab's
  // SectionCard stack shows drag handles and each drop persists the new order
  // through the reorder endpoint. `savingLayout` guards the in-flight persist.
  const [editingLayout, setEditingLayout] = useState(false);
  const [savingLayout,  setSavingLayout]  = useState(false);
  const layoutSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Leaving a tab exits Edit Layout — reorder is scoped to the tab you entered.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setEditingLayout(false); }, [activeTab]);

  // Refetch accounts whenever another component (e.g. ManageSpaceModal Finances tab) signals a change
  useEffect(() => {
    function handleAccountsChanged() { loadAccounts(); }
    window.addEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
    return () => window.removeEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
  }, [loadAccounts]);

  // (Activity slice) — the host no longer pre-fetches the activity feed for an
  // Overview doorway/modal. The recent_activity SECTION (TimelineWidget) self-
  // fetches /api/spaces/[id]/activity and paginates, so Activity owns its data.

  // Perspective Engine results — one batch fetch against the membership-
  // gated route (mirrors the activity fetch above). Failure of any kind
  // (network, 403, malformed) resolves to null: lens-backed cards then
  // keep their static descriptions — the engine's rollback property, live.
  useEffect(() => {
    let active = true;
    // MC1 view-as: when an override target is set, ask the engine to recompute
    // the lenses in that currency (headline + verdict + sums together).
    const url = perspectiveTargetCurrency
      ? `/api/spaces/${spaceId}/perspectives?target=${encodeURIComponent(perspectiveTargetCurrency)}`
      : `/api/spaces/${spaceId}/perspectives`;
    fetch(url)
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
    // currencyNonce (Q6): refetch converted lens metrics after a currency change.
    // perspectiveTargetCurrency: refetch when the "view as" override changes.
  }, [spaceId, currencyNonce, perspectiveTargetCurrency]);

  // Header member count — same endpoint SpaceMembersWidget/ManageSpaceModal use.
  useEffect(() => {
    let active = true;
    fetch(`/api/spaces/${spaceId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setMemberCount(data?.members?.length ?? null); })
      .catch(() => { if (active) setMemberCount(null); });
    return () => { active = false; };
  }, [spaceId]);

  // ── Trend hero data (Space Template Redesign) ─────────────────────────────
  // Only chartable categories (lib/space-hero.ts) fetch snapshot history.
  const heroDef = getSpaceHeroDef(category);
  useEffect(() => {
    // Unified Space Widget Layout (slice 1): Personal has no heroDef but its
    // Overview now includes the snapshot-backed `net_worth_chart` section, so
    // it still needs the snapshot fetch. Shared non-chartable categories skip
    // it as before. (Future: fetch when any snapshot-tier section is present.)
    if (!heroDef && spaceType !== "PERSONAL" && !debtWorkspaceActive && !wealthWorkspaceActive) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/snapshots`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((data) => { if (active) setSnapshots(data?.snapshots ?? []); })
      .catch(() => { if (active) setSnapshots([]); });
    return () => { active = false; };
  // currencyNonce (Q6): re-fetch the stamp-aware hero series after a currency change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, category, debtWorkspaceActive, wealthWorkspaceActive, currencyNonce]);

  // ── Space transactions (KD-15-filtered on the server) ────────────────────
  // Flow-identified templates show an Overview preview, so they fetch up
  // front; every other category fetches lazily when the Transactions tab
  // (doorway) is opened.
  const isFlowCategory = FLOW_TX_CATEGORIES.includes(category);
  useEffect(() => {
    // Fetch for flow categories, the Transactions doorway, OR the Cash Flow /
    // Liquidity Perspective workspaces (both need transaction history regardless
    // of category — Liquidity for its What Changed panel). Guarded by
    // spaceTransactions === null so it runs once.
    if (!isFlowCategory && activeTab !== "TRANSACTIONS" && !cashFlowActive && !liquidityWorkspaceActive) return;
    if (spaceTransactions !== null) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/transactions`)
      .then((r) => (r.ok ? r.json() : { transactions: [] }))
      .then((data) => {
        if (!active) return;
        setSpaceTransactions(data?.transactions ?? []);
        setSpaceMoneyCtx(data?.moneyCtx ?? undefined); // MC1 P4 Slice 6 (F-6)
      })
      .catch(() => { if (active) setSpaceTransactions([]); });
    return () => { active = false; };
  // currencyNonce (Q6): re-fetch tx rows + F-6 context after a currency change
  // (the handler also nulls spaceTransactions to release the guard above).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, isFlowCategory, activeTab, cashFlowActive, liquidityWorkspaceActive, spaceTransactions === null, currencyNonce]);

  useEffect(() => {
    Promise.all([
      fetch(`/api/spaces/${spaceId}/sections`).then((r) => r.ok ? r.json() : []),
      fetch(`/api/spaces/${spaceId}/accounts`).then((r)  => r.ok ? r.json() : []),
    ]).then(([secs, accs]: [DashboardSection[], SpaceAccount[]]) => {
      setSections(secs);
      setAccounts(accs);
      setLoading(false);

      // Set default tab from real section data — never default to SETTINGS
      if (!initialTabSet.current) {
        initialTabSet.current = true;
        // URL-backed tab state: the query string (?tab=…&perspective=…) is the
        // source of truth on load/refresh, then the caller's mapped legacy
        // initialTab, then the section-derived default below.
        const url = readUrlTabState();
        if (url.perspective) setSelectedPerspectiveId(url.perspective);
        const urlTab = url.tab ?? (initialTab || null);
        if (urlTab) {
          setActiveTab(urlTab);
          return;
        }
        const enabledTabs = new Set(secs.filter((s) => s.enabled).map((s) => s.tab));
        // Template polish: a Space with a trend hero has a real Overview
        // even when its signature modules live on other tabs (post-
        // curation Household/Business/Investment/Retirement) — open on it.
        if (getSpaceHeroDef(category)) {
          setActiveTab("OVERVIEW");
          return;
        }
        // Don't auto-default into ACTIVITY (prefer a content tab like
        // Overview/Accounts), and never open a Space directly into a
        // Perspective-routed tab: those render as GlassModals now, and landing
        // inside a modal is disorienting.
        const firstTab = TAB_ORDER.find(
          (t) => t !== "ACTIVITY" && !PERSPECTIVE_ROUTED_TABS.includes(t) && enabledTabs.has(t)
        );
        if (firstTab) {
          setActiveTab(firstTab);
        } else if (enabledTabs.has("ACTIVITY")) {
          // ACTIVITY is a real rail tab now — land on it directly (no modal).
          setActiveTab("ACTIVITY");
        } else {
          // No section tabs (e.g. CUSTOM space with no sections) — land on
          // Overview. Settings is no longer a tab; manage via ManageSpaceModal.
          setActiveTab("OVERVIEW");
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  // Template redesign: seeded section rows whose key has no SectionRegistry
  // renderer (and no debt-space legacy override) previously fell through to
  // a permanent ContextualCard "coming soon" body. Presets no longer seed
  // such keys, but EXISTING Spaces still carry the rows — gate them out at
  // render time ("nothing appears that the data cannot defend"). The rows
  // themselves are untouched (still visible/toggleable in Settings), so a
  // key regains its card the moment a renderer ships.
  const isDebtSpaceCategory = category === "DEBT_PAYOFF";
  const hasRenderer = (key: string) =>
    key in SectionRegistry ||
    (isDebtSpaceCategory && (key === "cash_flow" || key === "savings_rate"));

  // Derive tabs from enabled sections. (Settings is no longer an in-space
  // tab — section show/hide and layout controls live in ManageSpaceModal.)
  const enabledSections = sections.filter((s) => s.enabled && hasRenderer(s.key));
  const tabSet = Array.from(new Set(enabledSections.map((s) => s.tab)));
  const tabs   = TAB_ORDER.filter((t) => tabSet.includes(t));

  const catLabel = CATEGORY_LABELS[category as SpaceCategory] ?? category;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={20} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
  }

  // Unified Space Widget Layout (slice 1) — every tab (Personal OVERVIEW
  // included) renders its ordered section stack. The former renderHero
  // suppression that emptied Personal's Overview is gone: Net Worth / chart /
  // allocation are now section-backed, so Edit Layout works here naturally.
  const sectionsForTab = enabledSections
    .filter((s) => s.tab === activeTab)
    .sort((a, b) => a.order - b.order);

  // ── Edit Layout drag persistence (UX-CUST-1A) ──────────────────────────────
  // The visible stack is only the enabled+renderable subset of the tab, but the
  // reorder endpoint requires the tab's FULL permutation. So we splice the new
  // visible order back into the full tab list, keeping hidden/unrenderable
  // sections pinned at their current positions, and send that. Tab-scoped by
  // construction (only activeTab's sections are ever touched).
  const canReorderTab =
    canManage &&
    sectionsForTab.length > 1 &&
    activeTab !== "SETTINGS" && activeTab !== "ACTIVITY" &&
    !NEW_SPACE_TABS.includes(activeTab) &&
    !PERSPECTIVE_ROUTED_TABS.includes(activeTab);

  async function handleSectionDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const visibleIds = sectionsForTab.map((s) => s.id);
    const oldIdx = visibleIds.indexOf(String(active.id));
    const newIdx = visibleIds.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const newVisible = arrayMove(visibleIds, oldIdx, newIdx);

    // Full tab list in current order; substitute visible slots with the new
    // visible sequence, leave hidden sections where they are.
    const allTab = sections
      .filter((s) => s.tab === activeTab)
      .sort((a, b) => a.order - b.order);
    const visibleSet = new Set(visibleIds);
    let vp = 0;
    const fullOrderIds = allTab.map((s) => (visibleSet.has(s.id) ? newVisible[vp++] : s.id));

    // Optimistic: reassign order = index for this tab's rows.
    const orderById = new Map(fullOrderIds.map((id, i) => [id, i]));
    setSections((prev) =>
      prev.map((s) => (orderById.has(s.id) ? { ...s, order: orderById.get(s.id)! } : s)),
    );

    setSavingLayout(true);
    try {
      await fetch(`/api/spaces/${spaceId}/sections/reorder`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tab: activeTab, sectionIds: fullOrderIds }),
      });
      await loadSections();
    } finally {
      setSavingLayout(false);
    }
  }

  // ── Hero series (Space Template Redesign) ─────────────────────────────────
  // MC1 QA Q4b — drop fxMiss points (off-stamp rows whose FX rate missed, so
  // their values are native/unconverted) so the hero series never plots mixed
  // units: a shorter honest trend beats a silently mixed-magnitude one.
  const heroPoints: HeroPoint[] = heroDef && snapshots
    ? snapshots.filter((s) => !s.fxMiss).map((s) => ({ date: s.date, value: heroDef.value(s) }))
    : [];

  // Debt Space preview = the PAYMENTS story (template polish D6): only
  // rows on debt accounts. Pure render-phase filter over data already
  // fetched; other flow categories pass the list through unchanged.
  const previewTransactions: Transaction[] = (() => {
    const txs = spaceTransactions ?? [];
    if (category !== "DEBT_PAYOFF") return txs;
    const debtIds = new Set(accounts.filter((a) => a.type === "debt").map((a) => a.id));
    return txs.filter((t) => debtIds.has(t.accountId));
  })();
  const previewScopeNote =
    category === "DEBT_PAYOFF" ? `Debt accounts · ${TX_SCOPE_NOTE.toLowerCase()}` : TX_SCOPE_NOTE;

  // Emergency-fund lede: "how long could I last" — months covered, computed
  // from the existing emergency_fund_progress section config. Only shown
  // with its assumption disclosed (sublineNote); without config the hero
  // falls back to the plain savings balance.
  let heroHeadlineOverride: string | undefined;
  let heroSublineNote:      string | undefined;
  if (heroDef && category === "EMERGENCY_FUND" && heroPoints.length > 0) {
    const efCfg      = sections.find((s) => s.key === "emergency_fund_progress")?.config;
    const monthlyExp = Number(efCfg?.monthlyExpenses);
    if (!isNaN(monthlyExp) && monthlyExp > 0) {
      const months = heroPoints[heroPoints.length - 1].value / monthlyExp;
      heroHeadlineOverride = `${months.toFixed(1)} months covered`;
      // MC1 QA Q4 — the config expense figure is Space-native; label follows.
      heroSublineNote      = `at ${formatBalance(monthlyExp, displayCurrency)}/mo expenses`;
    }
  }

  // Overview doorways. (Activity slice) — the Recent Activity preview is
  // removed from Overview: Activity is now its own rail tab. The Recent
  // Transactions preview stays on flow-identified Spaces (money movement is
  // part of their story; it's a doorway to the Transactions tab, not Activity).
  // Non-flow Spaces get nothing here now.
  const recentTransactionsDoorway =
    isFlowCategory && accounts.length > 0 ? (
      <RecentTransactionsPanel
        transactions={previewTransactions}
        previewCount={5}
        scopeNote={previewScopeNote}
        onViewAll={() => setActiveTab("TRANSACTIONS")}
      />
    ) : null;

  const perspectivesDoorway =
    accounts.length > 0 ? (
      /* Doorways — hidden at day zero (every lens would open onto empty data;
         the setup card is the one call to action). */
      <div>
        <div className="flex items-center justify-between px-1 mb-2">
          <p className="text-sm font-semibold text-white">Perspectives</p>
          <button
            type="button"
            onClick={() => setActiveTab("PERSPECTIVES")}
            className="text-xs font-medium text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors"
          >
            See all
          </button>
        </div>
        <PerspectivesWidget items={perspectiveDoorwayItems} variant="row" />
      </div>
    ) : null;

  return (
    <>
      {/* (Activity slice) — the Timeline modal is gone. Activity is now a
          first-class rail tab rendering the recent_activity section inline
          (TimelineWidget, which self-fetches + paginates), so there's no
          modal to launch. */}

      {showAddGoal && (
        <AddGoalModal
          spaceId={spaceId}
          spaceCategory={category}
          accounts={accounts}
          onClose={() => setShowAddGoal(false)}
          onCreated={() => {
            setShowAddGoal(false);
            setActiveTab("GOALS");
          }}
        />
      )}

      {showManage && (
        <ManageSpaceModal
          spaceId={spaceId}
          spaceName={spaceName}
          myRole={myRole}
          currentUserId={currentUserId}
          onClose={() => setShowManage(false)}
          onRefresh={() => {
            setShowManage(false);
            loadSections();
            loadAccounts();
          }}
        />
      )}

      {/* ── Leave space confirmation (Atlas ConfirmDialog, doctrine Phase 4) ── */}
      {confirmLeave && (
        <ConfirmDialog
          onClose={() => setConfirmLeave(false)}
          onConfirm={handleLeave}
          icon={LogOut}
          title={`Leave ${displaySpaceName(spaceName)}?`}
          message={
            <>
              You&apos;ll lose access to this Space and all of its shared data.
              To rejoin, an <span className="text-white font-medium">Owner</span> or{" "}
              <span className="text-white font-medium">Admin</span> will need to manually
              re-add you.
            </>
          }
          confirmLabel="Leave Space"
          confirmIcon={<LogOut size={14} />}
          busy={leaveBusy}
        />
      )}

      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="text-xl font-bold text-white">{displaySpaceName(spaceName)}</h1>
            <p className="text-sm text-[var(--text-muted)]">
              {catLabel} Space{memberCount !== null ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : ""}
              {newestAccountUpdate ? ` · Updated ${formatRelativeTime(newestAccountUpdate)}` : ""}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0 ml-3">
            {/* Edit Layout toggle (UX-CUST-1A) — visible-surface reorder for the
                active tab's section cards. Shown only where a reorderable stack
                exists; while active it flips to Done. */}
            {(canReorderTab || editingLayout) && (
              <button
                onClick={() => setEditingLayout((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors border ${
                  editingLayout
                    ? "bg-[var(--accent-info)] text-white border-transparent"
                    : "text-[var(--text-secondary)] hover:text-white hover:bg-[var(--surface-hover)] border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]"
                }`}
              >
                {savingLayout
                  ? <Loader2 size={13} className="animate-spin" />
                  : <GripVertical size={13} />}
                {editingLayout ? "Done" : "Edit layout"}
              </button>
            )}

            {canManage && (
              <button
                onClick={() => setShowManage(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:text-white hover:bg-[var(--surface-hover)] transition-colors border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]"
              >
                <Settings size={13} />
                Manage
              </button>
            )}

            {canLeave && (
              <button
                onClick={() => setConfirmLeave(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-[var(--text-muted)] hover:text-[var(--accent-negative)] hover:bg-red-500/10 transition-colors border border-[var(--border-hairline)] hover:border-red-500/30"
              >
                <LogOut size={13} />
                Leave
              </button>
            )}
          </div>
        </div>

        {/* Tab navigation — fixed Spaces rail (lib/space-nav.ts), shared
            order across every Space type. Atlas SegmentedControl, not the
            old hand-rolled gray pill row. SHELL_NAV §2.4: a centered floating
            pill (sticky below the app header) rather than a full-width bar.

            Phase 2 §2.3 — scroll-follow swap: on the Perspectives tab the rail
            goes FULLY STATIC (rendered bare, no FloatingNavWrapper at all — not
            shrinkOnScroll={false}, which would still float/position it) so the
            Perspective track below becomes the one surface that floats + shrinks.
            Every other tab keeps the floating/shrinking rail unchanged. */}
        {(() => {
          const railControl = (
            <SegmentedControl
              aria-label="Space section"
              options={railOptions}
              value={activeTab}
              onChange={setActiveTab}
              labelVisibility="activeOnly"
            />
          );
          return activeTab === "PERSPECTIVES" ? (
            // Static + in-flow; the plain div only carries the bottom spacing the
            // floating wrapper otherwise provides — no positioning/scroll of its own.
            <div className="mb-5">{railControl}</div>
          ) : (
            <FloatingNavWrapper top={RAIL_PILL_TOP} className="mb-5">
              {railControl}
            </FloatingNavWrapper>
          );
        })()}

        {/* Settings is no longer an in-space tab (UX-CUST-1A correction):
            section show/hide and layout controls moved to ManageSpaceModal →
            Overview. Opened via the "Manage" button above. */}

        {/* Perspectives tab — free-form tab SELECTOR + the selected
            Perspective's WORKSPACE (UX-PER-3). Selecting a tab swaps the panel
            below: workspace-backed Perspectives (widgets[]) render their widgets
            through the EXISTING SectionCard/SectionRegistry compositor as
            VIRTUAL, render-only sections (no persistence, no drag/drop, no
            reorder — virtual ids never reach a mutation endpoint); others show
            an honest "coming soon" placeholder. No card grid, no enclosing
            container. Overview's Perspectives doorway is unchanged. */}
        {activeTab === "PERSPECTIVES" && (
          <div className="space-y-4">
            {/* ── Perspective shell — two framed containers (§2) ────────────────
                Container 1 (time & trust): As of / Compare to / Completeness /
                Evidence over the preset row. Container 2 (the lens): the tabs.
                Time is shared context above every Perspective; the shell writes
                shell state only through its own controls. Wealth supplies the
                Completeness/Evidence envelope; other Perspectives leave them as
                neutral placeholders until their engines drive them. */}
            <PerspectiveShell
              asOf={asOf}
              compareTo={compareTo}
              today={shellToday}
              onAsOfChange={handleAsOfChange}
              onCompareToChange={handleCompareToChange}
              onSwap={shell.actions.swap}
              envelope={resolvePerspectiveEnvelope({
                perspectiveId: activePerspectiveId ?? "",
                wealthResult,
                lensResult: activePerspectiveId ? lensResults?.[activePerspectiveId] ?? null : null,
                currency: wealthCurrency,
                cashFlowStamp: cashFlowStampValue,
                investmentsResult: investments.result,
              })}
              presetValue={timePreset === "CUSTOM" ? null : timePreset}
              onSelectPreset={handleSelectSlice}
              tabs={perspectiveItems.map((p) => ({
                id:           p.id,
                label:        p.label,
                hasWorkspace: !!(p.widgets && p.widgets.length > 0),
                icon:         p.icon,
              }))}
              activeTabId={activePerspectiveId}
              onSelectTab={setSelectedPerspectiveId}
            />

            {/* Row 4 — Perspective-specific controls slot. These stay
                Perspective-specific (never shared): Cash Flow's perspective /
                measure controls currently live in their own widgets below;
                future Perspectives surface their controls in this slot. Below it
                begins the existing widget/card stack. */}
            <div
              role="tabpanel"
              aria-labelledby={activePerspectiveId ? `ptab-${activePerspectiveId}` : undefined}
              className="space-y-3"
            >
              {activePerspectiveId === "wealth" ? (
                // Wealth Time Machine (A6) — the redesigned historical Wealth
                // workspace, driven by the shared shell context via the
                // wealthResult read model. Replaces the old current-state widget
                // stack for this Perspective only; the pure logic lives in the
                // read model, not here.
                <>
                  <WealthPerspective
                    result={wealthResult}
                    currency={wealthCurrency}
                    onSelectAsOf={shell.actions.setAsOf}
                    onSwitchLens={handleSwitchLens}
                    onViewEvidence={wealthEnvelope.evidence?.rows?.length ? () => setWealthEvidenceOpen(true) : undefined}
                    metric={chartMetric}
                    onMetricChange={handleMetricChange}
                    accounts={accounts}
                    ctx={widgetCtx}
                  />
                  {wealthEnvelope.evidence && (
                    <EvidenceDrawer
                      open={wealthEvidenceOpen}
                      onClose={() => setWealthEvidenceOpen(false)}
                      evidence={wealthEnvelope.evidence}
                    />
                  )}
                </>
              ) : activePerspectiveId === "cashFlow" ? (
                // Cash Flow Perspective — the redesigned multi-panel composition
                // (mirrors the Wealth grid pattern), replacing the generic
                // single-column SectionCard stack for this Perspective only. Time
                // stays host-owned via the existing period bridge; the exact same
                // props the SectionCard path passed reach the same five widgets.
                <CashFlowPerspectiveWorkspace
                  transactions={spaceTransactions}
                  txCtx={txConversionCtx}
                  accounts={accounts}
                  period={cashFlowPeriod}
                  onSelectPeriod={setCashFlowPeriod}
                  perspective={cashFlowPerspective}
                  filterId={cashFlowFilterId}
                  onPerspectiveChange={onCashFlowPerspectiveChange}
                  stamp={cashFlowStampValue}
                />
              ) : activePerspectiveId === "liquidity" ? (
                // Liquidity Perspective — the redesigned CURRENT-STATE-ONLY
                // multi-panel composition (mirrors the Cash Flow grid pattern),
                // replacing the generic SectionCard stack for this Perspective
                // only. No as-of / history read: the shell's As Of / Compare To
                // have zero effect here, exactly as the old stack. The lens lede
                // consumes the already-fetched lensResults["liquidity"] — no new
                // fetch, no envelope change.
                <LiquidityPerspective
                  accounts={accounts}
                  ctx={widgetCtx}
                  lensResult={lensResults?.["liquidity"] ?? null}
                  transactions={spaceTransactions}
                  txCtx={txConversionCtx}
                  period={cashFlowPeriod}
                  onOpenCashFlow={() => setSelectedPerspectiveId("cashFlow")}
                />
              ) : activePerspectiveId === "investments" ? (
                // Investments Perspective (A10) — the redesigned composition over
                // the Investments Time Machine. UNLIKE Liquidity (current-state
                // only), this perspective consumes the shell's As Of / Compare To:
                // its valuation is REAL historical pricing, so date changes
                // visibly change the numbers. The host fetch (above) is keyed on
                // the resolved dates; this branch is props-in, render-out.
                <InvestmentsPerspective
                  result={investments.result}
                  loading={investments.loading}
                  error={investments.error}
                  onRetry={investments.reload}
                  accounts={accounts}
                  spaceId={spaceId}
                  compareTo={investmentsCompareTo}
                />
              ) : activePerspectiveId === "debt" ? (
                // Debt Perspective — the redesigned CURRENT-STATE-ONLY multi-panel
                // composition (mirrors the Liquidity/Cash Flow grid pattern),
                // replacing the generic SectionCard stack for this Perspective
                // only. LIABILITIES ONLY. No as-of / history ACCOUNT read: the
                // shell's As Of / Compare To have zero effect here. Balance Over
                // Time reads the same `snapshots` array the old stack read (a
                // snapshot read, not an account as-of read). The lens lede consumes
                // the already-fetched lensResults["debt"] — no new fetch, no
                // envelope change.
                <DebtPerspective
                  accounts={accounts}
                  ctx={widgetCtx}
                  snapshots={snapshots}
                  ficoScore={ficoScore}
                  ficoUpdatedAt={ficoUpdatedAt}
                  lensResult={lensResults?.["debt"] ?? null}
                />
              ) : activePerspective?.widgets && activePerspective.widgets.length > 0 ? (
                toVirtualSections(activePerspective.id, activePerspective.widgets).map((vs) => (
                  <SectionCard
                    key={vs.id}
                    section={vs}
                    accounts={accounts}
                    spaceId={spaceId}
                    category={category}
                    canManage={canManage}
                    ctx={widgetCtx}
                    snapshots={snapshots}
                    snapshotCurrency={snapshotCurrency ?? displayCurrency}
                    transactions={spaceTransactions}
                    txCtx={txConversionCtx}
                    period={cashFlowPeriod}
                    onSelectPeriod={setCashFlowPeriod}
                    perspective={cashFlowPerspective}
                    filterId={cashFlowFilterId}
                    onPerspectiveChange={onCashFlowPerspectiveChange}
                    ficoScore={ficoScore}
                    ficoUpdatedAt={ficoUpdatedAt}
                    goals={spaceGoals}
                  />
                ))
              ) : activePerspective ? (
                <div className="text-center py-12">
                  <p className="text-sm text-[var(--text-muted)]">{activePerspective.label}</p>
                  <p className="text-xs text-[var(--text-faint)] mt-1">
                    This perspective&apos;s workspace is coming soon.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* Activity — a first-class rail tab now (Activity slice). It renders
            its recent_activity section through the shared section stack below
            (activeTab === "ACTIVITY"), like Overview/Accounts. No modal. */}

        {/* Finances / Documents — no rail control and no body on this host
            (v2.5 honesty slice): gated off the rail by
            railVisibleTabs(railHost) in lib/space-nav.ts until a real
            feature backs them. The ids remain valid members of
            NEW_SPACE_TABS so internal gating below keeps working. */}

        {/* Transactions tab — real data (Space Template Redesign): the
            doorway destination for every shared Space, and the "View all"
            target of flow templates' Overview preview. Rows come from
            GET /api/spaces/[id]/transactions, KD-15-filtered server-side,
            hence the scope note. */}
        {activeTab === "TRANSACTIONS" && (
          spaceTransactions === null ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={18} className="animate-spin text-[var(--text-faint)]" />
            </div>
          ) : (
            <SpaceTransactionsPanel
              transactions={spaceTransactions}
              accounts={accounts.map((a) => ({ ...a, type: a.type as PersonalAccount["type"] })) as PersonalAccount[]}
              scopeNote={TX_SCOPE_NOTE}
              // MC1 view-as: summary totals convert through the override context
              // when active; the panel's rows stay native either way.
              moneyCtx={transactionsMoneyCtxOverride ?? spaceMoneyCtx}
            />
          )
        )}

        {/* Members tab — real data. */}
        {activeTab === "MEMBERS" && (
          <SpaceMembersWidget spaceId={spaceId} onManage={() => setShowManage(true)} />
        )}

        {/* Goals/Debt/Investments/Retirement — Glass modal (IA refactor
            points 4 & 5), launched from the matching Perspective card.
            Same sectionsForTab/SectionCard rendering each tab always had —
            no widget/business-logic changes, just shown in a floating
            sheet instead of swapping the whole rail tab. */}
        {PERSPECTIVE_ROUTED_TABS.includes(activeTab) && (
          <GlassModal
            title={PERSPECTIVE_MODAL_META[activeTab]?.title ?? activeTab}
            icon={PERSPECTIVE_MODAL_META[activeTab]?.icon}
            size="xl"
            onClose={() => setActiveTab("OVERVIEW")}
          >
            <div className="space-y-3">
              {sectionsForTab.length === 0 ? (
                <div className="text-center py-12">
                  <LayoutDashboard size={30} className="text-[var(--text-faint)] mx-auto mb-3" />
                  <p className="text-sm text-[var(--text-muted)]">No sections on this tab</p>
                  {canManage && (
                    <button
                      onClick={() => setShowManage(true)}
                      className="mt-2 text-xs text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors"
                    >
                      Manage sections →
                    </button>
                  )}
                </div>
              ) : (
                sectionsForTab.map((s) => (
                  <SectionCard
                    key={s.id}
                    section={s}
                    accounts={accounts}
                    spaceId={spaceId}
                    category={category}
                    canManage={canManage}
                    onAddGoal={() => setShowAddGoal(true)}
                    ctx={widgetCtx}
                  />
                ))
              )}
            </div>
          </GlassModal>
        )}

        {/* Composition switcher (IA refactor point 2/3) — Overview only;
            swaps the canvas below in place. v2.5 honesty slice: only
            renders once there's a second REAL composition to switch to
            (status "available"), matching Personal's disabled
            COMPOSITION_SWITCHING_ENABLED flag — a switcher whose only
            other options are coming-soon panels is an invitation to a
            dead end. Re-enables itself the moment a Wealth or Cash Flow
            composition ships as "available" in lib/perspectives.ts. */}
        {activeTab === "OVERVIEW" &&
         compositionItems.filter((p) => p.status === "available").length > 1 && (
          <div className="flex items-center px-1 mb-3">
            <PerspectiveSwitcher items={compositionItems} value={composition} onChange={setComposition} />
          </div>
        )}

        {activeTab === "OVERVIEW" && composition !== "overview" && activeComposition && (
          <SpaceComingSoonPanel
            icon={(() => {
              const Icon = COMPOSITION_ICON_MAP[activeComposition.icon] ?? Compass;
              return <Icon size={20} />;
            })()}
            title={activeComposition.label}
            description={activeComposition.description}
          />
        )}

        {/* Section cards — section-backed tabs (Overview / Accounts / Activity).
            Untouched rendering path; gated off the rail's custom-body ids
            (NEW_SPACE_TABS), off Goals/Debt/Investments/Retirement (GlassModal
            launches), and off Overview when a comingSoon composition is active.
            ACTIVITY renders its recent_activity section here (Activity slice). */}
        {activeTab !== "SETTINGS" && !NEW_SPACE_TABS.includes(activeTab) &&
         !PERSPECTIVE_ROUTED_TABS.includes(activeTab) &&
         !(activeTab === "OVERVIEW" && composition !== "overview") && (
          <div className="space-y-3">
            {/* SP Overview refinement — additive top slot (Personal: the
                "view as" currency control), pinned above everything else on
                the OVERVIEW tab. Shared Spaces pass nothing ⇒ inert. */}
            {activeTab === "OVERVIEW" && composition === "overview" && overviewTopSlot}

            {/* Hero — the template contract's slot 1 (One Space, One Lede):
                headline + delta + this Space's primary trend, from its own
                SpaceSnapshot history. Only chartable categories have a
                heroDef; day-zero Spaces show the setup card instead.

                Shared chartable Spaces (heroDef) render SpaceTrendHero at the
                top, then their section cards. Personal has no heroDef (its
                trend is the `net_worth_chart` SECTION now), so this is inert
                for Personal — no duplicate chart. */}
            {activeTab === "OVERVIEW" && composition === "overview" &&
             accounts.length > 0 && heroDef && (
              <SpaceTrendHero
                title={heroDef.title}
                points={heroPoints}
                framing={heroDef.framing}
                chartType={heroDef.chartType}
                scopeLabel={heroDef.scopeLabel}
                loading={snapshots === null}
                headlineOverride={heroHeadlineOverride}
                sublineNote={heroSublineNote}
                // MC1 QA Q4 — SpaceSnapshot values are stamped in this Space's
                // reportingCurrency (P3 flip); the label follows the value.
                currency={displayCurrency}
              />
            )}

            {activeTab === "OVERVIEW" && !loading && accounts.length === 0 ? (
              /* Day-zero Overview (v2.5 honesty slice): one consolidated
                 setup card instead of a stack of per-widget empty states
                 that all ask for the same thing. Personal day-zero now flows
                 through here too (the hero no longer owns it). */
              <OverviewSetupCard
                canManage={canManage}
                onAddAccounts={() => setShowManage(true)}
                onAddGoal={() => setShowAddGoal(true)}
              />
            ) : sectionsForTab.length === 0 ? (
              // Template polish (D2): when the trend hero is rendering, hero +
              // change preview + doorways IS the Overview composition — an
              // empty-state card under the lede reads as breakage. Hero-less
              // categories keep the honest empty state.
              activeTab === "OVERVIEW" && (heroDef && accounts.length > 0) ? null : (
              <div className="text-center py-12">
                <LayoutDashboard size={30} className="text-[var(--text-faint)] mx-auto mb-3" />
                <p className="text-sm text-[var(--text-muted)]">No sections on this tab</p>
                {canManage && (
                  <button
                    onClick={() => setShowManage(true)}
                    className="mt-2 text-xs text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors"
                  >
                    Manage sections →
                  </button>
                )}
              </div>
              )
            ) : editingLayout && canReorderTab ? (
              /* Edit Layout (UX-CUST-1A): the same SectionCard stack, wrapped
                 for drag reorder. Single SortableContext = active tab only, so
                 reorder is tab-scoped and no card can cross tabs. Each drop
                 persists via handleSectionDragEnd. */
              <DndContext
                sensors={layoutSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleSectionDragEnd}
              >
                <SortableContext
                  items={sectionsForTab.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {sectionsForTab.map((s) => (
                    <SortableSectionCard key={s.id} section={s}>
                      <SectionCard
                        section={s}
                        accounts={accounts}
                        spaceId={spaceId}
                        category={category}
                        canManage={canManage}
                        onAddGoal={() => setShowAddGoal(true)}
                        ctx={widgetCtx}
                        snapshots={snapshots}
                        snapshotCurrency={snapshotCurrency ?? displayCurrency}
                      />
                    </SortableSectionCard>
                  ))}
                </SortableContext>
              </DndContext>
            ) : (
              sectionsForTab.map((s) => (
                <SectionCard
                  key={s.id}
                  section={s}
                  accounts={accounts}
                  spaceId={spaceId}
                  category={category}
                  canManage={canManage}
                  onAddGoal={() => setShowAddGoal(true)}
                  ctx={widgetCtx}
                  snapshots={snapshots}
                  snapshotCurrency={snapshotCurrency ?? displayCurrency}
                />
              ))
            )}

            {/* (Unified Space Widget Layout slice 1) — the former renderHero
                custom-hero seam is deleted. Personal's Net Worth / chart /
                allocation are now ordinary OVERVIEW sections rendered by the
                stack above. */}

            {/* Template contract slots 4 & 5 — change preview (Recent
                activity + Recent transactions on flow templates) and the
                Perspectives doorway. Composition, not duplication: everything
                reads data already fetched for the dedicated tabs.

                Order depends on the host: Personal puts Perspectives (E) above
                Recent Activity (F) per the canonical Personal Overview; shared
                Spaces keep the original Recent-Activity-then-Perspectives order
                (byte-identical). Both blocks are defined once above. */}
            {activeTab === "OVERVIEW" && composition === "overview" && (
              <div className="space-y-3 pt-2">
                {spaceType === "PERSONAL" ? (
                  <>
                    {perspectivesDoorway}
                    {recentTransactionsDoorway}
                  </>
                ) : (
                  <>
                    {recentTransactionsDoorway}
                    {perspectivesDoorway}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* No sections at all — only meaningful for the legacy data-driven
            tabs above; the fixed-rail tabs always have their own content. */}
        {tabs.length === 0 && !loading && activeTab !== "SETTINGS" && activeTab !== "ACTIVITY" &&
         !NEW_SPACE_TABS.includes(activeTab) && !PERSPECTIVE_ROUTED_TABS.includes(activeTab) && (
          <div className="text-center py-12">
            <LayoutDashboard size={30} className="text-[var(--text-faint)] mx-auto mb-3" />
            <p className="text-sm text-[var(--text-muted)]">No dashboard sections configured</p>
            {canManage && (
              <p className="text-xs text-[var(--text-faint)] mt-1">This Space was created without a template.</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
