/**
 * lib/email/beta-invite-url.ts  (Wave 1 S3)
 *
 * Pure builder for the beta-invite CTA link. Parallels lib/email/reset-url.ts so
 * the URL assembly — and its host-injection safety — is unit-testable in
 * isolation from the route and the DB.
 *
 * Unlike a Space invite (which carries no token — acceptance is identity-gated
 * in-app), a beta invite DOES carry a single-use token: the recipient has no
 * account yet, so the token is what the register route redeems. The link points
 * at the registration page with the token in the query; the page forwards it as
 * `inviteToken` in the register POST body.
 *
 * SECURITY: `base` MUST come from a trusted source (env.NEXT_PUBLIC_APP_URL),
 * never a request Host / X-Forwarded-Host header. This function only assembles a
 * string; passing an attacker-controlled base would defeat the point.
 *
 * The path + query shape (`/register?invite=…`) matches what
 * app/(auth)/register/page.tsx reads via useSearchParams().get("invite").
 */

export function buildBetaInviteUrl(base: string, token: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/register?invite=${encodeURIComponent(token)}`;
}
