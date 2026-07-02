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

  // ESC closes fullscreen; lock body scroll while open
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseFullscreen?.(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
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
        <CreditCard size={22} className="text-gray-700 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No debt accounts shared yet</p>
        <p className="text-xs text-gray-600 mt-1">Share debt accounts to use the payoff planner.</p>
      </div>
    );
  }

  // ── Shared sub-components used by both views ─────────────────────────────
  const freqToggle = (
    <div className="flex rounded-lg overflow-hidden border border-gray-700">
      {(["month", "week"] as const).map((f) => (
        <button
          key={f}
          onClick={() => setFreq(f)}
          className={`text-[10px] font-semibold px-2.5 py-1 transition-colors ${
            freq === f ? "text-white" : "text-gray-600 hover:text-gray-400 bg-transparent"
          }`}
          style={freq === f ? { backgroundColor: "rgba(96,165,250,0.12)", color: "#93c5fd" } : {}}
        >
          {f === "month" ? "Mo" : "Wk"}
        </button>
      ))}
    </div>
  );

  const paymentInput = (wide = false) => (
    <div className={`flex items-center bg-gray-800 rounded-lg px-3 py-1.5 gap-1 ${wide ? "w-full" : ""}`}>
      <span className="text-sm text-gray-500">$</span>
      <input
        type="text"
        inputMode="decimal"
        value={inputStr}
        onChange={(e) => handleInput(e.target.value)}
        onBlur={() => setInputStr(String(amount))}
        className={`bg-transparent font-semibold text-white text-right outline-none ${wide ? "flex-1 text-lg" : "w-20 text-sm"}`}
      />
    </div>
  );

  const sliderPct   = sliderMax > 50 ? ((Math.min(amount, sliderMax) - 50) / (sliderMax - 50)) * 100 : 0;
  const sliderLight = debtColor(sortedDebtAccounts.length > 1 ? sortedDebtAccounts.length - 1 : 0, sortedDebtAccounts.length);
  const sliderDark  = debtColor(0, sortedDebtAccounts.length);

  const slider = (
    <div className="relative w-full py-2">
      {/* Track */}
      <div className="w-full h-1.5 rounded-full bg-gray-700 overflow-hidden">
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
        className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-white shadow border border-gray-300 pointer-events-none -translate-y-1/2"
        style={{ left: `calc(${sliderPct / 100} * (100% - 14px) + 7px)` }}
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
    <div className="rounded-xl border border-gray-800 overflow-hidden">
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest px-3 pt-3 pb-1.5">
        Estimated total paid
      </p>
      <div className="divide-y divide-gray-800/60">
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-xs text-gray-500">Principal</p>
          <p className="text-sm font-medium text-white">{formatBalance(total)}</p>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-xs text-gray-500">
            Interest{hasRates ? ` (${weightedApr!.toFixed(2)}% APR)` : ""}
          </p>
          {hasRates && totalInterest != null ? (
            <p className="text-sm font-medium" style={{ color: debtColor(Math.floor(sortedDebtAccounts.length / 2), sortedDebtAccounts.length) }}>+{formatBalance(totalInterest)}</p>
          ) : (
            <p className="text-xs text-gray-600">— add APR to account for estimate</p>
          )}
        </div>
        <div className="flex items-center justify-between px-3 py-2.5 bg-gray-800/30">
          <p className="text-xs font-semibold text-gray-300">Total paid</p>
          <p className="text-sm font-bold text-white">
            {totalPaid != null ? formatBalance(totalPaid) : formatBalance(total)}
          </p>
        </div>
      </div>
    </div>
  );

  const disclaimer = (
    <p className="text-[10px] text-gray-700 text-center">
      {hasRates
        ? "Estimate only · actual totals may vary based on billing cycles, fees, and rate changes"
        : "Simplified estimate · add APR to accounts for interest-aware calculation"}
    </p>
  );

  // ── Full-screen modal ─────────────────────────────────────────────────────
  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/75 backdrop-blur-sm">
        <div className="w-full sm:max-w-3xl bg-gray-950 border border-gray-800 rounded-2xl shadow-2xl flex flex-col max-h-[88dvh]">

          {/* Header */}
          <div className="flex items-start justify-between px-5 py-4 border-b border-gray-800 shrink-0">
            <div>
              <p className="text-base font-bold text-white">Payoff Planner</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {debtAccounts.length} account{debtAccounts.length !== 1 ? "s" : ""}
                {hasRates ? ` · ${weightedApr!.toFixed(2)}% avg APR` : ""}
              </p>
            </div>
            <button
              onClick={onCloseFullscreen}
              className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-white transition-colors"
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
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Accounts</p>
                    {!allSelected && (
                      <button onClick={selectAll} className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
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
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
                            on ? "" : "bg-gray-800 border-gray-700 text-gray-500"
                          }`}
                          style={on ? { backgroundColor: `${debtColorFor(a.id)}18`, borderColor: `${debtColorFor(a.id)}44`, color: debtColorFor(a.id) } : {}}
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: on ? debtColorFor(a.id) : "#4b5563" }} />
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 text-xs border-b border-gray-800 pb-3">
                <div className="flex items-center gap-1">
                  <span className="text-gray-600">Total</span>
                  <span className="font-semibold" style={{ color: DEBT_RED }}>{formatBalance(total)}</span>
                </div>
                {hasRates && (
                  <>
                    <span className="text-gray-800">·</span>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-600">APR</span>
                      <span className="font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</span>
                    </div>
                  </>
                )}
                {minPayment > 0 && (
                  <>
                    <span className="text-gray-800">·</span>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-600">Min</span>
                      <span className="font-semibold text-gray-300">{formatBalance(minPayment)}/mo</span>
                    </div>
                  </>
                )}
              </div>

              <div className={`rounded-2xl px-4 py-3 border ${months == null ? "bg-yellow-500/5 border-yellow-500/20" : "bg-gray-900 border-gray-800"}`}>
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <p className="text-[11px] text-gray-500">Debt-free in</p>
                    <p className={`text-2xl font-bold leading-tight ${months == null ? "text-yellow-400" : "text-white"}`}>
                      {timeLabel()}
                    </p>
                  </div>
                  {payoffDate && (
                    <div className="text-right pb-0.5">
                      <p className="text-[10px] text-gray-600">by</p>
                      <p className="text-sm text-gray-300 font-medium" suppressHydrationWarning>{payoffDate}</p>
                    </div>
                  )}
                </div>
                {months != null && totalInterest != null && hasRates && (
                  <p className="text-[11px] text-gray-600 mt-1.5 pt-1.5 border-t border-gray-800">
                    {formatBalance(totalInterest)} in interest over {months} payment{months !== 1 ? "s" : ""}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-gray-400">{freqLabel} payment</p>
                    {freqToggle}
                  </div>
                  {paymentInput()}
                </div>
                {slider}
                <div className="flex justify-between text-[10px] text-gray-600">
                  <span>$50 / {freq === "week" ? "week" : "month"}</span>
                  <span>{formatBalance(sliderMax)} / {freq === "week" ? "week" : "month"}</span>
                </div>
              </div>

              {months != null && breakdown}
              {disclaimer}
            </div>

            {/* ── Desktop layout (two columns) ──────────────────── */}
            <div className="hidden sm:grid sm:grid-cols-[260px_1fr] divide-x divide-gray-800 min-h-full">

              {/* Left — account panel */}
              <div className="p-5 space-y-3 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Accounts</p>
                  {!allSelected && (
                    <button onClick={selectAll} className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
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
                          on ? "" : "bg-gray-900 border-gray-800 hover:bg-gray-800/60 opacity-50"
                        }`}
                        style={on ? { backgroundColor: `${debtColorFor(a.id)}10`, borderColor: `${debtColorFor(a.id)}30` } : {}}
                      >
                        <span
                          className="mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors"
                          style={on ? { borderColor: debtColorFor(a.id), backgroundColor: debtColorFor(a.id) } : { borderColor: "#4b5563", backgroundColor: "transparent" }}
                        >
                          {on && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium truncate ${on ? "text-white" : "text-gray-500"}`}>{a.name}</p>
                          <p className="text-[10px] text-gray-600 truncate">{a.institution}</p>
                          <div className="flex flex-wrap gap-x-2 mt-0.5">
                            <span className="text-xs font-semibold" style={{ color: debtColorFor(a.id) }}>{formatBalance(a.balance)}</span>
                            {a.interestRate != null && (
                              <span className="text-[10px]" style={{ color: `${debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length)}cc` }}>{a.interestRate.toFixed(2)}% APR</span>
                            )}
                            {a.minimumPayment != null && (
                              <span className="text-[10px] text-gray-600">{formatBalance(a.minimumPayment)}/mo min</span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="pt-3 border-t border-gray-800 space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Selected total</span>
                    <span className="font-semibold" style={{ color: DEBT_RED }}>{formatBalance(total)}</span>
                  </div>
                  {hasRates && (
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Avg APR</span>
                      <span className="font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</span>
                    </div>
                  )}
                  {minPayment > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Min monthly payments</span>
                      <span className="font-semibold text-gray-300">{formatBalance(minPayment)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Right — simulator */}
              <div className="p-5 space-y-5 overflow-y-auto">
                <div className={`rounded-2xl p-5 border ${months == null ? "bg-yellow-500/5 border-yellow-500/20" : "bg-gray-900 border-gray-800"}`}>
                  <p className="text-xs text-gray-500 mb-1">Debt-free in</p>
                  <p className={`text-3xl font-bold leading-tight ${months == null ? "text-yellow-400" : "text-white"}`}>
                    {timeLabel()}
                  </p>
                  {payoffDate && <p className="text-sm text-gray-400 mt-1" suppressHydrationWarning>by {payoffDate}</p>}
                  {months != null && totalInterest != null && hasRates && (
                    <p className="text-xs text-gray-600 mt-2">
                      {formatBalance(totalInterest)} in interest over {months} payment{months !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-gray-400">{freqLabel} payment</p>
                      {freqToggle}
                    </div>
                    {paymentInput()}
                  </div>
                  {slider}
                  <div className="flex justify-between text-[10px] text-gray-600">
                    <span>$50 / {freq === "week" ? "week" : "month"}</span>
                    <span>{formatBalance(sliderMax)} / {freq === "week" ? "week" : "month"}</span>
                  </div>
                  {minPayment > 0 && (
                    <p className="text-[10px] text-gray-600">Minimum payment: {formatBalance(minPayment)} / month</p>
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
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Accounts</p>
            {!allSelected && (
              <button onClick={selectAll} className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
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
                    on ? "" : "bg-gray-800 border-gray-700 text-gray-600 hover:text-gray-400"
                  }`}
                  style={on ? { backgroundColor: `${debtColorFor(a.id)}18`, borderColor: `${debtColorFor(a.id)}44`, color: debtColorFor(a.id) } : {}}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: on ? debtColorFor(a.id) : "#374151" }} />
                  {a.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-1">
            {allSelected ? "Total to pay off" : `${filtered.length} account${filtered.length !== 1 ? "s" : ""} selected`}
          </p>
          <p className="text-2xl font-bold" style={{ color: DEBT_RED }}>{formatBalance(total)}</p>
        </div>
        {hasRates && (
          <div className="text-right">
            <p className="text-[10px] text-gray-600">Avg APR</p>
            <p className="text-sm font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-gray-400 shrink-0">{freqLabel} payment</p>
              {freqToggle}
            </div>
            {minPayment > 0 && (
              <p className="text-[10px] text-gray-600">min {formatBalance(minPayment)}/mo</p>
            )}
          </div>
          {paymentInput()}
        </div>
        {slider}
        <div className="flex justify-between text-[10px] text-gray-600">
          <span>$50/{freq === "week" ? "wk" : "mo"}</span>
          <span>{formatBalance(sliderMax)}/{freq === "week" ? "wk" : "mo"}</span>
        </div>
      </div>

      <div className="bg-gray-800/50 rounded-xl px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500">Debt-free in</p>
          <p className={`text-lg font-bold ${months == null ? "text-yellow-400" : "text-white"}`}>
            {timeLabel()}
          </p>
        </div>
        {payoffDate && (
          <div className="text-right">
            <p className="text-xs text-gray-500">By</p>
            <p className="text-sm font-medium text-gray-300" suppressHydrationWarning>{payoffDate}</p>
          </div>
        )}
      </div>

      {months != null && breakdown}
      {disclaimer}
    </div>
  );
}
