/**
 * components/platform/widgets/deployment-evidence.test.ts  (OPS-2C-4)
 *
 * ONE INVARIANT, HELD STRUCTURALLY:
 *
 *     Execution → deploymentSha        ✅ an observed attribute of the object
 *     Deployment → execution summary   ❌ the inversion
 *
 * Operational tooling drifts into that inversion quietly: a divider becomes a
 * heading, a heading acquires a count, and within two slices "deployment" owns
 * the executions instead of describing them. This file pins the shape that makes
 * the drift impossible rather than merely discouraged — `isDeploymentBoundary`
 * returns a per-index boolean, so there are no buckets for a caller to render as
 * a group.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEPLOYMENT_UNKNOWN,
  isDeploymentBoundary,
  shortSha,
} from "@/components/platform/widgets/refresh-format";
import { EXECUTION_ROW_KEYS, projectExecutionRow } from "@/lib/platform/refresh/execution-query-core";

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

const row = (deploymentSha: string | null) => ({ deploymentSha });

function main() {
  console.log("sha formatting · unknown stays unknown");
  {
    check("null → unknown, never blank", shortSha(null) === DEPLOYMENT_UNKNOWN);
    check("undefined → unknown", shortSha(undefined) === DEPLOYMENT_UNKNOWN);
    check("empty string → unknown (absence, not identity)", shortSha("") === DEPLOYMENT_UNKNOWN);
    check("whitespace → unknown", shortSha("   ") === DEPLOYMENT_UNKNOWN);
    check("a real sha is shortened to 7", shortSha("abc123def456789") === "abc123d");
    check("a short sha is not padded or altered", shortSha("abc12") === "abc12");
  }

  console.log("boundary · an annotation on a sequence, never a group");
  {
    const rows = [row("aaa"), row("aaa"), row("bbb"), row("bbb")];
    check("index 0 is NEVER a boundary (no predecessor ⇒ no claim)", isDeploymentBoundary(rows, 0) === false);
    check("same-as-previous is not a boundary", isDeploymentBoundary(rows, 1) === false);
    check("a change IS a boundary", isDeploymentBoundary(rows, 2) === true);
    check("after the change, same-as-previous again", isDeploymentBoundary(rows, 3) === false);

    check("out-of-range index is false, never a throw", isDeploymentBoundary(rows, 99) === false);
    check("negative index is false", isDeploymentBoundary(rows, -1) === false);
    check("empty list is false", isDeploymentBoundary([], 0) === false);

    // Epistemic transitions are real changes.
    const withNull = [row("aaa"), row(null), row(null), row("aaa")];
    check("observed → not-observed IS a boundary", isDeploymentBoundary(withNull, 1) === true);
    check("not-observed → not-observed is NOT a boundary", isDeploymentBoundary(withNull, 2) === false);
    check("not-observed → observed IS a boundary", isDeploymentBoundary(withNull, 3) === true);

    // THE STRUCTURAL GUARANTEE: the return type cannot express a group.
    check(
      "the boundary API returns a boolean — no bucket, key, or group can be built from it",
      typeof isDeploymentBoundary([row("a"), row("b")], 1) === "boolean",
    );
  }

  console.log("only OBSERVED evidence is displayed — no runtime comparison");
  {
    const widget = strip("components/platform/widgets/OpsRefreshExecutionsWidget.tsx");
    const fmt = strip("components/platform/widgets/refresh-format.ts");
    // The only available basis was the client bundle's env, which reads unknown
    // whenever just the non-public var is set. Speculative UI on an unreliable
    // comparison is worse than none, so the whole notion was removed.
    check("the widget never resolves the running deployment", !/currentDeploymentSha/.test(widget));
    check("the widget does not import the deployment resolver", !/@\/lib\/monitoring\/deployment/.test(widget));
    check('no "served by" claim', !/served by/i.test(widget));
    check('no "current" deployment marker', !/· current|=== "current"/.test(widget));
    check('no "earlier" deployment marker', !/earlier/i.test(widget));
    check("the unused comparison helper was REMOVED, not left dormant", !/export function deploymentRelation/.test(fmt));
  }

  console.log("DTO · deployment rides the execution row, within its contract");
  {
    check("EXECUTION_ROW_KEYS declares deploymentSha", EXECUTION_ROW_KEYS.includes("deploymentSha"));

    const dto = projectExecutionRow(
      {
        id: "e1", runId: "r1", plaidItemId: "i1", trigger: "CRON", profile: "FULL_REFRESH",
        startedAt: new Date("2026-07-10T06:00:00.000Z"), completedAt: new Date("2026-07-10T06:00:05.000Z"),
        durationMs: 5000, overallStatus: "SUCCEEDED", parentJobRunId: null, errorSummary: null,
        deploymentSha: "abc123def",
      },
      "operator",
    );
    check("the DTO carries the sha", dto.deploymentSha === "abc123def");
    check(
      "the DTO has EXACTLY its declared keys (no field leaked in with it)",
      Object.keys(dto).sort().join(",") === [...EXECUTION_ROW_KEYS].sort().join(","),
    );

    const supportDto = projectExecutionRow(
      {
        id: "e1", runId: "r1", plaidItemId: "i1", trigger: "CRON", profile: "FULL_REFRESH",
        startedAt: new Date("2026-07-10T06:00:00.000Z"), completedAt: null, durationMs: null,
        overallStatus: "RUNNING", parentJobRunId: null, errorSummary: "secret internal detail",
        deploymentSha: "abc123def",
      },
      "support",
    );
    check("support also sees the sha (a commit is not customer data)", supportDto.deploymentSha === "abc123def");
    check("support redaction is UNCHANGED by this slice", supportDto.errorSummary === null && supportDto.hasError === true);
    check("a null sha survives as null, never coerced", projectExecutionRow(
      {
        id: "e2", runId: "r2", plaidItemId: "i1", trigger: "MANUAL", profile: "FULL_REFRESH",
        startedAt: new Date(), completedAt: null, durationMs: null, overallStatus: "RUNNING",
        parentJobRunId: null, errorSummary: null, deploymentSha: null,
      },
      "operator",
    ).deploymentSha === null);
  }

  console.log("no inversion · deployment never becomes a subject");
  {
    const widget = strip("components/platform/widgets/OpsRefreshExecutionsWidget.tsx");
    const fmt = strip("components/platform/widgets/refresh-format.ts");

    check("no grouping of rows by deployment", !/groupBy|\.group\(|byDeployment|deploymentGroups/i.test(widget + fmt));
    check("no per-deployment counting", !/deploymentCount|countByDeployment/i.test(widget + fmt));
    check("no reduce/fold over deployments", !/\.reduce\(/.test(widget + fmt));
    check("no sorting of rows by deployment", !/\.sort\(/.test(widget));
    check("no Set/Map of deployments built in the widget", !/new (Set|Map)\(/.test(widget));
    check("the boundary is rendered aria-hidden (decoration, not structure)", /isDeploymentBoundary[\s\S]{0,240}aria-hidden/.test(widget));
    check("no deployment section key was introduced", !/ops_deployment/.test(strip("lib/platform/policy.ts")));
    check("no deployment workspace was introduced", !/platform-deployment/.test(strip("lib/platform/workspaces.ts")));

    // The row remains the object being inspected.
    check("the panel is still opened with an EXECUTION id", /executionId=\{selected\?\.id \?\? null\}/.test(widget));
    check("deployment reaches the panel only as header context", /deploy \$\{shortSha/.test(widget));
  }

  console.log("scope · 2C-4 introduces no later-slice concept");
  {
    const forbidden = /mayRun|admission|pausedUntil|JobControlState|maintenanceMode|skipNext|ops_provider_operations|ops_scheduler/i;
    for (const f of [
      "components/platform/widgets/OpsRefreshExecutionsWidget.tsx",
      "components/platform/widgets/refresh-format.ts",
    ]) {
      check(`${f}: no later-slice vocabulary`, !forbidden.test(strip(f)));
    }
  }

  if (failures > 0) {
    console.error(`\ndeployment-evidence.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\ndeployment-evidence.test: all passed.");
}

main();
