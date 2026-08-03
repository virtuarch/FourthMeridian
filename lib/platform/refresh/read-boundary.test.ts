/**
 * lib/platform/refresh/read-boundary.test.ts  (OPS-2B)
 *
 * THE ratchet. It is the reason the rest of OPS-2B holds over time.
 *
 * OPERATIONAL_TRUTH_SPINE.md §G.1 says no operational consumer may query the
 * DF-2 refresh ledger directly — every consumer reads a PROJECTION or the
 * EXECUTION QUERY SEAM, and there is no third path. That is a statement about
 * the whole repository, so only a repository-wide scan can keep it true. A
 * reviewer will not catch the fifth `db.refreshExecution.findMany` in an
 * unrelated PR; this test will.
 *
 * The allowlist below is deliberately small and deliberately annoying to extend:
 * adding a file to it is a doctrine decision, not a convenience.
 *
 * (Operator-run `scripts/` and Prisma migrations are sanctioned direct readers
 * too — they are simply outside the scanned roots, which are the product tree.)
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
/** The product tree. `scripts/` and `prisma/` are sanctioned and not scanned. */
const SCANNED_ROOTS = ["lib", "app", "components"];

/** The four DF-2 ledger models, as Prisma client accessors. */
const LEDGER_ACCESSOR =
  /\.(refreshExecution|refreshEndpointResult|providerCall|refreshEndpointAccountCoverage)\s*\./;

/**
 * The ONLY product-tree files permitted to touch the ledger directly.
 *
 *   writers      — they own the facts (OPERATIONAL_TRUTH_SPINE.md §D.1)
 *   projections  — the aggregate seam
 *   query        — the row seam
 *
 * Anything else is a consumer, and a consumer reads a seam.
 */
const PERMITTED_DIRECT_READERS = new Set<string>([
  "lib/plaid/refresh-execution.ts",
  "lib/plaid/provider-call.ts",
  // V26-STAGE-1 — a WRITER, admitted under the same rule as refresh-execution.ts:
  // it owns the five historical stage facts. It exists separately because those
  // stages must be persisted AS THEY SETTLE to be resumable, whereas
  // refresh-execution.ts flushes its provider stages once at completion — a
  // crash mid-pipeline would otherwise leave nothing to resume to. It writes
  // only RefreshEndpointResult rows and reads only its own.
  "lib/plaid/historical-stage-recorder.ts",
  "lib/platform/refresh/projections.ts",
  "lib/platform/refresh/execution-query.ts",
]);

/** This guard names the models in its own regex/allowlist — never scan itself. */
const SELF = "lib/platform/refresh/read-boundary.test.ts";

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

/** Comments quote model names constantly; only real code counts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function main() {
  const files = SCANNED_ROOTS.flatMap((r) => walk(path.join(ROOT, r)));

  console.log("boundary · direct ledger access");
  {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === SELF) continue;
      // A test may legitimately construct fake ledger rows; it is not a consumer.
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const code = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
      if (LEDGER_ACCESSOR.test(code) && !PERMITTED_DIRECT_READERS.has(file)) offenders.push(file);
    }
    check(
      "no product-tree file outside the allowlist touches the DF-2 ledger",
      offenders.length === 0,
      offenders.length ? `offenders: ${offenders.join(", ")}` : undefined,
    );
  }

  console.log("boundary · the allowlist is honest");
  {
    // Every allowlisted file must still exist AND still actually read the ledger —
    // otherwise the allowlist rots into permission for files that no longer need it.
    for (const permitted of PERMITTED_DIRECT_READERS) {
      let code = "";
      try {
        code = stripComments(readFileSync(path.join(ROOT, permitted), "utf8"));
      } catch {
        check(`allowlisted file exists: ${permitted}`, false, "file not found");
        continue;
      }
      check(`allowlisted file still reads the ledger: ${permitted}`, LEDGER_ACCESSOR.test(code));
    }
  }

  console.log("boundary · the two seams are distinct");
  {
    const projections = stripComments(readFileSync(path.join(ROOT, "lib/platform/refresh/projections.ts"), "utf8"));
    const seam = stripComments(readFileSync(path.join(ROOT, "lib/platform/refresh/execution-query.ts"), "utf8"));

    check("the projection authority does not import the row seam", !/execution-query/.test(projections));
    check("the row seam does not import the projection authority", !/refresh\/projections/.test(seam));
    check(
      "neither seam imports the other's core",
      !/execution-query-core/.test(projections) && !/projections-core/.test(seam),
    );
  }

  console.log("boundary · no writes from either seam");
  {
    for (const file of ["lib/platform/refresh/projections.ts", "lib/platform/refresh/execution-query.ts"]) {
      const code = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
      check(
        `${file} performs no ledger writes`,
        !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(code),
      );
    }
  }

  if (failures > 0) {
    console.error(`\nread-boundary.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nread-boundary.test: all passed.");
}

main();
