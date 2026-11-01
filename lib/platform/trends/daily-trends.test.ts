/**
 * lib/platform/trends/daily-trends.test.ts  (Platform visual pass V2)
 *
 * The two counts-only day projections behind the Overview trends for Security
 * and Customer Success: pure bucketing + source pins on what the readers may
 * select and who may call the routes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { countByDay, utcDay, windowDayKeys, windowStart } from "@/lib/platform/trends/daily-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("pure day bucketing");
{
  const now = new Date("2026-10-28T09:30:00Z");
  const keys = windowDayKeys(now, 14);
  check("14 contiguous UTC days ending today, ascending", keys.length === 14 && keys[0] === "2026-10-15" && keys[13] === "2026-10-28"
    && keys.every((k, i) => i === 0 || Date.parse(k) - Date.parse(keys[i - 1]) === 86_400_000));
  check("window starts at 00:00Z of the first day", windowStart(now, 14).toISOString() === "2026-10-15T00:00:00.000Z");
  const c = countByDay(keys, [new Date("2026-10-28T00:00:00Z"), new Date("2026-10-28T23:59:59Z"), new Date("2026-10-15T00:00:00Z"), new Date("2026-10-14T23:59:59Z"), null]);
  check("counts per UTC day; out-of-window and null ignored; empty days are observed zeros",
    c["2026-10-28"] === 2 && c["2026-10-15"] === 1 && c["2026-10-20"] === 0 && Object.keys(c).length === 14 && !("2026-10-14" in c));
  check("utcDay is the UTC calendar day", utcDay(new Date("2026-10-27T23:30:00-03:00")) === "2026-10-28");
}

console.log("Security reader — counts only, no identity, no metadata load");
{
  const s = code("lib/platform/security/daily.ts");
  const selects = [...s.matchAll(/select:\s*\{([^}]*)\}/g)].map((m) => m[1].trim());
  check("every read selects createdAt and nothing else", selects.length === 3 && selects.every((x) => x === "createdAt: true"), selects.join(" | "));
  check("the denial split is a DB-side JSON filter (metadata is filtered, never selected)", /metadata: denialFilter/.test(s) && /NOT: \{ metadata: denialFilter \}/.test(s) && !/metadata: true/.test(s));
  check("fm_system reader with a row cap and a floor flag", /systemDb\.auditLog\.findMany/.test(s) && /take: SECURITY_DAILY_ROW_CAP/.test(s) && /floor:/.test(s));
  const r = code("app/api/platform/security-ops/daily/route.ts");
  check("route: SECURITY_OPS READ, GET only, no-store", /requirePlatformAccess\("SECURITY_OPS", "READ"\)/.test(r) && !/export async function (POST|PUT|PATCH|DELETE)/.test(r) && /no-store/.test(r));
}

console.log("Customer Success reader — counts only, no subject, no detail");
{
  const s = code("lib/platform/customer/incidents-daily.ts");
  check("selects exactly three timestamps", /select: \{ createdAt: true, firstOccurredAt: true, resolvedAt: true \}/.test(s));
  check("never touches detail, account, item, kind or subject", !/detail|financialAccount|plaidItem|kind|subject|incidentKey/.test(s.replace(/import[^;]+;/g, "")));
  check("fm_system reader with a row cap and a floor flag", /systemDb\.syncIssue\.findMany/.test(s) && /take: INCIDENTS_DAILY_ROW_CAP/.test(s) && /floor:/.test(s));
  const r = code("app/api/platform/customer-success/incidents-daily/route.ts");
  check("route: CUSTOMER_SUCCESS READ, GET only, no-store", /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\)/.test(r) && !/export async function (POST|PUT|PATCH|DELETE)/.test(r) && /no-store/.test(r));
}

if (failures > 0) {
  console.error(`\ndaily-trends: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\ndaily-trends: all checks passed.");
