/**
 * lib/marketing/request-access.ts
 *
 * The single dynamic seam of the public landing page: the "Request beta access"
 * form posts { email, note? } to POST /api/access-request — a public endpoint
 * hosted by this app (built in Wave 1②). This module is that seam's client-side
 * wrapper, and it is deliberately the ONLY business logic the landing page owns.
 *
 * Architecture (investigation §3): the landing page never touches the database.
 * When it eventually splits into its own repo/deploy, it carries the static
 * pages plus this one fetch URL as config — no Prisma client, no schema, no
 * auth. Keep this file free of any such import so that split stays a move, not
 * a rewrite.
 *
 * Graceful degradation: Wave 1② runs in parallel and may not have landed yet.
 * If the endpoint 404s (route absent), we treat the request as "queued" rather
 * than an error — the page shows the same "thanks, we'll be in touch" state it
 * would on success, so the form is never a dead end during the rollout window.
 * A genuine failure (network error, 5xx, rate-limit) still surfaces as an error
 * the user can retry.
 */

/** The one URL that is the entire beta-gate seam. Relative on purpose: same
 *  origin today; a config value when the marketing site splits out. */
export const ACCESS_REQUEST_ENDPOINT = "/api/access-request";

export type AccessRequestInput = {
  email: string;
  /** Optional free-text context (e.g. how they heard about us, a security report). */
  note?: string;
  /** Cloudflare Turnstile token (Wave 2 ⑥). Sent when a site key is configured;
   *  the server verifies it (env-gated — skipped when CAPTCHA is unconfigured). */
  captchaToken?: string | null;
};

export type AccessRequestResult =
  /** Server accepted the request (2xx), or the endpoint isn't live yet (404) —
   *  either way the user should see the success/"we'll be in touch" shell. */
  | { status: "queued"; degraded: boolean }
  /** The user submitted too quickly / too often (rate-limited, 429). */
  | { status: "rate_limited"; message: string }
  /** A real failure the user can retry (network error, 5xx, malformed input). */
  | { status: "error"; message: string };

/** Minimal RFC-5322-ish sanity check — the real validation lives server-side
 *  (Wave 1②). This only stops obviously-empty submissions client-side. */
export function isProbablyEmail(value: string): boolean {
  const v = value.trim();
  return v.length >= 3 && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export async function submitAccessRequest(
  input: AccessRequestInput,
): Promise<AccessRequestResult> {
  const email = input.email.trim().toLowerCase();
  const note = input.note?.trim();
  const captchaToken = input.captchaToken || undefined;

  if (!isProbablyEmail(email)) {
    return { status: "error", message: "Please enter a valid email address." };
  }

  let res: Response;
  try {
    res = await fetch(ACCESS_REQUEST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        ...(note ? { note } : {}),
        ...(captchaToken ? { captchaToken } : {}),
      }),
    });
  } catch {
    // Network-level failure — genuinely couldn't reach the server.
    return {
      status: "error",
      message: "Couldn't reach the server. Please check your connection and try again.",
    };
  }

  // Endpoint not live yet (Wave 1② hasn't landed): degrade to the success
  // shell rather than showing the user an error for our own rollout ordering.
  if (res.status === 404) {
    return { status: "queued", degraded: true };
  }

  if (res.status === 429) {
    return {
      status: "rate_limited",
      message: "Too many requests. Please wait a moment and try again.",
    };
  }

  if (res.ok) {
    return { status: "queued", degraded: false };
  }

  return {
    status: "error",
    message: "Something went wrong submitting your request. Please try again.",
  };
}
