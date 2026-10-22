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
import type { ConnectionHealthResult, ConnectionHealthRow, HealthState } from "@/lib/connections/health";
import type { AlertSyncIncident, SyncIncidentHealth } from "@/lib/alerts/authorities";
import { foldSyncIncidents } from "@/lib/alerts/sync-incidents";
import type { ResourceFreshnessResult, ResourceFreshnessReport, FreshnessHealthState } from "@/lib/platform/resource-freshness";
import type { AiFailureHealth } from "@/lib/platform/ai/failures";
import type { AiSpendHealth } from "@/lib/platform/ai/spend-health";

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
  return { total, counts: full, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 }, checkedAt: NOW.toISOString(), cap: 20, listedScope: "unhealthy" };
}
function aiHealth(o: Partial<AiFailureHealth>): AiFailureHealth {
  return { windowHours: 24, returned: 0, failed: 0, timeouts: 0, rateLimited: 0, quota: 0, lastFailureAt: null, lastQuotaAt: null, checkedAt: NOW.toISOString(), ...o };
}
function aiSpend(o: Partial<AiSpendHealth>): AiSpendHealth {
  return { windowHours: 24, fleetUsd: null, maxUserUsd: null, maxUserRef: null, customers: 0, customersAtOrOverThreshold: 0, customerInvocations: 0, unpricedInvocations: 0, unpricedModels: [], thresholds: { fleetUsd: 10, userUsd: 3 }, checkedAt: NOW.toISOString(), ...o };
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
  return { jobHealth: null, connectionHealth: null, resourceFreshness: null, aiFailures: null, aiSpend: null, syncIncidents: null, ...o };
}
const ALL_ON = () => true;

// ── Registry shape ───────────────────────────────────────────────────────────────

console.log("registry");
check("nine rules (five initial + ai-provider-failing + the two ai-spend rules + sync-incident-critical from OBS-004)", ALERT_RULES.length === 9);
check("eight live rules", ALERT_RULES.filter((r) => r.live).length === 8);
check("quota-low is the sole dormant rule", ALERT_RULES.filter((r) => !r.live).map((r) => r.id).join() === "quota-low");
check("every rule id unique", new Set(ALERT_RULES.map((r) => r.id)).size === 9);
check("sync-incident-critical reads the sync-incidents authority, live, on by default", ALERT_RULES.find((r) => r.id === "sync-incident-critical")?.authority === "sync-incidents" && ALERT_RULES.find((r) => r.id === "sync-incident-critical")!.live && ALERT_RULES.find((r) => r.id === "sync-incident-critical")!.defaultEnabled);
check("ai-provider-failing reads the ai-failures authority", ALERT_RULES.find((r) => r.id === "ai-provider-failing")?.authority === "ai-failures");
check("ai-spend-fleet-high reads the ai-spend authority and says critical = twice the threshold", ALERT_RULES.find((r) => r.id === "ai-spend-fleet-high")?.authority === "ai-spend" && /critical at or above twice/.test(ALERT_RULES.find((r) => r.id === "ai-spend-fleet-high")!.description));
check("ai-spend-user-high reads the same authority, is live and on by default", ALERT_RULES.find((r) => r.id === "ai-spend-user-high")?.authority === "ai-spend" && ALERT_RULES.find((r) => r.id === "ai-spend-user-high")!.live && ALERT_RULES.find((r) => r.id === "ai-spend-user-high")!.defaultEnabled);
check("the old ai-spend-high id is gone (one rule, one enabled key, one dedupe family each)", ALERT_RULES.every((r) => r.id !== "ai-spend-high"));

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
  check("fires on overdue", sigs.length === 1 && sigs[0].dedupeKey === "scheduler-silent:a" && sigs[0].severity === "critical");
  check("never-ran does NOT trip scheduler-silent (operator-decides state)", !sigs.some((s) => s.dedupeKey.includes(":b")));
  check("failing / healthy do not trip scheduler-silent", !sigs.some((s) => s.dedupeKey.includes(":c") || s.dedupeKey.includes(":d")));

  // OBS-002 — the runtime fixture (runtime/07-OBSERVABILITY.md §7.1): the SAME job
  // read `dead` at 60 days of silence and `overdue` at 10 h. Before the fix the
  // overdue read fired and the dead read went quiet — the inversion.
  const sixtyDaysSilent = jobHealth([{ job: "sync-crypto-continuation", status: "dead", expectedEveryHours: 6, consecutiveFailures: 0 }]);
  const dead = evaluateAlertRules(outputs({ jobHealth: sixtyDaysSilent }), ALL_ON).filter((s) => s.kind === "scheduler-silent");
  check("OBS-002: a DEAD job fires scheduler-silent", dead.length === 1 && dead[0].dedupeKey === "scheduler-silent:sync-crypto-continuation");
  check("OBS-002: dead is critical", dead[0]?.severity === "critical");
  check("OBS-002: the summary says DEAD and names the cadence, no user content", /DEAD/.test(dead[0]?.summary ?? "") && /every 6h/.test(dead[0]?.summary ?? ""));
  const tenHoursSilent = jobHealth([{ job: "sync-crypto-continuation", status: "overdue", expectedEveryHours: 6, consecutiveFailures: 0 }]);
  const overdue = evaluateAlertRules(outputs({ jobHealth: tenHoursSilent }), ALL_ON).filter((s) => s.kind === "scheduler-silent");
  check("OBS-002: the overdue read still fires (unchanged)", overdue.length === 1 && overdue[0].severity === "critical" && /overdue/.test(overdue[0].summary));
  check("OBS-002: overdue → dead is ONE breach (same dedupe key), so the ageing does not re-page inside the re-notify window",
    overdue[0].dedupeKey === dead[0].dedupeKey && decideDeliveries(dead, new Map([[overdue[0].dedupeKey, NOW_MS - 2 * HOUR]]), NOW_MS).suppressed.length === 1);
  const neverRanStill = evaluateAlertRules(outputs({ jobHealth: jobHealth([{ job: "sync-crypto-continuation", status: "never-ran", expectedEveryHours: 6, consecutiveFailures: 0 }]) }), ALL_ON).filter((s) => s.kind === "scheduler-silent");
  check("OBS-002: never-ran is unchanged (no signal)", neverRanStill.length === 0);
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

  // OPERATIONALIZATION P0 — a revoked connection is a FORMER connection. The
  // authority retires it out of the population; if one ever reaches the engine
  // it is degraded at most, never a permanent critical.
  const retiredOnly = evaluateAlertRules(
    outputs({ connectionHealth: { ...connHealth({ HEALTHY: 2 }), retired: { revoked: 3, ownerInactive: 1 } } }), ALL_ON,
  ).filter((s) => s.kind === "provider-unhealthy");
  check("retired (revoked / owner-inactive) connections produce no signal", retiredOnly.length === 0);
  const revokedLeak = evaluateAlertRules(outputs({ connectionHealth: connHealth({ HEALTHY: 2, REVOKED: 1 }) }), ALL_ON).filter((s) => s.kind === "provider-unhealthy");
  check("a REVOKED row that reaches the engine is NOT acute (warning, not critical)", revokedLeak.length === 1 && revokedLeak[0].severity === "warning");

  // OBS-004 — ONE BREACH PER CONNECTION. Before: one aggregate keyed on the
  // rule id, so a second failing connection inside the 20 h window was silent.
  console.log("engine · provider-unhealthy · per connection (OBS-004)");
  const row = (id: string, healthState: HealthState, over: Partial<ConnectionHealthRow> = {}): ConnectionHealthRow => ({
    source: "PLAID", id, label: "Chase Bank", status: "ERROR", errorCode: healthState === "ERROR" ? "ITEM_LOGIN_REQUIRED" : null, healthState,
    lastSyncedAt: null, since: "2026-07-15T08:00:00.000Z", kind: "BANK", institution: "Chase", network: null, overdueAfterHours: 30, neverSynced: false, availableActions: [], ...over,
  });
  const withRows = (counts: Partial<Record<HealthState, number>>, rows: ConnectionHealthRow[], cap = 20): ConnectionHealthResult => ({ ...connHealth(counts), unhealthy: rows, cap });
  const two = evaluateAlertRules(outputs({ connectionHealth: withRows({ HEALTHY: 3, ERROR: 1, STALE: 1 }, [row("item_aaaaaa111111", "ERROR"), row("wallet_bbbbbb222222", "STALE", { source: "WALLET", kind: "WALLET" })]) }), ALL_ON).filter((s) => s.kind === "provider-unhealthy");
  check("two unhealthy connections ⇒ two signals", two.length === 2);
  check("each keyed on its own connection id", two.map((s) => s.dedupeKey).sort().join(",") === "provider-unhealthy:item_aaaaaa111111,provider-unhealthy:wallet_bbbbbb222222");
  check("ERROR row critical, STALE row warning", two.find((s) => s.dedupeKey.endsWith("aaaaaa111111"))!.severity === "critical" && two.find((s) => s.dedupeKey.endsWith("bbbbbb222222"))!.severity === "warning");
  check("summary names source/kind/state/code and an OPAQUE ref — never the institution", two.every((s) => !/Chase/.test(s.summary)) && /…111111 \(PLAID, BANK\) is ERROR \(ITEM_LOGIN_REQUIRED\)/.test(two[0].summary));
  const firstDelivered = new Map([["provider-unhealthy:item_aaaaaa111111", NOW_MS - 2 * HOUR]]);
  const second = decideDeliveries(two, firstDelivered, NOW_MS);
  check("a SECOND connection failing inside the first's 20 h window is delivered on its own clock", second.toSend.length === 1 && second.toSend[0].dedupeKey.endsWith("bbbbbb222222") && second.suppressed.length === 1);
  const floor = evaluateAlertRules(outputs({ connectionHealth: withRows({ HEALTHY: 1, ERROR: 3 }, [row("item_aaaaaa111111", "ERROR")], 1) }), ALL_ON).filter((s) => s.kind === "provider-unhealthy");
  check("a capped list adds ONE aggregate remainder breach (:unlisted) so the fleet is never understated", floor.length === 2 && floor.some((s) => s.dedupeKey === "provider-unhealthy:unlisted" && /2 further/.test(s.summary)));
  check("counts without rows (legacy / pure callers) keep the aggregate signal on the rule id", warn[0].dedupeKey === "provider-unhealthy");
}

// ── Engine: sync-incident-critical (OBS-004) ────────────────────────────────────

console.log("engine · sync-incident-critical (OBS-004)");
{
  const inc = (id: string, over: Partial<AlertSyncIncident> = {}): AlertSyncIncident => ({
    id, plaidItemId: "item_zzzzzz999999", kind: "TRANSACTION_PERSISTENCE_FAILED", domain: "transactions", severity: "critical",
    lastOccurredAt: "2026-07-16T07:00:00.000Z", occurrenceCount: 2, ...over,
  });
  const health = (active: AlertSyncIncident[], scanTruncated = false): SyncIncidentHealth => ({ checkedAt: NOW.toISOString(), active, scanTruncated });
  const sig = (h: SyncIncidentHealth) => evaluateAlertRules(outputs({ syncIncidents: h }), ALL_ON).filter((s) => s.kind === "sync-incident");

  check("no active incidents ⇒ no signal", sig(health([])).length === 0);
  check("active non-critical (error / warning / info) ⇒ no signal", sig(health([inc("a", { severity: "error", kind: "WALLET_SYNC_FAILED", domain: "wallet" }), inc("b", { severity: "warning" })])).length === 0);
  const one = sig(health([inc("a")]));
  check("one active critical ⇒ one critical signal keyed on the ITEM", one.length === 1 && one[0].severity === "critical" && one[0].dedupeKey === "sync-incident-critical:item:item_zzzzzz999999");
  check("summary: the operator label, opaque Item ref, episode + occurrence counts; no customer, no detail", /Transaction persistence failed/.test(one[0].summary) && /…999999/.test(one[0].summary) && /1 active episode/.test(one[0].summary) && /2 occurrence/.test(one[0].summary) && !/item_zzzzzz999999/.test(one[0].summary));
  const sameItem = sig(health([inc("a"), inc("b", { occurrenceCount: 5, lastOccurredAt: "2026-07-16T07:30:00.000Z" })]));
  check("two critical episodes on ONE Item ⇒ one breach (2 episodes, 7 occurrences, newest time)", sameItem.length === 1 && /2 active episode/.test(sameItem[0].summary) && /7 occurrence/.test(sameItem[0].summary) && /07:30/.test(sameItem[0].summary));
  const twoItems = sig(health([inc("a"), inc("c", { plaidItemId: "item_yyyyyy888888" })]));
  check("two Items ⇒ two breaches with distinct keys", twoItems.length === 2 && new Set(twoItems.map((s) => s.dedupeKey)).size === 2);
  check("a second Item's incident inside the first's re-notify window is delivered (dedupe per Item)",
    decideDeliveries(twoItems, new Map([["sync-incident-critical:item:item_zzzzzz999999", NOW_MS - HOUR]]), NOW_MS).toSend.length === 1);
  const noItem = sig(health([inc("d", { plaidItemId: null, kind: "REPLAY_FAILED" })]));
  check("an episode naming no Item is keyed on the episode", noItem.length === 1 && noItem[0].dedupeKey === "sync-incident-critical:episode:d");
  check("a truncated scan is said in the summary", /may be a floor/.test(sig(health([inc("a")], true))[0].summary));
  check("legacy UPSERT_ERROR on the transactions domain reads by the same operator label", /Transaction persistence failed/.test(sig(health([inc("e", { kind: "UPSERT_ERROR" })]))[0].summary));

  // The fold from the projection: state-filtered, opaque, nothing from detail.
  const folded = foldSyncIncidents([
    { id: "x1", kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: "item_1", state: "active", classification: { domain: "transactions", severity: "critical", nature: "condition", customerActionable: true, cursorBlocking: true }, lastOccurredAt: "2026-07-16T07:00:00.000Z", occurrenceCount: 1 },
    { id: "x2", kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: "item_1", state: "recovered", classification: { domain: "transactions", severity: "critical", nature: "condition", customerActionable: true, cursorBlocking: true }, lastOccurredAt: null, occurrenceCount: 1 },
    { id: "x3", kind: "BALANCE_TX_MISMATCH", plaidItemId: null, state: "evidence", classification: { domain: "reconciliation", severity: "warning", nature: "event", customerActionable: false, cursorBlocking: false }, lastOccurredAt: null, occurrenceCount: 0 },
  ], true, NOW);
  check("fold keeps ACTIVE only, carries scanTruncated", folded.active.length === 1 && folded.active[0].id === "x1" && folded.scanTruncated);
  check("fold carries no classification object, no detail, no label", !("classification" in folded.active[0]) && !("detail" in folded.active[0]) && !("label" in folded.active[0]));
}

// ── Engine: ai-failing ───────────────────────────────────────────────────────────

console.log("engine · ai-failing");
{
  const sig = (o: Partial<AiFailureHealth>) =>
    evaluateAlertRules(outputs({ aiFailures: aiHealth(o) }), ALL_ON).filter((s) => s.kind === "ai-failing");
  check("quiet provider ⇒ no signal", sig({ returned: 40 }).length === 0);
  const quota = sig({ returned: 5, quota: 1, lastQuotaAt: NOW.toISOString() });
  check("ANY insufficient_quota ⇒ critical on its own key", quota.length === 1 && quota[0].severity === "critical" && quota[0].dedupeKey === "ai-provider-failing:quota");
  check("quota summary names the cause, counts only", /insufficient quota/.test(quota[0].summary) && !/\$/.test(quota[0].summary));
  const dark = sig({ returned: 0, failed: 2 });
  check("every call failed (0 returned) ⇒ critical :errors", dark.length === 1 && dark[0].severity === "critical" && dark[0].dedupeKey === "ai-provider-failing:errors");
  check("a few errors beside returned calls ⇒ warning", sig({ returned: 20, failed: 2, timeouts: 1 })[0]?.severity === "warning");
  check("fewer than the warning count ⇒ no signal", sig({ returned: 20, failed: 2 }).length === 0);
  check("rate limits alone never fire (retried by design)", sig({ returned: 3, rateLimited: 9 }).length === 0);
  const both = sig({ returned: 0, failed: 1, quota: 2 });
  check("quota + total failure ⇒ two independent breaches", both.length === 2 && new Set(both.map((s) => s.dedupeKey)).size === 2);
}

// ── Engine: ai-spend (BETA C7) ───────────────────────────────────────────────────

console.log("engine · ai-spend");
{
  const sig = (o: Partial<AiSpendHealth>) =>
    evaluateAlertRules(outputs({ aiSpend: aiSpend(o) }), ALL_ON).filter((s) => s.kind === "ai-spend-fleet" || s.kind === "ai-spend-user");
  check("quiet fleet, every invocation priced ⇒ no signal", sig({ fleetUsd: 2.5, maxUserUsd: 1.2, maxUserRef: "user …abc123", customers: 3, customerInvocations: 40 }).length === 0);
  check("nothing priced and nothing unpriced (empty window) ⇒ no signal", sig({}).length === 0);

  const fleet = sig({ fleetUsd: 10, maxUserUsd: 2, maxUserRef: "user …abc123", customers: 5, customerInvocations: 120 });
  check("fleet at the threshold ⇒ ONE warning on the per-day fleet key", fleet.length === 1 && fleet[0].severity === "warning" && fleet[0].dedupeKey === "ai-spend-fleet-high:fleet:2026-07-16");
  check("fleet summary names the estimated USD and the threshold", /\$10\.00/.test(fleet[0].summary) && /threshold of \$10/.test(fleet[0].summary) && /estimate, not a bill/.test(fleet[0].summary));
  check("fleet summary carries no unpriced line when everything was priced", !/unpriced/.test(fleet[0].summary));
  check("fleet at twice the threshold ⇒ critical", sig({ fleetUsd: 20 })[0]?.severity === "critical");
  check("fleet just under twice ⇒ still a warning", sig({ fleetUsd: 19.99 })[0]?.severity === "warning");
  check("fleet just under the threshold ⇒ no signal", sig({ fleetUsd: 9.99 }).length === 0);

  const user = sig({ fleetUsd: 4, maxUserUsd: 3, maxUserRef: "user …abc123", customers: 2, customerInvocations: 30 });
  check("one customer at the per-user threshold ⇒ warning on a per-day, per-opaque-ref key", user.length === 1 && user[0].severity === "warning" && user[0].dedupeKey === "ai-spend-user-high:user:2026-07-16:abc123");
  check("user summary names the opaque ref, the USD and the threshold — no email, no full id", /user …abc123/.test(user[0].summary) && /\$3\.00/.test(user[0].summary) && /threshold of \$3/.test(user[0].summary) && !/@/.test(user[0].summary));
  check("one customer at twice the per-user threshold ⇒ critical", sig({ maxUserUsd: 6, maxUserRef: "user …abc123" })[0]?.severity === "critical");
  check("a lone breacher's summary does not claim company", !/customers are at or above/.test(user[0].summary));
  const crowd = sig({ fleetUsd: 4, maxUserUsd: 3.5, maxUserRef: "user …abc123", customers: 4, customersAtOrOverThreshold: 3, customerInvocations: 30 });
  check("several customers at or over the per-user threshold ⇒ ONE signal that names the largest and says how many are over",
    crowd.length === 1 && /user …abc123/.test(crowd[0].summary) && /3 customers are at or above it/.test(crowd[0].summary));
  check("per-user just under the threshold ⇒ no signal", sig({ maxUserUsd: 2.99, maxUserRef: "user …abc123" }).length === 0);

  // ⚠️ FAIL CLOSED. An unpriced invocation fires on its own, whatever the dollars say.
  const unpriced = sig({ fleetUsd: 0.4, maxUserUsd: 0.2, maxUserRef: "user …abc123", unpricedInvocations: 3, unpricedModels: ["OPENAI:gpt-7-preview"] });
  check("any unpriced invocation ⇒ a warning even when spend is far under both thresholds", unpriced.length === 1 && unpriced[0].severity === "warning" && unpriced[0].dedupeKey === "ai-spend-fleet-high:unpriced:2026-07-16");
  check("the unpriced summary counts them, names the model and says not counted / see rate card", /3 invocation\(s\) on unpriced models \(OPENAI:gpt-7-preview\)/.test(unpriced[0].summary) && /not counted; see rate card/.test(unpriced[0].summary));
  const both = sig({ fleetUsd: 12, maxUserUsd: 1, maxUserRef: "user …abc123", unpricedInvocations: 1, unpricedModels: ["OPENAI:x"] });
  check("fleet breach + unpriced ⇒ two independent breaches, and the fleet summary carries the unpriced line", both.length === 2 && new Set(both.map((s) => s.dedupeKey)).size === 2 && /not counted; see rate card/.test(both.find((s) => s.dedupeKey.includes(":fleet:"))!.summary));
  check("no dollar value in any dedupe key", [...fleet, ...user, ...unpriced, ...both].every((s) => !/\$|\d+\.\d{2}/.test(s.dedupeKey)));

  // Dedupe across cycles: the same day's breach is suppressed within the window; a new UTC day is a new key.
  const first = decideDeliveries(fleet, new Map(), NOW_MS);
  check("first cycle delivers the fleet breach", first.toSend.length === 1);
  const again = decideDeliveries(fleet, new Map([[fleet[0].dedupeKey, NOW_MS - 2 * HOUR]]), NOW_MS + 4 * HOUR);
  check("same UTC day, within the re-notify window ⇒ suppressed", again.suppressed.length === 1 && again.toSend.length === 0);
  const nextDay = sig({ fleetUsd: 10, checkedAt: "2026-07-17T08:00:00Z" });
  check("the next UTC day is a new breach key", nextDay[0].dedupeKey === "ai-spend-fleet-high:fleet:2026-07-17" && decideDeliveries(nextDay, new Map([[fleet[0].dedupeKey, NOW_MS]]), NOW_MS + 24 * HOUR).toSend.length === 1);

  // AI COST CONTROLS — each rule is independently enable-able through the engine's existing key; disabling one changes evaluation only.
  const bothBreach = { fleetUsd: 12, maxUserUsd: 4, maxUserRef: "user …abc123", unpricedInvocations: 1, unpricedModels: ["OPENAI:x"] };
  const onlyUser = (id: string) => id === "ai-spend-user-high";
  const onlyFleet = (id: string) => id === "ai-spend-fleet-high";
  const userOnly = evaluateAlertRules(outputs({ aiSpend: aiSpend(bothBreach) }), onlyUser);
  check("fleet rule disabled ⇒ no fleet and no unpriced signal; the user signal still fires", userOnly.length === 1 && userOnly[0].ruleId === "ai-spend-user-high");
  const fleetOnly = evaluateAlertRules(outputs({ aiSpend: aiSpend(bothBreach) }), onlyFleet);
  check("user rule disabled ⇒ fleet + unpriced signals only", fleetOnly.length === 2 && fleetOnly.every((s) => s.ruleId === "ai-spend-fleet-high"));
  const settingsOff = new Map([["alert_rule_enabled:ai-spend-user-high", "false"]]);
  check("the user rule resolves disabled from its own alert_rule_enabled key, the fleet rule stays on",
    resolveEnabled(ALERT_RULES.find((r) => r.id === "ai-spend-user-high")!, settingsOff) === false && resolveEnabled(ALERT_RULES.find((r) => r.id === "ai-spend-fleet-high")!, settingsOff) === true);
  // Idempotency: the same breach within the 20 h window is suppressed on BOTH families; the fold is untouched by the rule state.
  const all = evaluateAlertRules(outputs({ aiSpend: aiSpend(bothBreach) }), ALL_ON);
  const prior = new Map(all.map((s) => [s.dedupeKey, NOW_MS - 2 * HOUR]));
  check("the same day's breaches are suppressed within 20 h on every family (idempotent)", decideDeliveries(all, prior, NOW_MS + 10 * HOUR).toSend.length === 0 && decideDeliveries(all, prior, NOW_MS + 17 * HOUR).suppressed.length === 3 && decideDeliveries(all, prior, NOW_MS + 19 * HOUR).toSend.length === 3);
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
  check("a view per rule", views.length === 9);
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
  check("per-rule outcomes list all nine rules", s1.rules.length === 9);
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
  check("nothing lost ⇒ undelivered is null", quiet.undelivered === null && s1.undelivered === null);

  // ── OBS-003 — the runtime fixture (runtime/07-OBSERVABILITY.md §7.2): no
  // RESEND_API_KEY ⇒ the chokepoint returns `captured`. Before the fix that was
  // "delivered" (counts.delivered 1, breach in fired[]) and the breach was
  // suppressed for 20 h while nobody was told.
  console.log("orchestrator · OBS-003 captured outside development");
  const silence = (e: unknown) => e;
  const captureDeps = { ...baseDeps, sendAlertEmail: async () => ({ status: "captured", provider: "capture" }) };
  const realConsoleError = console.error;
  console.error = silence as typeof console.error;
  let prod: AlertRunSummary, preview: AlertRunSummary, unset: AlertRunSummary;
  try {
    prod = await evaluatePlatformAlerts({ ...captureDeps, environment: "production" });
    preview = await evaluatePlatformAlerts({ ...captureDeps, environment: "preview" });
    unset = await evaluatePlatformAlerts({ ...captureDeps, environment: undefined });
  } finally {
    console.error = realConsoleError;
  }
  check("production + captured ⇒ deliveryStatus skipped (NOT delivered)", prod.deliveryStatus === "skipped");
  check("production + captured ⇒ nothing recorded as fired (no 20 h suppression)", prod.fired.length === 0 && prod.counts.delivered === 0);
  check("production + captured ⇒ a loud summary field names the cause and the count", prod.undelivered?.reason === "NO_EMAIL_TRANSPORT" && prod.undelivered.breaches === 2);
  check("the next cycle does NOT suppress the breach (it retries)",
    (await evaluatePlatformAlerts({ ...baseDeps, loadRecentRuns: async () => [prod] })).counts.suppressed === 0);
  check("any non-development NODE_ENV (preview / unset) is treated the same way", preview.deliveryStatus === "skipped" && preview.undelivered?.reason === "NO_EMAIL_TRANSPORT" && unset.deliveryStatus === "skipped");
  const dev = await evaluatePlatformAlerts({ ...captureDeps, environment: "development" });
  check("development + captured ⇒ captured counts as delivered (the local transport)", dev.deliveryStatus === "captured" && dev.fired.length === 2 && dev.undelivered === null);
  const test = await evaluatePlatformAlerts({ ...captureDeps, environment: "test" });
  check("test + captured ⇒ likewise", test.deliveryStatus === "captured" && test.fired.length === 2);
  check("no destination ⇒ undelivered NO_DESTINATION", s3.undelivered?.reason === "NO_DESTINATION" && s3.undelivered.breaches === 2);
  check("send threw ⇒ undelivered SEND_ERROR", s4.undelivered?.reason === "SEND_ERROR");
  const providerError = await evaluatePlatformAlerts({ ...baseDeps, sendAlertEmail: async () => ({ status: "error", provider: "resend" }) });
  check("provider returned error ⇒ error + SEND_ERROR + nothing fired", providerError.deliveryStatus === "error" && providerError.undelivered?.reason === "SEND_ERROR" && providerError.fired.length === 0);
  const sentOk = await evaluatePlatformAlerts({ ...baseDeps, environment: "production", sendAlertEmail: async () => ({ status: "sent", provider: "resend" }) });
  check("production + sent (provider accepted) ⇒ delivered and recorded", sentOk.deliveryStatus === "sent" && sentOk.fired.length === 2 && sentOk.undelivered === null);

  // ── OBS-011 — the destination ADDRESS never enters the ledger.
  console.log("orchestrator · OBS-011 no address in the summary");
  check("summary carries destinationConfigured, not the address", s1.destinationConfigured === true && !("destination" in s1) && !JSON.stringify(s1).includes("ops@fourthmeridian.com"));
  check("no destination ⇒ destinationConfigured false", s3.destinationConfigured === false);

  // ── OBS-015 — circuit breaker when this run's start row failed to write.
  console.log("orchestrator · OBS-015 ledger start-write circuit breaker");
  const before = sent.length;
  console.error = silence as typeof console.error;
  let broken: AlertRunSummary;
  try {
    broken = await evaluatePlatformAlerts({ ...baseDeps, ledgerStartWriteFailed: () => true });
  } finally {
    console.error = realConsoleError;
  }
  check("start-write failed ⇒ no email sent", sent.length === before);
  check("start-write failed ⇒ skipped + LEDGER_WRITE_FAILED with the breach count", broken.deliveryStatus === "skipped" && broken.undelivered?.reason === "LEDGER_WRITE_FAILED" && broken.undelivered.breaches === 2);
  check("start-write failed ⇒ evaluation still recorded every rule outcome (the breaker is on delivery only)", broken.counts.firing === 2 && broken.rules.length === 9);
  const healthyLedger = await evaluatePlatformAlerts({ ...baseDeps, ledgerStartWriteFailed: () => false });
  check("start-write ok ⇒ delivery proceeds", healthyLedger.deliveryStatus === "sent" && sent.length === before + 1);
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
  check("orchestrator consumes the AI failure authority (OPERATIONALIZATION P0)", /getAiFailureHealth\(/.test(runSrc));
  check("orchestrator consumes the AI spend authority (BETA C7)", /getAiSpendHealth\(24\)/.test(runSrc));
  check("orchestrator consumes the incident projection (OBS-004) — never a SyncIssue row", /getActiveIncidentPage\(/.test(runSrc) && !/db\.syncIssue/.test(runSrc) && !/syncIssue/.test(evaluateSrc));
  check("the engine judges against the thresholds the authority carried, never a literal of its own",
    /spend\.thresholds\.fleetUsd/.test(evaluateSrc) && /spend\.thresholds\.userUsd/.test(evaluateSrc) && !/ai_spend_alert/.test(evaluateSrc));
  check("the thresholds are resolved through the platform-settings descriptors (validated, default on missing or invalid)",
    /validateSetting\(/.test(read("lib/platform/ai/spend-thresholds.ts")) && /getSettingDescriptor\(/.test(read("lib/platform/ai/spend-thresholds.ts")) && /INVALID_SETTING/.test(read("lib/platform/ai/spend-thresholds.ts")));
  check("REVOKED is no longer an acute connection state (revoked connections are retired, not unhealthy)",
    !/CRITICAL_CONNECTION_STATES[\s\S]*?"REVOKED"[\s\S]*?\]\)/.test(evaluateSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")));
  check("destination is the OPS-1 email seam", /@\/lib\/email\/send/.test(runSrc));
  // OBS-003 — the only place `captured` may count as delivered is behind the environment gate.
  check("captured is gated on development/test (CAPTURE_IS_EXPECTED), never unconditionally delivered",
    /captureIsExpected\(environment\)/.test(runSrc) && !/deliveryStatus === "sent" \|\| deliveryStatus === "captured"/.test(runSrc));
  // OBS-008 — both delivery-failure paths reach the error monitor.
  check("both delivery-failure paths capture to Sentry through the seam", (runSrc.match(/captureAlertDeliveryFailure\(/g) ?? []).length >= 2 && /@\/lib\/alerts\/delivery-capture/.test(runSrc));
  // OBS-011 — the address is never written.
  check("the summary writer never stores the destination address", !/^\s*destination,\s*$/m.test(runSrc) && /destinationConfigured: Boolean\(destination\)/.test(runSrc));
  // OBS-015 — the breaker reads the ambient runJob context.
  check("the circuit breaker reads currentJobRun().id === null", /currentJobRun\(\)/.test(runSrc) && /run\.id === null/.test(runSrc));
}

// ── Helper ────────────────────────────────────────────────────────────────────────

function summaryWith(fired: { ruleId: string; dedupeKey: string; at: string }[]): AlertRunSummary {
  return {
    evaluatedAtISO: fired[fired.length - 1]?.at ?? NOW.toISOString(),
    destination: "ops@fourthmeridian.com",
    deliveryStatus: fired.length ? "sent" : "none",
    counts: { evaluated: 8, live: 7, enabled: 7, firing: fired.length, delivered: fired.length, suppressed: 0 },
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
