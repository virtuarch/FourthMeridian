/**
 * components/platform/widgets/cs-rollup.test.ts  (BETA · Workstream W4 — CS per-user roll-up)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/cs-rollup.test.ts
 *
 * Pinned:
 *   1. every column word renders whether or not the field arrived; absence is a dash, never 0
 *   2. a present field renders its value (count, $ estimate, relative time, stage words)
 *   3. the widget renders the roll-up on every list row from the pure view, with one mount clock
 *   4. username-first identity is untouched; the widget still imports no server module
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { ROLLUP_ABSENT, rollupAbsent, rollupCells, rollupLine } from "./cs-rollup-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const WORDS = ["AI turns 30 d", "est. USD", "Items", "last engaged", "stage"];

console.log("1. absence");
{
  const cells = rollupCells({}, NOW);
  check("five cells, in the design's order", cells.map((c) => c.word).join("|") === WORDS.join("|"), cells.map((c) => c.word).join("|"));
  check("every absent field is a dash", cells.every((c) => c.value === ROLLUP_ABSENT && c.absent));
  check("rollupAbsent is true when nothing arrived", rollupAbsent({}) && !rollupAbsent({ aiTurns30d: 0 }));
  check("null is absent too (unpriced / never), never 0", rollupCells({ aiEstimatedUsd30d: null, lastEngagedAt: null }, NOW).every((c) => c.value === ROLLUP_ABSENT));
}

console.log("2. presence");
{
  const line = rollupLine({ aiTurns30d: 12, aiEstimatedUsd30d: 0.41, plaidItemCount: 2, lastEngagedAt: "2026-10-15T09:00:00.000Z", funnelStage: "FIRST_CONNECTION" }, NOW);
  check("values render in words", line === "AI turns 30 d 12 · est. USD $0.41 · Items 2 · last engaged 3h ago · stage first connection", line);
  check("a zero count is a fact (0), not a dash", rollupCells({ aiTurns30d: 0 }, NOW)[0].value === "0");
}

console.log("3. the widget");
{
  const cs = strip("components/platform/widgets/CsCustomersWidget.tsx");
  check("renders rollupCells on the list row with the mount clock", /rollupCells\(c as CustomerRow, nowMs\)/.test(cs) && /useState\(\(\) => Date\.Now\(\)\)/i.test(cs));
  check("the roll-up fields are OPTIONAL on the row type (compiles before W3 merges)", /type CustomerRow = CustomerListResponse\["customers"\]\[number\] & CustomerRollupFields/.test(cs));
  check("the estimate note is on the surface", /ROLLUP_NOTE/.test(cs));
  check("username-first identity stays", /operatorDisplayName\(c\)/.test(cs) && !/\{c\.email\}/.test(cs));
  check("imports no server module", !/customer-core"|@\/lib\/db|server-only|platform\/customer\/customers"/.test(cs.replace(/import type[^;]+;/g, "")));
  const view = strip("components/platform/widgets/cs-rollup-view.ts");
  check("the view is clock-injected (no Date.now)", !/Date\.now\(/.test(view));
}

if (failures > 0) { console.error(`\ncs-rollup.test: ${failures} failure(s).`); process.exit(1); }
console.log("\ncs-rollup.test: all passed.");
