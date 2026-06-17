"use client";

/**
 * ArchiveBinClient
 *
 * Unified Archive & Trash page. Three tabs over three different object
 * types, all following the same restore/permanent-delete shape:
 *
 *   Archived Accounts  — soft-deleted FinancialAccount rows (manual, Plaid,
 *                         wallet). Pre-existing behavior, unchanged:
 *                           Restore -> POST /api/accounts/manual/[id]/restore
 *                                      or  POST /api/accounts/[id]/restore
 *                           Delete permanently (manual only) ->
 *                             DELETE /api/accounts/manual/[id]/permanent
 *
 *   Archived Workspaces — Workspace.archivedAt set (deletedAt still null).
 *                         Fully intact, hidden from active nav only.
 *                           Restore (unarchive) -> PATCH /api/workspaces/[id]
 *                                                  { archivedAt: null }
 *                           Move to trash       -> DELETE /api/workspaces/[id]
 *                         OWNER only — buttons are hidden for everyone else.
 *
 *   Trash               — Workspace.deletedAt set. Same OWNER-only gating.
 *                           Restore             -> POST /api/workspaces/[id]/restore
 *                           Delete permanently  -> DELETE /api/workspaces/[id]/permanent
 *                         Permanent delete is blocked server-side (and the
 *                         error surfaced here) if the workspace still owns
 *                         FinancialAccount rows — those must be reassigned
 *                         or removed first so they aren't orphaned.
 *
 * This is the only place a Workspace can be permanently deleted from — the
 * workspace detail / Manage modals only offer archive and trash.
 */

import { useState, useCallback } from "react";
import { useRouter }             from "next/navigation";
import {
  RotateCcw, Trash2, Loader2, Archive, ChevronLeft, AlertTriangle,
  Landmark, Wallet, Building2, Inbox,
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

export interface ArchivedWorkspace {
  id:         string;
  name:       string;
  type:       string;     // "SHARED" — PERSONAL workspaces can never be archived
  category:   string;
  archivedAt: string;
  myRole:     string;
}

export interface TrashedWorkspace {
  id:        string;
  name:      string;
  type:      string;
  category:  string;
  deletedAt: string;
  myRole:    string;
}

interface Props {
  assets:             ArchivedAsset[];
  archivedWorkspaces: ArchivedWorkspace[];
  trashedWorkspaces:  TrashedWorkspace[];
}

type BinTab = "accounts" | "workspaces" | "trash";

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

// ─── Row: Archived Account ──────────────────────────────────────────────────

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

// ─── Row: Archived Workspace ─────────────────────────────────────────────────

function ArchivedWorkspaceRow({
  ws,
  onUnarchived,
  onTrashed,
}: {
  ws:           ArchivedWorkspace;
  onUnarchived: (id: string) => void;
  onTrashed:    (id: string) => void;
}) {
  const [restoring,       setRestoring]       = useState(false);
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [trashing,        setTrashing]        = useState(false);
  const [error,           setError]           = useState<string | null>(null);

  const isOwner = ws.myRole === "OWNER";

  const handleUnarchive = useCallback(async () => {
    setRestoring(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ archivedAt: null }),
      });
      if (res.ok) {
        onUnarchived(ws.id);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to restore.");
      }
    } finally {
      setRestoring(false);
    }
  }, [ws.id, onUnarchived]);

  const handleTrash = useCallback(async () => {
    setTrashing(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
      if (res.ok) {
        onTrashed(ws.id);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to move to trash.");
        setConfirmingTrash(false);
      }
    } finally {
      setTrashing(false);
    }
  }, [ws.id, onTrashed]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-start gap-4 px-5 py-4">
        <div className="w-9 h-9 rounded-xl bg-gray-800 flex items-center justify-center shrink-0 mt-0.5">
          <Building2 size={16} className="text-gray-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white truncate">{ws.name}</p>
            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded-md shrink-0">
              Workspace
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Archived {timeAgo(ws.archivedAt)}
            {!isOwner && ` · ${ws.myRole}`}
          </p>
          {!isOwner && (
            <p className="text-xs text-gray-600 mt-1.5">Only the owner can restore or trash this workspace.</p>
          )}
          {error && (
            <p className="text-xs text-red-400 mt-2 flex items-center gap-1.5">
              <AlertTriangle size={11} /> {error}
            </p>
          )}
        </div>

        {isOwner && !confirmingTrash && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleUnarchive}
              disabled={restoring}
              className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {restoring ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
              {restoring ? "Restoring…" : "Restore"}
            </button>
            <button
              onClick={() => setConfirmingTrash(true)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-red-400 hover:bg-red-500/10 border border-gray-700 hover:border-red-500/30 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Trash2 size={11} />
              Move to trash
            </button>
          </div>
        )}
      </div>

      {isOwner && confirmingTrash && (
        <div className="px-5 pb-4 flex items-center justify-between gap-3 border-t border-gray-800 pt-3 mt-1">
          <p className="text-xs text-gray-400">
            Move <span className="text-white font-medium">{ws.name}</span> to trash?
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setConfirmingTrash(false)}
              disabled={trashing}
              className="text-xs text-gray-500 hover:text-gray-300 px-2.5 py-1.5 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleTrash}
              disabled={trashing}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {trashing ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
              {trashing ? "Moving…" : "Move to trash"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Row: Trashed Workspace ──────────────────────────────────────────────────

function TrashedWorkspaceRow({
  ws,
  onRestored,
  onDeleted,
}: {
  ws:         TrashedWorkspace;
  onRestored: (id: string) => void;
  onDeleted:  (id: string) => void;
}) {
  const [restoring,        setRestoring]        = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting,         setDeleting]         = useState(false);
  const [error,            setError]            = useState<string | null>(null);

  const isOwner = ws.myRole === "OWNER";

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/restore`, { method: "POST" });
      if (res.ok) {
        onRestored(ws.id);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to restore.");
      }
    } finally {
      setRestoring(false);
    }
  }, [ws.id, onRestored]);

  const handlePermanentDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/permanent`, { method: "DELETE" });
      if (res.ok) {
        onDeleted(ws.id);
      } else {
        const data = await res.json().catch(() => ({}));
        // Server includes ownedAccountCount when the block is "this workspace
        // still owns accounts" — the message already explains what to do.
        setError(data.error ?? "Failed to delete.");
        setConfirmingDelete(false);
      }
    } finally {
      setDeleting(false);
    }
  }, [ws.id, onDeleted]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="flex items-start gap-4 px-5 py-4">
        <div className="w-9 h-9 rounded-xl bg-gray-800 flex items-center justify-center shrink-0 mt-0.5">
          <Trash2 size={16} className="text-gray-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white truncate">{ws.name}</p>
            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-red-400 bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 rounded-md shrink-0">
              Trashed
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Trashed {timeAgo(ws.deletedAt)}
            {!isOwner && ` · ${ws.myRole}`}
          </p>
          {!isOwner && (
            <p className="text-xs text-gray-600 mt-1.5">Only the owner can restore or permanently delete this workspace.</p>
          )}
          {error && (
            <p className="text-xs text-red-400 mt-2 flex items-center gap-1.5">
              <AlertTriangle size={11} /> {error}
            </p>
          )}
        </div>

        {isOwner && !confirmingDelete && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRestore}
              disabled={restoring}
              className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {restoring ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
              {restoring ? "Restoring…" : "Restore"}
            </button>
            <button
              onClick={() => setConfirmingDelete(true)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-red-400 hover:bg-red-500/10 border border-gray-700 hover:border-red-500/30 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Trash2 size={11} />
              Delete permanently
            </button>
          </div>
        )}
      </div>

      {isOwner && confirmingDelete && (
        <div className="px-5 pb-4 flex items-center justify-between gap-3 border-t border-gray-800 pt-3 mt-1">
          <p className="text-xs text-gray-400">
            Permanently delete <span className="text-white font-medium">{ws.name}</span>?
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

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ icon: Icon, title, body }: { icon: React.ElementType; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-gray-800/60 flex items-center justify-center mb-4">
        <Icon size={24} className="text-gray-600" />
      </div>
      <p className="text-sm font-medium text-gray-400">{title}</p>
      <p className="text-xs text-gray-600 mt-1 max-w-xs">{body}</p>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ArchiveBinClient({
  assets: initialAssets,
  archivedWorkspaces: initialArchivedWorkspaces,
  trashedWorkspaces: initialTrashedWorkspaces,
}: Props) {
  const router = useRouter();
  const [tab,         setTab]         = useState<BinTab>("accounts");
  const [assets,       setAssets]       = useState<ArchivedAsset[]>(initialAssets);
  const [archivedWs,   setArchivedWs]   = useState<ArchivedWorkspace[]>(initialArchivedWorkspaces);
  const [trashedWs,    setTrashedWs]    = useState<TrashedWorkspace[]>(initialTrashedWorkspaces);

  const handleAssetRestored = useCallback((id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
    router.refresh();
  }, [router]);

  const handleAssetDeleted = useCallback((id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleWorkspaceUnarchived = useCallback((id: string) => {
    setArchivedWs((prev) => prev.filter((w) => w.id !== id));
    router.refresh();
  }, [router]);

  const handleWorkspaceTrashedFromArchive = useCallback((id: string) => {
    setArchivedWs((prev) => prev.filter((w) => w.id !== id));
    router.refresh();
  }, [router]);

  const handleWorkspaceRestoredFromTrash = useCallback((id: string) => {
    setTrashedWs((prev) => prev.filter((w) => w.id !== id));
    router.refresh();
  }, [router]);

  const handleWorkspacePermanentlyDeleted = useCallback((id: string) => {
    setTrashedWs((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const tabs: { id: BinTab; label: string; count: number }[] = [
    { id: "accounts",   label: "Archived Accounts",   count: assets.length },
    { id: "workspaces", label: "Archived Workspaces", count: archivedWs.length },
    { id: "trash",      label: "Trash",               count: trashedWs.length },
  ];

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
          <h1 className="text-xl font-bold text-white">Archive &amp; Trash</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Restore anything here to bring it back. Trashed workspaces and manual assets can also be deleted permanently.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-2xl p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
              tab === t.id ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${
                tab === t.id ? "bg-gray-600 text-gray-200" : "bg-gray-800 text-gray-500"
              }`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "accounts" && (
        assets.length === 0 ? (
          <EmptyState
            icon={Archive}
            title="No archived accounts"
            body="When you remove an account — manual, Plaid, or wallet — it appears here so you can restore it."
          />
        ) : (
          <div className="space-y-3">
            {assets.map((asset) => (
              <AssetRow key={asset.id} asset={asset} onRestored={handleAssetRestored} onDeleted={handleAssetDeleted} />
            ))}
            <p className="text-xs text-gray-600 text-center pt-2">
              {assets.length} archived {assets.length === 1 ? "asset" : "assets"}
            </p>
          </div>
        )
      )}

      {tab === "workspaces" && (
        archivedWs.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No archived workspaces"
            body="Archiving a workspace hides it from your active list without touching members, shared accounts, or history. Archive one from its Manage → Danger Zone tab."
          />
        ) : (
          <div className="space-y-3">
            {archivedWs.map((ws) => (
              <ArchivedWorkspaceRow
                key={ws.id}
                ws={ws}
                onUnarchived={handleWorkspaceUnarchived}
                onTrashed={handleWorkspaceTrashedFromArchive}
              />
            ))}
            <p className="text-xs text-gray-600 text-center pt-2">
              {archivedWs.length} archived {archivedWs.length === 1 ? "workspace" : "workspaces"}
            </p>
          </div>
        )
      )}

      {tab === "trash" && (
        trashedWs.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Trash is empty"
            body="Workspaces moved to trash from Manage → Danger Zone appear here. Restore them, or delete them permanently once you're sure."
          />
        ) : (
          <div className="space-y-3">
            {trashedWs.map((ws) => (
              <TrashedWorkspaceRow
                key={ws.id}
                ws={ws}
                onRestored={handleWorkspaceRestoredFromTrash}
                onDeleted={handleWorkspacePermanentlyDeleted}
              />
            ))}
            <p className="text-xs text-gray-600 text-center pt-2">
              {trashedWs.length} trashed {trashedWs.length === 1 ? "workspace" : "workspaces"}
            </p>
          </div>
        )
      )}
    </div>
  );
}
