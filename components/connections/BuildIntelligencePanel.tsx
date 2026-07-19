"use client";

/**
 * components/connections/BuildIntelligencePanel.tsx  (CONN-2B)
 *
 * The RECOVERY control — "Restore Financial Intelligence". This is a safety valve,
 * NOT the front door: intelligence is built automatically and completely at
 * connect (backgroundHistorySync A9 over the max-available window). This tool
 * exists only for when derived intelligence needs to be RESTORED — a failed
 * reconstruction, a corrupted projection, a migration, or operator/support
 * recovery. So it is presented as a de-emphasized, collapsed "Advanced" affordance,
 * never a primary CTA next to every account.
 *
 * When invoked it restores across connections together (POST
 * /api/connections/build-intelligence → the one existing
 * regenerateWealthHistoryForAccounts authority — the SAME authority + window the
 * automatic initial build uses). It restores DERIVED intelligence from
 * transactions that already exist; it does not re-acquire data or touch balances/
 * freshness (L3). Honest scope, no fake ETA — span + account count, never a %.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check, Wrench, ChevronDown } from "lucide-react";
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

export function BuildIntelligencePanel({ connections, intelligence, accountsByConnectionId }: Props) {
  const router = useRouter();

  // Rebuildable = has transactions to rebuild from (transactionHistory READY).
  // Importing / errored connections have nothing complete to reconstruct yet.
  const rebuildable = useMemo(
    () => connections.filter((c) => intelligence[c.id]?.transactionHistory === "READY"),
    [connections, intelligence],
  );

  const [open, setOpen] = useState(false); // recovery tool — collapsed by default
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The multi-account frame needs ≥2 restorable connections to be meaningful.
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
      const res = await fetch("/api/connections/build-intelligence", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ connectionIds: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Couldn’t build financial intelligence. Please try again.");
        return;
      }
      if (data.enabled === false) {
        setError("Building financial intelligence is currently unavailable.");
        return;
      }
      setResult(
        `Financial intelligence ready for ${data.accountsRebuilt} ` +
          `account${data.accountsRebuilt === 1 ? "" : "s"}.`,
      );
      setSelected(new Set());
      router.refresh(); // pull the freshly built derived data
    } catch {
      setError("Couldn’t build financial intelligence. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--border-hairline)]">
      {/* De-emphasized recovery affordance — collapsed by default, never a primary
          CTA. Intelligence is built automatically at connect; this is the safety
          valve for when it needs restoring. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
          <Wrench size={15} className="text-[var(--text-muted)]" />
          Financial intelligence tools
        </span>
        <ChevronDown size={16} className={`text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {!open ? null : (
      <div className="border-t border-[var(--border-hairline)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Restore Financial Intelligence</h3>
          <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
            Intelligence is built automatically when you connect. If your financial profile needs repair, restore your wealth timeline, cash flow, and insights from your existing transactions.
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
                    {rebuiltAt ? ` · Built ${rebuiltAt}` : ""}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {selected.size >= 2 && (
        <p className="mt-3 text-xs text-[var(--text-secondary)]">
          We&rsquo;ll restore {spanLabel === "No historical data yet" ? "your financial intelligence" : `${spanLabel} of financial intelligence`}{" "}
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
        className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-2,rgba(255,255,255,0.03))] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw size={15} className={submitting ? "animate-spin" : ""} />
        {submitting ? "Restoring…" : "Restore selected intelligence"}
      </button>
      {selected.size === 1 && (
        <span className="ml-3 text-xs text-[var(--text-muted)]">Select at least 2 connections.</span>
      )}
      </div>
      )}
    </section>
  );
}
