/**
 * lib/platform/refresh/routes.test.ts  (OPS-2C-1)
 *
 * Source-scan ratchet over the refresh read routes. Standalone tsx (house
 * pattern) — reads route source as text; no runtime, no DB, no network.
 *
 * These routes are the first consumers of the OPS-2B read model, so they are the
 * first place the read boundary could be violated by convenience. What is pinned:
 *
 *   • every route is READ-gated, and gates BEFORE doing any work;
 *   • no route writes anything (OPS-2C is observational — OPS-2D owns writes);
 *   • no route aggregates — the projections own that;
 *   • no route touches the ledger directly (also enforced repo-wide by
 *     read-boundary.test.ts; asserted here at the point of use);
 *   • the seam's AUDIENCE is hardcoded, never read from the request, because
 *     audience selects the redaction posture;
 *   • no OPS-2D vocabulary leaked in.
 */

import { existsSync, readFileSync } from "node:fs";
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
const BASE = "app/api/platform/platform-ops/refresh";

/** The four projection routes and the one seam route this slice ships. */
const PROJECTION_ROUTES = ["summary", "provider-operations", "coverage", "failures"] as const;
const SEAM_ROUTE = "executions";
const ALL_ROUTES = [...PROJECTION_ROUTES, SEAM_ROUTE];

/** Comments name forbidden concepts constantly; only real code counts. */
function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
const routeFile = (name: string) => `${BASE}/${name}/route.ts`;

function main() {
  console.log("existence");
  {
    for (const r of ALL_ROUTES) {
      check(`${r}/route.ts exists`, existsSync(path.join(ROOT, routeFile(r))));
    }
  }

  console.log("authorization · READ-gated, gated first");
  {
    for (const r of ALL_ROUTES) {
      const src = code(routeFile(r));
      check(`${r}: requires PLATFORM_OPS READ`, /requirePlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']READ["']\s*\)/.test(src));
      check(`${r}: never requests WRITE (observation only)`, !/["']WRITE["']/.test(src));
      check(`${r}: returns early on the auth error`, /if\s*\(\s*err\s*\)\s*return\s+err/.test(src));

      // The gate must precede the work: the auth call must appear before any
      // projection/seam invocation in the file.
      const gateAt = src.indexOf("requirePlatformAccess");
      const workAt = src.search(/await\s+(getRefreshSummary|getProviderOperationSummary|getCoverageSummary|getFailureSummary|queryRefreshExecutions)/);
      check(`${r}: authorization happens BEFORE any read`, gateAt >= 0 && workAt > gateAt);
    }
  }

  console.log("observation only · no writes");
  {
    for (const r of ALL_ROUTES) {
      const src = code(routeFile(r));
      check(`${r}: exports no POST/PUT/PATCH/DELETE`, !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(src));
      check(`${r}: performs no persistence call`, !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(src));
    }
  }

  console.log("one aggregation path · routes compute nothing");
  {
    for (const r of ALL_ROUTES) {
      const src = code(routeFile(r));
      check(`${r}: no direct db import`, !/@\/lib\/db/.test(src));
      check(`${r}: no ledger accessor`, !/\.(refreshExecution|refreshEndpointResult|providerCall|refreshEndpointAccountCoverage)\s*\./.test(src));
      check(`${r}: no folding in the route`, !/\.reduce\(|\.filter\(|\.map\(/.test(src));
      check(`${r}: no Prisma aggregation`, !/\.aggregate\(|\.groupBy\(|\.count\(/.test(src));
    }
  }

  console.log("each projection route calls exactly ONE projection");
  {
    const expected: Record<string, string> = {
      summary: "getRefreshSummary",
      "provider-operations": "getProviderOperationSummary",
      coverage: "getCoverageSummary",
      failures: "getFailureSummary",
    };
    const all = Object.values(expected);
    for (const r of PROJECTION_ROUTES) {
      const src = code(routeFile(r));
      check(`${r}: calls ${expected[r]}`, new RegExp(`\\b${expected[r]}\\(`).test(src));
      const others = all.filter((fn) => fn !== expected[r]);
      check(`${r}: calls no OTHER projection`, others.every((fn) => !new RegExp(`\\b${fn}\\(`).test(src)));
      check(`${r}: does not use the row seam`, !/queryRefreshExecutions|getRefreshExecutionDetail/.test(src));
    }
  }

  console.log("seam route · audience is never client-controlled");
  {
    const src = code(routeFile(SEAM_ROUTE));
    check("uses the row seam", /queryRefreshExecutions\(/.test(src));
    check("calls no projection", !/getRefreshSummary|getProviderOperationSummary|getCoverageSummary|getFailureSummary/.test(src));
    check('audience is hardcoded "operator"', /audience:\s*["']operator["']/.test(src));
    check(
      "audience is NOT read from the request",
      !/audience[^\n]*(searchParams|req\.|params\.get|body)/.test(src),
    );
    check("the support audience is not reachable from this route", !/["']support["']/.test(src));
  }

  console.log("shared parameter contract · parsed once, not per route");
  {
    for (const r of PROJECTION_ROUTES) {
      check(`${r}: uses the shared projection parser`, /parseProjectionParams\(/.test(code(routeFile(r))));
    }
    check("seam uses the shared seam parser", /parseExecutionQueryParams\(/.test(code(routeFile(SEAM_ROUTE))));

    // No route may re-implement date/scope validation locally.
    for (const r of ALL_ROUTES) {
      check(`${r}: no local date regex (parsing lives in one module)`, !/\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(code(routeFile(r))));
    }
  }

  console.log("future boundary · no OPS-2D vocabulary");
  {
    const forbidden = /JobControlState|JobAdmissionPolicy|mayRun|admission|declaredPolicy|maintenanceMode|pausedUntil|skipNext/i;
    for (const r of ALL_ROUTES) {
      check(`${r}: introduces no OPS-2D concept`, !forbidden.test(code(routeFile(r))));
    }
    const params = code("lib/platform/refresh/request-params.ts");
    check("the parameter module introduces no OPS-2D concept", !forbidden.test(params));
    check("the parameter module is pure (no db, no server-only)", !/@\/lib\/db|server-only/.test(params));
  }

  if (failures > 0) {
    console.error(`\nroutes.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nroutes.test: all passed.");
}

main();
