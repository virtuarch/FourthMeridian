/**
 * lib/space/space-runtime-ownership.test.ts  (SD-9)
 *
 * Ownership invariants for the Workspace Runtime Convergence. SpaceDashboard is a
 * COMPOSITION ROOT: it resolves navigation/time, mounts the runtime seams, and
 * dispatches the workspace renderer. It must NOT be a perspective-loading authority,
 * a trust calculator, or a trust-selection controller — those live in dedicated hooks.
 *
 * Pure source-scan, DB-free:  npx tsx lib/space/space-runtime-ownership.test.ts
 * (Comments are stripped first so a doc-comment mentioning a moved symbol never
 *  satisfies or breaks an invariant — only real code counts.)
 *
 * Also carries the SP-2A-4a shell-seam contract (merged from
 * lib/space-shell-seams.test.ts, updated for REVIEW-3 slice F) — both suites
 * scan the same SpaceDashboard seams, so they share one scan harness.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const count = (s: string, sub: string) => s.split(sub).length - 1;

const HOST_RAW = read("components/dashboard/SpaceDashboard.tsx");
const HOST = stripComments(HOST_RAW);
const LENS = read("lib/space/use-space-lens-results.ts");
const ENV  = read("lib/space/use-active-envelope.ts");

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}`);
  failures++;
}

console.log("SD-9A — LensResults ownership");
// Host mounts the seam and does not itself load perspectives.
check("host mounts useSpaceLensResults", HOST.includes("useSpaceLensResults("));
check("host does NOT fetch the perspectives route", !HOST.includes("/perspectives`") && !HOST.includes("/perspectives?"));
check("host does NOT own lens-result state (no setLensResults)", !HOST.includes("setLensResults"));
check("host does NOT subscribe to the lens currency-refresh signal", !HOST.includes("SPACE_CURRENCY_CHANGED"));
// The hook is the authority.
check("useSpaceLensResults owns the batch fetch", LENS.includes("/perspectives"));
check("useSpaceLensResults owns the currency-refresh listener", LENS.includes("SPACE_CURRENCY_CHANGED_EVENT"));

console.log("SD-9B — Trust publication ownership");
// Host mounts the seam and neither calculates nor selects envelopes.
check("host mounts useActiveEnvelope", HOST.includes("useActiveEnvelope("));
check("host does NOT calculate envelopes (no resolvePerspectiveEnvelope in host)", !HOST.includes("resolvePerspectiveEnvelope"));
check("host does NOT own the envelope state (no setActiveEnvelope)", !HOST.includes("setActiveEnvelope"));
check("host relays the resolved envelope to the shell", HOST.includes("envelope={activeEnvelope}"));
// The hook owns the authority + the selection; the authority itself is unchanged.
check("useActiveEnvelope owns the canonical resolver", ENV.includes("resolvePerspectiveEnvelope("));
check("useActiveEnvelope owns the workspace-backed selection", ENV.includes("WORKSPACE_RENDERERS["));
check("useActiveEnvelope does NOT define a parallel tier vocabulary", !ENV.includes("CompletenessTier =") && !ENV.includes("enum "));

console.log("SD-9C — Chrome derivation");
// The Space subtitle is derived exactly once (no duplicate inline computation).
check("subtitle member-clause is derived exactly once",
  count(HOST, "} member${memberCount === 1") === 1);
check("mobile relocation reuses the canonical subtitle parts",
  HOST.includes("subtitle={chromeUpdated ? `${chromeSubtitle}"));

// ── merged from lib/space-shell-seams.test.ts (SP-2A-4a guards, updated for
//    REVIEW-3 slice F) — the shell-seam contract on SpaceDashboard ────────────
console.log("SP-2A-4a — shell seams (REVIEW-3)");
{
  // dashSrc / dashCode from the source suite map onto the shared harness:
  // HOST_RAW is the raw dashboard source, HOST the comment-stripped code.
  const pageSrc = read(path.join("app", "(shell)", "dashboard", "page.tsx"));
  // SD-8b — the URL/tab/perspective navigation state machine moved here; the
  // initial-tab + URL-tab seam checks follow it.
  const navSrc = read(path.join("lib", "space", "use-space-navigation.ts"));
  const navCode = stripComments(navSrc);

  // The renderHero seam stays deleted; the display-currency control seam stays.
  check("renderHero seam is removed", !/renderHero/.test(HOST));
  check("display-currency control seam is retained", /displayCurrencyControl\?:\s*React\.ReactNode/.test(HOST_RAW));

  // REVIEW-3 — the initialTab seam is DELETED end-to-end: no prop on the host,
  // no arm in the nav hook. (Its last supplier, mapLegacyTabToShell +
  // PersonalDashboard's pass-through, was removed in Wave 1.)
  check("initialTab prop seam is deleted from the host", !/initialTab\??:/.test(HOST));
  check("initialTab arm is deleted from useSpaceNavigation", !/\binitialTab\b/.test(navCode.replace(/initialTabSet/g, "")));

  // Rail host is derived from spaceType, never hardcoded.
  check(
    "rail host derives from spaceType",
    HOST_RAW.includes('spaceType === "PERSONAL"') && HOST_RAW.includes("railVisibleTabs(railHost)")
  );
  check(
    "rail host is not hardcoded to \"shared\"",
    !HOST_RAW.includes('railVisibleTabs("shared")')
  );

  // REVIEW-3 — the Overview summary canvas is gone: the OVERVIEW slot always
  // renders the engaged Perspective workspace. No OverviewWorkspace mount, no
  // perspectiveEngaged negation branch, no SpaceTrendHero anywhere.
  check("OVERVIEW always renders the engaged workspace (no summary branch)",
    HOST.includes('activeTab === "OVERVIEW" && activePerspective != null') &&
    !HOST.includes("perspectiveEngaged") &&
    !HOST.includes("<OverviewWorkspace"));
  check("SpaceTrendHero is fully retired (only the hasSpaceTrendHero predicate remains)",
    !HOST.includes("<SpaceTrendHero") && !HOST.includes("widgets/SpaceTrendHero"));

  // SD-7b — the snapshot FETCH lives in useSpaceData; the host folds the same
  // activation gate (PERSONAL or a trend-hero category, or a snapshot-tier
  // perspective) into the `wantSnapshots` flag it hands the hook.
  check(
    "snapshots activation still gates on PERSONAL or a trend-hero category (folded into wantSnapshots)",
    /wantSnapshots = hasSpaceTrendHero\(category\) \|\| spaceType === "PERSONAL"/.test(HOST_RAW)
  );
  check(
    "initial tab is applied once — from the URL (?tab=), then the section-derived default (useSpaceNavigation)",
    /initialTabSet\.current = true;[\s\S]{0,400}readUrlTabState\(\)[\s\S]{0,400}hasSpaceTrendHero\(category\)/.test(navSrc)
  );

  // URL tab state uses window.history (not useSearchParams, which forces a Suspense
  // boundary) — now owned by useSpaceNavigation; the host still adds no useSearchParams.
  check(
    "URL tab state uses window.history (not the useSearchParams hook)",
    !HOST_RAW.includes("useSearchParams") && navSrc.includes("readUrlTabState")
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
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-9 runtime-ownership invariants hold.");
