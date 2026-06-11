"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Account, Transaction, TransactionCategory } from "@/types";
import { FicoCard } from "@/components/dashboard/FicoCard";
import { Card, CardTitle } from "@/components/ui/Card";
import {
  ShieldCheck, Save, Loader2, CreditCard, Pencil, X,
  Check, Search, ChevronLeft, ChevronRight,
} from "lucide-react";

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.abs(n));
const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Math.abs(n));

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

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Utilization bar color ─────────────────────────────────────────────────────
function utilColor(pct: number) {
  if (pct >= 70) return "bg-red-500";
  if (pct >= 30) return "bg-yellow-400";
  return "bg-emerald-400";
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  initialFico:   number | null;
  lastUpdatedAt: string | null;
  accounts:      Account[];       // debt accounts only
  transactions:  Transaction[];   // debt account transactions
}

// ── Main component ────────────────────────────────────────────────────────────
export function CreditClient({ initialFico, lastUpdatedAt, accounts, transactions }: Props) {
  const router = useRouter();

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
  // Optimistic limit overrides so the UI updates immediately after save
  const [limitOverrides,  setLimitOverrides]   = useState<Record<string, number>>({});

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

  // ── Derived totals ────────────────────────────────────────────────────────
  const cards = accounts.map((a) => ({
    ...a,
    creditLimit: limitOverrides[a.id] ?? a.creditLimit,
  }));

  // Convention: balance > 0 = you owe; balance < 0 = credit (bank owes you)
  // Charge cards (no limit) excluded from utilization math
  const limitedCards   = cards.filter((c) => c.creditLimit && c.creditLimit > 0);
  const owedCards      = limitedCards.filter((c) => c.balance > 0);
  const totalUsed      = cards.reduce((s, a) => s + Math.max(0, a.balance), 0);
  const totalLimit     = limitedCards.reduce((s, a) => s + (a.creditLimit ?? 0), 0);
  const totalAvailable = totalLimit - owedCards.reduce((s, a) => s + a.balance, 0);
  const overallUtil    = totalLimit > 0
    ? (owedCards.reduce((s, a) => s + a.balance, 0) / totalLimit) * 100
    : 0;
  const hasChargecards = cards.some((c) => !c.creditLimit);

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
          <Card>
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck size={16} className="text-blue-400" />
              <CardTitle>Update Your Score</CardTitle>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Check your free FICO score via Chase, Amex, or Experian and enter it here. Updating monthly keeps your dashboard accurate.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">FICO Score (300–850)</label>
                <input
                  type="text" inputMode="decimal" pattern="[0-9]*"
                  value={inputVal}
                  onChange={(e) => {
                    // Strip non-numeric chars so iOS numeric keyboard can't produce bad input
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
          </Card>
        </div>
      </section>

      {/* ── 2. Score ranges + tips (single combined card) ── */}
      <Card>
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-10">
          {/* Score ranges */}
          <div className="flex-1">
            <CardTitle>Score Ranges</CardTitle>
            <div className="mt-3 space-y-2">
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

          {/* Divider */}
          <div className="hidden lg:block w-px bg-gray-800 self-stretch" />
          <div className="block lg:hidden h-px bg-gray-800" />

          {/* How to Improve */}
          <div className="flex-1">
            <CardTitle>How to Improve</CardTitle>
            <div className="mt-3 space-y-2">
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
        </div>
      </Card>

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
            <p className="text-xs text-gray-500 mt-1">
              {hasChargecards ? "Excl. charge cards" : "Combined credit"}
            </p>
          </Card>
          <Card>
            <CardTitle>Available</CardTitle>
            <p className="text-2xl font-bold text-emerald-400 mt-1">{fmtUSD(totalAvailable)}</p>
            <p className="text-xs text-gray-500 mt-1">
              {hasChargecards ? "Excl. charge cards" : "Limit minus balance"}
            </p>
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

      {/* ── 4. Per-card breakdown ── */}
      {cards.length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 px-1">Cards</p>
          <div className="space-y-3">
            {cards.map((card) => {
              // positive = you owe; negative = bank owes you (credit)
              const isCredit    = card.balance < 0;
              const used        = Math.abs(card.balance);
              const limit       = card.creditLimit;
              const isCharge    = !limit;
              const util        = !isCharge && !isCredit && limit! > 0 ? (card.balance / limit!) * 100 : null;
              const available   = !isCharge && !isCredit ? limit! - card.balance : null;
              const isSelected  = selectedCardId === card.id;
              const isEditing   = editingLimitId === card.id;

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
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-white leading-tight">{card.name}</p>
                          {isCredit ? (
                            <span className="text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                              Owes you
                            </span>
                          ) : isCharge ? (
                            <span className="text-xs bg-purple-500/15 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded-full">
                              Charge card
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{card.institution}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-bold tabular-nums ${isCredit ? "text-emerald-400" : "text-red-400"}`}>
                        {isCredit ? `+${fmtUSD(used)}` : `−${fmtUSD(used)}`}
                      </p>
                      {!isCredit && !isCharge && limit && (
                        <p className="text-xs text-gray-500 mt-0.5">of {fmtUSD(limit)}</p>
                      )}
                    </div>
                  </button>

                  <div className="px-4 pb-4 space-y-3">
                    {/* Utilization bar — only for limited cards */}
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

                    {/* Limit edit row */}
                    <div className="flex items-center gap-2">
                      {isEditing ? (
                        <div className="flex items-center gap-2 flex-1">
                          <input
                            autoFocus type="text" inputMode="numeric"
                            placeholder={isCharge ? "Optional soft limit…" : "e.g. 25000"}
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
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pt-4 pb-40 sm:p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowTxModal(false)} />
          <div className="relative bg-gray-900 border border-gray-700 rounded-3xl w-full sm:max-w-2xl max-h-[calc(100dvh-180px)] sm:max-h-[85vh] flex flex-col shadow-2xl">

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
