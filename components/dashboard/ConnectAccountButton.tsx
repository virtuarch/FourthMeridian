"use client";

/**
 * ConnectAccountButton
 *
 * Opens the Plaid Link flow via PlaidContext — a single usePlaidLink instance
 * is managed at the provider level to prevent the "script loaded more than once" warning.
 */

import { usePlaid } from "@/context/PlaidContext";
import { Loader2, Plus, Building2 } from "lucide-react";
import { GlassButton } from "@/components/atlas/GlassButton";

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
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[var(--radius-sm)] text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
        >
          {isLoading
            ? <Loader2 size={14} className="animate-spin shrink-0" />
            : <Building2 size={14} className="shrink-0" />
          }
          {isLoading ? "Opening Plaid…" : "Connect Account"}
        </button>
        {error && <p className="text-xs text-[var(--coral-400)] px-3 pb-1">{error}</p>}
      </div>
    );
  }

  if (variant === "card") {
    return (
      <button
        onClick={handleClick}
        disabled={isLoading}
        className="group flex flex-col items-center justify-center gap-2 w-full p-5 rounded-[var(--radius-lg)] border-2 border-dashed border-[var(--border-hairline-strong)] hover:border-[rgba(125,168,255,.4)] hover:bg-[rgba(59,130,246,.06)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="text-[var(--text-muted)] group-hover:text-[var(--meridian-400)] transition-colors">
          {isLoading ? <Loader2 size={20} className="animate-spin" /> : <Building2 size={20} />}
        </span>
        <span className="text-sm font-medium text-[var(--text-muted)] group-hover:text-[var(--meridian-400)] transition-colors">
          {isLoading ? "Opening Plaid…" : "Connect Bank / Brokerage"}
        </span>
        {error && <p className="text-xs text-[var(--coral-400)] text-center">{error}</p>}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <GlassButton tone="meridian" size="sm" onClick={handleClick} disabled={isLoading}>
        {isLoading ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        {isLoading ? "Opening…" : "Connect Account"}
      </GlassButton>
      {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}
    </div>
  );
}
