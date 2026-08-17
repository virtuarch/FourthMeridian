/**
 * lib/space-shell-seams.test.ts
 *
 * SP-2A-4a guards (source-scan — no DOM runner exists in this repo).
 * Standalone tsx script:  npx tsx lib/space-shell-seams.test.ts
 *
 * Pins the shell-seam contract on SpaceDashboard. Updated for REVIEW-3
 * (slice F), which deleted the Overview summary canvas (OverviewWorkspace /
 * SpaceTrendHero) and the supplier-less initialTab seam:
 *  - renderHero seam remains removed; the display-currency control seam is
 *    retained (SD-2C: displayCurrencyControl, shell-mounted);
 *  - the initialTab prop seam is DELETED (its last supplier — the legacy
 *    /dashboard?tab= mapping chain — was removed in REVIEW-3 Wave 1);
 *  - the rail host is derived, not hardcoded "shared";
 *  - the OVERVIEW slot always renders the engaged Perspective workspace (no
 *    summary branch, no trend hero);
 *  - snapshots are fetched for PERSONAL or a trend-hero category
 *    (hasSpaceTrendHero), preserving the pre-REVIEW-3 activation gate;
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
// SD-8b — the URL/tab/perspective navigation state machine moved here; the
// initial-tab + URL-tab seam checks follow it.
const navSrc = readFileSync(
  path.join(ROOT, "lib", "space", "use-space-navigation.ts"),
  "utf8"
);
const navCode = navSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

// The renderHero seam stays deleted; the display-currency control seam stays.
check("renderHero seam is removed", !/renderHero/.test(dashCode));
check("display-currency control seam is retained", /displayCurrencyControl\?:\s*React\.ReactNode/.test(dashSrc));

// REVIEW-3 — the initialTab seam is DELETED end-to-end: no prop on the host,
// no arm in the nav hook. (Its last supplier, mapLegacyTabToShell +
// PersonalDashboard's pass-through, was removed in Wave 1.)
check("initialTab prop seam is deleted from the host", !/initialTab\??:/.test(dashCode));
check("initialTab arm is deleted from useSpaceNavigation", !/\binitialTab\b/.test(navCode.replace(/initialTabSet/g, "")));

// Rail host is derived from spaceType, never hardcoded.
check(
  "rail host derives from spaceType",
  dashSrc.includes('spaceType === "PERSONAL"') && dashSrc.includes("railVisibleTabs(railHost)")
);
check(
  "rail host is not hardcoded to \"shared\"",
  !dashSrc.includes('railVisibleTabs("shared")')
);

// REVIEW-3 — the Overview summary canvas is gone: the OVERVIEW slot always
// renders the engaged Perspective workspace. No OverviewWorkspace mount, no
// perspectiveEngaged negation branch, no SpaceTrendHero anywhere.
check("OVERVIEW always renders the engaged workspace (no summary branch)",
  dashCode.includes('activeTab === "OVERVIEW" && activePerspective != null') &&
  !dashCode.includes("perspectiveEngaged") &&
  !dashCode.includes("<OverviewWorkspace"));
check("SpaceTrendHero is fully retired (only the hasSpaceTrendHero predicate remains)",
  !dashCode.includes("<SpaceTrendHero") && !dashCode.includes("widgets/SpaceTrendHero"));

// SD-7b — the snapshot FETCH lives in useSpaceData; the host folds the same
// activation gate (PERSONAL or a trend-hero category, or a snapshot-tier
// perspective) into the `wantSnapshots` flag it hands the hook.
check(
  "snapshots activation still gates on PERSONAL or a trend-hero category (folded into wantSnapshots)",
  /wantSnapshots = hasSpaceTrendHero\(category\) \|\| spaceType === "PERSONAL"/.test(dashSrc)
);
check(
  "initial tab is applied once — from the URL (?tab=), then the section-derived default (useSpaceNavigation)",
  /initialTabSet\.current = true;[\s\S]{0,400}readUrlTabState\(\)[\s\S]{0,400}hasSpaceTrendHero\(category\)/.test(navSrc)
);

// URL tab state uses window.history (not useSearchParams, which forces a Suspense
// boundary) — now owned by useSpaceNavigation; the host still adds no useSearchParams.
check(
  "URL tab state uses window.history (not the useSearchParams hook)",
  !dashSrc.includes("useSearchParams") && navSrc.includes("readUrlTabState")
);

// REVIEW-3 — a hand-crafted ?perspective= id outside the category's lens list
// must degrade to the wealth default, never fall through to a deleted summary
// branch: the nav hook validates the selected id against availablePerspectives.
check(
  "nav hook resolves only category-valid lens ids (crafted URLs degrade to the wealth default)",
  navCode.includes("availablePerspectives.includes(selectedPerspectiveId)")
);

// The flip happened (SP-2A-4c): Personal renders through the shared shell
// (PersonalDashboard), and page.tsx no longer references DashboardClient.
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
