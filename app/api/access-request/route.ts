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
 * DEFENSES (R2 beta-intake hardening, 2026-10-31 — in request order):
 *   1. per-IP limit, 5 / 15 min (limitByIp, mirroring register). Fail-open on a
 *      store error, like every enforce() limiter.
 *   2. shape validation + PRIV-012 consent (400s, nothing stored).
 *   3. CAPTCHA (lib/captcha.ts verifyCaptchaToken). When TURNSTILE_SECRET_KEY is
 *      configured it is ENFORCED and FAILS CLOSED: "rejected" → 400, and
 *      "unavailable" (Cloudflare error/timeout/non-2xx/malformed) → 503
 *      "temporarily unavailable"; when it is not configured verification is
 *      skipped (logged once) — see captchaMode().
 *   4. GLOBAL limit per UTC hour across all callers (limitGlobal) → 429 with
 *      the generic "too many requests" body. The number is the PlatformSetting
 *      beta_intake_global_limit_per_hour (10–1000, default 60; an unreadable
 *      value ⇒ the default). Each refused hour is recorded ONCE as an
 *      AuditLog BETA_INTAKE_THROTTLED row { hourWindow, limit } (the per-hour
 *      count is the RateLimit counter). Placed AFTER the CAPTCHA so that, once
 *      Turnstile is enforced, only challenge-passing traffic spends the shared
 *      budget. FAIL-OPEN on a store error (availability: a limiter outage must
 *      not close the waitlist; per-IP + CAPTCHA still apply).
 *   5. per-address limit, 3 / 24 h, keyed on sha256 of the address AS STORED
 *      (lowercase + trim; lib/rate-limit emailLimitKey — never the raw address
 *      in RateLimit.key). NOT the canonical form: folding +tag / Gmail-dot
 *      variants here would let `victim+1/+2/+3@` fill the bucket and silently
 *      block the real `victim@`. Over the limit the submission is DROPPED —
 *      no waitlist row, no BetaAccessRequestEvent row, no per-submission audit
 *      row, no e-mail — SILENTLY, with the identical 200 (each hour with drops
 *      is recorded ONCE as BETA_INTAKE_DUPLICATE_DROPPED { hourWindow, limit },
 *      counts only — no address, no hash): a 429 here would tell a prober that the address was
 *      recently submitted, i.e. an existence oracle.
 *   6. operator-notification throttle (consumeThrottle): at most 1 e-mail per
 *      CANONICAL address (canonicalEmailLimitKey — variants folded, which can
 *      only reduce operator mail, never block an applicant) per 24 h and 20 per hour overall. A throttled
 *      submission is still stored; only the e-mail is skipped (logged).
 * An AuditLog row (BETA_ACCESS_REQUESTED, no userId) captures ip/user-agent so
 * the intake is forensically visible even though the request row itself keeps
 * minimal PII; jobs/data-retention.ts minimises those two fields after 90 days.
 *
 * ORIGIN IS NOT A BOT CONTROL. This route deliberately does not check the
 * Origin/Referer header as abuse protection: any non-browser client sets it to
 * whatever it likes. The proxy/CSRF posture is unchanged by R2; the controls
 * above are the bot controls.
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
 * PRIV-012 — NOTICE + CONSENT. The form shows a privacy notice and a required
 * consent checkbox; this route refuses (400) any submission without
 * `consent: true`, BEFORE anything is stored or e-mailed, so no waitlist row
 * exists for an applicant who was not shown the notice. The forensic audit row
 * records the notice version the applicant agreed to. (Retention/purge of
 * BetaAccessRequest is Agent C's half of PRIV-012.)
 *
 * Body: { email: string, consent: true, note?: string, captchaToken?: string, source?: object }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getBetaIntakeGlobalLimitPerHour } from "@/lib/platform-settings";
import { limitByIp, limitGlobal, limitByKey, consumeThrottle, countInWindow, emailLimitKey, canonicalEmailLimitKey, type RateLimitConfig } from "@/lib/rate-limit";
import { getRequestMeta } from "@/lib/api";
import { verifyCaptchaToken, CAPTCHA_UNAVAILABLE_MESSAGE } from "@/lib/captcha";
import { sendEmail } from "@/lib/email/send";
import { AuditAction } from "@/lib/audit-actions";
import { auditEmailHash } from "@/lib/audit";
import { boundAcquisitionSource, withCountry } from "@/lib/marketing/acquisition";
import { ACCESS_REQUEST_NOTICE_VERSION, CONSENT_REQUIRED_ERROR } from "@/components/marketing/access-request-consent";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NOTE_MAX = 1000;

// R2 — named limits (see header). Fixed windows in the RateLimit store; the
// 24 h windows are the longest any caller uses (jobs/sweep-rate-limits.ts keeps
// rows for 24 h past their window START, which is exactly enough).
const ACCESS_REQUEST_IP_LIMIT:         RateLimitConfig = { limit: 5,  windowSec: 15 * 60 };
const ACCESS_REQUEST_GLOBAL_WINDOW_SEC = 60 * 60; // the limit itself is a PlatformSetting
const ACCESS_REQUEST_EMAIL_LIMIT:      RateLimitConfig = { limit: 3,  windowSec: 24 * 60 * 60 };
const OPERATOR_NOTIFY_EMAIL_THROTTLE:  RateLimitConfig = { limit: 1,  windowSec: 24 * 60 * 60 };
const OPERATOR_NOTIFY_GLOBAL_THROTTLE: RateLimitConfig = { limit: 20, windowSec: 60 * 60 };

/** The one success body — identical for new, repeat, and silently-dropped submissions. */
const IDENTICAL_OK = {
  success: true,
  message: "Thanks — your request has been received. We'll email you if you're approved.",
} as const;

/**
 * R2 — monitoring: count the event in a per-UTC-hour counter (RateLimit store)
 * and write AT MOST ONE AuditLog row per hour per action — the caller whose
 * atomic increment returned 1 writes it; every later event that hour only
 * counts. No userId, no address, no hash. Never throws (monitoring must not
 * change the response); a counter-store error skips the row rather than risk
 * one row per request.
 */
async function recordHourlyIntakeSignal(
  action: typeof AuditAction.BETA_INTAKE_THROTTLED | typeof AuditAction.BETA_INTAKE_DUPLICATE_DROPPED,
  limit: number,
): Promise<void> {
  try {
    const tick = await countInWindow(`beta-intake:${action}`, 60 * 60);
    if (tick?.count !== 1) return;
    await db.auditLog.create({
      data: { action, metadata: { hourWindow: new Date(tick.windowStartMs).toISOString(), limit } },
    });
  } catch (err) {
    console.error(`[access-request] could not record ${action}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * R2 — may the operator be e-mailed about this submission? Per-address first, so
 * repeats never spend the global budget. Returns the throttling reason, or null
 * when the e-mail may be sent.
 */
async function operatorNotifyThrottle(canonicalKey: string): Promise<"email" | "global" | null> {
  if (!(await consumeThrottle(canonicalKey, "beta-request-notify-email", OPERATOR_NOTIFY_EMAIL_THROTTLE))) return "email";
  if (!(await consumeThrottle("all", "beta-request-notify-global", OPERATOR_NOTIFY_GLOBAL_THROTTLE))) return "global";
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // NB: no Origin/Referer check here — Origin is not a bot control (header).
    const limited = await limitByIp(req, "access-request", ACCESS_REQUEST_IP_LIMIT);
    if (limited) return limited;

    const meta = getRequestMeta(req);
    const body = await req.json().catch(() => ({}));
    const { email, note, captchaToken, source, consent } = body ?? {};

    // Basic shape validation. An invalid email is a real 400 (it's not a
    // state-disclosure — any client can tell a malformed address from a valid
    // one on its own); everything past this point is non-enumerating.
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    // PRIV-012 — consent to the privacy notice is required, strictly `true`
    // (not "true", not 1), and checked before anything is stored or e-mailed.
    if (consent !== true) {
      return NextResponse.json({ error: CONSENT_REQUIRED_ERROR }, { status: 400 });
    }
    if (note !== undefined && (typeof note !== "string" || note.length > NOTE_MAX)) {
      return NextResponse.json({ error: `Note must be ${NOTE_MAX} characters or fewer.` }, { status: 400 });
    }

    // CAPTCHA — enforced + fail-closed when TURNSTILE_SECRET_KEY is set;
    // skipped (logged once) when it is not. See lib/captcha.ts.
    // "unavailable" (Cloudflare unreachable) → honest 503; "rejected" → 400.
    const captcha = await verifyCaptchaToken(captchaToken, meta.ip);
    if (captcha === "unavailable") {
      return NextResponse.json({ error: CAPTCHA_UNAVAILABLE_MESSAGE }, { status: 503, headers: { "Retry-After": "60" } });
    }
    if (captcha !== "passed") {
      return NextResponse.json({ error: "CAPTCHA verification failed. Please try again." }, { status: 400 });
    }

    // GLOBAL ceiling — 429 with the generic body. Fail-open on a store error.
    const globalLimit = await getBetaIntakeGlobalLimitPerHour();
    const globalLimited = await limitGlobal("access-request", { limit: globalLimit, windowSec: ACCESS_REQUEST_GLOBAL_WINDOW_SEC });
    if (globalLimited) {
      await recordHourlyIntakeSignal(AuditAction.BETA_INTAKE_THROTTLED, globalLimit);
      return globalLimited;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const trimmedNote = typeof note === "string" ? note.trim() : "";
    const emailKey = emailLimitKey(normalizedEmail);

    // Per-address ceiling — over it, DROP SILENTLY with the identical 200 (a
    // 429 would disclose that the address was recently submitted). Nothing is
    // stored (no waitlist or event row), audited or e-mailed for a dropped submission.
    if (await limitByKey(emailKey, "access-request-email", ACCESS_REQUEST_EMAIL_LIMIT)) {
      console.warn("[access-request] per-email limit reached — submission dropped (identical 200)");
      await recordHourlyIntakeSignal(AuditAction.BETA_INTAKE_DUPLICATE_DROPPED, ACCESS_REQUEST_EMAIL_LIMIT.limit);
      return NextResponse.json(IDENTICAL_OK);
    }

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
        // BETA A7 — the address is referenced by digest, never stored (lib/audit.ts
        // auditEmailHash). The BetaAccessRequest row above is the identity-resolving
        // record; the forensic row only needs to be joinable to it by hash.
        // PRIV-012 — which privacy notice the applicant consented to.
        metadata:  { emailHash: auditEmailHash(normalizedEmail), consentNoticeVersion: ACCESS_REQUEST_NOTICE_VERSION },
      },
    });

    // PO-3B — operator intake notification. Honest-skip when BETA_REQUESTS_EMAIL
    // is unset (no guessed mailbox); non-throwing so a delivery failure never
    // affects the applicant's identical 200. The applicant never receives this —
    // only the approval invite (beta-invite) is applicant-facing.
    //
    // R2 — THROTTLED (operatorNotifyThrottle): the request above is stored
    // either way; a throttled submission only skips the e-mail (the queue is
    // the record). Throttle store errors fail OPEN (the e-mail is sent).
    const throttled = env.BETA_REQUESTS_EMAIL ? await operatorNotifyThrottle(canonicalEmailLimitKey(normalizedEmail)) : null;
    if (throttled) {
      console.warn(`[access-request] operator notification throttled reason=${throttled} (request stored)`);
    }
    if (env.BETA_REQUESTS_EMAIL && !throttled) {
      const queueUrl = `${env.NEXT_PUBLIC_APP_URL}/dashboard/platform/GROWTH_REVENUE`;
      const notify = await sendEmail("beta-request", env.BETA_REQUESTS_EMAIL, {
        applicantEmail: normalizedEmail,
        note:           trimmedNote || null,
        queueUrl,
      }, { key: "BETA_REQUEST_RECEIVED", recipientUserId: null });
      if (notify.status === "error") {
        console.error("[access-request] operator notification failed to send:", notify.error);
      }
    }

    // Identical 200 regardless of prior state — non-enumerating.
    return NextResponse.json(IDENTICAL_OK);
  } catch (err) {
    console.error("[access-request] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
