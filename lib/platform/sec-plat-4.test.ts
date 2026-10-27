/**
 * lib/platform/sec-plat-4.test.ts  (SEC-PLAT-4 — Growth users identity removal + CS-owned deactivation)
 *
 * Owner rulings 2026-10-27: remove customer usernames from Growth's users list,
 * keep useful aggregate Growth analytics; move customer deactivation out of the
 * Growth API authorization boundary into Customer Success, preserving
 * server-side authorization, the required reason, operator logging and tests.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AuditAction } from "@/lib/audit-actions";
import { REASON_REQUIRED_ACTIONS } from "@/lib/audit";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const OLD = "app/api/platform/growth-revenue/users/[userId]/route.ts";
const NEW = "app/api/platform/customer-success/customers/[userId]/access/route.ts";

console.log("A · deactivation lives in Customer Success only");
{
  check("the Growth per-user mutation route is gone", !existsSync(path.join(ROOT, OLD)));
  const s = code(NEW);
  check("fresh CUSTOMER_SUCCESS WRITE — and no Growth gate", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\)/.test(s) && !/GROWTH_REVENUE/.test(s));
  check("the reason is parsed before any read (required)", s.indexOf("parseOperatorReason(") > -1 && s.indexOf("parseOperatorReason(") < s.indexOf("user.findUnique("));
  check("ACCOUNT_DEACTIVATED / REACTIVATED stay reason-required",
    REASON_REQUIRED_ACTIONS.has(AuditAction.ACCOUNT_DEACTIVATED) && REASON_REQUIRED_ACTIONS.has(AuditAction.ACCOUNT_REACTIVATED));
  check("state change + operator action commit together, actor area CUSTOMER_SUCCESS",
    (s.match(/systemDb\.\$transaction\(async \(tx\) =>/g) ?? []).length === 2 && /recordOperatorAction\(tx,/.test(s) && s.includes('operatorActorFrom(auth, "CUSTOMER_SUCCESS")'));
  check("guards kept: no SYSTEM_ADMIN target, no self-target", /UserRole\.SYSTEM_ADMIN\) return NextResponse\.json/.test(s) && /target\.id === auth\.user\.id/.test(s));
  check("deactivation still revokes every session afterwards", s.indexOf("deactivatedAt: now") < s.indexOf("revokeAllUserSessions("));
  check("operator surface on fm_system (no migration-principal db)", /import \{ systemDb \} from "@\/lib\/db"/.test(s) && !/\bdb\./.test(s.replace(/systemDb\./g, "")));
  const detail = code("lib/platform/customer/customer-detail.ts");
  check("the customer profile points its action at the CS route", /\/api\/platform\/customer-success\/customers\/\$\{user\.id\}\/access/.test(detail) && !/growth-revenue\/users/.test(detail));
}

console.log("B · Growth users is aggregates only");
{
  const r = code("app/api/platform/growth-revenue/users/route.ts");
  check("GROWTH_REVENUE READ gate kept", /requirePlatformAccess\("GROWTH_REVENUE", "READ"\)/.test(r));
  check("no exported POST/PUT/PATCH/DELETE", !/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)/.test(r));
  check("no identity field selected or returned", !/(email|name|username|id)\s*:\s*(true|u\.)/.test(r) && !/findMany\(/.test(r));
  check("no search parameter (a search box is an identity oracle)", !/searchParams|contains:/.test(r));
  check("counts only: customer population (role USER)", /role: UserRole\.USER/.test(r) && /\.count\(/.test(r));
  const w = code("components/platform/widgets/OpsUsersWidget.tsx");
  check("the widget renders aggregate tiles and no per-user row", /WidgetStat value=\{data\.total\}/.test(w) && !/\.map\(\(u\)/.test(w));
  check("the widget points operators to Customer Success", /OPS_USERS_MOVED_LINE/.test(w));
}

if (failures > 0) {
  console.error(`\nsec-plat-4: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nsec-plat-4: all checks passed.");
