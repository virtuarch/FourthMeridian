/**
 * components/platform/widgets/refresh-widgets.test.ts  (OPS-2C-2)
 *
 * Consumption-boundary ratchet for the three Refresh widgets. Standalone tsx
 * (house pattern) — source scan; no React renderer in this repo.
 *
 * The 2C-2 contract is that the widgets consume the 2C-1 ROUTES and nothing
 * else. The failure mode this guards is quiet and attractive: importing
 * `projections.ts` directly into a widget would "work" in dev, bypass the route
 * (and therefore its authorization gate), and create a second consumption path
 * for the same value. That is precisely the parallel-authority defect the whole
 * operational spine exists to prevent, so it is pinned rather than reviewed.
 *
 * Also pinned: registration is complete end-to-end (section key → registry →
 * composition → identity), because a key registered in only two of the three
 * places renders nothing and fails silently.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const WIDGETS = [
  { file: "OpsRefreshSummaryWidget", key: "ops_refresh_summary", route: "/api/platform/platform-ops/refresh/summary" },
  { file: "OpsRefreshExecutionsWidget", key: "ops_refresh_executions", route: "/api/platform/platform-ops/refresh/executions" },
  { file: "OpsRefreshCoverageWidget", key: "ops_refresh_coverage", route: "/api/platform/platform-ops/refresh/coverage" },
] as const;

const widgetPath = (f: string) => `components/platform/widgets/${f}.tsx`;

function main() {
  console.log("consumption boundary · widgets fetch ROUTES, never internals");
  {
    for (const w of WIDGETS) {
      const src = strip(widgetPath(w.file));
      check(`${w.file}: fetches its route via useWidgetFetch`, new RegExp(`useWidgetFetch<[^>]+>\\(\\s*"${w.route.replace(/\//g, "\\/")}`).test(src));
      check(`${w.file}: does NOT import projections.ts`, !/@\/lib\/platform\/refresh\/projections/.test(src));
      check(`${w.file}: does NOT import the seam implementation`, !/@\/lib\/platform\/refresh\/execution-query"/.test(src));
      check(`${w.file}: does NOT import Prisma or db`, !/@\/lib\/db|@prisma\/client/.test(src));
      check(`${w.file}: does NOT import a ledger authority`, !/@\/lib\/plaid\//.test(src));
      check(`${w.file}: no raw fetch (must go through the shared hook)`, !/[^d]fetch\(/.test(src));
      check(`${w.file}: is a client component`, /^"use client";/.test(readFileSync(path.join(ROOT, widgetPath(w.file)), "utf8")));
    }
  }

  console.log("widgets compute no truth");
  {
    for (const w of WIDGETS) {
      const src = strip(widgetPath(w.file));
      check(`${w.file}: no reduce/fold`, !/\.reduce\(/.test(src));
      check(`${w.file}: no arithmetic aggregation over rows`, !/\+=|\bsum\b/.test(src));
      check(`${w.file}: no sorting of server data`, !/\.sort\(/.test(src));
    }
    // The executions widget is the ROW surface — it must not invent a count.
    const exec = strip(widgetPath("OpsRefreshExecutionsWidget"));
    check("executions widget renders no total/count (the seam does not aggregate)", !/\.length\s*\}\s*(execution|total|row)/i.test(exec));
  }

  console.log("registration is complete in all three places");
  {
    const policy = strip("lib/platform/policy.ts");
    const workspaces = strip("lib/platform/workspaces.ts");
    const dashboard = strip("components/platform/PlatformSpaceDashboard.tsx");

    for (const w of WIDGETS) {
      check(`${w.key}: declared in PLATFORM_AREAS sections (so it can be seeded)`, new RegExp(`key:\\s*"${w.key}"`).test(policy));
      check(`${w.key}: composed into the refresh workspace`, new RegExp(`"${w.key}"`).test(workspaces));
      check(`${w.key}: mapped to its widget in the registry`, new RegExp(`${w.key}:\\s*${w.file}`).test(dashboard));
    }

    check("platform-refresh has a workspace identity", /"platform-refresh":\s*\{/.test(workspaces));
    check("platform-refresh is composed into PLATFORM_OPS", /workspaceId:\s*"platform-refresh"/.test(workspaces));
    check("platform-refresh is reachable from the Overview doorways", /doorways:[^\]]*"platform-refresh"/.test(workspaces));
    check("its icon exists in the workspace icon map", /RefreshCw/.test(dashboard));
  }

  console.log("scope · 2C-2 does not reach into later slices");
  {
    const workspaces = strip("lib/platform/workspaces.ts");
    // OPS-2C-5 NARROWED THIS FENCE TO ITS STATED INTENT. It read "NOT folded into
    // the refresh workspace" but scanned the WHOLE file, so it also forbade the
    // section existing anywhere — including Providers, which is where 2C-5 places
    // it by decision. The real protection is no DUPLICATION into Refresh, so the
    // scan is now scoped to the refresh composition, where it still bites.
    const refreshSections =
      workspaces.match(/workspaceId:\s*"platform-refresh",\s*sections:\s*\[([^\]]*)\]/)?.[1] ?? "";
    check(
      "provider-operations is NOT folded into the refresh workspace (it lives under Providers)",
      refreshSections.length > 0 && !/ops_provider_operations/.test(refreshSections),
    );
    for (const w of WIDGETS) {
      const src = strip(widgetPath(w.file));
      // OPS-2C-4 RETIRED THIS FENCE FOR THE EXECUTIONS WIDGET ONLY. The fence was
      // written in 2C-2 labelled "(2C-4)" — a dated marker whose expiry is that
      // slice, not a doctrinal rule. 2C-4 surfaces deployment as EVIDENCE ON AN
      // EXECUTION, so the row surface may carry it. Summary and coverage are
      // aggregate surfaces with no execution to attach evidence to, so the fence
      // still holds there and a stray sha in either remains a failure.
      if (w.file === "OpsRefreshExecutionsWidget") {
        check(`${w.file}: carries deployment evidence on the execution row (2C-4)`, /deploymentSha/.test(src));
        check(`${w.file}: still never resolves the RUNNING deployment`, !/currentDeploymentSha/.test(src));
      } else {
        check(`${w.file}: no deployment identity (aggregate surface — nothing to attach it to)`, !/deploymentSha/.test(src));
      }
      check(`${w.file}: no execution detail panel (2C-3)`, !/RightPanel|getExecutionTimeline/.test(src));
      check(`${w.file}: no OPS-2D control vocabulary`, !/mayRun|admission|pause|resume|disable|maintenanceMode/i.test(src));
    }
  }

  console.log("honesty · empty states are explicit in the markup");
  {
    const summary = strip(widgetPath("OpsRefreshSummaryWidget"));
    const coverage = strip(widgetPath("OpsRefreshCoverageWidget"));
    const exec = strip(widgetPath("OpsRefreshExecutionsWidget"));

    check("summary branches on isUnobserved", /isUnobserved\(/.test(summary));
    check("coverage branches on isUnobserved", /isUnobserved\(/.test(coverage));
    check("summary says 'not observed' rather than showing zeros", /not observed/.test(summary));
    check("coverage says 'not observed' rather than 0%", /not observed/.test(coverage));
    check("coverage percentage is gated on a non-null ratio", /pct\s*!=\s*null/.test(coverage));
    check("executions distinguishes scope-denied from empty", /scopeDenied/.test(exec));
    check("every widget surfaces loading + error via the shared message", WIDGETS.every((w) => /WidgetMessage/.test(strip(widgetPath(w.file)))));
  }

  if (failures > 0) {
    console.error(`\nrefresh-widgets.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nrefresh-widgets.test: all passed.");
}

main();
