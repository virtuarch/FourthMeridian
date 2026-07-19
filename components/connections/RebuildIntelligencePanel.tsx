"use client";

/**
 * components/connections/RebuildIntelligencePanel.tsx  (CONN-2B)
 *
 * The master "Rebuild Financial History" control. Users think "fix my financial
 * history," not "fix Chase item #38492" — so this selects across connections and
 * rebuilds their INTELLIGENCE together (POST /api/connections/rebuild-intelligence
 * → the one existing regenerateWealthHistoryForAccounts authority). It rebuilds
 * DERIVED intelligence from transactions that already exist; it does not
 * re-acquire data or touch balances/freshness (L3).
 *
 * Honest scope, no fake ETA: it states the span + account count it will rebuild
 * ("~4 years 8 months across 3 accounts"), never a percentage or time estimate.
 * Presentation + orchestration only — no new authority.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check } from "lucide-react";
import type { SyncConnection } from "@/lib/sync/status";
import {
  formatAvailableHistory,
  type ConnectionIntelligenceStatus,
  type AvailableHistory,
} from "@/lib/connections/intelligence";
import type { AccountLite } from "@/components/connections/ConnectionCard";

interface Props {
  connections: SyncConnection[];
  intelligence: Record<string, ConnectionIntelligenceStatus>;
  accountsByConnectionId: Record<string, AccountLite[]>;
}

function fmtRebuiltAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RebuildIntelligencePanel({ connections, intelligence, accountsByConnectionId }: Props) {
  const router = useRouter();

  // Rebuildable = has transactions to rebuild from (transactionHistory READY).
  // Importing / errored connections have nothing complete to reconstruct yet.
  const rebuildable = useMemo(
    () => connections.filter((c) => intelligence[c.id]?.transactionHistory === "READY"),
    [connections, intelligence],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The multi-account frame needs ≥2 rebuildable connections to be meaningful.
  if (rebuildable.length < 2) return null;

  const allSelected = selected.size === rebuildable.length && rebuildable.length > 0;

  const toggle = (id: string) => {
    setResult(null);
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setResult(null);
    setError(null);
    setSelected(allSelected ? new Set() : new Set(rebuildable.map((c) => c.id)));
  };

  // Scope estimate — the longest history among the selected connections (the
  // rebuild reaches back to the earliest transaction) + the total account count.
  const selectedConns = rebuildable.filter((c) => selected.has(c.id));
  const spanSource = selectedConns
    .map((c) => intelligence[c.id]?.availableHistory ?? null)
    .reduce<AvailableHistory | null>((max, h) => (h && (!max || h.months > max.months) ? h : max), null);
  const accountCount = selectedConns.reduce((n, c) => n + (accountsByConnectionId[c.id]?.length ?? 0), 0);
  const spanLabel = formatAvailableHistory(spanSource);

  const canSubmit = selected.size >= 2 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/connections/rebuild-intelligence", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ connectionIds: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Rebuild failed. Please try again.");
        return;
      }
      if (data.enabled === false) {
        setError("Financial intelligence rebuild is currently unavailable.");
        return;
      }
      setResult(
        `Rebuilt financial intelligence across ${data.accountsRebuilt} ` +
          `account${data.accountsRebuilt === 1 ? "" : "s"}.`,
      );
      setSelected(new Set());
      router.refresh(); // pull the freshly rebuilt derived data
    } catch {
      setError("Rebuild failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--border-hairline)] bg-[var(--surface-1,rgba(255,255,255,0.02))] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--text-primary)]">Rebuild Financial History</h3>
          <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
            Your transactions are already imported. Rebuild your financial timeline, trends, and insights from them.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleAll}
          className="shrink-0 text-xs font-semibold text-[var(--meridian-400)] hover:underline"
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>

      <ul className="mt-4 space-y-1">
        {rebuildable.map((c) => {
          const intel = intelligence[c.id];
          const rebuiltAt = fmtRebuiltAt(intel?.lastReconstructedAt ?? null);
          const checked = selected.has(c.id);
          return (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-2 py-2 hover:bg-[var(--surface-2,rgba(255,255,255,0.03))]">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(c.id)}
                  className="h-4 w-4 shrink-0 accent-[var(--meridian-500)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{c.institution}</span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {formatAvailableHistory(intel?.availableHistory ?? null)}
                    {rebuiltAt ? ` · Last rebuilt ${rebuiltAt}` : ""}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {selected.size >= 2 && (
        <p className="mt-3 text-xs text-[var(--text-secondary)]">
          We&rsquo;ll rebuild {spanLabel === "No historical data yet" ? "your financial intelligence" : `${spanLabel} of financial intelligence`}{" "}
          across {accountCount} account{accountCount === 1 ? "" : "s"}.
        </p>
      )}

      {error && <p className="mt-3 text-xs text-[var(--accent-negative,#f87171)]">{error}</p>}
      {result && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--accent-positive,#34d399)]">
          <Check size={14} /> {result}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--meridian-500)] px-4 py-2.5 text-sm font-semibold text-white transition-[filter,opacity] hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw size={15} className={submitting ? "animate-spin" : ""} />
        {submitting ? "Rebuilding…" : "Rebuild selected"}
      </button>
      {selected.size === 1 && (
        <span className="ml-3 text-xs text-[var(--text-muted)]">Select at least 2 connections.</span>
      )}
    </section>
  );
}
