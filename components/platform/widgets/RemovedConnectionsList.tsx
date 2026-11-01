"use client";

/**
 * components/platform/widgets/RemovedConnectionsList.tsx  (PB-5)
 *
 * The "Removed" tab of Platform Ops → Providers → Connections: one row per
 * removed Plaid item or wallet connection — source, accounts, owner, removed at,
 * removed by, Plaid outcome — with server-side filters (owner, provider,
 * outcome) and paging, over GET /api/platform/platform-ops/removed-connections.
 *
 * OWNER — the opaque reference the diagnostics list already shows, and, ONLY
 * when the viewer also holds CUSTOMER_SUCCESS READ, the owner's display label
 * resolved through the connection-owners route (OwnerResolution — the
 * connection-health table's exact seam, owner decision D4). A 403 there leaves
 * the opaque reference; it never widens it.
 *
 * RETRY — an owed Plaid cleanup offers "Retry cleanup", which POSTs to the
 * EXISTING provider-cleanup route (requireFreshPlatformAccess WRITE, marker
 * re-read). The verdict shown afterwards is the server's, then the list is
 * re-read; nothing here infers success.
 */

import { useState } from "react";
import { RotateCw } from "lucide-react";
import { WidgetMessage, timeAgo } from "@/components/platform/widget-kit";
import { useKeyedFetch } from "@/components/platform/keyed-fetch";
import { OwnerResolution } from "./connection-health-table";
import type { RemovedConnectionsResponse } from "@/app/api/platform/platform-ops/removed-connections/route";
import type { ProviderCleanupRetryResponse } from "@/app/api/platform/platform-ops/provider-cleanup/route";
import { REMOVED_OUTCOMES, REMOVED_PROVIDERS, type RemovedConnectionRow, type RemovedOutcome, type RemovedProvider } from "@/lib/platform/connections/removed-connections.core";
import {
  EMPTY_FILTERS, PROVIDER_CLEANUP_RETRY_ROUTE, REMOVED_LIST_PAGE_SIZE,
  outcomeLabel, outcomeTone, ownerLookupRows, ownerTokenOf, removalReasonLabel, removedByLabel, removedConnectionsUrl,
  type RemovedFilters,
} from "./removed-connections-view";
import { FIELD } from "./policy-editor-kit";

/** UI-001 — what a READ holder sees instead of a Retry button that would 403. */
export const REMOVED_RETRY_READ_ONLY_LINE = "Read-only — retrying a provider cleanup needs WRITE access to Platform Operations.";

const TONE_CLASS: Record<ReturnType<typeof outcomeTone>, string> = {
  danger: "text-[var(--accent-danger)]",
  ok:     "text-[var(--accent-success)]",
  muted:  "text-[var(--text-muted)]",
};

function Row({ row, owner, canWrite, busy, verdict, onRetry, onOwner }: {
  row: RemovedConnectionRow;
  owner: string | undefined;
  canWrite: boolean;
  busy: boolean;
  verdict: string | undefined;
  onRetry: () => void;
  onOwner: (token: string) => void;
}) {
  const token = ownerTokenOf(row.ownerRef);
  const reason = removalReasonLabel(row.removedBy);
  return (
    <li className="flex flex-col gap-1 py-2" data-removed-row={row.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words text-xs text-[var(--text-primary)]">
          {row.source}
          <span className="text-[var(--text-muted)]"> · {row.provider === "WALLET" ? "Wallet" : "Plaid"} · {row.accountCount} account{row.accountCount === 1 ? "" : "s"}</span>
        </span>
        <span className={`shrink-0 text-[11px] ${TONE_CLASS[outcomeTone(row.outcome)]}`}>{outcomeLabel(row.outcome)}</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
        <span>
          Owner{" "}
          {token ? (
            <button type="button" onClick={() => onOwner(token)} className="text-[var(--text-primary)] underline-offset-2 hover:underline" title="Filter by this owner">
              {owner ?? row.ownerRef}
            </button>
          ) : <span className="text-[var(--text-primary)]">{owner ?? row.ownerRef}</span>}
        </span>
        <span>Removed {row.removedAtISO ? `${timeAgo(row.removedAtISO)} ago` : "—"}</span>
        <span className="text-[var(--text-primary)]">{removedByLabel(row.removedBy)}</span>
        {reason && <span>reason {reason}</span>}
        {row.relinked && <span>re-linked since</span>}
        {row.cleanup && row.cleanup.attemptCount > 0 && <span>{row.cleanup.attemptCount} unconfirmed attempt{row.cleanup.attemptCount === 1 ? "" : "s"}</span>}
        {row.cleanup?.inProgress && <span className="text-[var(--text-primary)]" data-in-progress>removal in progress</span>}
        {row.cleanup?.latestErrorCode && <span>last code <span className="text-[var(--text-primary)]">{row.cleanup.latestErrorCode}</span></span>}
      </div>
      {row.retryEligible && (
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-[var(--text-muted)]">{row.id}</span>
          {!canWrite && <span className="text-[10px] text-[var(--text-muted)]" data-read-only-line>{REMOVED_RETRY_READ_ONLY_LINE}</span>}
          {canWrite && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-primary)] disabled:opacity-50"
            >
              <RotateCw size={11} /> {busy ? "Retrying…" : "Retry cleanup"}
            </button>
          )}
          {verdict && <span className="text-[11px] text-[var(--text-muted)]">{verdict}</span>}
        </div>
      )}
    </li>
  );
}

export function RemovedConnectionsList({ canWrite, refreshKey = 0 }: { canWrite: boolean; refreshKey?: number }) {
  const [filters, setFilters] = useState<RemovedFilters>(EMPTY_FILTERS);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Record<string, string>>({});
  const { data, loading, error } = useKeyedFetch<RemovedConnectionsResponse>(removedConnectionsUrl(filters, nonce + refreshKey));

  const set = (patch: Partial<RemovedFilters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));

  async function retry(plaidItemId: string) {
    setBusy(plaidItemId);
    try {
      const res = await fetch(PROVIDER_CLEANUP_RETRY_ROUTE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ plaidItemId }),
      });
      const body = (await res.json().catch(() => null)) as ProviderCleanupRetryResponse | null;
      // The server's marker re-read is the verdict — never the HTTP status.
      setVerdict((v) => ({ ...v, [plaidItemId]: body?.confirmed ? "Confirmed" : body?.skipped === "ITEM_GONE" ? "Item gone" : body?.skipped === "IN_PROGRESS" ? "Removal in progress" : "Still owed" }));
      setNonce((n) => n + 1);
    } catch {
      setVerdict((v) => ({ ...v, [plaidItemId]: "Retry failed" }));
    } finally {
      setBusy(null);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / REMOVED_LIST_PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter removed connections">
        <select aria-label="Provider" className={FIELD} value={filters.provider} onChange={(e) => set({ provider: e.target.value as RemovedProvider | "" })}>
          <option value="">All providers</option>
          {REMOVED_PROVIDERS.map((p) => <option key={p} value={p}>{p === "WALLET" ? "Wallet" : "Plaid"}</option>)}
        </select>
        <select aria-label="Outcome" className={FIELD} value={filters.outcome} onChange={(e) => set({ outcome: e.target.value as RemovedOutcome | "" })}>
          <option value="">All outcomes</option>
          {REMOVED_OUTCOMES.map((o) => <option key={o} value={o}>{outcomeLabel(o)}</option>)}
        </select>
        {filters.owner && (
          <button type="button" className="text-[11px] text-[var(--text-secondary)] underline" onClick={() => set({ owner: "" })}>
            Owner …{filters.owner} ✕
          </button>
        )}
      </div>

      <WidgetMessage loading={loading && !data} error={error} />
      {data && (
        <>
          <p className="text-[11px] text-[var(--text-muted)]" data-removed-totals>
            {data.totals.all} removed · cleanup owed {data.cleanup.owedCount} · confirmed removals {data.cleanup.confirmedCount}
          </p>
          {data.rows.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">No removed connections match.</p>
          ) : (
            <OwnerResolution rows={ownerLookupRows(data.rows)}>
              {(owners) => (
                <ul className="-mx-1 divide-y divide-[var(--border-hairline)] px-1">
                  {data.rows.map((r) => (
                    <Row
                      key={`${r.provider}:${r.id}`}
                      row={r}
                      owner={owners?.get(`${r.provider}:${r.id}`)}
                      canWrite={canWrite}
                      busy={busy === r.id}
                      verdict={verdict[r.id]}
                      onRetry={() => retry(r.id)}
                      onOwner={(token) => set({ owner: token })}
                    />
                  ))}
                </ul>
              )}
            </OwnerResolution>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <button type="button" disabled={filters.page <= 1} onClick={() => set({ page: filters.page - 1 })} className="disabled:opacity-40">Previous</button>
              <span>Page {filters.page} of {pages} · {data.total} match</span>
              <button type="button" disabled={filters.page >= pages} onClick={() => set({ page: filters.page + 1 })} className="disabled:opacity-40">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
