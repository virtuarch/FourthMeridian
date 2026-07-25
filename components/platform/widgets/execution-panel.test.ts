/**
 * components/platform/widgets/execution-panel.test.ts  (OPS-2C-3)
 *
 * The panel is an INSPECTION surface. This ratchet holds it to that.
 *
 * The failure mode it guards is seductive: a detail panel is exactly where an
 * engineer reaches for "just total the provider calls" or "sort these by
 * duration". Either would make the panel a second ordering/aggregation authority
 * over facts the Execution Timeline projection already owns — and the two would
 * then be free to disagree about the same execution.
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

const PANEL = "components/platform/widgets/ExecutionTimelinePanel.tsx";
const WIDGET = "components/platform/widgets/OpsRefreshExecutionsWidget.tsx";
const ROUTE = "app/api/platform/platform-ops/refresh/executions/[id]/timeline/route.ts";

function main() {
  console.log("route · READ-gated, one projection, honest 404");
  {
    const src = strip(ROUTE);
    check("requires PLATFORM_OPS READ", /requirePlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']READ["']\s*\)/.test(src));
    check("never requests WRITE", !/["']WRITE["']/.test(src));
    check("authorizes BEFORE reading", src.indexOf("requirePlatformAccess") < src.search(/await\s+getExecutionTimeline/));
    check("calls getExecutionTimeline", /getExecutionTimeline\(/.test(src));
    check("calls no other projection", !/getRefreshSummary|getCoverageSummary|getFailureSummary|getProviderOperationSummary/.test(src));
    check("does not use the row seam", !/queryRefreshExecutions|getRefreshExecutionDetail/.test(src));
    check("404s a missing execution rather than fabricating an empty timeline", /status:\s*404/.test(src));
    check("exports no mutating verb", !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(src));
    check("touches no db and no ledger", !/@\/lib\/db|\.refreshExecution\./.test(src));
  }

  console.log("panel · inspects, never aggregates");
  {
    const src = strip(PANEL);
    check("no reduce/fold", !/\.reduce\(/.test(src));
    check("NO re-sorting — the projection owns entry order incl. its tiebreak", !/\.sort\(/.test(src));
    check("no filtering of projection entries", !/entries\.filter\(/.test(src));
    check("no counting/totalling of entries", !/entries\.length\s*[><+]/.test(src));
    check("no arithmetic accumulation", !/\+=/.test(src));
    check("renders entries in received order", /data\.entries\.map\(/.test(src));

    check("imports no projection module", !/@\/lib\/platform\/refresh\/(projections|execution-query)/.test(src));
    check("imports no db/Prisma", !/@\/lib\/db|@prisma\/client/.test(src));
    check("imports no ledger authority", !/@\/lib\/plaid\//.test(src));
    check("types come from the contract module only", /@\/lib\/platform\/refresh\/types/.test(src));
    check("is a client component", /^"use client";/.test(readFileSync(path.join(ROOT, PANEL), "utf8")));
  }

  console.log("panel · Panel = inspect (not a modal), and honest states");
  {
    const src = strip(PANEL);
    check("uses the Atlas RightPanel primitive", /RightPanel/.test(src));
    check("does NOT use a Dialog/Modal (inspection must not interrupt)", !/Dialog|OverlaySurface|Modal/.test(src));
    check("surfaces loading/error through the shared WidgetMessage", /WidgetMessage/.test(src));
    check("an incomplete (still RUNNING) timeline says so", /still running/.test(src));
    check("an empty timeline says 'not observed', never 'nothing happened'", /not observed/.test(src));
  }

  console.log("panel · the keyed-remount contract is real");
  {
    const src = strip(PANEL);
    check("the fetching body is a separate component", /function TimelineBody\(/.test(src));
    check("it is remounted per execution via a React key", /<TimelineBody\s+key=\{executionId\}/.test(src));
    check("it does NOT call the static-url shared hook", !/useWidgetFetch/.test(src));
    check("its own reader resets state per mount", /useState<T \| null>\(null\)/.test(src));
    check("it aborts on unmount", /alive\s*=\s*false/.test(src));
    check("it distinguishes 403 / 404 / other", /403/.test(src) && /404/.test(src));
  }

  console.log("widget → panel wiring passes an ID, never data");
  {
    const src = strip(WIDGET);
    check("renders the panel", /<ExecutionTimelinePanel/.test(src));
    check("passes only an execution id", /executionId=\{selected\?\.id \?\? null\}/.test(src));
    check("threads NO timeline data down (the panel fetches its own)", !/entries|timeline=/.test(src));
    check("rows are real buttons (keyboard reachable)", /<button/.test(src) && /type="button"/.test(src));
    check("rows carry an accessible label", /aria-label=/.test(src));
    check("closing clears the selection", /setSelected\(null\)/.test(src));
    check("still no aggregation in the row surface", !/\.reduce\(|\.sort\(/.test(src));
  }

  console.log("scope · 2C-3 reaches into no later slice");
  {
    const panel = strip(PANEL);
    const route = strip(ROUTE);
    const forbidden = /mayRun|admission|pausedUntil|JobControlState|maintenanceMode|skipNext|deploymentSha/i;
    check("panel introduces no OPS-2D vocabulary and no deployment identity (2C-4)", !forbidden.test(panel));
    check("route introduces no OPS-2D vocabulary and no deployment identity (2C-4)", !forbidden.test(route));
  }

  if (failures > 0) {
    console.error(`\nexecution-panel.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nexecution-panel.test: all passed.");
}

main();
