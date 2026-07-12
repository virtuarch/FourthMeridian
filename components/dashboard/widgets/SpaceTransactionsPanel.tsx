"use client";

/**
 * SpaceTransactionsPanel
 *
 * Renders the full transaction list for a Space — search, category, account,
 * date-range, and pending/cleared filters — using the transactions and accounts
 * data already fetched by the parent DashboardClient (no extra server round-trip).
 *
 * Data path: getTransactions() → DashboardClient props → this component.
 * Account lookup (name + institution) mirrors BankingClient: match tx.accountId
 * to Account.id, which is FinancialAccount.id for Plaid-synced rows (normalized
 * by getAccounts() and getTransactions()).
 */

import { useState, useMemo, useCallback } from "react";
import { Account, Transaction, TransactionCategory } from "@/types";
import { DataCard } from "@/components/atlas/DataCard";
import { Search, X } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { FLOW_TYPE_LABEL, UNCLASSIFIED_FLOW_KEY, sumByFlowType } from "@/lib/transactions/flow-predicates";
// TI5-3C — rows open the shared Transaction Detail drawer (mounted in DashboardChrome).
import { useOpenTransaction } from "@/components/transactions/useTransactionDrawer";
import { TransactionDate } from "@/components/ui/TransactionDate";

// ── Formatters ─────────────────────────────────────────────────────────────────
// MC1 QA Q3 — itemized transaction rows pass the ROW's own currency.
const fmt = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency:              cur,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));

// ── Category badge ──────────────────────────────────────────────────────────
// Step C: category colour-coding neutralised to a single ink chip (matches the
// other transaction surfaces); the label carries the meaning.
const CAT_CHIP = "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

const BANKING_CATEGORIES: TransactionCategory[] = [
  "Income", "Transfer", "Groceries", "Dining", "Shopping",
  "Travel", "Subscriptions", "Utilities", "Interest", "Payment", "Other",
];

// FlowType P5 Slice 2 / TI1 — money-out cost flows that count toward the "Spend"
// chip. Membership now lives in the single-authority predicate module.

// ── Date-range filter ─────────────────────────────────────────────────────────
type DateRange = "all" | "90d" | "30d" | "7d";

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  all:  "All Time",
  "90d": "90 Days",
  "30d": "30 Days",
  "7d":  "7 Days",
};

function cutoffForRange(r: DateRange): string | null {
  if (r === "all") return null;
  const d = new Date();
  d.setDate(d.getDate() - (r === "90d" ? 90 : r === "30d" ? 30 : 7));
  return d.toISOString().split("T")[0];
}

// ── Pending filter ────────────────────────────────────────────────────────────
type PendingFilter = "all" | "cleared" | "pending";

const PENDING_LABELS: Record<PendingFilter, string> = {
  all:     "All",
  cleared: "Cleared",
  pending: "Pending",
};

// ── Source filter (provenance) ─────────────────────────────────────────────────
// Backed by the list-level `source` field (getTransactions() → deriveSource).
type SourceFilter = "all" | "plaid" | "import" | "manual";

const SOURCE_LABELS: Record<SourceFilter, string> = {
  all:    "All sources",
  plaid:  "Plaid",
  import: "Import",
  manual: "Manual",
};

// ── Group By / perspective ─────────────────────────────────────────────────────
// One control does both jobs: the vision's "Perspective toggle" (List vs. a
// pivoted view) IS Group By with "none" as the flat/List perspective — shipping
// a second toggle would be redundant (plan §2.3 / stop condition #4). Pure
// client-side reduce over the already-fetched, already-filtered list — no refetch.
type GroupBy = "none" | "flow" | "merchant" | "account" | "category";

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  none:     "No grouping",
  flow:     "Flow type",
  merchant: "Merchant",
  account:  "Account",
  category: "Category",
};

// ── Transfer disposition (CF-1) ────────────────────────────────────────────────
// Humanized labels for the canonical TransferDisposition already computed for
// every TRANSFER row by getTransactions(). These present the existing canonical
// concept (lib/transactions/transfer-evidence.ts) — no new terminology is coined.
const TRANSFER_DISPOSITION_LABEL: Record<string, string> = {
  INTERNAL_TRANSFER:      "Internal transfer",
  EXTERNAL_BANK_TRANSFER: "External bank transfer",
  ASSET_VENUE_TRANSFER:   "Asset venue transfer",
  CASH_MOVEMENT:          "Cash movement",
  PAYMENT_APP_MOVEMENT:   "Payment app movement",
  UNKNOWN_MOVEMENT:       "Unknown movement",
};

// ── Shared input styling (Atlas tokens) ──────────────────────────────────────
const INPUT_BASE = "border rounded-xl text-sm placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-info)] transition-colors";
const inputStyle: React.CSSProperties = { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" };

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  transactions: Transaction[];
  accounts:     Account[];
  /** Honesty label for shared Spaces, where KD-15 makes the list
   *  structurally partial (FULL-visibility shares only) — e.g. "Showing
   *  transactions from fully shared accounts only". Omit on Personal. */
  scopeNote?:   string;
  /**
   * MC1 Phase 3 Slice 6 (F-1, D-6) — serialized Space conversion context.
   * Optional: absent => context-less native sums (the kill switch).
   * Provided by DashboardClient (server-page props) and — since MC1 Phase 4
   * Slice 6 closed F-6 — by SpaceDashboard via the transactions API payload.
   */
  moneyCtx?:    SerializedConversionContext;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function SpaceTransactionsPanel({ transactions, accounts, scopeNote, moneyCtx }: Props) {
  // TI5-3C — shared opener; rows call it to open the shell-mounted detail drawer.
  const openTransaction = useOpenTransaction();
  // MC1 P3 Slice 6 — rehydrated once; per-row conversion at each row's own
  // date (identical math for all-USD Spaces / absent context).
  const conversionCtx = useMemo(
    () => (moneyCtx ? rehydrateContext(moneyCtx) : undefined),
    [moneyCtx],
  );
  // MC1 Phase 4 Slice 1 (D-1) — summary totals format in the display
  // currency; transaction rows keep the constant (itemized rule).
  const displayCurrency = useDisplayCurrency();
  const fmtAgg = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, maximumFractionDigits: 2 }).format(Math.abs(n));
  const rowAmount = useCallback(
    (t: Transaction): number =>
      conversionCtx
        ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, conversionCtx).amount
        : t.amount,
    [conversionCtx],
  );
  const [search,        setSearch]        = useState("");
  const [catFilter,     setCatFilter]     = useState<TransactionCategory | null>(null);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [dateRange,     setDateRange]     = useState<DateRange>("all");
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");
  // Transactions Tab Phase 1 — pivot the existing ledger by the FlowType already
  // on every row (no new query). null = all flow types.
  const [flowFilter,    setFlowFilter]    = useState<string | null>(null);
  // TE-2B needs-review: reuse the existing per-row needsClassification boolean
  // as-is (no confidence tiers, no new copy). false = show all rows.
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  // CF-1 transfer disposition — filter TRANSFER rows by their canonical
  // disposition (already on every row). null = all dispositions.
  const [dispositionFilter, setDispositionFilter] = useState<string | null>(null);
  // Provenance source — backed by the list-level `source` field.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  // Merchant filter — distinct resolved-merchant names present in the fetched
  // list (client-side; no new query). null = all merchants.
  const [merchantFilter, setMerchantFilter] = useState<string | null>(null);
  // Group By / perspective (see GroupBy above). "none" = the flat List view.
  const [groupBy, setGroupBy] = useState<GroupBy>("none");

  // ── Account lookup helpers ───────────────────────────────────────────────
  const accountMap = useMemo(() => {
    const m = new Map<string, Account>();
    accounts.forEach((a) => m.set(a.id, a));
    return m;
  }, [accounts]);

  const acctName = useCallback(
    (id: string) => accountMap.get(id)?.name ?? "Unknown Account",
    [accountMap],
  );
  const acctInst = useCallback(
    (id: string) => accountMap.get(id)?.institution ?? "",
    [accountMap],
  );

  // ── Institution groups for account filter dropdown ───────────────────────
  // Only includes institutions that have at least one transaction.
  const txAccountIds = useMemo(
    () => new Set(transactions.map((t) => t.accountId)),
    [transactions],
  );

  const institutionGroups = useMemo(() => {
    const groups = new Map<string, Account[]>();
    accounts
      .filter((a) => txAccountIds.has(a.id))
      .forEach((a) => {
        const inst = a.institution;
        if (!groups.has(inst)) groups.set(inst, []);
        groups.get(inst)!.push(a);
      });
    return groups;
  }, [accounts, txAccountIds]);

  // ── Distinct merchants for the merchant filter dropdown ───────────────────
  // Resolved display name (MI M6) with raw fallback; only merchants that appear
  // in the fetched list, sorted for a stable dropdown. No new query.
  const merchantOptions = useMemo(() => {
    const names = new Set<string>();
    transactions.forEach((t) => names.add(t.merchantDisplayName ?? t.merchant));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [transactions]);

  // ── Filtering ────────────────────────────────────────────────────────────
  const cutoff = cutoffForRange(dateRange);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return transactions.filter((tx) => {
      if (catFilter     && tx.category   !== catFilter)     return false;
      if (flowFilter    && tx.flowType   !== flowFilter)    return false;
      if (dispositionFilter && tx.transferDisposition !== dispositionFilter) return false;
      if (sourceFilter !== "all" && tx.source !== sourceFilter) return false;
      if (merchantFilter && (tx.merchantDisplayName ?? tx.merchant) !== merchantFilter) return false;
      if (needsReviewOnly && !tx.needsClassification)       return false;
      if (accountFilter && tx.accountId  !== accountFilter) return false;
      if (cutoff        && tx.date        < cutoff)         return false;
      if (pendingFilter === "cleared" &&  tx.pending)       return false;
      if (pendingFilter === "pending" && !tx.pending)       return false;
      if (q && !tx.merchant.toLowerCase().includes(q) && !(tx.merchantDisplayName ?? "").toLowerCase().includes(q) /* MI M6 — alias-aware */ && !(tx.description ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [transactions, catFilter, flowFilter, dispositionFilter, sourceFilter, merchantFilter, needsReviewOnly, accountFilter, cutoff, pendingFilter, search]);

  // ── Shared per-FlowType aggregation (§2.3.1) ───────────────────────────────
  // ONE sumByFlowType map drives BOTH the summary chips and the "By Flow Type"
  // Group By bucket totals — they can never drift (§9.8). Amount accessor = the
  // row's own converted magnitude, identical to the pre-existing summary math.
  const flowSums = useMemo(
    () => sumByFlowType(filtered, (t) => Math.abs(rowAmount(t))),
    [filtered, rowAmount],
  );
  const sumOf = useCallback((k: string) => flowSums.get(k) ?? 0, [flowSums]);

  // ── Group By (client-side pivot over the filtered list) ────────────────────
  // First-appearance order (filtered is date-desc) — no re-sort, no refetch.
  const groups = useMemo(() => {
    if (groupBy === "none") return null;
    const map = new Map<string, { label: string; rows: Transaction[] }>();
    for (const tx of filtered) {
      let key: string;
      let label: string;
      switch (groupBy) {
        case "flow":
          key = tx.flowType ?? UNCLASSIFIED_FLOW_KEY;
          label = tx.flowType ? (FLOW_TYPE_LABEL[tx.flowType] ?? tx.flowType) : "Unclassified";
          break;
        case "merchant":
          label = tx.merchantDisplayName ?? tx.merchant;
          key = label;
          break;
        case "account":
          key = tx.accountId;
          label = [acctInst(tx.accountId), acctName(tx.accountId)].filter(Boolean).join(" · ") || "Unknown Account";
          break;
        case "category":
        default:
          key = tx.category;
          label = tx.category;
          break;
      }
      const bucket = map.get(key) ?? { label, rows: [] };
      bucket.rows.push(tx);
      map.set(key, bucket);
    }
    // Per-bucket total. "By Flow Type" reads the SHARED sumByFlowType map (never a
    // second reduce — §9.8); other axes sum their own rows with the same accessor.
    return [...map.entries()].map(([key, g]) => ({
      key,
      ...g,
      sum: groupBy === "flow"
        ? (flowSums.get(key) ?? 0)
        : g.rows.reduce((s, t) => s + Math.abs(rowAmount(t)), 0),
    }));
  }, [filtered, groupBy, acctInst, acctName, flowSums, rowAmount]);

  // ── Summary totals (§2.3.1) ────────────────────────────────────────────────
  // Composed from the shared flowSums map above (same source as Group By).
  // Spend = SPENDING + FEE + INTEREST (cost flows) minus REFUND, clamped ≥ 0 —
  // reproduces the pre-existing figure exactly, now composed from the shared map.
  const grossSpend  = sumOf("SPENDING") + sumOf("FEE") + sumOf("INTEREST");
  const totalRefund = sumOf("REFUND");
  const totalSpend  = Math.max(0, grossSpend - totalRefund);
  const totalIn     = sumOf("INCOME");
  const totalTransfer   = sumOf("TRANSFER");
  const totalDebtPmt    = sumOf("DEBT_PAYMENT");
  const totalInvestment = sumOf("INVESTMENT");

  // ── Active filter chip helpers ─────────────────────────────────────────
  const selectedAccount = accountFilter ? accountMap.get(accountFilter) : null;

  const clearAll = useCallback(() => {
    setSearch("");
    setCatFilter(null);
    setFlowFilter(null);
    setDispositionFilter(null);
    setSourceFilter("all");
    setMerchantFilter(null);
    setNeedsReviewOnly(false);
    setAccountFilter(null);
    setDateRange("all");
    setPendingFilter("all");
  }, []);

  const hasActiveFilters =
    search || catFilter || flowFilter || dispositionFilter || sourceFilter !== "all" ||
    merchantFilter || needsReviewOnly || accountFilter || dateRange !== "all" || pendingFilter !== "all";

  return (
    <div className="space-y-4">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      {scopeNote && (
        <p className="text-[11px] px-1" style={{ color: "var(--text-muted)" }}>{scopeNote}</p>
      )}
      <div className="flex items-center justify-between flex-wrap gap-2 px-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
            Transactions
          </p>
          {/* Active filter chips */}
          {selectedAccount && (
            <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--accent-info)", borderColor: "var(--border-hairline)" }}>
              {selectedAccount.institution} · {selectedAccount.name}
              <button onClick={() => setAccountFilter(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {catFilter && (
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
              {catFilter}
              <button onClick={() => setCatFilter(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {flowFilter && (
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
              {FLOW_TYPE_LABEL[flowFilter] ?? flowFilter}
              <button onClick={() => setFlowFilter(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {dispositionFilter && (
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
              {TRANSFER_DISPOSITION_LABEL[dispositionFilter] ?? dispositionFilter}
              <button onClick={() => setDispositionFilter(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {sourceFilter !== "all" && (
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
              {SOURCE_LABELS[sourceFilter]}
              <button onClick={() => setSourceFilter("all")} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {merchantFilter && (
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
              {merchantFilter}
              <button onClick={() => setMerchantFilter(null)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {needsReviewOnly && (
            <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--accent-warning)", borderColor: "var(--border-hairline)" }}>
              Needs review
              <button onClick={() => setNeedsReviewOnly(false)} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {pendingFilter !== "all" && (
            <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}>
              {PENDING_LABELS[pendingFilter]}
              <button onClick={() => setPendingFilter("all")} className="hover:text-[var(--text-primary)] ml-0.5">
                <X size={10} />
              </button>
            </span>
          )}
          {hasActiveFilters && (
            <button
              onClick={clearAll}
              className="text-xs hover:text-[var(--text-secondary)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              Clear all
            </button>
          )}
        </div>

        {/* Date-range pill strip */}
        <div className="flex items-center gap-1 border rounded-xl p-1 shrink-0" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
          {(["all", "90d", "30d", "7d"] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              className="text-xs font-semibold px-2.5 py-2 rounded-lg transition-colors touch-manipulation"
              style={dateRange === r
                ? { background: "var(--accent-info)", color: "#fff" }
                : { color: "var(--text-secondary)" }}
            >
              {DATE_RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {/* ── Search + filters row ────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px]">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }}
          />
          <input
            type="text"
            placeholder="Search transactions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`w-full pl-8 pr-8 py-2.5 ${INPUT_BASE}`}
            style={inputStyle}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-primary)]"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Category */}
        <select
          value={catFilter ?? ""}
          onChange={(e) => setCatFilter((e.target.value as TransactionCategory) || null)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          <option value="">All categories</option>
          {BANKING_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* Flow type — pivots the ledger by Fourth Meridian's own FlowType
            (already on every row), not the provider category. */}
        <select
          value={flowFilter ?? ""}
          onChange={(e) => setFlowFilter(e.target.value || null)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          <option value="">All flow types</option>
          {Object.entries(FLOW_TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        {/* Account / institution */}
        <select
          value={accountFilter ?? ""}
          onChange={(e) => setAccountFilter(e.target.value || null)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          <option value="">All accounts</option>
          {[...institutionGroups.entries()].map(([inst, accts]) => (
            <optgroup key={inst} label={inst}>
              {accts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Movement (transfer disposition) — only meaningful for TRANSFER rows;
            the canonical disposition is already on every row (CF-1). */}
        <select
          value={dispositionFilter ?? ""}
          onChange={(e) => setDispositionFilter(e.target.value || null)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          <option value="">All movements</option>
          {Object.entries(TRANSFER_DISPOSITION_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        {/* Source (provenance) — backed by the list-level `source` field. */}
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          {(["all", "plaid", "import", "manual"] as SourceFilter[]).map((s) => (
            <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
          ))}
        </select>

        {/* Pending / cleared */}
        <select
          value={pendingFilter}
          onChange={(e) => setPendingFilter(e.target.value as PendingFilter)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          {(["all", "cleared", "pending"] as PendingFilter[]).map((p) => (
            <option key={p} value={p}>{PENDING_LABELS[p]}</option>
          ))}
        </select>

        {/* Merchant — distinct resolved-merchant names in the fetched list. */}
        <select
          value={merchantFilter ?? ""}
          onChange={(e) => setMerchantFilter(e.target.value || null)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
        >
          <option value="">All merchants</option>
          {merchantOptions.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        {/* Group by / perspective — one control; "none" is the flat List view. */}
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          className={`px-3 py-2.5 ${INPUT_BASE}`}
          style={inputStyle}
          aria-label="Group by"
        >
          {(["none", "flow", "merchant", "account", "category"] as GroupBy[]).map((g) => (
            <option key={g} value={g}>{g === "none" ? "No grouping" : `Group: ${GROUP_BY_LABELS[g]}`}</option>
          ))}
        </select>

        {/* Needs review — reuses the TE-2B needsClassification boolean as-is. */}
        <button
          type="button"
          onClick={() => setNeedsReviewOnly((v) => !v)}
          aria-pressed={needsReviewOnly}
          className={`px-3 py-2.5 rounded-xl text-sm border transition-colors touch-manipulation ${INPUT_BASE}`}
          style={needsReviewOnly
            ? { background: "var(--surface-inset)", borderColor: "var(--accent-warning)", color: "var(--accent-warning)" }
            : inputStyle}
        >
          Needs review
        </button>
      </div>

      {/* ── Summary strip ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 text-sm flex-wrap px-1">
        <span style={{ color: "var(--text-secondary)" }}>
          <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{filtered.length}</span>{" "}
          {filtered.length === 1 ? "transaction" : "transactions"}
        </span>
        {totalSpend > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            Spend:{" "}
            <span className="font-semibold" style={{ color: "var(--accent-negative)" }}>-{fmtAgg(totalSpend)}</span>
          </span>
        )}
        {totalIn > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            In:{" "}
            <span className="font-semibold" style={{ color: "var(--accent-positive)" }}>+{fmtAgg(totalIn)}</span>
          </span>
        )}
        {/* §2.3.1 — the rest of the FlowType ontology, one figure per kind.
            Zero-count discipline (§9.7): a kind absent from the filtered list
            renders NO chip (never a fabricated "$0.00"). Refund is disclosed as
            its own figure while Spend stays net of refunds, so no dollar is
            counted twice (§2.3.1's "do not double-count"). Transfers / debt
            payments / investments are movements, not P&L — shown in neutral ink. */}
        {totalTransfer > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            Transfers:{" "}
            <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{fmtAgg(totalTransfer)}</span>
          </span>
        )}
        {totalDebtPmt > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            Debt payments:{" "}
            <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{fmtAgg(totalDebtPmt)}</span>
          </span>
        )}
        {totalInvestment > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            Investments:{" "}
            <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{fmtAgg(totalInvestment)}</span>
          </span>
        )}
        {totalRefund > 0 && (
          <span style={{ color: "var(--text-secondary)" }}>
            Refunds:{" "}
            <span className="font-semibold" style={{ color: "var(--accent-positive)" }}>+{fmtAgg(totalRefund)}</span>
          </span>
        )}
      </div>

      {/* ── Transaction list ─────────────────────────────────────────────────── */}
      {transactions.length === 0 ? (
        <div className="rounded-2xl border py-14 text-center" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No transactions found for this Space.</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>
            Connect a bank account to start seeing transactions here.
          </p>
        </div>
      ) : (
        <DataCard padding="0" className="overflow-hidden">
          {filtered.length === 0 ? (
            <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>
              No transactions match your filters.
            </p>
          ) : groups ? (
            // Grouped (pivoted) view — a header per bucket, then its rows.
            <div className="divide-y divide-[var(--border-hairline)]">
              {groups.map((g) => (
                <div key={g.key}>
                  <div
                    className="flex items-center justify-between gap-2 px-4 py-2 sticky top-0 z-10"
                    style={{ background: "var(--surface-muted)", color: "var(--text-secondary)" }}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide truncate">{g.label}</span>
                    <span className="text-xs shrink-0 flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
                      {/* By-Flow-Type sum comes from the shared sumByFlowType map (§9.8). */}
                      <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>{fmtAgg(g.sum)}</span>
                      <span>·</span>
                      <span>{g.rows.length}</span>
                    </span>
                  </div>
                  <div className="divide-y divide-[var(--border-hairline)]">
                    {g.rows.map((tx) => (
                      <TxRow
                        key={tx.id}
                        tx={tx}
                        acctName={acctName(tx.accountId)}
                        acctInst={acctInst(tx.accountId)}
                        onOpen={() => openTransaction(tx.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-hairline)]">
              {filtered.map((tx) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  acctName={acctName(tx.accountId)}
                  acctInst={acctInst(tx.accountId)}
                  onOpen={() => openTransaction(tx.id)}
                />
              ))}
            </div>
          )}
        </DataCard>
      )}
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
function TxRow({
  tx,
  acctName,
  acctInst,
  onOpen,
}: {
  tx:       Transaction;
  acctName: string;
  acctInst: string;
  onOpen:   () => void;
}) {
  const isCredit = tx.amount > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors cursor-pointer focus:outline-none focus-visible:bg-[var(--surface-hover)]"
    >
      {/* Date column */}
      <TransactionDate date={tx.date} />

      {/* Merchant + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{tx.merchantDisplayName ?? tx.merchant}{/* MI M6 — resolved name, raw fallback */}</p>
          {tx.pending && (
            <span className="text-xs px-1.5 py-0.5 rounded-full shrink-0" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}>
              Pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${CAT_CHIP}`}>
            {tx.category}
          </span>
          {/* CF-1 transfer disposition — canonical concept, already on the row. */}
          {tx.transferDisposition && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${CAT_CHIP}`}>
              {TRANSFER_DISPOSITION_LABEL[tx.transferDisposition] ?? tx.transferDisposition}
            </span>
          )}
          <span className="text-xs truncate" style={{ color: "var(--text-faint)" }}>
            {acctInst}{acctInst && acctName ? " · " : ""}{acctName}
          </span>
        </div>
      </div>

      {/* Amount */}
      <div className="shrink-0 text-right">
        <p className="text-sm font-bold tabular-nums" style={{ color: isCredit ? "var(--accent-positive)" : "var(--text-primary)" }}>
          {isCredit ? "+" : "−"}{fmt(tx.amount, tx.currency ?? DEFAULT_DISPLAY_CURRENCY)}
        </p>
      </div>
    </div>
  );
}
