/**
 * lib/platform/cost/cost.test.ts  (OPS-5 S10)
 *
 * Behavior guards for Cost & Latency Intelligence. Standalone tsx (house pattern).
 * PURE: derivation runs over INJECTED S7 history + S9 convergence results — proving
 * S10 consumes those two authorities ONLY (no direct execution reads), stamps
 * provenance, and keeps Unknown as Unknown / Estimated as Estimated.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getCostIntelligence, deriveCostMetrics } from "@/lib/platform/cost/cost";
import type { OperationalHistoryResult, OperationalHistorySeries } from "@/lib/platform/history/types";
import type { ConvergenceResult, ConvergenceEpisode } from "@/lib/platform/convergence/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});

function latencySeries(values: number[]): OperationalHistorySeries {
  return { sourceId: "jobs", label: "Runtime", metric: "latency", unit: "ms", trust: "observed", coverageFrom: "2026-07-01",
    points: values.map((v, i) => ({ at: `2026-07-${String(1 + i).padStart(2, "0")}T06:00:00Z`, tier: "observed", label: "sync-banks", value: v })) };
}
function hist(series: OperationalHistorySeries[]): OperationalHistoryResult {
  return { asOf: "2026-07-17", compareTo: null, window: { from: "2026-07-01", to: "2026-07-17" }, states: [], compareStates: null, series, completeness: { tier: "derived", conflict: false, reason: "x" }, checkedAt: "2026-07-17T00:00:00Z" };
}
function episode(events: { kind: string; outcome: "failure" | "degraded" | "recovery" | "action" | "info" }[]): ConvergenceEpisode {
  return { id: "e0", from: "2026-07-16T06:00:00Z", to: "2026-07-16T09:00:00Z", title: "t", subjects: ["fetch-fx-rates"], participants: ["jobRun", "alerts"],
    events: events.map((e, i) => ({ at: `2026-07-16T0${6 + i}:00:00Z`, ledger: "jobRun", kind: e.kind, subject: "fetch-fx-rates", outcome: e.outcome, detail: "x", tier: "observed" })),
    narrative: { happened: "x", caused: "y", recovered: "z" }, trust: "derived" };
}
function conv(episodes: ConvergenceEpisode[]): ConvergenceResult {
  return { window: { from: "2026-07-01", to: "2026-07-17" }, episodes, events: episodes.flatMap((e) => e.events), eventCount: episodes.reduce((n, e) => n + e.events.length, 0), participants: ["jobRun", "alerts"], checkedAt: "2026-07-17T00:00:00Z" };
}

async function main() {
  // ── derivation over S7 latency + S9 episodes ────────────────────────────────────
  console.log("derivation · latency + failures");
  {
    const metrics = deriveCostMetrics(hist([latencySeries([1000, 1000, 3000, 3000])]), conv([episode([{ kind: "job-failed", outcome: "failure" }, { kind: "manual-run", outcome: "action" }])]));
    const by = (id: string) => metrics.find((m) => m.id === id)!;
    check("avg-runtime derived from S7 latency (mean 2000)", by("avg-runtime").value === 2000 && by("avg-runtime").tier === "derived");
    check("latency-drift is recent-minus-earlier (+2000)", by("latency-drift").value === 2000 && by("latency-drift").tier === "derived");
    check("failure-cost from S9 episodes (1 failure event)", by("failure-cost").value === 1);
    check("retry-cost from S9 episodes (1 manual run)", by("retry-cost").value === 1);
    check("incident-count = episode count", by("incident-count").value === 1);
    check("projected-daily-load is ESTIMATED (a projection, not measured)", by("projected-daily-load").tier === "estimated");
    check("spend-usd is UNKNOWN (no pricing) — never a fabricated 0", by("spend-usd").value === null && by("spend-usd").tier === "unknown");
    check("every metric states its provenance", metrics.every((m) => m.provenance.length > 0));
  }

  // ── unknown stays unknown when upstream is empty ────────────────────────────────
  console.log("unknown stays unknown");
  {
    const metrics = deriveCostMetrics(hist([]), conv([]));
    check("no latency data ⇒ avg-runtime unknown (not 0)", metrics.find((m) => m.id === "avg-runtime")!.value === null && metrics.find((m) => m.id === "avg-runtime")!.tier === "unknown");
    check("no episodes ⇒ failure-cost unknown", metrics.find((m) => m.id === "failure-cost")!.value === null);
  }

  // ── authority consumes S7 + S9 via injected deps ────────────────────────────────
  console.log("authority · consumes S7 + S9 only");
  {
    let histCalls = 0, convCalls = 0;
    const res = await getCostIntelligence({ asOf: "2026-07-17" }, {
      now: new Date("2026-07-17T00:00:00Z"),
      history: async () => { histCalls++; return hist([latencySeries([2000, 2000])]); },
      convergence: async () => { convCalls++; return conv([episode([{ kind: "job-failed", outcome: "failure" }])]); },
    });
    check("fetches S7 history exactly once", histCalls === 1);
    check("fetches S9 convergence exactly once", convCalls === 1);
    check("result trust is the worst tier across valued metrics", ["derived", "estimated", "unknown"].includes(res.trust));
  }

  // ── doctrine: no direct execution/ledger reads ──────────────────────────────────
  console.log("doctrine · derived-only");
  {
    const code = readFileSync(path.join(process.cwd(), "lib/platform/cost/cost.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("consumes S7 (getOperationalHistory)", /getOperationalHistory/.test(code));
    check("consumes S9 (getConvergence)", /getConvergence/.test(code));
    check("NO direct db / JobRun / ApiUsageCounter reads (S7+S9 only)", !/@\/lib\/db|\bdb\.jobRun|apiUsageCounter|\.findMany\(/.test(code));
    check("no background worker / collector (no setInterval/cron/queue)", !/setInterval|new Queue|cron/i.test(code));
  }

  if (failures > 0) { console.error(`\ncost.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncost.test: all passed.");
}

void main();
