/**
 * lib/alerts/run.ts  (OPS-5 S5)
 *
 * The impure orchestrator — the ONE place that touches I/O for alerting:
 *   1. GATHER the six existing authorities, each best-effort (a gather failure
 *      → null, never a fabricated or suppressed breach).
 *   2. Resolve enabled state from PlatformSetting overrides.
 *   3. Read recent evaluate-alerts JobRun summaries → the suppression state (the
 *      ledger IS the alert store; no new table).
 *   4. evaluateAlertRules() → signals; decideDeliveries() → what to send now.
 *   5. Deliver via OPS-1 sendEmail() (the destination), best-effort.
 *   6. Return the AlertRunSummary — persisted as the JobRun.summary by runJob(),
 *      which makes it both the next cycle's suppression input and the UI history.
 *
 * FULLY INJECTABLE: every I/O boundary is a dep with a real default, so the
 * orchestrator unit-tests with no database, no network, no clock (the house
 * pattern — lib/jobs/dispatch.ts, lib/platform/resource-freshness.ts).
 */

import "server-only";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import { checkScheduledJobHealth } from "@/lib/jobs/health";
import { getConnectionHealth } from "@/lib/connections/health";
import { checkResourceFreshness } from "@/lib/platform/resource-freshness";
import { getAiFailureHealth } from "@/lib/platform/ai/failures";
import { getAiSpendHealth } from "@/lib/platform/ai/spend-health";
import { getActiveIncidentPage } from "@/lib/platform/incidents/projections";
import { foldSyncIncidents } from "@/lib/alerts/sync-incidents";
import { loadPolicyAssignmentHealth } from "@/lib/platform/policy-assignment-health";
import { ALERT_RULES, type AlertRuleDefinition, type AlertSeverity } from "@/lib/alerts/rules";
import type { AuthorityOutputs } from "@/lib/alerts/authorities";
import {
  buildAlertEmailData,
  decideDeliveries,
  evaluateAlertRules,
  extractPriorFired,
  resolveEnabled,
  type AlertEmailData,
  type AlertFiredRecord,
  type AlertRuleOutcome,
  type AlertRunSummary,
  type AlertUndelivered,
} from "@/lib/alerts/evaluate";
import { captureAlertDeliveryFailure } from "@/lib/alerts/delivery-capture";
import { latestAlertEvaluation, type AlertLatestEvaluation } from "@/lib/alerts/latest-evaluation";
import { currentJobRun } from "@/lib/jobs/run";

/** JobRun name of the alert-evaluation job (registered in lib/jobs/registry.ts). */
export const ALERT_JOB_NAME = "evaluate-alerts";

/** How many recent evaluate-alerts summaries to read for suppression/history. */
const RECENT_RUNS_EXAMINED = 10;

// ── Injectable dependencies ──────────────────────────────────────────────────────

export interface AlertRunDeps {
  now?: Date;
  /** Gather the five authority outputs (each best-effort → null on failure). */
  gatherAuthorities?: () => Promise<AuthorityOutputs>;
  /** PlatformSetting overrides of rule enabled state (key → "true"/"false"). */
  loadSettings?: () => Promise<ReadonlyMap<string, string>>;
  /** Recent evaluate-alerts JobRun summaries (newest first). */
  loadRecentRuns?: (limit: number) => Promise<AlertRunSummary[]>;
  /** The destination address, or null when unconfigured. */
  resolveDestination?: () => string | null;
  /** Deliver the alert email; returns the OPS-1 EmailResult status (+ transport name). */
  sendAlertEmail?: (to: string, data: AlertEmailData) => Promise<{ status: string; provider?: string }>;
  /** Re-notify window override (ms). */
  renotifyMs?: number;
  /** Rule set override (tests). */
  rules?: readonly AlertRuleDefinition[];
  /**
   * OBS-003 — the NODE_ENV this cycle runs under. Only "development" and
   * "test" may treat a CAPTURED message as delivered; anywhere else the capture
   * transport means there is NO mail transport, and a breach that went into an
   * in-memory buffer must not be recorded as fired (it would be suppressed for
   * DEFAULT_RENOTIFY_HOURS while nobody was told).
   */
  environment?: string | undefined;
  /**
   * OBS-015 — true when THIS run's JobRun start row failed to write (runJob's
   * currentJobRun().id === null). With no row, the fired[] record this cycle
   * returns can never be read back as suppression state, so every wake would
   * re-deliver every breach (up to 96 mails a day). Delivery is circuit-broken
   * and the summary says so. Defaults to reading the ambient runJob context.
   */
  ledgerStartWriteFailed?: () => boolean;
}

/** Environments in which the capture transport is the EXPECTED transport. */
function captureIsExpected(environment: string | undefined): boolean {
  return environment === "development" || environment === "test";
}

// ── Real default I/O ─────────────────────────────────────────────────────────────

async function gatherAuthoritiesDefault(): Promise<AuthorityOutputs> {
  const [jobHealth, connectionHealth, resourceFreshness, aiFailures, aiSpend, syncIncidents, policyAssignments] = await Promise.all([
    checkScheduledJobHealth().catch((e) => (warn("job-health", e), null)),
    getConnectionHealth().catch((e) => (warn("connection-health", e), null)),
    checkResourceFreshness().catch((e) => (warn("resource-freshness", e), null)),
    // OPERATIONALIZATION P0 — the AI failure fold over the last 24h.
    getAiFailureHealth(24).catch((e) => (warn("ai-failures", e), null)),
    // BETA C7 — estimated AI spend (fleet + max per customer) and the unpriced
    // count over the last 24h, with the two operator thresholds read through
    // the platform-settings descriptors.
    getAiSpendHealth(24).catch((e) => (warn("ai-spend", e), null)),
    // OBS-004 — the ACTIVE sync incidents (state + severity decided by the
    // semantic authority inside the projection), folded to the engine's slice.
    getActiveIncidentPage(SYNC_INCIDENT_SCAN)
      .then((page) => foldSyncIncidents(page.incidents, page.scanTruncated, new Date()))
      .catch((e) => (warn("sync-incidents", e), null)),
    // Owner ruling (2026-10-30) — missing / invalid customer policy-group
    // assignments (bounded, read-only; the same read as the Attention item).
    loadPolicyAssignmentHealth().catch((e) => (warn("policy-assignments", e), null)),
  ]);
  return { jobHealth, connectionHealth, resourceFreshness, aiFailures, aiSpend, syncIncidents, policyAssignments };
}

/** Unresolved SyncIssue rows scanned per cycle (the projection's default page). */
const SYNC_INCIDENT_SCAN = 200;

function warn(what: string, e: unknown): void {
  console.warn(`[alerts] authority "${what}" failed to gather (non-fatal):`, e);
}

/** Load the PlatformSetting enabled-overrides (also used by the read route). */
export async function loadAlertSettings(): Promise<ReadonlyMap<string, string>> {
  const rows = await db.platformSetting.findMany({
    where: { key: { startsWith: "alert_rule_enabled:" } },
    select: { key: true, value: true },
  });
  return new Map(rows.map((r) => [r.key, r.value] as const));
}

/** Recent evaluate-alerts summaries, newest first (also used by the read route). */
export async function loadRecentAlertRuns(limit: number = RECENT_RUNS_EXAMINED): Promise<AlertRunSummary[]> {
  const rows = await db.jobRun.findMany({
    where: { jobName: ALERT_JOB_NAME, status: "succeeded" },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: { summary: true },
  });
  const out: AlertRunSummary[] = [];
  for (const r of rows) {
    const s = r.summary as AlertRunSummary | null;
    if (s && Array.isArray(s.fired)) out.push(s);
  }
  return out;
}

/**
 * UX-P1 — the LATEST evaluation's per-rule outcomes, projected without the
 * destination address. This is the one read that may call a rule "firing": it
 * is the most recent cycle's verdict, not the delivery history. Null when the
 * evaluator has never recorded a run.
 */
export async function loadLatestAlertEvaluation(): Promise<AlertLatestEvaluation | null> {
  return latestAlertEvaluation(await loadRecentAlertRuns(1));
}

function resolveDestinationDefault(): string | null {
  return env.PLATFORM_ALERTS_EMAIL;
}

async function sendAlertEmailDefault(to: string, data: AlertEmailData): Promise<{ status: string; provider?: string }> {
  const res = await sendEmail("platform-alert", to, data as unknown as Record<string, unknown>, { key: "PLATFORM_ALERT", recipientUserId: null });
  return { status: res.status, provider: res.provider };
}

/** OBS-015 — the ambient runJob context: a null id means the start write failed. */
function ledgerStartWriteFailedDefault(): boolean {
  const run = currentJobRun();
  return run !== null && run.id === null;
}

// ── The orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run one alert-evaluation cycle. Returns the AlertRunSummary (the job body
 * returns this to runJob so it lands in the JobRun ledger). Never throws —
 * every external effect is guarded; a failure is recorded in the summary.
 */
export async function evaluatePlatformAlerts(deps: AlertRunDeps = {}): Promise<AlertRunSummary> {
  const now = deps.now ?? new Date();
  const rules = deps.rules ?? ALERT_RULES;
  const gather = deps.gatherAuthorities ?? gatherAuthoritiesDefault;
  const loadSettings = deps.loadSettings ?? loadAlertSettings;
  const loadRecentRuns = deps.loadRecentRuns ?? loadRecentAlertRuns;
  const resolveDestination = deps.resolveDestination ?? resolveDestinationDefault;
  const sendAlertEmail = deps.sendAlertEmail ?? sendAlertEmailDefault;
  const environment = deps.environment ?? process.env.NODE_ENV;
  const ledgerStartWriteFailed = deps.ledgerStartWriteFailed ?? ledgerStartWriteFailedDefault;

  const [authorities, settings, recentRuns] = await Promise.all([gather(), loadSettings(), loadRecentRuns(RECENT_RUNS_EXAMINED)]);

  const isEnabled = (ruleId: string): boolean => {
    const rule = rules.find((r) => r.id === ruleId);
    return rule ? resolveEnabled(rule, settings) : false;
  };

  const signals = evaluateAlertRules(authorities, isEnabled, rules);
  const priorFired = extractPriorFired(recentRuns);
  const { toSend, suppressed } = decideDeliveries(signals, priorFired, now.getTime(), deps.renotifyMs);

  // ── Deliver (best-effort) ──────────────────────────────────────────────────
  const destination = resolveDestination();
  let deliveryStatus: AlertRunSummary["deliveryStatus"] = "none";
  let delivered: typeof toSend = [];
  let undelivered: AlertUndelivered | null = null;

  if (toSend.length > 0) {
    if (ledgerStartWriteFailed()) {
      // OBS-015 — circuit breaker. Nothing this run records can be read back,
      // so a delivery now would be repeated at every wake. Say so, send nothing.
      deliveryStatus = "skipped";
      undelivered = { reason: "LEDGER_WRITE_FAILED", breaches: toSend.length };
      console.error(`[alerts] ${toSend.length} breach(es) NOT delivered: this run's JobRun start row failed to write, so suppression cannot persist (OBS-015 circuit breaker).`);
    } else if (!destination) {
      deliveryStatus = "skipped"; // firing, but no destination configured
      undelivered = { reason: "NO_DESTINATION", breaches: toSend.length };
    } else {
      try {
        const res = await sendAlertEmail(destination, buildAlertEmailData(toSend, now.toISOString()));
        deliveryStatus = normalizeStatus(res.status);
        if (deliveryStatus === "sent") {
          // The provider ACCEPTED the message: record the breaches as fired,
          // which suppresses them next cycle.
          delivered = toSend;
        } else if (deliveryStatus === "captured") {
          if (captureIsExpected(environment)) {
            // Development/test: capture IS the transport; treat as delivered so
            // the suppression semantics exercise locally exactly as they do live.
            delivered = toSend;
          } else {
            // OBS-003 — outside development the capture transport means NO mail
            // transport (RESEND_API_KEY absent). The message went into an
            // in-memory buffer nobody reads. Recording it as fired would silence
            // the breach for DEFAULT_RENOTIFY_HOURS; recording nothing lets the
            // next cycle retry — and the summary says, loudly, what happened.
            deliveryStatus = "skipped";
            undelivered = { reason: "NO_EMAIL_TRANSPORT", breaches: toSend.length };
            console.error(`[alerts] ${toSend.length} breach(es) NOT delivered: the email chokepoint selected the capture transport (no RESEND_API_KEY) in NODE_ENV=${environment ?? "(unset)"}.`);
          }
        } else {
          // skipped / error from the transport: nothing recorded, next cycle retries.
          undelivered = { reason: "SEND_ERROR", breaches: toSend.length };
          deliveryStatus = "error";
          captureAlertDeliveryFailure(res, toSend.length);
        }
      } catch (e) {
        console.warn("[alerts] email delivery failed (non-fatal):", e);
        deliveryStatus = "error";
        undelivered = { reason: "SEND_ERROR", breaches: toSend.length };
        captureAlertDeliveryFailure(e, toSend.length);
      }
    }
  }

  const deliveredAtISO = now.toISOString();
  const fired: AlertFiredRecord[] = delivered.map((s) => ({
    ruleId: s.ruleId,
    kind: s.kind,
    dedupeKey: s.dedupeKey,
    severity: s.severity,
    summary: s.summary,
    deliveredAtISO,
  }));

  // ── Per-rule outcomes (all rules, for the summary + UI) ─────────────────────
  const ruleOutcomes: AlertRuleOutcome[] = rules.map((rule) => {
    const breaches = signals.filter((s) => s.ruleId === rule.id);
    return {
      id: rule.id,
      kind: rule.kind,
      enabled: resolveEnabled(rule, settings),
      live: rule.live,
      firing: breaches.length > 0,
      breaches: breaches.length,
      severity: worstSeverity(breaches.map((b) => b.severity)),
    };
  });

  const liveCount = rules.filter((r) => r.live).length;
  const enabledCount = rules.filter((r) => resolveEnabled(r, settings)).length;

  return {
    evaluatedAtISO: now.toISOString(),
    // OBS-011 — presence only; the address never enters the ledger.
    destinationConfigured: Boolean(destination),
    deliveryStatus,
    undelivered,
    counts: {
      evaluated: rules.length,
      live: liveCount,
      enabled: enabledCount,
      firing: signals.length,
      delivered: delivered.length,
      suppressed: suppressed.length,
    },
    rules: ruleOutcomes,
    fired,
  };
}

function normalizeStatus(status: string): AlertRunSummary["deliveryStatus"] {
  return status === "sent" || status === "captured" || status === "skipped" || status === "error" ? status : "error";
}

function worstSeverity(severities: readonly AlertSeverity[]): AlertSeverity | null {
  if (severities.includes("critical")) return "critical";
  if (severities.includes("warning")) return "warning";
  return null;
}
