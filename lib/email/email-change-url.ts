/**
 * lib/email/email-change-url.ts  (OPS-2 S3a)
 *
 * Pure builder for the email-change confirmation link. Parallels
 * lib/email/{reset,verify}-url.ts so the URL assembly + host-injection safety
 * are unit-testable in isolation.
 *
 * SECURITY: `base` MUST come from a trusted source (env.NEXT_PUBLIC_APP_URL),
 * never a request Host / X-Forwarded-Host header.
 *
 * NOTE (S3a is request-side only): the target path `/confirm-email-change` has
 * no page/route yet — the S3b confirm consumer lands it. The link points at
 * the future path so no email content changes when that slice ships.
 */

export function buildEmailChangeUrl(base: string, token: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/confirm-email-change?token=${encodeURIComponent(token)}`;
}
