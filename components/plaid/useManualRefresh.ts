"use client";

/**
 * useManualRefresh
 *
 * Shared client logic for the two "Refresh" affordances that hit the BULK
 * (no-plaidItemId) POST /api/plaid/refresh path — the topbar RefreshButton and
 * the sidebar's Refresh Data row. Extracted because both previously duplicated
 * the same handler and therefore the same bug: they only checked `res.ok` and
 * showed "Synced ✓" on any 200, even when every item was actually skipped for
 * being on its 60-minute manual-refresh cooldown (D2 Step 7B).
 *
 * The route already returns the truth in the 200 body: summary.results carries
 * one RefreshItemResult per item, and cooldown-skipped ones are tagged
 * { skipped: "cooldown", institution, retryAfterSeconds } (app/api/plaid/
 * refresh/route.ts:104-134). This hook reads that and resolves to an honest
 * phase:
 *   - "done"     every item actually refreshed (or there was nothing to skip)
 *   - "cooldown" nothing refreshed — every item was on cooldown
 *   - "partial"  some refreshed, some on cooldown (both facts surfaced)
 *   - "error"    non-2xx / network failure
 *
 * It never calls router.refresh() when nothing changed (all-cooldown), and does
 * for "done"/"partial". `banner` carries human-readable cooldown detail for the
 * two informational phases (null otherwise). Minutes use the same
 * Math.ceil(secs / 60) convention as InvestmentAccountsWidget's
 * AccountRefreshButton for consistency.
 *
 * Server side (route + lib/plaid/refreshCooldown.ts) is already correct and is
 * intentionally not touched — this is a client-only fix.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SPACE_DATA_REFRESHED_EVENT } from "@/lib/space-nav";

export type RefreshPhase = "idle" | "loading" | "done" | "error" | "cooldown" | "partial";

interface SkippedResult { institution?: string; retryAfterSeconds?: number; skipped?: string }

export interface ManualRefreshState {
  phase: RefreshPhase;
  /** Cooldown detail for the "cooldown"/"partial" phases; null otherwise. */
  banner: string | null;
  run: () => void;
}

/**
 * Tell the active SpaceDashboard host to re-fetch its OWN client-fetched data
 * (accounts/snapshots/transactions). router.refresh() re-renders the server
 * tree but never re-runs those client effects, so without this a single refresh
 * left the balances stale until a full reload (Part-2 fix). Space-agnostic (no
 * detail) — the bulk refresh spans every item, and only the active host listens.
 */
function signalDataRefreshed(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SPACE_DATA_REFRESHED_EVENT));
  }
}

/** secs → "42m" (ceil, matching AccountRefreshButton), or "shortly" if unknown. */
function minutesLabel(secs: unknown): string {
  return typeof secs === "number" && secs > 0 ? `${Math.ceil(secs / 60)}m` : "shortly";
}

/** "Amex (42m), Chase (5m)" — or "3 connections" if that list would be long. */
function describeSkipped(skipped: SkippedResult[]): string {
  const parts = skipped.map((r) => `${r.institution ?? "A connection"} (${minutesLabel(r.retryAfterSeconds)})`);
  const list = parts.join(", ");
  return list.length <= 48 ? list : `${skipped.length} connections`;
}

export function useManualRefresh(): ManualRefreshState {
  const router = useRouter();
  const [phase, setPhase] = useState<RefreshPhase>("idle");
  const [banner, setBanner] = useState<string | null>(null);

  async function run() {
    if (phase === "loading") return;
    setPhase("loading");
    setBanner(null);

    // Informational phases (cooldown/partial) linger a little longer than the
    // fleeting done/error tick so the remaining-time detail is readable. Same
    // mechanism as before (a single setTimeout → idle), just a phase-aware delay.
    let lingering = false;

    try {
      const res = await fetch("/api/plaid/refresh", { method: "POST" });
      if (!res.ok) throw new Error("Refresh failed");

      const summary = (await res.json().catch(() => ({}))) as { results?: SkippedResult[] };
      const results = Array.isArray(summary.results) ? summary.results : [];
      const skipped   = results.filter((r) => r.skipped === "cooldown");
      const refreshed = results.filter((r) => r.skipped !== "cooldown");

      if (skipped.length === 0) {
        // Genuine success (or nothing to refresh) — safe to claim "Synced".
        setPhase("done");
        router.refresh();
        signalDataRefreshed(); // re-run SpaceDashboard's self-fetched data (Part-2)
      } else if (refreshed.length > 0) {
        // Partial: surface BOTH facts — don't hide the successful refreshes, and
        // don't imply everything synced.
        setPhase("partial");
        setBanner(`Refreshed ${refreshed.length} · cooling down: ${describeSkipped(skipped)}`);
        lingering = true;
        router.refresh(); // some data did change
        signalDataRefreshed(); // re-run SpaceDashboard's self-fetched data (Part-2)
      } else {
        // Nothing refreshed — every item was on cooldown. No router.refresh().
        setPhase("cooldown");
        setBanner(`Cooling down — ${describeSkipped(skipped)}`);
        lingering = true;
      }
    } catch {
      setPhase("error");
    } finally {
      setTimeout(() => { setPhase("idle"); setBanner(null); }, lingering ? 6000 : 2500);
    }
  }

  return { phase, banner, run };
}
