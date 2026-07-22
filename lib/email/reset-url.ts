/**
 * lib/email/reset-url.ts  (OPS-1 S2a)
 *
 * Pure builder for the absolute password-reset link that goes in the reset
 * email. Extracted so the URL assembly — and its host-injection safety — is
 * unit-testable in isolation from the route and the DB.
 *
 * SECURITY: `base` MUST come from a trusted source (env.NEXT_PUBLIC_APP_URL),
 * never from a request Host / X-Forwarded-Host header. This function only
 * assembles a string; passing an attacker-controlled base would defeat the
 * whole point, so callers are responsible for supplying the trusted base.
 *
 * The path + query shape (`/reset-password?token=…`) matches what
 * app/(auth)/reset-password/page.tsx reads via useSearchParams().get("token").
 */

/**
 * Build `<base>/reset-password?token=<token>`.
 *
 * - Trailing slashes on `base` are normalised so we never emit a double slash.
 * - `token` is URL-encoded defensively (reset tokens are hex today, but the
 *   builder should not assume that).
 */
export function buildResetUrl(base: string, token: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/reset-password?token=${encodeURIComponent(token)}`;
}
