/**
 * lib/auth/login-redirect.ts — send a Server Component's signed-out visitor to
 * /login WITHOUT losing where they were going.
 *
 * proxy.ts stops a request with no valid JWT and keeps the deep link itself.
 * What reaches a page with no session is the other case: a JWT whose signature
 * is valid but whose session the revocation check rejected (signed out
 * elsewhere, admin-revoked, expired row). Those pages used to call
 * `redirect("/login")` and the user landed on /dashboard/brief after signing
 * back in, whatever they had opened.
 *
 * proxy.ts stamps RETURN_TO_HEADER with the page's path + query on every
 * page request it lets through; this reads it, validates it again
 * (lib/auth/return-to.ts), and redirects to /login?callbackUrl=… — or to a
 * bare /login when it is absent or unsafe. No loop: /login itself renders the
 * form for a revoked session (it uses the same revocation-aware session read).
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loginUrlFor, RETURN_TO_HEADER } from "./return-to";

export async function redirectToLogin(): Promise<never> {
  const returnTo = (await headers()).get(RETURN_TO_HEADER);
  redirect(loginUrlFor(returnTo));
}
