"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Account, Transaction, TransactionCategory } from "@/types";
import { FicoCard } from "@/components/dashboard/FicoCard";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import {
  ShieldCheck, Save, Loader2, CreditCard, Pencil, X,
  Check, Search, ChevronLeft, ChevronRight, ChevronDown,
} from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { EstimatedChip } from "@/components/ui/EstimatedChip";
import { formatDate as formatDateUTC } from "@/lib/format";
import { renderDebtBreakdownChart, renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import {
  estimateMinimumPayment,
  totalDebtPaid as computeTotalDebtPaid,
  rollupDebtPaymentsByAccount,
} from "@/lib/debt";

// ── Formatters ────────────────────────────────────────────────────────────────
// MC1 QA Q3 — itemized rows pass the ROW's own currency; default preserved.
const fmtUSD = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(Math.abs(n));
const fmtFull = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(Math.abs(n));

// ── Category badge ─────────────────────────────────────────────────────────────
// Step C: category colour-coding neutralised to a single ink chip; the label
// carries the meaning. Amount direction is still state-coloured in TxRow.
const CAT_CHIP = "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

// Income, Transfer, Interest excluded — not relevant for credit card review
const ALL_CATEGORIES: TransactionCategory[] = [
  "Groceries","Dining","Shopping","Travel","Subscriptions","Utilities","Payment","Other",
];

// Score-range legend — a reference data-visualisation of the FICO bands; the
// dot colours are preserved as viz (not card chrome).
const SCORE_RANGES = [
  { label: "Poor",        range: "300–579", color: "bg-red-500"     },
  { label: "Fair",        range: "580–669", color: "bg-orange-400"  },
  { label: "Good",        range: "670–739", color: "bg-yellow-400"  },
  { label: "Very Good",   range: "740–799", color: "bg-blue-400"    },
  { label: "Exceptional", range: "800–850", color: "bg-emerald-400" },
];


const DEBT_SUBTYPES = [
  { value: 'credit_card',    label: 'Credit Card'    },
  { value: 'line_of_credit', label: 'Line of Credit' },
  { value: 'heloc',          label: 'HELOC'           },
  { value: 'auto_loan',      label: 'Auto Loan'       },
  { value: 'mortgage',       label: 'Mortgage'        },
  { value: 'personal_loan',  label: 'Personal Loan'   },
  { value: 'student_loan',   label: 'Student Loan'    },
  { value: 'other',          label: 'Other'           },
];

/** Revolving credit: shows utilisation bar + limit editor */
const REVOLVING = new Set(['credit_card', 'line_of_credit', 'heloc']);

/** Returns true if this subtype supports a credit limit */
function isRevolving(subtype?: string | null) {
  return !subtype || REVOLVING.has(subtype);
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return formatDateUTC(iso);
}

// ── Utilization bar color ─────────────────────────────────────────────────────
// Status data-viz for the utilisation fill — preserved as a health gauge.
function utilColor(pct: number) {
  if (pct >= 70) return "bg-red-500";
  if (pct >= 30) return "bg-yellow-400";
  return "bg-emerald-400";
}

// Utilisation text tone → Atlas accents (high = negative, mid = neutral, low = positive).
function utilTextColor(pct: number): string {
  if (pct >= 70) return "var(--accent-negative)";
  if (pct >= 30) return "var(--text-secondary)";
  return "var(--accent-positive)";
}

// ── Day-of-month ordinal (1st, 2nd, 3rd, 15th, ...) ───────────────────────────
function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

// Local shape for an in-flight DebtProfile edit. Uses `null` (not undefined)
// to mean "explicitly cleared" so it's distinguishable from "no override yet,
// fall back to the server-provided account".
type DebtProfileOverride = {
  apr: number | null;
  minimumPayment: number | null;
  dueDay: number | null;
  statementCloseDay: number | null;
  promoAprEndDate: string | null;
  notes: string | null;
};

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  initialFico:   number | null;
  lastUpdatedAt: string | null;
  accounts:      Account[];       // debt accounts only
  transactions:  Transaction[];   // debt account transactions
  /**
   * MC1 Phase 3 Slice 6 (F-1, D-6) — serialized Space conversion context from
   * the server page. Optional: absent => context-less native rollups (kill switch).
   */
  moneyCtx?:     SerializedConversionContext;
}

// Shared input styling (Atlas tokens).
const INPUT_CLS = "focus:outline-none focus:border-[var(--accent-info)] transition-colors placeholder:text-[var(--text-faint)]";
const inputStyle: React.CSSProperties = { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" };

// ── Main component ────────────────────────────────────────────────────────────
export function DebtClient({ initialFico, lastUpdatedAt, accounts, transactions, moneyCtx }: Props) {
  const router = useRouter();

  // MC1 P3 Slice 6 — rehydrated once; each debt leg converts at its own row
  // date inside the rollups (identical math when absent / all-USD).
  const conversionCtx = useMemo(
    () => (moneyCtx ? rehydrateContext(moneyCtx) : undefined),
    [moneyCtx],
  );
  // MC1 Phase 4 Slice 1 (D-1) — the CONVERTED aggregates (total debt paid,
  // per-card rollup) format in the display currency. The credit-utilization
  // sums above stay on the constant until they are conversion-threaded
  // (recorded as a residual finding), and per-card/per-row values keep the
  // constant (itemized rule).
  const displayCurrency = useDisplayCurrency();
  const fmtAggUtil = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, maximumFractionDigits: 0 }).format(Math.abs(n));
  const fmtAggFull = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, maximumFractionDigits: 2 }).format(Math.abs(n));
  const rollupRows = useMemo(
    () => transactions.map((t) => ({ ...t, dateISO: t.date, currency: t.currency ?? null })),
    [transactions],
  );
  const rollupRowById = useMemo(
    () => new Map(rollupRows.map((r) => [r.id, r])),
    [rollupRows],
  );

  // Credit section collapsed state (all collapsed by default for real-estate)
  const [updateScoreOpen, setUpdateScoreOpen] = useState(false);
  const [rangesOpen,      setRangesOpen]      = useState(false);
  const [tipsOpen,        setTipsOpen]        = useState(false);

  // FICO state
  const [score,     setScore]     = useState<number | null>(initialFico);
  const [inputVal,  setInputVal]  = useState(initialFico !== null ? String(initialFico) : "");
  const [saved,     setSaved]     = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [updatedAt, setUpdatedAt] = useState(lastUpdatedAt);

  // Card state — limit editing
  const [editingLimitId,  setEditingLimitId]  = useState<string | null>(null);
  const [limitInput,      setLimitInput]       = useState("");
  const [savingLimit,     setSavingLimit]      = useState(false);
  const [limitOverrides,  setLimitOverrides]   = useState<Record<string, number>>({});

  // Card state — subtype editing
  const [editingSubtypeId, setEditingSubtypeId] = useState<string | null>(null);
  const [subtypeInput,     setSubtypeInput]     = useState("");
  const [savingSubtype,    setSavingSubtype]    = useState(false);
  const [subtypeError,     setSubtypeError]     = useState<string | null>(null);
  const [subtypeOverrides, setSubtypeOverrides] = useState<Record<string, string>>({});

  // Card state — debt profile editing (APR, minimum payment, due day,
  // statement close day, promo APR end date, notes)
  const [editingDebtId,        setEditingDebtId]        = useState<string | null>(null);
  const [debtForm,             setDebtForm]             = useState({
    apr: "", minimumPayment: "", dueDay: "", statementCloseDay: "", promoAprEndDate: "", notes: "",
  });
  const [savingDebt,           setSavingDebt]           = useState(false);
  const [debtError,            setDebtError]            = useState<string | null>(null);
  const [debtProfileOverrides, setDebtProfileOverrides] = useState<Record<string, DebtProfileOverride>>({});

  // Selected card for transaction filtering
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  // Preset date range: "7d" | "1m" | "3m" | "6m" | "1y" | "all"
  const [datePreset, setDatePreset] = useState<"7d"|"1m"|"3m"|"6m"|"1y"|"all">("all");

  function presetToFrom(preset: typeof datePreset): string {
    if (preset === "all") return "";
    const d = new Date();
    if (preset === "7d") d.setDate(d.getDate() - 7);
    if (preset === "1m") d.setMonth(d.getMonth() - 1);
    if (preset === "3m") d.setMonth(d.getMonth() - 3);
    if (preset === "6m") d.setMonth(d.getMonth() - 6);
    if (preset === "1y") d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }

  // Modal state
  const [showTxModal, setShowTxModal] = useState(false);
  const [modalPage,   setModalPage]   = useState(0);

  // Modal-level filters (search + category only visible inside modal)
  const [search,    setSearch]    = useState("");
  const [catFilter, setCatFilter] = useState<TransactionCategory | null>(null);

  const COMPACT_ROWS = 4;
  const PAGE_ROWS    = 10;

  // Derived: is the current FICO input valid?
  const ficoParsed = parseInt(inputVal, 10);
  const ficoValid  = !isNaN(ficoParsed) && ficoParsed >= 300 && ficoParsed <= 850;
  const ficoError  = inputVal !== "" && !ficoValid;

  // ── FICO save ─────────────────────────────────────────────────────────────
  async function handleSaveFico() {
    if (!ficoValid) return;
    setSaving(true);
    try {
      const res = await fetch("/api/credit/update-fico", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score: ficoParsed }),
      });
      if (res.ok) {
        setScore(ficoParsed);
        setUpdatedAt(new Date().toISOString());
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } finally {
      setSaving(false);
    }
  }

  // ── Limit save ────────────────────────────────────────────────────────────
  async function handleSaveLimit(accountId: string) {
    const raw = limitInput.trim();
    // Blank → clear the limit (back to charge-card mode)
    // Non-empty → must be a positive number
    let creditLimit: number | null = null;
    if (raw !== "") {
      const parsed = parseFloat(raw.replace(/[^0-9.]/g, ""));
      if (isNaN(parsed) || parsed <= 0) return;
      creditLimit = parsed;
    }
    setSavingLimit(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditLimit }),
      });
      if (res.ok) {
        setLimitOverrides((prev) => {
          const next = { ...prev };
          if (creditLimit === null) {
            delete next[accountId];
          } else {
            next[accountId] = creditLimit;
          }
          return next;
        });
        setEditingLimitId(null);
        router.refresh();
      }
    } finally {
      setSavingLimit(false);
    }
  }

  // ── Subtype save ──────────────────────────────────────────────────────────
  async function handleSaveSubtype(accountId: string) {
    if (!subtypeInput) return;
    setSavingSubtype(true);
    setSubtypeError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debtSubtype: subtypeInput }),
      });
      if (res.ok) {
        setSubtypeOverrides((prev) => ({ ...prev, [accountId]: subtypeInput }));
        setEditingSubtypeId(null);
        setSubtypeInput("");
      } else {
        const d = await res.json().catch(() => ({}));
        setSubtypeError(d.error ?? "Failed to save — try again");
      }
    } catch {
      setSubtypeError("Network error — try again");
    } finally {
      setSavingSubtype(false);
    }
  }

  // ── Debt profile save ─────────────────────────────────────────────────────
  function openDebtEditor(card: Account) {
    const dp = debtProfileOverrides[card.id] ?? card.debtProfile ?? {};
    setDebtForm({
      apr:               dp.apr               != null ? String(dp.apr)            : "",
      minimumPayment:    dp.minimumPayment     != null ? String(dp.minimumPayment) : "",
      dueDay:            dp.dueDay             != null ? String(dp.dueDay)         : "",
      statementCloseDay: dp.statementCloseDay  != null ? String(dp.statementCloseDay) : "",
      promoAprEndDate:   dp.promoAprEndDate    ?? "",
      notes:             dp.notes              ?? "",
    });
    setDebtError(null);
    setEditingDebtId(card.id);
  }

  async function handleSaveDebtProfile(accountId: string) {
    setSavingDebt(true);
    setDebtError(null);

    // Blank field → explicit clear (null). Non-blank → must parse cleanly.
    const parseFloatOrNull = (raw: string): number | null | undefined => {
      const t = raw.trim();
      if (t === "") return null;
      const n = parseFloat(t.replace(/[^0-9.]/g, ""));
      return isNaN(n) ? undefined : n;
    };
    const parseDayOrNull = (raw: string): number | null | undefined => {
      const t = raw.trim();
      if (t === "") return null;
      const n = parseInt(t, 10);
      return isNaN(n) ? undefined : n;
    };

    const apr               = parseFloatOrNull(debtForm.apr);
    const minimumPayment    = parseFloatOrNull(debtForm.minimumPayment);
    const dueDay             = parseDayOrNull(debtForm.dueDay);
    const statementCloseDay = parseDayOrNull(debtForm.statementCloseDay);
    const promoAprEndDate   = debtForm.promoAprEndDate.trim() === "" ? null : debtForm.promoAprEndDate.trim();
    const notes              = debtForm.notes.trim() === "" ? null : debtForm.notes.trim();

    if (apr === undefined || minimumPayment === undefined || dueDay === undefined || statementCloseDay === undefined) {
      setDebtError("Please enter valid numbers.");
      setSavingDebt(false);
      return;
    }
    if (apr !== null && (apr < 0 || apr > 100)) {
      setDebtError("APR must be between 0 and 100.");
      setSavingDebt(false);
      return;
    }
    if ((dueDay !== null && (dueDay < 1 || dueDay > 31)) || (statementCloseDay !== null && (statementCloseDay < 1 || statementCloseDay > 31))) {
      setDebtError("Day fields must be between 1 and 31.");
      setSavingDebt(false);
      return;
    }

    try {
      const res = await fetch(`/api/accounts/${accountId}/debt-profile`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apr, minimumPayment, dueDay, statementCloseDay, promoAprEndDate, notes }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setDebtError(d.error ?? "Failed to save — try again");
        setSavingDebt(false);
        return;
      }
      setDebtProfileOverrides((prev) => ({
        ...prev,
        [accountId]: { apr, minimumPayment, dueDay, statementCloseDay, promoAprEndDate, notes },
      }));
      setEditingDebtId(null);
      router.refresh();
    } catch {
      setDebtError("Network error — try again");
    } finally {
      setSavingDebt(false);
    }
  }

  // ── Derived totals ────────────────────────────────────────────────────────
  const cards = accounts.map((a) => {
    const dpOverride = debtProfileOverrides[a.id];

    // APR: prefer the in-flight override, else whatever the server resolved
    // (DebtProfile.apr ?? legacy interestRate column).
    const apr = dpOverride ? (dpOverride.apr ?? undefined) : a.interestRate;

    // Minimum payment: prefer override, else server value. If the override
    // cleared the manual minimum but an APR is set, recompute the same
    // "Estimated minimum payment" heuristic the server uses so the UI doesn't
    // show a stale/blank value until the next refresh lands.
    let minimumPayment = dpOverride ? (dpOverride.minimumPayment ?? undefined) : a.minimumPayment;
    let minimumPaymentIsEstimated = dpOverride ? false : (a.minimumPaymentIsEstimated ?? false);
    if (dpOverride && dpOverride.minimumPayment == null && apr != null && a.balance) {
      minimumPayment = estimateMinimumPayment(Math.abs(a.balance), apr);
      minimumPaymentIsEstimated = true;
    }

    return {
      ...a,
      creditLimit: limitOverrides[a.id]  ?? a.creditLimit,
      debtSubtype: subtypeOverrides[a.id] ?? a.debtSubtype,
      interestRate: apr,
      minimumPayment,
      minimumPaymentIsEstimated,
      debtProfile: dpOverride ? {
        apr:               dpOverride.apr               ?? undefined,
        minimumPayment:    dpOverride.minimumPayment     ?? undefined,
        dueDay:            dpOverride.dueDay             ?? undefined,
        statementCloseDay: dpOverride.statementCloseDay  ?? undefined,
        promoAprEndDate:   dpOverride.promoAprEndDate    ?? undefined,
        notes:             dpOverride.notes               ?? undefined,
      } : a.debtProfile,
    };
  });

  // Only revolving accounts (credit cards, LOC, HELOC) factor into utilization
  const limitedCards   = cards.filter((c) => isRevolving(c.debtSubtype) && c.creditLimit && c.creditLimit > 0);
  const owedCards      = limitedCards.filter((c) => c.balance > 0);
  // MC1 QA Q2 (F-7) — utilization aggregates convert into the reporting
  // currency at the latest close (limit and balance share a card's native
  // currency, so the utilization RATIO is unchanged by conversion; the money
  // figures re-denominate). Map-then-reduce, no closure mutation; taint
  // drives the quiet "est." indicator. Per-card rows below stay native.
  const { totalUsed, totalLimit, totalAvailable, overallUtil, utilizationEstimated } = useMemo(() => {
    const conv = (amount: number, currency: string | null | undefined) =>
      conversionCtx
        ? convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), conversionCtx)
        : { amount, estimated: false };
    const usedConv  = cards.map((a) => conv(Math.max(0, a.balance), a.currency));
    const limitConv = limitedCards.map((a) => conv(a.creditLimit ?? 0, a.currency));
    const owedConv  = owedCards.map((a) => conv(a.balance, a.currency));
    const used  = usedConv.reduce((s, c) => s + c.amount, 0);
    const limit = limitConv.reduce((s, c) => s + c.amount, 0);
    const owed  = owedConv.reduce((s, c) => s + c.amount, 0);
    return {
      totalUsed:      used,
      totalLimit:     limit,
      totalAvailable: limit - owed,
      overallUtil:    limit > 0 ? (owed / limit) * 100 : 0,
      utilizationEstimated:
        [...usedConv, ...limitConv, ...owedConv].some((c) => c.estimated),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, conversionCtx]);
  // hasChargecards reserved for future charge card UI distinction
  // const hasChargecards = cards.some((c) => !c.creditLimit);

  // ── Transaction filtering ─────────────────────────────────────────────────
  // Base: card + date preset (shown in compact view)
  const baseTxs = useMemo(() => {
    const from = presetToFrom(datePreset);
    return transactions.filter((tx) => {
      if (selectedCardId && tx.accountId !== selectedCardId) return false;
      if (from && tx.date < from) return false;
      return true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardId, datePreset, transactions]);

  // Modal: base + search + category
  const filteredTxs = useMemo(() => {
    return baseTxs.filter((tx) => {
      if (catFilter && tx.category !== catFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!tx.merchant.toLowerCase().includes(q) && !(tx.description ?? "").toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [baseTxs, catFilter, search]);

  const selectedCard  = selectedCardId ? cards.find((c) => c.id === selectedCardId) : null;
  const compactSlice  = baseTxs.slice(0, COMPACT_ROWS);
  const totalPages    = Math.ceil(filteredTxs.length / PAGE_ROWS);
  const pageSlice     = filteredTxs.slice(modalPage * PAGE_ROWS, (modalPage + 1) * PAGE_ROWS);

  // Payments made toward the card balance (flowType = DEBT_PAYMENT — FlowType
  // P5 Slice 3; replaces the category === "Payment" string heuristic).
  const totalDebtPaid = computeTotalDebtPaid(baseTxs.map((t) => rollupRowById.get(t.id) ?? t), conversionCtx);

  // Per-liability payment rollup (KD-18 capability): payments grouped by the
  // receiving card. Shown only in the unfiltered view — with a card selected
  // it would be a single entry equal to totalDebtPaid.
  const debtPaidByCard = useMemo(
    () => (selectedCardId ? [] : rollupDebtPaymentsByAccount(baseTxs.map((t) => rollupRowById.get(t.id) ?? t), conversionCtx)),
    [selectedCardId, baseTxs, rollupRowById, conversionCtx],
  );

  // MC1 P4 Slice 3 (D-5) — estimation taint for the Total Debt Paid figure:
  // derived from the same rows/context via the rollup's per-entry flags
  // (computed over the FULL base set so it also covers the selected-card view).
  const debtPaidEstimated = useMemo(
    () =>
      conversionCtx
        ? rollupDebtPaymentsByAccount(baseTxs.map((t) => rollupRowById.get(t.id) ?? t), conversionCtx).some((e) => e.estimated)
        : false,
    [baseTxs, rollupRowById, conversionCtx],
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>Credit</h1>

      {/* ── 1. FICO score — always at top ── */}
      <section className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FicoCard score={score} lastUpdated={formatDate(updatedAt)} />
          {/* ── Update Your Score — collapsible ── */}
          <DataCard>
            <button
              onClick={() => setUpdateScoreOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 touch-manipulation"
            >
              <div className="flex items-center gap-2">
                <ShieldCheck size={15} style={{ color: "var(--accent-info)" }} />
                <DataCardTitle>Update Your Score</DataCardTitle>
              </div>
              <ChevronDown
                size={15}
                className="transition-transform duration-200 shrink-0"
                style={{ color: "var(--text-muted)", transform: updateScoreOpen ? "rotate(180deg)" : "rotate(0deg)" }}
              />
            </button>
            <div
              className="overflow-hidden transition-all duration-200"
              style={{ maxHeight: updateScoreOpen ? 400 : 0, opacity: updateScoreOpen ? 1 : 0 }}
            >
              <div className="pt-4 space-y-3">
                <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Check your free FICO score via Chase, Amex, or Experian and enter it here. Updating monthly keeps your dashboard accurate.
                </p>
                <div>
                  <label className="block text-xs mb-1.5" style={{ color: "var(--text-secondary)" }}>FICO Score (300–850)</label>
                  <input
                    type="text" inputMode="decimal" pattern="[0-9]*"
                    value={inputVal}
                    onChange={(e) => {
                      setInputVal(e.target.value.replace(/[^0-9]/g, ""));
                    }}
                    onBlur={() => {
                      const n = parseInt(inputVal, 10);
                      if (!isNaN(n)) setInputVal(String(Math.max(300, Math.min(850, n))));
                    }}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveFico()}
                    className={`w-full border rounded-xl px-4 py-3 text-lg font-bold placeholder:text-[var(--text-faint)] focus:outline-none transition-colors ${
                      ficoError ? "focus:border-[var(--accent-negative)]" : "focus:border-[var(--accent-info)]"
                    }`}
                    style={{ background: "var(--surface-inset)", borderColor: ficoError ? "var(--accent-negative)" : "var(--border-hairline)", color: "var(--text-primary)" }}
                  />
                  {ficoError && (
                    <p className="text-xs mt-1" style={{ color: "var(--accent-negative)" }}>Score must be between 300 and 850.</p>
                  )}
                </div>
                <button
                  onClick={handleSaveFico} disabled={saving || !ficoValid}
                  className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-60"
                  style={{ background: saved ? "var(--accent-positive)" : "var(--accent-info)" }}
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {saving ? "Saving…" : saved ? "Saved!" : "Save Score"}
                </button>
              </div>
            </div>
          </DataCard>
        </div>
      </section>

      {/* ── 2. Score ranges + tips — individually collapsible ── */}
      <div className="space-y-3">
        {/* Score Ranges */}
        <DataCard>
          <button
            onClick={() => setRangesOpen((v) => !v)}
            className="w-full flex items-center justify-between touch-manipulation"
          >
            <DataCardTitle>Score Ranges</DataCardTitle>
            <ChevronDown
              size={15}
              className="transition-transform duration-200 shrink-0"
              style={{ color: "var(--text-muted)", transform: rangesOpen ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
          <div
            className="overflow-hidden transition-all duration-200"
            style={{ maxHeight: rangesOpen ? 300 : 0, opacity: rangesOpen ? 1 : 0 }}
          >
            <div className="pt-3 space-y-2">
              {SCORE_RANGES.map(({ label, range, color }) => {
                const [lo, hi] = range.split("–").map(Number);
                const active   = score != null && score >= lo && score <= hi;
                return (
                  <div key={label} className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full shrink-0 ${color}`} />
                    <span className="text-sm font-medium w-24" style={{ color: "var(--text-primary)" }}>{label}</span>
                    <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{range}</span>
                    {active && <span className="text-xs font-semibold ml-auto" style={{ color: "var(--accent-info)" }}>← You</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </DataCard>

        {/* How to Improve */}
        <DataCard>
          <button
            onClick={() => setTipsOpen((v) => !v)}
            className="w-full flex items-center justify-between touch-manipulation"
          >
            <DataCardTitle>How to Improve</DataCardTitle>
            <ChevronDown
              size={15}
              className="transition-transform duration-200 shrink-0"
              style={{ color: "var(--text-muted)", transform: tipsOpen ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
          <div
            className="overflow-hidden transition-all duration-200"
            style={{ maxHeight: tipsOpen ? 400 : 0, opacity: tipsOpen ? 1 : 0 }}
          >
            <div className="pt-3 space-y-2">
              {[
                "Pay all bills on time — payment history is 35% of your score.",
                "Keep credit card utilization below 30% of each card's limit.",
                "Don't close old accounts — length of history matters.",
                "Limit hard inquiries — only apply for new credit when needed.",
                "Diversify credit types (credit cards, installment loans).",
              ].map((tip, i) => (
                <p key={i} className="text-sm pl-3 border-l" style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}>{tip}</p>
              ))}
            </div>
          </div>
        </DataCard>
      </div>

      {/* ── 3. Utilization summary (limited cards only, excl. charge cards) ── */}
      {limitedCards.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <DataCard>
            <DataCardTitle>Total Used</DataCardTitle>
            <p className="text-2xl font-bold mt-1" style={{ color: "var(--accent-negative)" }}>{utilizationEstimated ? "\u2248 " : ""}{fmtAggUtil(totalUsed)}{utilizationEstimated && <EstimatedChip />}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{cards.length} card{cards.length !== 1 ? "s" : ""}</p>
          </DataCard>
          <DataCard>
            <DataCardTitle>Total Limit</DataCardTitle>
            <p className="text-2xl font-bold mt-1" style={{ color: "var(--text-primary)" }}>{utilizationEstimated ? "\u2248 " : ""}{fmtAggUtil(totalLimit)}{utilizationEstimated && <EstimatedChip />}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Combined credit</p>
          </DataCard>
          <DataCard>
            <DataCardTitle>Available</DataCardTitle>
            <p className="text-2xl font-bold mt-1" style={{ color: "var(--accent-positive)" }}>{utilizationEstimated ? "\u2248 " : ""}{fmtAggUtil(totalAvailable)}{utilizationEstimated && <EstimatedChip />}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Limit minus balance</p>
          </DataCard>
          <DataCard>
            <DataCardTitle>Utilization</DataCardTitle>
            <p className="text-2xl font-bold mt-1" style={{ color: utilTextColor(overallUtil) }}>
              {overallUtil.toFixed(1)}%
            </p>
            <div className="w-full h-1.5 rounded-full mt-2 overflow-hidden" style={{ background: "var(--surface-inset)" }}>
              <div className={`h-full rounded-full transition-all ${utilColor(overallUtil)}`} style={{ width: `${Math.min(overallUtil, 100)}%` }} />
            </div>
          </DataCard>
        </div>
      )}

      {/* ── 4. Debt breakdown donut (shared widget, same as space debt dashboard) ── */}
      {accounts.length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest px-1" style={{ color: "var(--text-muted)" }}>Breakdown</p>
          <div className="border rounded-2xl p-4" style={{ background: "var(--surface-muted)", borderColor: "var(--border-hairline)" }}>
            {renderDebtBreakdownChart(accounts, "donut", "Add debt accounts to see your debt breakdown.")}
          </div>
        </section>
      )}

      {/* ── 5. Payoff planner (shared widget, same as space debt dashboard) ── */}
      {accounts.filter((a) => a.balance > 0).length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest px-1" style={{ color: "var(--text-muted)" }}>Payoff Planner</p>
          <div className="border rounded-2xl overflow-hidden" style={{ background: "var(--surface-muted)", borderColor: "var(--border-hairline)" }}>
            {renderDebtPayoffCalculator(accounts)}
          </div>
        </section>
      )}

      {/* ── 6. Per-card breakdown ── */}
      {cards.length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest px-1" style={{ color: "var(--text-muted)" }}>Cards</p>
          <div className="space-y-3">
            {cards.map((card) => {
              const isCredit       = card.balance < 0;
              const used           = Math.abs(card.balance);
              const limit          = card.creditLimit;
              const revolving      = isRevolving(card.debtSubtype);
              const util           = revolving && !isCredit && limit && limit > 0 ? (card.balance / limit) * 100 : null;
              const available      = revolving && !isCredit && limit ? limit - card.balance : null;
              const isSelected     = selectedCardId === card.id;
              const isEditingLimit = editingLimitId === card.id;
              const isEditingType  = editingSubtypeId === card.id;
              const subtypeLabel   = DEBT_SUBTYPES.find((s) => s.value === card.debtSubtype)?.label;

              return (
                <div
                  key={card.id}
                  className="rounded-2xl border transition-all"
                  style={{ borderColor: isSelected ? "var(--accent-info)" : "var(--border-hairline)", background: "var(--surface-muted)" }}
                >
                  {/* Card header */}
                  <button
                    onClick={() => setSelectedCardId((prev) => prev === card.id ? null : card.id)}
                    className="w-full flex items-center justify-between px-4 py-4 text-left touch-manipulation select-none"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: isSelected ? "var(--surface-hover-strong)" : "var(--surface-inset)" }}>
                        <CreditCard size={16} style={{ color: isSelected ? "var(--accent-info)" : "var(--text-secondary)" }} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold leading-tight" style={{ color: "var(--text-primary)" }}>{card.name}</p>
                          {isCredit && (
                            <span className="text-xs border px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ background: "rgba(34,197,94,0.15)", color: "var(--accent-positive)", borderColor: "rgba(34,197,94,0.20)" }}>
                              Owes you
                            </span>
                          )}
                          {subtypeLabel && (
                            <span className="text-xs border px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}>
                              {subtypeLabel}
                            </span>
                          )}
                        </div>
                        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{card.institution}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold tabular-nums" style={{ color: isCredit ? "var(--accent-positive)" : "var(--accent-negative)" }}>
                        {isCredit ? `+${fmtUSD(used, card.currency ?? DEFAULT_DISPLAY_CURRENCY)}` : `−${fmtUSD(used, card.currency ?? DEFAULT_DISPLAY_CURRENCY)}`}
                      </p>
                      {revolving && !isCredit && limit && (
                        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>of {fmtUSD(limit, card.currency ?? DEFAULT_DISPLAY_CURRENCY)}</p>
                      )}
                    </div>
                  </button>

                  <div className="px-4 pb-4 space-y-3">
                    {/* Utilization bar — revolving only */}
                    {util !== null && (
                      <div>
                        <div className="flex justify-between text-xs mb-1.5">
                          <span className="font-semibold" style={{ color: utilTextColor(util) }}>
                            {util.toFixed(1)}% used
                          </span>
                          <span style={{ color: "var(--text-muted)" }}>{fmtUSD(available ?? 0, card.currency ?? DEFAULT_DISPLAY_CURRENCY)} available</span>
                        </div>
                        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
                          <div className={`h-full rounded-full transition-all ${utilColor(util)}`} style={{ width: `${Math.min(util, 100)}%` }} />
                        </div>
                      </div>
                    )}

                    {/* APR + minimum payment + due/statement days */}
                    {(card.interestRate != null || card.minimumPayment != null || card.debtProfile?.dueDay || card.debtProfile?.statementCloseDay) && (
                      <div className="flex items-center gap-4 flex-wrap">
                        {card.interestRate != null && (
                          <div>
                            <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>APR</p>
                            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{card.interestRate.toFixed(2)}%</p>
                          </div>
                        )}
                        {card.minimumPayment != null && (
                          <div>
                            <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
                              {card.minimumPaymentIsEstimated ? "Est. Min Payment" : "Min Payment"}
                            </p>
                            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                              {fmtUSD(card.minimumPayment, card.currency ?? DEFAULT_DISPLAY_CURRENCY)}/mo
                            </p>
                          </div>
                        )}
                        {card.debtProfile?.dueDay && (
                          <div>
                            <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>Due</p>
                            <p className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{ordinal(card.debtProfile.dueDay)}</p>
                          </div>
                        )}
                        {card.debtProfile?.statementCloseDay && (
                          <div>
                            <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>Statement Close</p>
                            <p className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{ordinal(card.debtProfile.statementCloseDay)}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {card.minimumPaymentIsEstimated && card.minimumPayment != null && (
                      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                        Estimated minimum payment — not provided by your issuer. Enter an exact amount in debt details for accuracy.
                      </p>
                    )}
                    {card.debtProfile?.promoAprEndDate && (
                      <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Promo APR ends {formatDate(card.debtProfile.promoAprEndDate)}</p>
                    )}
                    {card.debtProfile?.notes && (
                      <p className="text-xs italic truncate" style={{ color: "var(--text-muted)" }}>&quot;{card.debtProfile.notes}&quot;</p>
                    )}

                    {/* Limit edit row — revolving only */}
                    {revolving && (
                      <div className="flex items-center gap-2">
                        {isEditingLimit ? (
                          <div className="flex items-center gap-2 flex-1">
                            <input
                              autoFocus type="text" inputMode="numeric"
                              placeholder="e.g. 25000"
                              value={limitInput}
                              onChange={(e) => setLimitInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveLimit(card.id);
                                if (e.key === "Escape") setEditingLimitId(null);
                              }}
                              className={`flex-1 border rounded-xl px-3 py-2 text-sm ${INPUT_CLS}`}
                              style={inputStyle}
                            />
                            <button
                              onClick={() => handleSaveLimit(card.id)} disabled={savingLimit}
                              className="flex items-center gap-1 text-xs font-semibold text-white disabled:opacity-60 px-3 py-2 rounded-xl transition-colors"
                              style={{ background: "var(--accent-info)" }}
                            >
                              {savingLimit ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              Save
                            </button>
                            <button onClick={() => setEditingLimitId(null)} className="p-2 hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-xl transition-colors" style={{ color: "var(--text-muted)" }}>
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingLimitId(card.id); setLimitInput(card.creditLimit ? String(card.creditLimit) : ""); }}
                            className="flex items-center gap-1.5 text-xs font-medium hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] px-2.5 py-1.5 rounded-lg transition-colors"
                            style={{ color: "var(--text-muted)" }}
                          >
                            <Pencil size={11} />
                            {card.creditLimit ? "Edit limit" : "Set limit"}
                          </button>
                        )}
                        {isSelected && (
                          <span className="ml-auto text-xs flex items-center gap-1" style={{ color: "var(--accent-info)" }}>
                            <Check size={9} /> filtering transactions
                          </span>
                        )}
                      </div>
                    )}

                    {/* Debt profile editor — APR, minimum payment, due day, statement
                        close day, promo APR end date, notes (Goal 2). Lives on a
                        separate DebtProfile row, edited via its own sub-resource. */}
                    <div className="flex flex-col gap-1.5">
                      {editingDebtId === card.id ? (
                        <div
                          className="space-y-2 border rounded-xl p-3"
                          style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>APR %</label>
                              <input
                                type="text" inputMode="decimal" placeholder="e.g. 24.99"
                                value={debtForm.apr}
                                onChange={(e) => setDebtForm((f) => ({ ...f, apr: e.target.value }))}
                                className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${INPUT_CLS}`}
                                style={inputStyle}
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>Min Payment $</label>
                              <input
                                type="text" inputMode="decimal" placeholder="Auto-estimated if blank"
                                value={debtForm.minimumPayment}
                                onChange={(e) => setDebtForm((f) => ({ ...f, minimumPayment: e.target.value }))}
                                className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${INPUT_CLS}`}
                                style={inputStyle}
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>Due Day (1–31)</label>
                              <input
                                type="text" inputMode="numeric" placeholder="e.g. 15"
                                value={debtForm.dueDay}
                                onChange={(e) => setDebtForm((f) => ({ ...f, dueDay: e.target.value }))}
                                className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${INPUT_CLS}`}
                                style={inputStyle}
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>Statement Close Day</label>
                              <input
                                type="text" inputMode="numeric" placeholder="e.g. 28"
                                value={debtForm.statementCloseDay}
                                onChange={(e) => setDebtForm((f) => ({ ...f, statementCloseDay: e.target.value }))}
                                className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${INPUT_CLS}`}
                                style={inputStyle}
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>Promo APR Ends</label>
                              <input
                                type="date"
                                value={debtForm.promoAprEndDate}
                                onChange={(e) => setDebtForm((f) => ({ ...f, promoAprEndDate: e.target.value }))}
                                className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${INPUT_CLS}`}
                                style={inputStyle}
                              />
                            </div>
                            <div className="col-span-2">
                              <label className="block text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>Notes</label>
                              <input
                                type="text" placeholder="Optional"
                                value={debtForm.notes}
                                onChange={(e) => setDebtForm((f) => ({ ...f, notes: e.target.value }))}
                                className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${INPUT_CLS}`}
                                style={inputStyle}
                              />
                            </div>
                          </div>
                          {debtError && <p className="text-xs" style={{ color: "var(--accent-negative)" }}>{debtError}</p>}
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSaveDebtProfile(card.id)}
                              disabled={savingDebt}
                              className="flex items-center justify-center gap-1.5 flex-1 text-xs font-semibold text-white disabled:opacity-60 px-3 py-2 rounded-xl transition-colors"
                              style={{ background: "var(--accent-info)" }}
                            >
                              {savingDebt ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              Save
                            </button>
                            <button
                              onClick={() => { setEditingDebtId(null); setDebtError(null); }}
                              disabled={savingDebt}
                              className="p-2 hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-xl transition-colors"
                              style={{ color: "var(--text-muted)" }}
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); openDebtEditor(card); }}
                          className="flex items-center gap-1.5 text-xs font-medium hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] px-2.5 py-1.5 rounded-lg transition-colors self-start"
                          style={{ color: "var(--text-muted)" }}
                        >
                          <Pencil size={11} />
                          {card.debtProfile ? "Edit debt details" : "Add debt details"}
                        </button>
                      )}
                    </div>

                    {/* Account type selector */}
                    <div className="flex flex-col gap-1.5">
                      {isEditingType ? (
                        <>
                          <div className="flex items-center gap-2">
                            <select
                              autoFocus
                              value={subtypeInput}
                              onChange={(e) => { setSubtypeInput(e.target.value); setSubtypeError(null); }}
                              disabled={savingSubtype}
                              className={`flex-1 border rounded-xl px-3 py-2 text-sm ${INPUT_CLS}`}
                              style={inputStyle}
                            >
                              <option value="" disabled>Select type…</option>
                              {DEBT_SUBTYPES.map((s) => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => handleSaveSubtype(card.id)}
                              disabled={savingSubtype || !subtypeInput}
                              className="flex items-center gap-1 text-xs font-semibold text-white disabled:opacity-50 px-3 py-2 rounded-xl transition-colors"
                              style={{ background: "var(--accent-info)" }}
                            >
                              {savingSubtype ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              Save
                            </button>
                            <button
                              onClick={() => { setEditingSubtypeId(null); setSubtypeInput(""); setSubtypeError(null); }}
                              className="p-2 hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-xl transition-colors"
                              style={{ color: "var(--text-muted)" }}
                            >
                              <X size={14} />
                            </button>
                          </div>
                          {subtypeError && (
                            <p className="text-xs px-1" style={{ color: "var(--accent-negative)" }}>{subtypeError}</p>
                          )}
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingSubtypeId(card.id);
                              setSubtypeInput(card.debtSubtype ?? "");
                              setSubtypeError(null);
                            }}
                            className="flex items-center gap-1.5 text-xs font-medium hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] px-2.5 py-1.5 rounded-lg transition-colors"
                            style={{ color: "var(--text-muted)" }}
                          >
                            <Pencil size={11} />
                            {card.debtSubtype ? "Change type" : "Set account type"}
                          </button>
                          {!revolving && isSelected && (
                            <span className="ml-auto text-xs flex items-center gap-1" style={{ color: "var(--accent-info)" }}>
                              <Check size={9} /> filtering transactions
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 5. Transactions ── */}
      {transactions.length > 0 && (
        <section className="space-y-3">

          {/* ── Date preset buttons ── */}
          <div className="flex items-center gap-2">
            {(["7d","1m","3m","6m","1y","all"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setDatePreset(p)}
                className="text-xs font-semibold px-4 py-2.5 rounded-full border transition-colors touch-manipulation"
                style={datePreset === p
                  ? { background: "var(--accent-info)", borderColor: "var(--accent-info)", color: "#fff" }
                  : { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}
              >
                {p === "all" ? "All" : p === "7d" ? "7D" : p.toUpperCase()}
              </button>
            ))}
          </div>

          {/* ── Compact card ── */}
          <DataCard padding="0" className="overflow-hidden">
            {/* Card header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b" style={{ borderColor: "var(--border-hairline)" }}>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>Transactions</p>
                {selectedCard && (
                  <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--accent-info)", borderColor: "var(--border-hairline)" }}>
                    {selectedCard.name}
                    <button onClick={() => setSelectedCardId(null)} className="hover:text-[var(--text-primary)] ml-0.5"><X size={10} /></button>
                  </span>
                )}
                {totalDebtPaid > 0 && (
                  <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                    Total Debt Paid: {debtPaidEstimated ? "\u2248 " : ""}{fmtAggFull(totalDebtPaid)}{debtPaidEstimated && <EstimatedChip />}
                  </span>
                )}
                {/* Per-liability breakdown (P5 Slice 3 / KD-18) — only when
                    more than one card received payments in this range. */}
                {debtPaidByCard.length > 1 && debtPaidByCard.map((e) => (
                  <span key={e.accountId} className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {cards.find((c) => c.id === e.accountId)?.name ?? "Other"}: {e.estimated ? "\u2248 " : ""}{fmtAggFull(e.total)}{e.estimated && <EstimatedChip />}
                  </span>
                ))}
              </div>
              {baseTxs.length > COMPACT_ROWS && (
                <button
                  onClick={() => { setModalPage(0); setShowTxModal(true); }}
                  className="text-xs font-semibold transition-colors shrink-0 ml-2 touch-manipulation px-2 py-2"
                  style={{ color: "var(--accent-info)" }}
                >
                  Show more
                </button>
              )}
            </div>

            {/* 4-row compact list */}
            {baseTxs.length === 0 ? (
              <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>No transactions in this range.</p>
            ) : (
              <div className="divide-y divide-[var(--border-hairline)]">
                {compactSlice.map((tx) => <TxRow key={tx.id} tx={tx} cards={cards} selectedCardId={selectedCardId} />)}
              </div>
            )}
          </DataCard>
        </section>
      )}

      {/* ── Transaction modal ── */}
      {showTxModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 backdrop-blur-sm" style={{ background: "var(--scrim)" }} onClick={() => setShowTxModal(false)} />
          <div className="relative border rounded-3xl w-full sm:max-w-2xl max-h-[88dvh] flex flex-col shadow-2xl" style={{ background: "var(--modal-surface)", borderColor: "var(--border-hairline-strong)" }}>

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b shrink-0" style={{ borderColor: "var(--border-hairline)" }}>
              <p className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>All Transactions</p>
              <button onClick={() => setShowTxModal(false)} className="p-1.5 hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-xl transition-colors" style={{ color: "var(--text-muted)" }}>
                <X size={16} />
              </button>
            </div>

            {/* Modal filters */}
            <div className="px-5 py-3 border-b space-y-2 shrink-0" style={{ borderColor: "var(--border-hairline)" }}>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text-muted)" }} />
                <input
                  type="text" placeholder="Search…" value={search}
                  onChange={(e) => { setSearch(e.target.value); setModalPage(0); }}
                  className={`w-full border rounded-xl pl-8 pr-3 py-2 text-sm ${INPUT_CLS}`}
                  style={inputStyle}
                />
                {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-primary)]" style={{ color: "var(--text-muted)" }}><X size={12} /></button>}
              </div>
              <select
                value={catFilter ?? ""}
                onChange={(e) => { setCatFilter((e.target.value as TransactionCategory) || null); setModalPage(0); }}
                className={`w-full border rounded-xl px-3 py-2 text-sm ${INPUT_CLS}`}
                style={inputStyle}
              >
                <option value="">All categories</option>
                {ALL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <div className="flex items-center gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
                <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{filteredTxs.length}</span> transactions
                {totalDebtPaid > 0 && (
                  <span className="ml-3 font-semibold" style={{ color: "var(--text-secondary)" }}>Total Debt Paid: {debtPaidEstimated ? "\u2248 " : ""}{fmtAggFull(totalDebtPaid)}{debtPaidEstimated && <EstimatedChip />}</span>
                )}
              </div>
            </div>

            {/* Modal list */}
            <div className="overflow-y-auto flex-1 divide-y divide-[var(--border-hairline)]">
              {pageSlice.length === 0
                ? <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>No transactions match your filters.</p>
                : pageSlice.map((tx) => <TxRow key={tx.id} tx={tx} cards={cards} selectedCardId={selectedCardId} />)
              }
            </div>

            {/* Modal pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t shrink-0" style={{ borderColor: "var(--border-hairline)" }}>
                <button
                  onClick={() => setModalPage((p) => Math.max(0, p - 1))}
                  disabled={modalPage === 0}
                  className="flex items-center gap-1 text-xs font-semibold hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <ChevronLeft size={14} /> Prev
                </button>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{modalPage + 1} / {totalPages}</span>
                <button
                  onClick={() => setModalPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={modalPage === totalPages - 1}
                  className="flex items-center gap-1 text-xs font-semibold hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            )}

            {/* Collapse button */}
            <div className="px-5 pb-5 shrink-0">
              <button
                onClick={() => setShowTxModal(false)}
                className="w-full py-3 rounded-2xl text-sm font-semibold hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors"
                style={{ color: "var(--text-secondary)", background: "var(--surface-inset)" }}
              >
                Collapse
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ── Shared transaction row ────────────────────────────────────────────────────
function TxRow({ tx, cards, selectedCardId }: {
  tx: Transaction;
  cards: Array<{ id: string; name: string; creditLimit?: number }>;
  selectedCardId: string | null;
}) {
  const isCredit = tx.amount > 0;
  const dateObj  = new Date(tx.date + "T12:00:00");
  const acctName = cards.find((c) => c.id === tx.accountId)?.name ?? "";
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors">
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold leading-none" style={{ color: "var(--text-secondary)" }}>{dateObj.toLocaleDateString("en-US", { day: "numeric" })}</p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-faint)" }}>{dateObj.toLocaleDateString("en-US", { month: "short" })}</p>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{tx.merchant}</p>
          {tx.pending && <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}>Pending</span>}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${CAT_CHIP}`}>{tx.category}</span>
          {!selectedCardId && <span className="text-xs" style={{ color: "var(--text-faint)" }}>{acctName}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-bold tabular-nums" style={{ color: isCredit ? "var(--accent-positive)" : "var(--text-primary)" }}>
          {isCredit ? "+" : "−"}{fmtFull(tx.amount, tx.currency ?? DEFAULT_DISPLAY_CURRENCY)}
        </p>
      </div>
    </div>
  );
}
