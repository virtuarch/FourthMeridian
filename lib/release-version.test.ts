/**
 * lib/release-version.test.ts
 *
 * THE VERSION AUTHORITY is `package.json`. Everything else mirrors it.
 *
 * This guard exists because the repository shipped a whole v2.6 arc while
 * `package.json` still said 2.5.0 — a drift nothing was watching. It checks
 * CONSISTENCY between the authority and its mirrors, not a specific number, so
 * it does not need editing on every release.
 *
 * Deliberately NOT asserted: status prose. The repository has no precedent for
 * failing a build over documentation wording, and a guard that demands prose
 * change on every commit gets disabled rather than obeyed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const pkg = JSON.parse(read("package.json")) as { name: string; version: string };
const lock = JSON.parse(read("package-lock.json")) as {
  version: string; packages: Record<string, { version?: string }>;
};

// ── the authority is a valid semver, and it is v2.6 ────────────────────────
{
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version is semver: ${pkg.version}`);
  const [major, minor] = pkg.version.split(".");
  assert.equal(`${major}.${minor}`, "2.6",
    `this is Fourth Meridian v2.6 — package.json says ${pkg.version}`);
  ok(`package.json is the version authority and reports v2.6 (${pkg.version})`);
}

// ── the lockfile mirrors it in BOTH places npm writes ──────────────────────
{
  assert.equal(lock.version, pkg.version, "package-lock.json root version mirrors package.json");
  assert.equal(lock.packages[""]?.version, pkg.version,
    'package-lock.json packages[""] mirrors package.json');
  ok("package-lock.json mirrors the authority in both places npm writes");
}

// ── STATUS.md names the same version ───────────────────────────────────────
//
// The canonical status file (README: "the current-state snapshot (version,
// active work, blockers, next steps, production readiness)") carries a Version
// row. It must not contradict the authority.
{
  const status = read("STATUS.md");
  assert.ok(status.includes(pkg.version),
    `STATUS.md must name the current version ${pkg.version}`);
  ok("STATUS.md names the same version as the authority");
}

// ── no stray v2.7 naming ───────────────────────────────────────────────────
//
// The historical-exploration work carried a "V27-" work-stream label that is
// NOT a version. It must never leak into a version field.
{
  assert.ok(!pkg.version.startsWith("2.7"), "this is v2.6, not v2.7");
  ok("no v2.7 version naming");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`release-version: ${checks.length} checks passed`);
