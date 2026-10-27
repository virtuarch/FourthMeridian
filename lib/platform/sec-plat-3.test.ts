/**
 * lib/platform/sec-plat-3.test.ts  (SEC-PLAT-3 — authorized customer-profile access + minimized account lists)
 *
 * Owner ruling P-4 (2026-10-27): Customer Success may resolve customer identity
 * under explicit authorization; Platform Operations and Growth stay
 * identity-minimized; account LISTS show institution · type · masked last
 * digits; full account names only in the authorized, audited detail.
 *
 *   A  the minimized / detail account label (pure)
 *   B  operator LISTS never select the account name
 *   C  every customer-profile open is audited first, fail-closed
 *   D  full names appear only in the audited profile, scoped to that customer
 *   E  the audit trail is visible to Security Ops and not to the customer
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AuditAction, OPERATOR_ACTION_FEED_ACTIONS, USER_SECURITY_HISTORY_ACTIONS } from "@/lib/audit-actions";
import { REASON_REQUIRED_ACTIONS } from "@/lib/audit";
import { detailAccountLabel, maskedDigits, minimizedAccountLabel, minimizedAccountPart } from "@/lib/platform/incidents/account-label";
import { projectIncidents } from "@/lib/platform/customer/customer-core";
import { OPERATOR_ACTION_LABEL } from "@/components/platform/widgets/SecOperatorActionsWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── A ───────────────────────────────────────────────────────────────────────
console.log("A · account labels");
{
  check("minimized: institution · type · ••last4", minimizedAccountLabel({ institution: "Chase", type: "checking", mask: "1234" }) === "Chase · Checking ••1234");
  check("only the last 4 digits of a longer mask, digits only", maskedDigits("00-98765") === "••8765" && maskedDigits("ab") === null && maskedDigits(null) === null);
  check("no mask ⇒ type word alone; unknown type ⇒ 'Account'", minimizedAccountPart({ type: "savings", mask: null }) === "Savings" && minimizedAccountPart({ type: "weird", mask: null }) === "Account");
  check("no institution ⇒ the account part alone", minimizedAccountLabel({ institution: null, type: "debt", mask: "9" }) === "Debt ••9");
  check("detail label adds the customer's account name", detailAccountLabel({ institution: "Chase", type: "checking", mask: "1234", name: "Rent fund" }) === "Rent fund (Chase · Checking ••1234)");
  check("detail label without a name is the minimized label", detailAccountLabel({ institution: "Chase", type: "checking", mask: null, name: "  " }) === "Chase · Checking");
}

// ── B ───────────────────────────────────────────────────────────────────────
console.log("B · operator lists never read the account name");
{
  const preview = code("lib/platform/incidents/preview.ts");
  check("the incident preview selects institution / type / mask, not name",
    /financialAccount\.findMany\(\{[\s\S]*?select: \{ id: true, institution: true, type: true, mask: true \}/.test(preview) && !/name: true/.test(preview));
  check("…and labels the account through the minimized helper", /secondary: minimizedAccountPart\(acct\)/.test(preview) && !/acct\.name/.test(preview));
  check("Platform Ops attention consumes that same minimized preview", /getIncidentPreview\(/.test(code("lib/platform/ops/attention.ts")));
  check("Customer Success sync issues consume that same minimized preview", /getIncidentPreview\(/.test(code("app/api/platform/customer-success/sync-issues/route.ts")));
}

// ── C ───────────────────────────────────────────────────────────────────────
console.log("C · every customer-profile open is audited, fail-closed");
{
  const route = code("app/api/platform/customer-success/customers/[userId]/route.ts");
  check("CUSTOMER_SUCCESS READ gate", route.includes('requirePlatformAccess("CUSTOMER_SUCCESS", "READ")'));
  check("CUSTOMER_PROFILE_VIEWED recorded with the grant-derived actor and the customer as target",
    /AuditAction\.CUSTOMER_PROFILE_VIEWED/.test(route) && route.includes('operatorActorFrom(auth, "CUSTOMER_SUCCESS")') && /target: \{ kind: "USER", id: userId \}/.test(route));
  check("the audit is written BEFORE the profile is returned",
    route.indexOf("recordOperatorAction(") > -1 && route.indexOf("recordOperatorAction(") < route.lastIndexOf("NextResponse.json(detail"));
  check("a failed audit refuses the view (503), it never serves unaudited",
    /catch \(e\) \{[\s\S]*status: 503/.test(route));
  check("the audit carries no profile content", !/detail: \{[^}]*(email|name|institution|account)/.test(route));
  check("not reason-required (a read, not a change)", !REASON_REQUIRED_ACTIONS.has(AuditAction.CUSTOMER_PROFILE_VIEWED));
  check("the profile response is not cached", /"Cache-Control": "no-store"/.test(route));
}

// ── D ───────────────────────────────────────────────────────────────────────
console.log("D · full account names only in the audited profile");
{
  const detail = code("lib/platform/customer/customer-detail.ts");
  check("the profile names accounts only for THIS customer's open incidents",
    /issues\.map\(\(i\) => i\.financialAccountId\)\.filter\(\(x\): x is string => !!x && accountIds\.includes\(x\)\)/.test(detail));
  check("…through the detail label", /detailAccountLabel\(a\)/.test(detail));
  const v = projectIncidents(
    [{ id: "i1", provider: "PLAID", kind: "SYNC_FAILED", plaidItemId: null, financialAccountId: "a1", firstOccurredAt: null, lastOccurredAt: null, createdAt: new Date(0), resolved: false }],
    [], [], new Map([["a1", "Rent fund (Chase · Checking ••1234)"]]),
  );
  check("projectIncidents attaches the label", v.open[0].account === "Rent fund (Chase · Checking ••1234)");
  check("…and null without one", projectIncidents(
    [{ id: "i2", provider: "PLAID", kind: "SYNC_FAILED", plaidItemId: "p", financialAccountId: null, firstOccurredAt: null, lastOccurredAt: null, createdAt: new Date(0), resolved: false }], [], [],
  ).open[0].account === null);
  check("profile VIEWS never crowd the profile's operator-action list",
    /action: \{ not: AuditAction\.CUSTOMER_PROFILE_VIEWED \}/.test(detail));
}

// ── E ───────────────────────────────────────────────────────────────────────
console.log("E · visible to Security Ops, not to the customer");
{
  check("on the Security Ops operator feed", OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.CUSTOMER_PROFILE_VIEWED));
  check("labelled for the feed", OPERATOR_ACTION_LABEL.CUSTOMER_PROFILE_VIEWED === "Viewed a customer profile");
  check("NOT in the customer's own security history", !USER_SECURITY_HISTORY_ACTIONS.includes(AuditAction.CUSTOMER_PROFILE_VIEWED));
}

if (failures > 0) {
  console.error(`\nsec-plat-3: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nsec-plat-3: all checks passed.");
