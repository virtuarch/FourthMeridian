/**
 * lib/space-shell-seams.test.ts
 *
 * SP-2A-4a guards (source-scan — no DOM runner exists in this repo).
 * Standalone tsx script:  npx tsx lib/space-shell-seams.test.ts
 *
 * Pins the shell-seam contract on SpaceDashboard:
 *  - renderHero / initialTab exist as OPTIONAL props (additive seam);
 *  - the rail host is derived, not hardcoded "shared";
 *  - the SpaceTrendHero path is gated off when a custom hero is provided;
 *  - the day-zero OverviewSetupCard is suppressed under a custom hero;
 *  - page.tsx renders Personal through the shared SpaceDashboard shell
 *    (SP-2A-4c flip — via PersonalDashboard + the renderHero seam), and no
 *    longer references DashboardClient.
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
const pageSrc = readFileSync(
  path.join(ROOT, "app", "(shell)", "dashboard", "page.tsx"),
  "utf8"
);

// Seams exist and are optional.
check("renderHero is an optional prop", /renderHero\?:\s*\(ctx:/.test(dashSrc));
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

// Custom hero owns the slot: trend-hero path and day-zero card are gated.
check(
  "SpaceTrendHero path is skipped when renderHero is provided",
  /&& !renderHero &&[\s\S]{0,120}heroDef &&/.test(dashSrc)
);
check(
  "day-zero OverviewSetupCard is suppressed under a custom hero",
  /accounts\.length === 0 && !renderHero \?/.test(dashSrc)
);
check(
  "snapshots are fetched when a custom hero needs them",
  dashSrc.includes("if (!heroDef && !renderHero) return;")
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
