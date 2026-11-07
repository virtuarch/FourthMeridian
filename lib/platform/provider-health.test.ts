/**
 * lib/platform/provider-health.test.ts  (OPS-5 S3)
 *
 * Pure guards for the Provider Health synthesis. Standalone tsx script (house
 * pattern): npx tsx lib/platform/provider-health.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: summarizeJobRuns / deriveProviderTrust / buildProviderHealth
 * are pure; getProviderHealth runs against injected loaders + a fake read-client.
 * Covers: run-window summary (availability · error rate · latency · streak ·
 * stale-running crash · in-flight break) · trust precedence (FAILING > STALE >
 * DEGRADED > OPERATIONAL, UNKNOWN, false-green catch, connection hard fault) ·
 * freshness CONSUMPTION from the S1 authority and from connection health ·
 * OXR + Plaid assembly · the driver over injected authorities · source-scan
 * fences (read-only · consumes freshness, never recomputes it · no live calls).
 */

import { readFileSync } from "node:fs";
import {
  PROVIDER_SPECS,
  PROVIDER_FAILING_STREAK,
  summarizeJobRuns,
  deriveProviderTrust,
  executionAssessment,
  freshnessFromResourceReport,
  freshnessFromConnections,
  buildProviderHealth,
  getProviderHealth,
  connectionAssessmentFor,
  type ProviderJobRun,
  type TrustSignals,
  type ProviderHealthReadClient,
} from "@/lib/platform/provider-health";
import type { ResourceFreshnessReport, ResourceFreshnessResult } from "@/lib/platform/resource-freshness";
import { tallyBySource, type ConnectionHealthResult, type ConnectionHealthRow } from "@/lib/connections/health";
import { PROVIDER_OUTCOME_DEFINITION, PROVIDER_OUTCOME_DEFINITION_ID, PROVIDER_FAILING_SHARE, assessOutcomes } from "@/lib/platform/verdicts/provider-outcome";
import {
  CUSTOMER_REAUTH_CODES, PROVIDER_CONNECTION_DEFINITION, PROVIDER_CONNECTION_DEFINITION_ID, PROVIDER_SIDE_ERROR_CODES,
  NOT_A_CODE, assessConnections, codeWord, connectionTrustState, tallyConnections,
} from "@/lib/platform/verdicts/provider-connection";
import { WEBHOOK_REAUTH_ERROR_CODES } from "@/lib/plaid/webhook-receiver";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const NOW = new Date("2026-07-16T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);
const run = (h: number, status: string, durationMs: number | null = 1200): ProviderJobRun => ({
  status, startedAt: hoursAgo(h), completedAt: status === "running" ? null : hoursAgo(h), durationMs,
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function freshReport(over: Partial<ResourceFreshnessReport> = {}): ResourceFreshnessReport {
  return {
    resource: "fx-rates",
    label: "FX Rates",
    newestObservedDate: "2026-07-15",
    ageHours: 20,
    ageDays: 0,
    expectedCadenceHours: 24,
    cadenceLabel: "Daily",
    staleAfterHours: 48,
    healthState: "fresh",
    completeness: { expected: 10, observed: 10, ratio: 1 },
    lastSuccessfulRefresh: "2026-07-16T06:31:00Z",
    lastAttemptedRefresh: "2026-07-16T06:31:00Z",
    lastAttemptStatus: "succeeded",
    trust: { level: "high", caveats: [] },
    ...over,
  };
}

const connRow = (over: Partial<ConnectionHealthRow>): ConnectionHealthRow => ({
  source: "PLAID", id: "i1", label: "Example Bank", status: "ACTIVE", errorCode: null,
  healthState: "HEALTHY", lastSyncedAt: "2026-07-16T06:00:00Z", since: null,
  // UX-P1 additive row facts (derivations; see lib/connections/health.ts)
  kind: "BANK", institution: "Example Bank", network: null, overdueAfterHours: 24, neverSynced: false, availableActions: ["resync", "request-reauth"],
  ...over,
});

async function main(): Promise<void> {
  console.log("provider health (OPS-5 S3)");

  // ── 1. Run-window summary ──────────────────────────────────────────────────
  {
    const s = summarizeJobRuns([run(6, "succeeded"), run(30, "succeeded"), run(54, "failed")], NOW);
    check("availability = succeeded/decided", s.availability === 2 / 3);
    check("error rate = failed/decided", s.errorRate === 1 / 3);
    check("sync failures counted", s.syncFailures === 1);
    check("latency from newest completed run", s.latencyMs === 1200);
    check("last success/failure surfaced", s.lastSuccessAt !== null && s.lastFailureAt !== null);

    const empty = summarizeJobRuns([], NOW);
    check("no runs → null availability/errorRate, hasRuns false",
      empty.availability === null && empty.errorRate === null && empty.hasRuns === false);

    const streak = summarizeJobRuns([run(1, "failed"), run(25, "failed"), run(49, "failed")], NOW);
    check("leading failure streak counted", streak.consecutiveFailures === 3 && streak.lastRunFailed === true);
    check("recent in-flight run breaks the streak",
      summarizeJobRuns([run(0.5, "running", null), run(25, "failed"), run(49, "failed")], NOW).consecutiveFailures === 0);
    check("stale running row counts as a crash in the streak",
      summarizeJobRuns([run(3, "running", null), run(25, "failed"), run(49, "failed")], NOW).consecutiveFailures === 3);
    check("running rows excluded from availability denominator",
      summarizeJobRuns([run(0.5, "running", null), run(6, "succeeded")], NOW).availability === 1);
  }

  // ── 2. Trust precedence (pure) — execution half = provider-outcome@1 ──────
  // Re-pinned 2026-11-03 (intentional, ops env-aware verdicts): the execution
  // verdict now rests on decided/failed run COUNTS with a minimum sample, not a
  // bare error rate — "high error rate" and "some failures" carry a sample.
  {
    const base: TrustSignals = {
      hasExecutionSignal: true, consecutiveFailures: 0, decidedRuns: 10, failedRuns: 0,
      freshnessState: "fresh", connections: null,
    };
    // Re-pinned (provider-connection@1): connection faults now arrive as the rule's assessment.
    // Re-pinned (provider-connection@2): FAILING needs the errors spread over ≥ 2 institutions.
    const spread4 = [{ active: 2, error: 2, reauth: 0 }, { active: 1, error: 1, reauth: 0 }, { active: 1, error: 1, reauth: 0 }];
    const connFailing = assessConnections({ active: 4, error: 4, reauth: 0, unclassified: 0, revoked: 0, institutions: spread4 });
    const connConcentrated = assessConnections({ active: 4, error: 4, reauth: 0, unclassified: 0, revoked: 0, institutions: [{ active: 4, error: 4, reauth: 0 }] });
    const connDegraded = assessConnections({ active: 4, error: 1, reauth: 0, unclassified: 0, revoked: 0 });
    check("clean → OPERATIONAL", deriveProviderTrust(base) === "OPERATIONAL");
    check("idle data + clean execution → OPERATIONAL", deriveProviderTrust({ ...base, freshnessState: "idle" }) === "OPERATIONAL");
    check("failure streak → FAILING",
      deriveProviderTrust({ ...base, consecutiveFailures: PROVIDER_FAILING_STREAK, failedRuns: PROVIDER_FAILING_STREAK }) === "FAILING");
    check("high error rate (≥ 50 % of a sufficient sample) → FAILING", deriveProviderTrust({ ...base, failedRuns: 5 }) === "FAILING");
    check("connections FAILING (provider-connection@2: all 4 in provider-side ERROR across 3 institutions) → FAILING", deriveProviderTrust({ ...base, connections: connFailing }) === "FAILING");
    check("connections institution-concentrated (all 4 at 1 institution) → DEGRADED, never FAILING", deriveProviderTrust({ ...base, connections: connConcentrated }) === "DEGRADED"
      && deriveProviderTrust({ ...base, freshnessState: "stale", connections: connConcentrated }) === "STALE");
    check("stale data (green execution) → STALE (false-green catch)",
      deriveProviderTrust({ ...base, freshnessState: "stale" }) === "STALE");
    check("empty archive → STALE", deriveProviderTrust({ ...base, freshnessState: "empty" }) === "STALE");
    check("FAILING beats STALE (execution worse than content)",
      deriveProviderTrust({ ...base, freshnessState: "stale", consecutiveFailures: PROVIDER_FAILING_STREAK, failedRuns: PROVIDER_FAILING_STREAK }) === "FAILING");
    check("some failures (isolated, sufficient sample) → DEGRADED", deriveProviderTrust({ ...base, failedRuns: 2 }) === "DEGRADED");
    check("connections DEGRADED (1 of 4 in provider-side ERROR) → DEGRADED", deriveProviderTrust({ ...base, connections: connDegraded }) === "DEGRADED");
    check("unknown freshness → DEGRADED (has execution)", deriveProviderTrust({ ...base, freshnessState: "unknown" }) === "DEGRADED");
    check("no signal at all → UNKNOWN",
      deriveProviderTrust({ ...base, hasExecutionSignal: false, decidedRuns: 0, freshnessState: "unknown" }) === "UNKNOWN");

    // The defect: 1 failed run of 1–2 in the window used to be FAILING (error rate ≥ 50 %).
    // Review fix (S2 BLOCKER): a small sample never hides a failure — DEGRADED, not FAILING, not "not enough data".
    check("1 failed of 1 run (below the run sample) → DEGRADED, not FAILING and not INSUFFICIENT_DATA",
      deriveProviderTrust({ ...base, decidedRuns: 1, failedRuns: 1, consecutiveFailures: 1 }) === "DEGRADED");
    check("1 failed of 2 runs → DEGRADED",
      deriveProviderTrust({ ...base, decidedRuns: 2, failedRuns: 1, consecutiveFailures: 1 }) === "DEGRADED");
    check("2 failed of 2 runs (streak 2) → DEGRADED",
      deriveProviderTrust({ ...base, decidedRuns: 2, failedRuns: 2, consecutiveFailures: 2 }) === "DEGRADED");
    check("too few clean runs → INSUFFICIENT_DATA, never OPERATIONAL",
      deriveProviderTrust({ ...base, decidedRuns: 2 }) === "INSUFFICIENT_DATA");
    check("no run at all but fresh data → INSUFFICIENT_DATA, never OPERATIONAL",
      deriveProviderTrust({ ...base, hasExecutionSignal: false, decidedRuns: 0 }) === "INSUFFICIENT_DATA");
    check("a recency streak is FAILING even within a small window (3 of 3 failed)",
      deriveProviderTrust({ ...base, decidedRuns: 3, failedRuns: 3, consecutiveFailures: 3 }) === "FAILING");
    check("connections FAILING still beat a small sample", deriveProviderTrust({ ...base, decidedRuns: 1, connections: connFailing }) === "FAILING");
    const a = executionAssessment({ ...base, decidedRuns: 10, failedRuns: 1 });
    check("execution assessment traces to its counts and the rule id",
      a?.verdict === "DEGRADED" && a.definition === PROVIDER_OUTCOME_DEFINITION_ID && a.evidence.decided === 10 && a.evidence.failed === 1 && a.basis === "1 of 10 runs failed");
    check("no run recorded → no execution assessment (null, never a verdict)", executionAssessment({ ...base, hasExecutionSignal: false }) === null);
  }

  // ── 2b. provider-outcome@1 boundaries (the shared rule) ────────────────────
  {
    const d = PROVIDER_OUTCOME_DEFINITION;
    check("definition is named + versioned", PROVIDER_OUTCOME_DEFINITION_ID === "provider-outcome@1" && d.version === 1);
    const calls = (decided: number, failed: number) => assessOutcomes({ kind: "calls", decided, failed, recentConsecutiveFailures: null }).verdict;
    const runs = (decided: number, failed: number, streak: number) => assessOutcomes({ kind: "runs", decided, failed, recentConsecutiveFailures: streak }).verdict;
    check("1 failed of 20 calls → DEGRADED (isolated failure)", calls(20, 1) === "DEGRADED");
    check("0 failed of 20 calls → HEALTHY", calls(20, 0) === "HEALTHY");
    check("19 clean calls (below the 20 floor) → NOT_ENOUGH_DATA, never HEALTHY", calls(19, 0) === "NOT_ENOUGH_DATA");
    // Review fix (S2 BLOCKER) — the small-sample and all-failed steps run before the floor.
    check("runs 1/1 failed → DEGRADED (small sample)", runs(1, 1, 1) === "DEGRADED");
    check("runs 2/2 failed (streak 2) → DEGRADED", runs(2, 2, 2) === "DEGRADED");
    check("runs 0/2 → NOT_ENOUGH_DATA", runs(2, 0, 0) === "NOT_ENOUGH_DATA");
    check("calls 3/3 failed → FAILING (all failed)", calls(3, 3) === "FAILING");
    check("calls 19/19 failed → FAILING (all failed)", calls(19, 19) === "FAILING");
    check("calls 2/2 failed (below 3) → DEGRADED (small sample)", calls(2, 2) === "DEGRADED");
    check("calls 10/15 → DEGRADED (small sample, not all failed)", calls(15, 10) === "DEGRADED");
    check("calls 1/19 → DEGRADED (small sample)", calls(19, 1) === "DEGRADED");
    check("small-sample basis says so",
      assessOutcomes({ kind: "runs", decided: 1, failed: 1, recentConsecutiveFailures: 1 }).basis === "1 of 1 run failed — small sample");
    check("calls 1/20 → DEGRADED; calls 10/20 → FAILING", calls(20, 1) === "DEGRADED" && calls(20, 10) === "FAILING");
    check("0 calls → NOT_ENOUGH_DATA", calls(0, 0) === "NOT_ENOUGH_DATA");
    check("ratio boundary: 9/20 DEGRADED, 10/20 FAILING", calls(20, 9) === "DEGRADED" && calls(20, 10) === "FAILING");
    check("calls carry no order: a ratio, never a recency verdict",
      assessOutcomes({ kind: "calls", decided: 100, failed: 3, recentConsecutiveFailures: null }).rule === "isolated");
    check("consecutive recent failures → FAILING (runs, last 3 all failed in a large window)", runs(40, 3, 3) === "FAILING");
    check("…a streak of 2 in a large window is only DEGRADED", runs(40, 2, 2) === "DEGRADED");
    check("run sample floor = 3: 2 clean runs NOT_ENOUGH_DATA, 3 clean runs HEALTHY", runs(2, 0, 0) === "NOT_ENOUGH_DATA" && runs(3, 0, 0) === "HEALTHY");
    check("basis words carry the figures", assessOutcomes({ kind: "calls", decided: 20, failed: 1, recentConsecutiveFailures: null }).basis === "1 of 20 calls failed");
  }

  // ── 2c. provider-connection boundaries (S2 rulings; v1 kept where @2 has no split) + the code→state pin ──
  {
    const v = (active: number, error: number, reauth = 0, unclassified = 0, revoked = 0) => assessConnections({ active, error, reauth, unclassified, revoked });
    check("definition is named + versioned (@2), sharing the failing share with provider-outcome@1",
      PROVIDER_CONNECTION_DEFINITION_ID === "provider-connection@2" && PROVIDER_CONNECTION_DEFINITION.failingShare === PROVIDER_FAILING_SHARE
        && PROVIDER_OUTCOME_DEFINITION.failingRatio === PROVIDER_FAILING_SHARE && PROVIDER_FAILING_SHARE === 0.5);
    check("ERROR 1/1 → DEGRADED (a lone connection never fails a provider)", v(1, 1).verdict === "DEGRADED" && v(1, 1).rule === "any-error");
    check("ERROR 1/2, no institution split → FAILING (≥ 50 % of ≥ 2; concentration not assessed, said in the basis)",
      v(2, 1).verdict === "FAILING" && v(2, 1).rule === "error-share" && v(2, 1).concentration === "not-assessed"
        && v(2, 1).basis === "1 of 2 connections in provider-side error — institution not recorded, concentration not assessed", v(2, 1).basis ?? "");
    check("ERROR 1/3 → DEGRADED", v(3, 1).verdict === "DEGRADED");
    check("ERROR 2/4 → FAILING; 4/4 → FAILING", v(4, 2).verdict === "FAILING" && v(4, 4).verdict === "FAILING");
    check("reauth 2/4 → DEGRADED (possible provider-side reauth wave), with the basis",
      v(4, 0, 2).verdict === "DEGRADED" && v(4, 0, 2).basis === "2 of 4 connections need reconnecting — possible provider-side reauth wave");
    check("reauth 1/3 → neutral (no verdict), named as a fact", v(3, 0, 1).verdict === null && v(3, 0, 1).facts[0] === "1 connection needs the customer to reconnect");
    check("reauth 3/3 (below the wave floor of 4) → neutral", v(3, 0, 3).verdict === null);
    check("reauth alone never FAILS a provider (10/10)", v(10, 0, 10).verdict === "DEGRADED");
    check("REVOKED 9/9 → neutral", v(0, 0, 0, 0, 9).verdict === null && v(0, 0, 0, 0, 9).facts[0] === "9 connections revoked by the customer");
    check("unclassified error → DEGRADED, never FAILING", v(2, 0, 0, 2).verdict === "DEGRADED" && v(2, 0, 0, 2).rule === "unclassified");
    check("no population (active 0) → no share rule: errors degrade, nothing fails", v(0, 5).verdict === "DEGRADED");

    // The classification pin: a code drifting into ERROR must not re-create the bug.
    check("login-required / pending-expiration codes → NEEDS_REAUTH, even under status ERROR",
      ["ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN", "PENDING_EXPIRATION", "PENDING_DISCONNECT"].every((c) =>
        connectionTrustState("ERROR", c) === "NEEDS_REAUTH" && connectionTrustState("DEGRADED", c) === "NEEDS_REAUTH" && connectionTrustState("NEEDS_REAUTH", c) === "NEEDS_REAUTH"));
    check("every code the Plaid webhook treats as reauth is a customer code", [...WEBHOOK_REAUTH_ERROR_CODES].every((c) => CUSTOMER_REAUTH_CODES.has(c)));
    check("only provider/institution-side codes → ERROR (down, not responding, internal, rate limit)",
      ["INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING", "INTERNAL_SERVER_ERROR", "RATE_LIMIT_EXCEEDED"].every((c) => connectionTrustState("ERROR", c) === "ERROR"));
    check("no code is both a provider-side and a customer code", [...PROVIDER_SIDE_ERROR_CODES].every((c) => !CUSTOMER_REAUTH_CODES.has(c)));
    // S2 follow-up — the two lists are DISJOINT, pinned both ways and by size.
    check("PROVIDER_SIDE_ERROR_CODES and CUSTOMER_REAUTH_CODES are disjoint (both directions; union size = sum)",
      [...CUSTOMER_REAUTH_CODES].every((c) => !PROVIDER_SIDE_ERROR_CODES.has(c))
        && new Set([...PROVIDER_SIDE_ERROR_CODES, ...CUSTOMER_REAUTH_CODES]).size === PROVIDER_SIDE_ERROR_CODES.size + CUSTOMER_REAUTH_CODES.size);

    // S2 follow-up — the unclassified basis names its codes (capped, codes only).
    const un = (rows: { healthState: string; errorCode: string | null; count?: number }[], active: number) => assessConnections(tallyConnections(rows, active, 0));
    check("unclassified basis names the code: '3 of 9 connections with an unclassified error (FOO_CODE)'",
      un([{ healthState: "ERROR", errorCode: "FOO_CODE", count: 3 }], 9).basis === "3 of 9 connections with an unclassified error (FOO_CODE)");
    check("…several codes sorted, capped at 3 with '+N more'",
      un(["E_D", "E_B", "E_A", "E_C", "E_E"].map((c) => ({ healthState: "ERROR", errorCode: c })), 9).basis === "5 of 9 connections with an unclassified error (E_A, E_B, E_C +2 more)");
    check("…a missing code is 'no code'; a non-code value (free text) is never echoed",
      un([{ healthState: "ERROR", errorCode: null }, { healthState: "DEGRADED", errorCode: "Request failed: user x@y timed out" }], 4).basis === "2 of 4 connections with an unclassified error (no code, non-code value)");
    check("codeWord: code-shaped only", codeWord("INSTITUTION_DOWN") === "INSTITUTION_DOWN" && codeWord("lower case") === NOT_A_CODE && codeWord("") === "no code" && codeWord("A".repeat(65)) === NOT_A_CODE);
    // S2 follow-up — without a tally the share is not computed, and the basis says so.
    const noPop = connectionAssessmentFor("PLAID", [connRow({ healthState: "ERROR", status: "ERROR", errorCode: "INSTITUTION_DOWN" }), connRow({ id: "i2", healthState: "ERROR", status: "ERROR", errorCode: "INSTITUTION_DOWN" })], null);
    check("tally absent → DEGRADED (never FAILING), basis 'connection population unavailable — share not computed'",
      noPop.verdict === "DEGRADED" && noPop.basis === "2 connections in provider-side error — connection population unavailable — share not computed", noPop.basis ?? "");
    check("tally present → the share is computed and the basis carries no such words",
      connectionAssessmentFor("PLAID", [], { active: 2, revoked: 0, faults: [{ healthState: "ERROR", errorCode: "INSTITUTION_DOWN", count: 1, institutionRef: 0 }, { healthState: "ERROR", errorCode: "INSTITUTION_DOWN", count: 1, institutionRef: 1 }], institutionActive: [1, 1] }).basis === "2 of 2 connections in provider-side error across 2 institutions");
    check("the provider-side list is exactly pinned (adding one is a reviewed change)",
      [...PROVIDER_SIDE_ERROR_CODES].sort().join() === "INSTITUTION_DOWN,INSTITUTION_NOT_AVAILABLE,INSTITUTION_NOT_RESPONDING,INSTITUTION_NO_LONGER_SUPPORTED,INTERNAL_SERVER_ERROR,PLANNED_MAINTENANCE,PRODUCT_NOT_READY,RATE_LIMIT_EXCEEDED");
    check("an unknown or missing code under ERROR is UNCLASSIFIED (degrades, never fails)",
      connectionTrustState("ERROR", "SOMETHING_NEW") === "UNCLASSIFIED" && connectionTrustState("ERROR", null) === "UNCLASSIFIED");
    check("a provider-side code without an ERROR status (DEGRADED) is UNCLASSIFIED", connectionTrustState("DEGRADED", "INSTITUTION_DOWN") === "UNCLASSIFIED");
    check("REVOKED → REVOKED; STALE / HEALTHY → NONE",
      connectionTrustState("REVOKED", "INSTITUTION_DOWN") === "REVOKED" && connectionTrustState("STALE", null) === "NONE" && connectionTrustState("HEALTHY", null) === "NONE");
  }

  // ── 2d. the connection authority's per-source tally (the denominator) ──────
  {
    const rows = [
      { source: "PLAID", healthState: "HEALTHY" as const, errorCode: null },
      { source: "PLAID", healthState: "NEEDS_REAUTH" as const, errorCode: "ITEM_LOGIN_REQUIRED" },
      { source: "PLAID", healthState: "NEEDS_REAUTH" as const, errorCode: "ITEM_LOGIN_REQUIRED" },
      { source: "PLAID", healthState: "ERROR" as const, errorCode: "INSTITUTION_DOWN" },
      { source: "WALLET", healthState: "HEALTHY" as const, errorCode: null },
    ];
    const t = tallyBySource(rows, new Map([["PLAID", 2], ["EXCHANGE", 1]]));
    check("tally: active = the live population per source; REVOKED outside it",
      t.PLAID.active === 4 && t.PLAID.revoked === 2 && t.WALLET.active === 1 && t.EXCHANGE.active === 0 && t.EXCHANGE.revoked === 1);
    // Re-pinned (provider-connection@2): a group also carries its anonymous institution ref (null = not recorded).
    check("tally: faults grouped by (state, code, institution ref), healthy rows omitted",
      JSON.stringify(t.PLAID.faults) === JSON.stringify([{ healthState: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED", count: 2, institutionRef: null }, { healthState: "ERROR", errorCode: "INSTITUTION_DOWN", count: 1, institutionRef: null }]));
    // S2 follow-up — getConnectionHealth sets bySource for EVERY source present in rows.
    const mixed = [
      { source: "PLAID", healthState: "HEALTHY" as const, errorCode: null },
      { source: "ALCHEMY", healthState: "HEALTHY" as const, errorCode: null },
      { source: "ESPLORA", healthState: "STALE" as const, errorCode: null },
      { source: "EXCHANGE", healthState: "ERROR" as const, errorCode: "INSTITUTION_DOWN" },
    ];
    const tm = tallyBySource(mixed, new Map());
    check("bySource has an entry for every source present in rows (healthy-only sources included), active = its row count",
      [...new Set(mixed.map((r) => r.source))].every((src) => tm[src]?.active === mixed.filter((r) => r.source === src).length)
        && Object.keys(tm).length === 4);
    const healthSrc = readFileSync("lib/connections/health.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("getConnectionHealth builds bySource from the SAME rows it returns (tallyBySource(rows, …)) and returns it",
      /const bySource = tallyBySource\(rows, revokedBySource\);/.test(healthSrc) && /return \{\s*total: rows\.length, counts, unhealthy, retired, bySource,/.test(healthSrc));
    const a = connectionAssessmentFor("PLAID", [], t.PLAID);
    check("tally → provider-connection@2: 1 of 4 in error ⇒ DEGRADED; 2 reauth + 2 revoked as facts",
      a.verdict === "DEGRADED" && a.basis === "1 of 4 connections in provider-side error"
        && a.facts.join(" | ") === "2 connections need the customer to reconnect | 2 connections revoked by the customer", JSON.stringify(a));
  }

  // ── 2e. provider-connection@2: institution concentration (S2 P8 item 5) ───
  {
    type I = { active: number; error: number; reauth?: number };
    const inst = (xs: I[]) => xs.map((x) => ({ active: x.active, error: x.error, reauth: x.reauth ?? 0 }));
    const total = (xs: I[], k: "active" | "error" | "reauth") => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
    /** A tally over institutions, plus `ua` unattributed live connections of which `uaErr` are in ERROR. */
    const at = (xs: I[], o: { ua?: number; uaErr?: number; uaReauth?: number; revoked?: number } = {}) => assessConnections({
      active: total(xs, "active") + (o.ua ?? 0), error: total(xs, "error") + (o.uaErr ?? 0), reauth: total(xs, "reauth") + (o.uaReauth ?? 0),
      unclassified: 0, revoked: o.revoked ?? 0, institutions: inst(xs),
    });

    const one = at([{ active: 6, error: 6 }, { active: 4, error: 0 }]);
    check("one institution all ERROR (6 of 10, ≥ 50 % of the fleet) → DEGRADED, institution-concentrated basis",
      one.verdict === "DEGRADED" && one.rule === "institution-concentrated" && one.concentration === "institution"
        && one.basis === "6 of 10 connections in provider-side error, all at 1 institution — institution-concentrated, not provider-wide", one.basis ?? "");
    const spread = at([{ active: 3, error: 3 }, { active: 3, error: 3 }, { active: 4, error: 0 }]);
    check("errors across 2 institutions, 6 of 10 (two institutions down side by side, neither a majority) → FAILING",
      spread.verdict === "FAILING" && spread.rule === "error-share" && spread.concentration === "spread"
        && spread.basis === "6 of 10 connections in provider-side error across 2 institutions", spread.basis ?? "");
    const fleetWide = at([{ active: 1, error: 1 }, { active: 1, error: 1 }, { active: 1, error: 1 }, { active: 1, error: 1 }]);
    check("every connection at every institution in ERROR → FAILING", fleetWide.verdict === "FAILING" && fleetWide.basis === "4 of 4 connections in provider-side error across 4 institutions");

    // Mixed: the overwhelming share falls out of "set the worst institution aside".
    const overwhelming = at([{ active: 10, error: 10 }, ...Array.from({ length: 10 }, (_, i) => ({ active: 1, error: i === 0 ? 1 : 0 }))]);
    check("mixed: 11 of 20, 10 at one institution, 1 of 10 elsewhere → DEGRADED (overwhelming share), the rest counted",
      overwhelming.verdict === "DEGRADED" && overwhelming.rule === "institution-concentrated"
        && overwhelming.basis === "11 of 20 connections in provider-side error, 10 at 1 institution (1 of 10 connections elsewhere) — institution-concentrated, not provider-wide", overwhelming.basis ?? "");
    const bigAndRest = at([{ active: 10, error: 10 }, { active: 4, error: 2 }, { active: 4, error: 2 }, { active: 2, error: 1 }]);
    check("mixed: a provider outage that also hits a large institution still FAILS (rest 5 of 10 ≥ 50 %)",
      bigAndRest.verdict === "FAILING" && bigAndRest.basis === "15 of 20 connections in provider-side error across 4 institutions", bigAndRest.basis ?? "");
    const restBelow = at([{ active: 10, error: 10 }, { active: 10, error: 4 }]);
    check("mixed: 14 of 20 but 4 of 10 outside the worst institution → DEGRADED (the rest is judged by the same share)",
      restBelow.verdict === "DEGRADED" && restBelow.rule === "institution-concentrated");
    check("mixed: 50/50 between two institutions is spread, never concentrated (a strict majority is required)",
      at([{ active: 2, error: 2 }, { active: 2, error: 2 }]).verdict === "FAILING" && at([{ active: 2, error: 2 }, { active: 2, error: 2 }]).concentration === "spread"
        && at([{ active: 3, error: 3 }, { active: 3, error: 3 }, { active: 20, error: 7 }]).verdict === "FAILING");
    check("mixed: the institution that explains it is chosen by the smallest rest share, not by name or order",
      at([{ active: 4, error: 0 }, { active: 6, error: 6 }]).basis === one.basis);
    check("below the share, errors at one institution → DEGRADED any-error (unchanged from v1)",
      at([{ active: 2, error: 2 }, { active: 8, error: 0 }]).rule === "any-error");

    // Small samples (guards as today, plus the institution spread).
    check("small: 1 of 1 → DEGRADED any-error (a lone connection never fails a provider)", at([{ active: 1, error: 1 }]).rule === "any-error");
    check("small: 2 of 2 at ONE institution → DEGRADED institution-concentrated", at([{ active: 2, error: 2 }]).rule === "institution-concentrated");
    check("small: 1 of 2, the other at a second healthy institution → DEGRADED (no error left elsewhere)",
      at([{ active: 1, error: 1 }, { active: 1, error: 0 }]).rule === "institution-concentrated");
    check("small: 2 of 2 at TWO institutions → FAILING (errors span ≥ 2 institutions)", at([{ active: 1, error: 1 }, { active: 1, error: 1 }]).verdict === "FAILING");
    check("a whole fleet at one institution is never FAILED by connections", at([{ active: 50, error: 50 }]).verdict === "DEGRADED");

    // Unattributed errors are never assumed to share an institution (a downgrade needs evidence).
    const ua = at([{ active: 2, error: 2 }], { ua: 2, uaErr: 2 });
    check("unattributed errors beside one institution stay in the rest → FAILING, the basis says so",
      ua.verdict === "FAILING" && ua.basis === "4 of 4 connections in provider-side error across 1 institution +2 connections without a recorded institution", ua.basis ?? "");
    const allUa = at([], { ua: 4, uaErr: 4 });
    check("an institution split with every error unattributed → FAILING (spread unknown, never assumed concentrated)",
      allUa.verdict === "FAILING" && allUa.basis === "4 of 4 connections in provider-side error — 4 connections without a recorded institution", allUa.basis ?? "");

    // REVOKED stays neutral; the reauth wave keeps its verdict and changes only its words.
    const revoked = at([{ active: 3, error: 0 }], { revoked: 9 });
    check("REVOKED stays neutral (a fact, never a verdict) under @2", revoked.verdict === null && revoked.facts[0] === "9 connections revoked by the customer");
    const waveOne = at([{ active: 5, error: 0, reauth: 5 }, { active: 5, error: 0 }]);
    check("reauth wave at ONE institution → DEGRADED (verdict unchanged), named institution-side",
      waveOne.verdict === "DEGRADED" && waveOne.rule === "reauth-wave" && waveOne.concentration === "institution"
        && waveOne.basis === "5 of 10 connections need reconnecting, all at 1 institution — institution-side reauth wave", waveOne.basis ?? "");
    const waveSpread = at([{ active: 5, error: 0, reauth: 3 }, { active: 5, error: 0, reauth: 3 }]);
    check("reauth wave spread over institutions → DEGRADED 'possible provider-side reauth wave'",
      waveSpread.verdict === "DEGRADED" && waveSpread.concentration === "spread" && waveSpread.basis === "6 of 10 connections need reconnecting — possible provider-side reauth wave");
    check("reauth never FAILS a provider, spread or not (10 of 10 at 10 institutions)",
      at(Array.from({ length: 10 }, () => ({ active: 1, error: 0, reauth: 1 }))).verdict === "DEGRADED");

    // The authority → the rule, end to end, with institution NAMES in the rows.
    const names = ["Institution A", "Institution B", "Institution C"];
    const row = (institution: string | null, healthState: "HEALTHY" | "ERROR" | "NEEDS_REAUTH", errorCode: string | null = null) => ({ source: "PLAID", healthState, errorCode, institution });
    const rowsA = [
      ...Array.from({ length: 6 }, () => row("Institution A", "ERROR", "INSTITUTION_DOWN")),
      row("Institution B", "HEALTHY"), row("Institution B", "HEALTHY"), row("Institution C", "HEALTHY"), row(null, "HEALTHY"), row("  ", "HEALTHY"),
    ];
    const tA = tallyBySource(rowsA, new Map());
    check("tallyBySource: institutions become anonymous refs; blank / missing institution ⇒ null ref, outside institutionActive",
      JSON.stringify(tA.PLAID.institutionActive) === "[6,2,1]" && tA.PLAID.active === 11
        && JSON.stringify(tA.PLAID.faults) === JSON.stringify([{ healthState: "ERROR", errorCode: "INSTITUTION_DOWN", count: 6, institutionRef: 0 }]), JSON.stringify(tA.PLAID));
    const aA = connectionAssessmentFor("PLAID", [], tA.PLAID);
    check("authority → rule: one institution's outage (6 of 11) → DEGRADED, institution-concentrated",
      aA.verdict === "DEGRADED" && aA.basis === "6 of 11 connections in provider-side error, all at 1 institution — institution-concentrated, not provider-wide", aA.basis ?? "");
    const rowsB = [...rowsA.slice(0, 3), row("Institution B", "ERROR", "INSTITUTION_NOT_RESPONDING"), row("Institution B", "ERROR", "INSTITUTION_NOT_RESPONDING"), row("Institution C", "ERROR", "INTERNAL_SERVER_ERROR"), row("Institution C", "HEALTHY")];
    const aB = connectionAssessmentFor("PLAID", [], tallyBySource(rowsB, new Map()).PLAID);
    check("authority → rule: errors at 3 institutions (6 of 7) → FAILING", aB.verdict === "FAILING" && aB.basis === "6 of 7 connections in provider-side error across 3 institutions", aB.basis ?? "");
    // OPS identity tier: the tally and the assessment carry counts, never an institution name.
    const payload = JSON.stringify([tA, aA, aB]);
    check("identity tier: no institution name reaches the tally or the assessment (counts and anonymous refs only)",
      names.every((n) => !payload.includes(n)) && !/Institution [A-Z]/.test(payload), payload);
    check("identity tier: every basis says 'institution(s)' with a count, never a name",
      [aA, aB, one, overwhelming, waveOne].every((a) => /\b1 institution\b|\b\d+ institutions\b/.test(a.basis ?? "") && !/Institution [A-Z]/.test(a.basis ?? "")));
    check("tallyConnections: the per-institution split is sorted by size (order of first appearance never survives)",
      JSON.stringify(tallyConnections([{ healthState: "ERROR", errorCode: "INSTITUTION_DOWN", institutionRef: 0 }], 3, 0, { institutionActive: [1, 2] }).institutions)
        === JSON.stringify([{ active: 2, error: 0, reauth: 0 }, { active: 1, error: 1, reauth: 0 }]));
    check("no institutionActive (older payload) ⇒ no split ⇒ concentration not assessed",
      tallyConnections([{ healthState: "ERROR", errorCode: "INSTITUTION_DOWN", institutionRef: 0 }], 3, 0).institutions === undefined);
  }

  // ── 3. Freshness CONSUMPTION (never recomputed) ────────────────────────────
  {
    const f = freshnessFromResourceReport(freshReport({ healthState: "stale", newestObservedDate: "2026-07-10", ageDays: 5, trust: { level: "low", caveats: ["newest observation is 5d old"] } }));
    check("resource report → provider freshness (state + asOf + source)",
      f.state === "stale" && f.asOf === "2026-07-10" && f.ageDays === 5 && f.source === "resource-freshness");
    check("resource freshness detail comes from the S1 caveat", f.detail === "newest observation is 5d old");

    const healthy = freshnessFromConnections("PLAID", [connRow({}), connRow({ id: "i2" })]);
    check("no unhealthy rows → fresh (connection authority)",
      healthy.state === "fresh" && healthy.source === "connection-health");
    const stale = freshnessFromConnections("PLAID", [connRow({ healthState: "STALE", since: "2026-07-01T00:00:00Z" })]);
    check("stale connection row → stale freshness", stale.state === "stale" && stale.asOf !== null);
    // Re-pinned (provider-connection@1): faults feed the CONNECTION rule, never recency.
    const errored = freshnessFromConnections("PLAID", [connRow({ healthState: "ERROR" })]);
    check("connection fault → freshness stays 'fresh' (faults feed provider-connection@2, not recency)", errored.state === "fresh");
    check("a customer who must reconnect never makes freshness 'unknown'",
      freshnessFromConnections("PLAID", [connRow({ healthState: "NEEDS_REAUTH", status: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED" })]).state === "fresh");
    check("freshness ignores other providers' rows",
      freshnessFromConnections("PLAID", [connRow({ source: "WALLET", healthState: "STALE" })]).state === "fresh");
  }

  // ── 4. Assembly — OXR (archive) + Plaid (sync) ─────────────────────────────
  {
    // OXR consuming a STALE S1 report over a GREEN execution window → false-green.
    const oxrSpec = PROVIDER_SPECS.find((s) => s.key === "OPEN_EXCHANGE_RATES")!;
    const oxr = buildProviderHealth(oxrSpec, {
      runs: [run(6, "succeeded"), run(30, "succeeded")],
      callsToday: null, calls30d: null,
      freshnessReport: freshReport({ healthState: "stale", newestObservedDate: "2026-07-10", ageDays: 5, completeness: { expected: 10, observed: 8, ratio: 0.8 }, trust: { level: "low", caveats: ["stale"] } }),
      connectionRows: [], now: NOW,
    });
    check("OXR trust = STALE despite green runs (content beats false-green)", oxr.trust === "STALE");
    const oxrPreview = buildProviderHealth(oxrSpec, {
      runs: [], callsToday: null, calls30d: null, connectionRows: [], now: NOW,
      freshnessReport: freshReport({ healthState: "not-refreshed", newestObservedDate: "2026-07-01", ageDays: 15, trust: { level: "unknown", caveats: ["Not refreshed in this environment — its producing job (fetch-fx-rates) is not scheduled on this deployment"] } }),
    });
    check("OXR on Preview (producer unscheduled, data behind) → not STALE: 'Not enough data', basis names the environment",
      oxrPreview.trust === "INSUFFICIENT_DATA" && oxrPreview.trustBasis === "no run recorded in the window · not refreshed in this environment", oxrPreview.trustBasis);
    check("OXR coverage taken from S1 completeness frontier", oxr.coverage === 8 && oxr.coverageUnit === "currency pairs");
    check("OXR surfaces a false-green note", oxr.notes.some((n) => /job success is not provider health/i.test(n)));
    check("OXR quota honestly null with a caveat",
      oxr.quota === null && oxr.remainingQuota === null && oxr.notes.some((n) => /usage\.json/i.test(n)));
    check("OXR not metered in ApiUsageCounter → calls null", oxr.callsToday === null && oxr.calls30d === null);

    // Plaid consuming a stale connection row.
    const plaidSpec = PROVIDER_SPECS.find((s) => s.key === "PLAID")!;
    const plaid = buildProviderHealth(plaidSpec, {
      runs: [run(6, "succeeded")],
      callsToday: 12, calls30d: 340,
      freshnessReport: null,
      connectionRows: [connRow({ healthState: "STALE", since: "2026-07-01T00:00:00Z" })], now: NOW,
    });
    check("Plaid freshness consumed from connection health", plaid.freshness.source === "connection-health");
    check("Plaid stale connection → STALE trust", plaid.trust === "STALE");
    check("Plaid call volume from ApiUsageCounter", plaid.callsToday === 12 && plaid.calls30d === 340);

    // Re-pinned (provider-connection@1): ONE ERROR row with no population (rows only) no longer FAILS the provider.
    const plaidError = buildProviderHealth(plaidSpec, {
      runs: [run(6, "succeeded")], callsToday: 0, calls30d: 0, freshnessReport: null,
      connectionRows: [connRow({ healthState: "ERROR", status: "ERROR", errorCode: "INSTITUTION_DOWN" })], now: NOW,
    });
    check("Plaid: one provider-side ERROR, population unknown → DEGRADED (never FAILING without a denominator)",
      plaidError.trust === "DEGRADED" && /^1 connection in provider-side error — connection population unavailable — share not computed \(provider-connection@2\)$/.test(plaidError.trustBasis ?? ""), plaidError.trustBasis);

    // ── 4b. provider-connection@2 through the assembly (with the authority's per-source tally) ──
    const runs3 = [run(6, "succeeded"), run(30, "succeeded"), run(54, "succeeded")];
    const plaidWith = (faults: { healthState: "ERROR" | "NEEDS_REAUTH" | "DEGRADED" | "STALE"; errorCode: string | null; count: number; institutionRef?: number | null }[], active: number, revoked = 0, rows: ConnectionHealthRow[] = [], institutionActive?: number[]) =>
      buildProviderHealth(plaidSpec, { runs: runs3, callsToday: 0, calls30d: 0, freshnessReport: null, connectionRows: rows, connectionTally: { active, revoked, faults, institutionActive }, now: NOW });
    const reauthRow = connRow({ healthState: "NEEDS_REAUTH", status: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED" });
    const oneReauth = plaidWith([{ healthState: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED", count: 1 }], 4, 0, [reauthRow]);
    check("1 NEEDS_REAUTH connection → provider NOT Failing (OPERATIONAL, the reconnect a neutral fact)",
      oneReauth.trust === "OPERATIONAL" && oneReauth.connections?.verdict === null
        && oneReauth.connections.facts.includes("1 connection needs the customer to reconnect")
        && oneReauth.notes.some((n) => /1 connection needs the customer to reconnect \(per-customer; does not affect provider health\)/.test(n)), JSON.stringify(oneReauth.connections));
    const preview = plaidWith([{ healthState: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED", count: 4 }], 10, 0, [reauthRow]);
    check("the Preview case: 4 reauth of 10 (below the wave share) → neutral, not Failing",
      preview.trust === "OPERATIONAL" && preview.connections?.facts[0] === "4 connections need the customer to reconnect");
    // Re-pinned (provider-connection@2): the same 4 of 4 FAILS only when spread over ≥ 2 institutions.
    const allError = plaidWith([0, 1, 2].map((i) => ({ healthState: "ERROR" as const, errorCode: "INSTITUTION_DOWN", count: i === 0 ? 2 : 1, institutionRef: i })), 4, 0, [], [2, 1, 1]);
    check("all connections in provider-side ERROR across 3 institutions → FAILING, with the basis",
      allError.trust === "FAILING" && allError.trustBasis === "4 of 4 connections in provider-side error across 3 institutions (provider-connection@2)", allError.trustBasis);
    const oneBank = plaidWith([{ healthState: "ERROR", errorCode: "INSTITUTION_DOWN", count: 4, institutionRef: 0 }], 6, 0, [], [4, 2]);
    check("4 of 6 in provider-side ERROR, all at one institution → DEGRADED, institution-concentrated basis",
      oneBank.trust === "DEGRADED" && oneBank.connections?.rule === "institution-concentrated"
        && oneBank.trustBasis === "4 of 6 connections in provider-side error, all at 1 institution — institution-concentrated, not provider-wide (provider-connection@2)", oneBank.trustBasis);
    const oneOfFour = plaidWith([{ healthState: "ERROR", errorCode: "INSTITUTION_NOT_RESPONDING", count: 1 }], 4);
    check("1 of 4 in provider-side ERROR → DEGRADED, with the basis",
      oneOfFour.trust === "DEGRADED" && oneOfFour.trustBasis === "1 of 4 connections in provider-side error (provider-connection@2)", oneOfFour.trustBasis);
    check("an ERROR status whose code is a reauth code counts as reauth, not ERROR",
      plaidWith([{ healthState: "ERROR", errorCode: "ITEM_LOGIN_REQUIRED", count: 4 }], 9).trust === "OPERATIONAL");
    check("REVOKED connections are a neutral fact only",
      (() => { const r = plaidWith([], 3, 9); return r.trust === "OPERATIONAL" && r.connections?.facts.includes("9 connections revoked by the customer") === true; })());
    check("every report carries its basis (clean: the execution counts)",
      plaidWith([], 4).trustBasis === "no failure in 3 runs (provider-outcome@1)");
  }

  // ── 5. The driver over injected authorities ────────────────────────────────
  {
    const client: ProviderHealthReadClient = {
      jobRun: {
        async findMany() {
          // Three runs each: the provider-outcome@1 run sample floor (re-pinned 2026-11-03).
          return [6, 30, 54].flatMap((h) => [
            { jobName: "sync-banks", status: "succeeded", startedAt: hoursAgo(h), completedAt: hoursAgo(h), durationMs: 900 },
            { jobName: "fetch-fx-rates", status: "succeeded", startedAt: hoursAgo(h), completedAt: hoursAgo(h), durationMs: 500 },
          ]);
        },
      },
      apiUsageCounter: {
        async findMany() {
          return [{ provider: "PLAID", day: new Date(Date.UTC(2026, 6, 16)), count: 12 }];
        },
      },
    };
    const freshness: ResourceFreshnessResult = {
      checkedAt: NOW, allFresh: true, resources: [freshReport({})],
    };
    const connections: ConnectionHealthResult = {
      total: 2, counts: { HEALTHY: 2, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 },
      checkedAt: NOW.toISOString(), cap: 20, listedScope: "unhealthy",
    };

    const result = await getProviderHealth({
      now: NOW, client,
      loadFreshness: async () => freshness,
      loadConnections: async () => connections,
    });
    const byKey = (k: string) => result.providers.find((p) => p.key === k);
    check("driver returns every registered provider", result.providers.length === PROVIDER_SPECS.length);
    check("OXR operational when fresh + green", byKey("OPEN_EXCHANGE_RATES")?.trust === "OPERATIONAL");
    check("Plaid operational when healthy connections + green", byKey("PLAID")?.trust === "OPERATIONAL");
    check("driver wires Plaid call volume", byKey("PLAID")?.callsToday === 12);
    check("counts aggregate the roll-up", result.counts.OPERATIONAL === 2 && result.counts.INSUFFICIENT_DATA === 0);
    check("each provider carries its execution assessment (3 of 3 runs clean)",
      result.providers.every((p) => p.execution?.verdict === "HEALTHY" && p.execution.evidence.decided === 3));
    check("checkedAt echoes the injected clock", result.checkedAt.getTime() === NOW.getTime());
  }

  // ── 6. Registry ────────────────────────────────────────────────────────────
  {
    const keys = PROVIDER_SPECS.map((s) => s.key);
    check("initial providers are Plaid + Open Exchange Rates",
      keys.includes("PLAID") && keys.includes("OPEN_EXCHANGE_RATES"));
    check("OXR freshness maps to the S1 'fx-rates' resource",
      PROVIDER_SPECS.find((s) => s.key === "OPEN_EXCHANGE_RATES")?.freshness.via === "resource");
    check("Plaid freshness maps to the connection authority",
      PROVIDER_SPECS.find((s) => s.key === "PLAID")?.freshness.via === "connection");
  }

  // ── 7. Source-scan fences ──────────────────────────────────────────────────
  {
    const src = readFileSync("lib/platform/provider-health.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("read-only synthesis (no writes, no new ledger)",
      !/\.create\(|\.update\(|\.updateMany\(|\.upsert\(|\.delete/i.test(code));
    check("no alerting / email / external service in the read-model",
      !/sendEmail|createNotification|slack|pagerduty|webhook|fetch\(/i.test(code));

    // The load-bearing invariant: freshness is CONSUMED, never re-derived.
    check("consumes the S1 Resource Freshness authority",
      code.includes('from "@/lib/platform/resource-freshness"') && code.includes("checkResourceFreshness"));
    check("consumes the connection-health authority for sync recency",
      code.includes('from "@/lib/connections/health"') && code.includes("getConnectionHealth"));
    check("does NOT reach into archives to recompute freshness (no MAX(date) / archive reads)",
      !/fxRate|priceObservation|FxRate\.date|MAX\(/i.test(code));
  }

  if (failures > 0) {
    console.error(`\nprovider health tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nprovider health tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
