/**
 * lib/email/invite-url.ts  (OPS-1 S3)
 *
 * Pure builder for the Space-invitation email CTA link. Parallels
 * lib/email/{reset,verify}-url.ts so the URL assembly is unit-testable in
 * isolation.
 *
 * Unlike reset/verify, an invite carries NO token — acceptance is identity-
 * gated in-app (the invitee logs in and accepts on /dashboard/spaces). The
 * link is therefore just a trusted-base pointer to that surface; an
 * unauthenticated click flows through /login?callbackUrl=/dashboard/spaces.
 *
 * SECURITY: `base` MUST come from a trusted source (env.NEXT_PUBLIC_APP_URL),
 * never a request Host / X-Forwarded-Host header.
 */

export function buildInviteUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/dashboard/spaces`;
}
