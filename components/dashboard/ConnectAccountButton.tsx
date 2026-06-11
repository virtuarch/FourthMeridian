"use client";

/**
 * ConnectAccountButton
 *
 * Opens the Plaid Link flow via PlaidContext — a single usePlaidLink instance
 * is managed at the provider level to prevent the "script loaded more than once" warning.
 */

import { usePlaid } from "@/context/PlaidContext";
import { Loader2, Plus, Building2 } from "lucide-react";

interface Props {
  variant?: "button" | "card" | "row";
  onDone?: () => void;
}

export function ConnectAccountButton({ variant = "button", onDone }: Props) {
  const { openLink, isLoading, error } = usePlaid();

  const handleClick = () => openLink(onDone);

  if (variant === "row") {
    return (
      <div>
        <button
          onClick={handleClick}
          disabled={isLoading}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          {isLoading
            ? <Loader2 size={14} className="animate-spin shrink-0" />
            : <Building2 size={14} className="shrink-0" />
          }
          {isLoading ? "Opening Plaid…" : "Connect Account"}
        </button>
        {error && <p className="text-xs text-red-400 px-3 pb-1">{error}</p>}
      </div>
    );
  }

  if (variant === "card") {
    return (
      <button
        onClick={handleClick}
        disabled={isLoading}
        className="flex flex-col items-center justify-center gap-2 w-full p-5 rounded-2xl border-2 border-dashed border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors text-gray-500 hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? <Loader2 size={20} className="animate-spin" /> : <Building2 size={20} />}
        <span className="text-sm font-medium">
          {isLoading ? "Opening Plaid…" : "Connect Bank / Brokerage"}
        </span>
        {error && <p className="text-xs text-red-400 text-center">{error}</p>}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={isLoading}
        className="flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 rounded-xl transition-colors"
      >
        {isLoading ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        {isLoading ? "Opening…" : "Connect Account"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
