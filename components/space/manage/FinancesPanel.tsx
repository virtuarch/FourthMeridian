"use client";

/**
 * components/space/manage/FinancesPanel.tsx  (MSM decomposition)
 *
 * The "Add Accounts" (Finances) tab of Manage Space, extracted verbatim from the
 * former single-file ManageSpaceModal (FinancesTab). Lists the Space's shared
 * accounts, revokes them, and opens the shared ShareExistingAccountsPanel to add
 * more — all against the canonical /api/spaces/[id]/accounts + /accounts/share
 * routes (server enforces the share/revoke gates). Behavior-preserving.
 *
 * UI-003 — revoking a share removes the account from the Space for every member, so
 * the row's X only stages it; handleRevoke is reachable from the ConfirmDialog alone.
 * UI-006 — a failed list read is an error with Retry, never "No accounts shared".
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2, X, Landmark, Share2, AlertTriangle } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { revokeAccountConfirm } from "./destructive-confirm";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { ShareExistingAccountsPanel } from "./ShareExistingAccountsPanel";
import { formatBalance, type SharedAccount } from "./manage-shared";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Checking", savings: "Savings", investment: "Investment",
  crypto: "Crypto", debt: "Debt", other: "Other",
};

export function FinancesPanel({
  spaceId,
  myRole,
  onRefresh,
}: {
  spaceId: string;
  myRole:      string;
  // The real top-level ManageSpaceModal.onRefresh — previously never
  // threaded into this tab at all, which is why sharing/revoking an asset
  // from /dashboard/spaces never updated the Space card/totals there.
  onRefresh:   () => void | Promise<void>;
}) {
  const [accounts,       setAccounts]       = useState<SharedAccount[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [showPanel,      setShowPanel]      = useState(false);
  const [revokingId,     setRevokingId]     = useState<string | null>(null);

  const canShare = ["OWNER", "ADMIN", "MEMBER"].includes(myRole);

  const [loadError,      setLoadError]      = useState(false);
  const [revokeError,    setRevokeError]    = useState("");
  const [pendingRevoke,  setPendingRevoke]  = useState<SharedAccount | null>(null);

  const loadAccounts = useCallback(() => {
    setLoading(true);
    fetch(`/api/spaces/${spaceId}/accounts`)
      .then((r) => {
        if (!r.ok) throw new Error(`accounts ${r.status}`);
        return r.json();
      })
      .then((data: SharedAccount[]) => { setAccounts(data); setLoadError(false); setLoading(false); })
      .catch(() => { setLoadError(true); setLoading(false); });
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  async function handleRevoke(accountId: string) {
    setRevokingId(accountId);
    setRevokeError("");
    try {
      const res = await fetch(`/api/spaces/${spaceId}/accounts/share`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financialAccountId: accountId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setRevokeError(d.error ?? "Couldn't remove the account. Try again.");
        return;
      }
      loadAccounts();
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
      // Notify the hosting page directly — same gap as MembersPanel had:
      // the event above only reaches SpaceDashboard's listener.
      await onRefresh();
    } catch {
      setRevokeError("Network error — the account was not removed.");
    } finally {
      setRevokingId(null);
      setPendingRevoke(null);
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>;

  if (showPanel) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPanel(false)} className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors">
            <X size={15} />
          </button>
          <p className="text-sm font-semibold text-[var(--text-primary)]">Share an account</p>
        </div>
        <ShareExistingAccountsPanel
          spaceId={spaceId}
          onShared={() => { loadAccounts(); onRefresh(); }}
        />
      </div>
    );
  }

  const grouped = accounts.reduce<Record<string, SharedAccount[]>>((acc, a) => {
    (acc[a.type] ??= []).push(a);
    return acc;
  }, {});

  if (loadError) {
    return (
      <div role="alert" className="text-center py-6">
        <AlertTriangle size={24} className="text-[var(--coral-400)] mx-auto mb-2" aria-hidden />
        <p className="text-sm text-[var(--text-secondary)]">Couldn&apos;t load this Space&apos;s accounts.</p>
        <button
          type="button"
          onClick={loadAccounts}
          className="mt-2 text-xs font-medium text-[var(--meridian-400)] hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <div className="text-center py-6">
          <Landmark size={28} className="text-[var(--text-muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-muted)]">No accounts shared</p>
          {canShare && <p className="text-xs text-[var(--text-muted)] mt-1">Share an account to include it in this Space.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type}>
              <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-1.5">
                {ACCOUNT_TYPE_LABELS[type] ?? type}
              </p>
              <div className="space-y-1">
                {items.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-muted)] group">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[var(--text-primary)] truncate">{a.name}</p>
                      <p className="text-xs text-[var(--text-muted)] truncate">{a.institution}</p>
                    </div>
                    <p className="text-sm font-medium text-[var(--text-primary)] shrink-0">{formatBalance(a.balance, a.currency)}</p>
                    {canShare && (
                      <button onClick={() => { setRevokeError(""); setPendingRevoke(a); }} disabled={revokingId === a.id}
                        className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.10)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50 transition-all"
                        title="Remove from Space"
                        aria-label={`Remove ${a.name} from Space`}>
                        {revokingId === a.id ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <X size={12} aria-hidden />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {revokeError && <p role="alert" className="text-xs text-[var(--coral-400)]">{revokeError}</p>}
      {/* UI-003 — the ONLY path to handleRevoke. */}
      {pendingRevoke && (() => {
        const copy = revokeAccountConfirm(pendingRevoke.name);
        return (
          <ConfirmDialog
            onClose={() => setPendingRevoke(null)}
            onConfirm={() => handleRevoke(pendingRevoke.id)}
            busy={revokingId === pendingRevoke.id}
            icon={X}
            title={copy.title}
            message={copy.message}
            confirmLabel={copy.confirmLabel}
          />
        );
      })()}
      {canShare && (
        <button onClick={() => setShowPanel(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-[var(--border-hairline)] text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hairline-strong)] transition-colors">
          <Share2 size={14} /> Share an account
        </button>
      )}
    </div>
  );
}
