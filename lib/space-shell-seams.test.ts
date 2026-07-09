/**
 * lib/space-shell-seams.test.ts
 *
 * SP-2A-4a guards (source-scan — no DOM runner exists in this repo).
 * Standalone tsx script:  npx tsx lib/space-shell-seams.test.ts
 *
 * Pins the shell-seam contract on SpaceDashboard. Updated for the Unified
 * Space Widget Layout (slice 1), which DELETES the renderHero seam and makes
 * Personal Overview section-backed:
 *  - renderHero seam is removed; overviewTopSlot (currency control) is retained;
 *  - initialTab remains an OPTIONAL prop;
 *  - the rail host is derived, not hardcoded "shared";
 *  - the SpaceTrendHero path is gated on heroDef only (Personal has none, so its
 *    chart is the net_worth_chart SECTION — no duplicate);
 *  - the day-zero OverviewSetupCard shows for accounts.length === 0 (Personal too);
 *  - snapshots are fetched for PERSONAL (net_worth_chart) or a heroDef;
 *  - page.tsx renders Personal through the shared SpaceDashboard shell (via
 *    PersonalDashboard), and no longer references DashboardClient.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const ROOT = process.cwd();
const dashSrc = readFileSync(
  path.join(ROOT, "components", "dashboard", "SpaceDashboard.tsx"),
  "utf8"
);
/** dashSrc with comments stripped — for checks that must match real code, not
 *  prose (e.g. "renderHero" still appears in explanatory comments). */
const dashCode = dashSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const pageSrc = readFileSync(
  path.join(ROOT, "app", "(shell)", "dashboard", "page.tsx"),
  "utf8"
);

// Unified Space Widget Layout (slice 1): the renderHero seam is DELETED —
// Personal Overview is now section-backed (net_worth / net_worth_chart /
// allocation), not a custom-hero body. overviewTopSlot (currency control) stays.
check("renderHero seam is removed", !/renderHero/.test(dashCode));
check("overviewTopSlot seam is retained", /overviewTopSlot\?:\s*React\.ReactNode/.test(dashSrc));
check("initialTab is an optional prop", /initialTab\?:\s*string/.test(dashSrc));

// Rail host is derived from spaceType, never hardcoded.
check(
  "rail host derives from spaceType",
  dashSrc.includes('spaceType === "PERSONAL"') && dashSrc.includes("railVisibleTabs(railHost)")
);
check(
  "rail host is not hardcoded to \"shared\"",
  !dashSrc.includes('railVisibleTabs("shared")')
);

// Section-backed Overview: the trend hero renders only for chartable shared
// Spaces (heroDef); Personal has no heroDef, so its chart is the
// net_worth_chart SECTION, not a duplicated SpaceTrendHero.
check(
  "SpaceTrendHero path is gated on heroDef only (no renderHero)",
  /composition === "overview" &&\s*\n\s*accounts\.length > 0 && heroDef &&/.test(dashSrc)
);
check(
  "day-zero OverviewSetupCard shows for accounts.length === 0 (Personal included)",
  /accounts\.length === 0 \?/.test(dashSrc) && !/accounts\.length === 0 && !renderHero/.test(dashSrc)
);
check(
  "snapshots are fetched for PERSONAL (net_worth_chart) or a heroDef (plus the Debt workspace)",
  /if \(!heroDef && spaceType !== "PERSONAL"[\s\S]{0,40}\) return;/.test(dashSrc)
);
check(
  "initialTab is applied once at the section-derived defaulting site",
  /initialTabSet\.current = true;[\s\S]{0,400}if \(initialTab\)/.test(dashSrc)
);

// No URL synchronization was added for tab state.
check(
  "SpaceDashboard does not read searchParams",
  !dashSrc.includes("useSearchParams")
);

// The flip happened (SP-2A-4c): Personal renders through the shared shell
// (PersonalDashboard + the renderHero seam), and page.tsx no longer
// references DashboardClient.
check(
  "page.tsx renders Personal through the shared shell, not DashboardClient",
  !pageSrc.includes("DashboardClient") &&
    pageSrc.includes("PersonalDashboard") &&
    pageSrc.includes('type === "PERSONAL"')
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SP-2A-4a shell-seam checks passed.");
