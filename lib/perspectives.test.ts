/**
 * lib/perspectives.test.ts
 *
 * Perspective library guards — the lens-backing invariants introduced in
 * Perspective Engine commit 5 (investigation §6.9), plus the pre-existing
 * conventions the library relies on hosts honoring.
 *
 * Standalone tsx script (house pattern — no jest/vitest, mirrors
 * lib/space-nav.test.ts):
 *
 *     npx tsx lib/perspectives.test.ts
 *
 * Run from the repo root (the lens-module scan resolves paths from cwd).
 * Exits 0 when all cases pass and 1 on failure.
 *
 * Invariants:
 *   1. Lens-backed entries can never be comingSoon — an entry with a lensId
 *      must be status "available". A computed answer cannot be "Soon".
 *   2. Every lensId has a real, registered lens module at
 *      lib/perspective-engine/lenses/<lensId>.ts (checked by source scan —
 *      importing the lens modules here would pull the data layer/Prisma
 *      into a pure config test).
 *   3. Lens-backed entries never leak into the composition switcher —
 *      exactly one navigation path per feature (the library's own rule).
 *   4. Category lists only reference library ids, and every lens-backed
 *      entry is reachable from at least one category.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  PERSPECTIVE_LIBRARY,
  getCompositionSwitcherItems,
  getPerspectivesForCategory,
} from "./perspectives";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Categories exercised — superset of PERSPECTIVES_BY_CATEGORY's keys plus an
// unknown one to cover the DEFAULT_PERSPECTIVES fallback path.
const CATEGORIES = [
  "PERSONAL", "HOUSEHOLD", "FAMILY", "RETIREMENT", "INVESTMENT", "PROPERTY",
  "VEHICLE", "BUSINESS", "DEBT_PAYOFF", "EMERGENCY_FUND", "GOAL", "TRIP",
  "EQUIPMENT", "CUSTOM", "OTHER", "SOME_FUTURE_CATEGORY",
];

function main(): void {
  const entries = Object.values(PERSPECTIVE_LIBRARY);
  const lensBacked = entries.filter((p) => p.lensId !== undefined);

  console.log("1. Lens-backed entries can never be comingSoon");
  check("at least one lens-backed entry exists (liquidity, debt)",
    lensBacked.some((p) => p.id === "liquidity") && lensBacked.some((p) => p.id === "debt"));
  for (const p of lensBacked) {
    check(`"${p.id}" (lensId: ${p.lensId}) is status "available"`, p.status === "available");
  }

  console.log("2. Every lensId has a registered lens module");
  for (const p of lensBacked) {
    let src = "";
    try {
      src = readFileSync(
        join(process.cwd(), "lib", "perspective-engine", "lenses", `${p.lensId}.ts`),
        "utf8",
      );
    } catch {
      /* missing file fails the check below */
    }
    check(`lenses/${p.lensId}.ts exists and calls registerLens("${p.lensId}", …)`,
      new RegExp(`registerLens\\(\\s*["']${p.lensId}["']`).test(src));
  }

  console.log("3. One navigation path — lens-backed entries stay out of the composition switcher");
  for (const cat of CATEGORIES) {
    const leaked = getCompositionSwitcherItems(cat).filter((p) => p.lensId !== undefined);
    check(`${cat}: switcher has no lens-backed entries`,
      leaked.length === 0, leaked.map((p) => p.id).join(", "));
  }

  console.log("4. Category lists are library-consistent and lens entries are reachable");
  const reachable = new Set<string>();
  for (const cat of CATEGORIES) {
    const defs = getPerspectivesForCategory(cat);
    check(`${cat}: every id resolves to a library entry`,
      defs.every((d) => d && PERSPECTIVE_LIBRARY[d.id] === d));
    defs.forEach((d) => reachable.add(d.id));
  }
  for (const p of lensBacked) {
    check(`lens-backed "${p.id}" is reachable from at least one category`, reachable.has(p.id));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll perspective library guards passed.");
  process.exit(0);
}

main();
