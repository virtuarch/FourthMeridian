/**
 * components/atlas/FloatingNavWrapper.test.ts
 *
 * SHELL_NAV S4/S5/S6 — source-scan contract for the floating-pill wrapper.
 *   - centers its child (flex + justify-center),
 *   - floats via position: sticky at a configurable top, under the z-40 header,
 *   - adds NO background of its own (the wrapped SegmentedControl supplies the
 *     glass material — keeps the primitive reusable, stop condition #5),
 *   - consumes useScrollShrink and applies it as a CSS transform whose animated
 *     tween rides the global transition (so prefers-reduced-motion is inherited,
 *     no bespoke JS branch / animation loop),
 *   - exports the coordinated stacking offsets used by the two call sites.
 *
 *   npx tsx components/atlas/FloatingNavWrapper.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  APP_HEADER_H, PILL_H, RAIL_PILL_TOP, PERSPECTIVE_PILL_TOP,
} from "./FloatingNavWrapper";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const src = readFileSync(path.join(process.cwd(), "components/atlas/FloatingNavWrapper.tsx"), "utf8");

function main(): void {
  console.log("centered + floating (sticky) positioning");
  check("sticky positioning", /\bsticky\b/.test(src));
  check("centers its child", /flex\s+justify-center|justify-center/.test(src));
  check("z-index below the z-40 header", /z-30/.test(src));
  check("pins at a configurable top", /style=\{\{\s*top\s*\}\}/.test(src));

  console.log("adds no background of its own (child supplies the glass)");
  check("no background/backdrop declared in the wrapper", !/background:|backdropFilter|backdrop-blur|--glass/.test(src));

  console.log("consumes the scroll-shrink hook via a CSS transform tween");
  check("imports + calls useScrollShrink", /useScrollShrink/.test(src));
  check("applies a scale transform", /transform:\s*scale\s*===\s*1\s*\?\s*undefined\s*:\s*`scale\(\$\{scale\}\)`/.test(src));
  check("tween rides the global transition var (reduced-motion inherited)", /transition:\s*"transform var\(--dur-base\)/.test(src));
  check("no JS animation loop (no rAF/setInterval here)", !/requestAnimationFrame|setInterval/.test(src));

  console.log("coordinated stacking offsets are exported and non-overlapping");
  check("APP_HEADER_H matches the h-14 header", APP_HEADER_H === 56);
  check("rail pill pins at the header height", RAIL_PILL_TOP === APP_HEADER_H);
  check("perspective pill pins strictly below the pinned rail", PERSPECTIVE_PILL_TOP > APP_HEADER_H + PILL_H);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll FloatingNavWrapper checks passed");
}

main();
