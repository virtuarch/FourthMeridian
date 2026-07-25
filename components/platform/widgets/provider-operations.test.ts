/**
 * components/platform/widgets/provider-operations.test.ts  (OPS-2C-5)
 *
 * Provider Operations sits between two established surfaces, and the risk is
 * SEMANTIC COLLAPSE rather than a bug:
 *
 *   Provider Health      health interpretation (canonical authority elsewhere)
 *   Provider Operations  observed behaviour during refresh executions   ← this
 *   API Usage            consumption / billing volume over time
 *
 * Two failure modes are pinned here. First, this card quietly becoming a second
 * provider-health authority — a "worst-first" sort or a computed verdict is all
 * it would take. Second, it leading with a per-provider call count, which API
 * Usage already leads with, inviting an operator to reconcile two populations
 * that are deliberately different (ApiUsageCounter counts every provider call;
 * ProviderCall counts only calls inside a refresh execution).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describeAttempts, operationLabel } from "@/components/platform/widgets/refresh-format";

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

const WIDGET = "components/platform/widgets/OpsProviderOperationsWidget.tsx";

function main() {
  console.log("consumption · the frozen 2C-1 route, nothing else");
  {
    const src = strip(WIDGET);
    check(
      "fetches the frozen provider-operations route",
      /useWidgetFetch<[^>]+>\(\s*"\/api\/platform\/platform-ops\/refresh\/provider-operations"/.test(src),
    );
    check("does NOT import the projection", !/@\/lib\/platform\/refresh\/projections/.test(src));
    check("does NOT import Prisma or db", !/@\/lib\/db|@prisma\/client/.test(src));
    check("does NOT import a ledger authority", !/@\/lib\/plaid\//.test(src));
    check("does NOT import the provider-health authority", !/provider-health/.test(src));
    check("does NOT import the usage authority", !/ApiUsage|usage\/pricing/.test(src));
    check("no raw fetch — the shared hook only", !/[^d]fetch\(/.test(src));
    check("is a client component", /^"use client";/.test(readFileSync(path.join(ROOT, WIDGET), "utf8")));
  }

  console.log("not a health authority · no verdict, no re-ranking");
  {
    const src = strip(WIDGET);
    check("does not re-sort the projection's operations", !/\.sort\(/.test(src));
    check("computes no health/trust verdict", !/trust|healthy|degraded|OPERATIONAL|deriveProvider/i.test(src));
    check("no reduce/fold over operations", !/\.reduce\(/.test(src));
    check("no arithmetic accumulation", !/\+=/.test(src));
    check("no filtering that would hide observed operations", !/operations\.filter\(/.test(src));
    check("renders the projection's order verbatim", /data\.operations\.map\(/.test(src));
  }

  console.log("leading metric differs from API Usage");
  {
    const src = strip(WIDGET);
    // API Usage leads with big WidgetStat call totals; this must not.
    check("does NOT render a WidgetStat headline number", !/WidgetStat/.test(src));
    check("does NOT lead with the summary's totalCalls", !/totalCalls/.test(src));
    check("leads with outcomes (failed / rate-limited / ok)", /op\.failed/.test(src) && /op\.rateLimited/.test(src) && /op\.succeeded/.test(src));
    check("surfaces latency alongside outcomes", /meanDurationMs/.test(src) && /maxDurationMs/.test(src));
    check("names the population it observed", /during refresh executions/i.test(src));
  }

  console.log("no retry rate · pagination confounding is stated, not narrated away");
  {
    const src = strip(WIDGET);
    check("publishes no retry rate", !/retryRate|retry rate(?! )/i.test(src.replace(/not a retry rate/g, "")));
    check("surfaces the pagination-confounded flag", /paginationConfounded/.test(src));

    check("a single-attempt operation says nothing at all", describeAttempts({ maxAttempt: 1, paginationConfounded: false }) === null);
    check("zero attempts says nothing", describeAttempts({ maxAttempt: 0, paginationConfounded: true }) === null);

    const plain = describeAttempts({ maxAttempt: 3, paginationConfounded: false });
    check("a retried operation reports attempts", plain === "up to 3 attempts per execution");

    const paged = describeAttempts({ maxAttempt: 4, paginationConfounded: true })!;
    check("a paginated operation NEVER calls them retries", !/retr/i.test(paged.replace(/retries are not distinguishable/, "")));
    check("...and says pages and retries are indistinguishable", /pages and retries are not distinguishable/.test(paged));
  }

  console.log("provider neutrality");
  {
    const src = strip(WIDGET);
    const fmt = strip("components/platform/widgets/refresh-format.ts");
    check("the widget hardcodes no provider name", !/plaid/i.test(src));
    check("the adapter hardcodes no provider name", !/plaid/i.test(fmt));
    check("the label is built from the data's own vocabulary", /operationLabel\(/.test(src));
    check("operationLabel joins provider + operation without inventing either", operationLabel({ provider: "PLAID", operation: "transactionsSync" }) === "plaid.transactionsSync");
    check("a future provider renders identically", operationLabel({ provider: "TELLER", operation: "accountsGet" }) === "teller.accountsGet");
  }

  console.log("honesty · absence is not health");
  {
    const src = strip(WIDGET);
    check("branches on isUnobserved", /isUnobserved\(/.test(src));
    check("says 'not observed' rather than showing zeros", /not observed/.test(src));
    check(
      "explicitly denies that absence means good behaviour",
      /not evidence the provider behaved well/i.test(src),
    );
    check("surfaces window indeterminacy", /describeWindow\(/.test(src) && /win\.detail/.test(src));
    check("loading + error go through the shared message", /WidgetMessage/.test(src));
  }

  console.log("placement · Providers only, in the approved order");
  {
    const workspaces = strip("lib/platform/workspaces.ts");
    const policy = strip("lib/platform/policy.ts");
    const dashboard = strip("components/platform/PlatformSpaceDashboard.tsx");

    check("registered as a section", /key:\s*"ops_provider_operations"/.test(policy));
    check("mapped to its widget", /ops_provider_operations:\s*OpsProviderOperationsWidget/.test(dashboard));

    const providers = workspaces.match(/workspaceId:\s*"platform-providers",\s*sections:\s*\[([^\]]*)\]/)?.[1] ?? "";
    const refresh = workspaces.match(/workspaceId:\s*"platform-refresh",\s*sections:\s*\[([^\]]*)\]/)?.[1] ?? "";

    check("appears under Providers", /ops_provider_operations/.test(providers));
    check("does NOT also appear under Refresh (no duplication)", !/ops_provider_operations/.test(refresh));

    const order = providers.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    check(
      "Providers order matches the approved sequence",
      order.join() ===
        [
          "ops_provider_health",
          "ops_provider_operations",
          "ops_connection_health",
          "ops_connection_diagnostics",
          "ops_api_usage",
          "ops_resource_freshness",
          "ops_email_delivery",
        ].join(),
      order.join(),
    );
    check("Provider Operations sits directly after Provider Health", order[1] === "ops_provider_operations");
    check("...and is not adjacent to API Usage", Math.abs(order.indexOf("ops_api_usage") - 1) > 1);
  }

  console.log("existing surfaces untouched");
  {
    const health = strip("components/platform/widgets/OpsProviderHealthWidget.tsx");
    const usage = strip("components/platform/widgets/OpsApiUsageWidget.tsx");
    check("Provider Health still consumes its own route", /platform-ops\/provider-health/.test(health));
    check("Provider Health knows nothing of provider-operations", !/provider-operations/.test(health));
    check("API Usage still consumes its own route", /platform-ops\/api-usage/.test(usage));
    check("API Usage knows nothing of provider-operations", !/provider-operations/.test(usage));
  }

  console.log("scope · no later-slice or OPS-2D behaviour");
  {
    const src = strip(WIDGET);
    check(
      "no controls, retries, quota, policy, or scheduler vocabulary",
      !/mayRun|admission|pause|resume|disable|maintenanceMode|quota|retryAction|ops_scheduler/i.test(src),
    );
    check("no deployment comparison (2C-4 boundary)", !/currentDeploymentSha|deploymentRelation/.test(src));
    check("no convergence-fetch work (2C-6 owns it)", !/convergence/i.test(src));
  }

  if (failures > 0) {
    console.error(`\nprovider-operations.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nprovider-operations.test: all passed.");
}

main();
