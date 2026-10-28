"use client";

/**
 * components/connections/ConnectionTimeline.tsx  (CONN-2D → "everything should be honest", 2026-10-28)
 *
 * The "Connection details" accordion. It used to be a generic checklist —
 * "Transactions available", "Wealth timeline built", "Cash flow available",
 * "Last updated Today" — whose booleans did not say WHAT, HOW MANY or WHERE, and
 * which told a crypto wallet it had Cash Flow. It is now a short list of
 * connection-specific FACTS, each read from its own persisted authority
 * (ConnectionIntelligenceStatus.facts / walletHistory, space-data.ts):
 *
 *   Bank    Connected <date> · Transactions imported <n, range> (the banking
 *           population — the rows Transactions/Cash Flow/Spending read) ·
 *           Balances updated <date> · Net Worth history built <date> · Used in
 *   Wallet  Watching since <date> · On-chain transactions processed <n (scope)> ·
 *           Current holdings updated <date> · Used in
 *
 * A fact with no persisted value is not shown. No checkmarks: a fact is a fact.
 * Absolute dates only (relative ones go stale on a page left open).
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";
import { fmtDay } from "@/lib/connections/connection-detail.core";

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

export function ConnectionTimeline({ intelligence, provider }: { intelligence: ConnectionIntelligenceStatus; provider: "PLAID" | "WALLET" | string }) {
  const [open, setOpen] = useState(false);
  const f = intelligence.facts;
  const wallet = provider === "WALLET";
  const tx = f?.bankTransactions ?? null;
  const range = tx && tx.fromISO && tx.toISO ? ` · ${fmtDay(tx.fromISO)} – ${fmtDay(tx.toISO)}` : "";

  const rows: Array<[string, string | null]> = wallet ? [
    ["Watching since", fmtDay(intelligence.connectedAt)],
    ["On-chain transactions", f?.onChain ? `${f.onChain.processed.toLocaleString("en-US")} processed (${f.onChain.scope})` : null],
    ["Current holdings updated", fmtDay(intelligence.positionObservedAt)],
    ["Used in", f?.destinations.length ? f.destinations.join(", ") : null],
  ] : [
    ["Connected", fmtDay(intelligence.connectedAt)],
    ["Transactions imported", tx ? `${tx.count.toLocaleString("en-US")}${range}` : null],
    ["Balances updated", fmtDay(intelligence.balancesUpdatedAt)],
    ["Net Worth history built", intelligence.intelligenceReady ? fmtDay(intelligence.lastReconstructedAt) : null],
    ["Used in", f?.destinations.length ? f.destinations.join(", ") : null],
  ];
  if (!rows.some(([, v]) => v)) return null;

  return (
    <div className="mt-4 border-t border-[var(--border-hairline)] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      >
        <span>Connection details</span>
        <ChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <dl className="mt-2 divide-y divide-[var(--border-hairline)]">
          {rows.map(([label, value]) => <Row key={label} label={label} value={value} />)}
        </dl>
      )}
    </div>
  );
}
