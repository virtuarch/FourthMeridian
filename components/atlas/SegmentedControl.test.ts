/**
 * components/atlas/SegmentedControl.test.ts
 *
 * SHELL_NAV S3/S6 — SegmentedControl is a widely-shared primitive (six real
 * consumers). This slice added an OPTIONAL icon slot; the top correctness bar is
 * that the five consumers which pass no icon are byte-identical. Source-scan
 * contract (house convention, no RTL):
 *   - the option type's icon is optional (icon?: ReactNode),
 *   - a segment renders its icon ONLY when present, and otherwise renders its
 *     bare label exactly as before (the label-only path is unchanged),
 *   - the decorative glyph carries aria-hidden (the visible label is the a11y name),
 *   - the primitive gained NO positioning/scroll logic (stop condition #5) — the
 *     floating/shrink behavior lives in FloatingNavWrapper, not here.
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
  console.log("icon slot is additive and optional");
  check("SegmentedControlOption gains icon?: ReactNode", /icon\?\s*:\s*ReactNode/.test(src));
  check("ReactNode is imported as a type", /type ReactNode/.test(src));

  console.log("label-only path is byte-identical (icon absent → bare label)");
  check("renders icon only when present (opt.icon != null ?)", /opt\.icon\s*!=\s*null\s*\?/.test(src));
  check("non-collapsed label resolves to the bare opt.label", /:\s*opt\.label;/.test(src));

  console.log("decorative glyph is hidden from assistive tech");
  check("icon wrapper is aria-hidden", /aria-hidden[^>]*>\{opt\.icon\}/.test(src));

  console.log("primitive stays plain — no positioning/scroll logic (stop condition #5)");
  check("no sticky/fixed positioning in the primitive", !/position:\s*(sticky|fixed)|\bsticky\b|\bfixed\b/.test(src));
  check("does not consume the scroll-shrink hook", !/useScrollShrink/.test(src));
  check("does not read scrollY / attach scroll listeners", !/scrollY|addEventListener\(\s*["']scroll/.test(src));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll SegmentedControl checks passed");
}

main();
