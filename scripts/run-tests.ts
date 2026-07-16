/**
 * scripts/run-tests.ts
 *
 * Unified local test runner for Fourth Meridian.
 *
 * The project has no test framework (no jest/vitest). Every test is a
 * standalone `tsx` script that runs inline assertions and exits 0 on pass / 1
 * on failure. This runner discovers those scripts and runs EACH IN ITS OWN
 * CHILD PROCESS — that one-process-per-file isolation is load-bearing: several
 * tests call `process.exit` and a number mutate `process.env`, and a separate
 * process per file keeps those effects from leaking between tests.
 *
 * PARALLELISM (TEST-4): files run through a bounded worker pool instead of a
 * sequential loop. One process per file is preserved, so per-process isolation
 * (env / process.exit / module state) is unchanged; the only cross-process
 * hazard would be two files racing on a shared filesystem path or a shared DB —
 * a determinism audit found none (the sole test that writes a tracked file,
 * lib/atlas/palette-ratchet.test.ts, writes only its own dedicated baseline and
 * runs in the SERIAL lane below out of caution; every DB-shaped test uses an
 * in-memory fake, never a live database). Aggregation is order-independent and
 * the per-file failure report is unchanged, so pass/fail is deterministic.
 *
 * Concurrency defaults to (CPU count - 1) and is overridable:
 *     TEST_CONCURRENCY=4 npm test        # cap the pool at 4 processes
 *     TEST_BAIL=1        npm test        # stop scheduling new files on first fail
 *
 * Usage:  npm test   |   npm run test:unit   |   npx tsx scripts/run-tests.ts
 *
 * SCOPE — safe local tests only:
 *   Discovers every ".test.ts" under `lib/`, `app/`, and `components/`. These
 *   are unit / pure / source-scan tests: no live database, no network, no
 *   Plaid, no secrets. Three of them import Prisma enum *values*, so the
 *   generated client must exist — `npm run test:unit` runs `prisma generate`
 *   first.
 *
 * DELIBERATELY EXCLUDED (do not add here): the DB/Plaid dev harnesses
 *   scripts/test-visibility-two-user-space.ts (+ .impl.ts) and
 *   scripts/reset-chase-history-test.ts. They are named `test-*.ts` (not
 *   `*.test.ts`), require a live Postgres / Plaid, and are not unit tests.
 *   The glob below never matches them; keep it that way.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const PRELOAD = path.join(ROOT, "scripts", "lib", "server-only-preload.cjs");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");

// Recursively collect files ending in ".test.ts" under a root dir. A hand-rolled
// walk (vs. fs.globSync) keeps this fully typed under @types/node@20 and adds no
// dependency. node_modules / .next are never under lib|app, so no prune needed.
function collectTests(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectTests(full));
    else if (entry.name.endsWith(".test.ts")) found.push(path.relative(ROOT, full));
  }
  return found;
}

// Files that must NOT share the parallel lane. Kept explicit + tiny so the
// hazard is auditable. Currently only the palette burn-down ratchet, which
// rewrites a tracked baseline file during its run; isolating it removes any
// doubt about a working-tree write racing a concurrent reader. Add a path here
// (repo-relative, matching the collectTests output) if a future test shares
// mutable filesystem/DB state. Everything else runs in the bounded pool.
const SERIAL_FILES = new Set<string>([
  path.join("lib", "atlas", "palette-ratchet.test.ts"),
]);

// Deterministic, predictable order. `components` carries colocated presentational
// tests (pure, DB-free — same house pattern); they need no live services, so the
// keep-it-unit rule still holds.
const files = [
  ...collectTests(path.join(ROOT, "lib")),
  ...collectTests(path.join(ROOT, "app")),
  ...collectTests(path.join(ROOT, "components")),
].sort();

if (files.length === 0) {
  console.error("run-tests: no *.test.ts files found under lib/, app/, or components/.");
  process.exit(1);
}

const serialFiles = files.filter((f) => SERIAL_FILES.has(f));
const parallelFiles = files.filter((f) => !SERIAL_FILES.has(f));

// Default pool size: one per core, less one to leave the machine responsive
// (tsx startup is the dominant cost, so this is near-linear). TEST_CONCURRENCY
// overrides; it is clamped to [1, parallelFiles.length].
const cpuCount = os.cpus().length || 4;
const requested = Number.parseInt(process.env.TEST_CONCURRENCY ?? "", 10);
const defaultConcurrency = Math.max(1, cpuCount - 1);
const concurrency = Math.min(
  Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : defaultConcurrency),
  Math.max(1, parallelFiles.length),
);
const BAIL = process.env.TEST_BAIL === "1" || process.env.TEST_BAIL === "true";

console.log(
  `run-tests: ${files.length} test file(s) — ${parallelFiles.length} parallel ` +
    `(concurrency ${concurrency}), ${serialFiles.length} serial\n`,
);

type Result = { file: string; ok: boolean; output: string };

// Run one test file in its own child process. Resolves (never rejects) with the
// captured status + combined stdout/stderr, so one crashed child can't take down
// the pool. `process.exit(1)` in the test surfaces as a nonzero `code` here.
function runFile(file: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, ["--require", PRELOAD, file], { cwd: ROOT });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => resolve({ file, ok: false, output: `spawn error: ${String(err)}` }));
    child.on("close", (code) => resolve({ file, ok: code === 0, output: output.trimEnd() }));
  });
}

// Bounded worker pool: `concurrency` workers pull from a shared cursor until the
// list is drained. Results are collected as they finish (interleaved progress),
// then aggregated deterministically by the caller. With BAIL, workers stop
// pulling new files after the first failure; in-flight children are allowed to
// finish so their output isn't lost.
async function runPool(list: string[], poolSize: number): Promise<Result[]> {
  const results: Result[] = [];
  let cursor = 0;
  let bailed = false;
  async function worker(): Promise<void> {
    while (cursor < list.length && !bailed) {
      const file = list[cursor++];
      const result = await runFile(file);
      results.push(result);
      console.log(`  ${result.ok ? "✓" : "✗"} ${result.file}`);
      if (!result.ok && BAIL) bailed = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(poolSize, list.length) }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  // Serial lane first (small, isolated), then the bounded parallel pool.
  const serialResults: Result[] = [];
  for (const file of serialFiles) {
    if (BAIL && serialResults.some((r) => !r.ok)) break;
    const result = await runFile(file);
    serialResults.push(result);
    console.log(`  ${result.ok ? "✓" : "✗"} ${result.file} (serial)`);
  }

  const parallelResults = parallelFiles.length > 0 ? await runPool(parallelFiles, concurrency) : [];

  const all = [...serialResults, ...parallelResults];
  const ran = all.length;
  const skipped = files.length - ran; // nonzero only under BAIL

  // Deterministic report: failures ordered by the canonical (sorted) file list,
  // independent of completion order.
  const byFile = new Map(all.map((r) => [r.file, r]));
  const failures = files.map((f) => byFile.get(f)).filter((r): r is Result => !!r && !r.ok);
  const passed = ran - failures.length;

  console.log(`\nrun-tests: ${passed}/${ran} passed${skipped > 0 ? ` (${skipped} skipped after fail-fast)` : ""}.`);

  if (failures.length > 0) {
    console.error(`\nrun-tests: ${failures.length} file(s) FAILED\n`);
    for (const { file, output } of failures) {
      console.error(`──────── ${file} ────────`);
      // Last lines carry the assertion/summary for these standalone scripts.
      console.error(output.split("\n").slice(-30).join("\n"));
      console.error("");
    }
    process.exit(1);
  }

  console.log("run-tests: all tests passed.");
  process.exit(0);
}

void main();
