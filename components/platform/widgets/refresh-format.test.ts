/**
 * components/platform/widgets/refresh-format.test.ts  (OPS-2C-2)
 *
 * Honesty guards for the Refresh presentation adapter. Standalone tsx (house
 * pattern). Pure — no React, no fetch, no DB.
 *
 * The five states that must never collapse into one another:
 *   UNOBSERVED (tier "unknown") · ZERO (a real count) · UNAVAILABLE (null) ·
 *   reproducible · indeterminate.
 *
 * Getting any pair confused is how an empty ledger comes to read as a healthy
 * platform, which is the single most damaging thing this workspace could do.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  UNAVAILABLE,
  describeWindow,
  formatDuration,
  formatNullable,
  humanizeToken,
  isUnobserved,
  ratio,
  summaryLine,
  tallyEntries,
} from "@/components/platform/widgets/refresh-format";
import type { ProjectionEnvelope } from "@/lib/platform/refresh/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const env = (over: Partial<ProjectionEnvelope> = {}): ProjectionEnvelope => ({
  window: { from: "2026-07-01", to: "2026-07-20" },
  deterministic: true,
  indeterminacyReason: null,
  checkedAt: "2026-07-24T00:00:00.000Z",
  ...over,
});

function main() {
  // ── unobserved ≠ zero ──────────────────────────────────────────────────────────
  console.log("honesty · unobserved is not zero, and not healthy");
  {
    check('tier "unknown" is unobserved', isUnobserved("unknown") === true);
    check('tier "observed" is NOT unobserved', isUnobserved("observed") === false);
    check('tier "derived" is NOT unobserved', isUnobserved("derived") === false);
    check('tier "incomplete" is NOT unobserved', isUnobserved("incomplete") === false);

    check(
      "an unobserved projection yields NO summary line (caller must render the empty state)",
      summaryLine("unknown", ["3 executions"]) === null,
    );
    check(
      "an observed projection yields its line, including real zeros",
      summaryLine("observed", ["0 executions", "0 failed"]) === "0 executions · 0 failed",
    );
  }

  // ── null ≠ zero ────────────────────────────────────────────────────────────────
  console.log("honesty · unavailable is not zero");
  {
    check("null renders as the em-dash, never 0", formatNullable(null) === UNAVAILABLE);
    check("undefined renders as the em-dash", formatNullable(undefined) === UNAVAILABLE);
    check("a REAL zero renders as 0", formatNullable(0) === "0");
    check("a real number renders", formatNullable(42) === "42");

    check("null duration is the em-dash, never 0ms", formatDuration(null) === UNAVAILABLE);
    check("a real 0ms renders as 0ms", formatDuration(0) === "0ms");
    check("sub-second renders in ms", formatDuration(850) === "850ms");
    check("seconds render with one decimal", formatDuration(12_000) === "12.0s");
    check("minutes round", formatDuration(180_000) === "3m");
  }

  // ── percentages ────────────────────────────────────────────────────────────────
  console.log("honesty · no percentage without a denominator");
  {
    check("0 of 0 yields NULL, never 0%", ratio(0, 0) === null);
    check("a negative denominator yields null", ratio(1, -1) === null);
    check("a REAL zero numerator over a real denominator IS 0%", ratio(0, 4) === 0);
    check("3 of 4 is 75%", ratio(3, 4) === 75);
    check("4 of 4 is 100%", ratio(4, 4) === 100);
  }

  // ── window determinism ─────────────────────────────────────────────────────────
  console.log("honesty · indeterminacy stays visible");
  {
    const closed = describeWindow(env());
    check("a closed window reports reproducible", closed.reproducible === true);
    check("...and says why", closed.detail.includes("closed window"));
    check("window range is rendered", closed.window === "2026-07-01 → 2026-07-20");

    const open = describeWindow(
      env({ deterministic: false, indeterminacyReason: "window is open — it ends 2026-07-24" }),
    );
    check("an open window is NOT reproducible", open.reproducible === false);
    check(
      "the projection's own reason is surfaced VERBATIM, not reduced to a badge",
      open.detail === "window is open — it ends 2026-07-24",
    );

    const noReason = describeWindow(env({ deterministic: false, indeterminacyReason: null }));
    check(
      "a missing reason still never claims reproducibility",
      noReason.reproducible === false && noReason.detail === "not reproducible",
    );
  }

  // ── tallies ────────────────────────────────────────────────────────────────────
  console.log("tallies preserve the projection's order");
  {
    const entries = tallyEntries({ FAILED: 2, PARTIAL: 1, SUCCEEDED: 7 });
    check("every key survives", entries.length === 3);
    check(
      "key order is preserved from the projection (already stable there)",
      entries.map((e) => e.key).join() === "FAILED,PARTIAL,SUCCEEDED",
    );
    check("counts are carried through unchanged", entries.find((e) => e.key === "SUCCEEDED")?.count === 7);
    check("an empty tally yields no rows", tallyEntries({}).length === 0);
  }

  // ── token humanisation invents no meaning ──────────────────────────────────────
  console.log("humanisation adds no semantics");
  {
    check("ACCOUNT_DISCONNECTED → Account disconnected", humanizeToken("ACCOUNT_DISCONNECTED") === "Account disconnected");
    check("NO_HOLDINGS → No holdings", humanizeToken("NO_HOLDINGS") === "No holdings");
    check("an unknown token still renders (never crashes, never renamed)", humanizeToken("SOME_FUTURE_REASON") === "Some future reason");
  }

  // ── boundary: the adapter is presentation only ─────────────────────────────────
  console.log("doctrine · the adapter computes no truth");
  {
    const strip = (p: string) =>
      readFileSync(path.join(process.cwd(), p), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const src = strip("components/platform/widgets/refresh-format.ts");

    check("no db import", !/@\/lib\/db/.test(src));
    check("no projection import", !/refresh\/projections|execution-query(?!-core)/.test(src));
    check("no fetch", !/fetch\(/.test(src));
    check("no React", !/from "react"/.test(src));
    check("type-only imports from the contract module", !/import\s+\{[^}]*\}\s+from\s+"@\/lib\/platform\/refresh\/types"/.test(src));
    check("no OPS-2D vocabulary", !/mayRun|admission|pausedUntil|JobControlState|maintenanceMode/i.test(src));
  }

  if (failures > 0) {
    console.error(`\nrefresh-format.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nrefresh-format.test: all passed.");
}

main();
