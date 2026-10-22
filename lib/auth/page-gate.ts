/**
 * lib/auth/page-gate.ts — SEC-001: the PURE forced-TOTP gate for server-rendered
 * pages.
 *
 * WHY THIS EXISTS. lib/session.ts denies every TOTP-pending session at the API
 * boundary, and proxy.ts confines page NAVIGATIONS to the enrolment surface —
 * but proxy.ts can only read the JWT, whose `requireTotpSetup` is a navigation
 * HINT (it was client-updatable until SEC-001; it is now re-derived on update,
 * but it is still a cached copy, not the authority). The server components
 * under /admin and /dashboard rendered on session + role alone and never asked
 * the DB-derived `session.requireTotpSetup`, so the page half of the product
 * disagreed with the API half. This decision is the page half's authority: it
 * keys on the SAME DB-derived flag every lib/session.ts guard enforces.
 *
 * THE RULE.
 *   - not pending                              → render
 *   - pending, on the role's enrolment surface → render (the surface hosts the
 *                                                enrolment widget — gating it on
 *                                                enrolment is the PO-1A deadlock)
 *   - pending, anywhere else                   → redirect to the role's
 *                                                enrolment path
 *   - pending, pathname unknown                → redirect (FAIL CLOSED: a page
 *                                                that cannot prove it is the
 *                                                enrolment surface is not it)
 *
 * The enrolment surface prefixes MUST equal the allow-list in proxy.ts
 * (`totpSetupAllowed`) — lib/auth/page-gate.test.ts pins both to these
 * constants. Only the PATH is compared: the query string (`setup2fa=true`) is
 * a presentation flag and never a gate input.
 *
 * Pure: imports only the enrolment path constants. No next/headers, no redirect
 * — lib/auth/totp-page-gate.ts is the server wrapper.
 */

import { UserRole } from "@prisma/client";
import { totpEnrollmentPathFor } from "@/lib/admin-totp-enrollment";

/** The path prefixes a PENDING session may render. Mirrors proxy.ts. */
export const ADMIN_TOTP_ENROLLMENT_SURFACE = "/admin/security";
export const USER_TOTP_ENROLLMENT_SURFACE  = "/dashboard/settings/security";

export function totpEnrollmentSurfaceFor(role: UserRole): string {
  return role === UserRole.SYSTEM_ADMIN ? ADMIN_TOTP_ENROLLMENT_SURFACE : USER_TOTP_ENROLLMENT_SURFACE;
}

export interface TotpPageGateInput {
  /** The DB-derived flag (`session.requireTotpSetup`), never the token's hint. */
  requireTotpSetup: boolean;
  role:             UserRole;
  /**
   * The page's own path (no query), or null when it cannot be established.
   * Server Components cannot see their URL; the caller reads it from the
   * proxy-stamped RETURN_TO_HEADER and re-validates it.
   */
  pathname:         string | null;
}

export type TotpPageGateDecision =
  | { readonly kind: "render" }
  | { readonly kind: "redirect"; readonly to: string };

/** True when `pathname` is the enrolment surface for `role` (exact or a sub-path). */
export function isTotpEnrollmentSurface(role: UserRole, pathname: string): boolean {
  const surface = totpEnrollmentSurfaceFor(role);
  return pathname === surface || pathname.startsWith(`${surface}/`);
}

export function decideTotpPageGate(input: TotpPageGateInput): TotpPageGateDecision {
  if (!input.requireTotpSetup) return { kind: "render" };
  if (input.pathname !== null && isTotpEnrollmentSurface(input.role, input.pathname)) {
    return { kind: "render" };
  }
  return { kind: "redirect", to: totpEnrollmentPathFor(input.role) };
}

/** The path component of a (validated) return-to value: everything before `?` or `#`. */
export function pathnameOf(returnTo: string | null): string | null {
  if (returnTo === null) return null;
  const path = returnTo.split(/[?#]/, 1)[0];
  return path.startsWith("/") ? path : null;
}
