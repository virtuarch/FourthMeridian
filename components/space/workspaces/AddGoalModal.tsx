"use client";

/**
 * components/space/workspaces/AddGoalModal.tsx  (SD-7)
 *
 * The Add-Goal capability (the GOALS destination's overlay), extracted verbatim from
 * SpaceDashboard: the inline goal-creation modal + its goal-taxonomy constants
 * (GOAL_CATEGORY_LABELS / SPACE_TO_GOAL_CATEGORY / GOAL_TYPE_META / HABIT_FREQ_LABELS)
 * and the cleanAmount input helper. Architecture-only — byte-identical markup and
 * behavior. The host keeps only the `showAddGoal` trigger state (a cross-cutting
 * affordance opened from Overview's setup card, section cards, and the routed modal)
 * and mounts <AddGoalModal> as a shell overlay.
 */

import React, { useState } from "react";
import { Loader2, X } from "lucide-react";
// Unified Space Widget Layout (slice 1) — Personal Overview lede widgets, now
// section-backed (net_worth_chart + allocation).
import { SPACE_GOALS_CHANGED_EVENT } from "@/lib/space-nav";
import { useDisplayCurrency } from "@/lib/currency-context";
import type { SpaceAccount } from "@/lib/space/dashboard-types";
import { formatBalance, currencySymbol } from "@/components/space/sections/SpaceSections";

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


// OverviewSetupCard (the day-zero Overview state) moved to
// components/space/workspaces/OverviewWorkspace.tsx (SD-7).

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

export function AddGoalModal({
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
