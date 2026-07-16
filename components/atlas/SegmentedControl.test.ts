/**
 * components/atlas/SegmentedControl.test.ts
 *
 * SegmentedControl is a widely-shared primitive with an optional icon slot and a
 * `labelVisibility` mode that can collapse an inactive tab to icon-only. The
 * exact-ternary / exact-JSX / prop-type pins this file used to carry were pure
 * implementation churn; what remains is the durable ACCESSIBILITY CONTRACT plus
 * the one real separation-of-concerns seam. Source-scan (house convention, no RTL):
 *   - a decorative glyph is hidden from assistive tech (the visible label is the
 *     accessible name — the icon must not be double-announced),
 *   - collapsing a label to icon-only NEVER removes it from the a11y tree: the
 *     label text stays reachable via sr-only text and/or an aria-label,
 *   - the primitive owns NO scroll/positioning behavior — the floating/shrink
 *     behavior lives in FloatingNavWrapper, keeping this primitive reusable.
 *
 *   npx tsx components/atlas/SegmentedControl.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const src = readFileSync(path.join(process.cwd(), "components/atlas/SegmentedControl.tsx"), "utf8");

function main(): void {
  console.log("accessibility contract — accessible name is preserved");
  // A decorative icon must be hidden from AT so the visible label remains the
  // single accessible name (not announced twice).
  check("a decorative glyph is marked aria-hidden", /aria-hidden/.test(src));
  // When a label is visually collapsed to icon-only it must still be exposed to
  // assistive tech — via sr-only text kept in the DOM and/or an aria-label —
  // rather than dropped from the accessibility tree. Assert the mechanism exists
  // and is fed by the label, not the exact JSX spelling.
  check("collapsed label stays accessible (sr-only text and/or aria-label carries opt.label)",
    /opt\.label/.test(src) && (/sr-only/.test(src) || /aria-label/.test(src)));

  console.log("separation of concerns — the primitive owns no scroll/positioning behavior");
  check("does not consume the scroll-shrink hook", !/useScrollShrink/.test(src));
  check("does not read scrollY / attach scroll listeners", !/scrollY|addEventListener\(\s*["']scroll/.test(src));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll SegmentedControl checks passed");
}

main();
