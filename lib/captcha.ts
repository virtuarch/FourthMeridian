/**
 * lib/captcha.ts  (Wave 1 S3 — shipped here so Wave 2 ⑥ only consumes it;
 * R2 beta-intake hardening 2026-10-31 — fail CLOSED when configured)
 *
 * Server-side CAPTCHA (Cloudflare Turnstile) verification, behind a single
 * helper so every spam-exposed endpoint calls one thing: `verifyCaptchaToken`.
 * Callers (all share these semantics — keep them consistent):
 *   - app/api/access-request/route.ts  — every submission
 *   - app/api/auth/register/route.ts   — every registration
 *   - lib/auth.ts authorize()          — login step-up past the per-identifier
 *                                        failure threshold
 *
 * TWO MODES (`captchaMode()`):
 *
 *   "not_configured" — no `TURNSTILE_SECRET_KEY`. Verification is SKIPPED and
 *     returns `true` with no network call (dev/test, and any deploy that has
 *     not been given keys). A single warning is logged per process so an
 *     unprotected deploy is visible in the logs rather than silent.
 *
 *   "enforced" — a secret is configured. A token is verified against
 *     Cloudflare's siteverify endpoint and ONLY a positive `success: true`
 *     passes. Everything else FAILS CLOSED and returns `false`:
 *       - missing/empty token,
 *       - Cloudflare `success: false`,
 *       - non-2xx from Cloudflare,
 *       - network error, timeout (VERIFY_TIMEOUT_MS) or malformed JSON.
 *
 * WHY FAIL CLOSED (owner decision, R2): the earlier fail-open posture meant a
 * bot only had to wait for — or induce — a siteverify error or timeout to
 * bypass the challenge entirely, so a configured CAPTCHA was not actually a
 * control. The cost is accepted: during a Cloudflare siteverify outage,
 * CAPTCHA-gated actions (access requests, registrations, and step-up logins
 * past the failure threshold) are refused with the callers' ordinary "CAPTCHA
 * verification failed" responses until Cloudflare recovers. Ordinary logins
 * below the step-up threshold never call this and are unaffected.
 *
 * NO SDK: Turnstile verification is one POST to a documented URL, so there is no
 * import to isolate — the single-import-site house rule is satisfied by having
 * no import at all.
 */

import "server-only";

/** Cloudflare Turnstile server-side verification endpoint. */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** How long to wait on Cloudflare before failing CLOSED (ms). */
export const VERIFY_TIMEOUT_MS = 5_000;

/** The subset of the siteverify JSON response we read. */
interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

export type CaptchaMode = "enforced" | "not_configured";

/** Whether server-side CAPTCHA verification is enforced on this deploy. */
export function captchaMode(): CaptchaMode {
  return process.env.TURNSTILE_SECRET_KEY ? "enforced" : "not_configured";
}

let loggedMode: CaptchaMode | null = null;
/** Log the mode once per process (and again only if it changes). */
function logModeOnce(mode: CaptchaMode): void {
  if (loggedMode === mode) return;
  loggedMode = mode;
  if (mode === "not_configured") {
    console.warn("[captcha] TURNSTILE_SECRET_KEY not set — CAPTCHA verification is NOT enforced (requests pass unchallenged)");
  } else if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    // A secret without a site key means the widget is never rendered, so no
    // client can produce a token and every gated request will be refused.
    console.error("[captcha] TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not — every CAPTCHA-gated request will be refused");
  } else {
    console.log("[captcha] Turnstile verification enforced (fail-closed)");
  }
}

/**
 * Verify a Turnstile token for a client IP.
 *
 * @param token  The `cf-turnstile-response` value posted by the widget. May be
 *               empty/absent — a failed challenge when enforced, ignored when
 *               not configured.
 * @param ip     The caller's IP (Cloudflare's `remoteip`), best-effort. Optional.
 * @param opts   `timeoutMs` override (tests).
 * @returns      `true` only if CAPTCHA is not configured OR Cloudflare positively
 *               confirmed the token. `false` in every other case (fail-closed).
 */
export async function verifyCaptchaToken(
  token: string | undefined | null,
  ip?: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const mode = captchaMode();
  logModeOnce(mode);
  if (mode === "not_configured") return true;

  const secret = process.env.TURNSTILE_SECRET_KEY as string;

  // An enforced CAPTCHA with no token is a failed challenge.
  if (!token) return false;

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? VERIFY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(SITEVERIFY_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    form.toString(),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      console.error(`[captcha] siteverify HTTP ${res.status} — failing CLOSED`);
      return false;
    }

    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch (err) {
    // Network error / abort (timeout) / malformed JSON — fail CLOSED (see header).
    console.error("[captcha] siteverify call failed — failing CLOSED:", err instanceof Error ? err.message : err);
    return false;
  }
}
