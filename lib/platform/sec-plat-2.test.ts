/**
 * lib/platform/sec-plat-2.test.ts  (SEC-PLAT-2 — operator authorization, privacy and audit)
 *
 * Regression pins for the SEC-PLAT-2 security PR. Pure checks + source scans:
 * no DB, no session, no network.
 *
 *   A  shared access enforcement — the platform area page uses the one guard
 *   B  /merchant-ops is a proxy-protected page
 *   C  privacy — Growth carries no Space names / ids
 *   D  required audit reasons + the operator-action envelope (growth, merchant)
 *   E  refused CONTROL mutations are recorded, without submitted values
 *   F  CONTROL reads are fresh; the webhook dry run is recorded
 *   G  request-reauth is rate-limited (it notifies a customer)
 *   H  the grant matrix survives the admin list bound
 *   I  the operator feed lists and labels every operator action
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AuditAction, OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { buildOperatorActionData, OPERATOR_REASON_CODES, REASON_REQUIRED_ACTIONS } from "@/lib/audit";
import { buildControlRefusalInput } from "@/lib/platform/control-refusal.core";
import { OPERATOR_REASON_FIELD_CODES } from "@/components/platform/widgets/OperatorReasonField";
import { OPERATOR_ACTION_LABEL } from "@/components/platform/widgets/SecOperatorActionsWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** The body of `export async function NAME` up to the next top-level export. */
function handler(rel: string, name: string): string {
  const s = code(rel);
  const i = s.indexOf(`export async function ${name}`);
  if (i < 0) return "";
  const j = s.indexOf("\nexport ", i + 1);
  return s.slice(i, j < 0 ? undefined : j);
}

// ── A ───────────────────────────────────────────────────────────────────────
console.log("A · the platform area page uses the shared guard");
{
  const page = code("app/(shell)/dashboard/platform/[area]/page.tsx");
  check("requirePlatformAccess(area, \"READ\") is the gate", page.includes('requirePlatformAccess(area, "READ")'));
  check("no page-local session or grant read remains", !page.includes("getServerSession") && !page.includes("platformGrant") && !page.includes("hasPlatformAccess"));
  check("401 → login, 403 → directory, anything else fails closed (throws)",
    /status === 401\) return redirectToLogin\(\)/.test(page) && /status === 403\) redirect\("\/dashboard\/platform"\)/.test(page) && /throw new Error\(/.test(page));
  check("the guard runs before the Space read", page.indexOf("requirePlatformAccess(") < page.indexOf("db.space.findUnique"));
}

// ── B ───────────────────────────────────────────────────────────────────────
console.log("B · /merchant-ops is a proxy-protected page");
{
  const proxy = code("proxy.ts");
  check("matcher lists /merchant-ops/:path*", /matcher:[\s\S]*"\/merchant-ops\/:path\*"/.test(proxy));
  check("isProtectedPagePath covers /merchant-ops", /pathname === "\/merchant-ops" \|\| pathname\.startsWith\("\/merchant-ops\/"\)/.test(proxy));
  const page = code("app/merchant-ops/page.tsx");
  check("the page keeps its own MERCHANT_OPS grant gate", page.includes('requirePlatformAccess("MERCHANT_OPS", "READ")'));
}

// ── C ───────────────────────────────────────────────────────────────────────
console.log("C · Growth is identity-minimized");
{
  const activity = code("lib/platform/activity/activity.ts");
  check("the activity projection carries no Space name", !/spaceName/.test(activity));
  check("SPACE_SWITCH rows are read as spaceId only", /select: \{ spaceId: true \}/.test(activity) && !/metadata: true/.test(activity));
  const widget = code("components/platform/widgets/OpsActivityWidget.tsx");
  check("the Growth activity widget renders no Space name or id", !/spaceName|spaceId|topSpaces/.test(widget));
}

// ── D ───────────────────────────────────────────────────────────────────────
console.log("D · required reasons + the operator-action envelope");
{
  for (const a of ["BETA_MODE_CHANGED", "PRODUCT_STATUS_CHANGED", "BETA_INVITATION_REVOKED", "MERCHANT_MERGE_APPLIED", "MERCHANT_MERGE_DISMISSED"] as const) {
    check(`${a} is reason-required`, REASON_REQUIRED_ACTIONS.has(AuditAction[a]));
  }
  for (const a of ["BETA_ACCESS_APPROVED", "BETA_ACCESS_DENIED", "BETA_INVITATION_RESENT", "BETA_INVITATION_CREATED"] as const) {
    check(`${a} stays reason-optional (the action is the reason)`, !REASON_REQUIRED_ACTIONS.has(AuditAction[a]));
  }
  let threw = false;
  try {
    buildOperatorActionData({ actor: { userId: "op", via: "PLATFORM_GRANT", area: "GROWTH_REVENUE" }, action: AuditAction.BETA_MODE_CHANGED,
      target: { kind: "PLATFORM_SETTING", id: "registration_mode" }, result: "SUCCESS" });
  } catch { threw = true; }
  check("a mode change without a reason cannot be built", threw);

  const GROWTH = [
    "app/api/platform/growth-revenue/registration-mode/route.ts",
    "app/api/platform/growth-revenue/product-status/route.ts",
    "app/api/platform/growth-revenue/invitations/route.ts",
    "app/api/platform/growth-revenue/requests/[id]/approve/route.ts",
    "app/api/platform/growth-revenue/requests/[id]/deny/route.ts",
    "app/api/platform/growth-revenue/requests/[id]/resend/route.ts",
    "app/api/platform/growth-revenue/requests/[id]/revoke/route.ts",
  ];
  for (const f of GROWTH) {
    const s = code(f);
    check(`${f}: recordOperatorAction with the grant-derived actor, no raw auditLog.create`,
      s.includes("recordOperatorAction(") && s.includes('operatorActorFrom(auth, "GROWTH_REVENUE")') && !s.includes("auditLog.create"));
  }
  for (const [f, write] of [
    ["app/api/platform/growth-revenue/registration-mode/route.ts", "setSetting("],
    ["app/api/platform/growth-revenue/product-status/route.ts", "setSetting("],
    ["app/api/platform/growth-revenue/requests/[id]/revoke/route.ts", "$transaction("],
  ] as const) {
    const s = code(f);
    check(`${f}: the reason is parsed BEFORE the write`, s.includes("parseOperatorReason(") && s.indexOf("parseOperatorReason(") < s.indexOf(write));
  }
  const revoke = code("app/api/platform/growth-revenue/requests/[id]/revoke/route.ts");
  check("revoke: the state change and its audit commit in ONE transaction",
    /\$transaction\(async \(tx\) => \{[\s\S]*tx\.betaAccessRequest\.update[\s\S]*recordOperatorAction\(tx,/.test(revoke));

  const merchant = code("lib/transactions/merchant-merge-review.ts");
  check("merchant decisions record through the envelope with a MERCHANT_PAIR target, never a raw auditLog.create",
    (merchant.match(/recordOperatorAction\(tx,/g) ?? []).length === 2 && /kind: "MERCHANT_PAIR"/.test(merchant) && !merchant.includes("auditLog.create"));
  const decide = code("app/api/merchant-ops/decide/route.ts");
  check("decide: fresh MERCHANT_OPS WRITE, then the reason, then the decision",
    decide.indexOf('requireFreshPlatformAccess("MERCHANT_OPS", "WRITE")') > -1
      && decide.indexOf('requireFreshPlatformAccess("MERCHANT_OPS", "WRITE")') < decide.indexOf("parseOperatorReason(")
      && decide.indexOf("parseOperatorReason(") < decide.indexOf("applyMergeReviewDecision("));

  const beta = code("components/platform/widgets/GrowthBetaRequestsWidget.tsx");
  check("the beta widget sends a reason with mode / status / revoke, and blocks confirm until one is chosen",
    (beta.match(/reason: reasonPayload\(reason\)/g) ?? []).length === 3 && (beta.match(/confirmDisabled=\{reasonPayload\(reason\) === null\}/g) ?? []).length === 3);
  const list = code("app/merchant-ops/MergeReviewList.tsx");
  // Owner review 2026-10-31: both verdicts confirm through ONE dialog that
  // collects the reason, so the gate is the dialog's confirm (and decide() itself).
  check("the merge review list sends the reason and refuses to confirm either verdict without one",
    /reason: chosen/.test(list) && /confirmDisabled=\{chosen === null\}/.test(list) && /if \(!pending \|\| chosen === null\) return;/.test(list));
  check("the client reason-code copy equals OPERATOR_REASON_CODES",
    JSON.stringify(OPERATOR_REASON_FIELD_CODES) === JSON.stringify(OPERATOR_REASON_CODES));
  check("no reason is pre-selected in the shared field", /code: "", note: ""/.test(code("components/platform/widgets/OperatorReasonField.tsx")));
}

// ── E ───────────────────────────────────────────────────────────────────────
console.log("E · refused CONTROL mutations are recorded — without submitted values");
{
  const actor = { userId: "op", via: "PLATFORM_GRANT" as const, area: "PLATFORM_OPS" };
  const hostile = buildControlRefusalInput(actor, {
    control: "refresh-cadence", verb: "change", code: "VALIDATION",
    targetKey: "victim@example.com 4111111111111111", reasonCode: "NOT_A_CODE",
  });
  const row = buildOperatorActionData(hostile);
  const json = JSON.stringify(row);
  check("action PLATFORM_CONTROL_REFUSED, result REFUSED", row.action === AuditAction.PLATFORM_CONTROL_REFUSED && /"result":"REFUSED"/.test(json));
  check("an unvalidated target is recorded as 'unknown'", /"id":"refresh-cadence:unknown"/.test(json));
  check("nothing hostile reaches the row (no email, no digit run)", !/@|\d{4,}/.test(json.replace(/"userId":"[^"]*"/, "")));
  check("an invalid reason code is dropped, not recorded", !("reason" in (row.metadata as Record<string, unknown>)));
  const ok = buildOperatorActionData(buildControlRefusalInput(actor, { control: "job-cadence", verb: "reset", code: "CONFLICT", targetKey: "sync-banks", reasonCode: "INCIDENT" }));
  const m = ok.metadata as Record<string, unknown>;
  check("a known target + reason code are kept; the detail is control / verb / refusal only",
    JSON.stringify(m.target) === JSON.stringify({ kind: "PLATFORM_SETTING", id: "job-cadence:sync-banks" })
      && JSON.stringify(m.reason) === JSON.stringify({ code: "INCIDENT" })
      && m.control === "job-cadence" && m.verb === "reset" && m.refusal === "CONFLICT");
  check("PLATFORM_CONTROL_REFUSED is not reason-required (a missing-reason refusal must still record)",
    !REASON_REQUIRED_ACTIONS.has(AuditAction.PLATFORM_CONTROL_REFUSED));
  for (const [f, verbs] of [
    ["app/api/platform/platform-ops/policies/route.ts", ["PATCH", "DELETE"]],
    ["app/api/platform/platform-ops/job-cadence/route.ts", ["PATCH", "DELETE"]],
    ["app/api/platform/platform-ops/ai-cost-controls/route.ts", ["PATCH"]],
  ] as const) {
    for (const v of verbs) {
      const h = handler(f, v);
      check(`${f} ${v}: every refusal past the grant check goes through refuse() (no bare NextResponse.json return)`,
        h.includes("recordControlRefusal(") && !/return NextResponse\.json\(/.test(h) && /result\.ok \? respond\(result\) : refuse\(respond\(result\)/.test(h));
      check(`${f} ${v}: a 429 is not recorded (the limit returns before refuse is defined)`,
        h.indexOf("if (limited) return limited;") > -1 && h.indexOf("if (limited) return limited;") < h.indexOf("const refuse"));
    }
  }
}

// ── F ───────────────────────────────────────────────────────────────────────
console.log("F · CONTROL reads are fresh; the dry run is recorded");
{
  for (const f of ["app/api/platform/platform-ops/plaid-webhooks/route.ts", "app/api/platform/platform-ops/connections/[id]/webhook/route.ts"]) {
    check(`${f}: no cached CONTROL check`, !/requirePlatformAccess\(/.test(code(f)));
  }
  const get = handler("app/api/platform/platform-ops/connections/[id]/webhook/route.ts", "GET");
  check("the dry run records PLAID_ITEM_WEBHOOK_DRY_RUN (target + outcome word, best-effort)",
    /AuditAction\.PLAID_ITEM_WEBHOOK_DRY_RUN/.test(get) && /kind: "PLAID_ITEM", id/.test(get) && /\.catch\(/.test(get) && !/providerError:\s*r\.providerError[\s\S]*detail/.test(get));
}

// ── G ───────────────────────────────────────────────────────────────────────
console.log("G · request-reauth is bounded (it notifies a customer)");
{
  const s = handler("app/api/platform/platform-ops/connections/[id]/request-reauth/route.ts", "POST");
  check("per-operator limit before any read", s.indexOf("limitByUser(") > -1 && s.indexOf("limitByUser(") < s.indexOf("plaidItem.findUnique"));
  check("per-connection limit before the customer is notified", s.indexOf("limitByKey(item.id") > -1 && s.indexOf("limitByKey(item.id") < s.indexOf("notifyItemSyncFailed("));
}

// ── H ───────────────────────────────────────────────────────────────────────
console.log("H · the grant matrix survives the admin list bound");
{
  const s = code("app/admin/platform-access/page.tsx");
  check("loads USER accounts server-filtered and reads `truncated`", s.includes("/api/admin/users?role=USER") && s.includes("u.truncated === true"));
  check("searches on the server when truncated", /const serverSearchActive = truncated && serverQuery\.length >= 2;/.test(s) && /if \(!serverSearchActive\) return;/.test(s) && s.includes("&search=${encodeURIComponent(q)}"));
  check("every ACTIVE grant holder is always listed", /for \(const g of grants\)[\s\S]{0,120}g\.status === "ACTIVE"/.test(s));
}

// ── I ───────────────────────────────────────────────────────────────────────
console.log("I · the operator feed lists and labels every operator action");
{
  for (const a of ["MERCHANT_MERGE_APPLIED", "MERCHANT_MERGE_DISMISSED", "PLATFORM_CONTROL_REFUSED", "PLAID_ITEM_WEBHOOK_DRY_RUN"] as const) {
    check(`${a} is on the Security Ops operator feed`, OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction[a]));
  }
  const unlabeled = OPERATOR_ACTION_FEED_ACTIONS.filter((a) => !(a in OPERATOR_ACTION_LABEL));
  check("every feed action has a human label", unlabeled.length === 0, unlabeled.join(", "));
}

if (failures > 0) {
  console.error(`\nsec-plat-2: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nsec-plat-2: all checks passed.");
