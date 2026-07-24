/**
 * POST /api/auth/pre-login
 *
 * Step-1 of the two-step login flow.
 * Verifies email/username + password and tells the client whether TOTP is required.
 * Does NOT create a session — that happens via NextAuth signIn() in step 2.
 *
 * Returns:
 *   { ok: false }                        — bad credentials                     (200)
 *   { ok: true, totpRequired: false }    — login can complete in one step      (200)
 *   { ok: true, totpRequired: true }     — TOTP screen must be shown           (200)
 *   { ok: false, reason: "unverified" }  — correct password, email unverified  (200)
 *   { ok: false, reason: "deactivated", totpRequired } — correct password,
 *     account deactivated (OPS-2 S4); login page offers reactivation           (200)
 *   { error: "Too many requests…" }      — rate limited                        (429)
 *   { ok: false, reason: "unavailable" } — the credential authority (DB/pool/
 *     limiter) is unreachable; NOT a credential judgement                      (503)
 *
 * Security notes:
 *   - Timing-safe: always runs bcrypt even when user is not found (dummy hash).
 *   - Does NOT distinguish "user not found" from "wrong password" to avoid enumeration.
 *   - Rate limited per IP (KD-3): 10 attempts / minute.
 *
 * PS-4A — AUTHENTICATION HONESTY. Before this change, ANY exception in the body
 * (a Prisma pool timeout — P2024 / ECHECKOUTTIMEOUT — during the user lookup, or
 * a rate-limiter store failure) was caught and returned as a bare `{ ok: false }`
 * with status 500, which the client mapped to "Invalid email, username, or
 * password." A database outage was shown to the user as a wrong password. Now:
 *   - infrastructure failure ⇒ HTTP 503 + `{ ok:false, reason:"unavailable" }`,
 *     a shape the client classifies as temporary-unavailability, never invalid
 *     credentials (classifyPreLoginResponse in lib/auth/login-outcome.ts);
 *   - the rate limiter FAILS CLOSED here (checkIpLimitStrict): if its store is
 *     unreachable we stop the attempt and return 503 rather than silently
 *     verifying credentials with brute-force protection disabled;
 *   - every infrastructure failure is captured once, with safe context, via the
 *     server capture authority (no PII, no secrets).
 * The enumeration-safety and timing-safety properties are unchanged: bad
 * credentials still return the identical `{ ok:false }` (200) as before.
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { checkIpLimitStrict, peekKey } from "@/lib/rate-limit";
import { LOGIN_ID_WINDOW_SEC, LOGIN_CAPTCHA_THRESHOLD } from "@/lib/login-limits";
import { captureAuthInfraFailure } from "@/lib/monitoring/capture";
import { PRELOGIN_UNAVAILABLE_REASON } from "@/lib/auth/login-outcome";

// Dummy hash used when the user is not found, to keep timing consistent.
const DUMMY_HASH =
  "$2a$12$Jb7jQimXuPj.v5R5hjZ.G.7F4.D3R1bBO4a0p6Y6f3jC2E4V6Uuze";

/** HTTP 503 + enumeration-safe body: authority unreachable, NOT a credential judgement. */
function temporarilyUnavailable(): NextResponse {
  return NextResponse.json({ ok: false, reason: PRELOGIN_UNAVAILABLE_REASON }, { status: 503 });
}

export async function POST(req: NextRequest) {
  // NOTE: no outer catch-all that collapses to `{ ok: false }`. Each stage that
  // can fail on infrastructure is handled explicitly so an outage can never be
  // reported as a credential result. A truly unexpected throw is left to
  // framework handling (a 500 with no `{ ok }` body, which the client classifies
  // as unavailable, not invalid — see classifyPreLoginResponse).

  let reqBody: { identifier?: string; password?: string };
  try {
    reqBody = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const identifier = (reqBody.identifier as string | undefined)?.toLowerCase().trim() ?? "";
  const password   = (reqBody.password   as string | undefined) ?? "";

  if (!identifier || !password) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  // ── Rate limit (per IP) — FAIL CLOSED (PS-4A) ──────────────────────────────
  // A store failure here must not silently disable brute-force protection: stop
  // the attempt and report temporary unavailability instead of verifying the
  // password with the limiter down.
  const limit = await checkIpLimitStrict(req, "pre-login", { limit: 10, windowSec: 60 });
  if (limit.status === "unavailable") {
    captureAuthInfraFailure("rate-limit", new Error("pre-login rate-limit store unavailable"));
    return temporarilyUnavailable();
  }
  if (limit.status === "limited") {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  // CAPTCHA step-up hint (Wave 2 ⑥): peekKey fails SOFT to 0 (advisory only), so
  // it never turns an infrastructure blip into a credential result. Left soft
  // deliberately — the authoritative CAPTCHA enforcement is in authorize().
  const captchaRequired =
    (await peekKey(identifier, "login-id", LOGIN_ID_WINDOW_SEC)) >= LOGIN_CAPTCHA_THRESHOLD;

  // ── User lookup — the credential AUTHORITY. A throw here is infrastructure,
  // NOT "wrong password": report 503, capture once. ──────────────────────────
  let user: {
    id: string;
    passwordHash: string | null;
    totpEnabled: boolean;
    emailVerifiedAt: Date | null;
    deactivatedAt: Date | null;
    deletionScheduledAt: Date | null;
  } | null;
  try {
    user = await db.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
      },
      select: { id: true, passwordHash: true, totpEnabled: true, emailVerifiedAt: true, deactivatedAt: true, deletionScheduledAt: true },
    });
  } catch (err) {
    captureAuthInfraFailure("user-lookup", err);
    return temporarilyUnavailable();
  }

  // Always run bcrypt to prevent timing-based user enumeration.
  const hash  = user?.passwordHash ?? DUMMY_HASH;
  const valid = await bcrypt.compare(password, hash);

  if (!valid || !user) {
    // Genuine bad credentials — the SAME 200 `{ ok: false }` shape as before.
    return NextResponse.json({ ok: false, captchaRequired });
  }

  // ── Email verification gate (OPS-1 S2e — block mode) ──────────────────────
  // Reveal "unverified" ONLY after a correct password, so this is not an
  // enumeration vector (the caller already proved they own the account).
  if (!user.emailVerifiedAt) {
    return NextResponse.json({ ok: false, reason: "unverified" });
  }

  // ── Pending-deletion gate (OPS-2 S7a) ──────────────────────────────────────
  // A pending-deletion account also has deactivatedAt set (S7b), so this is
  // checked BEFORE the deactivation gate to surface the distinct "pending
  // deletion — cancel?" affordance instead of the generic reactivate one.
  if (user.deletionScheduledAt) {
    return NextResponse.json({ ok: false, reason: "pending_deletion", totpRequired: user.totpEnabled });
  }

  // ── Deactivation gate (OPS-2 S4) ───────────────────────────────────────────
  // Revealed ONLY after a correct password. The login page shows a "Reactivate
  // and sign in" affordance; authorize() in lib/auth.ts is the authoritative block.
  if (user.deactivatedAt) {
    return NextResponse.json({ ok: false, reason: "deactivated", totpRequired: user.totpEnabled });
  }

  return NextResponse.json({
    ok:           true,
    totpRequired: user.totpEnabled,
    captchaRequired,
  });
}
