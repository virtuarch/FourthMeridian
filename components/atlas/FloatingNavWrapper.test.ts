/**
 * components/atlas/FloatingNavWrapper.test.ts
 *
 * FloatingNavWrapper — the coordinated stacking offsets it EXPORTS are a runtime
 * layout contract shared by its two call sites: the rail pill and the Perspective
 * pill both pin at the header line, which must stay equal to the header height.
 * The prior CSS-regex pins (sticky / justify-center / z-30 / transform-tween /
 * transition-var / no-background source scans) were implementation churn and were
 * removed — only the exported-constant contract remains, asserted at runtime.
 *
 *   npx tsx components/atlas/FloatingNavWrapper.test.ts
 */

import {
  APP_HEADER_H, PILL_H, RAIL_PILL_TOP, PERSPECTIVE_PILL_TOP,
} from "./FloatingNavWrapper";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  console.log("pinning offsets are exported and sane (runtime layout contract)");
  check("APP_HEADER_H matches the h-14 header", APP_HEADER_H === 56);
  check("PILL_H is a positive pill height", PILL_H > 0);
  check("rail pill pins at the header height", RAIL_PILL_TOP === APP_HEADER_H);
  // Phase 2 §2.3: the rail is static on the Perspectives tab, so the Perspective
  // pill no longer clears a floating rail — it pins at the header line, same as
  // the rail's own offset would be. They never both float on that tab.
  check("perspective pill pins at the header line", PERSPECTIVE_PILL_TOP === APP_HEADER_H);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll FloatingNavWrapper checks passed");
}

main();
