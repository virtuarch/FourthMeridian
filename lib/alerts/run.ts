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
import { getAiSpendAnomalyFacts } from "@/lib/platform/ai/spend-anomaly";
import { getPlaidCallAnomalyFacts } from "@/lib/platform/anomaly/plaid-calls";
import { ALERT_RULES, type AlertRuleDefinition, type AlertSeverity, type AlertSignal } from "@/lib/alerts/rules";
import type { AuthorityOutputs } from "@/lib/alerts/authorities";
import {
  buildAlertEmailData,
  decideDeliveries,
  evaluateAlertRulesDetailed,
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
import {
  FLAP_RECOVERIES, FLAP_STABLE_EVALUATIONS, FLAP_WINDOW_MS,
  advanceFlapping, advanceRecovery, cleanlyEvaluatedRules, clearRecoveredSuppression, deliveredFlapNotices, deliveredRecoveryKeys,
  durationLabel, episodeIdentity, escalatesFlap, escalationKeyOf, flappingKeyOf, openDelivered, previousFlap, previousOpen, recoveredRecord, recoveriesInWindow,
  recoveryKeyOf, stableKeyOf, wouldFlap,
  type AlertFlapRecord, type AlertOpenRecord, type AlertRecoveredRecord,
} from "@/lib/alerts/recovery";

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
  /**
   * Deliver the alert email; returns the OPS-1 EmailResult status (+ transport name).
   * ALERT RECOVERY — a recovery email passes its own `idempotencyKey` (the
   * recovery key), forwarded to the provider; a firing email passes none.
   */
  sendAlertEmail?: (to: string, data: AlertEmailData, opts?: { idempotencyKey?: string }) => Promise<{ status: string; provider?: string }>;
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
  const [jobHealth, connectionHealth, resourceFreshness, aiFailures, aiSpend, syncIncidents, policyAssignments, aiSpendAnomaly, plaidCallAnomaly] = await Promise.all([
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
    // Quota/cost anomaly (anomaly@1) — the same spend fold over 8 trailing 24 h
    // windows, and Plaid calls per UTC day from the usage ledger.
    getAiSpendAnomalyFacts().catch((e) => (warn("ai-spend-anomaly", e), null)),
    getPlaidCallAnomalyFacts().catch((e) => (warn("plaid-call-anomaly", e), null)),
  ]);
  return { jobHealth, connectionHealth, resourceFreshness, aiFailures, aiSpend, syncIncidents, policyAssignments, aiSpendAnomaly, plaidCallAnomaly };
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

async function sendAlertEmailDefault(to: string, data: AlertEmailData, opts?: { idempotencyKey?: string }): Promise<{ status: string; provider?: string }> {
  const res = await sendEmail("platform-alert", to, data as unknown as Record<string, unknown>, {
    key: "PLATFORM_ALERT", recipientUserId: null,
    ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });
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

  const { signals, notEvaluable } = evaluateAlertRulesDetailed(authorities, isEnabled, rules);
  // ALERT RECOVERY — a recovered episode's last delivery no longer suppresses its re-fire.
  const priorFired = clearRecoveredSuppression(extractPriorFired(recentRuns), recentRuns);
  // FLAP PROTECTION — a flapping identity's firing signals are suppressed (they
  // still count as firing in the rule outcomes) until it is stable again.
  const flapById = new Map(previousFlap(recentRuns).map((f) => [f.identity, f] as const));
  const flappingIds = new Set([...flapById.values()].filter((f) => f.flappingSinceISO !== null).map((f) => f.identity));
  // ESCALATION BREAKS THROUGH: a flapping identity firing ABOVE its recorded
  // `flappingSeverity` is emailed at once through the normal firing path (its
  // own escalation key, not the re-notify window); equal or lower stays suppressed.
  const priorNotices = deliveredFlapNotices(recentRuns);
  const escalations: { signal: AlertSignal; key: string }[] = [];
  const flapSuppressed: AlertSignal[] = [];
  for (const x of signals) {
    const id = episodeIdentity(x.dedupeKey);
    if (!flappingIds.has(id)) continue;
    const f = flapById.get(id)!;
    const key = escalationKeyOf(id, x.severity, f.flappingSinceISO!);
    if (escalatesFlap(f, x.severity) && !priorNotices.has(key) && !escalations.some((e) => e.key === key)) escalations.push({ signal: x, key });
    else flapSuppressed.push(x);
  }
  const decided = decideDeliveries(signals.filter((x) => !flappingIds.has(episodeIdentity(x.dedupeKey))), priorFired, now.getTime(), deps.renotifyMs);
  const toSend = [...decided.toSend, ...escalations.map((e) => e.signal)];
  const suppressed = [...decided.suppressed, ...flapSuppressed];

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

  // ── ALERT RECOVERY (lib/alerts/recovery.ts) ─────────────────────────────────
  // Advance the tracked episodes against THIS cycle's signals; an episode absent
  // for RECOVERY_ABSENT_EVALUATIONS clean evaluations gets ONE recovery email,
  // under exactly the gates a firing email meets. FLAP PROTECTION: the
  // FLAP_RECOVERIES-th recovery of one identity inside FLAP_WINDOW_MS sends ONE
  // "flapping" email instead, and the identity's firing and recovery emails are
  // suppressed until FLAP_STABLE_EVALUATIONS clean evaluations end in ONE
  // "stable again" email.
  const cleanly = cleanlyEvaluatedRules(authorities, isEnabled, rules, notEvaluable);
  const deliveredKeys = deliveredRecoveryKeys(recentRuns);
  for (const k of deliveredFlapNotices(recentRuns)) deliveredKeys.add(k);
  const advance = advanceRecovery({
    previous: previousOpen(recentRuns).filter((o) => !flappingIds.has(o.identity)),
    signals: signals.filter((x) => !flappingIds.has(episodeIdentity(x.dedupeKey))),
    cleanlyEvaluated: cleanly,
    deliveredRecoveries: deliveredKeys,
    nowISO: deliveredAtISO,
  });
  const recovered: AlertRecoveredRecord[] = [];
  const flapNotices: string[] = [];
  // Escalations delivered with this cycle's firing email: record their keys and raise the flap's severity.
  for (const e of escalations) {
    if (!delivered.includes(e.signal)) continue;
    flapNotices.push(e.key);
    const id = episodeIdentity(e.signal.dedupeKey);
    flapById.set(id, { ...flapById.get(id)!, flappingSeverity: e.signal.severity });
  }
  const handled = new Set<string>(); // identities whose due notice was delivered this cycle
  // Held in an object: the closures below write it (a `let` would be narrowed away by the compiler).
  const loss: { count: number; reason: AlertUndelivered["reason"] } = { count: 0, reason: "SEND_ERROR" };

  // One gate for every recovery-side notice — the firing email's gates.
  const gate = (): AlertUndelivered["reason"] | null =>
    ledgerStartWriteFailed() ? "LEDGER_WRITE_FAILED" : !destination ? "NO_DESTINATION" : null;
  const notify = async (data: AlertEmailData, key: string): Promise<boolean> => {
    const blocked = gate();
    if (blocked) { loss.count++; loss.reason = blocked; return false; }
    const outcome = await deliverOne(sendAlertEmail, destination!, data, environment, key);
    if (!outcome.delivered) { loss.count++; loss.reason = outcome.reason; }
    return outcome.delivered;
  };

  // (1) Episodes due to recover: a recovery — or, at the K-th inside the window, the flapping notice.
  for (const o of advance.due) {
    const f = flapById.get(o.identity);
    if (wouldFlap(f, deliveredAtISO)) {
      const key = flappingKeyOf(o.identity, o.firstFiredAtISO);
      if (await notify(flappingEmailData(o, deliveredAtISO, rules, f), key)) {
        flapNotices.push(key);
        handled.add(o.identity);
        flapById.set(o.identity, {
          identity: o.identity, ruleId: o.ruleId, kind: o.kind, dedupeKey: o.dedupeKey,
          recoveriesAtISO: [...(f ? recoveriesInWindow(f, deliveredAtISO) : []), deliveredAtISO],
          flappingSinceISO: deliveredAtISO, cleanEvaluations: o.absentEvaluations, cleanSinceISO: o.clearedAtISO,
          flappingSeverity: o.severity,
        });
      }
      continue;
    }
    if (await notify(recoveryEmailData(o, deliveredAtISO, rules), recoveryKeyOf(o.identity, o.firstFiredAtISO))) {
      recovered.push(recoveredRecord(o, deliveredAtISO));
      handled.add(o.identity);
      flapById.set(o.identity, {
        identity: o.identity, ruleId: o.ruleId, kind: o.kind, dedupeKey: o.dedupeKey,
        recoveriesAtISO: [...(f ? recoveriesInWindow(f, deliveredAtISO) : []), deliveredAtISO],
        flappingSinceISO: null, cleanEvaluations: 0, cleanSinceISO: null,
      });
    }
  }

  // (2) Flapping identities: advance the clean streak; at FLAP_STABLE_EVALUATIONS, ONE "stable again".
  for (const id of flappingIds) {
    const f0 = flapById.get(id)!;
    const firingNow = signals.some((x) => episodeIdentity(x.dedupeKey) === id);
    const f = advanceFlapping(f0, firingNow, cleanly.has(f0.ruleId), deliveredAtISO);
    flapById.set(id, f);
    if (f.cleanEvaluations < FLAP_STABLE_EVALUATIONS) continue;
    const key = stableKeyOf(id, f.flappingSinceISO!);
    if (deliveredKeys.has(key)) { flapById.delete(id); continue; } // a replayed wake: already sent
    if (await notify(stableEmailData(f, deliveredAtISO, rules), key)) {
      recovered.push({
        identity: id, ruleId: f.ruleId, kind: f.kind, dedupeKey: f.dedupeKey, recoveryKey: key,
        firstFiredAtISO: f.flappingSinceISO!, clearedAtISO: f.cleanSinceISO ?? deliveredAtISO, recoveredAtISO: deliveredAtISO,
        durationMs: Math.max(0, Date.parse(f.cleanSinceISO ?? deliveredAtISO) - Date.parse(f.flappingSinceISO!)),
      });
      flapById.delete(id); // a fresh start: the next fire is a new episode
    }
  }

  // (3) Expired: cleared for longer than RECOVERY_STATE_MAX_AGE_MS without a delivered recovery.
  const recoveryExpired = advance.expired.length;
  if (recoveryExpired > 0) {
    console.error(`[alerts] ${recoveryExpired} recovery notice(s) could not be delivered within 7 days and were dropped.`);
  }
  const recoveryUndelivered: AlertUndelivered | null =
    loss.count > 0 ? { reason: loss.reason, breaches: loss.count }
    : recoveryExpired > 0 ? { reason: "EXPIRED", breaches: recoveryExpired }
    : null;
  if (loss.count > 0 && loss.reason === "LEDGER_WRITE_FAILED") {
    console.error(`[alerts] ${loss.count} recovery notice(s) NOT delivered: this run's JobRun start row failed to write (OBS-015 circuit breaker).`);
  }

  const flap: AlertFlapRecord[] = [...flapById.values()]
    .map((f) => (f.flappingSinceISO ? f : { ...f, recoveriesAtISO: recoveriesInWindow(f, deliveredAtISO) }))
    .filter((f) => f.flappingSinceISO !== null || f.recoveriesAtISO.length > 0);
  const open: AlertOpenRecord[] = openDelivered(
    advance.open.filter((o) => !handled.has(o.identity) && !flapById.get(o.identity)?.flappingSinceISO),
    // An escalation of a flapping identity does not open an episode: the flap owns it until stable.
    delivered.filter((x) => !flappingIds.has(episodeIdentity(x.dedupeKey))), deliveredAtISO,
  );

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
      // Quota/cost anomaly — present only when the rule could not judge.
      ...(notEvaluable.has(rule.id) ? { notEvaluable: notEvaluable.get(rule.id)! } : {}),
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
      recovered: recovered.length,
      recoveryExpired,
    },
    rules: ruleOutcomes,
    fired,
    open,
    recovered,
    recoveryUndelivered,
    flap,
    flapNotices,
  };
}

/** The flapping-variant payload: ONE email when an identity starts flapping. */
function flappingEmailData(o: AlertOpenRecord, nowISO: string, rules: readonly AlertRuleDefinition[], f: AlertFlapRecord | undefined): AlertEmailData {
  return {
    evaluatedAtISO: nowISO,
    alerts: [],
    flapping: {
      ruleId: o.ruleId,
      ruleTitle: rules.find((r) => r.id === o.ruleId)?.title ?? o.ruleId,
      dedupeKey: o.dedupeKey,
      recoveries: (f ? recoveriesInWindow(f, nowISO).length : 0) + 1,
      windowHours: FLAP_WINDOW_MS / 3_600_000,
      stableAfterEvaluations: FLAP_STABLE_EVALUATIONS,
      threshold: FLAP_RECOVERIES,
    },
  };
}

/** The resolved variant, "stable again": the one email that ends a flapping period. */
function stableEmailData(f: AlertFlapRecord, nowISO: string, rules: readonly AlertRuleDefinition[]): AlertEmailData {
  const clearedAtISO = f.cleanSinceISO ?? nowISO;
  return {
    evaluatedAtISO: nowISO,
    alerts: [],
    resolved: {
      ruleId: f.ruleId,
      ruleTitle: rules.find((r) => r.id === f.ruleId)?.title ?? f.ruleId,
      dedupeKey: f.dedupeKey,
      firstFiredAtISO: f.flappingSinceISO!,
      clearedAtISO,
      durationLabel: durationLabel(Math.max(0, Date.parse(clearedAtISO) - Date.parse(f.flappingSinceISO!))),
      variant: "stable",
    },
  };
}

/** The resolved-variant payload for one recovered episode. */
function recoveryEmailData(o: AlertOpenRecord, nowISO: string, rules: readonly AlertRuleDefinition[]): AlertEmailData {
  const rec = recoveredRecord(o, nowISO);
  return {
    evaluatedAtISO: nowISO,
    alerts: [],
    resolved: {
      ruleId: o.ruleId,
      ruleTitle: rules.find((r) => r.id === o.ruleId)?.title ?? o.ruleId,
      dedupeKey: o.dedupeKey,
      firstFiredAtISO: rec.firstFiredAtISO,
      clearedAtISO: rec.clearedAtISO,
      durationLabel: durationLabel(rec.durationMs),
    },
  };
}

/**
 * One recovery send, classified EXACTLY as the firing send is: `sent` is
 * delivered; `captured` is delivered only where capture is the expected
 * transport (development/test — OBS-003); anything else is lost and retried
 * next cycle.
 */
async function deliverOne(
  send: NonNullable<AlertRunDeps["sendAlertEmail"]>,
  to: string,
  data: AlertEmailData,
  environment: string | undefined,
  idempotencyKey: string,
): Promise<{ delivered: true } | { delivered: false; reason: AlertUndelivered["reason"] }> {
  try {
    const res = await send(to, data, { idempotencyKey });
    const status = normalizeStatus(res.status);
    if (status === "sent") return { delivered: true };
    if (status === "captured") {
      if (captureIsExpected(environment)) return { delivered: true };
      console.error(`[alerts] a recovery notice was NOT delivered: the email chokepoint selected the capture transport (no RESEND_API_KEY) in NODE_ENV=${environment ?? "(unset)"}.`);
      return { delivered: false, reason: "NO_EMAIL_TRANSPORT" };
    }
    captureAlertDeliveryFailure(res, 1);
    return { delivered: false, reason: "SEND_ERROR" };
  } catch (e) {
    console.warn("[alerts] recovery email delivery failed (non-fatal):", e);
    captureAlertDeliveryFailure(e, 1);
    return { delivered: false, reason: "SEND_ERROR" };
  }
}

function normalizeStatus(status: string): AlertRunSummary["deliveryStatus"] {
  return status === "sent" || status === "captured" || status === "skipped" || status === "error" ? status : "error";
}

function worstSeverity(severities: readonly AlertSeverity[]): AlertSeverity | null {
  if (severities.includes("critical")) return "critical";
  if (severities.includes("warning")) return "warning";
  return null;
}
