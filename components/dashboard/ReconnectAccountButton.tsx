"use client";

/**
 * components/dashboard/ReconnectAccountButton.tsx
 *
 * D2-7E reconnect flow. Minimal badge/button rendered by AccountCard when
 * account.needsReauth is true (see lib/data/accounts.ts's getAccounts() —
 * that flag is already scoped to the current user's own broken connection,
 * so no further ownership check is needed here).
 *
 * Opens Plaid Link in update mode via PlaidContext.openLink(onDone, plaidItemId).
 * AccountCard stays a Server Component; this is a small client leaf,
 * matching the existing PlaidLinkButton/ConnectAccountButton/
 * RemoveAccountButton pattern in this directory.
 */

import { usePlaid } from "@/context/PlaidContext";
import { AlertTriangle, Loader2 } from "lucide-react";

interface Props {
  plaidItemId: string;
}

export function ReconnectAccountButton({ plaidItemId }: Props) {
  const { openLink, isLoading, error } = usePlaid();

  return (
    <div>
      <button
        onClick={() => openLink(undefined, plaidItemId)}
        disabled={isLoading}
        className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-warning)] border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 rounded-lg hover:bg-amber-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading
          ? <Loader2       size={12} className="animate-spin" />
          : <AlertTriangle size={12} />
        }
        {isLoading ? "Opening…" : "Reconnect"}
      </button>
      {error && <p className="text-xs text-[var(--accent-warning)] mt-1">{error}</p>}
    </div>
  );
}
