/**
 * lib/atlas/palette-ratchet.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1). BASELINE MODE.
 *
 * Prevents NEW raw-palette usage in dashboard component directories while
 * allowing the known legacy files to be burned down during Step B. It fails
 * only if a tracked file's violation count GROWS, or a NEW violating file
 * appears. On first run (no baseline file) it records the current reality and
 * passes, so it is green on day one and cannot wedge CI.
 *
 * See docs/investigations/ATLAS_GLASS_UNIFICATION_STEP_A_CHECKLIST.md §7.
 *
 * Run:  npx tsx lib/atlas/palette-ratchet.test.ts
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["components/dashboard", "components/space", "components/atlas"];
const BASELINE = "lib/atlas/palette-ratchet.baseline.json";

// Card.tsx is intentionally allowlisted (retired in Step B); charts/admin are
// out of the initial scan by directory selection above.
const ALLOWLIST_FILES = new Set<string>(["components/ui/Card.tsx"]);

const PATTERNS: RegExp[] = [
  /\bbg-gray-\d{2,3}\b/g,
  /\bborder-gray-\d{2,3}\b/g,
  /\btext-gray-\d{2,3}\b/g,
  /\btext-(?:blue|red|emerald|green|violet|yellow|amber|purple)-\d{2,3}\b/g,
];

function walk(dir: string, acc: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return acc;
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    const s = statSync(join(ROOT, rel));
    if (s.isDirectory()) walk(rel, acc);
    else if (/\.(tsx?|jsx?)$/.test(name)) acc.push(rel);
  }
  return acc;
}

function countViolations(file: string): number {
  const text = readFileSync(join(ROOT, file), "utf8");
  let n = 0;
  for (const re of PATTERNS) n += (text.match(re) ?? []).length;
  return n;
}

const current: Record<string, number> = {};
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    if (ALLOWLIST_FILES.has(file)) continue;
    const n = countViolations(file);
    if (n > 0) current[file] = n;
  }
}

const baselinePath = join(ROOT, BASELINE);

if (!existsSync(baselinePath)) {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
  console.log(
    `[palette-ratchet] baseline created — ${Object.keys(current).length} files, ` +
      `${Object.values(current).reduce((a, b) => a + b, 0)} violations recorded. PASS.`
  );
  process.exit(0);
}

const baseline: Record<string, number> = JSON.parse(
  readFileSync(baselinePath, "utf8")
);

const failures: string[] = [];
for (const [file, n] of Object.entries(current)) {
  if (!(file in baseline)) {
    failures.push(`${file}: new violating file (${n})`);
  } else if (n > baseline[file]) {
    failures.push(`${file}: ${baseline[file]} → ${n} (increased)`);
  }
}

// --update: ratchet the baseline DOWN. Rewrites the baseline to the current
// counts (files at 0 disappear, decreased files drop), but only after the same
// no-increase check as check mode — it refuses to write if any count grew.
const UPDATE = process.argv.includes("--update");

if (UPDATE) {
  if (failures.length) {
    console.error(
      "[palette-ratchet] REFUSING to update — counts increased:\n" +
        failures.map((f) => "  " + f).join("\n")
    );
    process.exit(1);
  }
  const cleared = Object.keys(baseline).filter((f) => !(f in current)).length;
  const lowered = Object.keys(current).filter(
    (f) => f in baseline && current[f] < baseline[f]
  ).length;
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
  console.log(
    `[palette-ratchet] baseline updated — ${cleared} file(s) cleared, ` +
      `${lowered} lowered, ${Object.keys(current).length} tracked.`
  );
  process.exit(0);
}

if (failures.length) {
  console.error(
    "[palette-ratchet] FAIL — raw palette grew:\n" +
      failures.map((f) => "  " + f).join("\n") +
      "\nMigrate to Atlas tokens (var(--text-*/--surface-*/--accent-*)) instead of raw gray/color classes."
  );
  process.exit(1);
}

console.log(
  `[palette-ratchet] OK — no new raw-palette usage (${Object.keys(current).length} tracked files).`
);
process.exit(0);
