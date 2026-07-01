"use client";

/**
 * components/admin/ProviderDiagnosticsDrawer.tsx
 *
 * Read-only diagnostics drawer for a single PlaidItem.
 * Opened from the Admin Providers table via the "Diagnostics" button.
 *
 * Fetches from POST /api/admin/plaid/diagnostics on open (not on page load)
 * so the table renders instantly and we only pay the query cost for the row
 * an admin actually expands.
 *
 * No mutations. No Plaid API calls. Admin-only (the endpoint enforces this).
 *
 * Async data pattern: the effect body never calls setState synchronously —
 * all state updates happen inside .then() / .catch() callbacks. Manual
 * refresh resets state in a click handler (batched by React, not in an
 * effect), then increments loadId which re-triggers the effect.
 */

import { useEffect, useState } from "react";
import { X, ChevronDown, ChevronUp, AlertCircle, CheckCircle2, Clock, Database } from "lucide-react";
import type { DiagnosticsResponse, DiagnosticsAccount } from "@/app/api/admin/plaid/diagnostics/route";

// ── Formatting helpers ────────────────────────────────────────────────────────
//
// Diagnostics are intentionally non-financial / operational only. No currency
// formatting helper exists because raw financial values (balances, transaction
// amounts) are never rendered in this drawer.

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// ── Status pill ───────────────────────────────────────────────────────────────

const STATUS_PILL: Record<string, string> = {
  ACTIVE:       "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  NEEDS_REAUTH: "bg-amber-500/10  text-amber-400  border-amber-500/20",
  ERROR:        "bg-red-500/15    text-red-400    border-red-500/20",
  REVOKED:      "bg-gray-700/60   text-gray-400   border-gray-600/40",
};

function StatusPill({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-500 text-xs">—</span>;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_PILL[value] ?? STATUS_PILL.ACTIVE}`}>
      {value}
    </span>
  );
}

// ── Field row ─────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-gray-800/60 last:border-0">
      <span className="w-44 shrink-0 text-xs text-gray-500">{label}</span>
      <span className="text-xs text-gray-200 font-mono break-all">{children}</span>
    </div>
  );
}

// ── Account card ─────────────────────────────────────────────────────────────

function AccountCard({ acct }: { acct: DiagnosticsAccount }) {
  const [open, setOpen] = useState(true);

  const displayLabel = acct.displayName ?? acct.officialName ?? acct.name;
  const typeLabel    = acct.type.charAt(0).toUpperCase() + acct.type.slice(1);

  return (
    <div className={`rounded-xl border ${acct.isArchived ? "border-gray-700/40 bg-gray-800/20" : "border-gray-700/60 bg-gray-800/40"}`}>
      {/* Card header — always visible */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <p className={`text-sm font-medium truncate ${acct.isArchived ? "text-gray-500" : "text-white"}`}>
              {displayLabel}
              {acct.mask && <span className="ml-1.5 text-gray-500">••{acct.mask}</span>}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {typeLabel}
              {acct.isArchived && (
                <span className="ml-2 text-amber-500/80 font-medium">ARCHIVED</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-2">
          {open
            ? <ChevronUp size={14} className="text-gray-500" />
            : <ChevronDown size={14} className="text-gray-500" />}
        </div>
      </button>

      {/* Card body — expanded */}
      {open && (
        <div className="px-4 pb-3 border-t border-gray-700/40">
          <div className="mt-2 space-y-0">
            <Field label="FinancialAccount ID">{acct.id}</Field>
            <Field label="Sync status">{acct.syncStatus ?? "—"}</Field>
            <Field label="SAL status">
              <StatusPill value={acct.salStatus} />
            </Field>
            <Field label="Connection status">
              <StatusPill value={acct.connectionStatus} />
            </Field>
            <Field label="Transactions">
              {acct.txCount.toLocaleString()} total · {acct.pendingCount.toLocaleString()} pending
            </Field>
            <Field label="Oldest tx">{fmtDate(acct.oldestTxDate)}</Field>
            <Field label="Newest tx">{fmtDate(acct.newestTxDate)}</Field>
            <Field label="officialName">{acct.officialName ?? "—"}</Field>
            <Field label="displayName">{acct.displayName ?? "—"}</Field>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main drawer component ─────────────────────────────────────────────────────

interface Props {
  plaidItemId:     string;
  institutionName: string;
  onClose:         () => void;
}

export function ProviderDiagnosticsDrawer({ plaidItemId, institutionName, onClose }: Props) {
  // loadId increments on manual refresh; included in the effect dep array
  // so the effect re-runs. State is reset in the click handler (not the
  // effect) to keep all synchronous setState calls out of the effect body.
  const [loadId,  setLoadId]  = useState(0);
  const [loading, setLoading] = useState(true);
  const [data,    setData]    = useState<DiagnosticsResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Fetch diagnostics — all setState calls are inside async .then()/.catch()
  // so the effect body itself never calls setState synchronously.
  useEffect(() => {
    let alive = true;

    fetch("/api/admin/plaid/diagnostics", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ plaidItemId }),
    })
      .then((res) => {
        if (!res.ok) {
          return res
            .json()
            .catch(() => ({}))
            .then((d: { error?: string }) =>
              Promise.reject(new Error(d.error ?? `HTTP ${res.status}`))
            );
        }
        return res.json() as Promise<DiagnosticsResponse>;
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to load diagnostics");
        setLoading(false);
      });

    return () => { alive = false; };
  }, [plaidItemId, loadId]);

  // Refresh button handler — setState here is in an event handler, not an
  // effect, so no lint concern. React batches all four updates.
  function handleRefresh() {
    setLoading(true);
    setData(null);
    setError(null);
    setLoadId((n) => n + 1);
  }

  return (
    <div className="fixed inset-0 z-[100] flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div className="relative w-full sm:max-w-xl bg-gray-950 border-l border-gray-800 shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <Database size={16} className="text-gray-400" />
            <div>
              <p className="text-sm font-semibold text-white">{institutionName}</p>
              <p className="text-xs text-gray-500">Provider diagnostics</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors p-1 rounded"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* Loading */}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-8 justify-center">
              <Clock size={14} className="animate-pulse" />
              Loading diagnostics…
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Data */}
          {!loading && data && (
            <>
              {/* ── PlaidItem section ── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  PlaidItem
                </h3>
                <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-4 py-2">
                  <Field label="Internal ID">{data.id}</Field>
                  <Field label="Plaid item_id">{data.externalItemId}</Field>
                  <Field label="Institution">{data.institutionName}</Field>
                  <Field label="Institution ID">{data.institutionId}</Field>
                  <Field label="User ID">{data.userId}</Field>
                  <Field label="Status"><StatusPill value={data.status} /></Field>
                  {data.errorCode && (
                    <Field label="Error code">
                      <span className="text-red-400">{data.errorCode}</span>
                    </Field>
                  )}
                  <Field label="Cursor">
                    {data.hasCursor ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 size={11} />
                        Present (synced)
                      </span>
                    ) : (
                      <span className="text-amber-400">null — first sync not yet completed</span>
                    )}
                  </Field>
                  <Field label="Last synced">{fmtDateTime(data.lastSyncedAt)}</Field>
                  <Field label="Last manual refresh">{fmtDateTime(data.lastManualRefreshAt)}</Field>
                  <Field label="Connected">{fmtDateTime(data.createdAt)}</Field>
                </div>
              </section>

              {/* ── Linked accounts section ── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  Linked accounts ({data.accounts.length})
                </h3>

                {data.accounts.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-6">
                    No live AccountConnection rows for this item.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {data.accounts.map((acct) => (
                      <AccountCard key={acct.id} acct={acct} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-gray-800 px-5 py-3 flex items-center justify-between">
          <p className="text-xs text-gray-600">Read-only · No mutations</p>
          <button
            onClick={handleRefresh}
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
