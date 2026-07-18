/**
 * POST /api/registration-policy  (PO-3C — public)
 *
 * The public read of the ONE authoritative registration policy, so the register
 * page can honor registration_mode BEFORE showing (or hiding) the form. Body
 * carries the optional invite token (POST, not a query param, so the token is
 * not written into access-log query strings).
 *
 * Unauthenticated + rate-limited + NON-ENUMERATING: an invalid/absent invite
 * returns `{ canRegister:false, invitedEmail:null }` with no distinction between
 * "wrong token" and "no token" — an attacker learns nothing beyond the public
 * mode. A VALID token returns the bound email, which its holder already owns.
 */

import { NextRequest, NextResponse } from "next/server";
import { limitByIp } from "@/lib/rate-limit";
import { resolveRegistrationPolicy } from "@/lib/registration-policy";

export const runtime = "nodejs";

export interface RegistrationPolicyResponse {
  mode:           "open" | "invite_only" | "closed";
  canRegister:    boolean;
  invitedEmail:   string | null;
  requiresInvite: boolean;
}

export async function POST(req: NextRequest) {
  const limited = await limitByIp(req, "registration-policy", { limit: 30, windowSec: 300 });
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const invite = typeof (body as { invite?: unknown }).invite === "string"
    ? (body as { invite: string }).invite
    : null;

  const policy = await resolveRegistrationPolicy(invite);
  return NextResponse.json({
    mode:           policy.mode,
    canRegister:    policy.canRegister,
    invitedEmail:   policy.invitedEmail,
    requiresInvite: policy.requiresInvite,
  } satisfies RegistrationPolicyResponse);
}
