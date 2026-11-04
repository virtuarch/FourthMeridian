/**
 * lib/alerts/recovery.ts  (alert RECOVERY notifications — pure)
 *
 * Today the evaluator emails a breach when it FIRES and says nothing when it
 * CLEARS. This module decides when a delivered breach has recovered, from state
 * carried in the evaluate-alerts JobRun summary (the alert history IS the
 * ledger — no new table, no migration).
 *
 * ── The state: `AlertRunSummary.open` ──────────────────────────────────────
 * Every run writes the episodes it is tracking: a breach enters `open` the cycle
 * its firing email is DELIVERED, and leaves it the cycle its recovery email is
 * delivered. Each cycle reads the newest run's `open` (the previous state),
 * advances it against THIS cycle's signals, and writes the result:
 *
 *   firing this cycle                   → absent = 0 (a flap resets the count)
 *   absent, its rule evaluated cleanly  → absent + 1
 *   absent, its rule NOT evaluated      → unchanged: UNKNOWN IS NEVER RECOVERY
 *     (authority did not gather, rule disabled or dormant, or the authority's
 *     answer is partial — unpriced AI spend, a truncated incident scan)
 *   absent ≥ RECOVERY_ABSENT_EVALUATIONS → recovered: ONE email
 *
 * ── Episode identity ─────────────────────────────────────────────────────────
 * Some dedupe keys carry the UTC day (`ai-spend-fleet-high:fleet:2026-11-03`) or
 * the severity (`policy-assignment-invalid:critical:…`). A condition that
 * persists past midnight, or escalates, changes its key without clearing. The
 * episode is therefore tracked by the key with those two segments normalised
 * (`episodeIdentity`), so neither looks like a recovery.
 *
 * ── Exactly once ─────────────────────────────────────────────────────────────
 * The recovery key is `<identity>:recovered:<firstFiredAtISO>` — unique per
 * episode. A key recorded as delivered in any retained run is never sent again
 * (and the provider gets it as its idempotency key), so two wakes over the same
 * state cannot both send. Once recovered, an episode must FIRE (and be
 * delivered) again before it can recover again; its suppression entry is
 * cleared (`clearRecoveredSuppression`) so the re-fire is emailed at once.
 *
 * PURE — no I/O, no clock.
 */

import type { AlertRuleDefinition, AlertSeverity, AlertSignal } from "@/lib/alerts/rules";
import type { AuthorityOutputs } from "@/lib/alerts/authorities";

/** Consecutive clean evaluations a delivered breach must be absent before it counts as recovered (flap protection). */
export const RECOVERY_ABSENT_EVALUATIONS = 2;
/**
 * A CLEARED episode whose recovery could not be delivered for this long (no
 * destination, no transport) is dropped WITHOUT a recovery email — counted as
 * `counts.recoveryExpired`, `recoveryUndelivered.reason = "EXPIRED"`. Measured
 * from `clearedAtISO` ONLY: an episode still firing (or whose rule is
 * unknown, so it never cleared) keeps its state however long the outage lasts.
 */
export const RECOVERY_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Flap protection (S2 ruling, option b) ────────────────────────────────────
/** Recoveries of one identity within FLAP_WINDOW_MS that mark it FLAPPING. */
export const FLAP_RECOVERIES = 2;
export const FLAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Consecutive clean evaluations (no firing) a flapping identity needs before its one "stable again" email. */
export const FLAP_STABLE_EVALUATIONS = 8;

/**
 * Per-identity flap state, carried run to run in `AlertRunSummary.flap` (the
 * retained runs cover hours, not the 24 h window, so the recovery times travel
 * with the state). While `flappingSinceISO` is set, the identity's firing AND
 * recovery emails are suppressed; one "flapping" email opened it, one "stable
 * again" email closes it.
 */
export interface AlertFlapRecord {
  identity: string;
  ruleId: string;
  kind: AlertSignal["kind"];
  dedupeKey: string;
  /** Delivered recoveries (and the flapping notice) within FLAP_WINDOW_MS. */
  recoveriesAtISO: string[];
  /** Set while flapping (the flapping notice's delivery time). */
  flappingSinceISO: string | null;
  /** Consecutive clean evaluations since the last firing, while flapping. */
  cleanEvaluations: number;
  /** The first evaluation of the current clean streak (the "stable again" email's "cleared"); null while firing. */
  cleanSinceISO: string | null;
  /**
   * The highest severity already emailed for this identity while flapping (set
   * when flapping is declared). A firing signal ABOVE it breaks through the
   * suppression — an escalation is the breach an operator most needs — and
   * raises it; equal or lower stays suppressed. Absent on non-flapping records
   * (and on rows written before the field: treated as "warning").
   */
  flappingSeverity?: AlertSeverity;
}

/** One delivered breach being tracked until it recovers. Persisted in the JobRun summary. */
export interface AlertOpenRecord {
  identity: string;
  ruleId: string;
  kind: AlertSignal["kind"];
  /** The newest firing dedupeKey of the episode. */
  dedupeKey: string;
  severity: AlertSeverity;
  /** When this episode's firing email was first delivered. */
  firstFiredAtISO: string;
  /** The last evaluation in which it was firing. */
  lastSeenAtISO: string;
  /** Consecutive clean evaluations it has been absent. */
  absentEvaluations: number;
  /** The first evaluation of the current absent streak (the "cleared at"); null while firing. */
  clearedAtISO: string | null;
}

/** One delivered recovery. Persisted in the JobRun summary. */
export interface AlertRecoveredRecord {
  identity: string;
  ruleId: string;
  kind: AlertSignal["kind"];
  dedupeKey: string;
  /** `<identity>:recovered:<firstFiredAtISO>` — the email's own dedupe key. */
  recoveryKey: string;
  firstFiredAtISO: string;
  clearedAtISO: string;
  /** When the recovery email was delivered. */
  recoveredAtISO: string;
  durationMs: number;
  /** A "stable again" record only: the HIGHEST severity reached during the flap (`flappingSeverity`). */
  peakSeverity?: AlertSeverity;
}

/** The episode identity: the dedupe key with its UTC-day and severity segments normalised. */
export function episodeIdentity(dedupeKey: string): string {
  return dedupeKey
    .replace(/:\d{4}-\d{2}-\d{2}(?=:|$)/g, ":<day>")
    .replace(/:(warning|critical)(?=:|$)/g, ":<severity>");
}

export function recoveryKeyOf(identity: string, firstFiredAtISO: string): string {
  return `${identity}:recovered:${firstFiredAtISO}`;
}

/**
 * Which rules produced a TRUSTWORTHY verdict this cycle — the only rules whose
 * absent signals may count toward recovery. Mirrors `evaluateAlertRules`'
 * dispatch: live, enabled, and its authority gathered; plus the two authorities
 * whose answer can be a floor (AI spend with unpriced calls, a truncated
 * incident scan), where absence proves nothing.
 */
export function cleanlyEvaluatedRules(
  authorities: AuthorityOutputs,
  isEnabled: (ruleId: string) => boolean,
  rules: readonly AlertRuleDefinition[],
  /** The evaluator's own `notEvaluable` verdicts (evaluateAlertRulesDetailed): treated exactly like disabled / dormant / partial. */
  notEvaluable: ReadonlyMap<string, string> = new Map(),
): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (!rule.live || !isEnabled(rule.id)) continue;
    // An evaluator that declined to judge (unpriced, nothing recorded, short history, source missing) is UNKNOWN.
    if (notEvaluable.has(rule.id)) continue;
    let ok: boolean;
    switch (rule.kind) {
      case "job-failing":
      case "scheduler-silent":   ok = authorities.jobHealth != null; break;
      case "provider-unhealthy": ok = authorities.connectionHealth != null; break;
      case "resource-stale":     ok = authorities.resourceFreshness != null; break;
      case "ai-failing":         ok = authorities.aiFailures != null; break;
      case "ai-spend-fleet":
      case "ai-spend-user":      ok = authorities.aiSpend != null && authorities.aiSpend.unpricedInvocations === 0; break;
      case "sync-incident":      ok = authorities.syncIncidents != null && !authorities.syncIncidents.scanTruncated; break;
      case "policy-assignment":  ok = authorities.policyAssignments != null; break;
      case "ai-spend-anomaly":
      case "ai-spend-user-anomaly": ok = authorities.aiSpendAnomaly != null; break;
      case "plaid-call-anomaly": ok = authorities.plaidCallAnomaly != null; break;
      case "platform-ai-purge-late": ok = authorities.platformAiPurge != null; break;
      default:                   ok = false; // dormant kinds have no authority
    }
    if (ok) out.add(rule.id);
  }
  return out;
}

/**
 * The previous state. The newest run that RECORDED `open` is authoritative. With
 * none (the first runs after this ships), the episodes are seeded from the
 * retained `fired` records — each a delivered breach — so a breach delivered
 * just before the deploy still gets its recovery.
 */
export function previousOpen(recentNewestFirst: readonly { open?: AlertOpenRecord[]; fired: readonly { ruleId: string; kind: AlertSignal["kind"]; dedupeKey: string; severity: AlertSeverity; deliveredAtISO: string }[] }[]): AlertOpenRecord[] {
  const withState = recentNewestFirst.find((r) => Array.isArray(r.open));
  if (withState) return withState.open!.map((o) => ({ ...o }));
  const byIdentity = new Map<string, AlertOpenRecord>();
  for (const run of [...recentNewestFirst].reverse()) {
    for (const f of run.fired) {
      if (Number.isNaN(Date.parse(f.deliveredAtISO))) continue;
      const identity = episodeIdentity(f.dedupeKey);
      const prev = byIdentity.get(identity);
      byIdentity.set(identity, {
        identity, ruleId: f.ruleId, kind: f.kind, dedupeKey: f.dedupeKey, severity: f.severity,
        firstFiredAtISO: prev?.firstFiredAtISO ?? f.deliveredAtISO,
        lastSeenAtISO: f.deliveredAtISO, absentEvaluations: 0, clearedAtISO: null,
      });
    }
  }
  return [...byIdentity.values()];
}

/** Every recovery key recorded as delivered in the retained runs. */
export function deliveredRecoveryKeys(recent: readonly { recovered?: AlertRecoveredRecord[] }[]): Set<string> {
  const out = new Set<string>();
  for (const run of recent) for (const r of run.recovered ?? []) out.add(r.recoveryKey);
  return out;
}

/**
 * Once an episode has recovered, its last firing delivery must no longer
 * suppress a RE-FIRE: drop from the suppression map every dedupe key of an
 * episode whose recovery was delivered after that key's last delivery.
 */
export function clearRecoveredSuppression(
  priorFired: Map<string, number>,
  recent: readonly { recovered?: AlertRecoveredRecord[] }[],
): Map<string, number> {
  const recoveredAt = new Map<string, number>();
  for (const run of recent) {
    for (const r of run.recovered ?? []) {
      const t = Date.parse(r.recoveredAtISO);
      if (!Number.isNaN(t) && t > (recoveredAt.get(r.identity) ?? -Infinity)) recoveredAt.set(r.identity, t);
    }
  }
  for (const [key, deliveredMs] of [...priorFired]) {
    const t = recoveredAt.get(episodeIdentity(key));
    if (t !== undefined && t >= deliveredMs) priorFired.delete(key);
  }
  return priorFired;
}

export interface RecoveryAdvance {
  /** The state after this cycle's signals, BEFORE recovery delivery (recovered candidates still present). */
  open: AlertOpenRecord[];
  /** Episodes that have now been absent long enough and whose recovery has not been delivered. */
  due: AlertOpenRecord[];
  /** Episodes whose recovery key was already delivered (a repeated wake) — dropped, never re-sent. */
  alreadyRecovered: AlertOpenRecord[];
  /** Episodes dropped as too old to report. */
  expired: AlertOpenRecord[];
}

/** PURE — advance the previous state by one evaluation. */
export function advanceRecovery(input: {
  previous: readonly AlertOpenRecord[];
  signals: readonly AlertSignal[];
  cleanlyEvaluated: ReadonlySet<string>;
  deliveredRecoveries: ReadonlySet<string>;
  nowISO: string;
  absentEvaluations?: number;
  maxAgeMs?: number;
}): RecoveryAdvance {
  const n = input.absentEvaluations ?? RECOVERY_ABSENT_EVALUATIONS;
  const maxAge = input.maxAgeMs ?? RECOVERY_STATE_MAX_AGE_MS;
  const nowMs = Date.parse(input.nowISO);
  const firing = new Map<string, AlertSignal>();
  for (const s of input.signals) firing.set(episodeIdentity(s.dedupeKey), s);

  const open: AlertOpenRecord[] = [], due: AlertOpenRecord[] = [], alreadyRecovered: AlertOpenRecord[] = [], expired: AlertOpenRecord[] = [];
  for (const p of input.previous) {
    const s = firing.get(p.identity);
    let next: AlertOpenRecord;
    if (s) {
      next = { ...p, dedupeKey: s.dedupeKey, severity: s.severity, lastSeenAtISO: input.nowISO, absentEvaluations: 0, clearedAtISO: null };
    } else if (input.cleanlyEvaluated.has(p.ruleId)) {
      next = { ...p, absentEvaluations: p.absentEvaluations + 1, clearedAtISO: p.clearedAtISO ?? input.nowISO };
    } else {
      next = { ...p }; // unknown — neither present nor absent
    }
    // Age is measured from when it CLEARED — never firstFired, never while firing or unknown.
    if (!s && next.clearedAtISO !== null && nowMs - Date.parse(next.clearedAtISO) > maxAge) { expired.push(next); continue; }
    if (next.absentEvaluations >= n) {
      if (input.deliveredRecoveries.has(recoveryKeyOf(next.identity, next.firstFiredAtISO))) { alreadyRecovered.push(next); continue; }
      due.push(next);
    }
    open.push(next);
  }
  return { open, due, alreadyRecovered, expired };
}

/** The episodes this cycle's DELIVERED firing emails open (an identity already open keeps its first-fired time). */
export function openDelivered(open: readonly AlertOpenRecord[], delivered: readonly AlertSignal[], nowISO: string): AlertOpenRecord[] {
  const out = open.map((o) => ({ ...o }));
  const idx = new Map(out.map((o, i) => [o.identity, i]));
  for (const s of delivered) {
    const identity = episodeIdentity(s.dedupeKey);
    if (idx.has(identity)) continue;
    idx.set(identity, out.length);
    out.push({
      identity, ruleId: s.ruleId, kind: s.kind, dedupeKey: s.dedupeKey, severity: s.severity,
      firstFiredAtISO: nowISO, lastSeenAtISO: nowISO, absentEvaluations: 0, clearedAtISO: null,
    });
  }
  return out;
}

/** The persisted record of a delivered recovery. */
export function recoveredRecord(o: AlertOpenRecord, recoveredAtISO: string): AlertRecoveredRecord {
  const clearedAtISO = o.clearedAtISO ?? recoveredAtISO;
  return {
    identity: o.identity, ruleId: o.ruleId, kind: o.kind, dedupeKey: o.dedupeKey,
    recoveryKey: recoveryKeyOf(o.identity, o.firstFiredAtISO),
    firstFiredAtISO: o.firstFiredAtISO, clearedAtISO, recoveredAtISO,
    durationMs: Math.max(0, Date.parse(clearedAtISO) - Date.parse(o.firstFiredAtISO)),
  };
}

/** "3 h 20 min", "45 min", "2 d 4 h" — whole minutes, never negative. */
export function durationLabel(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d > 0) return `${d} d${h > 0 ? ` ${h} h` : ""}`;
  if (h > 0) return `${h} h${min > 0 ? ` ${min} min` : ""}`;
  return `${min} min`;
}

/** Newest-first recoveries across the retained runs, for the alerts view. */
export function collectRecentRecoveries(recent: readonly { recovered?: AlertRecoveredRecord[] }[], cap = 20): AlertRecoveredRecord[] {
  const all: AlertRecoveredRecord[] = [];
  for (const run of recent) for (const r of run.recovered ?? []) all.push(r);
  all.sort((a, b) => Date.parse(b.recoveredAtISO) - Date.parse(a.recoveredAtISO));
  return all.slice(0, cap);
}

/** The recovery that closed the episode of a fire delivered at `deliveredAtISO`, if any. */
export function recoveryAfter(fire: { dedupeKey: string; deliveredAtISO: string }, recoveries: readonly AlertRecoveredRecord[]): AlertRecoveredRecord | null {
  const identity = episodeIdentity(fire.dedupeKey);
  const t = Date.parse(fire.deliveredAtISO);
  const matches = recoveries.filter((r) => r.identity === identity && Date.parse(r.recoveredAtISO) >= t)
    .sort((a, b) => Date.parse(a.recoveredAtISO) - Date.parse(b.recoveredAtISO));
  return matches[0] ?? null;
}

// ── Flap protection ──────────────────────────────────────────────────────────

/** The previous flap state: the newest run that recorded `flap`. */
export function previousFlap(recentNewestFirst: readonly { flap?: AlertFlapRecord[] }[]): AlertFlapRecord[] {
  const withState = recentNewestFirst.find((r) => Array.isArray(r.flap));
  return withState ? withState.flap!.map((f) => ({ ...f, recoveriesAtISO: [...f.recoveriesAtISO] })) : [];
}

/** Recoveries still inside the window. */
export function recoveriesInWindow(f: Pick<AlertFlapRecord, "recoveriesAtISO">, nowISO: string, windowMs = FLAP_WINDOW_MS): string[] {
  const now = Date.parse(nowISO);
  return f.recoveriesAtISO.filter((t) => now - Date.parse(t) < windowMs);
}

/** Would one more recovery of this identity make it flap? */
export function wouldFlap(f: AlertFlapRecord | undefined, nowISO: string, k = FLAP_RECOVERIES): boolean {
  return (f ? recoveriesInWindow(f, nowISO).length : 0) + 1 >= k;
}

/** PURE — a flapping identity's clean streak advanced by one evaluation. */
export function advanceFlapping(f: AlertFlapRecord, firing: boolean, cleanlyEvaluated: boolean, nowISO: string): AlertFlapRecord {
  if (firing) return { ...f, cleanEvaluations: 0, cleanSinceISO: null };
  if (cleanlyEvaluated) return { ...f, cleanEvaluations: f.cleanEvaluations + 1, cleanSinceISO: f.cleanSinceISO ?? nowISO };
  return { ...f }; // unknown: neither clean nor firing — never advances
}

/** Every flapping-notice key recorded as delivered in the retained runs. */
export function deliveredFlapNotices(recent: readonly { flapNotices?: string[] }[]): Set<string> {
  const out = new Set<string>();
  for (const run of recent) for (const k of run.flapNotices ?? []) out.add(k);
  return out;
}

export function stableKeyOf(identity: string, flappingSinceISO: string): string {
  return `${identity}:stable:${flappingSinceISO}`;
}
export function flappingKeyOf(identity: string, nowISO: string): string {
  return `${identity}:flapping:${nowISO}`;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { warning: 0, critical: 1 };

/** Does `severity` escalate past what this flapping identity has already emailed? */
export function escalatesFlap(f: Pick<AlertFlapRecord, "flappingSeverity">, severity: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] > SEVERITY_RANK[f.flappingSeverity ?? "warning"];
}

/** The escalation's own dedupe key (one per severity per flapping period). */
export function escalationKeyOf(identity: string, severity: AlertSeverity, flappingSinceISO: string): string {
  return `${identity}:escalated:${severity}:${flappingSinceISO}`;
}

/** "Flapped up to CRITICAL between <since> and <cleared>" — the stable-again line (dates pre-formatted by the caller). */
export function flapPeakLine(peak: AlertSeverity, sinceLabel: string, clearedLabel: string): string {
  return `Flapped up to ${peak.toUpperCase()} between ${sinceLabel} and ${clearedLabel}`;
}
