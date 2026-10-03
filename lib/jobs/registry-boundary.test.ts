/**
 * lib/jobs/registry-boundary.test.ts  (PERF-1)
 *
 * Asking "can the scheduler honour this cadence?" must not compile the jobs.
 *
 * The incident: 34e592c bound setting validation to scheduler capability
 * (lib/auth.ts → lib/platform-settings.ts → lib/platform/scheduler-capability.ts)
 * and capability read SCHEDULED_JOBS from the executable registry, whose run()
 * thunks dynamic-import every job body. Free at Node module load — but webpack
 * compiles every import() target into the importing route, so every
 * authenticated route (even /api/spaces) compiled sync-banks, sync-crypto and
 * the Plaid SDK. Measured A/B: /api/spaces 54 → 260 app modules, +~140 MB heap,
 * +~1.3 s cold compile, Plaid's 20.6 MB vendor chunk on a route that never syncs.
 *
 * The invariant is about REACHABILITY AS THE BUNDLER SEES IT: static imports,
 * re-exports AND dynamic import()s are all edges; `import type` is not. The
 * forbidden set is DERIVED from the executable registry itself (every module
 * its bodies import), not a hand-kept list of filenames, so a new job body is
 * covered the day it is registered.
 *
 * Run:  npx tsx lib/jobs/registry-boundary.test.ts
 */

import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";
import { importClosure } from "../../scripts/lib/import-closure";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const EXECUTABLE_REGISTRY = "lib/jobs/registry.ts";
const graph = importClosure();
const edgesOf = graph.edgesOf;
const closure = (roots: string[]) => graph.closure(roots);
const chain = (via: Map<string, string | null>, file: string) => graph.chain({ via, packages: new Map() }, file);

// ── 1. The forbidden set, derived from the executable registry ──────────────
console.log("1. the executable registry's bodies are the forbidden set");
const registryEdges = edgesOf(EXECUTABLE_REGISTRY);
const bodyModules = registryEdges.local.filter((f) => f !== "lib/jobs/registry.core.ts");
check("the executable registry imports at least one job body (else this guard is vacuous)",
  bodyModules.length >= SCHEDULED_JOBS.length / 2, bodyModules.join(", "));
check("the walker sees the registry's dynamic imports: a body is reachable FROM the registry",
  bodyModules.some((b) => closure([EXECUTABLE_REGISTRY]).via.has(b)));
check("…and through it the Plaid SDK (the cost that made this a defect)",
  closure([EXECUTABLE_REGISTRY]).packages.has("plaid"));
const FORBIDDEN_FILES = new Set([EXECUTABLE_REGISTRY, ...bodyModules]);
const isForbidden = (f: string) => FORBIDDEN_FILES.has(f) || f.startsWith("jobs/");

// ── 2. The shared request path never reaches them ───────────────────────────
console.log("\n2. the shared request path reaches no job body, no executable registry, no Plaid");
const SHARED_PATH = [
  "lib/auth.ts",
  "lib/session.ts",
  "lib/platform-settings.ts",
  "lib/platform/scheduler-capability.ts",
  "lib/jobs/registry.core.ts",
];
for (const root of SHARED_PATH) {
  const { via, packages } = closure([root]);
  const hits = [...via.keys()].filter(isForbidden);
  check(`${root} reaches no executable job code`, hits.length === 0, hits.map((h) => chain(via, h)).join("; "));
  check(`${root} reaches no Plaid SDK`, !packages.has("plaid"),
    packages.has("plaid") ? chain(via, packages.get("plaid")!) : undefined);
}

// ── 3. The facts module is facts ────────────────────────────────────────────
console.log("\n3. registry.core.ts holds facts only");
{
  const core = edgesOf("lib/jobs/registry.core.ts");
  check("registry.core.ts has no value imports (type-only)", core.local.length === 0 && core.packages.length === 0,
    [...core.local, ...core.packages].join(", "));
  check("scheduler capability reads the facts, not the executable registry",
    edgesOf("lib/platform/scheduler-capability.ts").local.includes("lib/jobs/registry.core.ts") &&
    !edgesOf("lib/platform/scheduler-capability.ts").local.includes(EXECUTABLE_REGISTRY));
}

// ── 4. One authority: the executable registry is the facts plus a body each ─
console.log("\n4. SCHEDULED_JOBS = SCHEDULED_JOB_FACTS + one body each (nothing added, nothing reordered)");
{
  check("same jobs, same order",
    SCHEDULED_JOBS.map((j) => j.name).join() === SCHEDULED_JOB_FACTS.map((f) => f.name).join());
  check("every job has a callable body", SCHEDULED_JOBS.every((j) => typeof j.run === "function"));
  check("bodies are distinct closures per job",
    new Set(SCHEDULED_JOBS.map((j) => j.run)).size === SCHEDULED_JOBS.length);
  const mismatched = SCHEDULED_JOBS.filter((j, i) => {
    const { run: _run, ...facts } = j;
    return JSON.stringify(facts) !== JSON.stringify(SCHEDULED_JOB_FACTS[i]);
  });
  check("each entry's facts are exactly the core's (no second source of slots)", mismatched.length === 0,
    mismatched.map((j) => j.name).join(", "));
}

if (failures > 0) {
  console.error(`\nregistry-boundary: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nregistry-boundary: all checks passed");
