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
 * OPERATIONALIZATION P0 (2026-10-07) — ACQUISITION FACTS. Every submission,
 * including a repeat for an address already on the waitlist, ALSO inserts one
 * BetaAccessRequestEvent row carrying a BOUNDED `source` (lib/marketing/
 * acquisition.ts: allowlisted utm_* / ref / source keys, the landing path the
 * public site forwarded, a cross-origin referrer's host, and the edge's
 * two-letter country — never an IP, user agent or raw header). The parent row
 * is untouched, the count from createMany is still discarded, and the response
 * is still the identical 200: requestCount and lastRequestedAt are COUNT/MAX
 * over these rows by an operator, never a branch here.
 *
 * Body: { email: string, note?: string, captchaToken?: string, source?: object }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { limitByIp } from "@/lib/rate-limit";
import { getRequestMeta } from "@/lib/api";
import { verifyCaptchaToken } from "@/lib/captcha";
import { sendEmail } from "@/lib/email/send";
import { AuditAction } from "@/lib/audit-actions";
import { boundAcquisitionSource, withCountry } from "@/lib/marketing/acquisition";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_MAX = 1000;

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "access-request", { limit: 5, windowSec: 900 });
    if (limited) return limited;

    const meta = getRequestMeta(req);
    const body = await req.json().catch(() => ({}));
    const { email, note, captchaToken, source } = body ?? {};

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

    // INSERT … ON CONFLICT DO NOTHING, by email.
    //
    // This was an `upsert` with an EMPTY `update`, which is the same intent said
    // a more expensive way: never disturb an existing request's status, token or
    // decision. RLS-C-S6 narrowed the statement to match the intent, because the
    // two differ in AUTHORITY. An upsert needs SELECT (to detect the conflict)
    // and UPDATE (to resolve it) on a table whose only non-operator privilege is
    // INSERT, so under any converted role a repeat submission failed. A
    // conflict-ignoring insert needs neither, which means the public intake
    // STRUCTURALLY CANNOT READ this table — the strongest form of the
    // non-enumeration property the route already promises, since a privilege it
    // does not hold cannot be misused by a later edit.
    //
    // ⚠️ THE COUNT IS DELIBERATELY DISCARDED. `createMany` returns 1 for a new
    // address and 0 for one already on the waitlist: branching on it — or
    // letting it reach the response — would reintroduce exactly the existence
    // oracle this endpoint is built not to be. The response below is identical
    // either way.
    await db.betaAccessRequest.createMany({
      data: [{ email: normalizedEmail, note: trimmedNote || null }],
      skipDuplicates: true,
    });

    // The submission FACT — one row per submission, first or repeat, never
    // conditional on the createMany outcome above. `source` is bounded by the
    // shared allowlist; the country comes from the edge header (Cloudflare's
    // cf-ipcountry via getRequestMeta, else Vercel's x-vercel-ip-country), and
    // nothing else about the request is kept here (ip/user-agent live on the
    // AuditLog forensic row below, as before).
    const acquisition = withCountry(
      boundAcquisitionSource(source),
      meta.country ?? req.headers.get("x-vercel-ip-country"),
    );
    await db.betaAccessRequestEvent.create({
      data: { email: normalizedEmail, ...(acquisition ? { source: acquisition } : {}) },
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
