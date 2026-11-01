/**
 * components/platform/space-switcher.test.ts  (Platform Spaces 2.0 — switcher placement + sticky header + chart pinning)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/space-switcher.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { placeMenu } from "./PlatformSpaceSwitcher";

let failures = 0;
const check = (name: string, cond: boolean, d?: unknown) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} — ${JSON.stringify(d)}`); } };
const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

console.log("1. the switcher menu stays inside the viewport");
{
  const vp = { width: 390, height: 844 };
  const topLeft = placeMenu({ left: 120, top: 60, bottom: 104 }, vp, { width: 256, height: 240 });
  check("opened from the top-left title: left-aligned to the trigger, fully on screen", topLeft.left === 120 && topLeft.left + 256 <= 390 - 8 && topLeft.top === 108, topLeft);
  const right = placeMenu({ left: 300, top: 60, bottom: 104 }, vp, { width: 256, height: 240 });
  check("near the right edge it shifts left only as far as needed", right.left === 390 - 8 - 256, right);
  const narrow = placeMenu({ left: 0, top: 60, bottom: 104 }, { width: 240, height: 600 }, { width: 256, height: 200 });
  check("narrower than the menu: pinned to the 8 px gutter", narrow.left === 8, narrow);
  const low = placeMenu({ left: 20, top: 780, bottom: 824 }, vp, { width: 256, height: 240 });
  check("near the bottom it flips above the trigger", low.top + 240 <= 780, low);
  const s = src("components/platform/PlatformSpaceSwitcher.tsx");
  check("portals to <body> as a fixed z-50 layer (escapes the sticky row's stacking context)", /createPortal\(/.test(s) && /document\.body/.test(s) && /fixed z-50/.test(s));
  check("closes on Escape (focus back to the trigger) and on an outside pointer-down", /"Escape"/.test(s) && /close\(true\)/.test(s) && /pointerdown/.test(s));
  check("the trigger states its state", /aria-expanded=\{open\}/.test(s) && /aria-label="Switch Platform Space"/.test(s));
}

console.log("2. the compact Platform header is sticky (Personal Space pattern)");
{
  const shell = src("components/space/shell/SpaceShell.tsx");
  check("sticky under the GlobalHeader, below it in z, solid background", /data-sticky-space-header/.test(shell) && /sticky top-\[calc\(3rem\+1px\)\] z-20/.test(shell) && /bg-\[var\(--bg-base\)\]/.test(shell));
}

console.log("3. chart selections persist after release and can be dismissed");
{
  const bars = src("components/platform/ops-visual/DayBars.tsx");
  check("DayBars: hover is mouse-only; a click/tap pins; ✕, Escape, outside tap clear; arrow keys step",
    /pointerType === "mouse"/.test(bars) && /setPinned\(\(p\) => \(p === i \? null : i\)\)/.test(bars) && /aria-label="Clear selection"/.test(bars) && /"Escape"/.test(bars) && /ArrowLeft/.test(bars) && /pointerdown/.test(bars));
  const grid = src("components/platform/charts/HeatGrid.tsx");
  check("HeatGrid: same contract", /pointerType === "mouse"/.test(grid) && /setPinned\(\(p\)/.test(grid) && /aria-label="Clear selection"/.test(grid) && /"Escape"/.test(grid) && /pointerdown/.test(grid));
}
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
