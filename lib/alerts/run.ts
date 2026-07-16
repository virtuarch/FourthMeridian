/**
 * lib/alerts/run.ts  (OPS-5 S5)
 *
 * The impure orchestrator — the ONE place that touches I/O for alerting:
 *   1. GATHER the three existing authorities, each best-effort (a gather failure
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
} from "@/lib/alerts/evaluate";

/** JobRun name of the alert-evaluation job (registered in lib/jobs/registry.ts). */
export const ALERT_JOB_NAME = "evaluate-alerts";

/** How many recent evaluate-alerts summaries to read for suppression/history. */
const RECENT_RUNS_EXAMINED = 10;

// ── Injectable dependencies ──────────────────────────────────────────────────────

export interface AlertRunDeps {
  now?: Date;
  /** Gather the three authority outputs (each best-effort → null on failure). */
  gatherAuthorities?: () => Promise<AuthorityOutputs>;
  /** PlatformSetting overrides of rule enabled state (key → "true"/"false"). */
  loadSettings?: () => Promise<ReadonlyMap<string, string>>;
  /** Recent evaluate-alerts JobRun summaries (newest first). */
  loadRecentRuns?: (limit: number) => Promise<AlertRunSummary[]>;
  /** The destination address, or null when unconfigured. */
  resolveDestination?: () => string | null;
  /** Deliver the alert email; returns the OPS-1 EmailResult status. */
  sendAlertEmail?: (to: string, data: AlertEmailData) => Promise<{ status: string }>;
  /** Re-notify window override (ms). */
  renotifyMs?: number;
  /** Rule set override (tests). */
  rules?: readonly AlertRuleDefinition[];
}

// ── Real default I/O ─────────────────────────────────────────────────────────────

async function gatherAuthoritiesDefault(): Promise<AuthorityOutputs> {
  const [jobHealth, connectionHealth, resourceFreshness] = await Promise.all([
    checkScheduledJobHealth().catch((e) => (warn("job-health", e), null)),
    getConnectionHealth().catch((e) => (warn("connection-health", e), null)),
    checkResourceFreshness().catch((e) => (warn("resource-freshness", e), null)),
  ]);
  return { jobHealth, connectionHealth, resourceFreshness };
}

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

function resolveDestinationDefault(): string | null {
  return env.PLATFORM_ALERTS_EMAIL;
}

async function sendAlertEmailDefault(to: string, data: AlertEmailData): Promise<{ status: string }> {
  const res = await sendEmail("platform-alert", to, data as unknown as Record<string, unknown>);
  return { status: res.status };
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

  if (toSend.length > 0) {
    if (!destination) {
      deliveryStatus = "skipped"; // firing, but no destination configured
    } else {
      try {
        const res = await sendAlertEmail(destination, buildAlertEmailData(toSend, now.toISOString()));
        deliveryStatus = normalizeStatus(res.status);
        // A successful hand-off (sent / captured) records the breaches as fired,
        // which suppresses them next cycle. A skip/error records nothing, so the
        // next cycle retries the delivery rather than silently dropping it.
        if (deliveryStatus === "sent" || deliveryStatus === "captured") delivered = toSend;
      } catch (e) {
        console.warn("[alerts] email delivery failed (non-fatal):", e);
        deliveryStatus = "error";
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
    destination,
    deliveryStatus,
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
