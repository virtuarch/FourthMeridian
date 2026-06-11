"use client";

/**
 * components/plaid/PlaidLinkButton.tsx
 *
 * Thin wrapper around PlaidContext.openLink().
 * usePlaidLink lives in PlaidProvider (providers.tsx) — not here —
 * so the Plaid script is only injected once regardless of how many
 * PlaidLinkButton instances are mounted on the page.
 */

import { usePlaid } from "@/context/PlaidContext";
import { Plus, Loader2 } from "lucide-react";

interface Props {
  label?:     string;
  className?: string;
}

export function PlaidLinkButton({ label = "Add Account", className }: Props) {
  const { openLink, isLoading } = usePlaid();

  return (
    <button
      onClick={() => openLink()}
      disabled={isLoading}
      className={
        className ??
        "flex items-center gap-1.5 text-xs font-semibold text-blue-400 border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      }
    >
      {isLoading
        ? <Loader2 size={14} className="animate-spin" />
        : <Plus    size={14} />
      }
      {isLoading ? "Opening…" : label}
    </button>
  );
}
