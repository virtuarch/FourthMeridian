"use client";

/**
 * components/space/sections/goals/GoalsCard.tsx  (SEC-1)
 *
 * The Space Goals card — the canonical goal LIST + LIFECYCLE surface (the
 * `goals_progress` section renderer). Extracted verbatim from SpaceSections.tsx:
 * this is a self-contained feature (fetches its own goals by spaceId, owns the
 * complete/archive/unarchive/trash/restore/permanent-delete + habit check-in
 * lifecycle, and renders all four goal-type bodies + the trash drawer) — a
 * capability, not section-dispatch machinery, so it lives in its own module and
 * the SectionRegistry entry simply mounts it.
 *
 * Authority: this is the single goal-list authority (goal CREATION is the
 * separate canonical AddGoalModal). Byte-identical to the former inline
 * definition; only relocated (and formatBalance now imported from the single
 * lib/currency authority per SEC-3, breaking the former same-file coupling).
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Loader2, Target, Plus, ChevronDown, ChevronUp, CheckCircle2, Circle,
  Calendar, AlertCircle, X, MoreHorizontal, Archive, Trash2, RotateCcw,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import { formatBalance } from "@/lib/currency";
import { SPACE_GOALS_CHANGED_EVENT } from "@/lib/space-nav";
import { useDisplayCurrency } from "@/lib/currency-context";
import type { SpaceGoal } from "@/lib/space/dashboard-types";

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

export function GoalsCard({
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
