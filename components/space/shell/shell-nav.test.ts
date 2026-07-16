/**
 * components/space/shell/shell-nav.test.ts
 *
 * SHELL_NAV S2/S3/S4/S6 — source-scan contract for the shell-level wiring and,
 * critically, the STOP-CONDITION GUARD that the five untouched SegmentedControl
 * consumers neither float nor receive icons (so they stay byte-identical).
 *
 *   npx tsx components/space/shell/shell-nav.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const shell   = read("components/space/shell/PerspectiveShell.tsx");
const tabs    = read("components/space/shell/PerspectiveTabs.tsx");
const dash    = read("components/dashboard/SpaceDashboard.tsx");
// SD-1: the Space-level rail render logic moved out of SpaceDashboard into the
// extracted SpaceShell frame; the host now only decides staticness via railStatic.
const frame   = read("components/space/shell/SpaceShell.tsx");

function main(): void {
  console.log("S2 — PerspectiveShell renders the lens tabs ABOVE the time/trust block");
  const iTabs   = shell.search(/<FloatingNavWrapper[^>]*>[\s\S]*?<PerspectiveTabs/);
  const iContext = shell.indexOf("<ShellContextRow");
  const iPreset  = shell.indexOf("<CashFlowPeriodSelector");
  check("tab track appears before ShellContextRow", iTabs > -1 && iContext > -1 && iTabs < iContext);
  check("tab track appears before the period preset selector", iTabs > -1 && iPreset > -1 && iTabs < iPreset);
  check("the old bordered selector frame is gone (no rounded-2xl border around the tabs)",
    !/rounded-2xl border p-1\.5 sm:p-2/.test(shell));

  console.log("S4 — the Perspective track floats; the rail floats only OFF the Perspectives tab");
  check("PerspectiveShell wraps the tabs in FloatingNavWrapper", /<FloatingNavWrapper[\s\S]*?<PerspectiveTabs/.test(shell));
  check("PerspectiveShell pins below the rail (PERSPECTIVE_PILL_TOP)", /PERSPECTIVE_PILL_TOP/.test(shell));
  // Phase 2 scroll-follow swap (SD-1: split across host + shell): the host feeds
  // railStatic on the Perspectives tab, and the shell gates the rail's
  // FloatingNavWrapper on railStatic, rendering BARE (no wrapper) when static —
  // not shrinkOnScroll={false} (stop condition #3).
  check("host makes the rail static on the Perspectives tab",
    /railStatic=\{activeTab === "PERSPECTIVES"\}/.test(dash));
  check("shell floats the rail only when NOT static",
    /railStatic \?\s*\(\s*[\s\S]{0,200}?\)\s*:\s*\(\s*<FloatingNavWrapper top=\{RAIL_PILL_TOP\}/.test(frame));
  check("shell renders the rail bare (no FloatingNavWrapper) when static",
    /railStatic \?\s*\(\s*<div className="mb-5">\{rail\}/.test(frame));
  // Strip comments first — an explanatory comment legitimately mentions the
  // anti-pattern; the assertion is about actual CODE not using it.
  const frameCode = frame.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("scroll-follow swap does NOT use shrinkOnScroll={false} (stop condition #3)",
    !/shrinkOnScroll=\{false\}/.test(frameCode));
  check("rail no longer forces full width (w-full removed from its control)",
    !/aria-label="Space section"[\s\S]{0,160}className="w-full/.test(frame));

  console.log("S1/S3 — perspective tab icons are wired through and rendered");
  check("SpaceDashboard threads PerspectiveDef.icon into the tab items", /icon:\s*p\.icon/.test(dash));
  check("PerspectiveTabs resolves via the shared map", /PERSPECTIVE_ICON_MAP/.test(tabs));
  check("PerspectiveTabs passes a resolved icon node to the option", /icon:\s*i\.icon\s*\?\s*<TabIcon/.test(tabs));
  check("TabIcon is decorative (aria-hidden) at tab scale (size 14)", /<Icon size=\{14\} aria-hidden/.test(tabs));

  console.log("STOP-CONDITION GUARD — the five untouched consumers never float and never get icons");
  const untouched = [
    "components/space/widgets/CashFlowPeriodSelector.tsx",
    "components/space/widgets/wealth/WealthCompositionCard.tsx",
    "components/space/widgets/wealth/WealthTrendChart.tsx",
    "components/space/widgets/TimelineWidget.tsx",
  ];
  for (const p of untouched) {
    const s = read(p);
    check(`${path.basename(p)} does not import FloatingNavWrapper`, !/FloatingNavWrapper/.test(s));
    check(`${path.basename(p)} does not use the scroll-shrink hook`, !/useScrollShrink/.test(s));
  }
  // These three have no legitimate use of the word "icon" at all — so any icon
  // reaching their SegmentedControl would trip this. (TimelineWidget legitimately
  // uses `icon` for event glyphs, so it is guarded by the float/scroll checks
  // above plus its options coming from the plain ACTIVITY_FILTER_GROUPS list.)
  for (const p of untouched.slice(0, 3)) {
    check(`${path.basename(p)} passes no icon to SegmentedControl`, !/icon/i.test(read(p)));
  }
  check("TimelineWidget's SegmentedControl options are the plain filter groups",
    /options=\{ACTIVITY_FILTER_GROUPS\}/.test(read("components/space/widgets/TimelineWidget.tsx")));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll shell-nav checks passed");
}

main();
