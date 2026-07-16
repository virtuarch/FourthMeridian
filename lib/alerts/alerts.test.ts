/**
 * lib/alerts/alerts.test.ts  (OPS-5 S5 — Alerting)
 *
 * Pure guards for the alerting slice. Standalone tsx script (house pattern):
 * npx tsx lib/alerts/alerts.test.ts — exits 0/1. Auto-discovered by
 * scripts/run-tests.ts.
 *
 * NO LIVE DATABASE / NETWORK: the engine is pure (evaluates over injected
 * authority outputs); the orchestrator runs against fully-injected deps (fake
 * gather/settings/recent-runs/sender/clock). A source-scan pins the load-bearing
 * doctrine: the engine performs no health computation of its own.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { ALERT_RULES } from "@/lib/alerts/rules";
import type { AuthorityOutputs, AlertJobHealth, AlertJobHealthReport } from "@/lib/alerts/authorities";
import {
  alertEnabledKey,
  buildAlertEmailData,
  collectAlertHistory,
  decideDeliveries,
  deriveAlertRuleViews,
  evaluateAlertRules,
  extractPriorFired,
  resolveEnabled,
  DEFAULT_RENOTIFY_HOURS,
  type AlertRunSummary,
} from "@/lib/alerts/evaluate";
import { evaluatePlatformAlerts } from "@/lib/alerts/run";
import type { ConnectionHealthResult, HealthState } from "@/lib/connections/health";
import type { ResourceFreshnessResult, ResourceFreshnessReport, FreshnessHealthState } from "@/lib/platform/resource-freshness";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const NOW = new Date("2026-07-16T08:00:00Z");
const NOW_MS = NOW.getTime();
const HOUR = 60 * 60 * 1000;

// ── Fixture builders ────────────────────────────────────────────────────────────

function job(name: string, status: AlertJobHealthReport["status"], streak = 0): AlertJobHealthReport {
  return { job: name, status, expectedEveryHours: 24, consecutiveFailures: streak };
}
function jobHealth(jobs: AlertJobHealthReport[]): AlertJobHealth {
  return { jobs };
}
function connHealth(counts: Partial<Record<HealthState, number>>): ConnectionHealthResult {
  const full: Record<HealthState, number> = { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0, ...counts };
  const total = (Object.values(full) as number[]).reduce((a, b) => a + b, 0);
  return { total, counts: full, unhealthy: [] };
}
function resource(id: string, state: FreshnessHealthState, trustLevel: "high" | "medium" | "low" | "unknown" = "low"): ResourceFreshnessReport {
  return {
    resource: id, label: id, newestObservedDate: null, ageHours: state === "stale" ? 96 : null, ageDays: state === "stale" ? 4 : null,
    expectedCadenceHours: 24, cadenceLabel: "Daily", staleAfterHours: 48, healthState: state, completeness: null,
    lastSuccessfulRefresh: null, lastAttemptedRefresh: null, lastAttemptStatus: null, trust: { level: trustLevel, caveats: [] },
  };
}
function freshness(resources: ResourceFreshnessReport[]): ResourceFreshnessResult {
  return { checkedAt: NOW, allFresh: resources.every((r) => r.healthState === "fresh" || r.healthState === "idle"), resources };
}
function outputs(o: Partial<AuthorityOutputs>): AuthorityOutputs {
  return { jobHealth: null, connectionHealth: null, resourceFreshness: null, ...o };
}
const ALL_ON = () => true;

// ── Registry shape ───────────────────────────────────────────────────────────────

console.log("registry");
check("five initial rules", ALERT_RULES.length === 5);
check("four live rules", ALERT_RULES.filter((r) => r.live).length === 4);
check("quota-low is the sole dormant rule", ALERT_RULES.filter((r) => !r.live).map((r) => r.id).join() === "quota-low");
check("every rule id unique", new Set(ALERT_RULES.map((r) => r.id)).size === 5);

// ── Engine: job-failing ──────────────────────────────────────────────────────────

console.log("engine · job-failing");
{
  const jh = jobHealth([job("sync-banks", "failing", 3), job("fetch-fx-rates", "healthy"), job("purge-trash", "overdue")]);
  const sigs = evaluateAlertRules(outputs({ jobHealth: jh }), ALL_ON).filter((s) => s.kind === "job-failing");
  check("fires once per failing job", sigs.length === 1);
  check("targets the failing job", sigs[0].dedupeKey === "job-failing:sync-banks");
  check("critical severity", sigs[0].severity === "critical");
  check("does not fire on healthy/overdue/never-ran", !sigs.some((s) => s.dedupeKey.includes("fetch-fx-rates") || s.dedupeKey.includes("purge-trash")));
}

// ── Engine: scheduler-silent ─────────────────────────────────────────────────────

console.log("engine · scheduler-silent");
{
  const jh = jobHealth([job("a", "overdue"), job("b", "never-ran"), job("c", "failing", 3), job("d", "healthy")]);
  const sigs = evaluateAlertRules(outputs({ jobHealth: jh }), ALL_ON).filter((s) => s.kind === "scheduler-silent");
  check("fires on overdue only", sigs.length === 1 && sigs[0].dedupeKey === "scheduler-silent:a");
  check("never-ran does NOT trip scheduler-silent (operator-decides state)", !sigs.some((s) => s.dedupeKey.includes(":b")));
}

// ── Engine: provider-unhealthy ───────────────────────────────────────────────────

console.log("engine · provider-unhealthy");
{
  const none = evaluateAlertRules(outputs({ connectionHealth: connHealth({ HEALTHY: 5 }) }), ALL_ON).filter((s) => s.kind === "provider-unhealthy");
  check("no signal when all healthy", none.length === 0);

  const warn = evaluateAlertRules(outputs({ connectionHealth: connHealth({ HEALTHY: 3, STALE: 2 }) }), ALL_ON).filter((s) => s.kind === "provider-unhealthy");
  check("one aggregate signal when degraded", warn.length === 1 && warn[0].dedupeKey === "provider-unhealthy");
  check("stale-only is a warning", warn[0].severity === "warning");

  const crit = evaluateAlertRules(outputs({ connectionHealth: connHealth({ HEALTHY: 1, ERROR: 1, STALE: 1 }) }), ALL_ON).filter((s) => s.kind === "provider-unhealthy");
  check("ERROR present ⇒ critical", crit[0].severity === "critical");
  check("summary counts the unhealthy (2 of 3)", crit[0].summary.includes("2 of 3"));
}

// ── Engine: resource-stale ───────────────────────────────────────────────────────

console.log("engine · resource-stale");
{
  const sigs = evaluateAlertRules(
    outputs({ resourceFreshness: freshness([resource("fx-rates", "stale"), resource("prices", "empty"), resource("snap", "fresh"), resource("idle-one", "idle")]) }),
    ALL_ON,
  ).filter((s) => s.kind === "resource-stale");
  check("fires on stale + empty only (not fresh/idle)", sigs.length === 2);
  check("stale is a warning", sigs.find((s) => s.dedupeKey.endsWith(":fx-rates"))!.severity === "warning");
  check("empty (cold archive) is critical", sigs.find((s) => s.dedupeKey.endsWith(":prices"))!.severity === "critical");

  // Blocked-pipeline honesty (S1 contract): an empty archive whose pipeline is
  // known-blocked is trust "unknown" — must NOT false-red the operator.
  const blocked = evaluateAlertRules(
    outputs({ resourceFreshness: freshness([resource("security-prices", "empty", "unknown"), resource("fx-rates", "empty", "low")]) }),
    ALL_ON,
  ).filter((s) => s.kind === "resource-stale");
  check("empty+blocked (trust unknown) does NOT fire (no false-red on a gated no-op)", !blocked.some((s) => s.dedupeKey.endsWith(":security-prices")));
  check("empty+genuine (trust low) still fires", blocked.some((s) => s.dedupeKey.endsWith(":fx-rates")));
}

// ── Engine: gating + null authorities + dormancy ─────────────────────────────────

console.log("engine · gating");
{
  const jh = jobHealth([job("x", "failing", 3)]);
  const off = evaluateAlertRules(outputs({ jobHealth: jh }), (id) => id !== "job-failing");
  check("disabled rule yields no signals", !off.some((s) => s.kind === "job-failing"));

  const nullAuth = evaluateAlertRules(outputs({}), ALL_ON);
  check("null authorities ⇒ no signals (no fabrication)", nullAuth.length === 0);

  // quota-low is dormant: even forcing enabled=true it cannot fire (no authority).
  const forced = evaluateAlertRules(outputs({ jobHealth: jh, connectionHealth: connHealth({ ERROR: 1 }), resourceFreshness: freshness([resource("r", "empty")]) }), ALL_ON);
  check("dormant quota-low never emits a signal", !forced.some((s) => s.kind === "quota-low"));
}

// ── resolveEnabled ────────────────────────────────────────────────────────────────

console.log("resolveEnabled");
{
  const live = ALERT_RULES.find((r) => r.id === "job-failing")!;
  const dormant = ALERT_RULES.find((r) => r.id === "quota-low")!;
  check("default enabled honored", resolveEnabled(live, new Map()) === true);
  check("PlatformSetting can disable", resolveEnabled(live, new Map([[alertEnabledKey("job-failing"), "false"]])) === false);
  check("PlatformSetting can enable", resolveEnabled(live, new Map([[alertEnabledKey("job-failing"), "true"]])) === true);
  check("dormant rule never enabled even if set true", resolveEnabled(dormant, new Map([[alertEnabledKey("quota-low"), "true"]])) === false);
}

// ── Suppression ────────────────────────────────────────────────────────────────────

console.log("suppression");
{
  const sig = { ruleId: "resource-stale", kind: "resource-stale" as const, severity: "warning" as const, dedupeKey: "resource-stale:fx-rates", summary: "x" };
  const fresh = decideDeliveries([sig], new Map(), NOW_MS);
  check("new breach is delivered", fresh.toSend.length === 1 && fresh.suppressed.length === 0);

  const recent = new Map([[sig.dedupeKey, NOW_MS - 2 * HOUR]]);
  check("within re-notify window ⇒ suppressed", decideDeliveries([sig], recent, NOW_MS).suppressed.length === 1);

  const old = new Map([[sig.dedupeKey, NOW_MS - (DEFAULT_RENOTIFY_HOURS + 1) * HOUR]]);
  check("beyond re-notify window ⇒ re-delivered", decideDeliveries([sig], old, NOW_MS).toSend.length === 1);
}

// ── Prior-fired extraction + history views ──────────────────────────────────────

console.log("history derivation");
{
  const s1: AlertRunSummary = summaryWith([{ ruleId: "job-failing", dedupeKey: "job-failing:a", at: "2026-07-14T07:30:00Z" }]);
  const s2: AlertRunSummary = summaryWith([{ ruleId: "job-failing", dedupeKey: "job-failing:a", at: "2026-07-15T07:30:00Z" }, { ruleId: "resource-stale", dedupeKey: "resource-stale:fx", at: "2026-07-15T07:30:00Z" }]);
  const prior = extractPriorFired([s2, s1]);
  check("prior-fired keeps the newest delivery per key", prior.get("job-failing:a") === Date.parse("2026-07-15T07:30:00Z"));

  const views = deriveAlertRuleViews(ALERT_RULES, ALL_ON, [s2, s1]);
  check("a view per rule", views.length === 5);
  check("last-triggered is the newest across runs", views.find((v) => v.id === "job-failing")!.lastTriggeredAtISO === "2026-07-15T07:30:00Z");
  check("never-fired rule has null last-triggered", views.find((v) => v.id === "scheduler-silent")!.lastTriggeredAtISO === null);
  check("dormant rule reported not-live", views.find((v) => v.id === "quota-low")!.live === false);

  const hist = collectAlertHistory([s2, s1]);
  check("history is newest-first", hist.length === 3 && Date.parse(hist[0].deliveredAtISO) >= Date.parse(hist[1].deliveredAtISO));
}

// ── Email payload ────────────────────────────────────────────────────────────────

console.log("email payload");
{
  const data = buildAlertEmailData(
    [
      { ruleId: "resource-stale", kind: "resource-stale", severity: "warning", dedupeKey: "resource-stale:fx", summary: "stale" },
      { ruleId: "job-failing", kind: "job-failing", severity: "critical", dedupeKey: "job-failing:a", summary: "failed" },
    ],
    NOW.toISOString(),
  );
  check("payload lists every alert", data.alerts.length === 2);
  check("critical is ordered first", data.alerts[0].severity === "critical");
}

// ── Orchestrator (fully injected) ────────────────────────────────────────────────

async function orchestratorTests() {
  console.log("orchestrator");
  const authorities = outputs({
    jobHealth: jobHealth([job("sync-banks", "failing", 3)]),
    connectionHealth: connHealth({ HEALTHY: 2 }),
    resourceFreshness: freshness([resource("fx-rates", "empty")]),
  });
  const sent: { to: string; count: number }[] = [];
  const baseDeps = {
    now: NOW,
    gatherAuthorities: async () => authorities,
    loadSettings: async () => new Map<string, string>(),
    loadRecentRuns: async () => [] as AlertRunSummary[],
    resolveDestination: () => "ops@fourthmeridian.com",
    sendAlertEmail: async (to: string, data: { alerts: unknown[] }) => { sent.push({ to, count: data.alerts.length }); return { status: "sent" }; },
  };

  const s1 = await evaluatePlatformAlerts(baseDeps);
  check("fires the two enabled breaches (job-failing + resource empty)", s1.counts.firing === 2);
  check("delivered both", s1.counts.delivered === 2 && s1.deliveryStatus === "sent");
  check("one email to the destination", sent.length === 1 && sent[0].to === "ops@fourthmeridian.com" && sent[0].count === 2);
  check("summary records fired for suppression/history", s1.fired.length === 2);
  check("per-rule outcomes list all five rules", s1.rules.length === 5);
  check("dormant rule not firing in outcomes", s1.rules.find((r) => r.id === "quota-low")!.firing === false);

  // Second cycle sees the first as recent history ⇒ suppresses (no second email).
  const s2 = await evaluatePlatformAlerts({ ...baseDeps, loadRecentRuns: async () => [s1] });
  check("ongoing breach suppressed next cycle", s2.counts.suppressed === 2 && s2.counts.delivered === 0);
  check("no second email while suppressed", sent.length === 1);

  // No destination configured ⇒ skipped, nothing recorded (retries next cycle).
  const s3 = await evaluatePlatformAlerts({ ...baseDeps, resolveDestination: () => null });
  check("no destination ⇒ deliveryStatus skipped", s3.deliveryStatus === "skipped" && s3.fired.length === 0);

  // Delivery failure ⇒ not recorded as fired (so it retries, not silently dropped).
  const s4 = await evaluatePlatformAlerts({ ...baseDeps, sendAlertEmail: async () => { throw new Error("smtp down"); } });
  check("send failure ⇒ error + nothing recorded fired", s4.deliveryStatus === "error" && s4.fired.length === 0);

  // A silent platform (nothing wrong) sends zero mail.
  const quiet = await evaluatePlatformAlerts({
    ...baseDeps,
    gatherAuthorities: async () => outputs({ jobHealth: jobHealth([job("a", "healthy")]), connectionHealth: connHealth({ HEALTHY: 3 }), resourceFreshness: freshness([resource("fx", "fresh")]) }),
  });
  check("a healthy platform sends zero mail", quiet.counts.firing === 0 && quiet.deliveryStatus === "none" && sent.length === 1);
}

// ── Doctrine source-scan: one canonical evaluation, no duplicated health compute ──

console.log("doctrine");
{
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  const evaluateSrc = read("lib/alerts/evaluate.ts");
  const rulesSrc = read("lib/alerts/rules.ts");
  const runSrc = read("lib/alerts/run.ts");

  check("pure engine never imports the db client", !/from ["']@\/lib\/db["']/.test(evaluateSrc) && !/from ["']@\/lib\/db["']/.test(rulesSrc));
  check("pure engine queries no product table (no db.* health re-derivation)", !/\bdb\.(plaidItem|connection|jobRun|fxRate|priceObservation)\b/.test(evaluateSrc));
  check("orchestrator consumes the OPS-4 job-health authority", /checkScheduledJobHealth/.test(runSrc));
  check("orchestrator consumes the connection-health authority", /getConnectionHealth/.test(runSrc));
  check("orchestrator consumes the OPS-5 resource-freshness authority", /checkResourceFreshness/.test(runSrc));
  check("destination is the OPS-1 email seam", /@\/lib\/email\/send/.test(runSrc));
}

// ── Helper ────────────────────────────────────────────────────────────────────────

function summaryWith(fired: { ruleId: string; dedupeKey: string; at: string }[]): AlertRunSummary {
  return {
    evaluatedAtISO: fired[fired.length - 1]?.at ?? NOW.toISOString(),
    destination: "ops@fourthmeridian.com",
    deliveryStatus: fired.length ? "sent" : "none",
    counts: { evaluated: 5, live: 4, enabled: 4, firing: fired.length, delivered: fired.length, suppressed: 0 },
    rules: [],
    fired: fired.map((f) => ({ ruleId: f.ruleId, kind: "job-failing", dedupeKey: f.dedupeKey, severity: "critical", summary: "x", deliveredAtISO: f.at })),
  };
}

async function main() {
  await orchestratorTests();
  if (failures > 0) {
    console.error(`\nalerts.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nalerts.test: all passed.");
}

void main();
