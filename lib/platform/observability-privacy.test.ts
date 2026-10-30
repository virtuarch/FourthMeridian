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
  // Visual pass V2 — the two counts-only day projections.
  "lib/platform/security/daily.ts",
  "lib/platform/customer/incidents-daily.ts",
  "lib/platform/ops/overview.ts",
  "lib/platform/ops/overview-core.ts",
  "lib/platform/ai/invocations.ts",
  "lib/platform/ai/invocations-core.ts",
  "lib/platform/ai/brief-ops.ts",
  "lib/platform/ai/failures.ts",
  "lib/platform/plaid/usage.ts",
  "lib/platform/refresh/inspection.ts",
  "lib/platform/refresh/execution-query.ts",
  "lib/platform/refresh/projections.ts",
  "lib/platform/connection-diagnostics.ts",
  "lib/platform/convergence/convergence.ts",
  // UX-P1 — the fleet connection reader (PLATFORM_OPS, identity-free) and the
  // CUSTOMER_SUCCESS owner reader (id / username / name only, never email).
  "lib/connections/health.ts",
  "lib/platform/customer/connection-owners.ts",
  // UX-P1 — the attention composition, the PLATFORM_OPS incident projection,
  // the latest-evaluation alert projection and the narrow operator feed.
  "lib/platform/ops/attention.ts",
  "lib/platform/ops/attention-core.ts",
  "lib/platform/incidents/platform-projection.ts",
  "lib/alerts/latest-evaluation.ts",
  "lib/platform/activity/operator-feed.ts",
  "lib/platform/activity/operator-feed-core.ts",
  // BETA C6/C7 — the spend-by-surface reader, the spend authority the alert
  // engine reads (opaque per-user ref only), the thresholds and the safeguards view.
  "lib/platform/ai/spend-by-surface.ts",
  "lib/platform/ai/spend-by-surface-core.ts",
  "lib/platform/ai/spend-health.ts",
  "lib/platform/ai/spend-thresholds.ts",
  "lib/platform/ai/cost-safeguards.ts",
  "lib/platform/ai/customer-spend-today.ts",
  // BETA A1–A8 — the fleet product-analytics reader + pure core (GROWTH_REVENUE,
  // identity-minimised: ids are joins, never output), and the two Growth readers
  // that now fold the same facts.
  "lib/platform/growth/product-analytics.ts",
  "lib/platform/growth/product-analytics-core.ts",
  "lib/platform/activity/activity.ts",
  "lib/platform/growth/growth.ts",
  // PLATFORM SPACES 2.0 — the Growth acquisition reader + pure core (requesters
  // are an md5 digest computed in SQL; ids are joins, never output).
  "lib/platform/growth/acquisition.ts",
  "lib/platform/growth/acquisition-core.ts",
  // PLATFORM SPACES 2.0 — the Security analytics reader + core (GROUP BY in SQL: day, code, count).
  "lib/platform/security/analytics.ts",
  "lib/platform/security/analytics-core.ts",
  // PLATFORM OPS PHASE 1 UX — the shared Policy Group catalogue reader (counts only).
  "lib/platform/policy-groups-read.ts",
];
const ROUTES = [
  "app/api/platform/platform-ops/overview/route.ts",
  "app/api/platform/platform-ops/ai-invocations/route.ts",
  "app/api/platform/platform-ops/brief-ops/route.ts",
  "app/api/platform/platform-ops/plaid-usage/route.ts",
  "app/api/platform/platform-ops/refresh/executions/[id]/route.ts",
  "app/api/platform/platform-ops/alerts/route.ts",
  "app/api/platform/platform-ops/connection-diagnostics/route.ts",
  // UX-P1 — the owner route (CUSTOMER_SUCCESS READ; scanned for secrets and
  // env, not for the PLATFORM_OPS gate — its gate is pinned below).
  "app/api/platform/customer-success/connection-owners/route.ts",
  // UX-P1 — the three new PLATFORM_OPS read routes.
  "app/api/platform/platform-ops/attention/route.ts",
  "app/api/platform/platform-ops/activity/route.ts",
  "app/api/platform/platform-ops/refresh/daily/route.ts",
  // BETA C6/C7 — spend by surface + cost safeguards (PLATFORM_OPS READ; gate pinned in spend-by-surface.test.ts).
  "app/api/platform/platform-ops/ai-spend/route.ts",
  // BETA A1–A8 — the GROWTH_REVENUE analytics route (its gate is pinned below).
  "app/api/platform/growth-revenue/product-analytics/route.ts",
  // PLATFORM SPACES 2.0 — the Growth acquisition route (GROWTH_REVENUE READ; gate pinned below).
  "app/api/platform/growth-revenue/acquisition/route.ts",
  // PLATFORM SPACES 2.0 — the Security analytics route (SECURITY_OPS READ; gate pinned below).
  "app/api/platform/security-ops/analytics/route.ts",
  // PLATFORM OPS PHASE 1 UX — the Policy Group catalogue, PLATFORM_OPS READ (gate pinned in its route.test.ts).
  "app/api/platform/platform-ops/policy-groups/route.ts",
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

console.log("source · owner resolution is a separate CUSTOMER_SUCCESS read (owner decision D4)");
{
  const owners = strip("lib/platform/customer/connection-owners.ts");
  const route = strip("app/api/platform/customer-success/connection-owners/route.ts");
  const fleet = strip("lib/connections/health.ts");
  check("the owner reader selects id, username and name only", /select:\s*\{\s*id:\s*true,\s*user:\s*\{\s*select:\s*\{\s*id:\s*true,\s*username:\s*true,\s*name:\s*true\s*\}\s*\}\s*\}/.test(owners));
  check("the owner reader labels through operatorDisplayName (username → name → opaque)", /operatorDisplayName\(/.test(owners) && /from "\.\/identity-label"/.test(owners));
  check("the owner reader is bounded", /CONNECTION_OWNERS_MAX\s*=\s*50/.test(owners));
  check("the owner route requires CUSTOMER_SUCCESS READ and returns the error first",
    /requirePlatformAccess\(\s*["']CUSTOMER_SUCCESS["']\s*,\s*["']READ["']\s*\)/.test(route) && /if\s*\(\s*err\s*\)\s*return\s+err/.test(route));
  check("the owner route never requests WRITE and exports no mutating verb", !/["']WRITE["']/.test(route) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(route));
  check("the owner route answers 400 on a malformed request", /status:\s*400/.test(route));
  check("the fleet reader never selects a user id, email or name onto a row", !/user:\s*\{\s*select:\s*\{[^}]*(id|email|name|username):\s*true/.test(fleet));
  check("the fleet reader's row type carries no owner identity", !/^\s*(userId|email|ownerEmail|owner)\s*:/m.test(fleet.slice(fleet.indexOf("interface ConnectionHealthRow"), fleet.indexOf("interface ConnectionHealthResult"))));
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

console.log("source · BETA — the product-analytics route is a GROWTH_REVENUE READ gate; the reader is fm_system and emits no identity");
{
  const route = strip("app/api/platform/growth-revenue/product-analytics/route.ts");
  check("the analytics route requires GROWTH_REVENUE READ and returns the error first",
    /requirePlatformAccess\(\s*["']GROWTH_REVENUE["']\s*,\s*["']READ["']\s*\)/.test(route) && /if\s*\(\s*err\s*\)\s*return\s+err/.test(route));
  check("the analytics route never requests WRITE/CONTROL, exports no mutating verb, imports no db, and is no-store",
    !/["'](WRITE|CONTROL)["']/.test(route) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(route) && !/@\/lib\/db/.test(route) && /no-store/.test(route));
  const reader = strip("lib/platform/growth/product-analytics.ts");
  check("the analytics reader reads through fm_system only", /systemDb/.test(reader) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(reader));
  check("the analytics reader selects no name, username, Space name or institution onto any row", !/\b(name|username|institutionName|institution)\s*:\s*true/.test(reader));
  check("the analytics reader selects no user relation (no identity is ever joined)", !/user:\s*\{\s*select/.test(reader));
  const dto = strip("lib/platform/growth/product-analytics-types.ts");
  check("the frozen DTO declares no identity field", !/^\s*(userId|email|username|name|spaceName)\??\s*:/m.test(dto));
}

console.log("source · PLATFORM SPACES 2.0 — the acquisition route is a GROWTH_REVENUE READ gate; the reader never reads an address");
{
  const route = strip("app/api/platform/growth-revenue/acquisition/route.ts");
  check("the acquisition route requires GROWTH_REVENUE READ and returns the error first",
    /requirePlatformAccess\(\s*["']GROWTH_REVENUE["']\s*,\s*["']READ["']\s*\)/.test(route) && /if\s*\(\s*err\s*\)\s*return\s+err/.test(route));
  check("the acquisition route never requests WRITE/CONTROL, exports no mutating verb, imports no db, and is no-store",
    !/["'](WRITE|CONTROL)["']/.test(route) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(route) && !/@\/lib\/db/.test(route) && /no-store/.test(route));
  const reader = strip("lib/platform/growth/acquisition.ts");
  check("the acquisition reader reads through fm_system only", /systemDb/.test(reader) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(reader));
  check("the acquisition reader digests the requester address in SQL and selects no address column",
    /md5\(lower\(trim\("email"\)\)\)\s+AS\s+k/.test(reader) && !/SELECT[^;]*"email"\s*(,|FROM)/.test(reader));
  check("the acquisition reader selects no name, username or user relation", !/\b(name|username)\s*:\s*true/.test(reader) && !/user:\s*\{\s*select/.test(reader));
  const dto = strip("lib/platform/growth/acquisition-types.ts");
  check("the acquisition DTO declares no identity field", !/^\s*(userId|email|username|name|spaceName|requesterKey)\??\s*:/m.test(dto));
}

console.log("source · PLATFORM SPACES 2.0 — the Security analytics route is a SECURITY_OPS READ gate; the reader aggregates in SQL");
{
  const route = strip("app/api/platform/security-ops/analytics/route.ts");
  check("the security analytics route requires SECURITY_OPS READ and returns the error first",
    /requirePlatformAccess\(\s*["']SECURITY_OPS["']\s*,\s*["']READ["']\s*\)/.test(route) && /if\s*\(\s*err\s*\)\s*return\s+err/.test(route));
  check("the security analytics route never requests WRITE/CONTROL, exports no mutating verb, imports no db, and is no-store",
    !/["'](WRITE|CONTROL)["']/.test(route) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(route) && !/@\/lib\/db/.test(route) && /no-store/.test(route));
  const reader = strip("lib/platform/security/analytics.ts");
  check("the security reader reads through fm_system only", /systemDb/.test(reader) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(reader));
  check("the security reader never reads the identifier, key, IP or user agent", !/"ipAddress"|"userAgent"|ipAddress:\s*true|userAgent:\s*true|->>\s*'?(identifier|key)'?|"identifier"|"key"\)/.test(reader));
  check("the security reader only extracts reason / type / result codes from metadata", (reader.match(/byDay\([^)]*"(\w+)"/g) ?? []).every((m) => /"(reason|type|result)"/.test(m)));
  const dto = strip("lib/platform/security/analytics-types.ts");
  check("the security DTO declares no identity field", !/^\s*(userId|email|username|name|identifier|ipAddress|userAgent)\??\s*:/m.test(dto));
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
