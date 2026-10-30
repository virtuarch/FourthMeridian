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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PLATFORM_WORKSPACE_ALIASES, getPlatformWorkspaceComposition } from "@/lib/platform/workspaces";

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

    // PLATFORM OPS PHASE 1 UX — re-ruled: the refresh workspace became the
    // Pipeline VIEW of Operations. The id "platform-refresh" survives as an alias
    // that opens that view; the view is composed and the Overview offers a doorway to it.
    const ops = getPlatformWorkspaceComposition("PLATFORM_OPS", "platform-overview");
    check("platform-refresh resolves (alias) to Operations › Pipeline",
      PLATFORM_WORKSPACE_ALIASES["platform-refresh"]?.workspaceId === "platform-overview" && PLATFORM_WORKSPACE_ALIASES["platform-refresh"]?.viewId === "pipeline");
    check("the Pipeline view is composed into PLATFORM_OPS", ops?.views?.some((v) => v.id === "pipeline") === true);
    check("the Pipeline view is reachable from the Overview doorways", /doorways:[^\]]*platformViewTarget\("platform-overview", "pipeline"\)/.test(workspaces)
      && (ops?.doorways ?? []).includes("platform-overview:pipeline"));
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
    // PLATFORM OPS PHASE 1 UX — the refresh composition is now Operations › Pipeline.
    void workspaces;
    const refreshSections = (getPlatformWorkspaceComposition("PLATFORM_OPS", "platform-overview")?.views
      ?.find((v) => v.id === "pipeline")?.sections ?? []).map(String).join(",");
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

  console.log("UX-P1 · page grain, shared primitives, honest paging");
  {
    const exec = strip(widgetPath("OpsRefreshExecutionsWidget"));
    const summary = strip(widgetPath("OpsRefreshSummaryWidget"));
    const coverage = strip(widgetPath("OpsRefreshCoverageWidget"));

    check("executions: filter pills are the shared PillGroup", /PillGroup/.test(exec) && !/function Segmented/.test(exec));
    check("executions: a real 'Load older' control exists", /Load older/.test(exec));
    check("executions: older pages ride the seam's cursor through the keyed reader", /nextCursor/.test(exec) && /useKeyedFetch<ExecutionPageDTO>\(\s*`[^`]*&cursor=/.test(exec));
    check("executions: each older page is a keyed body (remounted per cursor)", /<OlderPage\s+key=\{page\.nextCursor\}/.test(exec));
    check("executions: the control never claims a total", /no total is counted/.test(exec) && !/\d+ older|older \(\d|\{[^}]*\.length[^}]*\} older/i.test(exec));
    check("executions: below md the dropped columns reappear in an inline disclosure", /<details className="[^"]*md:hidden/.test(exec) && /<summary/.test(exec));
    check("executions: the disclosure is a sibling of the row button, never nested in it", (() => {
      const btnStart = exec.indexOf("<button\n                type=\"button\"\n                onClick={() => onSelect(selectionFor(row))}");
      const btnEnd = exec.indexOf("</button>", btnStart);
      const details = exec.indexOf("<details", btnStart);
      return btnStart >= 0 && btnEnd > btnStart && details > btnEnd;
    })());
    check("executions: the deployment rule still fires across a page boundary", /precededBy/.test(exec) && /isDeploymentBoundary\(sequence/.test(exec));
    check("executions: the drawer is untouched (panel receives only the selection)", /executionId=\{selected\?\.id \?\? null\}/.test(exec));

    for (const [name, src] of [["summary", summary], ["coverage", coverage]] as const) {
      check(`${name}: on the page grain (SectionSurface), not the card grain`, /SectionSurface/.test(src) && !/PlatformWidgetCard/.test(src));
      check(`${name}: the envelope is the scope line`, /describeWindow\(/.test(src));
      check(`${name}: has a prop-driven surface for render proofs`, /export function Refresh(Summary|Coverage)Surface\(/.test(src));
      check(`${name}: grid-row idiom with a shared column definition`, /gridTemplateColumns:\s*COLS/.test(src));
      check(`${name}: md collapse by class, never matchMedia`, /md:contents|md:hidden/.test(src) && !/matchMedia/.test(src));
    }
    check("summary: a BigStat for the execution count", /<BigStat/.test(summary));
    check("summary: the two strips through the SAME view map the Overview uses", /refresh-activity-view/.test(summary) && /statusSegments\(/.test(summary) && /triggerSegments\(/.test(summary));
    check("summary: Δ records goes through formatNullable (null ≠ 0)", /formatNullable\(ep\.recordsChanged\)/.test(summary));
    for (const w of WIDGETS) {
      check(`${w.file}: no hex colour (tokens only)`, !/#[0-9a-fA-F]{3,8}\b/.test(strip(widgetPath(w.file))));
    }

    const daily = "app/api/platform/platform-ops/refresh/daily/route.ts";
    check("the day-series route exists for the Overview block", existsSync(path.join(ROOT, daily)));
    check("...and is READ-gated", /requirePlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']READ["']\s*\)/.test(strip(daily)));
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
