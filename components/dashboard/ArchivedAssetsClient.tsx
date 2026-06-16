"use client";

/**
 * ArchivedAssetsClient
 *
 * Table of every soft-deleted account the user owns — manual assets, Plaid
 * accounts, and self-custody wallets alike (see archived-assets/page.tsx,
 * which now queries all deletedAt-set FinancialAccount rows instead of just
 * type=other/syncStatus=manual).
 *
 * Actions differ by source:
 *   - manual: Restore → POST /api/accounts/manual/[id]/restore
 *             Delete permanently → DELETE /api/accounts/manual/[id]/permanent
 *   - plaid/wallet: Restore → POST /api/accounts/[id]/restore (generic route)
 *             No permanent-delete action yet — there is no hard-delete route
 *             for non-manual accounts, and the project rules for this pass
 *             explicitly disallow adding one. Restore is the only action shown.
 */

import { useState, useCallback } from "react";
import { useRouter }             from "next/navigation";
import {
  RotateCcw, Trash2, Loader2, Archive, ChevronLeft, AlertTriangle, Landmark, Wallet,
} from "lucide-react";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ArchivedAssetSource = "manual" | "plaid" | "wallet";

export interface ArchivedAsset {
  id:          string;
  name:        string;
  balance:     number;
  currency:    string;
  deletedAt:   string;
  institution: string;
  source:      ArchivedAssetSource;
  workspaces: { id: string; name: string }[];
}

interface Props {
  assets: ArchivedAsset[];
}

const SOURCE_LABEL: Record<ArchivedAssetSource, string> = {
  manual: "Manual",
  plaid:  "Plaid",
  wallet: "Wallet",
};

const SOURCE_ICON: Record<ArchivedAssetSource, React.ElementType> = {
  manual: Archive,
  plaid:  Landmark,
  wallet: Wallet,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtCurrency(balance: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style:    "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 2,
  }).format(Math.abs(balance));
}

function timeAgo(iso: string) {
  const diffMs   = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30)  return `${diffDays} days ago`;
  const months = Math.floor(diffDays / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

// ─── Row component ────────────────────────────────────────────────────────────

function AssetRow({
  asset,
  onRestored,
  onDeleted,
}: {
  asset:      ArchivedAsset;
  onRestored: (id: string) => void;
  onDeleted:  (id: string) => void;
}) {
  const [restoring,        setRestoring]        = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting,         setDeleting]         = useState(false);
  const [error,            setError]            = useState<string | null>(null);

  const isManual = asset.source === "manual";

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    setError(null);
    try {
      // Manual assets keep the dedicated manual restore route; everything
      // else (Plaid, wallet) uses the generic restore route added alongside
      // the reconnect fix in app/api/accounts/[id]/restore/route.ts.
      const url = isManual
        ? `/api/accounts/manual/${asset.id}/restore`
        : `/api/accounts/${asset.id}/restore`;
      const res = await fetch(url, { method: "POST" });
      if (res.ok) {
        onRestored(asset.id);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to restore.");
      }
    } finally {
      setRestoring(false);
    }
  }, [asset.id, isManual, onRestored]);

  const handlePermanentDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/manual/${asset.id}/permanent`, { method: "DELETE" });
      if (res.ok) {
        onDeleted(asset.id);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to delete.");
        setConfirmingDelete(false);
      }
    } finally {
      setDeleting(false);
    }
  }, [asset.id, onDeleted]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Main row */}
      <div className="flex items-start gap-4 px-5 py-4">
        {/* Icon */}
        <div className="w-9 h-9 rounded-xl bg-gray-800 flex items-center justify-center shrink-0 mt-0.5">
          {(() => {
            const SourceIcon = SOURCE_ICON[asset.source];
            return <SourceIcon size={16} className="text-gray-500" />;
          })()}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white truncate">{asset.name}</p>
            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded-md shrink-0">
              {SOURCE_LABEL[asset.source]}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {asset.institution ? `${asset.institution} · ` : ""}
            {fmtCurrency(asset.balance, asset.currency)} · Archived {timeAgo(asset.deletedAt)}
          </p>
          {asset.workspaces.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {asset.workspaces.map((ws) => (
                <span
                  key={ws.id}
                  className="inline-flex items-center text-[11px] font-medium text-gray-400 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded-md"
                >
                  {ws.name}
                </span>
              ))}
            </div>
          )}
          {error && (
            <p className="text-xs text-red-400 mt-2 flex items-center gap-1.5">
              <AlertTriangle size={11} /> {error}
            </p>
          )}
        </div>

        {/* Actions */}
        {!confirmingDelete && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRestore}
              disabled={restoring}
              className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {restoring ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
              {restoring ? "Restoring…" : "Restore"}
            </button>
            {isManual && (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-red-400 hover:bg-red-500/10 border border-gray-700 hover:border-red-500/30 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Trash2 size={11} />
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {/* Permanent delete confirmation strip — manual assets only; the route
          itself also rejects non-manual ids, this is a defense-in-depth UI gate */}
      {confirmingDelete && isManual && (
        <div className="px-5 pb-4 flex items-center justify-between gap-3 border-t border-gray-800 pt-3 mt-1">
          <p className="text-xs text-gray-400">
            Permanently delete <span className="text-white font-medium">{asset.name}</span>?
            <span className="text-red-400"> This cannot be undone.</span>
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
              className="text-xs text-gray-500 hover:text-gray-300 px-2.5 py-1.5 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handlePermanentDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
              {deleting ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ArchivedAssetsClient({ assets: initialAssets }: Props) {
  const router = useRouter();
  const [assets, setAssets] = useState<ArchivedAsset[]>(initialAssets);

  const handleRestored = useCallback((id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
    router.refresh();
  }, [router]);

  const handleDeleted = useCallback((id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/settings"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors shrink-0"
        >
          <ChevronLeft size={16} />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-white">Archived Assets</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Restore any account to bring it back. Manual assets can also be deleted permanently.
          </p>
        </div>
      </div>

      {/* Asset list */}
      {assets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 rounded-2xl bg-gray-800/60 flex items-center justify-center mb-4">
            <Archive size={24} className="text-gray-600" />
          </div>
          <p className="text-sm font-medium text-gray-400">No archived accounts</p>
          <p className="text-xs text-gray-600 mt-1 max-w-xs">
            When you remove an account — manual, Plaid, or wallet — it appears here so you can restore it.
          </p>
          <Link
            href="/dashboard/settings"
            className="mt-6 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            ← Back to Settings
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {assets.map((asset) => (
            <AssetRow
              key={asset.id}
              asset={asset}
              onRestored={handleRestored}
              onDeleted={handleDeleted}
            />
          ))}
          <p className="text-xs text-gray-600 text-center pt-2">
            {assets.length} archived {assets.length === 1 ? "asset" : "assets"}
          </p>
        </div>
      )}
    </div>
  );
}
