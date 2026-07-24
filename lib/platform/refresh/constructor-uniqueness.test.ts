/**
 * lib/platform/refresh/constructor-uniqueness.test.ts  (OPS-2B′ Part VII)
 *
 * ONE CONSTRUCTOR · ONE OWNERSHIP POINT · MANY CONSUMERS.
 *
 * Every OPS-2B projection must be assembled in exactly one place. Duplicate
 * assembly is how two surfaces come to disagree about the same window — the
 * parallel-authority defect the Financial Truth Spine exists to prevent, applied
 * to operational reads.
 *
 * This guard exists because the first version of OPS-2B ALREADY drifted: three
 * projections counted open executions inline as `overallStatus === "RUNNING"`
 * while `buildRefreshSummary` used `countOpenExecutions` (which also treats a
 * null `completedAt` as open). The same window could therefore report two
 * different `deterministic` verdicts depending on which projection you asked.
 * That is now a single helper — and this test keeps it that way.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (p: string) =>
  readFileSync(path.join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The five OPS-2B projections: pure constructor ↔ its single authority entry point. */
const PROJECTIONS = [
  { name: "Refresh Summary", constructor: "buildRefreshSummary", authority: "getRefreshSummary" },
  { name: "Provider Operation Summary", constructor: "buildProviderOperationSummary", authority: "getProviderOperationSummary" },
  { name: "Coverage Summary", constructor: "buildCoverageSummary", authority: "getCoverageSummary" },
  { name: "Failure Summary", constructor: "buildFailureSummary", authority: "getFailureSummary" },
  { name: "Execution Timeline", constructor: "buildExecutionTimeline", authority: "getExecutionTimeline" },
] as const;

const CORE = "lib/platform/refresh/projections-core.ts";
const AUTHORITY = "lib/platform/refresh/projections.ts";
const SELF = "lib/platform/refresh/constructor-uniqueness.test.ts";
const SCANNED_ROOTS = ["lib", "app", "components"];

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(path.relative(ROOT, full));
  }
  return found;
}

function main() {
  const core = strip(CORE);
  const authority = strip(AUTHORITY);

  console.log("uniqueness · one pure constructor per projection");
  {
    for (const p of PROJECTIONS) {
      const declarations = (core.match(new RegExp(`export function ${p.constructor}\\b`, "g")) ?? []).length;
      check(`${p.name}: exactly one exported constructor (${p.constructor})`, declarations === 1, `found ${declarations}`);
    }
  }

  console.log("uniqueness · one authority entry point per projection");
  {
    for (const p of PROJECTIONS) {
      const entries = (authority.match(new RegExp(`export async function ${p.authority}\\b`, "g")) ?? []).length;
      check(`${p.name}: exactly one authority entry point (${p.authority})`, entries === 1, `found ${entries}`);

      // The authority must CALL its constructor exactly once — a second call site
      // would be a second assembly of the same projection.
      const calls = (authority.match(new RegExp(`\\b${p.constructor}\\(`, "g")) ?? []).length;
      check(`${p.name}: its constructor is invoked exactly once in the authority`, calls === 1, `found ${calls}`);
    }
  }

  console.log("uniqueness · no assembly outside the owning modules");
  {
    const files = SCANNED_ROOTS.flatMap((r) => walk(path.join(ROOT, r)));
    for (const p of PROJECTIONS) {
      const offenders = files.filter((f) => {
        if (f === CORE || f === AUTHORITY || f === SELF) return false;
        if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) return false;
        return new RegExp(`\\b${p.constructor}\\b`).test(strip(f));
      });
      check(
        `${p.name}: assembled nowhere else in the product tree`,
        offenders.length === 0,
        offenders.join(", "),
      );
    }
  }

  console.log("uniqueness · one determinism rule, one window loader");
  {
    // The regression this guard was written for.
    const inlineOpenCounts = (authority.match(/overallStatus\s*===\s*["']RUNNING["']/g) ?? []).length;
    check(
      "the authority never re-implements the open-execution rule inline",
      inlineOpenCounts === 0,
      `found ${inlineOpenCounts} inline occurrence(s)`,
    );
    check("countOpenExecutions is the single open-execution rule", (core.match(/export function countOpenExecutions\b/g) ?? []).length === 1);
    check("the authority derives determinism through one helper", (authority.match(/function envelopeFor\b/g) ?? []).length === 1);
    check("the envelope is built in exactly one place", (authority.match(/function envelope\b/g) ?? []).length === 1);

    // One fact-window loader — every projection starts from the same read.
    check("exactly one execution-window loader", (authority.match(/async function loadExecutionWindow\b/g) ?? []).length === 1);
    const directReads = (authority.match(/readers\.executions\(/g) ?? []).length;
    check(
      "readers.executions() is called from exactly one place (the loader)",
      directReads === 1,
      `found ${directReads}`,
    );
  }

  console.log("uniqueness · the seam assembles no projection");
  {
    const seam = strip("lib/platform/refresh/execution-query.ts");
    for (const p of PROJECTIONS) {
      check(`the row seam does not assemble ${p.name}`, !new RegExp(`\\b${p.constructor}\\b`).test(seam));
    }
  }

  if (failures > 0) {
    console.error(`\nconstructor-uniqueness.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nconstructor-uniqueness.test: all passed.");
}

main();
