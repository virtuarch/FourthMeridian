/**
 * POST /api/auth/pre-login
 *
 * Step-1 of the two-step login flow.
 * Verifies email/username + password and tells the client whether TOTP is required.
 * Does NOT create a session — that happens via NextAuth signIn() in step 2.
 *
 * Returns:
 *   { ok: false }                        — bad credentials
 *   { ok: true, totpRequired: false }    — login can complete in one step
 *   { ok: true, totpRequired: true }     — TOTP screen must be shown
 *   { ok: false, reason: "unverified" }  — correct password, email unverified
 *   { ok: false, reason: "deactivated", totpRequired } — correct password,
 *     account deactivated (OPS-2 S4); login page offers reactivation
 *
 * Security notes:
 *   - Timing-safe: always runs bcrypt even when user is not found (dummy hash).
 *   - Does NOT distinguish "user not found" from "wrong password" to avoid enumeration.
 *   - Rate limited per IP (KD-3): 10 attempts / minute.
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { limitByIp, peekKey } from "@/lib/rate-limit";
import { LOGIN_ID_WINDOW_SEC, LOGIN_CAPTCHA_THRESHOLD } from "@/lib/login-limits";

// Dummy hash used when the user is not found, to keep timing consistent.
const DUMMY_HASH =
  "$2a$12$Jb7jQimXuPj.v5R5hjZ.G.7F4.D3R1bBO4a0p6Y6f3jC2E4V6Uuze";

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "pre-login", { limit: 10, windowSec: 60 });
    if (limited) return limited;

    const body       = await req.json();
    const identifier = (body.identifier as string | undefined)?.toLowerCase().trim() ?? "";
    const password   = (body.password   as string | undefined) ?? "";

    if (!identifier || !password) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    // CAPTCHA step-up hint (Wave 2 ⑥): advise the client to render the Turnstile
    // widget once this identifier has crossed the attempt threshold. Peek only —
    // never increments (the count is driven by authorize()). Authoritative
    // enforcement is authorize()'s server-side re-verify; this is just the UX
    // signal. Keyed on the submitted string, so it discloses nothing about
    // whether an account exists.
    const captchaRequired =
      (await peekKey(identifier, "login-id", LOGIN_ID_WINDOW_SEC)) >= LOGIN_CAPTCHA_THRESHOLD;

    const user = await db.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
      },
      select: { id: true, passwordHash: true, totpEnabled: true, emailVerifiedAt: true, deactivatedAt: true, deletionScheduledAt: true },
    });

    // Always run bcrypt to prevent timing-based user enumeration
    const hash  = user?.passwordHash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(password, hash);

    if (!valid || !user) {
      return NextResponse.json({ ok: false, captchaRequired });
    }

    // ── Email verification gate (OPS-1 S2e — block mode) ──────────────────────
    // Reveal "unverified" ONLY after a correct password, so this is not an
    // enumeration vector (the caller already proved they own the account).
    // Bad credentials fall through the generic { ok: false } above. authorize()
    // in lib/auth.ts is the authoritative block; this is the UX signal so the
    // login page can show the verify message + resend affordance.
    if (!user.emailVerifiedAt) {
      return NextResponse.json({ ok: false, reason: "unverified" });
    }

    // ── Pending-deletion gate (OPS-2 S7a) ──────────────────────────────────────
    // A pending-deletion account also has deactivatedAt set (S7b), so this is
    // checked BEFORE the deactivation gate to surface the distinct "pending
    // deletion — cancel?" affordance instead of the generic reactivate one.
    // Same post-password non-enumeration argument. authorize() in lib/auth.ts
    // is the authoritative block (and performs the cancellation once full auth
    // succeeds via the cancelDeletion leg). totpRequired routes the cancel leg
    // through the TOTP screen when 2FA is enabled.
    if (user.deletionScheduledAt) {
      return NextResponse.json({ ok: false, reason: "pending_deletion", totpRequired: user.totpEnabled });
    }

    // ── Deactivation gate (OPS-2 S4) ───────────────────────────────────────────
    // Same post-password non-enumeration argument as "unverified": revealed
    // ONLY after a correct password. The login page shows a "Reactivate and
    // sign in" affordance; authorize() in lib/auth.ts is the authoritative
    // block (and performs the reactivation once full auth succeeds). We also
    // return totpRequired so the reactivation leg can route through the TOTP
    // screen when 2FA is enabled.
    if (user.deactivatedAt) {
      return NextResponse.json({ ok: false, reason: "deactivated", totpRequired: user.totpEnabled });
    }

    return NextResponse.json({
      ok:           true,
      totpRequired: user.totpEnabled,
      captchaRequired,
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
