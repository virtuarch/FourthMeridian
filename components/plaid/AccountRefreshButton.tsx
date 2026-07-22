"use client";

/**
 * components/plaid/AccountRefreshButton.tsx
 *
 * Per-connection "Refresh" control that re-syncs one Plaid item via the shared
 * POST /api/plaid/refresh path (with its 429 cooldown handling + copy). Kept in
 * the neutral Plaid domain so any surface can reuse the exact same button
 * instead of forking the refresh flow.
 *
 * Extracted verbatim from the retired InvestmentAccountsWidget (P1 closeout —
 * investment_accounts retirement). Its sole live consumer is the Investments
 * Perspective's InvestmentConnectionsCard; behavior is unchanged.
 */

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

export function AccountRefreshButton({ plaidItemId, onDone }: { plaidItemId: string; onDone: () => void }) {
  const [phase, setPhase] = useState<"idle" | "loading">("idle");
  const [note, setNote] = useState("");

  async function run() {
    if (phase === "loading") return;
    setPhase("loading");
    setNote("");
    try {
      const res = await fetch("/api/plaid/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plaidItemId }),
      });
      if (res.status === 429) {
        const d = await res.json().catch(() => ({}));
        const secs = typeof d.retryAfterSeconds === "number" ? d.retryAfterSeconds : null;
        setNote(secs ? `Cooling down — try again in ${Math.ceil(secs / 60)}m.` : "Cooling down — try again shortly.");
        return;
      }
      if (!res.ok) throw new Error("Refresh failed");
      onDone();
    } catch {
      setNote("Refresh failed — try again.");
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={phase === "loading"}
        className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-2.5 py-1.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors disabled:opacity-50"
      >
        {phase === "loading" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        {phase === "loading" ? "Refreshing…" : "Refresh"}
      </button>
      {note && <p className="mt-1 text-xs text-[var(--text-muted)]">{note}</p>}
    </div>
  );
}
