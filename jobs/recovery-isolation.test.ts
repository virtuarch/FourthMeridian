/**
 * jobs/recovery-isolation.test.ts  (OPS-2D-4A follow-up)
 *
 * A fan-out job must not be able to reach records a test did not ask for.
 *
 * This guard exists because of a specific incident, not a hypothetical. While
 * proving the OPS-2D-4A recovery path, a runtime script called
 * `resumeStaleImports()` directly against the persistent development database.
 * The job selects EVERY stale item on the platform, so it drove two unrelated
 * real connections through a mocked provider and overwrote their Plaid cursors
 * with the mock's value. Nothing in the code was wrong; the problem was that a
 * test had no way to say "only these items", so the only available call was the
 * platform-wide one.
 *
 * The fix is a candidate-loader seam, and this file holds the two halves of the
 * boundary it creates:
 *
 *   BEHAVIOURAL (§1–§3) — a scoped run drives exactly the supplied set and
 *   nothing else, proven by running the real job against fixtures.
 *
 *   STRUCTURAL (§4) — no tracked test may call the unscoped form, so the next
 *   person cannot reintroduce the incident by writing the convenient thing.
 *
 * Run:  npx tsx jobs/recovery-isolation.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resumeStaleImports, type StaleImportCandidate } from "./resume-stale-imports";
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";
import type { WebhookSyncOutcome } from "@/lib/plaid/webhook-sync";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** A fixture population that exists only in this process. */
const FIXTURE: StaleImportCandidate[] = [
  { id: "fixture-item-1", institutionName: "Fixture Bank A" },
  { id: "fixture-item-2", institutionName: "Fixture Bank B" },
];

function scopedLoader(items: StaleImportCandidate[], total = items.length) {
  return async () => ({ candidates: total, items });
}

/** A hermetic ADMIT — no database, so the isolation assertions are not vacuous. */
const admit = async (): Promise<StampedAdmissionVerdict> => ({
  decision: "ADMIT", reason: null, label: null, evidence: null,
  authority: "PlatformSetting", evaluatedAt: "2026-07-25T00:00:00.000Z",
});

async function main() {
  // ── 1. Structural — checked FIRST, before anything executes ─────────────────
  //
  // Order is load-bearing: if the job's loader fallback were removed, the
  // behavioural runs below would issue a PLATFORM-WIDE query before any
  // assertion could object — which is the incident this file exists to prevent.
  // The structural check therefore runs before a single candidate is loaded.
  console.log("1. no tracked test can call the platform-wide fan-out");
  {
    const callers = [...walk("lib"), ...walk("jobs"), ...walk("app"), ...walk("scripts"), ...walk("components")]
      .filter((f) => /\.test\.tsx?$/.test(f) || f.startsWith("scripts/"))
      .filter((f) => f !== "jobs/recovery-isolation.test.ts")
      .filter((f) => {
        const s = code(f);
        // An unscoped call is resumeStaleImports() with no argument.
        return /resumeStaleImports\(\s*\)/.test(s);
      });
    check("no test or script calls resumeStaleImports() unscoped", callers.length === 0, callers.join(", "));

    // The production path must still use the canonical loader.
    const job = code("jobs/resume-stale-imports.ts");
    check("the job defaults to the platform-wide loader",
      /deps\.loadCandidates \?\? loadStaleCandidates/.test(job));
    check("the canonical loader still applies the ACTIVE + live-user gate",
      /status:\s*PlaidItemStatus\.ACTIVE/.test(job) && /deactivatedAt: null/.test(job));
    check("the scheduled route calls the job with no deps (production is unscoped by design)",
      /runJob\("resume-stale-imports", resumeStaleImports/.test(code("app/api/jobs/resume-stale-imports/route.ts")));

    // The same hazard exists for the other fan-out; it has no runtime test today,
    // but the guard is stated so adding one has to be deliberate.
    const syncBanksCallers = [...walk("scripts"), ...walk("lib"), ...walk("jobs")]
      .filter((f) => /\.test\.tsx?$/.test(f) || f.startsWith("scripts/"))
      .filter((f) => f !== "jobs/recovery-isolation.test.ts")
      .filter((f) => /\bsyncBanks\(\s*\)/.test(code(f)));
    check("no test or script calls syncBanks() unscoped", syncBanksCallers.length === 0,
      syncBanksCallers.join(", "));
  }

  if (failures > 0) {
    console.error("\nrecovery-isolation.test: STRUCTURAL boundary broken — refusing to run the " +
      "behavioural scenarios, which would issue a platform-wide query.");
    process.exit(1);
  }

  // ── 2. A scoped run touches exactly the supplied set ────────────────────────
  console.log("2. a scoped run drives the fixture set and nothing else");
  {
    const driven: string[] = [];
    const drive = async (id: string): Promise<WebhookSyncOutcome> => { driven.push(id); return "ran"; };
    const r = await resumeStaleImports({ loadCandidates: scopedLoader(FIXTURE), drive, admit });

    check("drove exactly the fixture items",
      JSON.stringify(driven) === JSON.stringify(FIXTURE.map((f) => f.id)), driven.join(","));
    check("touched no id outside the fixture",
      driven.every((id) => FIXTURE.some((f) => f.id === id)));
    check("counts reflect the scoped population", r.candidates === 2 && r.attempted === 2 && r.ran === 2);
  }

  // ── 3. An empty fixture drives nothing ──────────────────────────────────────
  console.log("3. an empty fixture is a no-op, not a fallback");
  {
    const driven: string[] = [];
    const r = await resumeStaleImports({
      loadCandidates: scopedLoader([], 0),
      drive: async (id) => { driven.push(id); return "ran"; },
      admit,
    });
    // The load-bearing assertion: supplying no candidates must NOT silently fall
    // back to the platform-wide query. If it did, this would drive real records.
    check("nothing was driven", driven.length === 0, driven.join(","));
    check("reported zero candidates", r.candidates === 0 && r.attempted === 0);
  }

  // ── 4. Outcomes are attributed per fixture item ─────────────────────────────
  console.log("4. per-candidate outcomes are counted honestly");
  {
    const r = await resumeStaleImports({
      loadCandidates: scopedLoader(FIXTURE),
      drive: async (id) => (id === "fixture-item-1" ? "skipped-locked" : "ran"),
      admit,
    });
    check("lock contention counted as skipped, not ran", r.skipped === 1 && r.ran === 1);
  }

  if (failures > 0) {
    console.error(`\nrecovery-isolation.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nrecovery-isolation.test: all passed.");
}

main();
