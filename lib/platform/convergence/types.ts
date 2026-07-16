/**
 * lib/platform/convergence/types.ts  (OPS-5 S9 — Off-ledger Convergence)
 *
 * THE canonical convergence model. Platform Operations keeps several INDEPENDENT
 * ledgers (JobRun, the alert store, SyncIssue, AuditLog). S9 is a PURE READ MODEL
 * that lets an operator understand them TOGETHER — it does NOT merge, replace,
 * flatten, or reinterpret them, and it persists nothing and emits no new events.
 * Each `ConvergenceEvent` is a read-only PROJECTION of one existing ledger row;
 * the correlation engine clusters projections into `ConvergenceEpisode`s that
 * answer: what happened · what caused it · what recovered · what participated.
 *
 * Trust reuses the platform-wide doctrine (observed/derived/…); a projected
 * ledger row is `observed`, a correlation-derived narrative is `derived`.
 */

import type { OperationalTier } from "@/lib/platform/history/types";

/** What an event does to the operational story. */
export type ConvergenceOutcome = "failure" | "degraded" | "recovery" | "action" | "info";

/** One read-only projection of ONE existing ledger row. */
export interface ConvergenceEvent {
  /** ISO datetime of the underlying row. */
  at: string;
  /** Which ledger it was projected from ("jobRun" | "alerts" | "syncIssue" | "auditLog"). */
  ledger: string;
  /** Event kind ("job-failed" | "job-recovered" | "manual-run" | "alert-fired" | "sync-issue" | "status-changed"). */
  kind: string;
  /** The correlation key (jobName / provider / resource / "-"). */
  subject: string;
  outcome: ConvergenceOutcome;
  /** System-generated context (no PII). */
  detail: string;
  /** Trust of the projected row (a ledger row is observed). */
  tier: OperationalTier;
}

/** A correlated cluster of participations across ledgers — one operational story. */
export interface ConvergenceEpisode {
  id: string;
  from: string; // ISO
  to: string;   // ISO
  title: string;
  /** Distinct correlation subjects in the episode. */
  subjects: readonly string[];
  /** Distinct ledgers that participated. */
  participants: readonly string[];
  /** The ordered events (chronological). */
  events: readonly ConvergenceEvent[];
  /** The derived operational narrative. */
  narrative: {
    happened: string;
    caused: string | null;
    recovered: string | null;
  };
  /** Worst tier across the events + the derived narrative. */
  trust: OperationalTier;
}

export interface ConvergenceResult {
  window: { from: string; to: string };
  episodes: readonly ConvergenceEpisode[];
  /** OPS-6E — the flat chronological event feed (newest-first, capped): the
   *  operational TIMELINE. The SAME projected events the episodes cluster — not a
   *  second event system, just the un-clustered view. */
  events: readonly ConvergenceEvent[];
  /** Total events projected (across ledgers) in the window. */
  eventCount: number;
  /** Ledgers that participated at all. */
  participants: readonly string[];
  checkedAt: string;
}
