"use client";

/**
 * components/connections/ConnectionsOnboarding.tsx  (Connections pass PR 2)
 *
 * The welcome a first-time user lands on, and the Connections empty state for
 * everyone with nothing connected. Three ways in — a bank or brokerage (Plaid),
 * a crypto wallet (public address only), a home, vehicle or other real asset —
 * and a way OUT: "Explore My Space", which records the dismissal server-side
 * and goes to My Space. Connecting is never required and nothing here blocks.
 *
 * `welcome` (the one-time post-login redirect, ?welcome=1) adds the greeting.
 * The page records that the welcome was shown, server-side, so the redirect
 * never fires again and the back button returns to a normal Brief.
 *
 * Reuses the existing flows only: usePlaid().openLink, AddWalletModal,
 * AddManualAssetModal. No provider logic here.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Building2, Home, Loader2, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePlaid } from "@/context/PlaidContext";
import { Surface } from "@/components/atlas/Surface";
import { GlassButton } from "@/components/atlas/GlassButton";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import { AddManualAssetModal } from "@/components/dashboard/AddManualAssetModal";
import { dismissNotice } from "@/components/notices/NoticeRail";
import { noteFirstConnectStarted } from "@/lib/connections/first-connect-handoff";

function Option({ icon: Icon, title, body, note, onClick, disabled, busy }: {
  icon: LucideIcon; title: string; body: string; note?: string; onClick: () => void; disabled?: boolean; busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-1,rgba(255,255,255,0.02))] p-4 text-left transition-colors hover:border-[var(--border-hairline-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] disabled:opacity-60"
    >
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(125,168,255,.10)] text-[var(--meridian-400)]">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
          {title}
          <ArrowRight aria-hidden size={14} className="text-[var(--text-faint,#6b7280)] transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-[var(--text-secondary)]">{body}</span>
        {note && <span className="mt-1.5 block text-[11px] text-[var(--text-muted)]">{note}</span>}
      </span>
    </button>
  );
}

export function ConnectionsOnboarding({ welcome = false, firstName = null, plaidEnabled = true }: {
  welcome?: boolean; firstName?: string | null; plaidEnabled?: boolean;
}) {
  const router = useRouter();
  const { openLink, isLoading, error } = usePlaid();
  const [walletOpen, setWalletOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // A real asset is not a connection, so the list below never shows it — say it
  // landed, and offer the two ways on.
  const [assetAdded, setAssetAdded] = useState(false);


  function explore() {
    setLeaving(true);
    // The notice rail's own dismissal: hides the "Add your first account"
    // invitation in this tab at once (the rail outlives this client-side
    // navigation) AND records it server-side (keepalive POST /api/onboarding).
    dismissNotice("connect");
    router.push("/dashboard");
  }

  return (
    <div className="mx-auto max-w-xl pt-2" data-connections-onboarding={welcome ? "welcome" : "empty"}>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          {welcome ? `Welcome to Fourth Meridian${firstName ? `, ${firstName}` : ""}` : "Connect an account"}
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
          Bring in what you own and owe, and Fourth Meridian builds your net worth, cash flow and history from it.
          You can start with one account and add more anytime.
        </p>
      </div>

      {assetAdded && (
        <p role="status" className="mt-5 rounded-[var(--radius-md)] border border-[rgba(52,211,153,.3)] bg-[rgba(52,211,153,.06)] px-4 py-3 text-center text-sm text-[var(--text-secondary)]">
          Asset added. It’s part of your net worth in My Space now — add another, or explore.
        </p>
      )}

      <Surface className="mt-6 p-3 sm:p-4">
        <div className="flex flex-col gap-2.5">
          {plaidEnabled ? (
            <Option
              icon={Building2}
              title="Connect a bank or brokerage"
              body="Checking, savings, credit cards, loans and investments, through Plaid."
              note="Read-only. Fourth Meridian never sees your bank password."
              onClick={() => { noteFirstConnectStarted(); openLink(); }}
              disabled={isLoading}
              busy={isLoading}
            />
          ) : (
            <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-4 text-sm text-[var(--text-secondary)]">
              <Building2 size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
              <span>Bank connections are being set up — check back soon.</span>
            </div>
          )}
          <Option
            icon={Wallet}
            title="Add a crypto wallet"
            body="Bitcoin, Ethereum or Solana — paste a public address (or a Bitcoin xpub)."
            note="Watch-only. Never enter a seed phrase or private key."
            onClick={() => setWalletOpen(true)}
          />
          <Option
            icon={Home}
            title="Add a home, vehicle or other asset"
            body="Anything you value yourself. Update its value whenever you like."
            onClick={() => setAssetOpen(true)}
          />
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-[var(--coral-400)]">{error}</p>}
      </Surface>

      <div className="mt-5 flex flex-col items-center gap-2">
        <GlassButton tone="neutral" onClick={explore} disabled={leaving}>
          {leaving ? <Loader2 size={16} className="animate-spin" /> : null}
          Explore My Space
        </GlassButton>
        <p className="text-[11px] text-[var(--text-muted)]">Connecting is optional. You can add accounts later from Connections.</p>
      </div>

      {walletOpen && <AddWalletModal onClose={() => setWalletOpen(false)} onAdd={() => { noteFirstConnectStarted(); router.refresh(); }} />}
      {assetOpen && <AddManualAssetModal onClose={() => setAssetOpen(false)} onAdd={() => { setAssetAdded(true); router.refresh(); }} />}
    </div>
  );
}
