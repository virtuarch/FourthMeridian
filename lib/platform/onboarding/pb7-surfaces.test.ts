/**
 * lib/platform/onboarding/pb7-surfaces.test.ts  (PB-7 — gates, identity rules, privacy; source scan)
 *
 *   • the Recently-joined route is CUSTOMER_SUCCESS READ (the Customers list's gate) and the
 *     overview DTO gained no identity;
 *   • the panel is mounted only where the audited Customers list is hosted, and opens rows
 *     through the audited profile (the list's detail route), never a route of its own;
 *   • the Onboarding timeline rides the AUDITED profile route (getCustomerDetail);
 *   • the Platform Ops tile route is PLATFORM_OPS READ and its readers select no owner/identity;
 *   • every PB-7 reader selects no token, cursor, balance, amount or transaction content.
 *
 * Run: npx tsx lib/platform/onboarding/pb7-surfaces.test.ts
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
const gate = (s: string, area: string) => new RegExp(`requirePlatformAccess\\(\\s*["']${area}["']\\s*,\\s*["']READ["']\\s*\\)`).test(s) && /if\s*\(\s*err\s*\)\s*return\s+err/.test(s);

console.log("gates");
{
  const cs = strip("app/api/platform/customer-success/recently-joined/route.ts");
  const ops = strip("app/api/platform/platform-ops/new-connection-imports/route.ts");
  check("recently-joined: CUSTOMER_SUCCESS READ, error first", gate(cs, "CUSTOMER_SUCCESS"));
  check("new-connection-imports: PLATFORM_OPS READ, error first", gate(ops, "PLATFORM_OPS"));
  for (const [f, s] of [["recently-joined", cs], ["new-connection-imports", ops]] as const) {
    check(`${f}: no mutating verb`, !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(s));
  }
  const detailRoute = strip("app/api/platform/customer-success/customers/[userId]/route.ts");
  const detail = strip("lib/platform/customer/customer-detail.ts");
  check("the timeline is built inside getCustomerDetail (the audited profile)", /onboarding:\s*buildOnboardingTimeline\(/.test(detail));
  check("…whose route still records CUSTOMER_PROFILE_VIEWED before returning", /AuditAction\.CUSTOMER_PROFILE_VIEWED/.test(detailRoute) && detailRoute.indexOf("recordOperatorAction") < detailRoute.lastIndexOf("NextResponse.json(detail"));
}

console.log("identity rules");
{
  const overviewTypes = strip("lib/platform/customer/overview-types.ts");
  check("the CS overview DTO carries no recently-joined identities", !/recentlyJoined|RecentlyJoined/.test(overviewTypes));
  const lead = strip("components/platform/leads/CustomerSuccessLead.tsx");
  check("the panel mounts only where the Customers list is hosted", /recentlyJoined=\{hasHosted\(CUSTOMER_LIST_KEY\)\s*\?\s*<CsRecentlyJoinedPanel \/>\s*:\s*null\}/.test(lead));
  const panel = strip("components/platform/leads/CsRecentlyJoinedPanel.tsx");
  check("the panel reads the CS route, not the overview", panel.includes("/api/platform/customer-success/recently-joined") && !panel.includes("customer-success/overview"));
  check("a row opens the hosted list's audited profile", panel.includes("requestOpenCustomer(") && strip("components/platform/widgets/CsCustomersWidget.tsx").includes("CS_OPEN_CUSTOMER_EVENT"));
  for (const f of ["lib/platform/ops/new-connection-imports.ts", "lib/platform/ops/new-connection-imports-core.ts", "components/platform/leads/NewConnectionImportsTile.tsx"]) {
    const s = strip(f);
    check(`${f}: names no identity`, !/\b(userId|email|username|institutionName|ownerId)\b/.test(s));
  }
  const facts = strip("lib/platform/onboarding/import-facts.ts");
  const opsLoader = facts.slice(facts.indexOf("loadImportsLinkedSince"));
  check("the Ops loader selects no owner (userId only as a join filter)", !/userId:\s*true/.test(opsLoader) && /select:\s*ITEM_SELECT,/.test(opsLoader));
  check("ITEM_SELECT carries no owner", !/userId/.test(facts.slice(facts.indexOf("const ITEM_SELECT"), facts.indexOf("} as const"))));
}

console.log("privacy — allowlisted selects");
for (const f of ["lib/platform/onboarding/import-facts.ts", "lib/platform/customer/recently-joined.ts", "lib/platform/refresh/projections.ts", "lib/platform/customer/customer-detail.ts"]) {
  const s = strip(f);
  check(`${f}: selects no token, credential, cursor, balance or amount`, !/\b(encryptedToken|credential|cursor|syncOriginCursor|balance|amount|passwordHash|totpSecret|sessionToken|merchantName|description)\s*:\s*true/.test(s));
}
{
  const p = strip("lib/platform/refresh/projections.ts");
  const ev = p.slice(p.indexOf("export async function getImportEvidence"));
  check("import evidence never returns errorSummary", !/errorSummary\s*:/.test(ev.slice(ev.indexOf("evidence.set"))));
  check("import evidence reads no transaction table", !/\.transaction\./.test(ev));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
