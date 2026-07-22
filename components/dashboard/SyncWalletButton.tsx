"use client";

/**
 * components/dashboard/SyncWalletButton.tsx
 *
 * Manual balance-refresh affordance for self-custodied crypto wallet accounts.
 * Rendered by AccountCard for `type === "crypto"` wallet-backed accounts only
 * (never for Plaid bank accounts, which reconnect via ReconnectAccountButton).
 *
 * Triggers the existing manual sync route (POST /api/accounts/[id]/sync — BTC
 * wallet sync v1). Small client leaf, matching the ReconnectAccountButton /
 * PlaidLinkButton pattern so AccountCard stays a Server Component. Uses an
 * inline error (same as its sibling) — the codebase has no global toast
 * provider, only local one-shot banners.
 *
 * Label: syncStatus "pending" → "Sync wallet" (never synced yet); otherwise
 * "Refresh". On success, router.refresh() re-runs the server components so the
 * updated balance flows back through getAccounts() → AccountCard.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Loader2 } from "lucide-react";

interface Props {
  accountId: string;
  syncStatus?: "synced" | "pending" | "error" | "manual";
}

export function SyncWalletButton({ accountId, syncStatus }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const idleLabel = syncStatus === "pending" ? "Sync wallet" : "Refresh";

  async function handleSync() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      // The route returns { ok:false, reason } (502) on explorer/price failure
      // and { error } (400/404) for guard failures — the account stays visible
      // and "pending" either way; surface a clear message.
      if (!res.ok || data?.ok === false) {
        setError(data?.error ?? data?.reason ?? "Sync failed. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Sync failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleSync}
        disabled={loading}
        aria-label={loading ? "Syncing wallet" : idleLabel}
        className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-2.5 py-1 rounded-lg hover:bg-[var(--surface-muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading
          ? <Loader2  size={12} className="animate-spin" />
          : <RefreshCw size={12} />
        }
        {loading ? "Syncing…" : idleLabel}
      </button>
      {error && <p className="text-xs text-[var(--accent-negative)] mt-1">{error}</p>}
    </div>
  );
}
