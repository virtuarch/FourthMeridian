/**
 * POST /api/auth/verify-email/resend  (OPS-1 S2d — verification resend)
 *
 * Issues a fresh verification link. TWO entry points converge on ONE shared
 * core (lib/email/verification.ts → rotateAndSendVerification); only how the
 * user is resolved and how much is revealed differs:
 *
 *   { token }       — TOKEN-BASED (expired verify-email page). The token is a
 *                     bearer credential, so the response may be precise:
 *                       200 { success:true,  status:"sent" }
 *                       200 { success:true,  status:"already_verified" }
 *                       200 { success:false, status:"error" }        (send failed)
 *                       400 { success:false, status:"invalid" }      (unknown token)
 *
 *   { identifier }  — IDENTIFIER-BASED (login page; email OR username). MUST be
 *                     non-enumerating: it ALWAYS returns the same generic
 *                     success and never reveals whether the account exists or
 *                     is already verified. Mirrors forgot-password.
 *                       200 { success:true }
 *
 * Token is always ROTATED (fresh 1h expiry) on a real send. Rate limited per IP.
 * Does NOT enforce verification, and does not touch session/JWT/proxy.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/password-reset-token";
import { rotateAndSendVerification } from "@/lib/email/verification";
import { limitByIp } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "verify-email-resend", { limit: 5, windowSec: 900 });
    if (limited) return limited;

    const body = await req.json().catch(() => ({}));
    const token      = typeof body?.token === "string" ? body.token : undefined;
    const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : undefined;

    // ── Identifier-based (login page) — ALWAYS generic, never enumerating ─────
    if (identifier) {
      const normalized = identifier.toLowerCase();
      const user = await db.user.findFirst({
        where:  { OR: [{ email: normalized }, { username: normalized }] },
        select: { id: true, email: true, emailVerifiedAt: true },
      });

      // Best-effort: only a found, unverified user triggers a real send. The
      // response is identical in every case — existence and verification state
      // are never revealed.
      if (user) {
        await rotateAndSendVerification(user);
      }

      return NextResponse.json({ success: true });
    }

    // ── Token-based (expired page) — bearer credential, may be precise ────────
    if (token) {
      const user = await db.user.findFirst({
        where:  { emailVerificationToken: hashResetToken(token) },
        select: { id: true, email: true, emailVerifiedAt: true },
      });

      if (!user) {
        return NextResponse.json({ success: false, status: "invalid" }, { status: 400 });
      }

      const outcome = await rotateAndSendVerification(user);
      return NextResponse.json({ success: outcome !== "error", status: outcome });
    }

    // Neither token nor identifier supplied.
    return NextResponse.json({ success: false, status: "invalid" }, { status: 400 });
  } catch (err) {
    console.error("[verify-email/resend] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
