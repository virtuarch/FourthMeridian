/**
 * scripts/audit-brief-assessment-parity.test.ts
 *
 * WIRING PIN for the parity instrument (W3 acceptance repair).
 *
 * ── What broke, and what this pins ──────────────────────────────────────────
 *
 * Assembler registration is a SIDE-EFFECT of module load. W3 extended the
 * parity audit with ACCOUNTS arms (`getAssembler(FinanceDomains.ACCOUNTS)`)
 * while the script's import graph still loaded only ./transactions — so the
 * audit refused at startup on its first real run:
 *   "✗ ACCOUNTS assembler is not registered."
 * tsc was green the whole time: a missing side-effect import is wiring, not a
 * type, and `noUncheckedSideEffectImports` is off (the W2-documented trap).
 *
 * So this pin is BEHAVIORAL, not a source scan: it spawns the actual audit
 * script through the same preload the npm script wires, and asserts the
 * registration gate passes — i.e. the script's OWN import graph executed the
 * ACCOUNTS and TRANSACTIONS registrations. It fails if anyone narrows the
 * barrel import back to individual modules, drops './accounts' from the
 * barrel, or breaks the server-only preload chain.
 *
 * ── Why no database is touched ──────────────────────────────────────────────
 *
 * The registration gate runs BEFORE the first query. DATABASE_URL is
 * overridden with an unreachable dummy (connect_timeout=1), so the child can
 * never read a real corpus regardless of the parent environment; it prints the
 * gate result, then dies on the dummy connection. Exit code is deliberately
 * ignored — only the gate output is asserted.
 *
 * House-style standalone tsx test: exits 0 on pass / 1 on failure.
 * Run:  npx tsx scripts/audit-brief-assessment-parity.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); return; }
  failures.push(name);
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
}

console.log("\n[TEST] parity-instrument wiring pin — registration gate must pass\n");

const r = spawnSync(
  path.join(ROOT, "node_modules", ".bin", "tsx"),
  [
    "--require", path.join(ROOT, "scripts", "lib", "server-only-preload.cjs"),
    path.join(ROOT, "scripts", "audit-brief-assessment-parity.ts"),
  ],
  {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      // Unreachable on purpose: the registration gate precedes the first query,
      // and this guarantees the pin never reads a real corpus.
      DATABASE_URL:
        "postgresql://wiring:pin@127.0.0.1:9/wiring_pin?connect_timeout=1",
    },
  },
);

const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;

check(
  "the audit script starts (import graph loads under the server-only preload)",
  out.includes("[AUDIT] Brief → computeAssessment parity"),
  r.error ? String(r.error) : out.slice(0, 600),
);
check(
  "no assembler registration refusal — ACCOUNTS and TRANSACTIONS both register from the script's own import graph",
  !out.includes("assembler is not registered"),
  out.split("\n").filter((l) => l.includes("assembler is not registered")).join("\n      "),
);

console.log(`\n[TEST] ${failures.length === 0 ? `PASSED — ${passed} checks` : `FAILED — ${failures.length} failure(s)`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
