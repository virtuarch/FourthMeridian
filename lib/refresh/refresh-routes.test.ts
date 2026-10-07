/**
 * lib/refresh/refresh-routes.test.ts — source scans of the Refresh All surface
 * and the pure client helpers. Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/refresh/refresh-routes.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describeRefreshOutcomes, phaseForOutcomes } from "@/components/plaid/useManualRefresh";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("POST /api/refresh/all");
{
  const s = strip("app/api/refresh/all/route.ts");
  check("requires a session", /requireUser\(\)/.test(s));
  check("per-user backstop", /limitByUser\(user\.id,\s*"refresh-all"/.test(s));
  check("entitlements are read through a tenant phase", /withTenantDb\(user\.id,\s*\(tx\)\s*=>\s*loadEffectiveEntitlements\(tx,\s*user\.id\)\)/.test(s));
  check("runs the orchestrator as the USER authority", /authority:\s*"USER"/.test(s) && /tenantRefreshDeps\(user\.id\)/.test(s));
  check("never imports the migration principal or systemDb", !/from ["']@\/lib\/db["']/.test(s));
  check("audits REFRESH_ALL_REQUESTED with counts only", /AuditAction\.REFRESH_ALL_REQUESTED/.test(s) && /summary:\s*report\.summary/.test(s) && !/institution|label|balance/.test(s));
  check("the actor is the customer, through the tenant client", /actorId:\s*user\.id/.test(s) && /actorType:\s*"USER"/.test(s) && /tx\.auditLog\.create/.test(s));
}

console.log("lib/refresh — no ambient authority, no second execution path");
{
  for (const f of ["lib/refresh/refresh-all.ts", "lib/refresh/deps.ts", "lib/refresh/wallet-lock.ts", "lib/refresh/wallet-post-sync.ts"]) {
    const s = strip(f);
    check(`${f}: imports neither db nor systemDb`, !/from ["']@\/lib\/db["']/.test(s));
    check(`${f}: never calls runDeferredHistorySync`, !/runDeferredHistorySync\(/.test(s));
  }
  const o = strip("lib/refresh/refresh-all.ts");
  check("Plaid executes ONLY through refreshAllActiveItemsForUser (the canonical fan-out)", /refreshAllActiveItemsForUser\(/.test(o) && !/refreshPlaidItem\(|runFullRefresh\(/.test(o));
  check("wallets execute ONLY through syncWalletByChain", /syncWalletByChain\(/.test(o) && !/syncBtcWallet|syncEthWallet|syncSolWallet/.test(o));
  check("admission is asked once, before any provider work", o.indexOf("admit") < o.indexOf("markPlaidAttempts(") && /REFRESH_EXECUTION/.test(o));
  check("the cooldown is the entitlement, not a literal", /manualBankRefreshCooldownMinutes/.test(o) && !/60 \* 60 \* 1000/.test(o));
  check("operators have no force flag", !/force/.test(o));
}

console.log("Plaid routes use the entitled cooldown");
{
  for (const f of ["app/api/plaid/refresh/route.ts", "app/api/plaid/sync/route.ts"]) {
    const s = strip(f);
    check(`${f}: loads entitlements through a tenant phase`, /loadEffectiveEntitlements\(tx,\s*user\.id\)/.test(s));
    check(`${f}: every cooldown check passes the entitled window`, !/checkManualRefreshCooldown\([^,)]*\)/.test(s) && /checkManualRefreshCooldown\([^)]*cooldownMs\)/.test(s));
    check(`${f}: no role exemption`, !/SYSTEM_ADMIN/.test(s));
  }
  const r = strip("app/api/plaid/refresh/route.ts");
  check("the bulk branch is a thin caller of the orchestrator, Plaid-only", /refreshAllForUser\(/.test(r) && /listWallets:\s*async\s*\(\)\s*=>\s*\[\]/.test(r) && !/markManyManualRefreshed/.test(r));
}

console.log("wallet sync route gains the guards");
{
  const s = strip("app/api/accounts/[id]/sync/route.ts");
  check("asks platform admission", /admitOperationalWork\(\{\s*work:\s*"REFRESH_EXECUTION"/.test(s));
  check("judges the cooldown on the Connection clock with the entitled window", /lastManualRefreshAt/.test(s) && /manualBankRefreshCooldownMinutes/.test(s));
  check("hourly ceiling is the entitled value, no role exemption", /manualWalletRefreshPerHour/.test(s) && !/SYSTEM_ADMIN/.test(s));
  check("claims, marks and releases through the shared guards", /guards\.claimWallet\(/.test(s) && /guards\.markWalletAttempt\(/.test(s) && /guards\.releaseWallet\(/.test(s));
  check("finishes through the shared finaliser", /finalizeWalletSync\(/.test(s));
  check("the gate is still the one literal tenant phase", (s.match(/withTenantDb\(/g) ?? []).length === 1);
}

console.log("client hook");
{
  const s = strip("components/plaid/useManualRefresh.ts");
  check("calls the provider-agnostic route", /fetch\("\/api\/refresh\/all"/.test(s) && !/api\/plaid\/refresh/.test(s));
  const started = { decision: "STARTED" as const };
  check("all started ⇒ done", phaseForOutcomes([started, started]) === "done");
  check("nothing to refresh ⇒ done", phaseForOutcomes([]) === "done");
  check("some started ⇒ partial", phaseForOutcomes([started, { decision: "SKIPPED", reason: "COOLDOWN" }]) === "partial");
  check("none started, none failed ⇒ cooldown", phaseForOutcomes([{ decision: "SKIPPED", reason: "COOLDOWN" }, { decision: "REFUSED", reason: "NOT_REFRESHABLE" }]) === "cooldown");
  check("none started, one failed ⇒ error", phaseForOutcomes([{ decision: "FAILED", reason: "ERROR" }]) === "error");
  const banner = describeRefreshOutcomes([started, started, started, { decision: "SKIPPED", reason: "COOLDOWN", retryAfterSeconds: 42 * 60 }, { decision: "REFUSED", reason: "NOT_REFRESHABLE" }]);
  check("banner is terse and names every fact", banner === "3 refreshed · 1 on cooldown (42m) · 1 not refreshable", banner);
  check("banner never says everything refreshed when something was skipped", !/all|everything|synced/i.test(banner));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
