"use client";

/**
 * components/space/widgets/accounts/AccountsLedger.tsx
 *
 * The Accounts workspace in the Fourth Meridian EDITORIAL idiom — the presentation
 * convergence of the ACCOUNTS rail tab, moving it off the collapsible management-card
 * ("account cards / table dump", the former AccountsPerspective section) onto the same
 * read-surface language as the Liquidity / Debt / Cash Flow workspaces:
 *
 *   Summary   Assets + Liabilities figures over "N accounts across M institutions"
 *             and an honest connection-health line (render-only-when-present).
 *   Ledger    Accounts GROUPED by kind (Checking / Savings / Investment / Crypto /
 *             Debt / …) as Block + Surface rows, each carrying institution, identity,
 *             a weight bar (share of assets), and a display-converted balance.
 *   Explore   Preview shows the largest accounts; "View all N accounts →" opens the
 *             full, searchable list in a LeftPanel; picking any account — in the
 *             preview or the browser — opens its detail in a RightPanel.
 *
 * ARCHITECTURE (deliberately unchanged — this is presentation only):
 *  - NO new loader. It self-fetches GET /api/spaces/[id]/accounts/detail — the SAME
 *    enriched read the former AccountsPerspective used — and falls back to the host's
 *    already-loaded `accounts` for zero-flash parity and as the honest failure mode.
 *  - Balances are display-converted with the SAME authority the section cards use
 *    (convertMoney over the workspace ConversionContext); the native amount is shown
 *    alongside when it differs. Cross-currency Assets/Liabilities totals are shown
 *    only because every member is converted to ONE target — never a naive sum of
 *    mixed currencies.
 *  - PCS-2 boundary held: this is the Space-scoped financial-OBJECT surface. It never
 *    manages credentials / sync / provider auth — those live in Connections, linked
 *    out to from the detail panel.
 *  - It COMPOSES the generic Atlas panel primitives (LeftPanel / RightPanel) — it does
 *    NOT introduce an AccountPanel / AccountManager.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Landmark, Search, CheckCircle2, AlertTriangle } from "lucide-react";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { formatCurrency } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";
import { amountOwed, creditBalance } from "@/lib/debt/balance-semantics";
import type { AccountDetailRow } from "@/app/api/spaces/[id]/accounts/detail/route";
import { Surface, Block, Figure } from "@/components/atlas/Surface";
import {
  WorkspaceLayout, LeftPanel, RightPanel, PanelHeader, PanelContent,
} from "@/components/atlas/panels";
import { ACCOUNT_TYPE_LABELS, healthChip } from "./AccountsPerspective";
import { AccountDetail } from "./AccountDetail";

/** How many accounts to show inline before folding the rest behind "View all". */
const MAX_INLINE = 6;

/** Fixed kind order for the ledger — the canonical "what this Space holds" grouping.
 *  Unknown types (should be none) are appended after, in first-seen order. */
const GROUP_ORDER = ["checking", "savings", "investment", "crypto", "debt", "other"];

/** The host's shared account shape (structural) — the instant, honest fallback. */
interface FallbackAccount {
  id:          string;
  name:        string;
  type:        string;
  institution: string;
  balance:     number;
  currency:    string;
}

/** The single display value each row and its detail panel share (never re-derived,
 *  so the two can't disagree). Mirrors the section cards' `toDisplay`. */
function toDisplay(amount: number, currency: string | null | undefined, ctx?: ConversionContext): { amount: number; estimated: boolean } {
  if (!ctx) return { amount, estimated: false };
  const c = convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx);
  // V25-FINAL-1 — an unavailable balance is EXCLUDED (0) from the ledger's
  // assets/liabilities summary, never a native magnitude; `estimated` (true on a
  // miss) rides through so the summary is disclosed as approximate/incomplete.
  return { amount: c.amount ?? 0, estimated: c.estimated };
}

interface DisplayRow {
  row:     AccountDetailRow;
  display: { amount: number; estimated: boolean };
  /** |display balance| — the magnitude used for ordering and the weight bar. */
  magnitude: number;
}

function fallbackRows(accounts: FallbackAccount[]): AccountDetailRow[] {
  return accounts.map((a) => ({
    id:                 a.id,
    spaceAccountLinkId: null,
    visibility:         "FULL" as const,
    name:               a.name,
    institution:        a.institution,
    type:               a.type,
    mask:               null,
    balance:            a.balance,
    currency:           a.currency,
    isManual:           false,
    connectionState:    null,
    importBatchCount:   0,
  }));
}

export function AccountsLedger({
  spaceId, accounts, ctx,
}: {
  spaceId:  string;
  accounts: FallbackAccount[];
  ctx?:     ConversionContext;
}) {
  const [rows,  setRows]  = useState<AccountDetailRow[] | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    fetch(`/api/spaces/${spaceId}/accounts/detail`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => { setRows(Array.isArray(data) ? data : []); setFetchFailed(false); })
      .catch(() => setFetchFailed(true));
  }, [spaceId]);

  useEffect(() => { load(); }, [load]);

  const currency = ctx?.target ?? DEFAULT_DISPLAY_CURRENCY;

  // Until the enriched detail arrives (or if it fails), render the host's list so
  // accounts are never absent — strictly no worse than the former card.
  const source = rows ?? fallbackRows(accounts);

  // One display value per account (shared by the row and its detail panel). Descending
  // by magnitude so the preview surfaces the LARGEST holdings first.
  const display: DisplayRow[] = useMemo(() => {
    return source
      .map((row) => {
        const d = toDisplay(row.balance, row.currency, ctx);
        return { row, display: d, magnitude: Math.abs(d.amount) };
      })
      .sort((a, b) => b.magnitude - a.magnitude);
  }, [source, ctx]);

  const byId = useMemo(() => new Map(display.map((d) => [d.row.id, d])), [display]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

  // Summary totals — every member is converted to ONE target, so a cross-currency
  // total is honest (never a naive sum of mixed denominations). Assets vs liabilities
  // split by kind (debt = liability); estimated taints if any member was walked back.
  const summary = useMemo(() => {
    let assets = 0, liabilities = 0, assetsEst = false, liabEst = false;
    const institutions = new Set<string>();
    for (const d of display) {
      if (d.row.institution) institutions.add(d.row.institution);
      // V25-SIDE-1 — a liability contributes what is OWED. `Math.abs` made the
      // summary count a credit balance as $124 of liability while the row above
      // it read "−$124.04" — the two disagreed on screen about the same account.
      // Both now read the canonical authority, so they cannot diverge.
      if (d.row.type === "debt") { liabilities += amountOwed(d.display.amount); liabEst ||= d.display.estimated; }
      else { assets += d.display.amount; assetsEst ||= d.display.estimated; }
    }
    const hasDebt = display.some((d) => d.row.type === "debt");
    const hasAsset = display.some((d) => d.row.type !== "debt");
    return { assets, liabilities, assetsEst, liabEst, hasDebt, hasAsset, institutions: institutions.size };
  }, [display]);

  // Connection-health summary — render-only-when-present, in ConnectionCard's language.
  const health = useMemo(() => {
    let synced = 0, attention = 0;
    for (const d of display) {
      const chip = healthChip(d.row.connectionState);
      if (chip?.tone === "positive") synced += 1;
      else if (chip?.tone === "warning") attention += 1;
    }
    return { synced, attention };
  }, [display]);

  const totalAssetsMagnitude = useMemo(
    () => display.reduce((s, d) => s + d.magnitude, 0),
    [display],
  );

  // True account count per kind — so the PREVIEW's group badge reports how many
  // accounts of that kind EXIST (e.g. "Debt 2"), never how many happen to fit in the
  // top-N slice (which would read "Debt 1" while a second liability sits below the
  // fold — confident-wrong). The full browser omits this and counts what it shows,
  // so a search result honestly reads its match count.
  const totalByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of display) m.set(d.row.type, (m.get(d.row.type) ?? 0) + 1);
    return m;
  }, [display]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return display;
    return display.filter((d) =>
      d.row.name.toLowerCase().includes(q) || d.row.institution.toLowerCase().includes(q));
  }, [display, query]);

  if (display.length === 0) {
    return (
      <div className="py-12 text-center">
        <Landmark size={26} className="mx-auto mb-2 text-[var(--text-faint)]" />
        <p className="text-sm text-[var(--text-muted)]">No accounts in this Space yet</p>
        <p className="mt-0.5 text-xs text-[var(--text-faint)]">Share accounts from the Manage panel to see them here.</p>
      </div>
    );
  }

  const inline = display.slice(0, MAX_INLINE);
  const hidden = display.length - inline.length;

  const openDetail = (id: string) => setSelectedId(id);
  // From the browser: pick → close the browser and open the detail (one panel at a time).
  const openFromBrowser = (id: string) => { setSelectedId(id); setBrowserOpen(false); };

  return (
    <WorkspaceLayout>
      <div className="space-y-8 sm:space-y-10 min-w-0">
        {fetchFailed && rows === null && (
          <button
            type="button"
            onClick={load}
            className="text-[11px] text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
          >
            Couldn&apos;t load account details — showing balances only. Retry
          </button>
        )}

        {/* ① Summary — Assets / Liabilities over the honest count + health line. */}
        <section className="flex flex-wrap items-end gap-x-10 gap-y-4">
          {summary.hasAsset && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">Assets</p>
              <Figure value={`${summary.assetsEst ? "≈ " : ""}${formatCurrency(summary.assets, currency)}`} size="figure" />
            </div>
          )}
          {summary.hasDebt && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">Liabilities</p>
              <Figure value={`${summary.liabEst ? "≈ " : ""}${formatCurrency(summary.liabilities, currency)}`} size="figure" tone="down" />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-xs text-[var(--text-muted)]">
              {display.length} account{display.length === 1 ? "" : "s"}
              {summary.institutions > 0 && ` across ${summary.institutions} institution${summary.institutions === 1 ? "" : "s"}`}
            </p>
            {(health.synced > 0 || health.attention > 0) && (
              <p className="flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
                {health.synced > 0 && (
                  <span className="inline-flex items-center gap-1" style={{ color: "var(--accent-positive)" }}>
                    <CheckCircle2 size={12} aria-hidden /> {health.synced} synced
                  </span>
                )}
                {health.attention > 0 && (
                  <span className="inline-flex items-center gap-1" style={{ color: "var(--accent-warning)" }}>
                    <AlertTriangle size={12} aria-hidden /> {health.attention} need{health.attention === 1 ? "s" : ""} attention
                  </span>
                )}
              </p>
            )}
          </div>
        </section>

        {/* ② Ledger — accounts grouped by kind; preview surfaces the largest. */}
        <Block
          label="Accounts"
          action={<span className="text-[11px] text-[var(--text-faint)]">Bar shows share of total</span>}
        >
          <Surface className="overflow-hidden">
            <GroupedRows rows={inline} countByType={totalByType} total={totalAssetsMagnitude} currency={currency} onOpen={openDetail} />
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => { setQuery(""); setBrowserOpen(true); }}
                className="flex w-full items-center justify-between border-t border-[var(--border-hairline)] px-4 py-3 text-left text-[13px] font-medium text-[var(--meridian-400)] transition-colors hover:bg-[var(--surface-hover)]"
              >
                View all {display.length} accounts
                <span aria-hidden>→</span>
              </button>
            )}
          </Surface>
        </Block>
      </div>

      {/* Full list — the searchable context surface ("everything this Space holds"). */}
      <LeftPanel open={browserOpen} onClose={() => setBrowserOpen(false)} ariaLabel="All accounts">
        <PanelHeader eyebrow="Accounts" title={`All ${display.length} accounts`} />
        <PanelContent className="px-0">
          <div className="px-5 pb-3">
            <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-2">
              <Search size={14} className="shrink-0 text-[var(--text-faint)]" aria-hidden />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search accounts"
                aria-label="Search accounts"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none"
              />
            </div>
          </div>
          {filtered.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-[var(--text-muted)]">No accounts match “{query}”.</p>
          ) : (
            <GroupedRows rows={filtered} total={totalAssetsMagnitude} currency={currency} onOpen={openFromBrowser} />
          )}
        </PanelContent>
      </LeftPanel>

      {/* Per-account detail — the drill surface, stacked above the list. */}
      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel="Account detail">
        {selected && (
          <>
            <PanelHeader
              eyebrow={selected.row.institution || (ACCOUNT_TYPE_LABELS[selected.row.type] ?? selected.row.type)}
              title={selected.row.name}
            />
            <PanelContent>
              <AccountDetail
                row={selected.row}
                display={selected.display}
                currency={currency}
                spaceId={spaceId}
                onChanged={load}
              />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </WorkspaceLayout>
  );
}

/** Rows split under their kind headings, in the canonical GROUP_ORDER. When
 *  `countByType` is supplied (the top-N preview), the group badge shows the TRUE
 *  total for that kind; otherwise (the full/searched browser) it counts what it shows. */
function GroupedRows({
  rows, total, currency, onOpen, countByType,
}: {
  rows:        DisplayRow[];
  total:       number;
  currency:    string;
  onOpen:      (id: string) => void;
  countByType?: Map<string, number>;
}) {
  const seen = Array.from(new Set(rows.map((r) => r.row.type)));
  const order = [
    ...GROUP_ORDER.filter((t) => seen.includes(t)),
    ...seen.filter((t) => !GROUP_ORDER.includes(t)),
  ];
  const groups = order
    .map((type) => ({ type, rows: rows.filter((r) => r.row.type === type) }))
    .filter((g) => g.rows.length > 0);

  return (
    <>
      {groups.map((g, gi) => (
        <div key={g.type} className={gi > 0 ? "border-t border-[var(--border-hairline)]" : ""}>
          <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">
              {ACCOUNT_TYPE_LABELS[g.type] ?? g.type}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">{countByType?.get(g.type) ?? g.rows.length}</span>
          </div>
          <div className="divide-y divide-[var(--border-hairline)]">
            {g.rows.map((d) => (
              <LedgerRow key={d.row.id} d={d} total={total} currency={currency} onOpen={() => onOpen(d.row.id)} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function LedgerRow({
  d, total, currency, onOpen,
}: {
  d:        DisplayRow;
  total:    number;
  currency: string;
  onOpen:   () => void;
}) {
  const { row } = d;
  const share = total > 0 ? d.magnitude / total : 0;
  // V25-SIDE-1 — for a LIABILITY, a negative display amount is not "a negative
  // number", it is a CREDIT the issuer owes the user. Render the meaning, not
  // the provider's sign convention, and never in the negative/problem colour.
  const isDebt = row.type === "debt";
  const credit = isDebt ? creditBalance(d.display.amount) : 0;
  const isCredit = credit > 0;
  const negative = !isCredit && d.display.amount < 0;
  const approx = d.display.estimated ? "≈ " : "";
  const foreign = row.currency !== currency;
  const chip = healthChip(row.connectionState);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex w-full items-center gap-3 overflow-hidden px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
    >
      {/* Weight bar — a 2px NEUTRAL rule on the row baseline; length = share of total. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 transition-[width] duration-500"
        style={{ width: `${share * 100}%`, background: "var(--border-hairline-strong)" }}
      />
      {/* Hover accent rail — the affordance that this row opens a detail. */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />

      <div className="relative min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">{row.name}</p>
          {row.mask && <span className="shrink-0 text-[11px] text-[var(--text-faint)]">••••{row.mask}</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {row.institution && <p className="truncate text-[11px] text-[var(--text-muted)]">{row.institution}</p>}
          {chip && row.institution && <span className="text-[var(--text-faint)]">·</span>}
          {chip && (
            <span
              className="shrink-0 text-[11px]"
              style={{ color: chip.tone === "positive" ? "var(--accent-positive)" : chip.tone === "warning" ? "var(--accent-warning)" : "var(--text-muted)" }}
            >
              {chip.label}
            </span>
          )}
        </div>
      </div>

      <div className="relative shrink-0 text-right">
        {isCredit ? (
          <p className="tabular-nums text-sm text-[var(--accent-positive)]">
            {approx}{formatCurrency(credit, currency)} credit
          </p>
        ) : (
          <p className={`tabular-nums text-sm ${negative ? "text-[var(--accent-negative)]" : "text-[var(--text-primary)]"}`}>
            {approx}{formatCurrency(d.display.amount, currency)}
          </p>
        )}
        {foreign && (
          <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">{formatCurrency(row.balance, row.currency)}</p>
        )}
      </div>
    </button>
  );
}
