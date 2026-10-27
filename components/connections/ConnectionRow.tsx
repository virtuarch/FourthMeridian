"use client";

/**
 * components/connections/ConnectionRow.tsx  (Connections redesign — PR 1)
 *
 * One compact row per connection: name, provider, account count, last successful
 * update and a health word — then a chevron. Clicking the row opens the
 * connection's drawer (ConnectionDetail). The ⋯ menu is a SIBLING of the row
 * button, never nested inside it, so it opens on its own and keyboard users reach
 * it as a separate tab stop.
 *
 * The row shows no reason codes, provider errors or internal ids — the summary
 * comes from lib/connections/connection-summary.ts, which reads the same state
 * authorities the drawer does. Names and counts only, never balances (PCS-2).
 */

import { Building2, ChevronRight, Wallet } from "lucide-react";
import { ConnectionMenu } from "@/components/connections/ConnectionMenu";
import { relativeUpdated, summarizeConnection, type ConnectionTone } from "@/lib/connections/connection-summary";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";
import type { SyncConnection } from "@/lib/sync/status";

const DOT: Record<ConnectionTone, string> = {
  ok:        "bg-[var(--accent-positive,#34d399)]",
  progress:  "bg-[var(--meridian-400)] animate-pulse motion-reduce:animate-none",
  attention: "bg-[var(--accent-warning,#f59e0b)]",
  neutral:   "bg-[var(--text-faint,#6b7280)]",
};

const WORD: Record<ConnectionTone, string> = {
  ok:        "text-[var(--text-secondary)]",
  progress:  "text-[var(--meridian-400)]",
  attention: "text-[var(--accent-warning,#f59e0b)]",
  neutral:   "text-[var(--text-muted)]",
};

interface Props {
  connection:    SyncConnection;
  accountCount:  number;
  intelligence?: ConnectionIntelligenceStatus;
  onOpen:        () => void;
}

export function ConnectionRow({ connection, accountCount, intelligence, onOpen }: Props) {
  const s = summarizeConnection(connection, intelligence, accountCount);
  const Icon = connection.provider === "WALLET" ? Wallet : Building2;
  const updated = s.updatedAt ? `Updated ${relativeUpdated(s.updatedAt)}` : "Not updated yet";

  return (
    <li data-connection-row={connection.state} className="flex items-center">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${connection.institution} — ${s.status}. Open details`}
        className="group relative flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] px-3.5 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
      >
        {/* Hover accent rail — the affordance that this row opens a detail. */}
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2,rgba(255,255,255,0.04))] text-[var(--text-secondary)]">
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{connection.institution}</span>
          {/* Mobile: the health word leads the second line so the name keeps the width. */}
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] sm:hidden">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s.tone]}`} />
            <span className={`shrink-0 ${WORD[s.tone]}`}>{s.status}</span>
            <span className="truncate text-[var(--text-muted)]">· {updated}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">
            {s.provider} · {s.accountsLabel}<span className="hidden sm:inline"> · {updated}</span>
          </span>
        </span>
        <span className={`hidden shrink-0 items-center gap-1.5 text-xs sm:inline-flex ${WORD[s.tone]}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[s.tone]}`} />
          {s.status}
        </span>
        <ChevronRight aria-hidden size={16} className="shrink-0 text-[var(--text-faint,#6b7280)] transition-transform group-hover:translate-x-0.5" />
      </button>
      {/* CONN-4A — the ⋯ menu, once the connection has resolved (not mid-import). */}
      <div className="w-11 shrink-0 pr-1.5 flex justify-center">
        {connection.state !== "importing" && <ConnectionMenu connection={connection} />}
      </div>
    </li>
  );
}
