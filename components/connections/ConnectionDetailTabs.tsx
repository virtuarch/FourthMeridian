"use client";

/**
 * components/connections/ConnectionDetailTabs.tsx  (Connections detail — tabbed refinement)
 *
 * The body of a selected connection: identity, then Overview · Health · History.
 * Same drawer on every size (RightPanel: docked right on desktop, a near-full
 * bottom sheet on a phone); only the information architecture is new.
 *
 *   Overview  source, counts, last update, coverage in one line, and the
 *             accounts grouped by their own type (expandable) — or, for a
 *             wallet, network, abbreviated public address and asset
 *   Health    one line per dimension (connection, balances or holdings,
 *             transactions, history, valuation), then the state's own
 *             detail and recovery actions, exactly as before
 *   History   the proven interval, import state, limitations, the lifecycle
 *             timeline and the historical-import action
 *
 * Names and dates only — never balances (the Connections PCS-2 boundary). A
 * wallet's tokens are shown by identity, price presence and history facet only —
 * never a unit count or a money value.
 * Every sentence comes from lib/connections/connection-detail.core.ts.
 */

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Building2, ChevronDown, Wallet } from "lucide-react";
import type { SyncConnection } from "@/lib/sync/status";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";
import { summarizeConnection, type ConnectionTone } from "@/lib/connections/connection-summary";
import {
  fmtDay, tokenHistoryLabel, tokenPriceText,
  groupAccounts, connectionHealth, connectionHistory, abbreviateAddress, networkName, nativeAssetSymbol,
  type HistoryView,
} from "@/lib/connections/connection-detail.core";
import { formatAccountMask } from "@/lib/accounts/display-identity";
import { DOT, WORD } from "@/components/connections/ConnectionRow";
import type { AccountLite } from "@/components/connections/ConnectionCard";

type TabKey = "overview" | "health" | "history";
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "health",   label: "Health" },
  { key: "history",  label: "History" },
];

const fmtDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function Badge({ tone, children }: { tone: ConnectionTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-xs ${WORD[tone]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

export function Facts({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  const shown = rows.filter((r): r is [string, ReactNode] => !!r && r[1] !== null && r[1] !== undefined && r[1] !== "");
  return (
    <dl className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
      {shown.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
          <dt className="shrink-0 text-xs text-[var(--text-muted)]">{k}</dt>
          <dd className="min-w-0 text-right text-sm text-[var(--text-primary)]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{children}</h3>;
}

function coverageLine(h: HistoryView): string {
  switch (h.coverage) {
    // Wallets: NATIVE scope, said so — never an unqualified "Complete".
    case "COMPLETE":    return h.blockchain && h.fromISO ? `${h.blockchain.label} verified since ${fmtDate(h.fromISO)}` : h.fromISO ? `Verified from ${fmtDate(h.fromISO)}` : "Verified";
    case "AVAILABLE":   return h.fromISO ? `Available from ${fmtDate(h.fromISO)}` : "Available";
    case "PARTIAL":     return "Incomplete";
    case "IMPORTING":   return "Importing";
    case "NOT_BUILT":   return "Not built yet";
    case "UNAVAILABLE": return "Not available";
  }
}

function AccountGroups({ accounts }: { accounts: AccountLite[] }) {
  const groups = groupAccounts(accounts);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const base = useId();
  if (groups.length === 0) return <p className="text-sm text-[var(--text-muted)]">No accounts from this connection yet.</p>;
  return (
    <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
      {groups.map((g) => {
        const isOpen = !!open[g.key];
        const listId = `${base}-${g.key}`;
        return (
          <li key={g.key} data-account-group={g.key}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={listId}
              onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
              className="flex min-h-11 w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
            >
              <span>{g.label}</span>
              <span className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                {g.accounts.length}
                <ChevronDown aria-hidden size={14} className={`transition-transform motion-reduce:transition-none ${isOpen ? "rotate-180" : ""}`} />
              </span>
            </button>
            {isOpen && (
              <ul id={listId} className="pb-1.5">
                {g.accounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-3.5 py-1.5 pl-6 text-sm">
                    <span className="min-w-0 truncate text-[var(--text-secondary)]">{a.name}</span>
                    {formatAccountMask(a.mask) && <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{formatAccountMask(a.mask)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Connections 2.0 — the tab primitive, shared by a provider connection's detail
 * and a manual asset's (ManualAssetDetail), so both drawers have the same
 * WAI-ARIA tabs, keyboard model and spacing. Only the selected panel renders.
 */
export function DetailTabs<K extends string>({ tabs, tab, onTab, label, render }: {
  tabs:   ReadonlyArray<{ key: K; label: string }>;
  tab:    K;
  onTab:  (key: K) => void;
  label:  string;
  render: (key: K) => ReactNode;
}) {
  const tabRefs = useRef<Partial<Record<K, HTMLButtonElement | null>>>({});
  const base = useId();

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.key === tab);
    const next =
      e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length]
      : e.key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length]
      : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    onTab(next.key);
    tabRefs.current[next.key]?.focus();
  }

  return (
    <>
      <div role="tablist" aria-label={label} onKeyDown={onKey}
        className="mt-4 flex gap-1 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-1">
        {tabs.map((t) => {
          const selected = t.key === tab;
          return (
            <button
              key={t.key}
              ref={(el) => { tabRefs.current[t.key] = el; }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTab(t.key)}
              className={`min-h-10 flex-1 rounded-[var(--radius-sm)] px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] ${
                selected ? "bg-[var(--surface-hover-strong)] font-medium text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`${base}-panel-${t.key}`}
          aria-labelledby={`${base}-tab-${t.key}`}
          hidden={t.key !== tab}
          tabIndex={0}
          data-connection-tab={t.key}
          className="mt-4 focus-visible:outline-none"
        >
          {t.key === tab && render(t.key)}
        </div>
      ))}
    </>
  );
}

export function ConnectionDetailTabs({ connection, accounts, intelligence, healthExtra, historyExtra }: {
  connection: SyncConnection;
  accounts: AccountLite[];
  intelligence?: ConnectionIntelligenceStatus;
  /** The state's own detail + recovery actions (stepper, reconnect, wallet refresh…). */
  healthExtra: ReactNode;
  /** Lifecycle timeline, historical import action. */
  historyExtra: ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>("overview");
  const now = new Date();
  const summary = summarizeConnection(connection, intelligence, accounts.length);
  const health = connectionHealth(connection, intelligence, now);
  const history = connectionHistory(connection, intelligence, accounts);
  const wallet = connection.provider === "WALLET";
  const walletAccount = wallet ? accounts[0] : undefined;
  const tokens = wallet ? intelligence?.walletHistory?.tokens : undefined;
  const tokenLabel = tokenHistoryLabel(walletAccount?.chain, tokens);
  const Icon = wallet ? Wallet : Building2;

  return (
    // Phone: the sheet opens near-full height so it reads as a page, not a peek.
    <div data-connection-tabs className="flex min-h-[calc(92dvh-9rem)] flex-col sm:min-h-0">
      {/* Identity: the drawer header already names it; this says what it is and how it is. */}
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(125,168,255,.10)] text-[var(--meridian-400)]">
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--text-secondary)]">
            {wallet ? `${networkName(walletAccount?.chain) ?? "Crypto"} wallet · watch-only` : `${summary.provider} · ${summary.accountsLabel}`}
          </p>
        </div>
        <Badge tone={summary.tone}>{summary.status}</Badge>
      </div>

      <DetailTabs tabs={TABS} tab={tab} onTab={setTab} label="Connection detail" render={(key) => (
        <>
          {key === "overview" && (
            <>
              <Facts rows={wallet ? [
                ["Network", networkName(walletAccount?.chain)],
                ["Wallet", walletAccount?.publicAddress ? <span className="font-mono text-xs">{abbreviateAddress(walletAccount.publicAddress)}</span> : null],
                ["Assets tracked", nativeAssetSymbol(walletAccount?.chain)
                  ? `${nativeAssetSymbol(walletAccount?.chain)} (native)${tokens?.length ? ` + ${tokens.length} token${tokens.length === 1 ? "" : "s"}` : ""}` : null],
                ["Current holdings", intelligence?.positionObservedAt ? `Updated ${fmtDay(intelligence.positionObservedAt)}` : "Not read yet"],
                ["Native history", history.blockchain && history.fromISO ? `Verified since ${fmtDay(history.fromISO)}` : coverageLine(history)],
                ["Token history", tokenLabel],
                ["Chart-ready history", history.chart ? `Since ${fmtDay(history.chart.fromISO)}` : "Not available yet"],
              ] : [
                // Source and account count are in the identity line above.
                ["Last updated", summary.updatedAt ? fmtDay(summary.updatedAt) : "Not yet"],
                ["History", coverageLine(history)],
                ["Used in", intelligence?.facts?.destinations.length ? intelligence.facts.destinations.join(", ") : null],
              ]} />
              {wallet && tokens && tokens.length > 0 && (
                <>
                  <SectionLabel>Tokens</SectionLabel>
                  <ul data-wallet-tokens className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
                    {tokens.map((t, n) => (
                      <li key={`${t.label}-${n}`} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
                        <span className="min-w-0 truncate text-sm text-[var(--text-primary)]">
                          {t.label} <span className="text-xs text-[var(--text-muted)]">{t.standard === "SPL" ? "SPL" : "ERC-20"}</span>
                        </span>
                        <span className={`shrink-0 text-right text-xs ${t.priceStatus === "MARKET_PRICE" ? "text-[var(--text-secondary)]" : WORD.neutral}`}>
                          {tokenPriceText(t.priceStatus)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!wallet && (
                <>
                  <SectionLabel>Accounts</SectionLabel>
                  <AccountGroups accounts={accounts} />
                </>
              )}
            </>
          )}

          {key === "health" && (
            <>
              <p className={`flex items-center gap-2 text-sm font-medium ${health.tone === "ok" ? "text-[var(--text-primary)]" : WORD[health.tone]}`}>
                <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[health.tone]}`} />
                {health.headline}
              </p>
              <ul className="mt-3 divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
                {health.lines.map((l) => (
                  <li key={l.key} data-health={l.key} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">{l.label}</span>
                    <span className={`flex min-w-0 items-center gap-1.5 text-right text-sm ${l.tone === "ok" ? "text-[var(--text-primary)]" : WORD[l.tone]}`}>
                      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[l.tone]}`} />
                      {l.text}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">{healthExtra}</div>
            </>
          )}

          {key === "history" && (
            <>
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{history.summary}</p>
              <div className="mt-3">
                <Facts rows={history.blockchain !== undefined ? [
                  // WALLETS — two ranges, stated separately: what the chain proves,
                  // and what the chart can actually show (balances × prices × snapshots).
                  ["Blockchain history", history.blockchain && history.fromISO
                    ? `${history.blockchain.label} verified since ${fmtDate(history.fromISO)}` : "Not verified yet"],
                  ["Verified through", history.blockchain?.toISO ? fmtDate(history.blockchain.toISO) : null],
                  ["Chart-ready history", history.chart
                    ? `USD-valued since ${fmtDate(history.chart.fromISO)} (${history.chart.days} day${history.chart.days === 1 ? "" : "s"}${history.chart.continuous ? "" : ", with gaps"})`
                    : "Not available yet"],
                  ["Chart through", history.chart ? fmtDate(history.chart.toISO) : null],
                  ["Token history", tokenLabel],
                  ["On-chain transactions", intelligence?.facts?.onChain ? `${intelligence.facts.onChain.processed.toLocaleString("en-US")} processed (${intelligence.facts.onChain.scope})` : null],
                  ["Last history update", (intelligence?.walletHistory?.historyImport?.lastProgressAtISO ?? history.lastBuiltISO) ? fmtDay(intelligence?.walletHistory?.historyImport?.lastProgressAtISO ?? history.lastBuiltISO) : null],
                ] : [
                  ["Earliest", history.fromISO ? fmtDate(history.fromISO) : null],
                  ["Through", history.toISO ? fmtDate(history.toISO) : null],
                  ["Last built", history.lastBuiltISO ? fmtDay(history.lastBuiltISO) : null],
                  ["Coverage", coverageLine(history)],
                ]} />
              </div>
              {history.tokenFacets && history.tokenFacets.length > 0 && (
                <>
                  <SectionLabel>Token history</SectionLabel>
                  {/* Each token is its OWN facet — never folded into the native range above. */}
                  <ul data-token-history className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
                    {history.tokenFacets.map((f) => (
                      <li key={f.key} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
                        <span className="shrink-0 text-xs text-[var(--text-muted)]">{f.label}</span>
                        <span className="min-w-0 text-right text-sm text-[var(--text-primary)]">{f.text}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {history.rangeNote && <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">{history.rangeNote}</p>}
              {history.limitations.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {history.limitations.map((x) => <li key={x} className="text-xs leading-relaxed text-[var(--text-muted)]">{x}</li>)}
                </ul>
              )}
              <div className="mt-4">{historyExtra}</div>
            </>
          )}
        </>
      )} />
    </div>
  );
}
