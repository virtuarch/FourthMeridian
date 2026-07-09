"use client";

/**
 * AddWalletModal
 *
 * Migrated onto the Atlas Glass modal primitive (FormModal → OverlaySurface)
 * per docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md, migration M1.
 *
 * Why the change: the previous version hand-rolled its own `fixed inset-0`
 * shell and rendered inline in the component tree. Because GlassPanel uses
 * backdrop-filter (which establishes a containing block for `position:fixed`
 * descendants), opening this modal from within a glass surface — the user
 * menu, or the CreateSpace onboarding flow — positioned it relative to that
 * surface instead of the viewport, so it appeared pinned toward the top on
 * desktop. FormModal portals to document.body, which resolves that.
 *
 * No functional or API changes: same props (onClose / onAdd / zIndex), same
 * fields, same /api/accounts/wallet call, same error and loading behaviour.
 * The `zIndex` override is still honoured so this can stack above the (not
 * yet migrated) CreateSpaceModal, which passes zIndex={300}.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wallet, ChevronDown, Loader2 } from "lucide-react";
import { WalletChain } from "@/types";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";

const CHAINS: { value: WalletChain; label: string; placeholder: string }[] = [
  { value: "BTC",   label: "Bitcoin (BTC)",    placeholder: "address (bc1…/1…/3…) or xpub/ypub/zpub" },
  { value: "ETH",   label: "Ethereum (ETH)",   placeholder: "0x..." },
  { value: "SOL",   label: "Solana (SOL)",     placeholder: "Base58 address..." },
  { value: "BNB",   label: "BNB Chain (BNB)",  placeholder: "0x..." },
  { value: "MATIC", label: "Polygon (MATIC)",  placeholder: "0x..." },
  { value: "ADA",   label: "Cardano (ADA)",    placeholder: "addr1..." },
  { value: "XRP",   label: "XRP (XRP)",        placeholder: "r..." },
  { value: "OTHER", label: "Other",            placeholder: "Wallet address..." },
];

interface Props {
  onClose: () => void;
  onAdd?: () => void; // optional — called after successful save
  /** Override the stacking order so this can render above another modal
   *  (e.g. the Create Space onboarding flow's Add Accounts step). Defaults
   *  to the standard modal layer when omitted. */
  zIndex?: number;
}

export function AddWalletModal({ onClose, onAdd, zIndex }: Props) {
  const router = useRouter();
  const [name,    setName]    = useState("");
  const [chain,   setChain]   = useState<WalletChain>("BTC");
  const [address, setAddress] = useState("");
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const selectedChain = CHAINS.find((c) => c.value === chain)!;

  async function handleSubmit() {
    if (!name.trim())    { setError("Give this wallet a name.");      return; }
    if (!address.trim()) { setError("Wallet address is required.");   return; }

    setError("");
    setLoading(true);

    const res  = await fetch("/api/accounts/wallet", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ name: name.trim(), walletAddress: address.trim(), walletChain: chain }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);

    if (!res.ok) { setError(data.error ?? "Failed to add wallet."); return; }

    onAdd?.();
    onClose();
    router.refresh();
  }

  return (
    <FormModal
      open
      onClose={() => { if (!loading) onClose(); }}
      title="Track a Wallet"
      icon={Wallet}
      size="sm"
      zIndex={zIndex}
      preventClose={loading}
      footer={
        <div className="flex gap-3">
          <GlassButton onClick={onClose} disabled={loading} tone="neutral" fullWidth>
            Cancel
          </GlassButton>
          <GlassButton onClick={handleSubmit} disabled={loading} tone="meridian" fullWidth>
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? "Adding…" : "Add Wallet"}
          </GlassButton>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          Enter a public Bitcoin address or an <span className="font-medium text-[var(--text-secondary)]">xpub / ypub / zpub</span> to track the whole wallet. Watch-only — Fourth Meridian reads your balance from the blockchain and never needs spend access.
        </p>
        <p className="text-xs font-semibold text-[var(--brass-400)] leading-relaxed">
          Never enter a seed phrase or private key.
        </p>

        {/* Wallet name */}
        <div>
          <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Nickname</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(""); }}
            placeholder="e.g. My BTC Cold Storage"
            className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors"
            style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
          />
        </div>

        {/* Chain selector */}
        <div>
          <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Blockchain</label>
          <div className="relative">
            <select
              value={chain}
              onChange={(e) => { setChain(e.target.value as WalletChain); setAddress(""); setError(""); }}
              className="w-full appearance-none rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none transition-colors pr-10"
              style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
            >
              {CHAINS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
          </div>
        </div>

        {/* Wallet address */}
        <div>
          <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Public Wallet Address</label>
          <input
            type="text"
            value={address}
            onChange={(e) => { setAddress(e.target.value); setError(""); }}
            placeholder={selectedChain.placeholder}
            className="w-full rounded-[var(--radius-sm)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors font-mono"
            style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
          />
        </div>

        {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}

        <div className="flex items-center gap-2 pt-1">
          <div className="w-2 h-2 rounded-full bg-[var(--brass-400)]" />
          <p className="text-xs text-[var(--text-muted)]">
            Balance will show as <span className="text-[var(--brass-400)] font-medium">Pending Sync</span> until the first data refresh.
          </p>
        </div>
      </div>
    </FormModal>
  );
}
