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
  freshnessFromResourceReport,
  freshnessFromConnections,
  buildProviderHealth,
  getProviderHealth,
  type ProviderJobRun,
  type TrustSignals,
  type ProviderHealthReadClient,
} from "@/lib/platform/provider-health";
import type { ResourceFreshnessReport, ResourceFreshnessResult } from "@/lib/platform/resource-freshness";
import type { ConnectionHealthResult, ConnectionHealthRow } from "@/lib/connections/health";

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
  source: "PLAID", id: "i1", label: "Chase", status: "ACTIVE", errorCode: null,
  healthState: "HEALTHY", lastSyncedAt: "2026-07-16T06:00:00Z", since: null, ...over,
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

  // ── 2. Trust precedence (pure) ─────────────────────────────────────────────
  {
    const base: TrustSignals = {
      hasExecutionSignal: true, lastRunFailed: false, consecutiveFailures: 0,
      errorRate: 0, freshnessState: "fresh", connectionHardFault: false, connectionDegraded: false,
    };
    check("clean → OPERATIONAL", deriveProviderTrust(base) === "OPERATIONAL");
    check("idle data + clean execution → OPERATIONAL", deriveProviderTrust({ ...base, freshnessState: "idle" }) === "OPERATIONAL");
    check("failure streak → FAILING",
      deriveProviderTrust({ ...base, consecutiveFailures: PROVIDER_FAILING_STREAK }) === "FAILING");
    check("high error rate → FAILING", deriveProviderTrust({ ...base, errorRate: 0.5 }) === "FAILING");
    check("hard connection fault → FAILING", deriveProviderTrust({ ...base, connectionHardFault: true }) === "FAILING");
    check("stale data (green execution) → STALE (false-green catch)",
      deriveProviderTrust({ ...base, freshnessState: "stale" }) === "STALE");
    check("empty archive → STALE", deriveProviderTrust({ ...base, freshnessState: "empty" }) === "STALE");
    check("FAILING beats STALE (execution worse than content)",
      deriveProviderTrust({ ...base, freshnessState: "stale", consecutiveFailures: PROVIDER_FAILING_STREAK }) === "FAILING");
    check("some failures → DEGRADED", deriveProviderTrust({ ...base, errorRate: 0.2 }) === "DEGRADED");
    check("degraded connection → DEGRADED", deriveProviderTrust({ ...base, connectionDegraded: true }) === "DEGRADED");
    check("unknown freshness → DEGRADED (has execution)", deriveProviderTrust({ ...base, freshnessState: "unknown" }) === "DEGRADED");
    check("no signal at all → UNKNOWN",
      deriveProviderTrust({ ...base, hasExecutionSignal: false, errorRate: null, freshnessState: "unknown" }) === "UNKNOWN");
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
    const errored = freshnessFromConnections("PLAID", [connRow({ healthState: "ERROR" })]);
    check("hard connection fault → freshness 'unknown' (state feeds trust, not recency)", errored.state === "unknown");
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

    const plaidError = buildProviderHealth(plaidSpec, {
      runs: [run(6, "succeeded")], callsToday: 0, calls30d: 0, freshnessReport: null,
      connectionRows: [connRow({ healthState: "ERROR" })], now: NOW,
    });
    check("Plaid hard connection fault → FAILING", plaidError.trust === "FAILING");
  }

  // ── 5. The driver over injected authorities ────────────────────────────────
  {
    const client: ProviderHealthReadClient = {
      jobRun: {
        async findMany() {
          return [
            { jobName: "sync-banks", status: "succeeded", startedAt: hoursAgo(6), completedAt: hoursAgo(6), durationMs: 900 },
            { jobName: "fetch-fx-rates", status: "succeeded", startedAt: hoursAgo(6), completedAt: hoursAgo(6), durationMs: 500 },
          ];
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
      total: 2, counts: { HEALTHY: 2, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [],
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
    check("counts aggregate the roll-up", result.counts.OPERATIONAL === 2);
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
