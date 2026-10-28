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
 * Names and dates only — never balances (the Connections PCS-2 boundary).
 * Every sentence comes from lib/connections/connection-detail.core.ts.
 */

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Building2, ChevronDown, Wallet } from "lucide-react";
import type { SyncConnection } from "@/lib/sync/status";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";
import { summarizeConnection, relativeUpdated, type ConnectionTone } from "@/lib/connections/connection-summary";
import {
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

function Badge({ tone, children }: { tone: ConnectionTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-xs ${WORD[tone]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
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

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{children}</h3>;
}

function coverageLine(h: HistoryView): string {
  switch (h.coverage) {
    case "COMPLETE":    return h.fromISO ? `Complete from ${fmtDate(h.fromISO)}` : "Complete";
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
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({ overview: null, health: null, history: null });
  const base = useId();
  const now = new Date();
  const summary = summarizeConnection(connection, intelligence, accounts.length);
  const health = connectionHealth(connection, intelligence, now);
  const history = connectionHistory(connection, intelligence, accounts);
  const wallet = connection.provider === "WALLET";
  const walletAccount = wallet ? accounts[0] : undefined;
  const Icon = wallet ? Wallet : Building2;

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.key === tab);
    const next =
      e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length]
      : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length]
      : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next.key);
    tabRefs.current[next.key]?.focus();
  }

  return (
    <div data-connection-tabs className="flex flex-col">
      {/* Identity: the drawer header already names it; this says what it is and how it is. */}
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(125,168,255,.10)] text-[var(--meridian-400)]">
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--text-secondary)]">
            {wallet ? `${networkName(walletAccount?.walletChain) ?? "Crypto"} wallet · watch-only` : `${summary.provider} · ${summary.accountsLabel}`}
          </p>
        </div>
        <Badge tone={summary.tone}>{summary.status}</Badge>
      </div>

      <div role="tablist" aria-label="Connection detail" onKeyDown={onKey}
        className="mt-4 flex gap-1 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-1">
        {TABS.map((t) => {
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
              onClick={() => setTab(t.key)}
              className={`min-h-10 flex-1 rounded-[var(--radius-sm)] px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] ${
                selected ? "bg-[var(--surface-hover-strong)] font-medium text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {TABS.map((t) => (
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
          {t.key === "overview" && t.key === tab && (
            <>
              <Facts rows={wallet ? [
                ["Network", networkName(walletAccount?.walletChain)],
                ["Wallet", walletAccount?.walletAddress ? <span className="font-mono text-xs">{abbreviateAddress(walletAccount.walletAddress)}</span> : null],
                ["Assets tracked", nativeAssetSymbol(walletAccount?.walletChain) ? `${nativeAssetSymbol(walletAccount?.walletChain)} (native)` : null],
                ["Holdings updated", intelligence?.positionObservedAt ? relativeUpdated(intelligence.positionObservedAt, now) : "Not read yet"],
                ["History", coverageLine(history)],
              ] : [
                ["Source", summary.provider],
                ["Accounts", String(accounts.length)],
                ["Last updated", summary.updatedAt ? relativeUpdated(summary.updatedAt, now) : "Not yet"],
                ["History", coverageLine(history)],
              ]} />
              {!wallet && (
                <>
                  <SectionLabel>Accounts</SectionLabel>
                  <AccountGroups accounts={accounts} />
                </>
              )}
            </>
          )}

          {t.key === "health" && t.key === tab && (
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

          {t.key === "history" && t.key === tab && (
            <>
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{history.summary}</p>
              <div className="mt-3">
                <Facts rows={[
                  ["Earliest", history.fromISO ? fmtDate(history.fromISO) : null],
                  ["Through", history.toISO ? fmtDate(history.toISO) : null],
                  ["Last built", history.lastBuiltISO ? relativeUpdated(history.lastBuiltISO, now) : null],
                  ["Coverage", coverageLine(history)],
                ]} />
              </div>
              {history.limitations.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {history.limitations.map((x) => <li key={x} className="text-xs leading-relaxed text-[var(--text-muted)]">{x}</li>)}
                </ul>
              )}
              <div className="mt-4">{historyExtra}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
