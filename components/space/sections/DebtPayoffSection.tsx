"use client";

/**
 * DebtPayoffSection
 *
 * Interactive debt payoff planner for space dashboards.
 * Supports both an embedded card view and a full-screen modal view.
 *
 * Extracted from SpaceDashboard.tsx to keep that file manageable.
 */

import { useState, useEffect } from "react";
import { CreditCard, X } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatMonthYear } from "@/lib/format";
import { useBodyScrollLock } from "@/components/atlas/useBodyScrollLock";

// ─── Types ────────────────────────────────────────────────────────────────────

// Minimal account fields needed by this component.
// Structurally compatible with SpaceDashboard's SpaceAccount type.
export type DebtPayoffAccount = {
  id:              string;
  name:            string;
  type:            string;
  institution:     string;
  balance:         number;
  currency:        string;
  interestRate?:   number;  // APR, e.g. 19.99
  minimumPayment?: number;  // monthly minimum
};

type PayFreq = "week" | "month" | "year";

type PayoffResult = { months: number; totalPaid: number; totalInterest: number };

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatBalance(amount: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

// Debt-account viz palette: a red gradient that ranks accounts by balance.
// This is data visualisation (per-account differentiation), not card chrome —
// intentionally preserved through the Atlas token migration.
function debtColor(i: number, n: number): string {
  const t = n > 1 ? i / (n - 1) : 0;
  const r = Math.round(185 + (249 - 185) * t);
  const g = Math.round(28  + (115 - 28)  * t);
  const b = Math.round(28  + (22  - 28)  * t);
  return `rgb(${r},${g},${b})`;
}

// Darkest red convenience (totals, primary debt figures)
const DEBT_RED = debtColor(0, 1);

/**
 * Simulate amortization month-by-month so the last payment is exact
 * (not a full monthly payment). This avoids over-counting interest.
 *
 * Exported so callers that only need the calculation (e.g. collapsed section
 * summary text in SpaceDashboard) don't have to duplicate the logic.
 */
export function simulatePayoff(balance: number, monthlyRate: number, payment: number): PayoffResult | null {
  if (payment <= 0 || balance <= 0) return null;
  if (monthlyRate <= 0) {
    const months = Math.ceil(balance / payment);
    return { months, totalPaid: balance, totalInterest: 0 };
  }
  const firstInterest = balance * monthlyRate;
  if (payment <= firstInterest) return null; // payment doesn't cover interest

  let remaining = balance;
  let totalPaid = 0;
  let months = 0;
  const MAX_MONTHS = 600;

  while (remaining > 0.005 && months < MAX_MONTHS) {
    const interest = remaining * monthlyRate;
    if (payment >= remaining + interest) {
      totalPaid += remaining + interest;
      remaining = 0;
    } else {
      remaining = remaining + interest - payment;
      totalPaid += payment;
    }
    months++;
  }

  if (months >= MAX_MONTHS) return null;
  return { months, totalPaid, totalInterest: Math.max(0, totalPaid - balance) };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DebtPayoffSection({
  accounts,
  fullscreen     = false,
  onCloseFullscreen,
}: {
  accounts:           DebtPayoffAccount[];
  fullscreen?:        boolean;
  onCloseFullscreen?: () => void;
}) {
  const debtAccounts = accounts.filter((a) => a.type === "debt");
  // Sort by balance descending so color ranks match the breakdown chart
  const sortedDebtAccounts = [...debtAccounts].sort((a, b) => b.balance - a.balance);
  const debtColorFor = (id: string) => {
    const idx = sortedDebtAccounts.findIndex((a) => a.id === id);
    return debtColor(idx < 0 ? 0 : idx, sortedDebtAccounts.length);
  };

  const [freq,        setFreq]        = useState<PayFreq>("month");
  const [amount,      setAmount]      = useState(500);
  const [inputStr,    setInputStr]    = useState("500");
  // Track explicit user deselections; new accounts auto-include, removed ones auto-exclude
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set());

  // Lock body scroll while fullscreen — shared nest-safe helper that also
  // preserves/restores window.scrollY (doctrine §14). Replaces the former
  // bare `body.style.overflow` toggle, which is what SpaceDashboard used to
  // compensate for with a manual scrollY save/restore.
  useBodyScrollLock(fullscreen);

  // ESC closes fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseFullscreen?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen, onCloseFullscreen]);

  function toggleAccount(id: string) {
    setDeselectedIds((prev) => {
      if (prev.has(id)) {
        // Re-selecting — always allowed
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      // Deselecting — guard: must leave at least one selected
      const selectedCount = debtAccounts.length - prev.size;
      if (selectedCount <= 1) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function selectAll() { setDeselectedIds(new Set()); }

  const filtered     = debtAccounts.filter((a) => !deselectedIds.has(a.id));
  const allSelected  = deselectedIds.size === 0;
  const total        = filtered.reduce((s, a) => s + a.balance, 0);

  const withRate    = filtered.filter((a) => a.interestRate != null && a.balance > 0);
  const weightedApr = withRate.length > 0
    ? withRate.reduce((s, a) => s + (a.interestRate! * a.balance), 0)
      / withRate.reduce((s, a) => s + a.balance, 0)
    : null;
  const hasRates = weightedApr != null;

  const minPayment = filtered.reduce((s, a) => s + (a.minimumPayment ?? 0), 0);

  const monthlyEquiv = freq === "week" ? (amount * 52) / 12
                     : freq === "year" ? amount / 12
                     : amount;

  const sliderMax = Math.max(5000, Math.ceil(total));

  const monthlyRate   = hasRates ? (weightedApr! / 100) / 12 : 0;
  const result        = simulatePayoff(total, monthlyRate, monthlyEquiv);
  const months        = result?.months ?? null;
  const totalInterest = (result && hasRates) ? result.totalInterest : null;
  const totalPaid     = result ? result.totalPaid : null;
  const years         = months != null ? Math.floor(months / 12) : null;
  const remMonths     = months != null ? months % 12 : null;
  const payoffDate    = months != null
    ? formatMonthYear(new Date(new Date().getTime() + months * 30.44 * 24 * 60 * 60 * 1000).toISOString())
    : null;

  function timeLabel() {
    if (months == null) return "Payment too low";
    if (years === 0)     return `${months} month${months !== 1 ? "s" : ""}`;
    if (remMonths === 0) return `${years} year${years !== 1 ? "s" : ""}`;
    return `${years}y ${remMonths}mo`;
  }

  function handleInput(val: string) {
    setInputStr(val);
    const n = parseFloat(val.replace(/[^0-9.]/g, ""));
    if (!isNaN(n) && n > 0) setAmount(Math.min(n, sliderMax));
  }

  function handleSlider(val: number) {
    setAmount(val);
    setInputStr(String(val));
  }

  const freqLabel = freq === "week" ? "Weekly" : freq === "year" ? "Yearly" : "Monthly";

  // Empty state — placed after all hooks/computations to satisfy rules-of-hooks
  if (debtAccounts.length === 0) {
    return (
      <div className="text-center py-5">
        <CreditCard size={22} className="mx-auto mb-2" style={{ color: "var(--text-faint)" }} />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No debt accounts shared yet</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>Share debt accounts to use the payoff planner.</p>
      </div>
    );
  }

  // ── Shared sub-components used by both views ─────────────────────────────
  const freqToggle = (
    <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: "var(--border-hairline)" }}>
      {(["month", "week"] as const).map((f) => (
        <button
          key={f}
          onClick={() => setFreq(f)}
          className={`text-[10px] font-semibold px-2.5 py-1 transition-colors ${
            freq === f ? "" : "hover:text-[var(--text-secondary)]"
          }`}
          style={freq === f
            ? { backgroundColor: "var(--surface-hover-strong)", color: "var(--accent-info)" }
            : { color: "var(--text-faint)" }}
        >
          {f === "month" ? "Mo" : "Wk"}
        </button>
      ))}
    </div>
  );

  const paymentInput = (wide = false) => (
    <div className={`flex items-center rounded-lg px-3 py-1.5 gap-1 ${wide ? "w-full" : ""}`} style={{ background: "var(--surface-inset)" }}>
      <span className="text-sm" style={{ color: "var(--text-muted)" }}>$</span>
      <input
        type="text"
        inputMode="decimal"
        value={inputStr}
        onChange={(e) => handleInput(e.target.value)}
        onBlur={() => setInputStr(String(amount))}
        className={`bg-transparent font-semibold text-right outline-none ${wide ? "flex-1 text-lg" : "w-20 text-sm"}`}
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );

  const sliderPct   = sliderMax > 50 ? ((Math.min(amount, sliderMax) - 50) / (sliderMax - 50)) * 100 : 0;
  const sliderLight = debtColor(sortedDebtAccounts.length > 1 ? sortedDebtAccounts.length - 1 : 0, sortedDebtAccounts.length);
  const sliderDark  = debtColor(0, sortedDebtAccounts.length);

  const slider = (
    <div className="relative w-full py-2">
      {/* Track */}
      <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${sliderPct}%`,
            background: `linear-gradient(to right, ${sliderLight}, ${sliderDark})`,
          }}
        />
      </div>
      {/* Thumb */}
      <div
        className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-white shadow border pointer-events-none -translate-y-1/2"
        style={{ left: `calc(${sliderPct / 100} * (100% - 14px) + 7px)`, borderColor: "var(--border-hairline-strong)" }}
      />
      {/* Native input — invisible but handles interaction */}
      <input
        type="range"
        min={50}
        max={sliderMax}
        step={50}
        value={Math.min(amount, sliderMax)}
        onChange={(e) => handleSlider(Number(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
    </div>
  );

  const breakdown = (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border-hairline)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-widest px-3 pt-3 pb-1.5" style={{ color: "var(--text-faint)" }}>
        Estimated total paid
      </p>
      <div className="divide-y divide-[var(--border-hairline)]">
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Principal</p>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{formatBalance(total)}</p>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Interest{hasRates ? ` (${weightedApr!.toFixed(2)}% APR)` : ""}
          </p>
          {hasRates && totalInterest != null ? (
            <p className="text-sm font-medium" style={{ color: debtColor(Math.floor(sortedDebtAccounts.length / 2), sortedDebtAccounts.length) }}>+{formatBalance(totalInterest)}</p>
          ) : (
            <p className="text-xs" style={{ color: "var(--text-faint)" }}>— add APR to account for estimate</p>
          )}
        </div>
        <div className="flex items-center justify-between px-3 py-2.5" style={{ background: "var(--surface-muted)" }}>
          <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>Total paid</p>
          <p className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
            {totalPaid != null ? formatBalance(totalPaid) : formatBalance(total)}
          </p>
        </div>
      </div>
    </div>
  );

  const disclaimer = (
    <p className="text-[10px] text-center" style={{ color: "var(--text-faint)" }}>
      {hasRates
        ? "Estimate only · actual totals may vary based on billing cycles, fees, and rate changes"
        : "Simplified estimate · add APR to accounts for interest-aware calculation"}
    </p>
  );

  // ── Full-screen modal ─────────────────────────────────────────────────────
  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 backdrop-blur-sm" style={{ background: "var(--scrim)" }}>
        <div
          className="w-full sm:max-w-3xl rounded-2xl shadow-2xl flex flex-col max-h-[88dvh] border"
          style={{ background: "var(--modal-surface)", borderColor: "var(--border-hairline-strong)" }}
        >

          {/* Header */}
          <div className="flex items-start justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: "var(--border-hairline)" }}>
            <div>
              <p className="text-base font-bold" style={{ color: "var(--text-primary)" }}>Payoff Planner</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                {debtAccounts.length} account{debtAccounts.length !== 1 ? "s" : ""}
                {hasRates ? ` · ${weightedApr!.toFixed(2)}% avg APR` : ""}
              </p>
            </div>
            <button
              onClick={onCloseFullscreen}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={18} />
            </button>
          </div>

          {/* Body — single column on mobile, two columns on desktop */}
          <div className="flex-1 overflow-y-auto">

            {/* ── Mobile layout ─────────────────────────────────── */}
            <div className="sm:hidden px-4 pt-3 pb-6 space-y-3">

              {debtAccounts.length > 1 && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>Accounts</p>
                    {!allSelected && (
                      <button onClick={selectAll} className="text-[10px] transition-colors" style={{ color: "var(--accent-info)" }}>
                        Select all
                      </button>
                    )}
                  </div>
                  <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
                    {debtAccounts.map((a) => {
                      const on = !deselectedIds.has(a.id);
                      return (
                        <button
                          key={a.id}
                          onClick={() => toggleAccount(a.id)}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border whitespace-nowrap shrink-0 transition-colors"
                          style={on
                            ? { backgroundColor: `${debtColorFor(a.id)}18`, borderColor: `${debtColorFor(a.id)}44`, color: debtColorFor(a.id) }
                            : { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-muted)" }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: on ? debtColorFor(a.id) : "var(--text-faint)" }} />
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 text-xs border-b pb-3" style={{ borderColor: "var(--border-hairline)" }}>
                <div className="flex items-center gap-1">
                  <span style={{ color: "var(--text-faint)" }}>Total</span>
                  <span className="font-semibold" style={{ color: DEBT_RED }}>{formatBalance(total)}</span>
                </div>
                {hasRates && (
                  <>
                    <span style={{ color: "var(--text-faint)" }}>·</span>
                    <div className="flex items-center gap-1">
                      <span style={{ color: "var(--text-faint)" }}>APR</span>
                      <span className="font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</span>
                    </div>
                  </>
                )}
                {minPayment > 0 && (
                  <>
                    <span style={{ color: "var(--text-faint)" }}>·</span>
                    <div className="flex items-center gap-1">
                      <span style={{ color: "var(--text-faint)" }}>Min</span>
                      <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{formatBalance(minPayment)}/mo</span>
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-2xl px-4 py-3 border" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>Debt-free in</p>
                    <p className="text-2xl font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
                      {timeLabel()}
                    </p>
                  </div>
                  {payoffDate && (
                    <div className="text-right pb-0.5">
                      <p className="text-[10px]" style={{ color: "var(--text-faint)" }}>by</p>
                      <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }} suppressHydrationWarning>{payoffDate}</p>
                    </div>
                  )}
                </div>
                {months != null && totalInterest != null && hasRates && (
                  <p className="text-[11px] mt-1.5 pt-1.5 border-t" style={{ color: "var(--text-faint)", borderColor: "var(--border-hairline)" }}>
                    {formatBalance(totalInterest)} in interest over {months} payment{months !== 1 ? "s" : ""}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <p className="text-xs" style={{ color: "var(--text-secondary)" }}>{freqLabel} payment</p>
                    {freqToggle}
                  </div>
                  {paymentInput()}
                </div>
                {slider}
                <div className="flex justify-between text-[10px]" style={{ color: "var(--text-faint)" }}>
                  <span>$50 / {freq === "week" ? "week" : "month"}</span>
                  <span>{formatBalance(sliderMax)} / {freq === "week" ? "week" : "month"}</span>
                </div>
              </div>

              {months != null && breakdown}
              {disclaimer}
            </div>

            {/* ── Desktop layout (two columns) ──────────────────── */}
            <div className="hidden sm:grid sm:grid-cols-[260px_1fr] divide-x divide-[var(--border-hairline)] min-h-full">

              {/* Left — account panel */}
              <div className="p-5 space-y-3 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>Accounts</p>
                  {!allSelected && (
                    <button onClick={selectAll} className="text-[10px] transition-colors" style={{ color: "var(--accent-info)" }}>
                      Select all
                    </button>
                  )}
                </div>

                <div className="space-y-2">
                  {debtAccounts.map((a) => {
                    const on = !deselectedIds.has(a.id);
                    return (
                      <button
                        key={a.id}
                        onClick={() => toggleAccount(a.id)}
                        className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                          on ? "" : "hover:bg-[var(--surface-hover)] opacity-50"
                        }`}
                        style={on
                          ? { backgroundColor: `${debtColorFor(a.id)}10`, borderColor: `${debtColorFor(a.id)}30` }
                          : { background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
                      >
                        <span
                          className="mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors"
                          style={on ? { borderColor: debtColorFor(a.id), backgroundColor: debtColorFor(a.id) } : { borderColor: "var(--text-faint)", backgroundColor: "transparent" }}
                        >
                          {on && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" style={{ color: on ? "var(--text-primary)" : "var(--text-muted)" }}>{a.name}</p>
                          <p className="text-[10px] truncate" style={{ color: "var(--text-faint)" }}>{a.institution}</p>
                          <div className="flex flex-wrap gap-x-2 mt-0.5">
                            <span className="text-xs font-semibold" style={{ color: debtColorFor(a.id) }}>{formatBalance(a.balance)}</span>
                            {a.interestRate != null && (
                              <span className="text-[10px]" style={{ color: `${debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length)}cc` }}>{a.interestRate.toFixed(2)}% APR</span>
                            )}
                            {a.minimumPayment != null && (
                              <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>{formatBalance(a.minimumPayment)}/mo min</span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="pt-3 border-t space-y-1.5" style={{ borderColor: "var(--border-hairline)" }}>
                  <div className="flex justify-between text-xs">
                    <span style={{ color: "var(--text-muted)" }}>Selected total</span>
                    <span className="font-semibold" style={{ color: DEBT_RED }}>{formatBalance(total)}</span>
                  </div>
                  {hasRates && (
                    <div className="flex justify-between text-xs">
                      <span style={{ color: "var(--text-muted)" }}>Avg APR</span>
                      <span className="font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</span>
                    </div>
                  )}
                  {minPayment > 0 && (
                    <div className="flex justify-between text-xs">
                      <span style={{ color: "var(--text-muted)" }}>Min monthly payments</span>
                      <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{formatBalance(minPayment)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Right — simulator */}
              <div className="p-5 space-y-5 overflow-y-auto">
                <div className="rounded-2xl p-5 border" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                  <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Debt-free in</p>
                  <p className="text-3xl font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
                    {timeLabel()}
                  </p>
                  {payoffDate && <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }} suppressHydrationWarning>by {payoffDate}</p>}
                  {months != null && totalInterest != null && hasRates && (
                    <p className="text-xs mt-2" style={{ color: "var(--text-faint)" }}>
                      {formatBalance(totalInterest)} in interest over {months} payment{months !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{freqLabel} payment</p>
                      {freqToggle}
                    </div>
                    {paymentInput()}
                  </div>
                  {slider}
                  <div className="flex justify-between text-[10px]" style={{ color: "var(--text-faint)" }}>
                    <span>$50 / {freq === "week" ? "week" : "month"}</span>
                    <span>{formatBalance(sliderMax)} / {freq === "week" ? "week" : "month"}</span>
                  </div>
                  {minPayment > 0 && (
                    <p className="text-[10px]" style={{ color: "var(--text-faint)" }}>Minimum payment: {formatBalance(minPayment)} / month</p>
                  )}
                </div>

                {months != null && breakdown}
                {disclaimer}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Normal embedded view ──────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {debtAccounts.length > 1 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>Accounts</p>
            {!allSelected && (
              <button onClick={selectAll} className="text-[10px] transition-colors" style={{ color: "var(--accent-info)" }}>
                Select all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {debtAccounts.map((a) => {
              const on = !deselectedIds.has(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggleAccount(a.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                    on ? "" : "hover:text-[var(--text-secondary)]"
                  }`}
                  style={on
                    ? { backgroundColor: `${debtColorFor(a.id)}18`, borderColor: `${debtColorFor(a.id)}44`, color: debtColorFor(a.id) }
                    : { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-faint)" }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: on ? debtColorFor(a.id) : "var(--text-faint)" }} />
                  {a.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest font-semibold mb-1" style={{ color: "var(--text-muted)" }}>
            {allSelected ? "Total to pay off" : `${filtered.length} account${filtered.length !== 1 ? "s" : ""} selected`}
          </p>
          <p className="text-2xl font-bold" style={{ color: DEBT_RED }}>{formatBalance(total)}</p>
        </div>
        {hasRates && (
          <div className="text-right">
            <p className="text-[10px]" style={{ color: "var(--text-faint)" }}>Avg APR</p>
            <p className="text-sm font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs shrink-0" style={{ color: "var(--text-secondary)" }}>{freqLabel} payment</p>
              {freqToggle}
            </div>
            {minPayment > 0 && (
              <p className="text-[10px]" style={{ color: "var(--text-faint)" }}>min {formatBalance(minPayment)}/mo</p>
            )}
          </div>
          {paymentInput()}
        </div>
        {slider}
        <div className="flex justify-between text-[10px]" style={{ color: "var(--text-faint)" }}>
          <span>$50/{freq === "week" ? "wk" : "mo"}</span>
          <span>{formatBalance(sliderMax)}/{freq === "week" ? "wk" : "mo"}</span>
        </div>
      </div>

      <div className="rounded-xl px-4 py-3 flex items-center justify-between" style={{ background: "var(--surface-inset)" }}>
        <div>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Debt-free in</p>
          <p className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>
            {timeLabel()}
          </p>
        </div>
        {payoffDate && (
          <div className="text-right">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>By</p>
            <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }} suppressHydrationWarning>{payoffDate}</p>
          </div>
        )}
      </div>

      {months != null && breakdown}
      {disclaimer}
    </div>
  );
}
