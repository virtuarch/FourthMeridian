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
import type { AuthorityOutputs, AlertJobHealth, SyncIncidentHealth } from "@/lib/alerts/authorities";
import { incidentLabel, type SyncIssueDomain } from "@/lib/platform/sync-issue-semantics";
import type { ConnectionHealthResult, HealthState } from "@/lib/connections/health";
import type { ResourceFreshnessResult } from "@/lib/platform/resource-freshness";
import type { AiFailureHealth } from "@/lib/platform/ai/failures";
import type { AiSpendHealth } from "@/lib/platform/ai/spend-health";

// ── Constants ─────────────────────────────────────────────────────────────────

/** PlatformSetting key that overrides a rule's default enabled state. */
export function alertEnabledKey(ruleId: string): string {
  return `alert_rule_enabled:${ruleId}`;
}

/** Re-notify window: an already-delivered breach is suppressed until this much
 *  time has passed, then it re-alerts. The evaluator runs at every dispatcher
 *  slot (00:30/06:30/07:30/12:30/18:30 UTC — OPERATIONALIZATION P0; it was once
 *  daily at 07:30), so a NEW breach is noticed within ~6h, while an ONGOING one
 *  still re-alerts about once a day rather than five times. */
export const DEFAULT_RENOTIFY_HOURS = 20;
const HOUR_MS = 60 * 60 * 1000;

/** Connection health states that make a provider ACUTELY (not just degraded)
 *  unhealthy. REVOKED is deliberately NOT here: a revoked connection is a FORMER
 *  connection, which the authority now excludes from its population
 *  (`retired`, lib/connections/health.ts). Before that it fired a permanent
 *  critical for every disconnected Item — Production carried three. */
const CRITICAL_CONNECTION_STATES: ReadonlySet<HealthState> = new Set<HealthState>([
  "ERROR",
  "NEEDS_REAUTH",
]);

/** The cadence multiple at which job health calls a silent job `dead`
 *  (lib/jobs/health.ts DEAD_CADENCE_MULTIPLE). Mirrored as a WORD for the alert
 *  summary only — the verdict itself is read from the authority, never recomputed. */
const DEAD_MULTIPLE_WORD = "3";

/** Failed/timed-out calls beside returned ones at which the AI rule warns. */
export const AI_FAILURE_WARNING_COUNT = 3;

/** The multiple of a spend threshold at which the two `ai-spend-*-high` rules escalate from warning to critical. */
export const AI_SPEND_CRITICAL_MULTIPLE = 2;

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

/** OPS-4 job health → silent-scheduler signals (one per `overdue` OR `dead` job).
 *  `never-ran` is deliberately excluded: it is an operator-decides state (a
 *  just-registered job reports it until its first slot), and alerting on it would
 *  false-alarm.
 *
 *  OBS-002 (pre-beta audit, runtime-confirmed): this filter once matched
 *  `overdue` ONLY, while lib/jobs/health.ts promotes `overdue` → `dead` at
 *  DEAD_CADENCE_MULTIPLE × cadence. The same job, the same ledger, fired at 10 h
 *  of silence and went QUIET at 60 days — the worse state dropped out of the
 *  firing set. `dead` is the stronger escalate-now signal and is critical; its
 *  dedupe key is the job's, so an `overdue` that ages into `dead` is one breach
 *  with one suppression clock (re-notified every DEFAULT_RENOTIFY_HOURS), not a
 *  new one. */
export function evaluateSchedulerSilent(rule: AlertRuleDefinition, health: AlertJobHealth): AlertSignal[] {
  return health.jobs
    .filter((j) => j.status === "overdue" || j.status === "dead")
    .map((j) => ({
      ruleId: rule.id,
      kind: rule.kind,
      severity: "critical" as AlertSeverity,
      dedupeKey: `${rule.id}:${j.job}`,
      summary:
        j.status === "dead"
          ? `Job "${j.job}" is DEAD — no run for more than ${j.expectedEveryHours}h × ${DEAD_MULTIPLE_WORD} (expected every ${j.expectedEveryHours}h); its schedule has stopped.`
          : `Job "${j.job}" is overdue (expected every ${j.expectedEveryHours}h) — its schedule has gone silent.`,
    }));
}

/** Opaque reference for an id in an alert payload: the last six characters, never the whole id. */
const opaque = (id: string): string => `…${id.slice(-6)}`;

/**
 * Connection health → provider-unhealthy signals, ONE PER UNHEALTHY CONNECTION
 * (OBS-004). Until the pre-beta audit this was one aggregate breach keyed on
 * the rule id, so a second connection failing inside the 20 h re-notify window
 * was silent. Each connection now has its own suppression clock, keyed on its
 * opaque id. The payload still carries no institution label — source kind,
 * health state and error code only; the operator opens the Connection Health
 * widget for the name.
 *
 * The authority's `unhealthy` list is capped (`cap`, worst first). When the
 * list is a FLOOR (fewer rows than `total − HEALTHY`), or when a caller handed
 * counts without rows, the remainder is ONE aggregate breach keyed `:unlisted`
 * so nothing is silently dropped.
 */
export function evaluateProviderUnhealthy(rule: AlertRuleDefinition, conn: ConnectionHealthResult): AlertSignal[] {
  const unhealthyCount = conn.total - conn.counts.HEALTHY;
  if (unhealthyCount <= 0) return [];

  const out: AlertSignal[] = [];
  const rows = Array.isArray(conn.unhealthy) ? conn.unhealthy.filter((r) => r.healthState !== "HEALTHY") : [];
  for (const row of rows) {
    const acute = CRITICAL_CONNECTION_STATES.has(row.healthState);
    out.push({
      ruleId: rule.id,
      kind: rule.kind,
      severity: acute ? "critical" : "warning",
      dedupeKey: `${rule.id}:${row.id}`,
      summary: `Connection ${opaque(row.id)} (${row.source}, ${row.kind}) is ${row.healthState}${row.errorCode ? ` (${row.errorCode})` : ""}${row.since ? ` since ${row.since}` : ""}.`,
    });
  }

  const unlisted = unhealthyCount - rows.length;
  if (unlisted > 0) {
    // The counts know more than the capped list shows (or no list was handed
    // in): one aggregate breach for the remainder, so the fleet picture is
    // never understated.
    const states = (Object.keys(conn.counts) as HealthState[]).filter((s) => s !== "HEALTHY" && conn.counts[s] > 0);
    const acute = states.some((s) => CRITICAL_CONNECTION_STATES.has(s));
    const breakdown = states.map((s) => `${conn.counts[s]} ${s}`).join(", ");
    out.push({
      ruleId: rule.id,
      kind: rule.kind,
      severity: acute ? "critical" : "warning",
      dedupeKey: rows.length === 0 ? rule.id : `${rule.id}:unlisted`,
      summary: rows.length === 0
        ? `${unhealthyCount} of ${conn.total} provider connection(s) unhealthy: ${breakdown}.`
        : `${unlisted} further provider connection(s) unhealthy beyond the ${rows.length} listed (cap ${conn.cap}); fleet: ${breakdown}.`,
    });
  }
  return out;
}

/**
 * OBS-004 — active sync incidents → one critical signal PER PLAID ITEM (or per
 * episode when the episode names no Item). The semantic authority decided
 * "active" and "critical" upstream; this reads those verdicts and groups them
 * so one Item with several critical episodes is one breach, and two Items are
 * two. The dedupe key carries the opaque Item id, so a second customer's
 * incident inside the re-notify window pages on its own clock. No `detail`,
 * no institution, no customer reaches the payload.
 */
export function evaluateSyncIncidentCritical(rule: AlertRuleDefinition, health: SyncIncidentHealth): AlertSignal[] {
  const critical = health.active.filter((i) => i.severity === "critical");
  if (critical.length === 0) return [];
  const byItem = new Map<string, typeof critical>();
  for (const i of critical) {
    const key = i.plaidItemId ? `item:${i.plaidItemId}` : `episode:${i.id}`;
    const bucket = byItem.get(key);
    if (bucket) bucket.push(i); else byItem.set(key, [i]);
  }
  const out: AlertSignal[] = [];
  for (const [key, episodes] of byItem) {
    const first = episodes[0];
    const newest = episodes.map((e) => e.lastOccurredAt).filter((t): t is string => !!t).sort().at(-1) ?? null;
    const occurrences = episodes.reduce((n, e) => n + e.occurrenceCount, 0);
    const subject = first.plaidItemId ? `Plaid Item ${opaque(first.plaidItemId)}` : `episode ${opaque(first.id)} (${first.domain})`;
    out.push({
      ruleId: rule.id,
      kind: rule.kind,
      severity: "critical",
      dedupeKey: `${rule.id}:${key}`,
      summary: `Critical sync incident on ${subject}: ${incidentLabel(first.kind, first.domain as SyncIssueDomain)} — ${episodes.length} active episode(s), ${occurrences} occurrence(s)${newest ? `, last seen ${newest}` : ""}.${health.scanTruncated ? " (The incident scan hit its ceiling; this may be a floor.)" : ""}`,
    });
  }
  return out;
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

/** AI failure facts → provider-failing signals. Two independent breaches, each
 *  with its own dedupe key so a quota outage and an error burst re-alert on
 *  their own clocks:
 *    :quota   ANY insufficient_quota in the window — critical. Waiting cannot
 *             cure it; a person has to pay the provider.
 *    :errors  every call failed (returned 0, ≥1 failure) — critical; or at least
 *             AI_FAILURE_WARNING_COUNT failed/timed-out beside returned calls —
 *             warning. Rate limits are excluded here: they are retried by design
 *             and each attempt is its own row, so counting them would page on
 *             ordinary backpressure. */
export function evaluateAiFailing(rule: AlertRuleDefinition, ai: AiFailureHealth): AlertSignal[] {
  const out: AlertSignal[] = [];
  if (ai.quota > 0) {
    out.push({
      ruleId: rule.id, kind: rule.kind, severity: "critical", dedupeKey: `${rule.id}:quota`,
      summary: `AI provider refused ${ai.quota} call(s) for insufficient quota in the last ${ai.windowHours}h — the provider account is out of credits or over its billing quota.`,
    });
  }
  const errors = ai.failed + ai.timeouts;
  if (errors > 0 && ai.returned === 0) {
    out.push({
      ruleId: rule.id, kind: rule.kind, severity: "critical", dedupeKey: `${rule.id}:errors`,
      summary: `Every AI call in the last ${ai.windowHours}h failed (${ai.failed} failed, ${ai.timeouts} timed out, 0 returned).`,
    });
  } else if (errors >= AI_FAILURE_WARNING_COUNT) {
    out.push({
      ruleId: rule.id, kind: rule.kind, severity: "warning", dedupeKey: `${rule.id}:errors`,
      summary: `${errors} AI call(s) failed or timed out beside ${ai.returned} returned in the last ${ai.windowHours}h (${ai.failed} failed, ${ai.timeouts} timed out).`,
    });
  }
  return out;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** BETA C7 → AI COST CONTROLS — the AI spend fold → spend-high signals, split
 *  across TWO rules so each is independently enable-able through the engine's
 *  `alert_rule_enabled:<id>` key. Every breach keeps its own dedupe key per UTC
 *  day so an ongoing condition re-alerts about once a day and a new day is a
 *  new breach:
 *    ai-spend-fleet-high
 *      :fleet:<day>        estimated fleet USD (customer surfaces) ≥ fleet threshold —
 *                          warning; critical at ≥ AI_SPEND_CRITICAL_MULTIPLE × it.
 *      :unpriced:<day>     ANY invocation on a model the rate card cannot price —
 *                          warning REGARDLESS of spend (fail closed): the dollar
 *                          figures above are partial and the summary says so.
 *    ai-spend-user-high
 *      :user:<day>:<ref>   the largest per-customer estimated USD ≥ user threshold —
 *                          same two levels; the key carries the OPAQUE "user …abc123"
 *                          reference, never an email.
 *  Every summary names the estimated USD and the threshold it was judged
 *  against, and carries the unpriced line as its own sentence. */
function unpricedLineOf(spend: AiSpendHealth): string {
  return spend.unpricedInvocations > 0
    ? ` ${spend.unpricedInvocations} invocation(s) on unpriced models (${spend.unpricedModels.join(", ")}) — not counted; see rate card.`
    : "";
}
const spendLevel = (value: number, threshold: number): AlertSeverity =>
  value >= threshold * AI_SPEND_CRITICAL_MULTIPLE ? "critical" : "warning";

export function evaluateAiSpendFleetHigh(rule: AlertRuleDefinition, spend: AiSpendHealth): AlertSignal[] {
  const out: AlertSignal[] = [];
  const day = spend.checkedAt.slice(0, 10);
  const unpricedLine = unpricedLineOf(spend);

  if (spend.fleetUsd !== null && spend.fleetUsd >= spend.thresholds.fleetUsd) {
    out.push({
      ruleId: rule.id, kind: rule.kind, severity: spendLevel(spend.fleetUsd, spend.thresholds.fleetUsd),
      dedupeKey: `${rule.id}:fleet:${day}`,
      summary: `Estimated AI spend across customer surfaces in the last ${spend.windowHours}h is ${usd(spend.fleetUsd)} — at or above the fleet threshold of $${spend.thresholds.fleetUsd} (${spend.customerInvocations} invocations, ${spend.customers} customer(s); estimate, not a bill).${unpricedLine}`,
    });
  }
  if (spend.unpricedInvocations > 0) {
    out.push({
      ruleId: rule.id, kind: rule.kind, severity: "warning",
      dedupeKey: `${rule.id}:unpriced:${day}`,
      summary: `${spend.unpricedInvocations} invocation(s) on unpriced models (${spend.unpricedModels.join(", ")}) in the last ${spend.windowHours}h — not counted; see rate card. The spend figures for this window are partial, so the thresholds cannot be trusted until a rate is added.`,
    });
  }
  return out;
}

export function evaluateAiSpendUserHigh(rule: AlertRuleDefinition, spend: AiSpendHealth): AlertSignal[] {
  const out: AlertSignal[] = [];
  const day = spend.checkedAt.slice(0, 10);
  const unpricedLine = unpricedLineOf(spend);

  if (spend.maxUserUsd !== null && spend.maxUserRef && spend.maxUserUsd >= spend.thresholds.userUsd) {
    out.push({
      ruleId: rule.id, kind: rule.kind, severity: spendLevel(spend.maxUserUsd, spend.thresholds.userUsd),
      dedupeKey: `${rule.id}:user:${day}:${spend.maxUserRef.slice(-6)}`,
      summary: `One customer (${spend.maxUserRef}) caused an estimated ${usd(spend.maxUserUsd)} of AI spend in the last ${spend.windowHours}h — at or above the per-customer threshold of $${spend.thresholds.userUsd}`
        + (spend.customersAtOrOverThreshold > 1 ? ` (${spend.customersAtOrOverThreshold} customers are at or above it; the largest is named)` : "")
        + ` (estimate, not a bill).${unpricedLine}`,
    });
  }
  return out;
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
      case "ai-failing":
        if (authorities.aiFailures) signals.push(...evaluateAiFailing(rule, authorities.aiFailures));
        break;
      case "ai-spend-fleet":
        if (authorities.aiSpend) signals.push(...evaluateAiSpendFleetHigh(rule, authorities.aiSpend));
        break;
      case "ai-spend-user":
        if (authorities.aiSpend) signals.push(...evaluateAiSpendUserHigh(rule, authorities.aiSpend));
        break;
      case "sync-incident":
        if (authorities.syncIncidents) signals.push(...evaluateSyncIncidentCritical(rule, authorities.syncIncidents));
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

/**
 * OBS-003 — why breaches that should have been delivered were NOT, stated
 * loudly in the summary so a reader (the Alerts widget, the posture chip, an
 * operator reading the ledger) never mistakes "nothing went out" for "nothing
 * was wrong". `breaches` is how many firing signals were due for delivery.
 *
 *   NO_EMAIL_TRANSPORT  the chokepoint selected the in-memory CAPTURE transport
 *                       outside development/test — there is no RESEND_API_KEY —
 *                       so the message went to a buffer nobody reads
 *   NO_DESTINATION      PLATFORM_ALERTS_EMAIL is unset
 *   SEND_ERROR          the transport attempted a send and failed
 *   LEDGER_WRITE_FAILED OBS-015 — this run's own JobRun start row failed to
 *                       write; delivery was circuit-broken because suppression
 *                       cannot persist (an alert storm would follow)
 */
export type AlertUndeliveredReason = "NO_EMAIL_TRANSPORT" | "NO_DESTINATION" | "SEND_ERROR" | "LEDGER_WRITE_FAILED";
export interface AlertUndelivered {
  reason: AlertUndeliveredReason;
  breaches: number;
}

/** The full JobRun summary the evaluate-alerts job returns. Counts/kinds/IDs
 *  only — no user content, monetary values OR addresses (JobRun.summary
 *  doctrine; OBS-011). This IS the alert history: the ledger is the store, no
 *  new table.
 *
 *  Fields added after the first ledger rows were written are OPTIONAL on the
 *  type: a persisted summary from an older deployment lacks them, and every
 *  reader treats absence as "not recorded", never as a value. */
export interface AlertRunSummary {
  evaluatedAtISO: string;
  /**
   * @deprecated OBS-011 — the destination ADDRESS is no longer written (an
   * address in JobRun.summary was visible to every ledger reader). Present only
   * on rows persisted before the change; new rows carry `destinationConfigured`.
   */
  destination?: string | null;
  /** OBS-011 — whether PLATFORM_ALERTS_EMAIL was set when this run evaluated. */
  destinationConfigured?: boolean;
  /**
   *   none      nothing was due for delivery
   *   sent      the real provider ACCEPTED the message (acceptance ≠ delivery:
   *             no delivery event exists in this product, so no reader may
   *             claim "delivered" — see lib/platform/email-health.ts)
   *   captured  development/test only: the capture transport recorded it
   *   skipped   due for delivery but nothing was sent — `undelivered` says why
   *   error     the transport failed — `undelivered` says so
   */
  deliveryStatus: "none" | "sent" | "captured" | "skipped" | "error";
  /** OBS-003 — set whenever firing breaches were due and did NOT reach a real transport. Null when nothing was lost. */
  undelivered?: AlertUndelivered | null;
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
