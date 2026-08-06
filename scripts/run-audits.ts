/**
 * scripts/run-audits.ts
 *
 * v2.6-OWN-2 — the architecture-audit runner. This is what CI executes.
 *
 *   npx tsx scripts/run-audits.ts               # REQUIRED tier — the CI gate
 *   npx tsx scripts/run-audits.ts --tier=all    # REQUIRED + INFORMATIONAL
 *   npx tsx scripts/run-audits.ts --list        # the inventory, no execution
 *   npx tsx scripts/run-audits.ts --only=audit-flow-desync[,…]
 *
 * ── What it guarantees ──────────────────────────────────────────────────────
 *
 *  · Every REQUIRED audit RUNS. A registry entry with no script on disk is a
 *    failure, not a silent skip — a deleted audit must be deliberately retired,
 *    never quietly dropped.
 *  · Every script on disk is CLASSIFIED. A new scripts/audit-*.ts that nobody
 *    registered fails the run, so an invariant cannot be written and then left
 *    outside the gate. That is precisely how eleven audits ended up unexecuted.
 *  · The exit code is the union: any REQUIRED failure fails the process.
 *    INFORMATIONAL results are reported and NEVER affect it.
 *
 * ── Environment ─────────────────────────────────────────────────────────────
 *
 * The audits used to disagree about their own environment: some npm scripts
 * carried `--env-file=.env.local`, some did not, so half the suite failed with
 * "Environment variable not found: DATABASE_URL" on first invocation. The runner
 * owns this now — it requires DATABASE_URL to be present in the environment and
 * passes it through, so a script never needs to know where it came from. Locally
 * that means `npm run audit` (which supplies --env-file); in CI the service
 * container exports it directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AUDITS, REQUIRED_AUDITS, type AuditEntry, type AuditTier } from "./audit-registry";

const argv = process.argv.slice(2);
const flag = (n: string): string | null => argv.find((a) => a.startsWith(`${n}=`))?.split("=")[1] ?? null;

const LIST = argv.includes("--list");
const TIER = (flag("--tier") ?? "required").toLowerCase();
const ONLY = flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

const SCRIPTS_DIR = join(process.cwd(), "scripts");
const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

/** This runner's own infrastructure — audit-shaped names, not audits. */
const INFRASTRUCTURE = new Set(["audit-registry"]);

/** Every audit-shaped script actually on disk. */
function scriptsOnDisk(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /^(audit|check|verify)-/.test(f))
    .map((f) => f.replace(/\.ts$/, ""))
    .filter((n) => !INFRASTRUCTURE.has(n))
    .sort();
}

function printInventory(): void {
  const byTier: Record<AuditTier, AuditEntry[]> = {
    REQUIRED: [], INFORMATIONAL: [], RETIRED: [],
  };
  for (const a of AUDITS) byTier[a.tier].push(a);
  for (const tier of ["REQUIRED", "INFORMATIONAL", "RETIRED"] as const) {
    bar(`${tier} — ${byTier[tier].length}`);
    for (const a of byTier[tier]) {
      console.log(`  ${a.name}`);
      console.log(`      ${a.what}`);
      if (a.retiredBecause) console.log(`      RETIRED: ${a.retiredBecause}`);
    }
  }
}

interface Result { entry: AuditEntry; code: number; ms: number }

function run(entry: AuditEntry): Result {
  const started = Date.now();
  const r = spawnSync("npx", ["tsx", `scripts/${entry.name}.ts`], {
    stdio: "inherit",
    env: process.env,
  });
  return { entry, code: r.status ?? 1, ms: Date.now() - started };
}

function main(): void {
  if (LIST) { printInventory(); return; }

  // ── Registry ↔ disk reconciliation ────────────────────────────────────────
  // Both directions. An unregistered script is the failure mode this runner
  // exists to prevent; a registered-but-missing script means a gate vanished.
  const disk = new Set(scriptsOnDisk());
  const registered = new Set(AUDITS.map((a) => a.name));
  const unregistered = [...disk].filter((n) => !registered.has(n));
  const missing = AUDITS.filter((a) => !existsSync(join(SCRIPTS_DIR, `${a.name}.ts`)));

  if (unregistered.length > 0 || missing.length > 0) {
    bar("REGISTRY ↔ DISK MISMATCH");
    for (const n of unregistered) {
      console.error(`  ✗ scripts/${n}.ts exists but is not classified in scripts/audit-registry.ts`);
    }
    for (const a of missing) {
      console.error(`  ✗ ${a.name} is registered as ${a.tier} but no script exists`);
    }
    console.error(
      "\n[AUDITS] FAILED — the inventory and the filesystem disagree.\n" +
      "Classify the script (REQUIRED / INFORMATIONAL / RETIRED) or remove its entry.\n" +
      "An audit outside the registry is an audit outside the gate, which is exactly how\n" +
      "eleven of these ended up never running.\n",
    );
    process.exitCode = 1;
    return;
  }

  const selected = (ONLY
    ? AUDITS.filter((a) => ONLY.includes(a.name))
    : TIER === "all"
      ? AUDITS.filter((a) => a.tier !== "RETIRED")
      : REQUIRED_AUDITS
  );

  if (ONLY) {
    const unknown = ONLY.filter((n) => !registered.has(n));
    if (unknown.length > 0) {
      console.error(`[AUDITS] unknown audit(s): ${unknown.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  if (selected.some((a) => a.needsDb) && !process.env.DATABASE_URL) {
    console.error(
      "[AUDITS] DATABASE_URL is not set.\n" +
      "These audits measure a corpus; without one there is nothing to assert.\n" +
      "Locally: npm run audit   (supplies --env-file=.env.local)\n",
    );
    process.exitCode = 1;
    return;
  }

  bar(`ARCHITECTURE AUDITS — ${selected.length} selected (tier=${ONLY ? "explicit" : TIER})`);
  const results: Result[] = [];
  for (const entry of selected) {
    bar(`▶ ${entry.name}   [${entry.tier}]`);
    results.push(run(entry));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  bar("SUMMARY");
  let requiredFailures = 0;
  for (const { entry, code, ms } of results) {
    const ok = code === 0;
    if (!ok && entry.tier === "REQUIRED") requiredFailures++;
    const mark = ok ? "✓" : entry.tier === "REQUIRED" ? "✗" : "⚠";
    const note = ok ? "" : entry.tier === "REQUIRED" ? "  FAILED" : "  non-zero (informational — does not gate)";
    console.log(`  ${mark} ${entry.name.padEnd(44)} ${String(ms).padStart(6)}ms  [${entry.tier}]${note}`);
  }

  if (requiredFailures > 0) {
    console.error(
      `\n[AUDITS] FAILED — ${requiredFailures} required architecture invariant(s) breached.\n` +
      "Each one above printed the specific statement that no longer holds. These are\n" +
      "properties of the system, not of this corpus: fix the code, never the audit.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\n[AUDITS] PASSED — ${results.length} audit(s), every required invariant holds. ✓\n`);
}

main();
