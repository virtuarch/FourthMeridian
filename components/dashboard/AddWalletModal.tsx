"use client";

/**
 * AddWalletModal
 *
 * Ported to Atlas Glass (GlassPanel/GlassButton + theme tokens) to match
 * CreateSpaceModal/AddManualAssetModal — same backdrop, sheet, header, and
 * footer recipe. No functional or API changes from the previous version.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Wallet, ChevronDown, Loader2 } from "lucide-react";
import { WalletChain } from "@/types";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";

const CHAINS: { value: WalletChain; label: string; placeholder: string }[] = [
  { value: "BTC",   label: "Bitcoin (BTC)",    placeholder: "bc1q... or 1... or 3..." },
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
   *  to the standard z-[100] modal layer when omitted. */
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
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{
        zIndex: zIndex ?? 100,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <GlassPanel depth="thick" elevation="e4" radius="xl" className="w-full sm:max-w-md">
        <div className="flex flex-col max-h-[92dvh] sm:max-h-[88dvh]">

          {/* Header — always visible */}
          <div
            className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 shrink-0"
            style={{ borderBottom: "1px solid var(--border-hairline)" }}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[rgba(201,162,39,.12)] border border-[rgba(201,162,39,.25)] flex items-center justify-center">
                <Wallet size={16} className="text-[var(--brass-400)]" />
              </div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Track a Wallet</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              aria-label="Close"
              className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Form — scrollable if content overflows */}
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4 min-h-0">
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Enter a public wallet address. Fourth Meridian will query the blockchain for your balance — no private keys needed, ever.
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

          {/* Actions */}
          <div
            className="shrink-0 flex gap-3 px-6 py-5"
            style={{ borderTop: "1px solid var(--border-hairline)" }}
          >
            <GlassButton onClick={onClose} disabled={loading} tone="neutral" fullWidth>
              Cancel
            </GlassButton>
            <GlassButton onClick={handleSubmit} disabled={loading} tone="meridian" fullWidth>
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading ? "Adding…" : "Add Wallet"}
            </GlassButton>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
