/**
 * lib/entitlements/consumers.test.ts — SOURCE SCAN: every product quota reads the
 * effective-entitlement authority; no role exemption remains at a quota; the
 * register route places a new customer on the default group (and in the invite
 * cohort only when an invite was redeemed); the catalogue route is a
 * GROWTH_REVENUE READ gate on fm_system that names no customer.
 * Run: npx tsx lib/entitlements/consumers.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("Conversations (app/api/ai/chat/route.ts)");
{
  const s = strip("app/api/ai/chat/route.ts");
  check("no SYSTEM_ADMIN role exemption at a quota", !/role\s*!==\s*['"]SYSTEM_ADMIN['"]/.test(s));
  check("resolves the effective entitlements once", (s.match(/entitlementsForUser\(user\.id\)/g) ?? []).length === 1);
  check("refuses when the conversations dimension is off, before any model call", /refuseIfDisabled\(entitlements,\s*'conversations'/.test(s) && s.indexOf("refuseIfDisabled(") < s.indexOf("runStatelessTurn("));
  check("minute window reads aiTurnsPerMinute", /'ai-chat',\s*\{\s*limit:\s*countLimit\(entitlements,\s*'aiTurnsPerMinute'\),\s*windowSec:\s*60\s*\}/.test(s));
  check("hour window reads aiTurnsPerHour", /'ai-chat-hour',\s*\{\s*limit:\s*countLimit\(entitlements,\s*'aiTurnsPerHour'\),\s*windowSec:\s*3600\s*\}/.test(s));
  check("no literal 10 / 60 limits remain", !/limit:\s*10\b/.test(s) && !/limit:\s*60\b/.test(s));
}

console.log("Daily Brief (app/api/brief/**)");
{
  const gen = strip("app/api/brief/generate/route.ts");
  const get = strip("app/api/brief/route.ts");
  check("generate: no role exemption", !/SYSTEM_ADMIN/.test(gen));
  check("generate: dailyBrief gate before the generation call", /refuseIfDisabled\(entitlements,\s*'dailyBrief'/.test(gen) && gen.indexOf("refuseIfDisabled(") < gen.indexOf("generateBriefResponse("));
  check("generate: the 20/min pacing stays (abuse control, not a plan quota)", /'ai-brief-generate',\s*\{\s*limit:\s*20,\s*windowSec:\s*60\s*\}/.test(gen));
  check("read: dailyBrief gate before the read", /refuseIfDisabled\(await entitlementsForUser\(user\.id\),\s*'dailyBrief'/.test(get) && get.indexOf("refuseIfDisabled(") < get.indexOf("readBriefResponse("));
}

console.log("Export (app/api/user/export/route.ts)");
{
  const s = strip("app/api/user/export/route.ts");
  check("exports/day reads the entitlement", /"data-export",\s*\{\s*limit:\s*countLimit\(entitlements,\s*"exportsPerDay"\),\s*windowSec:\s*86_400\s*\}/.test(s));
  check("no literal 3/day remains", !/limit:\s*3\b/.test(s));
}

console.log("Registration (app/api/auth/register/route.ts)");
{
  const s = strip("app/api/auth/register/route.ts");
  const tx = s.slice(s.indexOf("db.$transaction(async (tx)"), s.indexOf("return newUser;"));
  // POLICY EDITOR — the default is the catalogue's (DB default row, else the code
  // DEFAULT_POLICY_GROUP), read BEFORE the transaction by the never-throwing loader.
  check("policy assignment is created INSIDE the registration transaction, on the default group",
    /tx\.customerPolicyAssignment\.create\(\{\s*data:\s*\{\s*userId:\s*newUser\.id,\s*policyGroup:\s*defaultPolicyGroup\s*\}/.test(tx));
  check("…the default group is read from the policy-group catalogue BEFORE the transaction",
    /const defaultPolicyGroup = \(await loadPolicyGroupCatalogue\(\)\)\.defaultKey;/.test(s.slice(0, s.indexOf("db.$transaction(async (tx)"))));
  check("cohort row only when an invite was redeemed, with INVITE_COHORT and source INVITE",
    /if \(betaRequestId\) \{\s*await tx\.customerCohort\.create\(\{\s*data:\s*\{\s*userId:\s*newUser\.id,\s*cohort:\s*INVITE_COHORT,\s*source:\s*"INVITE"\s*\}/.test(tx));
  check("no cohort literal is spelled in the route (catalogue owns the key)", !/CLOSED_BETA_2026/.test(s));
  check("imports the two keys from the catalogue", /from "@\/lib\/entitlements\/catalogue"/.test(s));
}

console.log("Catalogue routes + their ONE reader (lib/platform/policy-groups-read.ts)");
{
  // PLATFORM OPS PHASE 1 UX — re-ruled: the read moved verbatim into a shared
  // module used by the Growth route AND the new PLATFORM_OPS route, so the
  // data-access pins apply to the reader and the gate pins to each route.
  const r = strip("lib/platform/policy-groups-read.ts");
  check("reads through systemDb, not the migration principal", /import \{ systemDb \} from "@\/lib\/db"/.test(r) && !/\bdb\./.test(r.replace(/systemDb\./g, "")));
  check("selects no identity (email / name / username)", !/\b(email|name|username)\s*:\s*true/.test(r));
  check("counts only: groupBy + count", /groupBy\(/.test(r) && /user\.count\(/.test(r) && !/findMany\(/.test(r));
  check("the reader is server-only", /import "server-only"/.test(r));
  for (const [file, area] of [
    ["app/api/platform/growth-revenue/policy-groups/route.ts", "GROWTH_REVENUE"],
    ["app/api/platform/platform-ops/policy-groups/route.ts", "PLATFORM_OPS"],
  ] as const) {
    const s = strip(file);
    check(`${file}: ${area} READ gate, early return`, new RegExp(`requirePlatformAccess\\(\\s*"${area}",\\s*"READ"\\s*\\)`).test(s) && /if \(err\) return err/.test(s));
    check(`${file}: answers from the shared reader, touches no database itself`, /return NextResponse\.json\(await readPolicyGroups\(\)\)/.test(s) && !/@\/lib\/db/.test(s));
    check(`${file}: exports no mutating verb`, !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(s));
  }
}

console.log("consume helper (lib/entitlements/consume.ts)");
{
  const s = strip("lib/entitlements/consume.ts");
  // Owner ruling (2026-10-30) — the default loader also hands the resolver the fail-closed switch.
  check("reads on the tenant role through withTenantDb", /withTenantDb\(userId,\s*\(tx\) => loadEffectiveEntitlements\(tx,\s*userId,\s*entitlementLoadOptions\(\)\)\)/.test(s));
  check("imports no database client of its own", !/from "@\/lib\/db"/.test(s));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
