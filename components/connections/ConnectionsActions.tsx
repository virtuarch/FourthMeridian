"use client";

/**
 * components/connections/ConnectionsActions.tsx
 *
 * D2.x — page-level provider action cluster for the Connections hub, the single
 * entry point for all financial sources. Two actions today:
 *   - Connect institution → Plaid Link (usePlaid().openLink)
 *   - Add wallet          → the existing AddWalletModal
 *
 * Visual language matches the Daily Brief hero CTAs (BriefHero): useAtlasLiquid()
 * picks the Liquid CTA (AtlasLiquidCta) when supported, else the Atlas Glass
 * fallback (GlassButton). Responsive: on mobile the actions stack full-width so
 * labels never truncate; on sm+ they sit inline at content width.
 *
 * Reuses existing primitives only — no wallet/Plaid logic here, no new material.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Wallet, Loader2 } from "lucide-react";
import { usePlaid } from "@/context/PlaidContext";
import { useAtlasLiquid } from "@/components/atlas/useAtlasLiquid";
import { AtlasLiquidCta } from "@/components/atlas/AtlasLiquidCta";
import { GlassButton } from "@/components/atlas/GlassButton";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";

interface Props {
  /** Center the cluster (used by the empty state). Default false. */
  centered?: boolean;
}

export function ConnectionsActions({ centered = false }: Props) {
  const router = useRouter();
  const { openLink, isLoading, error } = usePlaid();
  const liquid = useAtlasLiquid();
  const [walletOpen, setWalletOpen] = useState(false);

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

  return (
    <div className={centered ? "flex flex-col items-stretch gap-2.5 sm:flex-row sm:justify-center" : "flex flex-col items-stretch gap-2.5 sm:flex-row sm:justify-end"}>
      <div className="flex flex-col gap-2.5 sm:flex-row">
        {liquid ? (
          <>
            <AtlasLiquidCta
              onClick={() => openLink()}
              ariaLabel="Connect a bank or institution"
            >
              {connectContent}
            </AtlasLiquidCta>
            <AtlasLiquidCta onClick={() => setWalletOpen(true)} ariaLabel="Add a wallet">
              {walletContent}
            </AtlasLiquidCta>
          </>
        ) : (
          <>
            <GlassButton
              tone="meridian"
              fullWidth
              className="sm:w-auto"
              onClick={() => openLink()}
              disabled={isLoading}
            >
              {connectContent}
            </GlassButton>
            <GlassButton
              tone="neutral"
              fullWidth
              className="sm:w-auto"
              onClick={() => setWalletOpen(true)}
            >
              {walletContent}
            </GlassButton>
          </>
        )}
      </div>

      {error && (
        <p className="text-xs text-[var(--coral-400)] sm:self-center">{error}</p>
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
