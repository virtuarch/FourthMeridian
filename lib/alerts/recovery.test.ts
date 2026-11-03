/**
 * lib/alerts/recovery.test.ts  (alert RECOVERY notifications)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/alerts/recovery.test.ts
 *
 * Drives evaluatePlatformAlerts cycle by cycle with injected authorities, a
 * JobRun ledger held in memory (each cycle's summary is the next cycle's
 * history, newest first — exactly what loadRecentAlertRuns returns) and the
 * fake sender. Pins:
 *   - fire → absent × N → exactly ONE recovery email (resolved variant);
 *   - flapping within N → no recovery;
 *   - an UNAVAILABLE evaluation is not counted as absent;
 *   - re-fire after recovery → a NEW firing email, then a recovery later;
 *   - no destination → skipped and recorded; delivered once a destination exists;
 *   - idempotent across wakes (a replayed state never re-sends);
 *   - a day-keyed breach that persists past midnight is NOT a recovery;
 *   - the resolved template renders rule, first fired, cleared, duration.
 * No DB, no network, no real email.
 */

import type { AuthorityOutputs, AlertJobHealth } from "@/lib/alerts/authorities";
import type { AlertEmailData, AlertRunSummary } from "@/lib/alerts/evaluate";
import { evaluatePlatformAlerts } from "@/lib/alerts/run";
import {
  FLAP_RECOVERIES, FLAP_STABLE_EVALUATIONS, FLAP_WINDOW_MS, RECOVERY_ABSENT_EVALUATIONS, RECOVERY_STATE_MAX_AGE_MS,
  advanceRecovery, collectRecentRecoveries, durationLabel, episodeIdentity, recoveryAfter,
} from "@/lib/alerts/recovery";
import { evaluateAlertRulesDetailed } from "@/lib/alerts/evaluate";
import type { PlaidCallAnomalyFacts } from "@/lib/alerts/authorities";
import { latestAlertEvaluation, undeliveredSentence } from "@/lib/alerts/latest-evaluation";
import { expiredRecoveries, expiredRecoveriesSentence } from "@/components/platform/widgets/OpsAlertsWidget";
import { renderPlatformAlert } from "@/lib/email/templates/platform-alert";

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-opaque-ref-secret";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});

const T0 = Date.parse("2026-11-03T08:00:00.000Z");
const HOUR = 3_600_000;
const at = (h: number) => new Date(T0 + h * HOUR);

const failing: AlertJobHealth = { jobs: [{ job: "sync-banks", status: "failing", expectedEveryHours: 1, consecutiveFailures: 3 }] };
const healthy: AlertJobHealth = { jobs: [{ job: "sync-banks", status: "healthy", expectedEveryHours: 1, consecutiveFailures: 0 }] };
const authorities = (jobHealth: AlertJobHealth | null, extra: Partial<AuthorityOutputs> = {}): AuthorityOutputs => ({
  jobHealth, connectionHealth: null, resourceFreshness: null, aiFailures: null, aiSpend: null, syncIncidents: null, policyAssignments: null, ...extra,
});

/** A ledger + fake sender; `cycle` runs one evaluation and appends its summary. */
function harness() {
  const runs: AlertRunSummary[] = []; // newest first
  const mail: { data: AlertEmailData; idempotencyKey?: string }[] = [];
  let destination: string | null = "ops@example.invalid";
  async function cycle(h: number, jobHealth: AlertJobHealth | null, opts: { persist?: boolean; extra?: Partial<AuthorityOutputs> } = {}) {
    const s = await evaluatePlatformAlerts({
      now: at(h),
      gatherAuthorities: async () => authorities(jobHealth, opts.extra),
      loadSettings: async () => new Map(),
      loadRecentRuns: async (limit) => runs.slice(0, limit),
      resolveDestination: () => destination,
      sendAlertEmail: async (_to, data, o) => { mail.push({ data, idempotencyKey: o?.idempotencyKey }); return { status: "sent" }; },
      environment: "production",
      ledgerStartWriteFailed: () => false,
    });
    if (opts.persist !== false) runs.unshift(s);
    return s;
  }
  const firingMails = () => mail.filter((m) => !m.data.resolved && !m.data.flapping);
  const recoveryMails = () => mail.filter((m) => m.data.resolved);
  return { runs, mail, cycle, firingMails, recoveryMails, setDestination: (d: string | null) => { destination = d; } };
}

async function main() {
  console.log("1. fire → absent × N → exactly one recovery");
  {
    const t = harness();
    const s0 = await t.cycle(0, failing);
    check("the breach fires and is delivered", s0.counts.delivered === 1 && t.firingMails().length === 1);
    check("…and enters the recovery state", s0.open?.length === 1 && s0.open[0].identity === "job-failing:sync-banks" && s0.open[0].absentEvaluations === 0);
    const s1 = await t.cycle(1, healthy);
    check(`absent once (N = ${RECOVERY_ABSENT_EVALUATIONS}) ⇒ no recovery yet`, t.recoveryMails().length === 0 && s1.open?.[0].absentEvaluations === 1 && s1.open?.[0].clearedAtISO === at(1).toISOString());
    const s2 = await t.cycle(2, healthy);
    check("absent N times ⇒ exactly ONE recovery email", t.recoveryMails().length === 1 && s2.counts.recovered === 1 && s2.recovered?.length === 1);
    const r = t.recoveryMails()[0];
    check("it is the resolved variant naming the rule, first fired, cleared and the duration",
      r.data.resolved?.ruleId === "job-failing" && r.data.resolved.ruleTitle === "Repeated job failures"
        && r.data.resolved.firstFiredAtISO === at(0).toISOString() && r.data.resolved.clearedAtISO === at(1).toISOString()
        && r.data.resolved.durationLabel === "1 h" && r.data.alerts.length === 0);
    check("it carries its OWN dedupe key, as the provider idempotency key",
      r.idempotencyKey === `job-failing:sync-banks:recovered:${at(0).toISOString()}` && s2.recovered?.[0].recoveryKey === r.idempotencyKey);
    check("the episode leaves the state", s2.open?.length === 0);
    await t.cycle(3, healthy); await t.cycle(4, healthy);
    check("later quiet cycles send nothing more", t.recoveryMails().length === 1 && t.firingMails().length === 1);
  }

  console.log("\n2. flapping within N → no recovery");
  {
    const t = harness();
    await t.cycle(0, failing);
    await t.cycle(1, healthy);   // absent 1
    const back = await t.cycle(2, failing); // back — resets
    check("a return before N resets the count", back.open?.[0].absentEvaluations === 0 && back.open[0].clearedAtISO === null);
    await t.cycle(3, healthy);   // absent 1
    await t.cycle(4, failing);
    await t.cycle(5, healthy);
    check("…so an alternating breach never recovers", t.recoveryMails().length === 0);
    check("and the ongoing breach stays suppressed (one firing email)", t.firingMails().length === 1);
  }

  console.log("\n3. an UNAVAILABLE evaluation is not absence");
  {
    const t = harness();
    await t.cycle(0, failing);
    await t.cycle(1, null); // job-health did not gather
    await t.cycle(2, null);
    const s = await t.cycle(3, null);
    check("three cycles with the authority unavailable ⇒ no recovery, count unchanged", t.recoveryMails().length === 0 && s.open?.[0].absentEvaluations === 0);
    await t.cycle(4, healthy);
    check("one clean absent cycle after that ⇒ still not N", t.recoveryMails().length === 0);
    await t.cycle(5, null);
    check("an unavailable cycle between does not complete the streak", t.recoveryMails().length === 0);
    await t.cycle(6, healthy);
    check("the second CLEAN absent cycle recovers", t.recoveryMails().length === 1);
    // A disabled rule is not evaluated either.
    const u = harness();
    await u.cycle(0, failing);
    const disabled = async (h: number) => evaluatePlatformAlerts({
      now: at(h), gatherAuthorities: async () => authorities(healthy), loadSettings: async () => new Map([["alert_rule_enabled:job-failing", "false"]]),
      loadRecentRuns: async (l) => u.runs.slice(0, l), resolveDestination: () => "ops@example.invalid",
      sendAlertEmail: async (_t, data) => { u.mail.push({ data }); return { status: "sent" }; }, environment: "production", ledgerStartWriteFailed: () => false,
    }).then((s) => { u.runs.unshift(s); return s; });
    await disabled(1); await disabled(2); await disabled(3);
    check("a DISABLED rule's silence is not recovery", u.recoveryMails().length === 0);
    // Partial authority: AI spend with unpriced calls proves nothing.
    const adv = advanceRecovery({
      previous: [{ identity: "ai-spend-fleet-high:fleet:<day>", ruleId: "ai-spend-fleet-high", kind: "ai-spend-fleet", dedupeKey: "ai-spend-fleet-high:fleet:2026-11-03", severity: "warning", firstFiredAtISO: at(0).toISOString(), lastSeenAtISO: at(0).toISOString(), absentEvaluations: 5, clearedAtISO: at(1).toISOString() }],
      signals: [], cleanlyEvaluated: new Set(), deliveredRecoveries: new Set(), nowISO: at(6).toISOString(),
    });
    check("a rule not cleanly evaluated keeps its count (no increment)", adv.open[0].absentEvaluations === 5);
  }

  console.log("\n4. re-fire after recovery → a new firing email, then a recovery");
  {
    const t = harness();
    await t.cycle(0, failing); await t.cycle(1, healthy); await t.cycle(2, healthy);
    check("recovered once", t.recoveryMails().length === 1 && t.firingMails().length === 1);
    const refire = await t.cycle(3, failing); // within the 20 h re-notify window of the first delivery
    check("the re-fire is EMAILED at once (recovery cleared its suppression)", t.firingMails().length === 2 && refire.counts.delivered === 1 && refire.counts.suppressed === 0);
    check("…and opens a new episode", refire.open?.length === 1 && refire.open[0].firstFiredAtISO === at(3).toISOString());
    await t.cycle(4, failing);
    check("while it persists it is suppressed again", t.firingMails().length === 2);
    // Keep it firing past the flap window (FLAP_WINDOW_MS) so the next recovery is an ordinary one.
    for (let h = 5; h <= 27; h++) await t.cycle(h, failing);
    await t.cycle(28, healthy); await t.cycle(29, healthy);
    const recs = t.recoveryMails();
    check("a second recovery OUTSIDE the flap window, for the new episode, with its own key",
      recs.length === 2 && !recs[1].data.resolved?.variant && recs[1].idempotencyKey === `job-failing:sync-banks:recovered:${at(3).toISOString()}` && recs[1].data.resolved?.durationLabel === "1 d 1 h");
  }

  console.log("\n5. no destination → skipped and recorded; delivered once one exists");
  {
    const t = harness();
    await t.cycle(0, failing);
    t.setDestination(null);
    await t.cycle(1, healthy);
    const s = await t.cycle(2, healthy);
    check("due but no destination ⇒ nothing sent, recorded as NO_DESTINATION", t.recoveryMails().length === 0 && s.recoveryUndelivered?.reason === "NO_DESTINATION" && s.recoveryUndelivered.breaches === 1);
    check("…and the episode is still tracked (it retries)", s.open?.length === 1 && (s.recovered ?? []).length === 0);
    const again = await t.cycle(3, healthy);
    check("the next cycle records it again (same as a firing breach with nowhere to go)", again.recoveryUndelivered?.reason === "NO_DESTINATION");
    t.setDestination("ops@example.invalid");
    await t.cycle(4, healthy);
    check("a destination appears ⇒ the ONE recovery is delivered", t.recoveryMails().length === 1);
    // OBS-003 — capture outside development is not delivery.
    const c = harness();
    await c.cycle(0, failing); await c.cycle(1, healthy);
    const cap = await evaluatePlatformAlerts({
      now: at(2), gatherAuthorities: async () => authorities(healthy), loadSettings: async () => new Map(),
      loadRecentRuns: async (l) => c.runs.slice(0, l), resolveDestination: () => "ops@example.invalid",
      sendAlertEmail: async () => ({ status: "captured", provider: "capture" }), environment: "production", ledgerStartWriteFailed: () => false,
    });
    check("captured outside development ⇒ NOT delivered, NO_EMAIL_TRANSPORT, still tracked", cap.recoveryUndelivered?.reason === "NO_EMAIL_TRANSPORT" && cap.open?.length === 1 && (cap.recovered ?? []).length === 0);
    // OBS-015 — the circuit breaker applies to recoveries too.
    const lw = await evaluatePlatformAlerts({
      now: at(2), gatherAuthorities: async () => authorities(healthy), loadSettings: async () => new Map(),
      loadRecentRuns: async (l) => c.runs.slice(0, l), resolveDestination: () => "ops@example.invalid",
      sendAlertEmail: async () => { throw new Error("must not send"); }, environment: "production", ledgerStartWriteFailed: () => true,
    });
    check("JobRun start write failed ⇒ circuit-broken, LEDGER_WRITE_FAILED, nothing sent", lw.recoveryUndelivered?.reason === "LEDGER_WRITE_FAILED");
  }

  console.log("\n6. idempotent across wakes");
  {
    const t = harness();
    await t.cycle(0, failing); await t.cycle(1, healthy);
    // Two wakes evaluate the SAME prior state (neither sees the other's row) — the provider idempotency key is identical.
    await t.cycle(2, healthy, { persist: false });
    await t.cycle(2, healthy, { persist: false });
    check("both wakes carry the same recovery key (the provider dedupes)", t.recoveryMails().length === 2 && t.recoveryMails()[0].idempotencyKey === t.recoveryMails()[1].idempotencyKey);
    // Once one wake's row is in the ledger, every later wake sees the delivered key and never re-sends.
    const s = await t.cycle(2, healthy);
    const n = t.recoveryMails().length;
    // Replay: an older state row (still listing the episode as due) newest after the delivered one.
    const replayed = [{ ...t.runs[1] }, ...t.runs];
    const r = await evaluatePlatformAlerts({
      now: at(3), gatherAuthorities: async () => authorities(healthy), loadSettings: async () => new Map(),
      loadRecentRuns: async (l) => replayed.slice(0, l), resolveDestination: () => "ops@example.invalid",
      sendAlertEmail: async (_t, data) => { t.mail.push({ data }); return { status: "sent" }; }, environment: "production", ledgerStartWriteFailed: () => false,
    });
    check("a replayed state whose recovery key is already delivered sends nothing", t.recoveryMails().length === n && (r.recovered ?? []).length === 0 && s.counts.recovered === 1);
    check("…and drops the episode", r.open?.length === 0);
  }

  console.log("\n7. episode identity: a day-keyed or escalating key is not a recovery");
  {
    check("the UTC day and severity segments are normalised",
      episodeIdentity("ai-spend-fleet-high:fleet:2026-11-03") === "ai-spend-fleet-high:fleet:<day>"
        && episodeIdentity("ai-spend-user-high:user:2026-11-03:abc123") === "ai-spend-user-high:user:<day>:abc123"
        && episodeIdentity("policy-assignment-invalid:critical:missing") === "policy-assignment-invalid:<severity>:missing"
        && episodeIdentity("job-failing:sync-banks") === "job-failing:sync-banks");
    const prev = [{ identity: "ai-spend-fleet-high:fleet:<day>", ruleId: "ai-spend-fleet-high", kind: "ai-spend-fleet" as const, dedupeKey: "ai-spend-fleet-high:fleet:2026-11-03", severity: "warning" as const, firstFiredAtISO: at(0).toISOString(), lastSeenAtISO: at(0).toISOString(), absentEvaluations: 0, clearedAtISO: null }];
    const nextDay = advanceRecovery({
      previous: prev,
      signals: [{ ruleId: "ai-spend-fleet-high", kind: "ai-spend-fleet", severity: "warning", dedupeKey: "ai-spend-fleet-high:fleet:2026-11-04", summary: "s" }],
      cleanlyEvaluated: new Set(["ai-spend-fleet-high"]), deliveredRecoveries: new Set(), nowISO: at(20).toISOString(),
    });
    check("the next day's key keeps the episode present (no absence)", nextDay.open[0].absentEvaluations === 0 && nextDay.open[0].dedupeKey.endsWith("2026-11-04") && nextDay.due.length === 0);
  }

  console.log("\n8. the resolved template + the alerts view");
  {
    const r = renderPlatformAlert({
      evaluatedAtISO: at(2).toISOString(), alerts: [],
      resolved: { ruleId: "job-failing", ruleTitle: "Repeated job failures", dedupeKey: "job-failing:sync-banks", firstFiredAtISO: at(0).toISOString(), clearedAtISO: at(1).toISOString(), durationLabel: "1 h" },
    });
    check("subject says resolved and names the rule", /platform alert resolved: Repeated job failures/.test(r.subject));
    check("body names first fired, cleared and duration", /First fired:/.test(r.text) && /Cleared:/.test(r.text) && /Duration: 1 h/.test(r.text) && /job-failing/.test(r.text));
    const firing = renderPlatformAlert({ evaluatedAtISO: at(0).toISOString(), alerts: [{ title: "job-failing:sync-banks", severity: "critical", summary: "failed" }] });
    check("a firing email (no `resolved`) renders as before", /platform alert: 1 issue\(s\) \(1 critical\)/.test(firing.subject));
    check("duration labels", durationLabel(45 * 60_000) === "45 min" && durationLabel(200 * 60_000) === "3 h 20 min" && durationLabel(52 * HOUR) === "2 d 4 h");
    const t = harness();
    await t.cycle(0, failing); await t.cycle(1, healthy); await t.cycle(2, healthy);
    const recs = collectRecentRecoveries(t.runs);
    const fire = t.runs.flatMap((s) => s.fired)[0];
    const rec = recoveryAfter(fire, recs);
    check("the alerts view can say 'recovered at …' for the fire", recs.length === 1 && rec?.recoveredAtISO === at(2).toISOString());
  }

  console.log(`\n9. FLAP BOUND: K = ${FLAP_RECOVERIES} recoveries / ${FLAP_WINDOW_MS / HOUR} h ⇒ one flapping email; a 24 h flap sends ≤ 4`);
  {
    const t = harness();
    const Q = 0.25; // the evaluator's 15-min wake
    // fire → clean → clean → fire … for 24 h.
    for (let i = 0; i < 96; i++) await t.cycle(i * Q, i % 3 === 0 ? failing : healthy);
    const flapMails = t.mail.filter((m) => m.data.flapping);
    check("at most 4 emails across a 24 h flap (fire, recovery, re-fire, flapping)", t.mail.length <= 4, String(t.mail.length));
    check("…exactly: 2 firing, 1 recovery, 1 flapping", t.firingMails().length === 2 && t.mail.filter((m) => m.data.resolved).length === 1 && flapMails.length === 1);
    check("the flapping email names the rule, the count and the stable bound",
      flapMails[0]?.data.flapping?.ruleId === "job-failing" && flapMails[0].data.flapping.recoveries === 2 && flapMails[0].data.flapping.stableAfterEvaluations === FLAP_STABLE_EVALUATIONS);
    const flapState = t.runs[0].flap?.find((f) => f.identity === "job-failing:sync-banks");
    check("the identity is recorded as flapping in the summary", flapState?.flappingSinceISO != null);
    check("…and its firing signals are counted suppressed, not delivered", t.runs[0].counts.delivered === 0);
    // Now stable: FLAP_STABLE_EVALUATIONS consecutive clean evaluations since the last fire ⇒ ONE "stable again".
    // The 24 h loop ended on two clean evaluations (i = 94, 95), so 5 more make 7.
    const start = 96 * Q;
    check("fixture: the loop ended two clean evaluations after the last fire", t.runs[0].flap?.find((f) => f.flappingSinceISO)?.cleanEvaluations === 2);
    for (let i = 0; i < FLAP_STABLE_EVALUATIONS - 3; i++) await t.cycle(start + i * Q, healthy);
    check(`${FLAP_STABLE_EVALUATIONS - 1} clean evaluations ⇒ not yet stable`, !t.mail.some((m) => m.data.resolved?.variant === "stable"));
    // An unavailable cycle does not count toward stable.
    await t.cycle(start + 7 * Q, null);
    check("an unavailable evaluation does not complete the stable streak", !t.mail.some((m) => m.data.resolved?.variant === "stable"));
    await t.cycle(start + 8 * Q, healthy);
    const stable = t.mail.filter((m) => m.data.resolved?.variant === "stable");
    check("the 8th clean evaluation ⇒ exactly ONE 'stable again' email", stable.length === 1 && stable[0].idempotencyKey?.includes(":stable:") === true);
    check("…and the flap state is cleared", !(t.runs[0].flap ?? []).some((f) => f.flappingSinceISO));
    await t.cycle(start + 9 * Q, healthy); await t.cycle(start + 10 * Q, healthy);
    check("no further stable emails", t.mail.filter((m) => m.data.resolved?.variant === "stable").length === 1);
    const refire = await t.cycle(start + 11 * Q, failing);
    check("after stable, a re-fire is emailed again", refire.counts.delivered === 1);
    // The flapping notice is sent through the same gates.
    const n = harness();
    for (let i = 0; i < 5; i++) await n.cycle(i * Q, i % 3 === 0 ? failing : healthy);
    n.setDestination(null);
    const s = await n.cycle(5 * Q, healthy);
    check("a flapping notice with no destination ⇒ not sent, recorded, not flapping yet", s.recoveryUndelivered?.reason === "NO_DESTINATION" && !(s.flap ?? []).some((f) => f.flappingSinceISO));
  }

  console.log("\n10. notEvaluable (anomaly rules) is UNKNOWN: never a recovery");
  {
    const plaid = (current: number | null, baseline: number[]): PlaidCallAnomalyFacts => ({
      checkedAt: at(0).toISOString(), dayISO: "2026-11-02",
      current: current === null ? { kind: "IDLE" } : { kind: "VALUE", value: current },
      baseline: baseline.map((v) => ({ kind: "VALUE" as const, value: v })),
    }) as PlaidCallAnomalyFacts;
    const firingFacts = plaid(400, [50, 50, 50, 50, 50, 50, 50]);
    const shortFacts = plaid(5, []); // no history ⇒ not evaluable
    const det = evaluateAlertRulesDetailed(authorities(null, { plaidCallAnomaly: shortFacts }), () => true);
    check("fixture: short history is notEvaluable", det.notEvaluable.has("plaid-call-anomaly"));
    const t = harness();
    const s0 = await t.cycle(0, null, { extra: { plaidCallAnomaly: firingFacts } });
    check("fixture: the anomaly fired and was delivered", s0.fired.some((f) => f.ruleId === "plaid-call-anomaly"));
    for (let h = 1; h <= RECOVERY_ABSENT_EVALUATIONS + 3; h++) await t.cycle(h, null, { extra: { plaidCallAnomaly: shortFacts } });
    check(`notEvaluable for ${RECOVERY_ABSENT_EVALUATIONS + 3} cycles ⇒ NO recovery, count never advanced`,
      t.recoveryMails().length === 0 && t.runs[0].open?.find((o) => o.ruleId === "plaid-call-anomaly")?.absentEvaluations === 0);
    for (let h = 10; h <= 12; h++) await t.cycle(h, null, { extra: { plaidCallAnomaly: null } });
    check("…nor when the anomaly source did not load", t.recoveryMails().length === 0);
    await t.cycle(13, null, { extra: { plaidCallAnomaly: plaid(50, [50, 50, 50, 50, 50, 50, 50]) } });
    await t.cycle(14, null, { extra: { plaidCallAnomaly: plaid(50, [50, 50, 50, 50, 50, 50, 50]) } });
    check("two genuinely NORMAL evaluations ⇒ the one recovery", t.recoveryMails().length === 1 && t.recoveryMails()[0].data.resolved?.ruleId === "plaid-call-anomaly");
  }

  console.log("\n11. the 7-day drop: keyed on clearedAt, never on a still-firing episode");
  {
    const t = harness();
    await t.cycle(0, failing);
    for (let h = 1; h <= 24 * 8; h += 12) await t.cycle(h, failing); // a week-long outage
    const s = t.runs[0];
    check("a breach firing for 8 days keeps its open state (never expired)", s.open?.length === 1 && (s.counts.recoveryExpired ?? 0) === 0);
    const u = harness();
    await u.cycle(0, failing);
    for (let h = 1; h <= 24 * 8; h += 12) await u.cycle(h, null); // unknown for a week: never cleared
    check("unknown for 8 days (never cleared) keeps its state", u.runs[0].open?.length === 1);
    const d = harness();
    await d.cycle(0, failing);
    d.setDestination(null);
    await d.cycle(1, healthy); await d.cycle(2, healthy);
    const H = RECOVERY_STATE_MAX_AGE_MS / HOUR;
    const before = await d.cycle(1 + H - 1, healthy);
    check("cleared and undelivered for < 7 days ⇒ still tracked", before.open?.length === 1 && (before.counts.recoveryExpired ?? 0) === 0);
    const after = await d.cycle(1 + H + 1, healthy);
    check("cleared and undelivered for > 7 days ⇒ dropped, counts.recoveryExpired = 1, reason EXPIRED",
      after.open?.length === 0 && after.counts.recoveryExpired === 1 && after.recoveryUndelivered?.reason === "EXPIRED" && after.recoveryUndelivered.breaches === 1);
    check("no email was sent for it", d.recoveryMails().length === 0);
    const latest = latestAlertEvaluation([after]);
    check("the latest evaluation projects it", latest?.recoveryUndelivered?.reason === "EXPIRED" && /could not be delivered within 7 days/.test(undeliveredSentence(latest.recoveryUndelivered)));
    const view = { destinationConfigured: false, lastEvaluatedAt: after.evaluatedAtISO, rules: [], history: [], historyRuns: 1, latest, latestRecoveryExpired: 1 };
    check("the Alerts widget says 'N recoveries could not be delivered within 7 days'",
      expiredRecoveries(view) === 1 && expiredRecoveriesSentence(1) === "1 recovery could not be delivered within 7 days" && expiredRecoveriesSentence(3) === "3 recoveries could not be delivered within 7 days");
  }

  console.log("\n12. ESCALATION breaks through flap suppression (warning → critical, same identity)");
  {
    const ai = (kind: "warn" | "crit" | "ok") => ({
      aiFailures: {
        windowHours: 24, rateLimited: 0, quota: 0, lastFailureAt: null, lastQuotaAt: null, checkedAt: at(0).toISOString(),
        ...(kind === "warn" ? { returned: 10, failed: 3, timeouts: 0 } : kind === "crit" ? { returned: 0, failed: 5, timeouts: 0 } : { returned: 10, failed: 0, timeouts: 0 }),
      },
    });
    const t = harness();
    const Q = 0.25;
    let i = 0;
    const step = (k: "warn" | "crit" | "ok") => t.cycle((i++) * Q, healthy, { extra: ai(k) });
    // Flap at WARNING: warn, ok, ok, warn, ok, ok ⇒ flapping declared at warning.
    for (const k of ["warn", "ok", "ok", "warn", "ok", "ok"] as const) await step(k);
    const flap = t.runs[0].flap?.find((f) => f.identity === "ai-provider-failing:errors");
    check("fixture: ai-provider-failing:errors is flapping at WARNING", flap?.flappingSinceISO != null && flap.flappingSeverity === "warning");
    const before = t.mail.length;
    for (const k of ["warn", "ok", "ok"] as const) await step(k);
    check("a WARNING re-fire while flapping stays suppressed", t.mail.length === before);
    const esc = await step("crit");
    const escalated = t.mail.slice(before);
    check("the same identity firing CRITICAL ⇒ exactly ONE email, through the normal firing path",
      escalated.length === 1 && !escalated[0].data.resolved && !escalated[0].data.flapping
        && escalated[0].data.alerts.length === 1 && escalated[0].data.alerts[0].severity === "critical" && esc.counts.delivered === 1);
    check("…recorded under its own escalation key, and flappingSeverity is raised",
      (esc.flapNotices ?? []).some((k) => k.startsWith("ai-provider-failing:errors:escalated:critical:")) && esc.flap?.find((f) => f.identity === "ai-provider-failing:errors")?.flappingSeverity === "critical");
    check("…without opening a new episode (the flap owns the identity)", !(esc.open ?? []).some((o) => o.identity === "ai-provider-failing:errors"));
    const after = t.mail.length;
    for (const k of ["ok", "ok", "crit", "ok", "ok", "crit", "warn", "ok", "crit"] as const) await step(k);
    check("continued CRITICAL (and warning) flapping after that is suppressed", t.mail.length === after, String(t.mail.length - after));
  }

  console.log(failures === 0 ? "\nAll alert-recovery checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
