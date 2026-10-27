"use client";

/**
 * components/connections/ConnectionsActions.tsx
 *
 * D2.x — page-level provider action cluster for the Connections hub, the single
 * entry point for all financial sources. Three actions today:
 *   - Connect institution → Plaid Link (usePlaid().openLink)
 *   - Add wallet          → the existing AddWalletModal
 *   - Add asset           → the existing AddManualAssetModal (RWA-1: a home,
 *                           vehicle or valuable the user values themselves — a
 *                           first-class asset, not a provider connection)
 *
 * Connections redesign — the Personal button language (GlassButton), no Liquid
 * WebGL CTA. Responsive: on mobile the actions stack full-width so labels never
 * truncate; on sm+ they sit inline at content width.
 *
 * Reuses existing primitives only — no wallet/Plaid logic here, no new material.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Wallet, Loader2, Home } from "lucide-react";
import { usePlaid } from "@/context/PlaidContext";
import { GlassButton } from "@/components/atlas/GlassButton";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import { AddManualAssetModal } from "@/components/dashboard/AddManualAssetModal";

interface Props {
  /** Center the cluster (used by the empty state). Default false. */
  centered?: boolean;
  /** PO-5A — whether Plaid bank connections are available (server env.isPlaidEnabled).
   *  When false, the Connect-institution action is replaced by an honest
   *  "being set up" notice so the user never hits a silent dead end. Default true
   *  (backward compatible). Self-custody wallets are unaffected. */
  plaidEnabled?: boolean;
}

export function ConnectionsActions({ centered = false, plaidEnabled = true }: Props) {
  const router = useRouter();
  const { openLink, isLoading, error } = usePlaid();
  const [walletOpen, setWalletOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);

  const connectLabel = isLoading ? "Opening…" : "Connect institution";

  const connectContent = (
    <>
      {isLoading ? (
        <Loader2 size={16} className="animate-spin shrink-0" />
      ) : (
        <Building2 size={16} className="shrink-0" />
      )}
      <span className="whitespace-nowrap">{connectLabel}</span>
    </>
  );

  const walletContent = (
    <>
      <Wallet size={16} className="shrink-0" />
      <span className="whitespace-nowrap">Add wallet (address or xpub)</span>
    </>
  );

  const assetContent = (
    <>
      <Home size={16} className="shrink-0" />
      <span className="whitespace-nowrap">Add asset</span>
    </>
  );

  return (
    <div className={centered ? "flex flex-col items-stretch gap-2.5 sm:flex-row sm:justify-center" : "flex flex-col items-stretch gap-2.5 sm:flex-row sm:justify-end"}>
      <div className="flex flex-col gap-2.5 sm:flex-row">
        {/* PO-5A — Plaid bank connections gated on availability. When unavailable
            the button is replaced by an honest notice (never a silent dead end);
            self-custody wallets stay available. */}
        {!plaidEnabled ? (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-1,rgba(255,255,255,0.02))] px-4 py-2.5 text-sm text-[var(--text-secondary)]">
            <Building2 size={16} className="shrink-0 text-[var(--text-muted)]" />
            <span>Bank connections are being set up — check back soon.</span>
          </div>
        ) : (
          <GlassButton tone="meridian" fullWidth className="sm:w-auto" onClick={() => openLink()} disabled={isLoading}>
            {connectContent}
          </GlassButton>
        )}

        <GlassButton tone="neutral" fullWidth className="sm:w-auto" onClick={() => setWalletOpen(true)}>
          {walletContent}
        </GlassButton>

        <GlassButton tone="neutral" fullWidth className="sm:w-auto" onClick={() => setAssetOpen(true)}>
          {assetContent}
        </GlassButton>
      </div>

      {error && (
        <p className="text-xs text-[var(--coral-400)] sm:self-center">{error}</p>
      )}

      {assetOpen && (
        <AddManualAssetModal
          onClose={() => setAssetOpen(false)}
          onAdd={() => router.refresh()}
        />
      )}

      {walletOpen && (
        <AddWalletModal
          onClose={() => setWalletOpen(false)}
          onAdd={() => router.refresh()}
        />
      )}
    </div>
  );
}
