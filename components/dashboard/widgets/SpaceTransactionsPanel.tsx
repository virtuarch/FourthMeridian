"use client";

/**
 * SpaceTransactionsPanel — the Transaction EXPLORER  (TX-3.3)
 *
 * An INVESTIGATION surface: question → answer → inspect → act. Not a ledger table,
 * not a spreadsheet.
 *
 * WHAT CHANGED IN TX-3.3
 *   This panel used to receive one array of up to 5,000 rows and run a complete
 *   query engine in the browser: `filter()` for every predicate, `sort()` for every
 *   ordering, `slice()` for pagination. That made the browser the BROWSING AUTHORITY
 *   over a silently partial population — the answer looked complete and wasn't.
 *
 *   Now the SERVER answers the question:
 *     - filters + search  → validated query params (lib/data/transaction-query-core)
 *     - ordering          → server sort (newest / oldest)
 *     - paging            → KEYSET cursor + infinite scroll, never offset
 *     - "N results"       → countTransactions, built from the SAME filter
 *                           construction as the row query, so the figure cannot
 *                           drift from the list
 *   This component performs NO filtering, NO sorting, and NO slicing. If a
 *   `.filter(` or `.sort(` appears here over `rows`, the browser has quietly become
 *   the browsing authority again — there is a test that fails if it does.
 *
 * WHAT WAS DELIBERATELY REMOVED (and where it went)
 *   - Group By pivot, Calendar heat-map, per-flow-type money totals: client-derived
 *     ANALYTICS over the full array. A 100-row page cannot produce them honestly, and
 *     their semantic authority (conversion + classification doctrine) belongs to the
 *     Cash Flow projection layer, not to the explorer. TX-3 does not redesign them;
 *     they stay available on their own surfaces via their own authorities.
 *   - Numbered/offset pagination: keyset cursors page forward, not to "page 7 of 154".
 *   - Largest / Smallest / Merchant A–Z sorts: see TX3_1B_CONTRACT_HARDENING.md §2 —
 *     the product's "largest" is `Math.abs(FX-converted)`, which SQL cannot order by.
 *   - transferDisposition / needsClassification filters: derived at read time and
 *     never persisted (schema.prisma:1710,1881), so they cannot be server predicates.
 *     Deferred as a future intelligence projection.
 *
 * PRESERVED: the editorial day-grouped ledger, the detail drawer (URL-driven
 * selection via `?transaction=<id>`), the toolbar/filter/chip visual identity, and
 * the KD-15 scope note.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Account, Transaction, TransactionCategory } from "@/types";
import { DataCard } from "@/components/atlas/DataCard";
import { Search, X, SlidersHorizontal, CalendarDays, ChevronRight, ArrowDownUp, ArrowLeftRight, Loader2 } from "lucide-react";
import { ToolbarMenuButton } from "@/components/dashboard/widgets/transactions/ToolbarMenuButton";
import { QuickFlowPills } from "@/components/dashboard/widgets/transactions/QuickFlowPills";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
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
} from "@/components/dashboard/widgets/transactions/transactions-filter-constants";
import { TransactionFilterChips } from "@/components/dashboard/widgets/transactions/TransactionFilterChips";
import {
  useTransactionExplorer,
  activeFilterCount as countActiveFilters,
  type ExplorerQuery,
} from "@/components/dashboard/widgets/transactions/useTransactionExplorer";

// ── Formatters ─────────────────────────────────────────────────────────────────
// MC1 QA Q3 — itemized transaction rows pass the ROW's own currency. Explorer rows
// render NATIVE (unchanged); converted money figures are the analytics layer's job.
const fmt = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency:              cur,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));

// ── Date-range filter ─────────────────────────────────────────────────────────
type DateRange = "all" | "90d" | "30d" | "7d" | "custom";

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  all:  "All Time",
  "90d": "90 Days",
  "30d": "30 Days",
  "7d":  "7 Days",
  custom: "Custom",
};

type SortBy = "newest" | "oldest";
const SORT_LABELS: Record<SortBy, string> = { newest: "Newest", oldest: "Oldest" };

/** YYYY-MM-DD `days` before today, in UTC (matches the server's @db.Date encoding). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - days))
    .toISOString()
    .slice(0, 10);
}

/** The [from, to] the toolbar's time selector implies. */
function rangeBounds(range: DateRange, customStart: string, customEnd: string): { from: string | null; to: string | null } {
  switch (range) {
    case "7d":  return { from: isoDaysAgo(7),  to: null };
    case "30d": return { from: isoDaysAgo(30), to: null };
    case "90d": return { from: isoDaysAgo(90), to: null };
    case "custom": return { from: customStart || null, to: customEnd || null };
    case "all":
    default: return { from: null, to: null };
  }
}

// ── Day-header formatter (editorial timeline) ────────────────────────────────
// Parsed at local midnight (append T00:00:00, no trailing Z) so a YYYY-MM-DD never
// drifts a day across time zones. Presentation only.
function formatDayHeader(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

/**
 * Group the ALREADY-ORDERED server rows under their day. This is presentation only:
 * it preserves the server's sequence exactly (a Map keyed in insertion order) and
 * never reorders or filters. It is not a client query.
 */
function groupByDay(rows: Transaction[]): [string, Transaction[]][] {
  const map = new Map<string, Transaction[]>();
  for (const tx of rows) {
    const bucket = map.get(tx.date);
    if (bucket) bucket.push(tx);
    else map.set(tx.date, [tx]);
  }
  return [...map.entries()];
}

export function SpaceTransactionsPanel({
  spaceId,
  accounts,
  scopeNote,
  initialAccountFilter,
}: {
  /** The Space whose transactions this explorer queries. */
  spaceId: string;
  accounts: Account[];
  scopeNote?: string;
  /** Banking→Transactions retarget — deep-link account pre-filter. */
  initialAccountFilter?: string | null;
}) {
  const openTransaction = useOpenTransaction();

  // ── The question ─────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");           // debounced → server
  const [catFilter, setCatFilter] = useState<TransactionCategory | null>(null);
  const [flowFilter, setFlowFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");
  const [accountFilter, setAccountFilter] = useState<string | null>(initialAccountFilter ?? null);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [merchantLabel, setMerchantLabel] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Debounce the search box so a server query is not issued per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query: ExplorerQuery = useMemo(() => {
    const { from, to } = rangeBounds(dateRange, customStart, customEnd);
    return {
      text: search,
      dateFrom: from,
      dateTo: to,
      accountId: accountFilter,
      category: catFilter,
      flowType: flowFilter,
      source: sourceFilter === "all" ? null : sourceFilter,
      pending: pendingFilter === "all" ? null : pendingFilter === "pending",
      merchantId,
      sort: sortBy,
    };
  }, [search, dateRange, customStart, customEnd, accountFilter, catFilter, flowFilter, sourceFilter, pendingFilter, merchantId, sortBy]);

  // ── The answer ───────────────────────────────────────────────────────────
  const { rows, count, hasMore, loading, loadingMore, error, loadMore } =
    useTransactionExplorer(spaceId, query);

  // ── Infinite scroll (mobile-first; the same sentinel drives desktop) ──────
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); },
      { rootMargin: "600px 0px" }, // begin the next page before the user hits the end
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  // ── Account lookup helpers ───────────────────────────────────────────────
  const accountMap = useMemo(() => {
    const m = new Map<string, Account>();
    accounts.forEach((a) => m.set(a.id, a));
    return m;
  }, [accounts]);

  const acctName = useCallback((id: string) => accountMap.get(id)?.name ?? "Unknown Account", [accountMap]);
  const acctInst = useCallback((id: string) => accountMap.get(id)?.institution ?? "", [accountMap]);

  // Institution → accounts for the account filter. Built from the Space's ACCOUNTS
  // (not from the fetched rows): under server paging one page cannot enumerate the
  // Space's accounts, and the account list is already loaded and authoritative.
  const institutionGroups = useMemo(() => {
    const groups = new Map<string, Account[]>();
    accounts.forEach((a) => {
      const inst = a.institution;
      if (!groups.has(inst)) groups.set(inst, []);
      groups.get(inst)!.push(a);
    });
    return groups;
  }, [accounts]);

  const dayGroups = useMemo(() => groupByDay(rows), [rows]);

  const selectedAccount = accountFilter ? accountMap.get(accountFilter) : null;
  const activeFilterCount = countActiveFilters(query);

  const clearAll = useCallback(() => {
    setSearchInput("");
    setSearch("");
    setCatFilter(null);
    setFlowFilter(null);
    setSourceFilter("all");
    setPendingFilter("all");
    setAccountFilter(null);
    setMerchantId(null);
    setMerchantLabel(null);
    setDateRange("all");
    setCustomStart("");
    setCustomEnd("");
  }, []);

  /** The inspect→query pivot: "show me everything from this merchant". */
  const pivotToMerchant = useCallback((id: string, label: string) => {
    setMerchantId(id);
    setMerchantLabel(label);
  }, []);

  const clearMerchant = useCallback(() => {
    setMerchantId(null);
    setMerchantLabel(null);
  }, []);

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
      <div className="flex flex-wrap items-center gap-2">
        {/* Search — debounced, then answered by the server. */}
        <div className="relative w-full lg:w-[52%] order-1">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--text-muted)" }}
          />
          <input
            type="text"
            placeholder="Search transactions…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search transactions"
            className={`w-full pl-10 pr-9 py-3 text-[15px] ${INPUT_BASE}`}
            style={inputStyle}
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput("")}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-primary)]"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Right cluster — time, filters, sort. */}
        <div className="w-full lg:w-auto lg:flex-1 order-3 lg:order-2 flex items-center gap-2 flex-wrap lg:flex-nowrap lg:justify-end">
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

          {/* Sort — a SERVER ordering. Only the two date sorts exist; see the
              header note and TX3_1B_CONTRACT_HARDENING.md §2. */}
          <ToolbarMenuButton
            icon={<ArrowDownUp size={14} />}
            triggerLabel={SORT_LABELS[sortBy]}
            options={(["newest", "oldest"] as SortBy[]).map((s) => ({ id: s, label: SORT_LABELS[s] }))}
            value={sortBy}
            onChange={setSortBy}
            aria-label="Sort transactions"
          />
        </div>

        <div className="w-full order-2 lg:order-3">
          <QuickFlowPills value={flowFilter} onChange={setFlowFilter} />
        </div>
      </div>

      {/* Filters overlay — every control here is a server query param. */}
      <TransactionsFilterOverlay
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        resultCount={count ?? rows.length}
        activeCount={activeFilterCount}
        onClearAll={clearAll}
        catFilter={catFilter}
        setCatFilter={setCatFilter}
        flowFilter={flowFilter}
        setFlowFilter={setFlowFilter}
        accountFilter={accountFilter}
        setAccountFilter={setAccountFilter}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        pendingFilter={pendingFilter}
        setPendingFilter={setPendingFilter}
        institutionGroups={institutionGroups}
      />

      {/* ── Active filter chips ─────────────────────────────────────────────── */}
      <TransactionFilterChips
        selectedAccount={selectedAccount}
        setAccountFilter={setAccountFilter}
        catFilter={catFilter}
        setCatFilter={setCatFilter}
        flowFilter={flowFilter}
        setFlowFilter={setFlowFilter}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        merchantLabel={merchantLabel}
        onClearMerchant={clearMerchant}
        pendingFilter={pendingFilter}
        setPendingFilter={setPendingFilter}
        activeCount={activeFilterCount}
        onClearAll={clearAll}
        onAddFilter={() => setFiltersOpen(true)}
      />

      {/* ── The answer's size ───────────────────────────────────────────────────
          `count` is the server's exact count for THIS question, built from the same
          filter construction as the rows — so it cannot drift from the list as it
          scrolls. It is a count, not a money figure: converted totals are the Cash
          Flow projection layer's authority, not the explorer's. */}
      {!loading && count !== null && (
        <p className="px-1 text-xs" style={{ color: "var(--text-muted)" }}>
          {count.toLocaleString()} {count === 1 ? "transaction" : "transactions"}
          {rows.length < count ? ` · showing ${rows.length.toLocaleString()}` : ""}
        </p>
      )}

      {/* ── Transaction list ─────────────────────────────────────────────────── */}
      <DataCard padding="0" className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={18} className="animate-spin" style={{ color: "var(--text-faint)" }} />
          </div>
        ) : error ? (
          <p className="text-sm text-center py-10" style={{ color: "var(--text-muted)" }}>{error}</p>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {activeFilterCount > 0 || search ? "No transactions match your filters." : "No transactions found for this Space."}
            </p>
            {activeFilterCount === 0 && !search && (
              <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>
                Connect a bank account to start seeing transactions here.
              </p>
            )}
          </div>
        ) : (
          // The editorial ledger, grouped by DAY with sticky day headers. The date
          // lives in the header, so rows drop their own date (showDate=false).
          <div className="divide-y divide-[var(--border-hairline)]">
            {dayGroups.map(([date, dayRows]) => (
              <div key={date}>
                <div
                  className="flex items-center justify-between gap-2 px-4 sm:px-5 py-2.5 sticky top-0 z-10 border-b"
                  style={{ background: "color-mix(in srgb, var(--surface-muted) 88%, transparent)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
                >
                  <span className="text-xs font-semibold uppercase tracking-wide truncate">{formatDayHeader(date)}</span>
                  <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>{dayRows.length}</span>
                </div>
                <div className="divide-y divide-[var(--border-hairline)]">
                  {dayRows.map((tx) => (
                    <TxRow
                      key={tx.id}
                      tx={tx}
                      acctName={acctName(tx.accountId)}
                      acctInst={acctInst(tx.accountId)}
                      showDate={false}
                      onOpen={() => openTransaction(tx.id)}
                      onPivotMerchant={pivotToMerchant}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </DataCard>

      {/* ── Continuation ────────────────────────────────────────────────────────
          Infinite scroll via the sentinel; the button is the accessible, explicit
          fallback (and what keyboard users reach). Keyset paging goes forward only —
          there is no "page 7 of 154" to jump to, by design. */}
      {!loading && hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm ${INPUT_BASE}`}
            style={inputStyle}
          >
            {loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
// One editorial ledger row at every width (the prototype thesis: no table, at any
// width — the row reflows, it does not become a spreadsheet). Merchant on top;
// category · disposition · account beneath; amount right-aligned. Transfers get a
// glyph, not a colour — moving your own money is structural, neither gain nor loss.
// Keeps role="button" + Enter/Space for keyboard access (the shared-opener contract).
function TxRow({
  tx,
  acctName,
  acctInst,
  showDate = true,
  onOpen,
  onPivotMerchant,
}: {
  tx:        Transaction;
  acctName:  string;
  acctInst:  string;
  showDate?: boolean;
  onOpen:    () => void;
  /** TX-3.3 — the inspect→query pivot, enabled by the merchantId the DTO now carries. */
  onPivotMerchant?: (merchantId: string, label: string) => void;
}) {
  const isTransfer = tx.flowType === "TRANSFER";
  const isCredit   = tx.amount > 0 && !isTransfer;
  const title      = tx.merchantDisplayName ?? tx.merchant; // MI M6 — resolved name, raw fallback
  const canPivot   = !!tx.merchantId && !!onPivotMerchant;

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
          {/* The investigation loop: inspect a row, then re-ask the question scoped
              to its merchant. Stops propagation so it never opens the drawer. */}
          {canPivot && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPivotMerchant!(tx.merchantId!, title); }}
              className="text-xs underline underline-offset-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
              style={{ color: "var(--text-muted)" }}
            >
              More from this merchant
            </button>
          )}
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
