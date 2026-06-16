"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Account, Transaction, TransactionCategory } from "@/types";
import { FicoCard } from "@/components/dashboard/FicoCard";
import { Card, CardTitle } from "@/components/ui/Card";
import {
  ShieldCheck, Save, Loader2, CreditCard, Pencil, X,
  Check, Search, ChevronLeft, ChevronRight, ChevronDown,
} from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate as formatDateUTC } from "@/lib/format";
import { renderDebtBreakdownChart, renderDebtPayoffCalculator } from "@/components/workspace/widgets/debt-adapters";
import { estimateMinimumPayment } from "@/lib/debt";

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(Math.abs(n));
const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(Math.abs(n));

// ── Category badge colors ─────────────────────────────────────────────────────
const CAT_COLORS: Partial<Record<TransactionCategory, string>> = {
  Income:        "bg-emerald-500/15 text-emerald-400",
  Transfer:      "bg-blue-500/15 text-blue-400",
  Groceries:     "bg-lime-500/15 text-lime-400",
  Dining:        "bg-orange-500/15 text-orange-400",
  Shopping:      "bg-purple-500/15 text-purple-400",
  Travel:        "bg-sky-500/15 text-sky-400",
  Subscriptions: "bg-violet-500/15 text-violet-400",
  Utilities:     "bg-slate-500/15 text-slate-400",
  Interest:      "bg-teal-500/15 text-teal-400",
  Payment:       "bg-gray-500/15 text-gray-400",
  Other:         "bg-gray-600/15 text-gray-500",
};

// Income, Transfer, Interest excluded — not relevant for credit card review
const ALL_CATEGORIES: TransactionCategory[] = [
  "Groceries","Dining","Shopping","Travel","Subscriptions","Utilities","Payment","Other",
];

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
function utilColor(pct: number) {
  if (pct >= 70) return "bg-red-500";
  if (pct >= 30) return "bg-yellow-400";
  return "bg-emerald-400";
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
}

// ── Main component ────────────────────────────────────────────────────────────
export function DebtClient({ initialFico, lastUpdatedAt, accounts, transactions }: Props) {
  const router = useRouter();

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
  const totalUsed      = cards.reduce((s, a) => s + Math.max(0, a.balance), 0);
  const totalLimit     = limitedCards.reduce((s, a) => s + (a.creditLimit ?? 0), 0);
  const totalAvailable = totalLimit - owedCards.reduce((s, a) => s + a.balance, 0);
  const overallUtil    = totalLimit > 0
    ? (owedCards.reduce((s, a) => s + a.balance, 0) / totalLimit) * 100
    : 0;
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

  // Payments made toward the card balance (positive txs with category Payment)
  const totalDebtPaid = baseTxs
    .filter((t) => t.category === "Payment")
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Credit</h1>

      {/* ── 1. FICO score — always at top ── */}
      <section className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FicoCard score={score} lastUpdated={formatDate(updatedAt)} />
          {/* ── Update Your Score — collapsible ── */}
          <Card>
            <button
              onClick={() => setUpdateScoreOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 touch-manipulation"
            >
              <div className="flex items-center gap-2">
                <ShieldCheck size={15} className="text-blue-400" />
                <CardTitle>Update Your Score</CardTitle>
              </div>
              <ChevronDown
                size={15}
                className="text-gray-500 transition-transform duration-200 shrink-0"
                style={{ transform: updateScoreOpen ? "rotate(180deg)" : "rotate(0deg)" }}
              />
            </button>
            <div
              className="overflow-hidden transition-all duration-200"
              style={{ maxHeight: updateScoreOpen ? 400 : 0, opacity: updateScoreOpen ? 1 : 0 }}
            >
              <div className="pt-4 space-y-3">
                <p className="text-xs text-gray-400">
                  Check your free FICO score via Chase, Amex, or Experian and enter it here. Updating monthly keeps your dashboard accurate.
                </p>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">FICO Score (300–850)</label>
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
                    className={`w-full bg-gray-800 border rounded-xl px-4 py-3 text-white text-lg font-bold focus:outline-none transition-colors ${
                      ficoError ? "border-red-500 focus:border-red-400" : "border-gray-700 focus:border-blue-500"
                    }`}
                  />
                  {ficoError && (
                    <p className="text-xs text-red-400 mt-1">Score must be between 300 and 850.</p>
                  )}
                </div>
                <button
                  onClick={handleSaveFico} disabled={saving || !ficoValid}
                  className={`flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-60 ${
                    saved ? "bg-emerald-600 text-white" : "bg-blue-600 hover:bg-blue-500 text-white"
                  }`}
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {saving ? "Saving…" : saved ? "Saved!" : "Save Score"}
                </button>
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* ── 2. Score ranges + tips — individually collapsible ── */}
      <div className="space-y-3">
        {/* Score Ranges */}
        <Card>
          <button
            onClick={() => setRangesOpen((v) => !v)}
            className="w-full flex items-center justify-between touch-manipulation"
          >
            <CardTitle>Score Ranges</CardTitle>
            <ChevronDown
              size={15}
              className="text-gray-500 transition-transform duration-200 shrink-0"
              style={{ transform: rangesOpen ? "rotate(180deg)" : "rotate(0deg)" }}
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
                    <span className="text-sm text-white font-medium w-24">{label}</span>
                    <span className="text-sm text-gray-400">{range}</span>
                    {active && <span className="text-xs font-semibold text-blue-400 ml-auto">← You</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        {/* How to Improve */}
        <Card>
          <button
            onClick={() => setTipsOpen((v) => !v)}
            className="w-full flex items-center justify-between touch-manipulation"
          >
            <CardTitle>How to Improve</CardTitle>
            <ChevronDown
              size={15}
              className="text-gray-500 transition-transform duration-200 shrink-0"
              style={{ transform: tipsOpen ? "rotate(180deg)" : "rotate(0deg)" }}
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
                <p key={i} className="text-sm text-gray-400 pl-3 border-l border-gray-700">{tip}</p>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* ── 3. Utilization summary (limited cards only, excl. charge cards) ── */}
      {limitedCards.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card>
            <CardTitle>Total Used</CardTitle>
            <p className="text-2xl font-bold text-red-400 mt-1">{fmtUSD(totalUsed)}</p>
            <p className="text-xs text-gray-500 mt-1">{cards.length} card{cards.length !== 1 ? "s" : ""}</p>
          </Card>
          <Card>
            <CardTitle>Total Limit</CardTitle>
            <p className="text-2xl font-bold text-white mt-1">{fmtUSD(totalLimit)}</p>
            <p className="text-xs text-gray-500 mt-1">Combined credit</p>
          </Card>
          <Card>
            <CardTitle>Available</CardTitle>
            <p className="text-2xl font-bold text-emerald-400 mt-1">{fmtUSD(totalAvailable)}</p>
            <p className="text-xs text-gray-500 mt-1">Limit minus balance</p>
          </Card>
          <Card>
            <CardTitle>Utilization</CardTitle>
            <p className={`text-2xl font-bold mt-1 ${overallUtil >= 70 ? "text-red-400" : overallUtil >= 30 ? "text-yellow-400" : "text-emerald-400"}`}>
              {overallUtil.toFixed(1)}%
            </p>
            <div className="w-full h-1.5 bg-gray-800 rounded-full mt-2 overflow-hidden">
              <div className={`h-full rounded-full transition-all ${utilColor(overallUtil)}`} style={{ width: `${Math.min(overallUtil, 100)}%` }} />
            </div>
          </Card>
        </div>
      )}

      {/* ── 4. Debt breakdown donut (shared widget, same as workspace debt dashboard) ── */}
      {accounts.length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 px-1">Breakdown</p>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            {renderDebtBreakdownChart(accounts, "donut", "Add debt accounts to see your debt breakdown.")}
          </div>
        </section>
      )}

      {/* ── 5. Payoff planner (shared widget, same as workspace debt dashboard) ── */}
      {accounts.filter((a) => a.balance > 0).length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 px-1">Payoff Planner</p>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            {renderDebtPayoffCalculator(accounts)}
          </div>
        </section>
      )}

      {/* ── 6. Per-card breakdown ── */}
      {cards.length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 px-1">Cards</p>
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
                  className={`rounded-2xl border transition-all ${
                    isSelected ? "border-blue-500 bg-blue-500/5" : "border-gray-800 bg-gray-900/60 hover:border-gray-700"
                  }`}
                >
                  {/* Card header */}
                  <button
                    onClick={() => setSelectedCardId((prev) => prev === card.id ? null : card.id)}
                    className="w-full flex items-center justify-between px-4 py-4 text-left touch-manipulation select-none"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isSelected ? "bg-blue-500/20" : "bg-gray-800"}`}>
                        <CreditCard size={16} className={isSelected ? "text-blue-400" : "text-gray-400"} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-white leading-tight">{card.name}</p>
                          {isCredit && (
                            <span className="text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                              Owes you
                            </span>
                          )}
                          {subtypeLabel && (
                            <span className="text-xs bg-gray-800 text-gray-400 border border-gray-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                              {subtypeLabel}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{card.institution}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-bold tabular-nums ${isCredit ? "text-emerald-400" : "text-red-400"}`}>
                        {isCredit ? `+${fmtUSD(used)}` : `−${fmtUSD(used)}`}
                      </p>
                      {revolving && !isCredit && limit && (
                        <p className="text-xs text-gray-500 mt-0.5">of {fmtUSD(limit)}</p>
                      )}
                    </div>
                  </button>

                  <div className="px-4 pb-4 space-y-3">
                    {/* Utilization bar — revolving only */}
                    {util !== null && (
                      <div>
                        <div className="flex justify-between text-xs mb-1.5">
                          <span className={`font-semibold ${util >= 70 ? "text-red-400" : util >= 30 ? "text-yellow-400" : "text-emerald-400"}`}>
                            {util.toFixed(1)}% used
                          </span>
                          <span className="text-gray-500">{fmtUSD(available ?? 0)} available</span>
                        </div>
                        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${utilColor(util)}`} style={{ width: `${Math.min(util, 100)}%` }} />
                        </div>
                      </div>
                    )}

                    {/* APR + minimum payment + due/statement days */}
                    {(card.interestRate != null || card.minimumPayment != null || card.debtProfile?.dueDay || card.debtProfile?.statementCloseDay) && (
                      <div className="flex items-center gap-4 flex-wrap">
                        {card.interestRate != null && (
                          <div>
                            <p className="text-[10px] text-gray-600 uppercase tracking-widest">APR</p>
                            <p className="text-sm font-semibold text-orange-400">{card.interestRate.toFixed(2)}%</p>
                          </div>
                        )}
                        {card.minimumPayment != null && (
                          <div>
                            <p className="text-[10px] text-gray-600 uppercase tracking-widest">
                              {card.minimumPaymentIsEstimated ? "Est. Min Payment" : "Min Payment"}
                            </p>
                            <p className="text-sm font-semibold text-white">
                              {fmtUSD(card.minimumPayment)}/mo
                            </p>
                          </div>
                        )}
                        {card.debtProfile?.dueDay && (
                          <div>
                            <p className="text-[10px] text-gray-600 uppercase tracking-widest">Due</p>
                            <p className="text-sm font-semibold text-gray-300">{ordinal(card.debtProfile.dueDay)}</p>
                          </div>
                        )}
                        {card.debtProfile?.statementCloseDay && (
                          <div>
                            <p className="text-[10px] text-gray-600 uppercase tracking-widest">Statement Close</p>
                            <p className="text-sm font-semibold text-gray-300">{ordinal(card.debtProfile.statementCloseDay)}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {card.minimumPaymentIsEstimated && card.minimumPayment != null && (
                      <p className="text-xs text-gray-500">
                        Estimated minimum payment — not provided by your issuer. Enter an exact amount in debt details for accuracy.
                      </p>
                    )}
                    {card.debtProfile?.promoAprEndDate && (
                      <p className="text-xs text-yellow-400">Promo APR ends {formatDate(card.debtProfile.promoAprEndDate)}</p>
                    )}
                    {card.debtProfile?.notes && (
                      <p className="text-xs text-gray-500 italic truncate">&quot;{card.debtProfile.notes}&quot;</p>
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
                              className="flex-1 bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                            />
                            <button
                              onClick={() => handleSaveLimit(card.id)} disabled={savingLimit}
                              className="flex items-center gap-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 px-3 py-2 rounded-xl transition-colors"
                            >
                              {savingLimit ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              Save
                            </button>
                            <button onClick={() => setEditingLimitId(null)} className="p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-xl transition-colors">
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingLimitId(card.id); setLimitInput(card.creditLimit ? String(card.creditLimit) : ""); }}
                            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-white hover:bg-gray-800 px-2.5 py-1.5 rounded-lg transition-colors"
                          >
                            <Pencil size={11} />
                            {card.creditLimit ? "Edit limit" : "Set limit"}
                          </button>
                        )}
                        {isSelected && (
                          <span className="ml-auto text-xs text-blue-400 flex items-center gap-1">
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
                          className="space-y-2 bg-gray-800/40 border border-gray-700 rounded-xl p-3"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">APR %</label>
                              <input
                                type="text" inputMode="decimal" placeholder="e.g. 24.99"
                                value={debtForm.apr}
                                onChange={(e) => setDebtForm((f) => ({ ...f, apr: e.target.value }))}
                                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Min Payment $</label>
                              <input
                                type="text" inputMode="decimal" placeholder="Auto-estimated if blank"
                                value={debtForm.minimumPayment}
                                onChange={(e) => setDebtForm((f) => ({ ...f, minimumPayment: e.target.value }))}
                                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Due Day (1–31)</label>
                              <input
                                type="text" inputMode="numeric" placeholder="e.g. 15"
                                value={debtForm.dueDay}
                                onChange={(e) => setDebtForm((f) => ({ ...f, dueDay: e.target.value }))}
                                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Statement Close Day</label>
                              <input
                                type="text" inputMode="numeric" placeholder="e.g. 28"
                                value={debtForm.statementCloseDay}
                                onChange={(e) => setDebtForm((f) => ({ ...f, statementCloseDay: e.target.value }))}
                                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Promo APR Ends</label>
                              <input
                                type="date"
                                value={debtForm.promoAprEndDate}
                                onChange={(e) => setDebtForm((f) => ({ ...f, promoAprEndDate: e.target.value }))}
                                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                              />
                            </div>
                            <div className="col-span-2">
                              <label className="block text-[10px] text-gray-500 mb-1">Notes</label>
                              <input
                                type="text" placeholder="Optional"
                                value={debtForm.notes}
                                onChange={(e) => setDebtForm((f) => ({ ...f, notes: e.target.value }))}
                                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                              />
                            </div>
                          </div>
                          {debtError && <p className="text-xs text-red-400">{debtError}</p>}
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSaveDebtProfile(card.id)}
                              disabled={savingDebt}
                              className="flex items-center justify-center gap-1.5 flex-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 px-3 py-2 rounded-xl transition-colors"
                            >
                              {savingDebt ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              Save
                            </button>
                            <button
                              onClick={() => { setEditingDebtId(null); setDebtError(null); }}
                              disabled={savingDebt}
                              className="p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); openDebtEditor(card); }}
                          className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-white hover:bg-gray-800 px-2.5 py-1.5 rounded-lg transition-colors self-start"
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
                              className="flex-1 bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                            >
                              <option value="" disabled>Select type…</option>
                              {DEBT_SUBTYPES.map((s) => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => handleSaveSubtype(card.id)}
                              disabled={savingSubtype || !subtypeInput}
                              className="flex items-center gap-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-2 rounded-xl transition-colors"
                            >
                              {savingSubtype ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                              Save
                            </button>
                            <button
                              onClick={() => { setEditingSubtypeId(null); setSubtypeInput(""); setSubtypeError(null); }}
                              className="p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
                            >
                              <X size={14} />
                            </button>
                          </div>
                          {subtypeError && (
                            <p className="text-xs text-red-400 px-1">{subtypeError}</p>
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
                            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-white hover:bg-gray-800 px-2.5 py-1.5 rounded-lg transition-colors"
                          >
                            <Pencil size={11} />
                            {card.debtSubtype ? "Change type" : "Set account type"}
                          </button>
                          {!revolving && isSelected && (
                            <span className="ml-auto text-xs text-blue-400 flex items-center gap-1">
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
                className={`text-xs font-semibold px-4 py-2.5 rounded-full border transition-colors touch-manipulation ${
                  datePreset === p
                    ? "bg-blue-600 border-blue-500 text-white"
                    : "bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white"
                }`}
              >
                {p === "all" ? "All" : p === "7d" ? "7D" : p.toUpperCase()}
              </button>
            ))}
          </div>

          {/* ── Compact card ── */}
          <Card className="!p-0 overflow-hidden">
            {/* Card header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-800">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Transactions</p>
                {selectedCard && (
                  <span className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
                    {selectedCard.name}
                    <button onClick={() => setSelectedCardId(null)} className="hover:text-white ml-0.5"><X size={10} /></button>
                  </span>
                )}
                {totalDebtPaid > 0 && (
                  <span className="text-xs font-semibold text-yellow-400">
                    Total Debt Paid: {fmtFull(totalDebtPaid)}
                  </span>
                )}
              </div>
              {baseTxs.length > COMPACT_ROWS && (
                <button
                  onClick={() => { setModalPage(0); setShowTxModal(true); }}
                  className="text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors shrink-0 ml-2 touch-manipulation px-2 py-2"
                >
                  Show more
                </button>
              )}
            </div>

            {/* 4-row compact list */}
            {baseTxs.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-10">No transactions in this range.</p>
            ) : (
              <div className="divide-y divide-gray-800">
                {compactSlice.map((tx) => <TxRow key={tx.id} tx={tx} cards={cards} selectedCardId={selectedCardId} />)}
              </div>
            )}
          </Card>
        </section>
      )}

      {/* ── Transaction modal ── */}
      {showTxModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowTxModal(false)} />
          <div className="relative bg-gray-900 border border-gray-700 rounded-3xl w-full sm:max-w-2xl max-h-[88dvh] flex flex-col shadow-2xl">

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-800 shrink-0">
              <p className="text-sm font-bold text-white">All Transactions</p>
              <button onClick={() => setShowTxModal(false)} className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-xl transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Modal filters */}
            <div className="px-5 py-3 border-b border-gray-800 space-y-2 shrink-0">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="text" placeholder="Search…" value={search}
                  onChange={(e) => { setSearch(e.target.value); setModalPage(0); }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl pl-8 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
                {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"><X size={12} /></button>}
              </div>
              <select
                value={catFilter ?? ""}
                onChange={(e) => { setCatFilter((e.target.value as TransactionCategory) || null); setModalPage(0); }}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              >
                <option value="">All categories</option>
                {ALL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <span className="font-semibold text-white">{filteredTxs.length}</span> transactions
                {totalDebtPaid > 0 && (
                  <span className="ml-3 font-semibold text-yellow-400">Total Debt Paid: {fmtFull(totalDebtPaid)}</span>
                )}
              </div>
            </div>

            {/* Modal list */}
            <div className="overflow-y-auto flex-1 divide-y divide-gray-800">
              {pageSlice.length === 0
                ? <p className="text-sm text-gray-500 text-center py-10">No transactions match your filters.</p>
                : pageSlice.map((tx) => <TxRow key={tx.id} tx={tx} cards={cards} selectedCardId={selectedCardId} />)
              }
            </div>

            {/* Modal pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800 shrink-0">
                <button
                  onClick={() => setModalPage((p) => Math.max(0, p - 1))}
                  disabled={modalPage === 0}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={14} /> Prev
                </button>
                <span className="text-xs text-gray-500">{modalPage + 1} / {totalPages}</span>
                <button
                  onClick={() => setModalPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={modalPage === totalPages - 1}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            )}

            {/* Collapse button */}
            <div className="px-5 pb-5 shrink-0">
              <button
                onClick={() => setShowTxModal(false)}
                className="w-full py-3 rounded-2xl text-sm font-semibold text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors"
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
  const catCls   = CAT_COLORS[tx.category] ?? "bg-gray-600/15 text-gray-500";
  const acctName = cards.find((c) => c.id === tx.accountId)?.name ?? "";
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800/40 transition-colors">
      <div className="w-9 shrink-0 text-center">
        <p className="text-xs font-semibold text-gray-300 leading-none">{dateObj.toLocaleDateString("en-US", { day: "numeric" })}</p>
        <p className="text-xs text-gray-600 mt-0.5">{dateObj.toLocaleDateString("en-US", { month: "short" })}</p>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-white truncate">{tx.merchant}</p>
          {tx.pending && <span className="text-xs bg-yellow-500/15 text-yellow-400 px-1.5 py-0.5 rounded-full shrink-0">Pending</span>}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${catCls}`}>{tx.category}</span>
          {!selectedCardId && <span className="text-xs text-gray-600">{acctName}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-sm font-bold tabular-nums ${isCredit ? "text-emerald-400" : "text-white"}`}>
          {isCredit ? "+" : "−"}{fmtFull(tx.amount)}
        </p>
      </div>
    </div>
  );
}
