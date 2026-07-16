/**
 * lib/alerts/evaluate.ts  (OPS-5 S5)
 *
 * THE one canonical alert evaluation — pure, deterministic, DB-free. Given the
 * already-fetched output of the existing health authorities (AuthorityOutputs)
 * and an enabled-predicate, it classifies breach SIGNALS. It performs NO health
 * computation of its own: it reads authority verdicts (`failing`, `overdue`,
 * `stale`, non-`HEALTHY`, …) and turns each into a signal. This is the mission's
 * "one canonical evaluation · no duplicated health computation" as code.
 *
 * Also here (all pure, so the whole slice unit-tests with no database):
 *   - resolveEnabled       PlatformSetting override of a rule's default
 *   - decideDeliveries     suppress-while-open across evaluation cycles
 *   - buildAlertEmailData  the OPS-1 email payload for the firing signals
 *   - extractPriorFired /  derive suppression state + UI views from prior
 *     deriveAlertRuleViews   evaluate-alerts JobRun summaries (the alert history)
 *
 * The evaluators dispatch on rule KIND (job-health backs two rules), each a tiny
 * pure function over one authority's output — the SCHEDULED_JOBS/classifyJobHealth
 * split idiom (OPS-4 S5), applied to alerting.
 */

import { ALERT_RULES, type AlertRuleDefinition, type AlertSeverity, type AlertSignal } from "@/lib/alerts/rules";
import type { AuthorityOutputs, AlertJobHealth } from "@/lib/alerts/authorities";
import type { ConnectionHealthResult, HealthState } from "@/lib/connections/health";
import type { ResourceFreshnessResult } from "@/lib/platform/resource-freshness";

// ── Constants ─────────────────────────────────────────────────────────────────

/** PlatformSetting key that overrides a rule's default enabled state. */
export function alertEnabledKey(ruleId: string): string {
  return `alert_rule_enabled:${ruleId}`;
}

/** Re-notify window: an already-delivered breach is suppressed until this much
 *  time has passed, then it re-alerts. 20h < the 24h daily eval cadence, so an
 *  ongoing breach re-alerts once per day but a same-day re-run never double-sends. */
export const DEFAULT_RENOTIFY_HOURS = 20;
const HOUR_MS = 60 * 60 * 1000;

/** Connection health states that make a provider ACUTELY (not just degraded) unhealthy. */
const CRITICAL_CONNECTION_STATES: ReadonlySet<HealthState> = new Set<HealthState>([
  "ERROR",
  "REVOKED",
  "NEEDS_REAUTH",
]);

// ── Enabled resolution ──────────────────────────────────────────────────────────

/**
 * A rule is enabled unless a PlatformSetting explicitly turns it off/on. Dormant
 * rules (live: false) are never enabled regardless of the setting — they have no
 * authority to evaluate. `settings` maps the enabled-key to "true"/"false".
 */
export function resolveEnabled(rule: AlertRuleDefinition, settings: ReadonlyMap<string, string>): boolean {
  if (!rule.live) return false;
  const raw = settings.get(alertEnabledKey(rule.id));
  if (raw === "true") return true;
  if (raw === "false") return false;
  return rule.defaultEnabled;
}

// ── Per-authority evaluators (pure) ─────────────────────────────────────────────

/** OPS-4 job health → repeated-failure signals (one per `failing` job). */
export function evaluateJobFailing(rule: AlertRuleDefinition, health: AlertJobHealth): AlertSignal[] {
  return health.jobs
    .filter((j) => j.status === "failing")
    .map((j) => ({
      ruleId: rule.id,
      kind: rule.kind,
      severity: "critical" as AlertSeverity,
      dedupeKey: `${rule.id}:${j.job}`,
      summary: `Job "${j.job}" has failed its last ${j.consecutiveFailures} run(s).`,
    }));
}

/** OPS-4 job health → silent-scheduler signals (one per `overdue` job). `never-ran`
 *  is deliberately excluded: it is an operator-decides state (a just-registered job
 *  reports it until its first slot), and alerting on it would false-alarm. */
export function evaluateSchedulerSilent(rule: AlertRuleDefinition, health: AlertJobHealth): AlertSignal[] {
  return health.jobs
    .filter((j) => j.status === "overdue")
    .map((j) => ({
      ruleId: rule.id,
      kind: rule.kind,
      severity: "critical" as AlertSeverity,
      dedupeKey: `${rule.id}:${j.job}`,
      summary: `Job "${j.job}" is overdue (expected every ${j.expectedEveryHours}h) — its schedule has gone silent.`,
    }));
}

/** Connection health → one aggregate provider-unhealthy signal (never per-connection
 *  — a solo operator opens the Connection Health widget for the detail). Carries
 *  counts + states only; no institution labels reach the alert payload. */
export function evaluateProviderUnhealthy(rule: AlertRuleDefinition, conn: ConnectionHealthResult): AlertSignal[] {
  const unhealthyCount = conn.total - conn.counts.HEALTHY;
  if (unhealthyCount <= 0) return [];

  const acute = (Object.keys(conn.counts) as HealthState[]).some(
    (s) => CRITICAL_CONNECTION_STATES.has(s) && conn.counts[s] > 0,
  );
  const breakdown = (Object.keys(conn.counts) as HealthState[])
    .filter((s) => s !== "HEALTHY" && conn.counts[s] > 0)
    .map((s) => `${conn.counts[s]} ${s}`)
    .join(", ");

  return [
    {
      ruleId: rule.id,
      kind: rule.kind,
      severity: acute ? "critical" : "warning",
      dedupeKey: rule.id,
      summary: `${unhealthyCount} of ${conn.total} provider connection(s) unhealthy: ${breakdown}.`,
    },
  ];
}

/** OPS-5 resource freshness → stale/empty signals (one per non-fresh, non-idle
 *  resource). `empty` (a cold archive — the incident shape) is critical; `stale`
 *  is a warning. `idle`/`fresh` never fire.
 *
 *  BLOCKED-PIPELINE HONESTY (cross-slice contract with OPS-5 S1): S1 marks an
 *  empty archive whose producing pipeline is known-blocked (e.g. security-prices
 *  with no price vendor configured — A8-3B) as trust.level "unknown" — "honest,
 *  not a false alarm". Alerting on it would page the operator about a gated no-op
 *  they cannot fix (a false-red that would fire on every deployment with held
 *  instruments and no price vendor). So `empty` fires ONLY when the empty is a
 *  genuine failure (trust.level !== "unknown"); `stale` always has data and is
 *  never blocked-relevant, so it always fires. */
export function evaluateResourceStale(rule: AlertRuleDefinition, fresh: ResourceFreshnessResult): AlertSignal[] {
  return fresh.resources
    .filter((r) => r.healthState === "stale" || (r.healthState === "empty" && r.trust.level !== "unknown"))
    .map((r) => ({
      ruleId: rule.id,
      kind: rule.kind,
      severity: (r.healthState === "empty" ? "critical" : "warning") as AlertSeverity,
      dedupeKey: `${rule.id}:${r.resource}`,
      summary:
        r.healthState === "empty"
          ? `Resource "${r.resource}" archive is empty (expected data, found none).`
          : `Resource "${r.resource}" is stale — newest data ${r.ageDays ?? "?"}d old (threshold ${Math.round(r.staleAfterHours / 24)}d).`,
    }));
}

// ── THE canonical evaluation ────────────────────────────────────────────────────

/**
 * Evaluate every enabled, live rule against the gathered authority outputs.
 * A rule whose authority did not gather (null) simply contributes no signals.
 * Deterministic: same authorities + same enabled set ⇒ same signals.
 */
export function evaluateAlertRules(
  authorities: AuthorityOutputs,
  isEnabled: (ruleId: string) => boolean,
  rules: readonly AlertRuleDefinition[] = ALERT_RULES,
): AlertSignal[] {
  const signals: AlertSignal[] = [];
  for (const rule of rules) {
    if (!rule.live || !isEnabled(rule.id)) continue;
    switch (rule.kind) {
      case "job-failing":
        if (authorities.jobHealth) signals.push(...evaluateJobFailing(rule, authorities.jobHealth));
        break;
      case "scheduler-silent":
        if (authorities.jobHealth) signals.push(...evaluateSchedulerSilent(rule, authorities.jobHealth));
        break;
      case "provider-unhealthy":
        if (authorities.connectionHealth) signals.push(...evaluateProviderUnhealthy(rule, authorities.connectionHealth));
        break;
      case "resource-stale":
        if (authorities.resourceFreshness) signals.push(...evaluateResourceStale(rule, authorities.resourceFreshness));
        break;
      case "quota-low":
        // Dormant — no authority to read. `live: false` already excluded it above;
        // this arm exists only for switch exhaustiveness.
        break;
    }
  }
  return signals;
}

// ── Suppression (suppress-while-open across cycles) ─────────────────────────────

export interface DeliveryDecision {
  toSend: AlertSignal[];
  suppressed: AlertSignal[];
}

/**
 * Decide which firing signals to actually deliver. A breach is suppressed when
 * the same dedupeKey was delivered within `renotifyMs` — so an ongoing condition
 * re-alerts at most once per re-notify window instead of every cycle.
 * `priorFired` maps a dedupeKey to the last delivery time (ms).
 */
export function decideDeliveries(
  signals: readonly AlertSignal[],
  priorFired: ReadonlyMap<string, number>,
  nowMs: number,
  renotifyMs: number = DEFAULT_RENOTIFY_HOURS * HOUR_MS,
): DeliveryDecision {
  const toSend: AlertSignal[] = [];
  const suppressed: AlertSignal[] = [];
  for (const s of signals) {
    const last = priorFired.get(s.dedupeKey);
    if (last !== undefined && nowMs - last < renotifyMs) suppressed.push(s);
    else toSend.push(s);
  }
  return { toSend, suppressed };
}

// ── Email payload (OPS-1) ────────────────────────────────────────────────────────

/** The data the `platform-alert` email template renders from. */
export interface AlertEmailData {
  evaluatedAtISO: string;
  alerts: { title: string; severity: AlertSeverity; summary: string }[];
}

/** Build the email payload for the signals being delivered (critical first). */
export function buildAlertEmailData(signals: readonly AlertSignal[], evaluatedAtISO: string): AlertEmailData {
  const ordered = [...signals].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    evaluatedAtISO,
    alerts: ordered.map((s) => ({ title: s.dedupeKey, severity: s.severity, summary: s.summary })),
  };
}

function severityRank(s: AlertSeverity): number {
  return s === "critical" ? 1 : 0;
}

// ── History / suppression state from prior JobRun summaries ──────────────────────

/** One delivered breach, recorded in an evaluate-alerts JobRun summary. */
export interface AlertFiredRecord {
  ruleId: string;
  kind: AlertSignal["kind"];
  dedupeKey: string;
  severity: AlertSeverity;
  summary: string;
  deliveredAtISO: string;
}

/** Per-rule outcome of one evaluation cycle (recorded in the JobRun summary). */
export interface AlertRuleOutcome {
  id: string;
  kind: AlertSignal["kind"];
  enabled: boolean;
  live: boolean;
  firing: boolean;
  breaches: number;
  severity: AlertSeverity | null;
}

/** The full JobRun summary the evaluate-alerts job returns. Counts/kinds/IDs
 *  only — no user content or monetary values (JobRun.summary doctrine). This IS
 *  the alert history: the ledger is the store, no new table. */
export interface AlertRunSummary {
  evaluatedAtISO: string;
  destination: string | null;
  deliveryStatus: "none" | "sent" | "captured" | "skipped" | "error";
  counts: { evaluated: number; live: number; enabled: number; firing: number; delivered: number; suppressed: number };
  rules: AlertRuleOutcome[];
  fired: AlertFiredRecord[];
}

/**
 * Merge the delivered records of recent evaluate-alerts summaries into the
 * suppression map (dedupeKey → newest delivery ms). Newest-first or any order —
 * we keep the max.
 */
export function extractPriorFired(recent: readonly AlertRunSummary[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const run of recent) {
    for (const f of run.fired) {
      const t = Date.parse(f.deliveredAtISO);
      if (Number.isNaN(t)) continue;
      const prev = map.get(f.dedupeKey);
      if (prev === undefined || t > prev) map.set(f.dedupeKey, t);
    }
  }
  return map;
}

/** One rule as the UI presents it. */
export interface AlertRuleView {
  id: string;
  kind: AlertSignal["kind"];
  title: string;
  description: string;
  authority: AlertRuleDefinition["authority"];
  live: boolean;
  enabled: boolean;
  lastTriggeredAtISO: string | null;
  lastSeverity: AlertSeverity | null;
}

/**
 * Derive the per-rule UI views from the registry, the resolved enabled map, and
 * recent evaluate-alerts summaries (newest first). `lastTriggeredAt` is the most
 * recent delivery of any of the rule's breaches across the recent history.
 */
export function deriveAlertRuleViews(
  rules: readonly AlertRuleDefinition[],
  isEnabled: (ruleId: string) => boolean,
  recent: readonly AlertRunSummary[],
): AlertRuleView[] {
  return rules.map((rule) => {
    let lastTriggeredAtISO: string | null = null;
    let lastSeverity: AlertSeverity | null = null;
    let lastMs = -Infinity;
    for (const run of recent) {
      for (const f of run.fired) {
        if (f.ruleId !== rule.id) continue;
        const t = Date.parse(f.deliveredAtISO);
        if (!Number.isNaN(t) && t > lastMs) {
          lastMs = t;
          lastTriggeredAtISO = f.deliveredAtISO;
          lastSeverity = f.severity;
        }
      }
    }
    return {
      id: rule.id,
      kind: rule.kind,
      title: rule.title,
      description: rule.description,
      authority: rule.authority,
      live: rule.live,
      enabled: isEnabled(rule.id),
      lastTriggeredAtISO,
      lastSeverity,
    };
  });
}

/** Flatten recent summaries into a capped, newest-first firing history for the UI. */
export function collectAlertHistory(recent: readonly AlertRunSummary[], cap = 20): AlertFiredRecord[] {
  const all: AlertFiredRecord[] = [];
  for (const run of recent) all.push(...run.fired);
  all.sort((a, b) => Date.parse(b.deliveredAtISO) - Date.parse(a.deliveredAtISO));
  return all.slice(0, cap);
}
