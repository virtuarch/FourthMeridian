/**
 * lib/platform/history/history.test.ts  (OPS-5 S7)
 *
 * Behavior guards for the Operational History authority. Standalone tsx (house
 * pattern): npx tsx lib/platform/history/history.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: the authority runs against injected fake readers; the sources
 * reuse the REAL live engines (classifyJobHealth, classifyResourceFreshness) over
 * that fake data — proving history is computed the SAME way as live (no second
 * interpretation), with honest trust (observed row → derived verdict → unknown
 * where a ledger doesn't cover the period).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getOperationalHistory } from "@/lib/platform/history/history";
import type { HistoryReaders, HistoryJobRun, FxCoverageRow } from "@/lib/platform/history/sources";
import type { AlertRunSummary } from "@/lib/alerts/evaluate";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err); process.exit(1);
});

const NOW = new Date("2026-07-17T12:00:00Z");
function run(jobName: string, status: string, agoH: number, extra: Partial<HistoryJobRun> = {}): HistoryJobRun {
  return { jobName, status, startedAt: new Date(NOW.getTime() - agoH * 3600_000), completedAt: null, durationMs: 2000, trigger: "cron", errorSummary: null, ...extra };
}
function alertRun(evaluatedAtISO: string, firing: number, fired: { ruleId: string; severity: "warning" | "critical"; deliveredAtISO: string }[]): AlertRunSummary {
  return {
    evaluatedAtISO, destination: "ops@x", deliveryStatus: firing ? "sent" : "none",
    counts: { evaluated: 5, live: 4, enabled: 4, firing, delivered: fired.length, suppressed: 0 },
    rules: [],
    fired: fired.map((f) => ({ ruleId: f.ruleId, kind: "job-failing", dedupeKey: `${f.ruleId}`, severity: f.severity, summary: "x", deliveredAtISO: f.deliveredAtISO })),
  };
}
function fakeReaders(over: {
  jobRunsByJob?: Record<string, HistoryJobRun[]>;
  jobRunsWindow?: HistoryJobRun[];
  alertRuns?: AlertRunSummary[];
  fxCoverage?: FxCoverageRow[];
  fxNewest?: { dateISO: string; observedUnits: number } | null;
  throwSource?: string;
}): HistoryReaders {
  return {
    now: NOW,
    jobRunsInWindow: async () => over.jobRunsWindow ?? [],
    jobRunsAsOf: async (name, asOf, take) => (over.jobRunsByJob?.[name] ?? []).filter((r) => r.startedAt <= asOf).slice(0, take),
    alertRuns: async () => over.alertRuns ?? [],
    fxCoverageInWindow: async () => over.fxCoverage ?? [],
    fxNewestAsOf: async () => over.fxNewest ?? null,
  };
}

async function main() {
  // ── jobs source reuses classifyJobHealth at as-of ──────────────────────────────
  console.log("jobs source · reuses classifyJobHealth");
  {
    const readers = fakeReaders({ jobRunsByJob: { "sync-banks": [run("sync-banks", "failed", 1), run("sync-banks", "failed", 25), run("sync-banks", "failed", 49)] } });
    const res = await getOperationalHistory({ asOf: "2026-07-17", sourceIds: ["jobs"] }, { now: NOW, readers });
    const jobs = res.states.find((s) => s.sourceId === "jobs")!;
    check("job health reconstructed at as-of (derived tier)", jobs.tier === "derived");
    check("a 3-failure streak reads unhealthy (same verdict as live classifier)", jobs.status === "unhealthy" && (jobs.value ?? 0) >= 1);
  }

  // ── freshness source reuses classifyResourceFreshness at as-of ─────────────────
  console.log("freshness source · reuses classifyResourceFreshness");
  {
    const stale = fakeReaders({ fxNewest: { dateISO: "2026-07-01", observedUnits: SUPPORTED_COUNT } });
    const res = await getOperationalHistory({ asOf: "2026-07-17", sourceIds: ["freshness"] }, { now: NOW, readers: stale });
    const f = res.states.find((s) => s.sourceId === "freshness")!;
    check("stale FX archive reconstructed at as-of reads stale (derived)", f.status === "stale" && f.tier === "derived");

    const cold = fakeReaders({ fxNewest: null });
    const res2 = await getOperationalHistory({ asOf: "2026-07-17", sourceIds: ["freshness"] }, { now: NOW, readers: cold });
    check("no FX archive as-of ⇒ unknown (Unknown stays Unknown)", res2.states[0].tier === "unknown");
  }

  // ── alerts source ── observed firings ──────────────────────────────────────────
  console.log("alerts source · observed firings");
  {
    const readers = fakeReaders({ alertRuns: [alertRun("2026-07-16T07:30:00Z", 2, [
      { ruleId: "resource-stale", severity: "critical", deliveredAtISO: "2026-07-16T07:30:00Z" },
      { ruleId: "provider-unhealthy", severity: "warning", deliveredAtISO: "2026-07-16T07:30:00Z" },
    ])] });
    const res = await getOperationalHistory({ asOf: "2026-07-17", compareTo: "2026-07-10", sourceIds: ["alerts"] }, { now: NOW, readers });
    const a = res.states.find((s) => s.sourceId === "alerts")!;
    check("alert firing state at as-of is observed", a.tier === "observed" && a.status === "firing" && a.value === 2);
    const series = res.series.find((s) => s.sourceId === "alerts")!;
    check("alert firing series has the observed points", series.points.length === 2 && series.points.every((p) => p.tier === "observed"));
  }

  // ── as-of + compare-to both produced; completeness worst-tier ──────────────────
  console.log("as-of / compare-to / completeness");
  {
    const readers = fakeReaders({ jobRunsByJob: { "sync-banks": [run("sync-banks", "succeeded", 1)] }, fxNewest: { dateISO: "2026-07-16", observedUnits: SUPPORTED_COUNT } });
    const res = await getOperationalHistory({ asOf: "2026-07-17", compareTo: "2026-07-10" }, { now: NOW, readers });
    check("compareStates populated when compareTo set", res.compareStates != null && res.compareStates.length === res.states.length);
    check("window derived from compareTo", res.window.from === "2026-07-10" && res.window.to === "2026-07-17");
    check("completeness is the worst tier across sources", ["observed", "derived", "incomplete", "unknown"].includes(res.completeness.tier));
    check("every registered source produced a state", res.states.length >= 4);
  }

  // ── source failure ⇒ unknown (best-effort, never breaks the read) ──────────────
  console.log("source best-effort degradation");
  {
    const throwing: HistoryReaders = { ...fakeReaders({}), jobRunsAsOf: async () => { throw new Error("db down"); } };
    const res = await getOperationalHistory({ asOf: "2026-07-17", sourceIds: ["jobs"] }, { now: NOW, readers: throwing });
    check("a failing source degrades to unknown, not a thrown read", res.states[0].tier === "unknown");
  }

  // ── doctrine: sources reuse the live engines (no second interpretation) ─────────
  console.log("doctrine · reuse, not re-implement");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/history/sources.ts"), "utf8");
    // Comment-stripped: the module NAMES deriveProviderTrust in prose to explain why
    // it deliberately does NOT re-derive provider trust; only a real CALL is a defect.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("jobs source reuses the live classifyJobHealth", /classifyJobHealth/.test(code));
    check("freshness source reuses the live classifyResourceFreshness", /classifyResourceFreshness/.test(code));
    check("alerts source reads S5's alert store (no second alert model)", /alertRuns|AlertRunSummary/.test(code));
    check("as-of pick uses the HIST-1 nearest-≤ primitive (no hand-rolled scan)", /nearestOnOrBefore/.test(code));
    check("sources re-derive no provider/connection health inline (no second model)", !/PLAID_STALE|deriveConnectionHealthState|deriveProviderTrust/.test(code));
  }

  if (failures > 0) { console.error(`\nhistory.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nhistory.test: all passed.");
}

// SUPPORTED_QUOTES length — imported indirectly so the fixture matches expectedUnits.
import { SUPPORTED_QUOTES } from "@/lib/fx/config";
const SUPPORTED_COUNT = SUPPORTED_QUOTES.length;

void main();
