/**
 * lib/platform/convergence/participants.ts  (OPS-5 S9)
 *
 * THE registry of convergence PARTICIPANTS. Each participant PROJECTS one existing
 * ledger's rows into read-only ConvergenceEvents — it never mutates, merges, or
 * reinterprets the ledger, and emits no new persisted event. Adding a ledger to
 * the operational story = adding one participant here (registry-driven,
 * provider-neutral, no switch statements). This mirrors the S7 source registry.
 *
 * Reuse (no duplicated persistence): jobRun rows, S5's alert store, SyncIssue, and
 * the AuditLog status-transition rows are read through the injected reader seam;
 * nothing here writes.
 */

import type { AlertRunSummary } from "@/lib/alerts/evaluate";
import type { ConvergenceEvent } from "@/lib/platform/convergence/types";

// ── Injected reads (the ONLY I/O; real impls in convergence.ts) ─────────────────

export interface ConvJobRun {
  jobName: string;
  startedAt: Date;
  status: string;
  trigger: string | null;
  errorSummary: string | null;
}
export interface ConvSyncIssue {
  provider: string;
  kind: string;
  plaidItemId: string | null;
  createdAt: Date;
}
export interface ConvTransition {
  at: Date;
  /** connection/item id (the subject). */
  subject: string;
  /** landing state ("ACTIVE" | "ERROR" | "DEGRADED" | …). */
  to: string;
  /** provider/source label. */
  source: string;
}

/** One user/beta lifecycle AuditLog row (OPS-6E). */
export interface ConvLifecycleEvent {
  at: Date;
  /** AuditAction (BETA_ACCESS_* / ACCOUNT_DEACTIVATED / ACCOUNT_REACTIVATED). */
  action: string;
}

export interface ConvergenceReaders {
  now: Date;
  jobRuns(from: Date, to: Date): Promise<ConvJobRun[]>;
  alertRuns(limit: number): Promise<AlertRunSummary[]>;
  syncIssues(from: Date, to: Date): Promise<ConvSyncIssue[]>;
  statusTransitions(from: Date, to: Date): Promise<ConvTransition[]>;
  /** OPS-6E — beta/account lifecycle AuditLog rows in the window. */
  lifecycleEvents(from: Date, to: Date): Promise<ConvLifecycleEvent[]>;
}

export interface ConvergenceWindow { from: string; to: string; }

export interface ConvergenceParticipant {
  ledger: string;
  label: string;
  project(readers: ConvergenceReaders, window: ConvergenceWindow): Promise<ConvergenceEvent[]>;
}

function startOfDay(iso: string): Date { return new Date(`${iso}T00:00:00.000Z`); }
function endOfDay(iso: string): Date { return new Date(`${iso}T23:59:59.999Z`); }

// ── jobRun participant — failures, recoveries, manual runs ──────────────────────

const jobRunParticipant: ConvergenceParticipant = {
  ledger: "jobRun",
  label: "Jobs",
  async project(readers, window) {
    const rows = await readers.jobRuns(startOfDay(window.from), endOfDay(window.to));
    return rows.map((r) => {
      const manual = r.trigger === "manual";
      const failed = r.status === "failed";
      return {
        at: r.startedAt.toISOString(),
        ledger: "jobRun",
        kind: manual ? "manual-run" : failed ? "job-failed" : "job-ran",
        subject: r.jobName,
        outcome: manual ? "action" : failed ? "failure" : "recovery",
        detail: manual
          ? `manual run of ${r.jobName} (${r.status})`
          : failed
            ? `${r.jobName} failed${r.errorSummary ? `: ${r.errorSummary}` : ""}`
            : `${r.jobName} ${r.status}`,
        tier: "observed",
      };
    });
  },
};

// ── alerts participant — firings from S5's alert store ──────────────────────────

const alertsParticipant: ConvergenceParticipant = {
  ledger: "alerts",
  label: "Alerts",
  async project(readers, window) {
    const from = startOfDay(window.from).toISOString(), to = endOfDay(window.to).toISOString();
    const runs = await readers.alertRuns(200);
    const events: ConvergenceEvent[] = [];
    for (const run of runs) {
      for (const f of run.fired) {
        if (f.deliveredAtISO >= from && f.deliveredAtISO <= to) {
          events.push({
            at: f.deliveredAtISO, ledger: "alerts", kind: "alert-fired", subject: f.ruleId,
            outcome: f.severity === "critical" ? "failure" : "degraded",
            detail: `alert ${f.ruleId} (${f.severity}) fired`, tier: "observed",
          });
        }
      }
    }
    return events;
  },
};

// ── syncIssue participant — provider sync-integrity issues ──────────────────────

const syncIssueParticipant: ConvergenceParticipant = {
  ledger: "syncIssue",
  label: "Sync Issues",
  async project(readers, window) {
    const rows = await readers.syncIssues(startOfDay(window.from), endOfDay(window.to));
    return rows.map((r) => ({
      at: r.createdAt.toISOString(), ledger: "syncIssue", kind: "sync-issue",
      subject: r.plaidItemId ?? r.provider,
      outcome: "degraded" as const,
      detail: `${r.provider} sync issue: ${r.kind}`, tier: "observed" as const,
    }));
  },
};

// ── auditLog participant — provider status transitions ──────────────────────────

const auditTransitionParticipant: ConvergenceParticipant = {
  ledger: "auditLog",
  label: "Status Changes",
  async project(readers, window) {
    const rows = await readers.statusTransitions(startOfDay(window.from), endOfDay(window.to));
    return rows.map((r) => {
      const recovered = r.to === "ACTIVE" || r.to === "HEALTHY";
      return {
        at: r.at.toISOString(), ledger: "auditLog", kind: "status-changed", subject: r.subject,
        outcome: recovered ? ("recovery" as const) : ("degraded" as const),
        detail: `${r.source} → ${r.to}`, tier: "observed" as const,
      };
    });
  },
};

// ── lifecycle participant (OPS-6E) — beta + account lifecycle AuditLog rows ──────

const LIFECYCLE_META: Record<string, { kind: string; outcome: ConvergenceEvent["outcome"]; detail: string }> = {
  BETA_ACCESS_APPROVED: { kind: "beta-approved", outcome: "action", detail: "beta access approved — invite emailed" },
  BETA_ACCESS_REDEEMED: { kind: "beta-redeemed", outcome: "info", detail: "beta invite redeemed — user registered" },
  BETA_ACCESS_DENIED: { kind: "beta-denied", outcome: "info", detail: "beta access denied" },
  ACCOUNT_DEACTIVATED: { kind: "account-deactivated", outcome: "action", detail: "user account deactivated" },
  ACCOUNT_REACTIVATED: { kind: "account-reactivated", outcome: "recovery", detail: "user account reactivated" },
};

const lifecycleParticipant: ConvergenceParticipant = {
  ledger: "lifecycle",
  label: "User & Beta Lifecycle",
  async project(readers, window) {
    const rows = await readers.lifecycleEvents(startOfDay(window.from), endOfDay(window.to));
    return rows.map((r) => {
      const meta = LIFECYCLE_META[r.action] ?? { kind: r.action.toLowerCase(), outcome: "info" as const, detail: r.action };
      // No PII in the timeline — the action, not the user.
      return { at: r.at.toISOString(), ledger: "lifecycle", kind: meta.kind, subject: "-", outcome: meta.outcome, detail: meta.detail, tier: "observed" as const };
    });
  },
};

export const CONVERGENCE_PARTICIPANTS: readonly ConvergenceParticipant[] = [
  jobRunParticipant, alertsParticipant, syncIssueParticipant, auditTransitionParticipant, lifecycleParticipant,
];
