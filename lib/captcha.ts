/**
 * lib/captcha.ts  (Wave 1 S3 — shipped here so Wave 2 ⑥ only consumes it)
 *
 * Server-side CAPTCHA (Cloudflare Turnstile) verification, behind a single
 * helper so every spam-exposed endpoint calls one thing: `verifyCaptchaToken`.
 *
 * ENV-GATED, exactly like the email seam (lib/email/send.ts:36-38 gates real
 * delivery on RESEND_API_KEY): with no `TURNSTILE_SECRET_KEY` configured,
 * verification is SKIPPED and returns `true`. So dev/test — and this whole slice
 * before Wave 2 wires real keys — behave as if CAPTCHA passed, with no network
 * call and no credentials. The moment a secret is present, tokens are verified
 * for real against Cloudflare's siteverify endpoint.
 *
 * NON-THROWING + FAIL-OPEN-WITH-LOG on a Cloudflare outage: a siteverify error
 * or timeout returns `true` (and logs), mirroring the rate-limiter's documented
 * fail-open posture. Failing CLOSED here would let a Cloudflare API blip take
 * down all registration/access-request — a worse outcome than briefly admitting
 * unverified traffic. The token's own single-use nature at Cloudflare limits the
 * blast radius of the open window.
 *
 * NO SDK: Turnstile verification is one POST to a documented URL, so there is no
 * import to isolate — the single-import-site house rule is satisfied by having
 * no import at all.
 */

import "server-only";

/** Cloudflare Turnstile server-side verification endpoint. */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** How long to wait on Cloudflare before failing open (ms). */
const VERIFY_TIMEOUT_MS = 5_000;

/** The subset of the siteverify JSON response we read. */
interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Verify a Turnstile token for a client IP.
 *
 * @param token  The `cf-turnstile-response` value posted by the widget. May be
 *               empty/absent — treated as a failed challenge when a secret is
 *               configured, ignored when CAPTCHA is disabled.
 * @param ip     The caller's IP (Cloudflare's `remoteip`), best-effort. Optional.
 * @returns      `true` if the challenge passed OR CAPTCHA is disabled OR
 *               Cloudflare was unreachable (fail-open). `false` only when a
 *               secret is configured AND Cloudflare positively rejected the token.
 */
export async function verifyCaptchaToken(token: string | undefined | null, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  // Disabled (dev/test, and this whole slice until Wave 2 configures keys).
  if (!secret) return true;

  // A configured CAPTCHA with no token is a failed challenge — not fail-open.
  if (!token) return false;

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
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
      // Cloudflare returned non-2xx — treat as an outage, fail open with a log.
      console.error(`[captcha] siteverify HTTP ${res.status} — failing open`);
      return true;
    }

    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch (err) {
    // Network error / abort / malformed JSON — fail open with a log (see header).
    console.error("[captcha] siteverify call failed — failing open:", err);
    return true;
  }
}
