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
  Eye, EyeOff, ChevronDown, ChevronUp,
  CheckCircle2, Circle, Calendar, AlertCircle,
  X, MoreHorizontal, Archive, Trash2, RotateCcw, LogOut,
  Compass, PiggyBank,
} from "lucide-react";
import { CATEGORY_LABELS, SpaceCategory } from "@/lib/space-presets";
import { getWidgetMeta } from "@/lib/widget-registry";
import { AssetValueWidget, type AssetValueConfig } from "@/components/space/widgets/AssetValueWidget";
import { ProgressWidget, type ProgressStat } from "@/components/space/widgets/ProgressWidget";
import { type BreakdownViewMode } from "@/components/space/widgets/BreakdownWidget";
import { SummaryWidget } from "@/components/space/widgets/SummaryWidget";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate, formatRelativeTime, displaySpaceName } from "@/lib/format";
import { ManageSpaceModal } from "@/components/dashboard/ManageSpaceModal";
import { simulatePayoff } from "@/components/space/sections/DebtPayoffSection";
import { renderDebtBreakdownChart, renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import { TimelineWidget } from "@/components/space/widgets/TimelineWidget";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import {
  railVisibleTabs,
  SPACE_TAB_LABELS,
  SPACE_GOALS_CHANGED_EVENT,
  SPACE_ACCOUNTS_CHANGED_EVENT,
} from "@/lib/space-nav";
import { getPerspectivesForCategory, getCompositionSwitcherItems } from "@/lib/perspectives";
import type { LensResult } from "@/lib/perspective-engine/types";
import { PerspectiveSwitcher, COMPOSITION_ICON_MAP } from "@/components/dashboard/widgets/PerspectiveSwitcher";
import type { TimelineEvent } from "@/lib/timeline-types";
import { PerspectivesWidget, type PerspectiveCardItem } from "@/components/dashboard/widgets/PerspectivesWidget";
import { SpaceTimelinePanel } from "@/components/dashboard/widgets/SpaceTimelineWidget";
import { TimelineModal } from "@/components/dashboard/widgets/TimelineModal";
import { SpaceMembersWidget } from "@/components/dashboard/widgets/SpaceMembersWidget";
import { SpaceComingSoonPanel } from "@/components/dashboard/widgets/SpaceComingSoonPanel";
import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { SpaceTrendHero, type HeroPoint } from "@/components/dashboard/widgets/SpaceTrendHero";
import { RecentTransactionsPanel } from "@/components/dashboard/widgets/RecentTransactionsPanel";
import { SpaceTransactionsPanel } from "@/components/dashboard/widgets/SpaceTransactionsPanel";
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TAB_ORDER = ["OVERVIEW", "GOALS", "ACCOUNTS", "DEBT", "INVESTMENTS", "RETIREMENT", "ACTIVITY"];

const TAB_LABELS: Record<string, string> = {
  OVERVIEW:    "Overview",
  GOALS:       "Goals",
  ACCOUNTS:    "Accounts",
  DEBT:        "Debt",
  INVESTMENTS: "Investments",
  RETIREMENT:  "Retirement",
  ACTIVITY:    "Activity",
  SETTINGS:    "Settings",
};

// ─── Fixed Spaces rail (lib/space-nav.ts) ──────────────────────────────────────
//
// The legacy data-driven tabs above (GOALS/ACCOUNTS/DEBT/INVESTMENTS/
// RETIREMENT/ACTIVITY/SETTINGS) stay exactly as they are — this dashboard is
// still section-template-driven underneath. What changes is which of them
// get their own button on the new fixed top rail (OVERVIEW, ACCOUNTS, and
// SETTINGS keep direct buttons; everything else routes through Perspectives
// or the new Timeline tab) vs. which become reachable only as a Perspective
// card, so nothing real is lost, just re-entered through one calm front door.

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

/** New tab ids that live entirely on the fixed rail (not section-driven). */
const NEW_SPACE_TABS = ["PERSPECTIVES", "TIMELINE", "FINANCES", "TRANSACTIONS", "MEMBERS", "DOCUMENTS"];

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
              <p className="text-sm font-medium text-white">{formatBalance(g.currentAmount)}</p>
              <p className="text-[10px] text-[var(--text-muted)]">of {formatBalance(g.targetAmount ?? 0)}</p>
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
              <p className={`text-sm font-medium ${overBudget ? "text-[var(--accent-negative)]" : "text-white"}`}>{formatBalance(spent)}</p>
              <p className="text-[10px] text-[var(--text-muted)]">of {formatBalance(limit)}/mo</p>
            </div>
          </div>
          <div className="h-1.5 bg-[var(--surface-inset)] rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${overBudget ? "bg-red-500" : pct > 80 ? "bg-yellow-500" : "bg-green-500"}`} style={{ width: `${pct}%` }} />
          </div>
          <p className={`text-[10px] text-right ${overBudget ? "text-[var(--accent-negative)]" : "text-[var(--text-faint)]"}`}>
            {overBudget ? `${formatBalance(spent - limit)} over budget` : `${formatBalance(limit - spent)} remaining`}
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
                {snapshot > 0 && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Started at {formatBalance(snapshot)}</p>}
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-medium text-[var(--accent-positive)]">−{formatBalance(paid)}</p>
              {target > 0 && <p className="text-[10px] text-[var(--text-muted)]">goal: −{formatBalance(target)}</p>}
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
                  <p className="text-xs text-[var(--accent-positive)] shrink-0">{formatBalance(g.targetAmount)}</p>
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

/** Sum balances from accounts matching any of the given type strings. */
function sumAccounts(accounts: SpaceAccount[], ...types: string[]): number {
  const set = new Set(types);
  return accounts.filter((a) => set.has(a.type)).reduce((s, a) => s + a.balance, 0);
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
  const assets = p.accounts.filter((a) => a.type !== "debt").reduce((s, a) => s + a.balance, 0);
  const debt   = p.accounts.filter((a) => a.type === "debt").reduce((s, a) => s + a.balance, 0);
  const net    = assets - debt;
  return (
    <SummaryWidget
      primary={p.accounts.length > 0 ? {
        value: formatBalance(net),
        label: "Net worth across all shared accounts",
        color: net >= 0 ? "white" : "red",
        size:  "3xl",
      } : undefined}
      stats={p.accounts.length > 0 ? [
        { label: "Total assets", value: formatBalance(assets), accent: "green" },
        { label: "Total debt",   value: formatBalance(debt),   accent: "red"   },
      ] : undefined}
      emptyHeadline="No accounts shared yet"
      emptySubline="Share accounts on the Spaces page to see net worth."
      emptyIcon={<LayoutDashboard size={22} className="text-[var(--text-faint)]" />}
    />
  );
};

const renderDebtSummary = (p: SectionRenderProps): React.ReactElement => {
  const debts = p.accounts.filter((a) => a.type === "debt");
  const total = debts.reduce((s, a) => s + a.balance, 0);
  return (
    <SummaryWidget
      primary={debts.length > 0 ? {
        value: formatBalance(total),
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
  const total = investments.reduce((s, a) => s + a.balance, 0);
  return (
    <SummaryWidget
      primary={investments.length > 0 ? {
        value: formatBalance(total),
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

const SectionRegistry: Record<string, (p: SectionRenderProps) => React.ReactElement> = {
  "net_worth":              renderNetWorth,
  "net_worth_section":      renderNetWorth,       // deprecated alias — seeded pre-v2
  "accounts_overview":      (p) => <AccountsCard accounts={p.accounts} />,
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
    );
  },
  "debt_payoff_calculator": (p) => renderDebtPayoffCalculator(p.accounts, p.payoffFullscreen, p.closePayoffFullscreen),
  "investment_summary":     renderInvestmentSummary,
  "investment_allocation":  renderInvestmentSummary, // TODO: replace with BreakdownWidget when adapter is ready
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
    return (
      <AssetValueWidget
        title="Property Value"
        assetType="property"
        config={cfg}
        accountBalance={match?.balance}
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
    return (
      <AssetValueWidget
        title="Vehicle Value"
        assetType="vehicle"
        config={cfg}
        accountBalance={match?.balance}
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
    return (
      <AssetValueWidget
        title="Equipment Value"
        assetType="equipment"
        config={cfg}
        accountBalance={match?.balance}
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
    const stats: ProgressStat[] = [];
    if (targetAmount != null) {
      const rem = targetAmount - currentAmount;
      stats.push({
        label:  rem >= 0 ? "Remaining" : "Over budget",
        value:  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.abs(rem)),
        accent: rem >= 0 ? "green" : "red",
      });
    }
    return (
      <ProgressWidget
        currentAmount={targetAmount != null ? currentAmount : null}
        targetAmount={targetAmount}
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
    // Live balance from shared savings/checking accounts
    const currentAmount = sumAccounts(p.accounts, "savings", "checking");
    const stats: ProgressStat[] = [];
    if (targetAmount != null) {
      const remaining = targetAmount - currentAmount;
      if (remaining > 0) {
        stats.push({
          label:  "Still needed",
          value:  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(remaining),
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
    const currentAmount  = sumAccounts(p.accounts, "savings");
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
    // Live investment account balances
    const currentAmount  = sumAccounts(p.accounts, "investment");
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
        value:  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(projected),
        accent: onTrack ? "green" : targetAmount != null ? "orange" : "default",
      });
    }
    return (
      <ProgressWidget
        currentAmount={currentAmount}
        targetAmount={targetAmount}
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

function SectionCard({
  section,
  accounts,
  spaceId,
  category,
  canManage,
  onAddGoal,
}: {
  section:     DashboardSection;
  accounts:    SpaceAccount[];
  spaceId: string;
  category:    string;
  canManage:   boolean;
  onAddGoal?:  () => void;
}) {
  const [collapsed,        setCollapsed]        = useState(false);
  const [payoffFullscreen, setPayoffFullscreen] = useState(false);
  // useState instead of useRef so the React Compiler doesn't flag the ref being
  // referenced in functions passed through renderBody during render.
  const [savedScrollY,    setSavedScrollY]     = useState(0);
  const isDebtSpace = category === "DEBT_PAYOFF";

  function openPayoffFullscreen() {
    setSavedScrollY(window.scrollY);
    setPayoffFullscreen(true);
  }

  function closePayoffFullscreen() {
    setPayoffFullscreen(false);
    // rAF defers until after React's re-render commits, preventing scroll reset
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
  }

  // Override stale section labels for existing seeded debt spaces
  const displayLabel = isDebtSpace && section.key === "cash_flow"    ? "Debt Breakdown"
                     : isDebtSpace && section.key === "savings_rate" ? "Payoff Planner"
                     : section.label;

  // Debt Breakdown and Activity feed are never collapsible
  const isDebtBreakdown = (isDebtSpace && section.key === "cash_flow") || section.key === "debt_breakdown_chart" || section.key === "recent_activity";
  // Payoff Planner shows a summary when collapsed
  const isDebtPayoff    = (isDebtSpace && section.key === "savings_rate") || section.key === "debt_payoff_calculator";

  // ── Payoff summary for collapsed state ─────────────────────────────────────
  let payoffSummary: string | null = null;
  if (isDebtPayoff) {
    const debtAccs  = accounts.filter((a) => a.type === "debt");
    const totalBal  = debtAccs.reduce((s, a) => s + a.balance, 0);
    const totalMin  = debtAccs.reduce((s, a) => s + (a.minimumPayment ?? 0), 0);
    if (totalBal > 0 && totalMin > 0) {
      const avgApr      = debtAccs.reduce((s, a) => s + (a.interestRate ?? 0) * a.balance, 0) / totalBal;
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
      );
    }
    if (isDebtSpace && section.key === "savings_rate") return renderDebtPayoffCalculator(accounts, payoffFullscreen, closePayoffFullscreen);

    const render = SectionRegistry[section.key];
    if (render) return render({ accounts, spaceId, canManage, onAddGoal, payoffFullscreen, closePayoffFullscreen, config: section.config });
    return <ContextualCard sectionKey={section.key} label={section.label} />;
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

// ─── Settings tab ─────────────────────────────────────────────────────────────

function SettingsTab({
  sections,
  spaceId,
  onUpdate,
}: {
  sections:    DashboardSection[];
  spaceId: string;
  onUpdate:    () => void;
}) {
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggleSection(s: DashboardSection) {
    setTogglingId(s.id);
    try {
      await fetch(`/api/spaces/${spaceId}/sections/${s.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ enabled: !s.enabled }),
      });
      onUpdate();
    } finally {
      setTogglingId(null);
    }
  }

  const byTab = sections.reduce<Record<string, DashboardSection[]>>((acc, s) => {
    (acc[s.tab] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <p className="text-xs text-[var(--text-muted)]">
        Toggle sections to show or hide them on this Space&apos;s dashboard. Changes apply to all members.
      </p>
      {Object.entries(byTab).map(([tab, items]) => (
        <div key={tab}>
          <p className="text-[10px] font-semibold text-[var(--text-faint)] uppercase tracking-widest mb-2">
            {TAB_LABELS[tab] ?? tab}
          </p>
          <div className="space-y-1">
            {items.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[var(--surface-inset)]">
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${s.enabled ? "text-white" : "text-[var(--text-muted)]"}`}>
                    {s.label}
                  </p>
                </div>
                <button
                  onClick={() => toggleSection(s)}
                  disabled={togglingId === s.id}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    s.enabled
                      ? "bg-blue-600/20 text-[var(--accent-info)] hover:bg-blue-600/30"
                      : "bg-[var(--surface-inset)] text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {togglingId === s.id
                    ? <Loader2 size={11} className="animate-spin" />
                    : s.enabled
                      ? <><Eye     size={11} /> Shown</>
                      : <><EyeOff  size={11} /> Hidden</>}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

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
  const displayCurrency = DEFAULT_DISPLAY_CURRENCY;

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
                        <option key={a.id} value={a.id}>{a.name} — {formatBalance(a.balance)}</option>
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
                      >{m === "amount" ? `$ Amount` : "% Percent"}</button>
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
  category,
  myRole,
  currentUserId = "",
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

  // Fixed-rail additions — Timeline (real activity + placeholder event
  // types) and the header member count, both read-only fetches against
  // existing, unmodified endpoints. See SpaceTimelinePanel / SpaceMembersWidget.
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[] | null>(null);
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

  // Fixed rail options — starts from railVisibleTabs("shared") (v2.5
  // honesty slice: placeholder tabs — Finances/Documents, plus Transactions
  // on non-personal Spaces — get no rail control until real; see
  // lib/space-nav.ts). On top of that, SETTINGS only renders a button for
  // managers, matching the old tabs.push("SETTINGS") gate below. TIMELINE
  // is excluded too: it's now a modal launched from Overview's "Recent
  // activity" preview (IA refactor point 1), not its own rail page —
  // "TIMELINE" stays a valid activeTab value (NEW_SPACE_TABS,
  // setActiveTab("TIMELINE") below) that now opens the modal instead of
  // switching rail pages. Order is inherited from SPACE_TAB_ORDER — these
  // filters never reorder.
  const railOptions: { id: string; label: string }[] = railVisibleTabs("shared")
    .filter((id) => id !== "SETTINGS" || canManage)
    .filter((id) => id !== "TIMELINE")
    .map((id) => ({ id, label: SPACE_TAB_LABELS[id] }));

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

  // Refetch accounts whenever another component (e.g. ManageSpaceModal Finances tab) signals a change
  useEffect(() => {
    function handleAccountsChanged() { loadAccounts(); }
    window.addEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
    return () => window.removeEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
  }, [loadAccounts]);

  // Timeline data — real events from the existing activity route ONLY.
  // v2.5 honesty slice: FUTURE_TIMELINE_EVENTS preview rows are no longer
  // merged in — a Space's timeline shows what actually happened, and the
  // presenter's built-in empty state ("Nothing has happened in this Space
  // yet") takes over when that's nothing. Event types with no producer yet
  // simply don't appear until their producers ship.
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

  // Perspective Engine results — one batch fetch against the membership-
  // gated route (mirrors the activity fetch above). Failure of any kind
  // (network, 403, malformed) resolves to null: lens-backed cards then
  // keep their static descriptions — the engine's rollback property, live.
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
    if (!heroDef) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/snapshots`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((data) => { if (active) setSnapshots(data?.snapshots ?? []); })
      .catch(() => { if (active) setSnapshots([]); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, category]);

  // ── Space transactions (KD-15-filtered on the server) ────────────────────
  // Flow-identified templates show an Overview preview, so they fetch up
  // front; every other category fetches lazily when the Transactions tab
  // (doorway) is opened.
  const isFlowCategory = FLOW_TX_CATEGORIES.includes(category);
  useEffect(() => {
    if (!isFlowCategory && activeTab !== "TRANSACTIONS") return;
    if (spaceTransactions !== null) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/transactions`)
      .then((r) => (r.ok ? r.json() : { transactions: [] }))
      .then((data) => { if (active) setSpaceTransactions(data?.transactions ?? []); })
      .catch(() => { if (active) setSpaceTransactions([]); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, isFlowCategory, activeTab, spaceTransactions === null]);

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
        const enabledTabs = new Set(secs.filter((s) => s.enabled).map((s) => s.tab));
        // Template polish: a Space with a trend hero has a real Overview
        // even when its signature modules live on other tabs (post-
        // curation Household/Business/Investment/Retirement) — open on it.
        if (getSpaceHeroDef(category)) {
          setActiveTab("OVERVIEW");
          return;
        }
        // ACTIVITY no longer has a rail button of its own — the fixed
        // Timeline tab (real activity feed + placeholder event types)
        // covers it now, so skip straight past it here. Also never open a
        // Space directly into a Perspective-routed tab: those render as
        // GlassModals now, and landing inside a modal is disorienting.
        const firstTab = TAB_ORDER.find(
          (t) => t !== "ACTIVITY" && !PERSPECTIVE_ROUTED_TABS.includes(t) && enabledTabs.has(t)
        );
        if (firstTab) {
          setActiveTab(firstTab);
        } else if (enabledTabs.has("ACTIVITY")) {
          setActiveTab("TIMELINE");
        } else if (canManage) {
          // CUSTOM space with no sections — Settings is fine here
          setActiveTab("SETTINGS");
        } else {
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

  // Derive tabs from enabled sections (plus Settings for admins)
  const enabledSections = sections.filter((s) => s.enabled && hasRenderer(s.key));
  const tabSet = Array.from(new Set(enabledSections.map((s) => s.tab)));
  const tabs   = TAB_ORDER.filter((t) => tabSet.includes(t));
  if (canManage) tabs.push("SETTINGS");

  const catLabel = CATEGORY_LABELS[category as SpaceCategory] ?? category;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={20} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
  }

  const sectionsForTab = enabledSections
    .filter((s) => s.tab === activeTab)
    .sort((a, b) => a.order - b.order);

  // ── Hero series (Space Template Redesign) ─────────────────────────────────
  const heroPoints: HeroPoint[] = heroDef && snapshots
    ? snapshots.map((s) => ({ date: s.date, value: heroDef.value(s) }))
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
      heroSublineNote      = `at ${formatBalance(monthlyExp)}/mo expenses`;
    }
  }

  return (
    <>
      {/* Timeline modal — reuses activeTab === "TIMELINE"/"ACTIVITY" as the
          open/closed flag (same toggle setActiveTab("TIMELINE") below and
          deep links already drive), so nothing else about tab state needs
          to change. No sub-nav filter here yet — unlike DashboardClient.tsx,
          this dashboard has never had a Timeline filter row, so `filters`
          is simply omitted (TimelineModal renders with no toolbar). */}
      {(activeTab === "TIMELINE" || activeTab === "ACTIVITY") && (
        <TimelineModal
          events={timelineEvents ?? []}
          loading={timelineEvents === null}
          onClose={() => setActiveTab("OVERVIEW")}
        />
      )}

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
            old hand-rolled gray pill row. */}
        <SegmentedControl
          aria-label="Space section"
          className="w-full mb-5"
          options={railOptions}
          value={activeTab}
          onChange={setActiveTab}
        />

        {/* Settings tab */}
        {activeTab === "SETTINGS" && (
          <SettingsTab
            sections={sections}
            spaceId={spaceId}
            onUpdate={loadSections}
          />
        )}

        {/* Perspectives tab — full grid. */}
        {activeTab === "PERSPECTIVES" && (
          <PerspectivesWidget items={perspectiveItems} variant="grid" />
        )}

        {/* Timeline — no longer an inline tab body (IA refactor point 1).
            activeTab === "TIMELINE"/"ACTIVITY" now just gates the
            TimelineModal mount near the top of this component, instead of
            switching what renders in the rail's content area. */}

        {/* Finances / Documents — no rail control and no body on this host
            (v2.5 honesty slice): gated off the rail by
            railVisibleTabs("shared") in lib/space-nav.ts until a real
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
                      onClick={() => setActiveTab("SETTINGS")}
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

        {/* Section cards — legacy data-driven tabs (Overview/Accounts).
            Untouched rendering path; just gated off the rail's new ids now
            that those have their own blocks, off Goals/Debt/Investments/
            Retirement now that they're GlassModal launches (IA refactor
            point 5) instead of full tab swaps, and off Overview specifically
            when a comingSoon composition is active (the ComingSoonPanel
            above takes its place). */}
        {activeTab !== "SETTINGS" && activeTab !== "ACTIVITY" && !NEW_SPACE_TABS.includes(activeTab) &&
         !PERSPECTIVE_ROUTED_TABS.includes(activeTab) &&
         !(activeTab === "OVERVIEW" && composition !== "overview") && (
          <div className="space-y-3">
            {/* Hero — the template contract's slot 1 (One Space, One Lede):
                headline + delta + this Space's primary trend, from its own
                SpaceSnapshot history. Only chartable categories have a
                heroDef; day-zero Spaces show the setup card instead. */}
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
              />
            )}

            {activeTab === "OVERVIEW" && !loading && accounts.length === 0 ? (
              /* Day-zero Overview (v2.5 honesty slice): one consolidated
                 setup card instead of a stack of per-widget empty states
                 that all ask for the same thing. Other tabs keep their own
                 per-section empty states. */
              <OverviewSetupCard
                canManage={canManage}
                onAddAccounts={() => setShowManage(true)}
                onAddGoal={() => setShowAddGoal(true)}
              />
            ) : sectionsForTab.length === 0 ? (
              // Template polish (D2): when the hero is rendering, hero +
              // change preview + doorways IS the Overview composition — an
              // empty-state card under the lede reads as breakage. Other
              // tabs (and hero-less categories) keep the honest empty state.
              activeTab === "OVERVIEW" && heroDef && accounts.length > 0 ? null : (
              <div className="text-center py-12">
                <LayoutDashboard size={30} className="text-[var(--text-faint)] mx-auto mb-3" />
                <p className="text-sm text-[var(--text-muted)]">No sections on this tab</p>
                {canManage && (
                  <button
                    onClick={() => setActiveTab("SETTINGS")}
                    className="mt-2 text-xs text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors"
                  >
                    Manage sections →
                  </button>
                )}
              </div>
              )
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
                />
              ))
            )}

            {/* Template contract slots 4 & 5 — change preview (Recent
                activity + Recent transactions on flow templates), then
                doorways (Perspectives row) LAST. Composition, not
                duplication: everything reads data already fetched for the
                dedicated tabs. */}
            {activeTab === "OVERVIEW" && composition === "overview" && (
              <div className="space-y-3 pt-2">
                {isFlowCategory && accounts.length > 0 ? (
                  /* Flow-identified templates: money movement is part of the
                     story — Transactions is first-class, scope-labeled
                     (KD-15 makes shared lists structurally partial). */
                  <div className="md:grid md:grid-cols-2 md:gap-3 space-y-3 md:space-y-0">
                    <SpaceTimelinePanel
                      title="Recent activity"
                      events={timelineEvents ?? []}
                      loading={timelineEvents === null}
                      variant="preview"
                      previewCount={4}
                      onViewAll={() => setActiveTab("TIMELINE")}
                    />
                    <RecentTransactionsPanel
                      transactions={previewTransactions}
                      previewCount={5}
                      scopeNote={previewScopeNote}
                      onViewAll={() => setActiveTab("TRANSACTIONS")}
                    />
                  </div>
                ) : (
                  <SpaceTimelinePanel
                    title="Recent activity"
                    events={timelineEvents ?? []}
                    loading={timelineEvents === null}
                    variant="preview"
                    previewCount={4}
                    onViewAll={() => setActiveTab("TIMELINE")}
                  />
                )}

                {/* Doorways — hidden at day zero (every lens would open
                    onto empty data; the setup card is the one call to
                    action). */}
                {accounts.length > 0 && (
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
                    <PerspectivesWidget items={perspectiveItems} variant="row" />
                  </div>
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
