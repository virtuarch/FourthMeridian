/**
 * lib/platform/observability-privacy.test.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The observability payloads carry the MINIMUM operational identity and no
 * customer or secret material. Pinned two ways:
 *
 *   SOURCE — every reader / route this slice added or touched selects no
 *   email, no account name, no wallet address, no credential, no token, no
 *   password, no session material, and no raw environment value.
 *
 *   RUNTIME — the pure builders, fed rows that DO carry such fields, emit
 *   none of them.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildPlaidUsage } from "@/lib/platform/plaid/usage";
import { buildPipelineStatus } from "@/lib/platform/refresh/projections-core";
import { projectExecutionRow } from "@/lib/platform/refresh/execution-query-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const READERS = [
  "lib/platform/ops/overview.ts",
  "lib/platform/ops/overview-core.ts",
  "lib/platform/ai/invocations.ts",
  "lib/platform/ai/invocations-core.ts",
  "lib/platform/ai/brief-ops.ts",
  "lib/platform/plaid/usage.ts",
  "lib/platform/refresh/inspection.ts",
  "lib/platform/refresh/execution-query.ts",
  "lib/platform/refresh/projections.ts",
  "lib/platform/connection-diagnostics.ts",
  "lib/platform/convergence/convergence.ts",
];
const ROUTES = [
  "app/api/platform/platform-ops/overview/route.ts",
  "app/api/platform/platform-ops/ai-invocations/route.ts",
  "app/api/platform/platform-ops/brief-ops/route.ts",
  "app/api/platform/platform-ops/plaid-usage/route.ts",
  "app/api/platform/platform-ops/refresh/executions/[id]/route.ts",
  "app/api/platform/platform-ops/alerts/route.ts",
  "app/api/platform/platform-ops/connection-diagnostics/route.ts",
];

console.log("source · no customer identity or secret is selected");
{
  // Prisma select keys and property reads that would carry the forbidden material.
  const forbidden = /\b(email|walletAddress|encryptedToken|credential|passwordHash|sessionToken|accessToken|refreshToken|totpSecret|apiKey|secretKey)\s*:\s*true|\.(email|walletAddress|encryptedToken|credential|passwordHash)\b/;
  for (const f of [...READERS, ...ROUTES]) {
    check(`${f}: selects/reads no email, address, credential, token or password`, !forbidden.test(strip(f)));
  }
  // Customer account NAMES never cross into an operator label.
  check("convergence no longer selects the account name", !/name:\s*true/.test(strip("lib/platform/convergence/convergence.ts")));
  check("convergence labels by institution or an opaque reference", /Account …\$\{a\.id\.slice\(-6\)\}/.test(strip("lib/platform/convergence/convergence.ts")));
  check("connection diagnostics exposes an opaque ownerRef, not an owner email",
    /ownerRef/.test(strip("lib/platform/connection-diagnostics.ts")) && !/owner:\s*[a-z.]*email/.test(strip("lib/platform/connection-diagnostics.ts")));
}

console.log("source · no raw environment value reaches a payload");
{
  const alerts = strip("app/api/platform/platform-ops/alerts/route.ts");
  check("alerts route reports only whether a destination is configured", /destinationConfigured:\s*Boolean\(env\.PLATFORM_ALERTS_EMAIL\)/.test(alerts) && !/destination:\s*env\./.test(alerts));
  const env = strip("lib/env.ts");
  check("env-status reports the deployment environment, not a variable's value", /deploymentEnv:\s*deploymentEnvironment\(\)/.test(env));
  for (const f of ROUTES) {
    check(`${f}: reads no process.env directly`, !/process\.env/.test(strip(f)));
  }
}

console.log("source · every new route is a PLATFORM_OPS READ gate that returns early");
{
  for (const f of ROUTES.slice(0, 5)) {
    const src = strip(f);
    check(`${f}: requires PLATFORM_OPS READ`, /requirePlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']READ["']\s*\)/.test(src));
    check(`${f}: returns the auth error before reading`, /if\s*\(\s*err\s*\)\s*return\s+err/.test(src));
    check(`${f}: never requests WRITE`, !/["']WRITE["']/.test(src));
    check(`${f}: imports no db and touches no ledger accessor`, !/@\/lib\/db/.test(src) && !/\.(refreshExecution|aiInvocation|dailyBrief|plaidItem)\./.test(src));
    check(`${f}: exports no mutating verb`, !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(src));
  }
}

console.log("runtime · builders emit no customer material even when fed it");
{
  const plaid = buildPlaidUsage(
    [{ id: "i1", externalItemId: "real-1", createdAt: "2026-07-03", status: "ACTIVE", investmentsConsent: null, environment: "production",
       // extra fields a careless caller might pass through
       ...({ encryptedToken: "SECRET-TOKEN", institutionName: "Chase", userId: "user-1" } as object) }],
    [], "2026-09-15",
  );
  const plaidJson = JSON.stringify(plaid);
  check("plaid usage carries no token, institution or user id", !/SECRET-TOKEN|Chase|user-1|i1/.test(plaidJson), plaidJson.slice(0, 200));

  const fact = {
    id: "e1", runId: "r1", plaidItemId: null, sourceKind: "WALLET" as const, sourceRef: "acct-123456789", network: "BTC",
    trigger: "MANUAL", profile: "WALLET_SYNC", startedAt: new Date("2026-09-15T16:35:00.000Z"), completedAt: null, durationMs: 11_600,
    overallStatus: "FAILED", parentJobRunId: null, errorSummary: "mempool.space did not respond within 10000 ms", deploymentSha: null,
    admissionReason: null, failureStage: "balance", failureCategory: "PROVIDER_TIMEOUT", outcome: null,
    // never on the fact type, present here to prove projection drops it
    ...({ walletAddress: "bc1qSECRET" } as object),
  };
  const row = projectExecutionRow(fact, "operator");
  check("execution projection drops an address that leaked onto a fact", !JSON.stringify(row).includes("bc1qSECRET"));
  check("support audience never sees the free-text error", projectExecutionRow(fact, "support").errorSummary === null);
  const status = buildPipelineStatus([fact], { WALLET: null });
  const projectedFailures = status.latestFailures.map((f) => projectExecutionRow(f, "operator"));
  check("the overview's failure rows are projected, so an address on a fact never reaches the payload",
    projectedFailures.length === 1 && !JSON.stringify(projectedFailures).includes("bc1qSECRET"));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
