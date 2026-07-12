/**
 * components/atlas/useScrollShrink.test.ts
 *
 * SHELL_NAV S5/S6 — the pure shrink decision behind the floating-nav pill. The
 * hook itself is a thin rAF/scroll-listener wrapper; the DECISION is computeShrink,
 * tested here against a scripted sequence of scroll positions (house convention:
 * no DOM/RTL). Contract (plan §2.5): shrink on scroll-DOWN past the threshold,
 * return to full size on scroll-UP or near the top, hold on no movement.
 *
 *   npx tsx components/atlas/useScrollShrink.test.ts
 */

import { computeShrink, SHRINK_THRESHOLD, SHRINK_SCALE } from "./useScrollShrink";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T = 24;

function main(): void {
  console.log("near the top is always full size, regardless of prior state or direction");
  check("at 0 → full", computeShrink(0, 100, true, T) === false);
  check("exactly at threshold → full", computeShrink(T, 100, true, T) === false);
  check("just above threshold while scrolling down → shrink", computeShrink(T + 1, T, false, T) === true);

  console.log("direction drives the state past the threshold");
  check("scrolling DOWN (100→200) → shrink", computeShrink(200, 100, false, T) === true);
  check("scrolling UP (200→100) → full", computeShrink(100, 200, true, T) === false);
  check("no movement holds previous (was shrunk)", computeShrink(300, 300, true, T) === true);
  check("no movement holds previous (was full)", computeShrink(300, 300, false, T) === false);

  console.log("a full scripted journey down-then-up converges correctly");
  // Replay a sequence, threading (prevY, shrunk) like the hook does.
  const journey = [0, 10, 40, 120, 300, 500, 480, 300, 30, 0];
  let prevY = journey[0];
  let shrunk = false;
  const states: boolean[] = [];
  for (let i = 1; i < journey.length; i++) {
    shrunk = computeShrink(journey[i], prevY, shrunk, T);
    prevY = journey[i];
    states.push(shrunk);
  }
  // 10(full,<=T) 40(down>T→shrink) 120(down→shrink) 300 500(shrink) 480(up→full) 300(up→full) 30(up→full) 0(top→full)
  check("mid-journey deep scroll-down is shrunk", states[3] === true && states[4] === true);
  check("first scroll-up releases to full", states[5] === false);
  check("ends full at the top", states[states.length - 1] === false);

  console.log("exported defaults are sane (modest shrink, small threshold, never a hide)");
  check("threshold is a small positive number", SHRINK_THRESHOLD > 0 && SHRINK_THRESHOLD <= 64);
  check("shrink scale is a modest reduction, not a hide", SHRINK_SCALE < 1 && SHRINK_SCALE >= 0.8);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll useScrollShrink checks passed");
}

main();
