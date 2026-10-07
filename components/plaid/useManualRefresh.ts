"use client";

/**
 * useManualRefresh
 *
 * Shared client logic for the two "Refresh" affordances — the topbar
 * RefreshButton and the sidebar's Refresh Data row. Both call the customer's
 * provider-agnostic Refresh All, POST /api/refresh/all (P1), which refreshes
 * EVERY eligible financial authority (Plaid banking and investments, crypto
 * wallets) and returns one structured outcome per authority
 * (lib/refresh/outcomes.ts). Before P1 they posted /api/plaid/refresh, so
 * "Refresh" quietly meant "refresh Plaid".
 *
 * The hook resolves the report to an honest phase and a terse banner:
 *   - "done"     every authority STARTED (or there was nothing to refresh)
 *   - "partial"  some STARTED, some skipped/refused/failed — both facts shown
 *   - "cooldown" nothing started and nothing failed — all skipped or refused
 *                (cooldown, in flight, not refreshable, paused)
 *   - "error"    non-2xx / network failure, or nothing started and ≥1 FAILED
 *
 * It never calls router.refresh() when nothing changed, and does when
 * something STARTED. Never "Synced" when something was skipped.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SPACE_DATA_REFRESHED_EVENT } from "@/lib/space-nav";

// P1 — the outcome vocabulary and its one-sentence description live with the
// vocabulary (lib/refresh/outcomes.ts) so the operator's Customer Success action
// and this customer button describe the SAME report the same way. Re-exported
// here for the callers and tests that import them from the hook.
export { describeRefreshOutcomes, phaseForOutcomes } from "@/lib/refresh/outcomes";
export type { RefreshPhase } from "@/lib/refresh/outcomes";
import { describeRefreshOutcomes, phaseForOutcomes, type RefreshOutcomeLike, type RefreshPhase } from "@/lib/refresh/outcomes";

export interface ManualRefreshState {
  phase: RefreshPhase;
  /** Detail for the informational phases; null otherwise. */
  banner: string | null;
  run: () => void;
}

function signalDataRefreshed(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SPACE_DATA_REFRESHED_EVENT));
  }
}

export function useManualRefresh(): ManualRefreshState {
  const router = useRouter();
  const [phase, setPhase] = useState<RefreshPhase>("idle");
  const [banner, setBanner] = useState<string | null>(null);

  async function run() {
    if (phase === "loading") return;
    setPhase("loading");
    setBanner(null);
    let lingering = false;

    try {
      const res = await fetch("/api/refresh/all", { method: "POST" });
      if (!res.ok) throw new Error("Refresh failed");

      const report = (await res.json().catch(() => ({}))) as { outcomes?: RefreshOutcomeLike[] };
      const outcomes = Array.isArray(report.outcomes) ? report.outcomes : [];
      const next = phaseForOutcomes(outcomes);
      setPhase(next);
      if (next === "done") {
        router.refresh();
        signalDataRefreshed();
      } else {
        setBanner(describeRefreshOutcomes(outcomes));
        lingering = true;
        if (next === "partial") {
          router.refresh();
          signalDataRefreshed();
        }
      }
    } catch {
      setPhase("error");
    } finally {
      setTimeout(() => { setPhase("idle"); setBanner(null); }, lingering ? 6000 : 2500);
    }
  }

  return { phase, banner, run };
}
