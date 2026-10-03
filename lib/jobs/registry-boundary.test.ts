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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const EXECUTABLE_REGISTRY = "lib/jobs/registry.ts";

/** Source with comments removed — string-aware, so "/api/*" in a string survives. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

interface Edges { local: string[]; packages: string[] }

/** Value edges of one module: static imports, re-exports, import(), require(). Type-only edges excluded. */
function edgesOf(file: string): Edges {
  const src = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
  const specs: string[] = [];
  const staticRe = /\b(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g;
  for (const m of src.matchAll(staticRe)) if (!m[1]) specs.push(m[2]);
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  const local: string[] = [];
  const packages: string[] = [];
  for (const s of specs) {
    const resolved = resolveLocal(file, s);
    if (resolved) local.push(resolved);
    else if (!s.startsWith(".") && !s.startsWith("@/")) packages.push(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
  }
  return { local, packages };
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    if (existsSync(path.join(ROOT, base + ext)) && /\.tsx?$/.test(base + ext)) return base + ext;
  }
  return null;
}

/** Transitive value closure, each file mapped to the file that first reached it. */
function closure(roots: string[]): { via: Map<string, string | null>; packages: Map<string, string> } {
  const via = new Map<string, string | null>();
  const packages = new Map<string, string>();
  const todo: [string, string | null][] = roots.map((r) => [r, null]);
  while (todo.length > 0) {
    const [file, parent] = todo.pop()!;
    if (via.has(file)) continue;
    via.set(file, parent);
    const { local, packages: pk } = edgesOf(file);
    for (const p of pk) if (!packages.has(p)) packages.set(p, file);
    for (const l of local) todo.push([l, file]);
  }
  return { via, packages };
}

function chain(via: Map<string, string | null>, file: string): string {
  const out = [file];
  for (let p = via.get(file); p; p = via.get(p)) out.push(p);
  return out.join(" ← ");
}

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
