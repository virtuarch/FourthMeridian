/**
 * lib/platform/beta-ops-guards.test.ts  (PO-3B)
 *
 * SOURCE-SCAN test (house pattern — deterministic, no runtime/DB): every beta
 * operations MUTATION obeys the PO-1 security contract — fresh GROWTH_REVENUE
 * WRITE gate + an AuditLog row — and revoke stays scoped to the invitation
 * (never deletes users or touches access). Also pins the operator-feed wiring
 * and the honest-skip on the intake notification.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { OPERATOR_ACTION_FEED_ACTIONS, AuditAction } from "@/lib/audit-actions";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

console.log("beta-ops-guards — every mutation is WRITE-gated + audited (PO-3B)");

const MUTATIONS: { file: string; action: string }[] = [
  { file: "app/api/platform/growth-revenue/registration-mode/route.ts", action: "BETA_MODE_CHANGED" },
  { file: "app/api/platform/growth-revenue/requests/[id]/resend/route.ts", action: "BETA_INVITATION_RESENT" },
  { file: "app/api/platform/growth-revenue/requests/[id]/revoke/route.ts", action: "BETA_INVITATION_REVOKED" },
  // PO-3C
  { file: "app/api/platform/growth-revenue/invitations/route.ts", action: "BETA_INVITATION_CREATED" },
  { file: "app/api/platform/growth-revenue/product-status/route.ts", action: "PRODUCT_STATUS_CHANGED" },
];

for (const m of MUTATIONS) {
  const s = src(m.file);
  check(`${m.action}: fresh GROWTH_REVENUE WRITE gate`,
    /requireFreshPlatformAccess\(\s*["']GROWTH_REVENUE["']\s*,\s*["']WRITE["']\s*\)/.test(s));
  check(`${m.action}: writes an AuditLog row`, s.includes("auditLog.create"));
  check(`${m.action}: audits AuditAction.${m.action}`, s.includes(`AuditAction.${m.action}`));
  check(`${m.action}: records performedByAdminId (operator)`, s.includes("performedByAdminId"));
}

console.log("revoke stays scoped to the invitation (no user deletion / access change)");
{
  const revoke = src("app/api/platform/growth-revenue/requests/[id]/revoke/route.ts");
  check("revoke nulls the invite token", /inviteTokenHash:\s*null/.test(revoke));
  check("revoke never deletes a user", !/user\.delete|users\.delete|user\.deleteMany/.test(revoke));
  check("revoke never touches SpaceMember / grants", !/spaceMember|platformGrant/.test(revoke));
}

console.log("operator feed + intake notification wiring");
{
  check("new actions surface in the Security Ops operator feed",
    OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.BETA_MODE_CHANGED) &&
    OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.BETA_INVITATION_RESENT) &&
    OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.BETA_INVITATION_REVOKED));

  const mode = src("app/api/platform/growth-revenue/registration-mode/route.ts");
  check("mode change validates against REGISTRATION_MODES", mode.includes("REGISTRATION_MODES"));

  const intake = src("app/api/access-request/route.ts");
  check("intake notification is honest-skip (guarded on BETA_REQUESTS_EMAIL)", /if\s*\(\s*env\.BETA_REQUESTS_EMAIL\s*\)/.test(intake));
  check("intake notification uses the beta-request template", intake.includes('"beta-request"'));
  check("intake still 200s regardless (notification is non-throwing)", intake.includes("success: true"));
}

console.log("resend reuses the ONE invite system (no second token/email path)");
{
  const resend = src("app/api/platform/growth-revenue/requests/[id]/resend/route.ts");
  check("resend uses the shared hashResetToken + beta-invite template", resend.includes("hashResetToken") && resend.includes('"beta-invite"'));
  check("resend only acts on an APPROVED (un-redeemed) invite", /status\s*!==\s*BetaAccessRequestStatus\.APPROVED/.test(resend));
}

console.log("PO-3C — one authoritative registration policy honored by both public + API");
{
  // The public register page gates on the policy (no form before invite validation).
  const page = src("app/(auth)/register/page.tsx");
  check("register page fetches the authoritative policy", page.includes("/api/registration-policy"));
  check("register page gates the form on canRegister", /canRegister/.test(page));
  check("register page steers no-invite/closed → request-access", page.includes("/request-access"));

  // The register API validates via the SAME shared authority (no duplicated lookup).
  const register = src("app/api/auth/register/route.ts");
  check("register API uses the shared validateInvite (one policy)", register.includes("validateInvite("));
  check("register API still enforces the email-binding", /invite\.email\s*!==\s*normalizedEmail/.test(register));

  // The public policy route is intentionally UNAUTHENTICATED (no platform gate) + rate-limited.
  const policyRoute = src("app/api/registration-policy/route.ts");
  check("policy route is public (no requirePlatformAccess/requireUser)", !/requirePlatformAccess|requireUser|requireSystemAdmin/.test(policyRoute));
  check("policy route is rate-limited", policyRoute.includes("limitByIp"));

  // Direct invite reuses the ONE invite system + rejects an existing account.
  const invite = src("app/api/platform/growth-revenue/invitations/route.ts");
  check("direct invite reuses hashResetToken + beta-invite template", invite.includes("hashResetToken") && invite.includes('"beta-invite"'));
  check("direct invite rejects an email that already has an account", /existingUser/.test(invite) && invite.includes("409"));

  // Product status is the SEPARATE launch axis, validated against its own enum.
  const productStatus = src("app/api/platform/growth-revenue/product-status/route.ts");
  check("product-status validates against PRODUCT_STATUSES", productStatus.includes("PRODUCT_STATUSES"));
}

if (failures > 0) { console.error(`\nbeta-ops-guards: ${failures} failure(s).`); process.exit(1); }
console.log("\nbeta-ops-guards: all passed.");
