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

export type RefreshPhase = "idle" | "loading" | "done" | "error" | "cooldown" | "partial";

/** The subset of lib/refresh/outcomes.ts the client reads. */
interface Outcome {
  kind?: string;
  label?: string;
  decision?: "STARTED" | "SKIPPED" | "REFUSED" | "FAILED";
  reason?: string | null;
  retryAfterSeconds?: number;
}

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

/** secs → "42m" (ceil), or "" when unknown. */
function minutesLabel(secs: unknown): string {
  return typeof secs === "number" && secs > 0 ? ` (${Math.ceil(secs / 60)}m)` : "";
}

/** PURE — the terse banner: "3 refreshed · 1 on cooldown (42m) · 1 not refreshable". Exported for tests. */
export function describeRefreshOutcomes(outcomes: Outcome[]): string {
  const started = outcomes.filter((o) => o.decision === "STARTED").length;
  const cooldown = outcomes.filter((o) => o.reason === "COOLDOWN");
  const inFlight = outcomes.filter((o) => o.reason === "IN_FLIGHT").length;
  const rate = outcomes.filter((o) => o.reason === "RATE_LIMITED").length;
  const notRefreshable = outcomes.filter((o) => o.reason === "NOT_REFRESHABLE" || o.reason === "NOT_ENTITLED").length;
  const paused = outcomes.filter((o) => o.reason === "NOT_ADMITTED").length;
  const budget = outcomes.filter((o) => o.reason === "BUDGET").length;
  const failed = outcomes.filter((o) => o.decision === "FAILED").length;
  const longestWait = cooldown.reduce((m, o) => Math.max(m, o.retryAfterSeconds ?? 0), 0);
  const parts: string[] = [];
  if (started) parts.push(`${started} refreshed`);
  if (cooldown.length) parts.push(`${cooldown.length} on cooldown${minutesLabel(longestWait)}`);
  if (inFlight) parts.push(`${inFlight} already syncing`);
  if (rate) parts.push(`${rate} over the hourly limit`);
  if (notRefreshable) parts.push(`${notRefreshable} not refreshable`);
  if (paused) parts.push(`${paused} paused by the platform`);
  if (budget) parts.push(`${budget} deferred`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** PURE — the phase a report resolves to. Exported for tests. */
export function phaseForOutcomes(outcomes: Outcome[]): Exclude<RefreshPhase, "idle" | "loading"> {
  const started = outcomes.filter((o) => o.decision === "STARTED").length;
  const failed = outcomes.filter((o) => o.decision === "FAILED").length;
  if (outcomes.length === 0 || started === outcomes.length) return "done";
  if (started > 0) return "partial";
  return failed > 0 ? "error" : "cooldown";
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

      const report = (await res.json().catch(() => ({}))) as { outcomes?: Outcome[] };
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
