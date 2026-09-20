"use client";

/**
 * DebtPayoffSection
 *
 * Interactive debt payoff planner for space dashboards.
 * Supports both an embedded card view and a full-screen modal view.
 *
 * Extracted from SpaceDashboard.tsx to keep that file manageable.
 *
 * CODE OWNS MONEY — this component holds the user's CHOICES (which accounts,
 * how much a month) and nothing else. The schedule — PER LIABILITY: every debt's
 * own balance, own APR, own interest, own payments — the elapsed time, the final
 * partial payment and every refusal come from `planPayoff` (lib/debt/payoff.ts).
 * Every aggregate on screen is the engine's sum of those liability schedules.
 * The "Avg APR" is `computeDebtAggregate`'s, shown for reference only: it drives
 * no calculation. Nothing here divides a balance by a payment.
 *
 * The amount the user enters is a BUDGET — the most they can pay a month. The
 * engine never pays more than extinguishes the debt; when one payment clears it
 * with budget to spare, the engine reports the spare amount and this panel says
 * so as information (never an error — any amount may be entered).
 *
 * Inputs to the schedule are balance + APR + the chosen payment. Minimum
 * payments are not read, shown, or required. There is ONE cadence — monthly —
 * and no other mode exists in this component's state.
 *
 * UNKNOWN APR does not block the planner, and is never turned into a rate. Each
 * selected account goes to the engine with its own APR or `null`; an unknown one
 * accrues nothing as a labelled assumption on THAT liability, and the engine
 * returns an ESTIMATE whose `basis` says PRINCIPAL_ONLY / PARTIAL_INTEREST. This
 * component reads that basis; it never infers "estimate" from a number, and it
 * never writes or displays a 0% for an account whose rate is unknown.
 *
 * APRs are managed in ONE place — the Interest cost widget. This panel has no
 * APR input: its "Add APR" action only takes the user THERE (`onAddApr`).
 */

import { useState, useEffect } from "react";
import { CreditCard, X } from "lucide-react";
import { formatBalance, formatCurrencyExact, currencySymbol } from "@/lib/currency";
import { useAggregateCurrency } from "@/components/space/widgets/display-money";
import { formatDate } from "@/lib/format";
import { convertMoney } from "@/lib/money/convert";
// v2.6-DEBT-1 — `amountOwed` / `hasOutstandingDebt` are no longer applied here:
// the aggregate authority owns both, so the planner cannot drift from the rule.
import { computeDebtAggregate, type DebtAggregateRow } from "@/lib/debt/aggregates";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import { useBodyScrollLock } from "@/components/atlas/useBodyScrollLock";
import { planPayoff, DEFAULT_PAYOFF_PAYMENT, type PayoffLiabilityInput } from "@/lib/debt/payoff";
import { todayUTCISO } from "@/lib/time/clock";
import {
  payoffHeadline,
  payoffEstimateNotice,
  payoffOverBudgetNotice,
  isSinglePaymentPayoff,
  ADD_APR_PROMPT,
} from "@/components/space/widgets/debt/payoff-copy";
import { PayoffScenarioStrip } from "@/components/space/widgets/debt/PayoffScenarioStrip";

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
  interestRate?:   number;  // APR, e.g. 19.99 — undefined = UNKNOWN (never 0)
};

// ─── Utilities ────────────────────────────────────────────────────────────────
// formatBalance + currencySymbol now come from the single lib/currency authority
// (SEC-3) — the former local copies were byte-identical for all real inputs.

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

// ─── Component ────────────────────────────────────────────────────────────────

export function DebtPayoffSection({
  accounts,
  fullscreen     = false,
  onCloseFullscreen,
  ctx,
  today,
  onAddApr,
}: {
  accounts:           DebtPayoffAccount[];
  fullscreen?:        boolean;
  onCloseFullscreen?: () => void;
  /**
   * MC1 QA Q4 — optional conversion context (classifier pattern). Present ⇒
   * planner aggregates (selected total, min payments, interest projections)
   * convert into ctx.target at the latest close and labels follow; absent ⇒
   * the original raw-sum, USD-labeled behavior byte-for-byte (kill switch).
   * Per-account rows stay native either way (itemized doctrine).
   */
  ctx?: ConversionContext;
  /** The host's "today" (YYYY-MM-DD) — the schedule's start. Defaults to the clock. */
  today?: string;
  /**
   * Takes the user to the ONE APR editing surface (the Interest cost widget).
   * Supplied by a host that mounts that widget; absent ⇒ the prompt is plain
   * text. This panel never grows an APR input of its own.
   */
  onAddApr?: () => void;
}) {
  const debtAccounts = accounts.filter((a) => a.type === "debt");

  // Display currency follows the converted values; with no context the
  // display-currency AUTHORITY decides — never a hard-coded default label
  // (REVIEW-3 C-5).
  const disp = useAggregateCurrency(ctx);
  const sym  = currencySymbol(disp);

  /** Row amount in the display currency (native pass-through + taint on miss, plan D-3). */
  const inDisp = (amount: number, currency: string | null | undefined): { amount: number; estimated: boolean } => {
    if (!ctx) return { amount, estimated: false };
    const c = convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx);
    // V25-FINAL-1 — unavailable conversion excluded (0), never native; `estimated`
    // (true on a miss) discloses the payoff figures are approximate/incomplete.
    return { amount: c.amount ?? 0, estimated: c.estimated };
  };
  // Sort by balance descending so color ranks match the breakdown chart
  const sortedDebtAccounts = [...debtAccounts].sort((a, b) => b.balance - a.balance);
  const debtColorFor = (id: string) => {
    const idx = sortedDebtAccounts.findIndex((a) => a.id === id);
    return debtColor(idx < 0 ? 0 : idx, sortedDebtAccounts.length);
  };

  // The default is an INITIAL value only (useState initialiser): a payment the
  // user has chosen is never overwritten by it on a later render.
  const [amount,      setAmount]      = useState(DEFAULT_PAYOFF_PAYMENT);
  const [inputStr,    setInputStr]    = useState(String(DEFAULT_PAYOFF_PAYMENT));
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

  // MC1 QA Q4 — planner aggregates in the display currency (map-then-reduce
  // so the taint survives the sum). Without a context inDisp passes native
  // amounts through, so this is the original raw addition byte-for-byte.
  // V25-SIDE-1 — the planner projects a PAYOFF, so every figure is amount OWED
  // (lib/debt/balance-semantics.ts). A credit balance contributes nothing: it
  // must not net against another card's obligation or carry APR weight.
  // v2.6-DEBT-1 — the population rule (who counts, how they are weighted, what a
  // missing rate means) belongs to `computeDebtAggregate`, not to this planner.
  // This block now does only what IS the planner's context: convert into the
  // display currency and carry the FX taint. Six surfaces derived this same
  // triple; five of them wrote it out again, and one of those five disagreed.
  const filteredConv = filtered.map((a) => ({ a, bal: inDisp(a.balance, a.currency) }));

  // DESCRIPTIVE ONLY — the total owed and an owed-weighted "Avg APR" to show.
  // Neither is an input to the schedule: the engine gets the liabilities below.
  const agg = computeDebtAggregate(
    filteredConv.map(({ a, bal }): DebtAggregateRow => ({
      balance:        bal.amount,
      apr:            a.interestRate ?? null,
      minimumPayment: null,
    })),
  );

  const total = agg.totalOwed;
  // The engine's input: ONE ROW PER LIABILITY, each with its own APR or null
  // (UNKNOWN — never 0, never a neighbour's rate; there is no shared rate).
  const liabilities: PayoffLiabilityInput[] = filteredConv.map(({ a, bal }) => ({
    id: a.id, label: a.name, balance: bal.amount, aprPct: a.interestRate ?? null,
  }));
  const unratedNames = filteredConv
    .filter(({ a, bal }) => bal.amount > 0 && a.interestRate == null)
    .map(({ a }) => a.name);
  const aprPct            = agg.weightedApr;               // for the reference label only
  const weightedApr       = aprPct;
  const hasRates          = aprPct != null;

  // Aggregate taint — any unresolvable row marks every derived projection.
  const aggEstimated = filteredConv.some((r) => r.bal.estimated);
  const est = aggEstimated ? "≈ " : "";

  const sliderMax = Math.max(5000, Math.ceil(total));

  // The clock seam (lib/time) — never an inline current-day derivation.
  const startISO = today ?? todayUTCISO();
  const plan     = planPayoff({ liabilities, payment: amount, startISO });
  // STRUCTURAL, from the engine — not inferred from a missing rate or a 0.
  const notice     = payoffEstimateNotice(plan);
  const isEstimate = notice != null;
  const paidOff  = plan.status === "paid_off" ? plan : null;
  const totalInterest = paidOff?.totalInterest ?? null;
  const totalPaid     = paidOff?.totalPaid ?? null;
  const payoffDate    = paidOff ? formatDate(paidOff.payoffISO) : null;

  const headline = payoffHeadline(plan);
  const timeLabel = () => headline.label;
  const onePayment = isSinglePaymentPayoff(plan);
  // The engine's figures (totalPaid / unusedPaymentCapacity), worded per its basis.
  const overBudget = payoffOverBudgetNotice(plan, (n) => `${est}${formatCurrencyExact(n, disp)}`);

  /** "$174.23 final payment" — the engine's figure, to the cent; qualified by the
   *  same basis as the timeline when interest evidence is incomplete. */
  const finalPaymentLine = paidOff
    ? `${est}${isEstimate ? "about " : ""}${formatCurrencyExact(paidOff.finalPayment, disp)} ${onePayment ? "payment" : "final payment"}`
      + (paidOff.fullPayments > 0 ? ` after ${paidOff.fullPayments} of ${formatBalance(amount, disp)}` : "")
      // One payment: the headline no longer carries the duration, so it lives here.
      + (onePayment ? ` · in ${paidOff.elapsed.label}` : "")
      + (isEstimate ? (paidOff.basis.interest === "PRINCIPAL_ONLY" ? " · before interest" : " · before unknown interest") : "")
    : null;

  /** Why there is no timeline, in the user's terms. Null when there is one. */
  const refusalLine =
    plan.status === "non_amortizing"
      ? `${formatBalance(amount, disp)} a month does not cover the interest (${est}${formatCurrencyExact(plan.firstPeriodInterest, disp)} in the first month), so the balance never falls.`
    : plan.status === "beyond_horizon"
      ? "At this payment the balance is not cleared within 100 years."
    : null;

  function handleInput(val: string) {
    setInputStr(val);
    const n = parseFloat(val.replace(/[^0-9.]/g, ""));
    if (!isNaN(n) && n > 0) setAmount(Math.min(n, sliderMax));
  }

  function handleSlider(val: number) {
    setAmount(val);
    setInputStr(String(val));
  }

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
  const paymentInput = (wide = false) => (
    <div className={`flex items-center rounded-lg px-3 py-1.5 gap-1 ${wide ? "w-full" : ""}`} style={{ background: "var(--surface-inset)" }}>
      <span className="text-sm" style={{ color: "var(--text-muted)" }}>{sym}</span>
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
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{est}{formatBalance(total, disp)}</p>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Estimated interest{isEstimate && hasRates ? " (known APRs only)" : ""}
          </p>
          {paidOff?.basis.interest === "PRINCIPAL_ONLY" ? (
            <p className="text-xs" style={{ color: "var(--text-faint)" }}>Not included — APR unknown</p>
          ) : totalInterest != null && (
            <p className="text-sm font-medium" style={{ color: debtColor(Math.floor(sortedDebtAccounts.length / 2), sortedDebtAccounts.length) }}>+{est}{formatCurrencyExact(totalInterest, disp)}</p>
          )}
        </div>
        <div className="flex items-center justify-between px-3 py-2.5" style={{ background: "var(--surface-muted)" }}>
          <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
            {isEstimate ? "Total paid, before unknown interest" : "Total paid"}
          </p>
          <p className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
            {est}{formatCurrencyExact(totalPaid ?? total, disp)}
          </p>
        </div>
      </div>
    </div>
  );

  /** "Your payment is more than this debt needs" — information in the info accent,
   *  never the warning/negative treatment: entering a larger amount is allowed. */
  const overBudgetNotice = overBudget && (
    <div
      data-payoff-over-budget
      role="status"
      className="rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}
    >
      <p className="text-[11px] font-semibold" style={{ color: "var(--accent-info)" }}>{overBudget.headline}</p>
      <p className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>{overBudget.required}</p>
      <p className="text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>{overBudget.unused}</p>
    </div>
  );

  /** The estimate qualification + the one way to fix it. Rendered whenever the
   *  engine's basis is not INTEREST_AWARE — beside the timeline, never instead of it. */
  const estimateNotice = notice && (
    <div
      data-payoff-basis={plan.status === "paid_off" || plan.status === "non_amortizing" || plan.status === "beyond_horizon" ? plan.basis.interest : undefined}
      className="rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}
    >
      <p className="text-[11px] font-semibold" style={{ color: "var(--accent-warning)" }}>{notice.headline}</p>
      <p className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
        {notice.detail}
        {unratedNames.length > 0 ? ` No APR on file: ${unratedNames.join(", ")}.` : ""}
      </p>
      {onAddApr ? (
        <button
          type="button"
          onClick={onAddApr}
          className="mt-1 text-[11px] font-medium"
          style={{ color: "var(--accent-info)" }}
        >
          {ADD_APR_PROMPT} →
        </button>
      ) : (
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>{ADD_APR_PROMPT} — in Interest cost.</p>
      )}
    </div>
  );

  /** Under the headline: the final payment + interest, or WHY there is no timeline. */
  const resultDetail = (cls: string) => {
    if (paidOff) {
      return (
        <p className={cls} style={{ color: "var(--text-faint)", borderColor: "var(--border-hairline)" }}>
          {finalPaymentLine}
          {totalInterest != null && totalInterest > 0
            ? ` · ${est}${formatCurrencyExact(totalInterest, disp)} in interest${isEstimate ? " on known APRs" : ""}`
            : ""}
        </p>
      );
    }
    if (!refusalLine) return null;
    return (
      <p className={cls} style={{ color: "var(--accent-warning)", borderColor: "var(--border-hairline)" }}>{refusalLine}</p>
    );
  };

  /** BY ACCOUNT — each liability's OWN schedule, straight from the engine
   *  (`plan.liabilities`). Collapsed by default so the panel stays a summary. */
  const byAccount = paidOff && (
    <details data-payoff-by-account className="rounded-xl border" style={{ borderColor: "var(--border-hairline)" }}>
      <summary className="cursor-pointer select-none px-3 py-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
        By account · {paidOff.liabilities.length}
      </summary>
      <ul className="divide-y divide-[var(--border-hairline)] border-t" style={{ borderColor: "var(--border-hairline)" }}>
        {paidOff.liabilities.map((l) => {
          const known = l.interestBasis === "KNOWN_APR";
          return (
            <li key={l.id} data-liability={l.id} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-xs font-medium" style={{ color: "var(--text-primary)" }}>{l.label}</p>
                <p className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--text-faint)" }}>
                  {known ? `${(l.aprPct as number).toFixed(2)}% APR` : "APR unknown"}
                </p>
              </div>
              <p className="mt-0.5 text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                {est}{formatCurrencyExact(l.principalPaid, disp)} of {est}{formatCurrencyExact(l.startingPrincipal, disp)} principal paid
                {" · "}{formatCurrencyExact(l.remainingBalance, disp)} remaining
              </p>
              <p className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                {known
                  ? `Estimated interest: ${est}${formatCurrencyExact(l.interestPaid, disp)}`
                  : "Interest not included — APR unknown"}
              </p>
              <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                {l.paidOffWithFirstPayment ? "Paid off with one payment" : `Paid off over ${l.paymentCount} payments`}
                {" · "}{formatDate(l.payoffISO)}
                {known ? "" : " · estimated on principal only"}
              </p>
            </li>
          );
        })}
      </ul>
    </details>
  );

  const disclaimer = (
    <p className="text-[10px] text-center" style={{ color: "var(--text-faint)" }}>
      {!isEstimate
        ? "An estimate, not an issuer payoff quote · each debt accrues interest daily at its own APR · each payment is split across debts in proportion to what each owes · grace periods, statement timing and fees are not modelled"
        : "An estimate, not an issuer payoff quote: interest is not included for accounts with an unknown APR. Their APR stays unknown — nothing is saved as 0%. Each payment is split across debts in proportion to what each owes."}
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
                {hasRates ? ` · ${weightedApr!.toFixed(2)}% avg APR (reference)` : ""}
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
                  <span className="font-semibold" style={{ color: DEBT_RED }}>{est}{formatBalance(total, disp)}</span>
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
              </div>

              <div className="rounded-2xl px-4 py-3 border" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{headline.caption}</p>
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
                {resultDetail("text-[11px] mt-1.5 pt-1.5 border-t")}
              </div>
              {overBudgetNotice}
              {estimateNotice}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Monthly payment</p>
                  {paymentInput()}
                </div>
                {slider}
                <div className="flex justify-between text-[10px]" style={{ color: "var(--text-faint)" }}>
                  <span>{sym}50 / month</span>
                  <span>{formatBalance(sliderMax, disp)} / month</span>
                </div>
              </div>

              {paidOff && breakdown}
              {byAccount}
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
                            {/* Itemized rows stay native — label follows the row's own currency (MC1 QA Q4). */}
                            <span className="text-xs font-semibold" style={{ color: debtColorFor(a.id) }}>{formatBalance(a.balance, a.currency)}</span>
                            {a.interestRate != null && (
                              <span className="text-[10px]" style={{ color: `${debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length)}cc` }}>{a.interestRate.toFixed(2)}% APR</span>
                            )}
                            {a.interestRate == null && a.balance > 0 && (
                              <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>APR unknown · counted without interest</span>
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
                    <span className="font-semibold" style={{ color: DEBT_RED }}>{est}{formatBalance(total, disp)}</span>
                  </div>
                  {hasRates && (
                    <div className="flex justify-between text-xs">
                      <span style={{ color: "var(--text-muted)" }}>{isEstimate ? "Avg APR (known) · reference" : "Avg APR · reference"}</span>
                      <span className="font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Right — simulator */}
              <div className="p-5 space-y-5 overflow-y-auto">
                <div className="rounded-2xl p-5 border" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
                  <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>{headline.caption}</p>
                  <p className="text-3xl font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
                    {timeLabel()}
                  </p>
                  {payoffDate && <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }} suppressHydrationWarning>by {payoffDate}</p>}
                  {resultDetail("text-xs mt-2")}
                </div>
                {overBudgetNotice}
                {estimateNotice}

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Monthly payment</p>
                    {paymentInput()}
                  </div>
                  {slider}
                  <div className="flex justify-between text-[10px]" style={{ color: "var(--text-faint)" }}>
                    {/* MC1 QA — slider bounds are Space-native aggregates; label
                        in the Space's display currency like the other two
                        slider variants (was a hardcoded-$ omission). */}
                    <span>{sym}50 / month</span>
                    <span>{formatBalance(sliderMax, disp)} / month</span>
                  </div>
                </div>

                {paidOff && breakdown}
                {byAccount}
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
          <p className="text-2xl font-bold" style={{ color: DEBT_RED }}>{est}{formatBalance(total, disp)}</p>
        </div>
        {hasRates && (
          <div className="text-right">
            <p className="text-[10px]" style={{ color: "var(--text-faint)" }}>{isEstimate ? "Avg APR (known) · reference" : "Avg APR · reference"}</p>
            <p className="text-sm font-semibold" style={{ color: debtColor(sortedDebtAccounts.length - 1, sortedDebtAccounts.length) }}>{weightedApr!.toFixed(2)}%</p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs shrink-0" style={{ color: "var(--text-secondary)" }}>Monthly payment</p>
          {paymentInput()}
        </div>
        {slider}
        <div className="flex justify-between text-[10px]" style={{ color: "var(--text-faint)" }}>
          <span>{sym}50/mo</span>
          <span>{formatBalance(sliderMax, disp)}/mo</span>
        </div>
      </div>

      <div className="rounded-xl px-4 py-3 flex items-center justify-between" style={{ background: "var(--surface-inset)" }}>
        <div>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{headline.caption}</p>
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

      {resultDetail("text-[11px] px-1")}
      {overBudgetNotice}
      {estimateNotice}
      {paidOff && breakdown}
      {byAccount}
      <PayoffScenarioStrip input={{ liabilities, payment: amount, startISO }} currency={disp} />
      {disclaimer}
    </div>
  );
}
