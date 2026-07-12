/**
 * scripts/run-tests.ts
 *
 * Unified local test runner for Fourth Meridian.
 *
 * The project has no test framework (no jest/vitest). Every test is a
 * standalone `tsx` script that runs inline assertions and exits 0 on pass / 1
 * on failure. This runner discovers those scripts, runs each in its own child
 * process (isolation: several tests call `process.exit` and one mutates
 * `process.env`), and aggregates a single pass/fail summary with a nonzero exit
 * code on any failure. No new dependency — `tsx` is already a devDependency.
 *
 * Usage:  npm test   |   npm run test:unit   |   npx tsx scripts/run-tests.ts
 *
 * SCOPE — safe local tests only:
 *   Discovers every ".test.ts" under `lib/` and `app/`. These are unit / pure /
 *   source-scan tests: no live database, no network, no Plaid, no secrets.
 *   Three of them import Prisma enum *values*, so the generated client must
 *   exist — `npm run test:unit` runs `prisma generate` first.
 *
 * DELIBERATELY EXCLUDED (do not add here): the DB/Plaid dev harnesses
 *   scripts/test-visibility-two-user-space.ts (+ .impl.ts) and
 *   scripts/reset-chase-history-test.ts. They are named `test-*.ts` (not
 *   `*.test.ts`), require a live Postgres / Plaid, and are not unit tests.
 *   The glob below never matches them; keep it that way.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
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

console.log(`run-tests: running ${files.length} test file(s)\n`);

type Failure = { file: string; output: string };
const failures: Failure[] = [];

for (const file of files) {
  const result = spawnSync(TSX_BIN, ["--require", PRELOAD, file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const ok = result.status === 0;
  console.log(`  ${ok ? "✓" : "✗"} ${file}`);
  if (!ok) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
    failures.push({ file, output });
  }
}

const passed = files.length - failures.length;
console.log(`\nrun-tests: ${passed}/${files.length} passed.`);

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
