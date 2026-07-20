/**
 * components/space/shell/timeline-lens-exclusivity.test.ts
 *
 * Phase 2 deletion guard — ONE canonical time selector, unconditionally.
 *
 * Before deletion this file proved the two paths were mutually exclusive. That
 * question is gone: there is no second path. It now proves the stronger property
 * — the legacy controls are deleted, cannot return, and TimelineLens renders for
 * every Perspective with no branch to take.
 *
 * It RENDERS PerspectiveShell rather than scanning it, because the property is
 * about what reaches the user, and rendering is the only thing that distinguishes
 * "present in source" from "present on screen".
 *
 * Pure, DB-free:  npx tsx components/space/shell/timeline-lens-exclusivity.test.ts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PerspectiveTimeState } from "@/lib/perspectives/time-range";
import { PerspectiveShell } from "./PerspectiveShell";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

const ROOT = process.cwd();
const TODAY = "2026-07-19";
const TIME: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" };
const HISTORICAL: PerspectiveTimeState = { preset: "YTD", asOf: "2026-03-31", compareTo: "2026-01-01" };
const PERSPECTIVES = ["wealth", "cashFlow", "investments", "debt", "liquidity"];

const noop = () => {};
function render(
  time: PerspectiveTimeState = TIME,
  temporalCapability: unknown = { asOf: "full", compareTo: "full", period: "none" },
) {
  return renderToStaticMarkup(
    h(PerspectiveShell as never, {
      today: TODAY,
      onAsOfChange: noop,
      onCompareToChange: noop,
      onSwap: noop,
      onSelectPreset: noop,
      envelope: {},
      temporalCapability,
      timeState: time,
      tabs: [],
      activeTabId: null,
      onSelectTab: noop,
    } as never),
  );
}

const LENS = (html: string) => html.includes('aria-label="Change time period"');
const LEGACY_SLICER = (html: string) => html.includes('aria-label="Cash flow period');
const LEGACY_DATES = (html: string) => html.includes('aria-label="As of date"');
const LEGACY_SWAP = (html: string) => html.includes('aria-label="Swap As of and Compare to dates"');

// ── 1. The legacy files are gone and cannot come back ────────────────────────
console.log("1. Deleted — the legacy controls no longer exist");
{
  const DELETED = [
    "components/space/widgets/CashFlowPeriodSelector.tsx",
    "components/space/shell/ShellContextRow.tsx",
    "components/space/shell/timeline-lens-rollout.ts",
  ];
  for (const rel of DELETED) {
    check(`${rel} is deleted`, !existsSync(path.join(ROOT, rel)));
  }

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !full.endsWith("exclusivity.test.ts")) {
        const src = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
        if (/from\s+"[^"]*(CashFlowPeriodSelector|ShellContextRow|timeline-lens-rollout)"/.test(src)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  for (const d of ["components", "app", "lib"]) walk(path.join(ROOT, d));
  check("nothing imports the deleted modules", offenders.length === 0, offenders.join(", "));
}

// ── 2. TimelineLens renders unconditionally — there is no branch ─────────────
console.log("2. One selector, no branch");
{
  const shellSrc = readFileSync(path.join(ROOT, "components/space/shell/PerspectiveShell.tsx"), "utf8");
  const stripped = shellSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

  check("PerspectiveShell renders TimelineLens", stripped.includes("<TimelineLens"));
  check("no rollout flag remains", !stripped.includes("usesTimelineLens"));
  check("no conditional selector branch remains", !/useLens\s*\?/.test(stripped));

  for (const time of [TIME, HISTORICAL]) {
    const html = render(time);
    const label = time === TIME ? "present" : "historical";
    check(`${label}: renders TimelineLens`, LENS(html));
    check(`${label}: renders NO legacy preset slicer`, !LEGACY_SLICER(html));
    check(`${label}: renders NO legacy date inputs`, !LEGACY_DATES(html));
    check(`${label}: renders NO legacy swap`, !LEGACY_SWAP(html));
    check(`${label}: exactly one lens trigger`,
      (html.match(/aria-label="Change time period"/g) ?? []).length === 1);
  }

  // Capability still gates the explicit boundary fields, never the selector itself.
  const gated = render(TIME, { asOf: "none", compareTo: "none", period: "full" });
  check("a lens with no explicit date axis STILL gets the selector", LENS(gated));
}

// ── 3. The behavioral adapter seam survived the deletion ─────────────────────
console.log("3. Intent callbacks preserved — adapters, not legacy plumbing");
{
  // The load-bearing distinction of Phase 2. These four LOOK like legacy selector
  // plumbing but are how every TimelineIntent reaches the host: the adapter
  // resolves an intent into a sanctioned ShellTimeAction and the shell dispatches
  // it through exactly these. Losing onSelectPreset would bypass handleSelectSlice
  // and strand cashFlowExplicitPeriod — Cash Flow would stay pinned to a drilled
  // month while every other Perspective moved.
  const shellSrc = readFileSync(path.join(ROOT, "components/space/shell/PerspectiveShell.tsx"), "utf8");
  for (const cb of ["onSelectPreset", "onAsOfChange", "onCompareToChange", "onSwap"]) {
    check(`${cb} is still a prop`, new RegExp(`${cb}:\\s*\\(`).test(shellSrc));
    check(`${cb} is still dispatched by handleTimelineIntent`, new RegExp(`props\\.${cb}\\(`).test(shellSrc));
  }
  check("every ShellTimeAction the adapter can emit has a dispatch arm",
    ["selectPreset", "setAsOf", "setCompareTo", "swap", "clearCompareTo"]
      .every((a) => shellSrc.includes(`case "${a}":`)));

  const host = readFileSync(path.join(ROOT, "components/dashboard/SpaceDashboard.tsx"), "utf8");
  check("the host still routes presets through handleSelectSlice",
    /onSelectPreset=\{handleSelectSlice\}/.test(host));
  check("handleSelectSlice still clears the Cash-Flow override",
    /isExplicitPeriod\(slice\)[\s\S]{0,400}setCashFlowExplicitPeriod\(null\)/.test(host));
}

// ── 4. Trust surfaces survived ───────────────────────────────────────────────
console.log("4. Trust surfaces are independent of the time control");
{
  const html = render();
  check("Completeness chip still renders", html.includes("Completeness"));
  check("Evidence chip still renders", html.includes("Evidence"));
}

// ── 5. The anchor is named for every declared capability shape ───────────────
console.log("5. Anchor visibility (TIME-1B)");
{
  for (const id of PERSPECTIVES) {
    const cap = id === "debt" || id === "liquidity"
      ? { asOf: "partial", compareTo: "partial", period: "none" }
      : { asOf: "full", compareTo: "full", period: id === "cashFlow" ? "full" : "none" };
    const present = render(TIME, cap);
    const past = render(HISTORICAL, cap);
    check(`${id}: names the anchor at the present`, present.includes("As of today"));
    check(`${id}: names the anchor when historical`, past.includes("As of Mar 31, 2026"));
    check(`${id}: still states the resolved window`, past.includes("Jan 1, 2026"));
    check(`${id}: no present-tense period claim`, !/>This (week|month|quarter|year)</.test(past));
  }
}

if (failures > 0) {
  console.error(`\n${failures} deletion-guard check(s) failed.`);
  process.exit(1);
}
console.log("\nLegacy controls deleted; TimelineLens is the only canonical time selector.");
