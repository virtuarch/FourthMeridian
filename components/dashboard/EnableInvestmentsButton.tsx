"use client";

/**
 * components/dashboard/EnableInvestmentsButton.tsx
 *
 * Connection-specific "Enable Investments" action, rendered by ConnectionCard
 * ONLY when the connection's Investments capability is "available"
 * (PlaidItem.investmentsConsent === CONSENT_REQUIRED) — i.e. the Item plausibly
 * supports investment data but the user hasn't consented yet. Unsupported /
 * unknown connections never render this button (see lib/sync/status.ts
 * deriveInvestmentsCapability), so it is never misleading.
 *
 * Opens Plaid Link update mode for THIS Item with Investments consent via
 * PlaidContext.openInvestmentsConsent — the single usePlaidLink instance, same
 * pattern as ReconnectAccountButton. On success the context runs the existing
 * holdings refresh and refreshes the page; this leaf only drives its own
 * opening → syncing → error UI. Cancel is non-destructive (silent return to
 * idle).
 */

import { useState } from "react";
import { usePlaid } from "@/context/PlaidContext";
import { LineChart, Loader2 } from "lucide-react";

interface Props {
  /** PlaidItem.id — the SyncConnection id for a Plaid connection. */
  plaidItemId: string;
  /**
   * Fired after a successful in-app (non-OAuth) enable, so a self-fetching host
   * (e.g. the Investments perspective widget) can reload its own data. The
   * context also calls router.refresh() for server-rendered hosts; this is
   * additive. Not fired for OAuth institutions, which resolve on the
   * OAuth-return page and navigate away.
   */
  onEnabled?: () => void;
}

export function EnableInvestmentsButton({ plaidItemId, onEnabled }: Props) {
  const { openInvestmentsConsent } = usePlaid();
  const [phase, setPhase] = useState<"idle" | "opening" | "syncing">("idle");
  const [error, setError] = useState("");

  const start = () => {
    setError("");
    setPhase("opening");
    openInvestmentsConsent(plaidItemId, {
      onSyncing: () => setPhase("syncing"),
      onResult:  (ok, msg) => {
        setPhase("idle");
        // ok → the context has already called router.refresh(); this card will
        // re-render with the "enabled" capability. On a clean cancel (ok=false,
        // no msg) we simply return to idle — non-destructive.
        if (ok) onEnabled?.();
        if (!ok && msg) setError(msg);
      },
    });
  };

  const busy  = phase !== "idle";
  const label =
    phase === "syncing" ? "Syncing holdings…" :
    phase === "opening" ? "Opening…" :
    "Enable Investments";

  return (
    <div>
      <button
        onClick={start}
        disabled={busy}
        className="flex items-center gap-1.5 text-xs font-semibold text-[var(--meridian-400)] border border-[rgba(125,168,255,.3)] bg-[rgba(59,130,246,.08)] px-2.5 py-1 rounded-lg hover:bg-[rgba(59,130,246,.16)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy
          ? <Loader2   size={12} className="animate-spin" />
          : <LineChart size={12} />
        }
        {label}
      </button>
      {error && <p className="text-xs text-[var(--accent-warning,#f59e0b)] mt-1">{error}</p>}
    </div>
  );
}
