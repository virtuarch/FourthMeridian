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
import {
  Search, X, SlidersHorizontal, CalendarDays, ChevronRight, ChevronLeft, ArrowDownUp, ArrowLeftRight,
} from "lucide-react";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { ToolbarMenuButton } from "@/components/dashboard/widgets/transactions/ToolbarMenuButton";
import { QuickFlowPills } from "@/components/dashboard/widgets/transactions/QuickFlowPills";
import { TransactionSummaryCards } from "@/components/dashboard/widgets/transactions/TransactionSummaryCards";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { FLOW_TYPE_LABEL, UNCLASSIFIED_FLOW_KEY, sumByFlowType } from "@/lib/transactions/flow-predicates";
import { TransactionsCalendarHeatmap } from "@/components/dashboard/widgets/transactions/TransactionsCalendarHeatmap";
// TI5-3C — rows open the shared Transaction Detail drawer (mounted in DashboardChrome).
import { useOpenTransaction } from "@/components/transactions/useTransactionDrawer";
import { TransactionDate } from "@/components/ui/TransactionDate";
import { TransactionsFilterOverlay } from "@/components/dashboard/widgets/transactions/TransactionsFilterOverlay";
import {
  CAT_CHIP,
  TRANSFER_DISPOSITION_LABEL,
  INPUT_BASE,
  inputStyle,
  type PendingFilter,
  type SourceFilter,
  type GroupBy,
} from "@/components/dashboard/widgets/transactions/transactions-filter-constants";
import { TransactionFilterChips } from "@/components/dashboard/widgets/transactions/TransactionFilterChips";

// ── Formatters ─────────────────────────────────────────────────────────────────
// MC1 QA Q3 — itemized transaction rows pass the ROW's own currency.
const fmt = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency:              cur,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));

// FlowType P5 Slice 2 / TI1 — money-out cost flows that count toward the "Spend"
// chip. Membership now lives in the single-authority predicate module.

// ── Date-range filter ─────────────────────────────────────────────────────────
// Redesign Slice 2 — "custom" adds an explicit [from, to] window (both optional)
// alongside the rolling presets. The predicate stays a pure date comparison over
// the already-fetched list; no query/API change.
type DateRange = "all" | "90d" | "30d" | "7d" | "custom";

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  all:  "All Time",
  "90d": "90 Days",
  "30d": "30 Days",
  "7d":  "7 Days",
  custom: "Custom",
};

// ── Sort (Slice 7) ────────────────────────────────────────────────────────────
// Pure client-side reorder of the already-fetched, already-filtered list — the
// same "no refetch" philosophy as Group By. "newest" returns the list untouched
// so the default order is byte-identical to the pre-redesign behavior (the data
// arrives date-desc from getTransactions()).
type SortBy = "newest" | "oldest" | "largest" | "smallest" | "merchant";

const SORT_LABELS: Record<SortBy, string> = {
  newest:   "Newest",
  oldest:   "Oldest",
  largest:  "Largest",
  smallest: "Smallest",
  merchant: "Merchant A–Z",
};

// ── Day-header formatter (editorial timeline) ────────────────────────────────
// The ledger's temporal spine: rows group under the day they occurred. Parsed at
// local midnight (append T00:00:00, no trailing Z) so a YYYY-MM-DD never drifts a
// day across time zones. Presentation only — no new data.
function formatDayHeader(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

// ── Pagination (table redesign follow-up) ─────────────────────────────────────
// Page-size options — default 25, capped at 100 (product decision). Pure
// client-side slicing of the already-filtered/sorted list; no query change.
// Scoped to the flat Table view: Group By keeps rendering full buckets, since
// paginating across group boundaries is a separate, unrequested feature.
type PageSize = 25 | 50 | 100;
const PAGE_SIZE_OPTIONS: readonly PageSize[] = [25, 50, 100];

/** Compact page-number sequence with "…" gaps, e.g. [1, "…", 4, 5, 6, "…", 154]. */
function paginationRange(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, current - 1, current, current + 1]);
  const sortedPages = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  sortedPages.forEach((p, i) => {
    if (i > 0 && p - (sortedPages[i - 1] as number) > 1) out.push("…");
    out.push(p);
  });
  return out;
}

// Friendly subtitle for the KPI cards (Slice 4) — reflects the active window.
const RANGE_SUBTITLE: Record<DateRange, string> = {
  all:  "All time",
  "90d": "Last 90 days",
  "30d": "Last 30 days",
  "7d":  "Last 7 days",
  custom: "Custom range",
};

function cutoffForRange(r: DateRange): string | null {
  if (r === "all" || r === "custom") return null;
  const d = new Date();
  d.setDate(d.getDate() - (r === "90d" ? 90 : r === "30d" ? 30 : 7));
  return d.toISOString().split("T")[0];
}

// Pending / Source / Group By / Movement vocabulary + shared input styling now
// live in ./transactions/transactions-filter-constants (shared with the Filters
// overlay). Group By stays a table-only sub-mode — "none" is the flat List view.

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
  /**
   * Banking→Transactions retarget — deep-link seed for the account filter.
   * When the tab is opened via `?tab=transactions&account=<id>` (e.g.
   * AccountsPerspective's "View transactions" row action), the host reads the
   * param and passes it here so the list lands pre-scoped to that account. It
   * only seeds the initial state — the filter select stays fully changeable.
   */
  initialAccountFilter?: string | null;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function SpaceTransactionsPanel({ transactions, accounts, scopeNote, moneyCtx, initialAccountFilter }: Props) {
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
  const [accountFilter, setAccountFilter] = useState<string | null>(initialAccountFilter ?? null);
  const [dateRange,     setDateRange]     = useState<DateRange>("all");
  // Custom [from, to] window (ISO YYYY-MM-DD, both optional) — only consulted
  // when dateRange === "custom".
  const [customStart,   setCustomStart]   = useState<string>("");
  const [customEnd,     setCustomEnd]     = useState<string>("");
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
  // §2.4 — top-level view switch. "table" = the list/grouped view (Group By
  // applies); "calendar" = the day heat-map over the same filtered set. One
  // control, not two — Group By is a table-only sub-mode, Calendar is a peer view.
  const [viewMode, setViewMode] = useState<"table" | "calendar">("table");
  // Redesign Slice 1 — the wall of dropdowns now lives in one on-demand overlay.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Redesign Slice 7 — client-side sort. "newest" leaves the list untouched.
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  // Table redesign follow-up — page size + current page (flat Table view only).
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [page, setPage] = useState(1);

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
      if (dateRange === "custom") {
        if (customStart && tx.date < customStart) return false;
        if (customEnd   && tx.date > customEnd)   return false;
      } else if (cutoff && tx.date < cutoff)                return false;
      if (pendingFilter === "cleared" &&  tx.pending)       return false;
      if (pendingFilter === "pending" && !tx.pending)       return false;
      if (q && !tx.merchant.toLowerCase().includes(q) && !(tx.merchantDisplayName ?? "").toLowerCase().includes(q) /* MI M6 — alias-aware */ && !(tx.description ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [transactions, catFilter, flowFilter, dispositionFilter, sourceFilter, merchantFilter, needsReviewOnly, accountFilter, cutoff, dateRange, customStart, customEnd, pendingFilter, search]);

  // ── Sort (Slice 7) ─────────────────────────────────────────────────────────
  // Reorders the RENDERED rows only. "newest" returns `filtered` unchanged (its
  // date-desc order is the pre-redesign default); every other mode sorts a copy.
  // Summary math reads `filtered` (order-independent), so totals never shift.
  const sorted = useMemo(() => {
    if (sortBy === "newest") return filtered;
    const arr = [...filtered];
    switch (sortBy) {
      case "oldest":
        arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        break;
      case "largest":
        arr.sort((a, b) => Math.abs(rowAmount(b)) - Math.abs(rowAmount(a)));
        break;
      case "smallest":
        arr.sort((a, b) => Math.abs(rowAmount(a)) - Math.abs(rowAmount(b)));
        break;
      case "merchant":
        arr.sort((a, b) =>
          (a.merchantDisplayName ?? a.merchant).localeCompare(b.merchantDisplayName ?? b.merchant),
        );
        break;
    }
    return arr;
  }, [filtered, sortBy, rowAmount]);

  // Never strand the user on a page past the end when the visible set reshuffles
  // (a new filter, a new sort, a new page size). Adjusted DURING render, not in
  // an effect — react-hooks/set-state-in-effect (this repo's eslint config)
  // flags setState-in-effect as a cascading-render risk; this is React's own
  // documented "storing information from previous renders" alternative.
  const pageResetKey = `${filtered.length}|${sortBy}|${pageSize}|${groupBy}|${viewMode}`;
  const [prevPageResetKey, setPrevPageResetKey] = useState(pageResetKey);
  if (pageResetKey !== prevPageResetKey) {
    setPrevPageResetKey(pageResetKey);
    setPage(1);
  }

  // ── Pagination (flat Table view only — see PAGE_SIZE_OPTIONS comment) ──────
  const totalPages  = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, (currentPage - 1) * pageSize + pageSize),
    [sorted, currentPage, pageSize],
  );
  const pageStart = sorted.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const pageEnd    = Math.min(currentPage * pageSize, sorted.length);

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
    for (const tx of sorted) {
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
  }, [sorted, groupBy, acctInst, acctName, flowSums, rowAmount]);

  // ── Editorial day grouping (default List view) ─────────────────────────────
  // With no explicit pivot and a chronological sort, the flat list reads as a
  // ledger: rows grouped under their day with a sticky day header (the prototype's
  // temporal spine). Amount/merchant sorts stay flat — day headers only make sense
  // in date order. Groups the CURRENT page, so pagination is unaffected.
  const chronological = sortBy === "newest" || sortBy === "oldest";
  const dayGroups = useMemo(() => {
    if (groupBy !== "none" || !chronological) return null;
    const map = new Map<string, Transaction[]>();
    for (const tx of paged) {
      const bucket = map.get(tx.date);
      if (bucket) bucket.push(tx);
      else map.set(tx.date, [tx]);
    }
    return [...map.entries()];
  }, [paged, groupBy, chronological]);

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
    setCustomStart("");
    setCustomEnd("");
    setPendingFilter("all");
  }, []);

  // Count of active filter GROUPS inside the Filters overlay — drives the
  // "Filters (N)" badge. Search, time range, view, and grouping are toolbar-level
  // concerns and are deliberately excluded (they have their own controls).
  const activeFilterCount =
    (catFilter ? 1 : 0) +
    (flowFilter ? 1 : 0) +
    (dispositionFilter ? 1 : 0) +
    (sourceFilter !== "all" ? 1 : 0) +
    (merchantFilter ? 1 : 0) +
    (needsReviewOnly ? 1 : 0) +
    (accountFilter ? 1 : 0) +
    (pendingFilter !== "all" ? 1 : 0);

  return (
    <div className="space-y-4">

      {/* ── Title + description ─────────────────────────────────────────────── */}
      <div className="px-1">
        <h2 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Transactions
        </h2>
        {scopeNote && (
          <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>{scopeNote}</p>
        )}
      </div>

      {/* ── Primary toolbar + Quick Flow ────────────────────────────────────── */}
      {/* One wrapping flex row whose `order` yields the intended hierarchy at
          each breakpoint:
            mobile  → Search · Quick Flow · Controls  (stacked, order 1·2·3)
            desktop → Search + Controls on one row, Quick Flow beneath.
          Search is the dominant affordance (~half width on desktop). */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative w-full lg:w-[52%] order-1">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }}
          />
          <input
            type="text"
            placeholder="Search transactions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search transactions"
            className={`w-full pl-10 pr-9 py-3 text-[15px] ${INPUT_BASE}`}
            style={inputStyle}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-primary)]"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Right cluster — view, time, filters, sort. */}
        <div className="w-full lg:w-auto lg:flex-1 order-3 lg:order-2 flex items-center gap-2 flex-wrap lg:flex-nowrap lg:justify-end">
          {/* Table / Calendar — a segmented control, visually distinct from the
              Time selector so the two don't compete (§2.4). */}
          <SegmentedControl
            options={[
              { id: "table", label: "List" },
              { id: "calendar", label: "Calendar" },
            ]}
            value={viewMode}
            onChange={setViewMode}
            aria-label="View mode"
          />

          {/* Time selector — presets + a Custom [from, to] window. */}
          <ToolbarMenuButton
            icon={<CalendarDays size={14} />}
            triggerLabel={DATE_RANGE_LABELS[dateRange]}
            options={(["all", "90d", "30d", "7d", "custom"] as DateRange[]).map((r) => ({ id: r, label: DATE_RANGE_LABELS[r] }))}
            value={dateRange}
            onChange={setDateRange}
            shouldCloseOnSelect={(id) => id !== "custom"}
            aria-label="Time range"
          >
            {dateRange === "custom" && (
              <div className="mt-1 pt-2 px-3 pb-1 border-t space-y-2" style={{ borderColor: "var(--border-hairline)" }}>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>From</span>
                  <input
                    type="date"
                    value={customStart}
                    max={customEnd || undefined}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className={`w-full mt-1 px-2.5 py-2 ${INPUT_BASE}`}
                    style={inputStyle}
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>To</span>
                  <input
                    type="date"
                    value={customEnd}
                    min={customStart || undefined}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className={`w-full mt-1 px-2.5 py-2 ${INPUT_BASE}`}
                    style={inputStyle}
                  />
                </label>
              </div>
            )}
          </ToolbarMenuButton>

          {/* Filters — the wall of dropdowns now lives in one grouped, on-demand
              overlay (Slice 1). All filter semantics are unchanged; only their
              location moved. The badge counts active filter groups. */}
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            className={`flex items-center gap-2 px-3 py-2.5 touch-manipulation ${INPUT_BASE}`}
            style={activeFilterCount > 0
              ? { background: "var(--surface-inset)", borderColor: "var(--accent-info)", color: "var(--text-primary)" }
              : inputStyle}
          >
            <SlidersHorizontal size={14} />
            <span>Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</span>
          </button>

          {/* Sort — pure client-side reorder of the filtered list (Slice 7). */}
          <ToolbarMenuButton
            icon={<ArrowDownUp size={14} />}
            triggerLabel={SORT_LABELS[sortBy]}
            options={(["newest", "oldest", "largest", "smallest", "merchant"] as SortBy[]).map((s) => ({ id: s, label: SORT_LABELS[s] }))}
            value={sortBy}
            onChange={setSortBy}
            aria-label="Sort transactions"
          />
        </div>

        {/* Quick Flow shortcuts — common FlowType filters as pills; they drive the
            same flowFilter state. Sits beneath the toolbar on desktop, and between
            search and the toolbar on mobile (order-2). */}
        <div className="w-full order-2 lg:order-3">
          <QuickFlowPills value={flowFilter} onChange={setFlowFilter} />
        </div>
      </div>

      {/* Filters overlay — centered dialog on desktop, bottom sheet on mobile. */}
      <TransactionsFilterOverlay
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        resultCount={filtered.length}
        activeCount={activeFilterCount}
        onClearAll={clearAll}
        catFilter={catFilter}
        setCatFilter={setCatFilter}
        flowFilter={flowFilter}
        setFlowFilter={setFlowFilter}
        accountFilter={accountFilter}
        setAccountFilter={setAccountFilter}
        dispositionFilter={dispositionFilter}
        setDispositionFilter={setDispositionFilter}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        merchantFilter={merchantFilter}
        setMerchantFilter={setMerchantFilter}
        needsReviewOnly={needsReviewOnly}
        setNeedsReviewOnly={setNeedsReviewOnly}
        pendingFilter={pendingFilter}
        setPendingFilter={setPendingFilter}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        institutionGroups={institutionGroups}
        merchantOptions={merchantOptions}
        showGrouping={viewMode === "table"}
      />

      {/* ── Active filter chips ─────────────────────────────────────────────── */}
      {/* Only rendered when a filter group is active (reduce noise). */}
      <TransactionFilterChips
        selectedAccount={selectedAccount}
        setAccountFilter={setAccountFilter}
        catFilter={catFilter}
        setCatFilter={setCatFilter}
        flowFilter={flowFilter}
        setFlowFilter={setFlowFilter}
        dispositionFilter={dispositionFilter}
        setDispositionFilter={setDispositionFilter}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        merchantFilter={merchantFilter}
        setMerchantFilter={setMerchantFilter}
        needsReviewOnly={needsReviewOnly}
        setNeedsReviewOnly={setNeedsReviewOnly}
        pendingFilter={pendingFilter}
        setPendingFilter={setPendingFilter}
        activeCount={activeFilterCount}
        onClearAll={clearAll}
        onAddFilter={() => setFiltersOpen(true)}
      />

      {/* ── Summary KPI cards (§2.3.1) ──────────────────────────────────────────
          Same shared-map math as before, re-presented as KPI cards. Zero-count
          discipline (§9.7) is preserved inside TransactionSummaryCards: a money
          card renders only when its figure > 0 — never a fabricated "$0.00".
          Spend stays net of refunds while Refund is disclosed as its own figure,
          so no dollar is double-counted; transfers / debt payments / investments
          are movements shown in neutral ink. */}
      <TransactionSummaryCards
        count={filtered.length}
        spend={totalSpend}
        income={totalIn}
        transfers={totalTransfer}
        debtPayments={totalDebtPmt}
        investments={totalInvestment}
        refunds={totalRefund}
        fmt={fmtAgg}
        rangeLabel={RANGE_SUBTITLE[dateRange]}
      />

      {/* ── Transaction list ─────────────────────────────────────────────────── */}
      {transactions.length === 0 ? (
        <div className="rounded-2xl border py-14 text-center" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-muted)" }}>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No transactions found for this Space.</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>
            Connect a bank account to start seeing transactions here.
          </p>
        </div>
      ) : (
        <>
          <DataCard padding="0" className="overflow-hidden">
            {filtered.length === 0 ? (
              <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>
                No transactions match your filters.
              </p>
            ) : viewMode === "calendar" ? (
              // §2.4 — day heat-map over the same filtered set (net in − out), the
              // amount accessor + formatter shared with the summary chips. Calendar
              // authority (TransactionsCalendarHeatmap / CalendarHeatmapGrid) preserved.
              <TransactionsCalendarHeatmap transactions={filtered} amountOf={rowAmount} fmt={fmtAgg} />
            ) : groups ? (
              // Explicit pivot (flow / merchant / account / category) — a header per
              // bucket, then its rows. Not paginated (see PAGE_SIZE_OPTIONS comment):
              // every matching row renders. Rows share the editorial TxRow.
              <div className="divide-y divide-[var(--border-hairline)]">
                {groups.map((g) => (
                  <div key={g.key}>
                    <div
                      className="flex items-center justify-between gap-2 px-4 sm:px-5 py-2.5 sticky top-0 z-10 border-b"
                      style={{ background: "color-mix(in srgb, var(--surface-muted) 88%, transparent)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
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
            ) : dayGroups ? (
              // Editorial default — the ledger grouped by DAY with sticky day headers.
              // The date lives in the header, so rows drop their own date (showDate=false).
              <div className="divide-y divide-[var(--border-hairline)]">
                {dayGroups.map(([date, rows]) => (
                  <div key={date}>
                    <div
                      className="flex items-center justify-between gap-2 px-4 sm:px-5 py-2.5 sticky top-0 z-10 border-b"
                      style={{ background: "color-mix(in srgb, var(--surface-muted) 88%, transparent)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
                    >
                      <span className="text-xs font-semibold uppercase tracking-wide truncate">{formatDayHeader(date)}</span>
                      <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>{rows.length}</span>
                    </div>
                    <div className="divide-y divide-[var(--border-hairline)]">
                      {rows.map((tx) => (
                        <TxRow
                          key={tx.id}
                          tx={tx}
                          acctName={acctName(tx.accountId)}
                          acctInst={acctInst(tx.accountId)}
                          showDate={false}
                          onOpen={() => openTransaction(tx.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              // Non-chronological sort (largest / smallest / merchant) — a flat ledger,
              // each row carrying its own date since there are no day headers.
              <div className="divide-y divide-[var(--border-hairline)]">
                {paged.map((tx) => (
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

          {/* Pagination footer — flat Table view only. Page-size choice always
              visible once there are any rows; the numbered nav only appears once
              there is more than one page. */}
          {viewMode === "table" && groupBy === "none" && sorted.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-1">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Showing {pageStart} to {pageEnd} of {sorted.length} transactions
              </p>
              <div className="flex items-center gap-3">
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      aria-label="Previous page"
                      className="flex items-center justify-center h-7 w-7 rounded-lg border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] transition-colors"
                      style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    {paginationRange(currentPage, totalPages).map((p, i) =>
                      p === "…" ? (
                        <span key={`gap-${i}`} className="px-1 text-xs" style={{ color: "var(--text-faint)" }}>…</span>
                      ) : (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPage(p)}
                          aria-current={p === currentPage ? "page" : undefined}
                          className="flex items-center justify-center h-7 min-w-7 px-1.5 rounded-lg text-xs font-semibold transition-colors"
                          style={p === currentPage
                            ? { background: "var(--meridian-400)", color: "#fff" }
                            : { color: "var(--text-secondary)" }}
                        >
                          {p}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      aria-label="Next page"
                      className="flex items-center justify-center h-7 w-7 rounded-lg border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] transition-colors"
                      style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}
                  aria-label="Transactions per page"
                  className={`px-2 py-1.5 ${INPUT_BASE}`}
                  style={inputStyle}
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n} per page</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
// One editorial ledger row at every width (the prototype thesis: no table, at any
// width — the row reflows, it does not become a spreadsheet). Merchant on top;
// category · disposition · account beneath; amount right-aligned. Transfers get a
// glyph, not a colour — moving your own money is structural, neither gain nor loss.
// A hover accent rail signals the row opens a detail. `showDate` is dropped in the
// day-grouped timeline (the day header carries the date) and kept in flat/pivot views.
// Keeps role="button" + Enter/Space for keyboard access (the shared-opener contract).
function TxRow({
  tx,
  acctName,
  acctInst,
  showDate = true,
  onOpen,
}: {
  tx:        Transaction;
  acctName:  string;
  acctInst:  string;
  showDate?: boolean;
  onOpen:    () => void;
}) {
  const isTransfer = tx.flowType === "TRANSFER";
  const isCredit   = tx.amount > 0 && !isTransfer;
  const title      = tx.merchantDisplayName ?? tx.merchant; // MI M6 — resolved name, raw fallback

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="group relative flex items-center gap-3.5 px-4 py-3.5 sm:px-5 cursor-pointer transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:bg-[var(--surface-hover)]"
    >
      {/* Hover accent rail — the affordance that this row opens a detail. */}
      <span
        aria-hidden
        className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />

      {showDate && <TransactionDate date={tx.date} />}

      {isTransfer && (
        <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0" style={{ color: "var(--text-faint)" }} />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{title}</p>
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

      <div className="shrink-0 text-right">
        <p
          className="text-sm font-bold tabular-nums"
          style={{ color: isCredit ? "var(--accent-positive)" : isTransfer ? "var(--text-secondary)" : "var(--text-primary)" }}
        >
          {isTransfer ? "" : isCredit ? "+" : "−"}{fmt(tx.amount, tx.currency ?? DEFAULT_DISPLAY_CURRENCY)}
        </p>
      </div>

      <ChevronRight
        size={15}
        aria-hidden
        className="shrink-0 -mr-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
        style={{ color: "var(--text-faint)" }}
      />
    </div>
  );
}
