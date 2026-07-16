/**
 * lib/platform/convergence/convergence.test.ts  (OPS-5 S9)
 *
 * Behavior guards for the convergence read model. Standalone tsx (house pattern).
 * NO LIVE DATABASE: injected fake readers project a multi-ledger "operational
 * story"; the pure correlation engine clusters it into one episode with a derived
 * narrative — proving S9 CONSUMES the ledgers (never merges/persists/reinterprets).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getConvergence, correlateEpisodes } from "@/lib/platform/convergence/convergence";
import type { ConvergenceReaders, ConvJobRun } from "@/lib/platform/convergence/participants";
import type { AlertRunSummary } from "@/lib/alerts/evaluate";
import type { ConvergenceEvent } from "@/lib/platform/convergence/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});

const T = Date.parse("2026-07-16T06:00:00Z");
const at = (h: number) => new Date(T + h * 3600_000);
const atISO = (h: number) => at(h).toISOString();

function job(name: string, status: string, h: number, trigger = "cron"): ConvJobRun {
  return { jobName: name, status, startedAt: at(h), trigger, errorSummary: status === "failed" ? "all providers empty" : null };
}
function alertRun(fired: { ruleId: string; severity: "warning" | "critical"; h: number }[]): AlertRunSummary {
  return {
    evaluatedAtISO: atISO(1), destination: "ops@x", deliveryStatus: "sent",
    counts: { evaluated: 5, live: 4, enabled: 4, firing: fired.length, delivered: fired.length, suppressed: 0 },
    rules: [], fired: fired.map((f) => ({ ruleId: f.ruleId, kind: "resource-stale", dedupeKey: f.ruleId, severity: f.severity, summary: "x", deliveredAtISO: atISO(f.h) })),
  };
}
function fakeReaders(over: { jobRuns?: ConvJobRun[]; alertRuns?: AlertRunSummary[] }): ConvergenceReaders {
  return {
    now: at(24),
    jobRuns: async () => over.jobRuns ?? [],
    alertRuns: async () => over.alertRuns ?? [],
    syncIssues: async () => [],
    statusTransitions: async () => [],
  };
}

async function main() {
  // ── the FX incident as one operational story ───────────────────────────────────
  console.log("operational story · one episode");
  {
    const readers = fakeReaders({
      jobRuns: [job("fetch-fx-rates", "failed", 0), job("fetch-fx-rates", "succeeded", 3, "manual"), job("fetch-fx-rates", "succeeded", 4)],
      alertRuns: [alertRun([{ ruleId: "resource-stale", severity: "critical", h: 1 }])],
    });
    const res = await getConvergence({ asOf: "2026-07-16", from: "2026-07-16" }, { now: at(24), readers });
    check("the correlated burst is ONE episode", res.episodes.length === 1);
    const ep = res.episodes[0];
    check("multiple ledgers participated (jobRun + alerts)", ep.participants.includes("jobRun") && ep.participants.includes("alerts"));
    check("subjects include the job and the alert rule", ep.subjects.includes("fetch-fx-rates") && ep.subjects.includes("resource-stale"));
    check("narrative: what happened is the lead failure", /failed/.test(ep.narrative.happened));
    check("narrative: what caused it names the failures", ep.narrative.caused != null && /fetch-fx-rates/.test(ep.narrative.caused!));
    check("narrative: what recovered is present (the later success)", ep.narrative.recovered != null);
    check("episode trust is derived (correlation narrative)", ep.trust === "derived");
    check("eventCount counts every projected row", res.eventCount === 4);
  }

  // ── time-gap clustering: distant events are separate episodes ───────────────────
  console.log("clustering · time gap");
  {
    const evts: ConvergenceEvent[] = [
      { at: atISO(0), ledger: "jobRun", kind: "job-failed", subject: "a", outcome: "failure", detail: "a failed", tier: "observed" },
      { at: atISO(20), ledger: "jobRun", kind: "job-failed", subject: "b", outcome: "failure", detail: "b failed", tier: "observed" },
    ];
    check("events > 6h apart split into separate episodes", correlateEpisodes(evts).length === 2);
    check("empty input ⇒ no episodes", correlateEpisodes([]).length === 0);
  }

  // ── best-effort: a failing participant never breaks the read ────────────────────
  console.log("best-effort");
  {
    const readers: ConvergenceReaders = { ...fakeReaders({}), jobRuns: async () => { throw new Error("db down"); } };
    const res = await getConvergence({ asOf: "2026-07-16", from: "2026-07-16" }, { now: at(24), readers });
    check("a failing participant degrades gracefully (empty, no throw)", res.eventCount === 0 && res.episodes.length === 0);
  }

  // ── doctrine: pure read model, no persistence, no reinterpretation ──────────────
  console.log("doctrine · pure read model");
  {
    const conv = readFileSync(path.join(process.cwd(), "lib/platform/convergence/convergence.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const part = readFileSync(path.join(process.cwd(), "lib/platform/convergence/participants.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("convergence writes nothing (no create/update/delete)", !/\.(create|update|updateMany|delete|deleteMany|upsert)\(/.test(conv) && !/\.(create|update|delete|upsert)\(/.test(part));
    check("no duplicate event system (no emit/dispatch/publish)", !/\bemit\(|dispatchEvent|publish\(/.test(conv) && !/\bemit\(|dispatchEvent|publish\(/.test(part));
    check("participants are registry-driven (no giant switch on ledger)", !/switch\s*\(/.test(part));
  }

  if (failures > 0) { console.error(`\nconvergence.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nconvergence.test: all passed.");
}

void main();
