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
  { file: "app/api/platform/growth-revenue/requests/[id]/revoke/route.ts", action: "BETA_INVITATION_REVOKED" },
  { file: "app/api/platform/growth-revenue/product-status/route.ts", action: "PRODUCT_STATUS_CHANGED" },
];

// PR B — the issuance routes are thin wrappers: the gate and the actor stay in
// the route; the write + audit live in THE issuance mechanism.
const ISSUANCE = "lib/platform/growth/invitation-issue.ts";
const POLICY = "lib/platform/growth/invitation-policy.ts";
const WRAPPERS: { file: string; action: string; via: string; module: string }[] = [
  { file: "app/api/platform/growth-revenue/requests/[id]/approve/route.ts", action: "BETA_ACCESS_APPROVED", via: "issueBetaInvitation(", module: ISSUANCE },
  { file: "app/api/platform/growth-revenue/requests/[id]/resend/route.ts", action: "BETA_INVITATION_RESENT", via: "issueBetaInvitation(", module: ISSUANCE },
  { file: "app/api/platform/growth-revenue/invitations/route.ts", action: "BETA_INVITATION_CREATED", via: "issueBetaInvitation(", module: ISSUANCE },
  { file: "app/api/platform/growth-revenue/requests/[id]/extend/route.ts", action: "BETA_INVITATION_EXTENDED", via: "extendBetaInvitation(", module: ISSUANCE },
  { file: "app/api/platform/growth-revenue/invitation-policy/route.ts", action: "BETA_INVITATION_VALIDITY_CHANGED", via: "updateInvitationValidity(", module: POLICY },
  // PR C — bulk approval: per-row approvals go through issuance; the ONE batch row is written by bulk-approve.ts.
  { file: "app/api/platform/growth-revenue/requests/bulk-approve/route.ts", action: "BETA_ACCESS_BULK_APPROVED", via: "bulkApproveBetaRequests(", module: "lib/platform/growth/bulk-approve.ts" },
];
for (const w of WRAPPERS) {
  const s = src(w.file);
  const m = src(w.module);
  check(`${w.action}: fresh GROWTH_REVENUE WRITE gate in the route`,
    /requireFreshPlatformAccess\(\s*["']GROWTH_REVENUE["']\s*,\s*["']WRITE["']\s*\)/.test(s));
  check(`${w.action}: actor derived from the resolved grant`, s.includes(`operatorActorFrom(auth, "GROWTH_REVENUE")`));
  check(`${w.action}: the route delegates (${w.via.slice(0, -1)}) and writes nothing itself`,
    s.includes(w.via) && !/\.(update|updateMany|upsert|create|createMany)\(/.test(s) && !s.includes("recordOperatorAction("));
  check(`${w.action}: audited through recordOperatorAction in ${w.module}`, m.includes("recordOperatorAction(") && m.includes(`AuditAction.${w.action}`) && !m.includes("auditLog.create"));
}
{
  const m = src(ISSUANCE);
  check("issuance has no unconditional upsert", !/\.upsert\(/.test(m));
  check("issuance mints with the shared hash + beta-invite template", m.includes("hashResetToken") && m.includes('"beta-invite"'));
  // The in-memory fake restores the WHOLE store on rollback, so it cannot tell a
  // write through `tx` from one through the outer client; pin it at the source.
  const pol = src(POLICY);
  check("validity policy: every setting write and its audit go through the transaction client",
    /createSettingIfAbsent\(tx, /.test(pol) && /updateSettingIfVersion\(tx, /.test(pol) && /deleteSettingIfVersion\(tx, /.test(pol)
      && (pol.match(/recordOperatorAction\(tx, /g) ?? []).length === 2 && !/(SettingIfAbsent|SettingIfVersion|recordOperatorAction)\(client/.test(pol));
  check("issuance: the row writes and the issuance / extend audits go through the transaction client",
    (m.match(/tx\.betaAccessRequest\.(updateMany|createMany)\(/g) ?? []).length === 4 && !/client\.betaAccessRequest\.(update|updateMany|create|createMany)\(/.test(m)
      && /recordOperatorAction\(tx, \{\s*actor: input\.actor,\s*action,/.test(m) && /recordOperatorAction\(tx, \{\s*actor: input\.actor,\s*action: AuditAction\.BETA_INVITATION_EXTENDED/.test(m));
  check("issuance has no TTL constant of its own (expiry from the policy or the override)", !/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(m) && !/\b14\b/.test(m));
}

for (const m of MUTATIONS) {
  const s = src(m.file);
  check(`${m.action}: fresh GROWTH_REVENUE WRITE gate`,
    /requireFreshPlatformAccess\(\s*["']GROWTH_REVENUE["']\s*,\s*["']WRITE["']\s*\)/.test(s));
  // SEC-PLAT-2 — through the operator-action envelope (lib/audit.ts
  // recordOperatorAction), which writes performedByAdminId + actor + target +
  // result; never a hand-built auditLog.create.
  check(`${m.action}: audited through recordOperatorAction`, s.includes("recordOperatorAction(") && !s.includes("auditLog.create"));
  check(`${m.action}: audits AuditAction.${m.action}`, s.includes(`AuditAction.${m.action}`));
  check(`${m.action}: actor derived from the resolved grant (performedByAdminId = operator)`, s.includes(`operatorActorFrom(auth, "GROWTH_REVENUE")`));
}

console.log("owner P2-1 — deny is ONE transaction: row lock → status → block upsert (if confirmed suspicious) → audit");
{
  const deny = src("app/api/platform/growth-revenue/requests/[id]/deny/route.ts");
  check("deny: fresh GROWTH_REVENUE WRITE gate", /requireFreshPlatformAccess\(\s*["']GROWTH_REVENUE["']\s*,\s*["']WRITE["']\s*\)/.test(deny));
  const tx = deny.slice(deny.indexOf("$transaction("));
  const at = (re: RegExp) => { const m = re.exec(tx); return m ? m.index : -1; };
  const lock = at(/FOR UPDATE/), upd = at(/tx\.betaAccessRequest\.update\(/), blk = at(/blockIfConfirmedSuspicious\(tx,/), aud = at(/recordOperatorAction\(tx,/);
  check("deny: the lock, the update, the block and the audit all run on `tx`, in that order",
    deny.includes("db.$transaction(") && lock > -1 && lock < upd && upd < blk && blk < aud && !/recordOperatorAction\(db,/.test(deny) && !/db\.betaAccessRequest\.update/.test(deny));
  check("deny: a block that cannot be recorded (BlocklistUnavailableError) answers 409, never a partial deny", /BlocklistUnavailableError/.test(deny) && /status: 409/.test(deny));
  const review = src("lib/platform/growth/beta-risk-review.ts");
  check("risk review: block upsert / removal inside its transaction, on `tx`", /upsertIdentifierBlock\(tx,/.test(review) && /removeBlocksForSourceRequest\(tx,/.test(review));
  for (const f of ["lib/platform/growth/bulk-approve.ts", "lib/platform/growth/bulk-approve.core.ts"]) {
    check(`${f}: no blocklist import of its own (the block fact arrives through the shared loader)`, !/beta-blocklist/.test(src(f)));
  }
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
    OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.BETA_INVITATION_REVOKED) &&
    OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.BETA_INVITATION_VALIDITY_CHANGED) &&
    OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.BETA_INVITATION_EXTENDED) &&
    OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.BETA_ACCESS_BULK_APPROVED));

  const mode = src("app/api/platform/growth-revenue/registration-mode/route.ts");
  check("mode change validates against REGISTRATION_MODES", mode.includes("REGISTRATION_MODES"));

  const intake = src("app/api/access-request/route.ts");
  check("intake notification is honest-skip (guarded on BETA_REQUESTS_EMAIL; R2 adds the throttle beside it)", /if\s*\(\s*env\.BETA_REQUESTS_EMAIL\s*(\)|&&)/.test(intake));
  check("intake notification uses the beta-request template", intake.includes('"beta-request"'));
  check("intake still 200s regardless (notification is non-throwing)", intake.includes("success: true"));
}

console.log("resend reuses the ONE invite system (no second token/email path)");
{
  const resend = src("app/api/platform/growth-revenue/requests/[id]/resend/route.ts");
  const core = src("lib/platform/growth/invitation-issue.core.ts");
  check("resend delegates to the one issuance mechanism as a reissue", resend.includes('kind: "reissue"'));
  check("reissue only acts on an APPROVED (un-redeemed) invite", /if \(row\.status !== "APPROVED"\) return \{ action: "refuse", refusal: refusal\("NOT_APPROVED"\) \}/.test(core));
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
  const core = src("lib/platform/growth/invitation-issue.core.ts");
  check("direct invite delegates to the one issuance mechanism", invite.includes('kind: "direct"'));
  check("direct invite rejects an email that already has an account", /planDirect[\s\S]{0,120}if \(accountExists\) return \{ action: "refuse", refusal: refusal\("ACCOUNT_EXISTS"\) \}/.test(core));

  // Product status is the SEPARATE launch axis, validated against its own enum.
  const productStatus = src("app/api/platform/growth-revenue/product-status/route.ts");
  check("product-status validates against PRODUCT_STATUSES", productStatus.includes("PRODUCT_STATUSES"));
}

if (failures > 0) { console.error(`\nbeta-ops-guards: ${failures} failure(s).`); process.exit(1); }
console.log("\nbeta-ops-guards: all passed.");
