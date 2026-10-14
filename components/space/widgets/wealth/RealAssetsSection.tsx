"use client";

/**
 * components/space/widgets/wealth/RealAssetsSection.tsx   (RWA-1)
 *
 * Net Worth → Assets → "Real assets": the manual assets in this Space (a home,
 * a vehicle, jewelry, a collection), each labelled as the user's ESTIMATE, with
 * Add asset, Update value and Archive.
 *
 * ── Why it reads the accounts DETAIL route, not the shared SpaceAccount list ──
 * GET /api/spaces/[id]/accounts/detail is the management-shaped read that the
 * Accounts tab already uses: membership-gated, RLS-scoped, and privacy-reduced
 * by the same normalizer as every other Space read. It is the one read that
 * says which rows are user estimates (`isUserEstimate`) and which the VIEWER may
 * manage (`canManage` = owner AND manual — the write routes' own gate). Reading
 * it means this section adds no second visibility rule and widens no shared type.
 * BALANCE_ONLY rows are never listed here: an aggregate is not one asset, and
 * naming it would disclose what that tier withholds.
 *
 * ── After a write ─────────────────────────────────────────────────────────────
 * The routes regenerate today's snapshot; this section then re-reads itself and
 * fires SPACE_DATA_REFRESHED_EVENT for this Space, which re-runs the host's
 * accounts + snapshot fetches — the same nonce a manual sync uses — so the hero,
 * the chart and the composition move with the card.
 */

import { useCallback, useEffect, useState } from "react";
import { Archive, Loader2, PencilLine, Plus } from "lucide-react";
import type { AccountDetailRow } from "@/app/api/spaces/[id]/accounts/detail/route";
import { formatCurrency } from "@/lib/currency";
import { ESTIMATE_DISCLOSURE, estimateCaption } from "@/lib/assets/manual-asset";
import { SPACE_DATA_REFRESHED_EVENT } from "@/lib/space-nav";
import { GlassButton } from "@/components/atlas/GlassButton";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { AddManualAssetModal } from "@/components/dashboard/AddManualAssetModal";
import { UpdateAssetValueModal } from "./UpdateAssetValueModal";

/** The rows this section lists: FULL, user-estimate rows only. Exported for the test. */
export function selectRealAssetRows(rows: AccountDetailRow[]): AccountDetailRow[] {
  return rows
    .filter((r) => r.visibility === "FULL" && r.isUserEstimate)
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

type LoadState = "loading" | "ready" | "failed";

export function RealAssetsSection({ spaceId, active = true }: { spaceId: string; active?: boolean }) {
  const [rows,  setRows]  = useState<AccountDetailRow[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [adding,     setAdding]     = useState(false);
  const [revaluing,  setRevaluing]  = useState<AccountDetailRow | null>(null);
  const [archiving,  setArchiving]  = useState<AccountDetailRow | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/spaces/${spaceId}/accounts/detail`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        const list: AccountDetailRow[] = Array.isArray(data?.rows) ? data.rows : [];
        setRows(selectRealAssetRows(list));
        setState("ready");
      })
      .catch(() => setState("failed"));
  }, [spaceId]);

  useEffect(() => { if (active) load(); }, [active, load]);

  // Another surface (a manual sync, another tab of this page) refreshed the Space.
  useEffect(() => {
    function onRefreshed(e: Event) {
      const detail = (e as CustomEvent<{ spaceId?: string }>).detail;
      if (detail?.spaceId && detail.spaceId !== spaceId) return;
      load();
    }
    window.addEventListener(SPACE_DATA_REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(SPACE_DATA_REFRESHED_EVENT, onRefreshed);
  }, [spaceId, load]);

  // After OUR write: the host re-reads accounts + snapshots (the handler above
  // re-reads this section too).
  const announceChange = useCallback(() => {
    window.dispatchEvent(new CustomEvent(SPACE_DATA_REFRESHED_EVENT, { detail: { spaceId } }));
  }, [spaceId]);

  async function confirmArchive() {
    if (!archiving) return;
    setArchiveBusy(true);
    setArchiveError(null);
    const res = await fetch(`/api/accounts/manual/${encodeURIComponent(archiving.id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    setArchiveBusy(false);
    if (!res.ok) {
      setArchiveError(data.error ?? "Couldn't archive this asset. Please try again.");
      return;
    }
    setArchiving(null);
    announceChange();
  }

  const now = new Date();

  return (
    <div className="space-y-4" data-real-assets>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[var(--text-muted)] max-w-md">
          Homes, vehicles and other things you own. {ESTIMATE_DISCLOSURE}
        </p>
        <GlassButton tone="neutral" className="w-full sm:w-auto" onClick={() => setAdding(true)}>
          <Plus size={14} />
          Add asset
        </GlassButton>
      </div>

      {state === "loading" && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 size={12} className="animate-spin" /> Loading assets…
        </div>
      )}

      {state === "failed" && (
        <p className="text-xs text-[var(--text-muted)]">
          Couldn&rsquo;t load real assets.{" "}
          <button type="button" className="underline hover:text-[var(--text-primary)]" onClick={() => { setState("loading"); load(); }}>
            Try again
          </button>
        </p>
      )}

      {state === "ready" && rows.length === 0 && (
        <div
          className="rounded-2xl border p-6 text-center"
          style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
        >
          <p className="text-sm text-[var(--text-secondary)]">No real assets in this Space yet.</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Add a home, vehicle, jewelry or anything else you own. It counts toward your net worth at the value you enter.
          </p>
        </div>
      )}

      {state === "ready" && rows.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Real assets">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-2xl border p-4 flex flex-col gap-3 min-w-0"
              style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text-primary)]" title={r.name}>{r.name}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-primary)]">
                  {formatCurrency(r.balance, r.currency)}
                </p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {estimateCaption(r.freshness?.balance?.ingestedAt ?? null, now)}
                </p>
              </div>
              {r.canManage && (
                <div className="flex gap-2">
                  <GlassButton tone="neutral" size="sm" onClick={() => setRevaluing(r)}>
                    <PencilLine size={13} />
                    Update value
                  </GlassButton>
                  <GlassButton tone="neutral" size="sm" onClick={() => { setArchiveError(null); setArchiving(r); }}>
                    <Archive size={13} />
                    Archive
                  </GlassButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddManualAssetModal
          defaultSpaceIds={[spaceId]}
          onClose={() => setAdding(false)}
          onAdd={announceChange}
        />
      )}

      {revaluing && (
        <UpdateAssetValueModal
          accountId={revaluing.id}
          name={revaluing.name}
          currency={revaluing.currency}
          currentValue={revaluing.balance}
          onClose={() => setRevaluing(null)}
          onSaved={announceChange}
        />
      )}

      {archiving && (
        <ConfirmDialog
          onClose={() => { if (!archiveBusy) setArchiving(null); }}
          onConfirm={confirmArchive}
          busy={archiveBusy}
          icon={Archive}
          title={`Archive ${archiving.name}?`}
          message={
            <span>
              It leaves your net worth and every Space it&rsquo;s shown in. You can restore it from
              Settings → Data &amp; privacy → Archived assets.
              {archiveError && <span className="mt-2 block text-[var(--coral-400)]" role="alert">{archiveError}</span>}
            </span>
          }
          confirmLabel="Archive"
        />
      )}
    </div>
  );
}
