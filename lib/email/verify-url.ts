/**
 * lib/email/verify-url.ts  (OPS-1 S2b)
 *
 * Pure builder for the absolute email-verification link. Parallels
 * lib/email/reset-url.ts so the URL assembly + host-injection safety are
 * unit-testable in isolation from the route and the DB.
 *
 * SECURITY: `base` MUST come from a trusted source (env.NEXT_PUBLIC_APP_URL),
 * never a request Host / X-Forwarded-Host header.
 *
 * NOTE (S2b is seam-only): the target path `/verify-email` has no page/route
 * yet — the token is stored but not consumed. The link points at the future
 * consumer path so no email content changes when that slice lands.
 */

export function buildVerifyUrl(base: string, token: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/verify-email?token=${encodeURIComponent(token)}`;
}
