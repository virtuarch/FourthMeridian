"use client";

/**
 * components/space/manage/ShareExistingAccountsPanel.tsx  (MSM decomposition)
 *
 * Lets a member move/share an account they already own (from their global
 * `/api/accounts` list) into a given Space. This is the single source of
 * truth for "add an existing account to this Space" — it backs both the
 * Finances panel's "Share an account" view AND the Create Space onboarding
 * flow's "Add existing accounts" step (CreateSpaceModal.tsx). Fetches its own
 * "already shared" exclusion list so it's drop-in reusable with nothing but a
 * spaceId — no duplicated account-sharing logic. Extracted verbatim from the
 * former single-file ManageSpaceModal.
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2, ChevronRight, Landmark, Share2 } from "lucide-react";
import { GlassButton } from "@/components/atlas/GlassButton";
import { SPACE_ACCOUNTS_CHANGED_EVENT } from "@/lib/space-nav";
import { formatBalance, type SharedAccount, type UserAccount } from "./manage-shared";

export function ShareExistingAccountsPanel({
  spaceId,
  onShared,
}: {
  spaceId: string;
  onShared?: (accountId: string) => void;
}) {
  const [myAccounts, setMyAccounts] = useState<UserAccount[]>([]);
  const [sharedIds,  setSharedIds]  = useState<Set<string>>(new Set());
  const [loading,    setLoading]    = useState(true);
  const [sharingId,  setSharingId]  = useState<string | null>(null);
  const [shareVis,   setShareVis]   = useState<"FULL" | "BALANCE_ONLY">("FULL");
  const [shareBusy,  setShareBusy]  = useState(false);
  const [shareError, setShareError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mineRes, sharedRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch(`/api/spaces/${spaceId}/accounts`),
      ]);
      if (mineRes.ok) setMyAccounts(await mineRes.json());
      if (sharedRes.ok) {
        const shared: SharedAccount[] = await sharedRes.json();
        setSharedIds(new Set(shared.map((a) => a.id)));
      }
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function handleShare(accountId: string) {
    setShareBusy(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/accounts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financialAccountId: accountId, visibilityLevel: shareVis }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setShareError(d.error ?? "Failed"); }
      else {
        setSharingId(null);
        setShareVis("FULL");
        setShareError("");
        setSharedIds((prev) => new Set(prev).add(accountId));
        // Notify SpaceDashboard (and any other listeners) to refresh its account list
        window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
        onShared?.(accountId);
      }
    } catch { setShareError("Network error"); }
    finally { setShareBusy(false); }
  }

  const available = myAccounts.filter((a) => !sharedIds.has(a.id));

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>;

  if (available.length === 0) {
    return (
      <div className="text-center py-8">
        <Landmark size={26} className="text-[var(--text-muted)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No accounts available to add</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {available.map((a) => {
        const isSelected = sharingId === a.id;
        return (
          <div key={a.id} className={`rounded-xl border transition-colors ${isSelected ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.05)]" : "border-[var(--border-hairline)] bg-[var(--surface-muted)]"}`}>
            <button type="button" onClick={() => setSharingId(isSelected ? null : a.id)}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--text-primary)] truncate">{a.name}</p>
                <p className="text-xs text-[var(--text-muted)] truncate">{a.institution}{a.mask ? ` ···${a.mask}` : ""}</p>
              </div>
              <p className="text-sm font-medium text-[var(--text-primary)] shrink-0 mr-1">{formatBalance(a.balance, a.currency)}</p>
              <ChevronRight size={13} className={`text-[var(--text-muted)] shrink-0 transition-transform ${isSelected ? "rotate-90" : ""}`} />
            </button>
            {isSelected && (
              <div className="px-3 pb-3 space-y-2.5 border-t border-[var(--border-hairline)]">
                <p className="text-xs text-[var(--text-muted)] pt-2">Visibility for Space members:</p>
                {(["FULL", "BALANCE_ONLY"] as const).map((vis) => (
                  <button key={vis} type="button" onClick={() => setShareVis(vis)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-colors ${shareVis === vis ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]" : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]"}`}>
                    <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${shareVis === vis ? "border-[var(--meridian-400)] bg-[var(--meridian-400)]" : "border-[var(--border-hairline-strong)]"}`} />
                    <div>
                      <p className="text-xs font-medium text-[var(--text-primary)]">{vis === "FULL" ? "Full access" : "Balance only"}</p>
                      <p className="text-[10px] text-[var(--text-muted)]">{vis === "FULL" ? "Name, institution, and balance" : "Balance total only"}</p>
                    </div>
                  </button>
                ))}
                {shareError && <p className="text-xs text-[var(--coral-400)]">{shareError}</p>}
                <GlassButton onClick={() => handleShare(a.id)} disabled={shareBusy} tone="meridian" size="sm" fullWidth>
                  {shareBusy ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                  Share into Space
                </GlassButton>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
