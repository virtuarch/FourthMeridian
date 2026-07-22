/**
 * lib/registration-policy.test.ts  (PO-3C)
 *
 * Unit tests for the ONE authoritative registration-policy decision. Pure — the
 * mode → {canRegister, invitedEmail, requiresInvite} mapping, exhaustive over the
 * three modes, is what the public register page and the register API both obey.
 */

import { decideRegistrationPolicy, type InviteValidation } from "@/lib/registration-policy";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const NO_INVITE: InviteValidation   = { valid: false, email: null, requestId: null };
const GOOD_INVITE: InviteValidation = { valid: true, email: "invited@example.com", requestId: "req_1" };

console.log("registration-policy — mode → decision (PO-3C)");

// open — form always available, no invite needed.
{
  const p = decideRegistrationPolicy("open", NO_INVITE);
  check("open: canRegister, no invite required", p.canRegister === true && p.requiresInvite === false && p.invitedEmail === null);
}

// closed — form never available; steer to request-access.
{
  const p = decideRegistrationPolicy("closed", GOOD_INVITE);
  check("closed: form unavailable even WITH a valid invite", p.canRegister === false && p.requiresInvite === true);
}

// invite_only — gated behind a valid invite; email locked to the bound address.
{
  const noInvite = decideRegistrationPolicy("invite_only", NO_INVITE);
  check("invite_only + no invite: form gated, steer to request-access", noInvite.canRegister === false && noInvite.requiresInvite === true);

  const withInvite = decideRegistrationPolicy("invite_only", GOOD_INVITE);
  check("invite_only + valid invite: form available", withInvite.canRegister === true && withInvite.requiresInvite === false);
  check("invite_only + valid invite: email locked to the bound address", withInvite.invitedEmail === "invited@example.com");
}

if (failures > 0) { console.error(`\nregistration-policy: ${failures} failure(s).`); process.exit(1); }
console.log("\nregistration-policy: all passed.");
