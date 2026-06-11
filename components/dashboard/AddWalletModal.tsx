"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Wallet, ChevronDown, Loader2 } from "lucide-react";
import { WalletChain } from "@/types";

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
}

export function AddWalletModal({ onClose, onAdd }: Props) {
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
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pt-4 pb-40 sm:p-4 bg-black/60 backdrop-blur-sm">
      <div className="flex flex-col w-full max-h-[calc(100dvh-180px)] sm:max-h-[85vh] sm:h-auto sm:max-w-md bg-gray-900 border border-gray-700 rounded-3xl sm:rounded-2xl shadow-2xl">
        {/* Header — always visible */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
              <Wallet size={16} className="text-yellow-400" />
            </div>
            <h2 className="text-base font-semibold text-white">Track a Wallet</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Form — scrollable if content overflows */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <p className="text-xs text-gray-400">
            Enter a public wallet address. FinTracker will query the blockchain for your balance — no private keys needed, ever.
          </p>

          {/* Wallet name */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Nickname</label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(""); }}
              placeholder="e.g. My BTC Cold Storage"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Chain selector */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Blockchain</label>
            <div className="relative">
              <select
                value={chain}
                onChange={(e) => { setChain(e.target.value as WalletChain); setAddress(""); setError(""); }}
                className="w-full appearance-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors pr-10"
              >
                {CHAINS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {/* Wallet address */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Public Wallet Address</label>
            <input
              type="text"
              value={address}
              onChange={(e) => { setAddress(e.target.value); setError(""); }}
              placeholder={selectedChain.placeholder}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors font-mono"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <div className="w-2 h-2 rounded-full bg-yellow-400" />
            <p className="text-xs text-gray-400">
              Balance will show as <span className="text-yellow-400 font-medium">Pending Sync</span> until the first data refresh.
            </p>
          </div>
        </div>

        {/* Actions — pinned above the home indicator */}
        <div className="shrink-0 flex gap-3 px-5 pt-3 pb-8 sm:pb-5 border-t border-gray-800 sm:border-none sm:pt-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-gray-400 border border-gray-700 hover:border-gray-500 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? "Adding…" : "Add Wallet"}
          </button>
        </div>
      </div>
    </div>
  );
}
