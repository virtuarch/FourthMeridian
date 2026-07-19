/**
 * components/space/shell/timeline-lens-exclusivity.test.ts
 *
 * Slice 4 doctrine guard — ONE canonical time selector, ever.
 *
 * This RENDERS PerspectiveShell (renderToStaticMarkup) rather than scanning its
 * source, because the property worth protecting is about what reaches the user:
 * a Perspective must never show two time selectors, and which one it shows must
 * depend on nothing but the rollout allowlist.
 *
 * Source scanning cannot prove that — both selectors legitimately appear in the
 * file, in exclusive branches. Only rendering distinguishes "present in source"
 * from "present on screen".
 *
 * Pure, DB-free:  npx tsx components/space/shell/timeline-lens-exclusivity.test.ts
 */

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PerspectiveTimeState } from "@/lib/perspectives/time-range";
import { PerspectiveShell } from "./PerspectiveShell";
import { TIMELINE_LENS_PERSPECTIVES, usesTimelineLens } from "./timeline-lens-rollout";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

const TODAY = "2026-07-19";
const TIME: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" };

const noop = () => {};
function render(activePerspectiveId: string | null) {
  return renderToStaticMarkup(
    h(PerspectiveShell as never, {
      asOf: TIME.asOf,
      compareTo: TIME.compareTo,
      today: TODAY,
      onAsOfChange: noop,
      onCompareToChange: noop,
      onSwap: noop,
      envelope: {},
      presetValue: "MTD",
      onSelectPreset: noop,
      temporalCapability: { asOf: "full", compareTo: "full", period: "none" },
      timeState: TIME,
      activePerspectiveId,
      tabs: [],
      activeTabId: activePerspectiveId,
      onSelectTab: noop,
    } as never),
  );
}

/** Signatures that identify each control in the rendered output. */
const LENS = (html: string) => html.includes('aria-label="Change time period"');
const LEGACY_SLICER = (html: string) => html.includes('aria-label="Cash flow period');
const LEGACY_DATES = (html: string) => html.includes('aria-label="As of date"');
const LEGACY_SWAP = (html: string) => html.includes('aria-label="Swap As of and Compare to dates"');

// ── 1. Exactly one selector, chosen only by the flag ─────────────────────────
console.log("1. Exclusivity — a Perspective never shows two time selectors");
{
  const wealth = render("wealth");
  const cashFlow = render("cashFlow");
  const none = render(null);

  check("wealth is on the allowlist (fixture precondition)", usesTimelineLens("wealth"));
  check("cashFlow is NOT on the allowlist (fixture precondition)", !usesTimelineLens("cashFlow"));

  // Flag ON
  check("wealth renders TimelineLens", LENS(wealth));
  check("wealth renders NO legacy preset slicer", !LEGACY_SLICER(wealth));
  check("wealth renders NO legacy date inputs", !LEGACY_DATES(wealth));
  check("wealth renders NO legacy swap", !LEGACY_SWAP(wealth));

  // Flag OFF
  check("cashFlow renders the legacy slicer", LEGACY_SLICER(cashFlow));
  check("cashFlow renders the legacy date inputs", LEGACY_DATES(cashFlow));
  check("cashFlow renders NO TimelineLens", !LENS(cashFlow));

  // Unknown / null falls back to legacy — fail safe, never "no time control".
  check("a null perspective falls back to the legacy control", LEGACY_SLICER(none) && !LENS(none));
  check("an unknown perspective falls back to the legacy control",
    LEGACY_SLICER(render("not-a-real-perspective")));

  // The core doctrine, stated directly.
  for (const [id, html] of [["wealth", wealth], ["cashFlow", cashFlow], ["null", none]] as const) {
    const count = [LENS(html), LEGACY_SLICER(html)].filter(Boolean).length;
    check(`${id} renders EXACTLY ONE canonical time selector`, count === 1, `found ${count}`);
  }
}

// ── 2. Trust surfaces survive both paths ─────────────────────────────────────
console.log("2. Trust surfaces are independent of the time control");
{
  // The chips were never temporally gated; swapping the time UI must not drop them.
  for (const id of ["wealth", "cashFlow"]) {
    const html = render(id);
    check(`${id} still renders the Completeness chip`, html.includes("Completeness"));
    check(`${id} still renders the Evidence chip`, html.includes("Evidence"));
  }
}

// ── 3. The rollout is a migration device, not a permanent fork ───────────────
console.log("3. Rollout allowlist shape");
{
  check("the allowlist is non-empty (the canary is running)", TIMELINE_LENS_PERSPECTIVES.size > 0);
  check("the rollout has NOT silently expanded past Wealth",
    TIMELINE_LENS_PERSPECTIVES.size === 1 && TIMELINE_LENS_PERSPECTIVES.has("wealth"),
    [...TIMELINE_LENS_PERSPECTIVES].join(","));
  check("null/undefined never enables the lens",
    !usesTimelineLens(null) && !usesTimelineLens(undefined) && !usesTimelineLens(""));
}

// ── 4. No second time authority reaches the user ─────────────────────────────
console.log("4. One authority — the lens path adds no competing control");
{
  const wealth = render("wealth");
  // Exactly one element carries the lens trigger, and no stray date input exists
  // outside the lens panel (the panel is portalled and absent from this markup).
  check("exactly one lens trigger", (wealth.match(/aria-label="Change time period"/g) ?? []).length === 1);
  check("no date input renders alongside the lens trigger",
    !wealth.includes('type="date"'), "a boundary input escaped the panel");
}

if (failures > 0) {
  console.error(`\n${failures} exclusivity check(s) failed.`);
  process.exit(1);
}
console.log("\nOne canonical time selector, chosen only by the rollout flag.");
