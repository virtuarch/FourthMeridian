/**
 * POST /api/access-request  (Wave 1 S3 — public beta-access intake)
 *
 * The unauthenticated front door for beta-access requests. Anyone (typically
 * from the landing-page request-access form) may submit an email; a SYSTEM_ADMIN
 * or GROWTH_REVENUE grant-holder later approves it from the Growth & Revenue
 * platform queue, which mints and emails a single-use invite.
 *
 * NON-ENUMERATING BY DESIGN: the response is an identical 200 whether the email
 * is brand new, already pending, already approved, already denied, or already a
 * live user. The upsert-by-email means a re-submission never discloses prior
 * state — an attacker probing addresses learns nothing. (A live-user submission
 * still records a fresh request row; approval simply never happens for an email
 * that already has an account, and the register route would 409 anyway.)
 *
 * DEFENSES: limitByIp (5 / 15 min, mirroring register) + CAPTCHA
 * (verifyCaptchaToken, env-gated off until Wave 2 configures Turnstile keys —
 * skipped verification returns true, so this endpoint behaves normally in
 * dev/test today). An AuditLog row (BETA_ACCESS_REQUESTED, no userId) captures
 * ip/user-agent so the intake is forensically visible even though the request
 * row itself keeps minimal PII.
 *
 * Body: { email: string, note?: string, captchaToken?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { limitByIp } from "@/lib/rate-limit";
import { getRequestMeta } from "@/lib/api";
import { verifyCaptchaToken } from "@/lib/captcha";
import { sendEmail } from "@/lib/email/send";
import { AuditAction } from "@/lib/audit-actions";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_MAX = 1000;

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "access-request", { limit: 5, windowSec: 900 });
    if (limited) return limited;

    const meta = getRequestMeta(req);
    const body = await req.json().catch(() => ({}));
    const { email, note, captchaToken } = body ?? {};

    // Basic shape validation. An invalid email is a real 400 (it's not a
    // state-disclosure — any client can tell a malformed address from a valid
    // one on its own); everything past this point is non-enumerating.
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    if (note !== undefined && (typeof note !== "string" || note.length > NOTE_MAX)) {
      return NextResponse.json({ error: `Note must be ${NOTE_MAX} characters or fewer.` }, { status: 400 });
    }

    // CAPTCHA — env-gated off in this slice (no TURNSTILE_SECRET_KEY ⇒ true).
    const captchaOk = await verifyCaptchaToken(captchaToken, meta.ip);
    if (!captchaOk) {
      return NextResponse.json({ error: "CAPTCHA verification failed. Please try again." }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const trimmedNote = typeof note === "string" ? note.trim() : "";

    // Upsert-by-email: a re-submission of the same address updates nothing that
    // could leak state (it only refreshes the note on a still-PENDING row) and
    // never resets an APPROVED/DENIED/REDEEMED lifecycle. Create-side seeds a
    // fresh PENDING request. Either way the response is identical (below).
    await db.betaAccessRequest.upsert({
      where:  { email: normalizedEmail },
      update: {}, // never disturb an existing request's status/token/decision
      create: {
        email: normalizedEmail,
        note:  trimmedNote || null,
      },
    });

    // Forensic trail — no userId (there is no account), ip/user-agent captured.
    await db.auditLog.create({
      data: {
        action:    AuditAction.BETA_ACCESS_REQUESTED,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        metadata:  { email: normalizedEmail },
      },
    });

    // PO-3B — operator intake notification. Honest-skip when BETA_REQUESTS_EMAIL
    // is unset (no guessed mailbox); non-throwing so a delivery failure never
    // affects the applicant's identical 200. The applicant never receives this —
    // only the approval invite (beta-invite) is applicant-facing.
    if (env.BETA_REQUESTS_EMAIL) {
      const queueUrl = `${env.NEXT_PUBLIC_APP_URL}/dashboard/platform/GROWTH_REVENUE`;
      const notify = await sendEmail("beta-request", env.BETA_REQUESTS_EMAIL, {
        applicantEmail: normalizedEmail,
        note:           trimmedNote || null,
        queueUrl,
      });
      if (notify.status === "error") {
        console.error("[access-request] operator notification failed to send:", notify.error);
      }
    }

    // Identical 200 regardless of prior state — non-enumerating.
    return NextResponse.json({
      success: true,
      message: "Thanks — your request has been received. We'll email you if you're approved.",
    });
  } catch (err) {
    console.error("[access-request] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
