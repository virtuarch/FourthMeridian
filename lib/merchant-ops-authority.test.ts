/**
 * lib/merchant-ops-authority.test.ts  (MERCHANT-OPS AUTHORITY, 2026-10-06)
 *
 * Merchant Ops is PLATFORM authority. A merge rewrites merchant identity for
 * every tenant; it used to be gated by MEMBER of an ordinary Space named by
 * MERCHANT_OPS_SPACE_ID, so any member — and anyone that Space's admins invited —
 * could do it. These checks pin the replacement: READ grant to view, FRESH WRITE
 * grant to decide, and no Space-membership path anywhere. The merge guarantees
 * (eligibility, in-transaction decision + audit, recovery snapshot, rollback) are
 * proven against a real database in scripts/rls-foreground-acceptance.ts 58-62.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PLATFORM_AREAS, ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import { PLATFORM_AREA_WORKSPACES } from "@/lib/platform/workspaces";
import { MUTATION_FAMILIES } from "@/lib/platform/capability-classification";
import { AuditAction } from "@/lib/audit-actions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const ROUTE = "app/api/merchant-ops/decide/route.ts";
const PAGE  = "app/merchant-ops/page.tsx";

console.log("Merchant Ops — platform authority, never Space membership");

check("MERCHANT_OPS is a registered platform area with a workspace", ALL_PLATFORM_AREAS.includes("MERCHANT_OPS")
  && PLATFORM_AREAS.MERCHANT_OPS.key === "MERCHANT_OPS"
  && PLATFORM_AREA_WORKSPACES.MERCHANT_OPS.some((w) => w.sections.includes("merchant_review")));

const route = code(ROUTE);
check("decide requires a FRESH MERCHANT_OPS grant at WRITE", /await requireFreshPlatformAccess\("MERCHANT_OPS", "WRITE"\)/.test(route));
check("…before the body is read or any decision runs",
  route.indexOf('requireFreshPlatformAccess("MERCHANT_OPS", "WRITE")') < route.indexOf("req.json()")
  && route.indexOf('requireFreshPlatformAccess("MERCHANT_OPS", "WRITE")') < route.indexOf("applyMergeReviewDecision("));

const page = code(PAGE);
check("the review page requires a MERCHANT_OPS grant at READ", /await requirePlatformAccess\("MERCHANT_OPS", "READ"\)/.test(page));
check("…and only WRITE (or break-glass) enables the decision buttons", /canDecide/.test(page) && /LEVEL_RANK\.WRITE/.test(page));

for (const [f, src] of [[ROUTE, route], [PAGE, page]] as const) {
  check(`${f}: no Space-membership gate (requireSpaceRole / requireMerchantOpsMember / MERCHANT_OPS_SPACE_ID)`,
    !/requireSpaceRole|requireMerchantOpsMember|MERCHANT_OPS_SPACE_ID|merchantOpsSpaceId/.test(src));
}
check("the Space-membership gate module is gone", !existsSync(path.join(process.cwd(), "lib/merchant-ops-access.ts")));
check("the MERCHANT_OPS_SPACE_ID setting is gone from the env surface",
  !/MERCHANT_OPS_SPACE_ID/.test(code("lib/env.ts")) && !/MERCHANT_OPS_SPACE_ID/.test(read(".env.example")));

const family = MUTATION_FAMILIES.find((f) => f.key === "merchant-identity-decisions");
check("the decision is a classified WRITE mutation family carried by the route",
  family?.status === "SHIPPED" && family.capability === "WRITE" && (family.routes ?? []).includes(ROUTE));

check("merge and dismissal each have a typed audit action",
  AuditAction.MERCHANT_MERGE_APPLIED === "MERCHANT_MERGE_APPLIED" && AuditAction.MERCHANT_MERGE_DISMISSED === "MERCHANT_MERGE_DISMISSED");

const review = code("lib/transactions/merchant-merge-review.ts");
check("the decision and the audit record are written through the merge engine's in-transaction hook",
  /withinTransaction:\s*async \(tx, applied\)/.test(review) && /recordMergeDecision\(tx,/.test(review) && /tx\.auditLog\.create\(/.test(review));
check("no decision or audit write happens outside a transaction",
  !/recordMergeDecision\(client,/.test(review) && !/client\.auditLog\.create\(/.test(review));

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll Merchant Ops authority checks passed.");
