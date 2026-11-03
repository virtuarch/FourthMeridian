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

import type { IncidentVerdict } from "@/lib/platform/incidents/intelligence/types";
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
/**
 * PB-1 Phase 2 (R3) — one incident row AS THE INTELLIGENCE MODULE JUDGED IT
 * (Platform Ops tier, identity-free). Convergence no longer reads SyncIssue
 * or re-derives state: D1/D2/D2b/D3/D10 are the module's. No `detail`.
 */
export interface ConvSyncIssue {
  id: string;
  provider: string;
  kind: string;
  plaidItemId: string | null;
  financialAccountId: string | null;
  rowClass: IncidentVerdict["rowClass"];
  state: IncidentVerdict["state"];
  closure: IncidentVerdict["closure"];
  severity: IncidentVerdict["severity"];
  domain: string;
  /** Registered operation key, or null (never a raw stage). */
  operation: string | null;
  /** D8 — episode identity (incidentKey, shared across recurrence generations). */
  episodeKey: string;
  /** D7 — since / recency, ISO. */
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** Operator-safe label resolved by the reader (institution / opaque account ref). */
  subjectLabel: string | null;
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
  /** PB-1 R3 (D5) — the last syncIssues scan's completeness; absent/null ⇒ not reported. */
  incidentScan?(): { truncated: boolean; scanned: number; cap: number } | null;
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

/**
 * The semantic correlation key for a sync issue. ALWAYS item-scoped, so a
 * fallback can never merge two institutions: an issue with no runId (pre-Phase-4
 * rows) still correlates only with other rows for the SAME PlaidItem, and one
 * with no item at all correlates only with itself.
 */
/**
 * D8 — one operational story per incident EPISODE (incidentKey, which a
 * recurrence shares), scoped to its subject so a key can never span two
 * subjects. Replaces the item + detail.runId key (detail is never read here).
 */
function correlationKeyFor(r: ConvSyncIssue): string {
  const subject = r.plaidItemId ?? r.financialAccountId ?? `provider:${r.provider}`;
  return `plaidItem:${subject}|episode:${r.episodeKey}`;
}

/** The event outcome, read off the MODULE's verdict (harness MODULE_OPEN for convergence ⇔ state === "active"). */
export function syncIssueOutcome(r: Pick<ConvSyncIssue, "rowClass" | "state" | "closure">): "degraded" | "recovery" | "action" {
  if (r.rowClass === "incident" && r.state === "active") return "degraded";
  if (r.rowClass === "incident" && r.state === "resolved" && r.closure !== "connection-removed") return "recovery";
  return "action";
}

/** Where a row sits on the timeline: closed rows at their resolution, open ones at their latest occurrence (D7). */
export function convergenceInstant(r: Pick<ConvSyncIssue, "state" | "resolvedAt" | "lastSeenAt">): string {
  return (r.state === "resolved" || r.state === "archived") && r.resolvedAt ? r.resolvedAt : r.lastSeenAt;
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
    return rows.map((r) => {
      const outcome = syncIssueOutcome(r);

      // Human-first subject: institution or account reference where we could resolve
      // one, never a bare cuid and never the literal string "PLAID".
      const subject = r.subjectLabel ?? r.plaidItemId ?? r.provider;

      const note =
        r.rowClass === "evidence"   ? " — expected provider lifecycle"
      : r.rowClass === "superseded" ? " — superseded (produced by a retired rule)"
      : r.state === "acknowledged"  ? " — acknowledged"
      : r.state === "recovering"    ? " — recovering"
      : r.state === "stale-unverified" ? " — stale (needs verification)"
      : r.closure === "connection-removed" ? " — connection removed"
      : r.state === "resolved" || r.state === "archived" ? " — recovered"
      : "";

      return {
        at: convergenceInstant(r), ledger: "syncIssue", kind: "sync-issue",
        subject,
        outcome,
        // Derived vocabulary only (severity · domain · kind · operation) — no customer data, no detail.
        detail: `${r.severity} · ${r.domain} · ${r.kind.replace(/_/g, " ").toLowerCase()}${r.operation ? ` (${r.operation})` : ""}${note}`,
        tier: "observed" as const,
        // Same incident episode on the same subject = same operational story (D8).
        correlationKey: correlationKeyFor(r),
      };
    });
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
  // PRE-BETA-OPS-CLOSE Phase 3 — provider-revocation evidence.
  ACCOUNT_DELETION_REVOCATION_FAILED: {
    kind: "revocation-failed", outcome: "degraded",
    detail: "account deletion HELD — upstream Plaid revocation failed, retrying daily",
  },
  // The critical one. It means a user's data is gone from Fourth Meridian while
  // their bank consent may still be live at Plaid, and only a human can now
  // revoke it. It must never read as a routine lifecycle event.
  ACCOUNT_DELETED_UNREVOKED: {
    kind: "deleted-unrevoked", outcome: "failure",
    detail: "CRITICAL — account deleted WITHOUT confirmed provider revocation; manual Plaid revocation required",
  },
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
