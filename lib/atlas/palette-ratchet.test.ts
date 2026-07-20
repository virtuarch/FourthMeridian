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
const BASELINE = "lib/atlas/palette-ratchet.baseline.json";

/**
 * V25-CLOSE-2 — SCAN THE WHOLE RENDERED SURFACE, not three directories.
 *
 * Before this slice the fence covered components/{dashboard,space,atlas} only,
 * so raw palette could accumulate freely in components/{ui,charts,security,
 * notifications,admin} and in every route under app/. Both roots are scanned
 * now; the exclusions below are the only carve-outs and each states its reason.
 *
 * Everything under these roots is product UI, an Atlas consumer, or a
 * visualization component — the three things this ratchet exists to protect.
 * `lib/` is deliberately NOT scanned: it holds no JSX, and design tokens that
 * legitimately carry raw colour values (lib/charts/chart-palette.ts) live there.
 */
const SCAN_ROOTS = ["components", "app"];

/**
 * Excluded subtrees. Kept tiny and justified — an exclusion is a place drift can
 * hide, so each one must earn itself.
 */
const EXCLUDED_PREFIXES: { prefix: string; why: string }[] = [
  {
    prefix: "components/atlas/vendor/",
    why: "Vendored third-party source (see components/atlas/vendor/*/VENDORED.md), kept pristine and not subject to our design rules. eslint.config.mjs excludes it for the same reason.",
  },
  {
    prefix: "app/prototype/",
    why: "Design harnesses, untracked and non-shipping (V25-CLOSE-1 containment). Scanning them would put machine-local files in a shared baseline, so the guard would fail for anyone who does not have them.",
  },
];

/**
 * Per-file allowlist. Empty by design: baseline mode already tolerates existing
 * violations file-by-file, so a blanket allowlist would only hide growth.
 */
const ALLOWLIST_FILES = new Set<string>([]);

/**
 * Forbidden raw-palette patterns.
 *
 * V25-CLOSE-2 closed a hole here as well: `text-{colour}` was matched but
 * `bg-{colour}` / `border-{colour}` were matched for gray ONLY. That is why the
 * baseline read `{}` while `bg-blue-500` and friends sat in already-scanned
 * files — the fence looked clean because it was not looking. Backgrounds and
 * borders now carry the same colour list as text.
 *
 * Deliberately NOT matched: raw hex / rgb(). Chart token modules legitimately
 * define colour values, and matching hex would need its own burn-down with a
 * real exemption story. Recorded as follow-up rather than half-enforced here.
 */
const COLOURS = "blue|red|emerald|green|violet|yellow|amber|purple";
const PATTERNS: RegExp[] = [
  /\bbg-gray-\d{2,3}\b/g,
  /\bborder-gray-\d{2,3}\b/g,
  /\btext-gray-\d{2,3}\b/g,
  new RegExp(`\\btext-(?:${COLOURS})-\\d{2,3}\\b`, "g"),
  new RegExp(`\\bbg-(?:${COLOURS})-\\d{2,3}\\b`, "g"),
  new RegExp(`\\bborder-(?:${COLOURS})-\\d{2,3}\\b`, "g"),
];

function isExcluded(rel: string): boolean {
  return EXCLUDED_PREFIXES.some((e) => rel.startsWith(e.prefix));
}

function walk(dir: string, acc: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return acc;
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    if (isExcluded(`${rel}/`) || isExcluded(rel)) continue;
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
for (const dir of SCAN_ROOTS) {
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
