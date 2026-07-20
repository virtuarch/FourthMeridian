/**
 * lib/admin-totp-enrollment.ts
 *
 * PO-1A — the PURE rules governing forced TOTP enrolment: which SURFACE a
 * pending operator is shown, and whether a session may reach the admin APIs.
 *
 * WHY THIS EXISTS
 * ---------------
 * PO-1 made enrolment mandatory for SYSTEM_ADMIN (lib/auth-totp-policy.ts) and
 * lib/session.ts denies every pending session at the API boundary. Both are
 * correct and stay correct. What was missing was an EXPLICIT enrolment state:
 * /admin/security inferred everything from /api/admin/security/admin-status,
 * which is itself gated — so a pending admin's page sat on "Loading…" forever
 * with the enrolment widget nested INSIDE the branch that never rendered. The
 * enrolment surface depended on data only an enrolled admin could fetch.
 *
 * The fix is to make the state explicit and resolve it from the SESSION (which
 * already carries `requireTotpSetup`) BEFORE any gated fetch is composed — see
 * app/admin/security/page.tsx. Keeping the rule pure here means the surface
 * choice and the API decision are unit-testable without a DB, a session, or a
 * browser, exactly like requiresTotpEnrollment().
 *
 * THE INVARIANT (unchanged from PO-1): a pending session reaches NOTHING but
 * the enrolment endpoints. `decideAdminApiAccess` does not soften that — it is
 * the same two checks lib/session.ts always ran, lifted into a pure function so
 * they can be proven. Role is checked BEFORE enrolment so a non-admin never
 * learns anything about admin enrolment state.
 */

import { UserRole } from "@prisma/client";

// ── Enrolment surfaces ────────────────────────────────────────────────────────

/**
 * Where a pending session is sent to enrol. These are the ONLY two enrolment
 * surfaces in the product.
 *
 * Both carry `setup2fa=true`, which puts the enrolment widget into its
 * non-dismissable "enforced" mode. The admin surface no longer DEPENDS on that
 * query param — app/admin/security/page.tsx resolves the phase server-side and
 * passes `enforced` explicitly — but the param is preserved so a direct link
 * behaves identically.
 *
 * NOTE — the user path points at the `security` SECTION, not the `/dashboard/
 * settings` index. The index is a server redirect to `…/settings/account`,
 * which DROPS the query string: routing enrolment through it silently stripped
 * `setup2fa` and landed the user on a page with no enrolment UI at all.
 *
 * proxy.ts cannot import these (it runs on the Edge and deliberately keeps a
 * zero-dependency module graph — see its header). The literals are duplicated
 * there and locked to these constants by
 * lib/admin-totp-enrollment-surface.test.ts.
 */
export const ADMIN_TOTP_ENROLLMENT_PATH = "/admin/security?setup2fa=true";
export const USER_TOTP_ENROLLMENT_PATH  = "/dashboard/settings/security?setup2fa=true";

/** The enrolment surface for a role. */
export function totpEnrollmentPathFor(role: UserRole): string {
  return role === UserRole.SYSTEM_ADMIN
    ? ADMIN_TOTP_ENROLLMENT_PATH
    : USER_TOTP_ENROLLMENT_PATH;
}

// ── Which surface /admin/security renders ─────────────────────────────────────

/**
 * ENROLLING — render the enrolment screen ONLY. No gated admin data may be
 *             composed in this phase; that dependency is what deadlocked.
 * ENROLLED   — render the full security console.
 */
export type AdminTotpPhase = "ENROLLING" | "ENROLLED";

export interface AdminTotpPhaseInput {
  /** The session's forced-enrolment flag (`session.requireTotpSetup`). */
  requireTotpSetup: boolean;
}

/**
 * Resolves which surface /admin/security must render.
 *
 * Deliberately depends ONLY on the session flag — not on totpEnabled read from
 * the database, and not on a query param. The session flag is what every guard
 * in lib/session.ts enforces, so keying the UI to the same input makes the
 * screen and the API agree by construction: if the phase is ENROLLING, every
 * admin API would 403, so the console must not be rendered.
 */
export function resolveAdminTotpPhase(input: AdminTotpPhaseInput): AdminTotpPhase {
  return input.requireTotpSetup ? "ENROLLING" : "ENROLLED";
}

// ── Whether a session may reach the admin APIs ────────────────────────────────

/**
 * FORBIDDEN_ROLE     — not a SYSTEM_ADMIN.
 * FORBIDDEN_PENDING  — a SYSTEM_ADMIN who has not completed forced enrolment.
 * ALLOW              — an enrolled SYSTEM_ADMIN.
 *
 * Both FORBIDDEN_* map to an identical 403 on the wire; they are distinguished
 * here only so tests can prove WHICH rule rejected, never to tell a caller.
 */
export type AdminApiAccess = "ALLOW" | "FORBIDDEN_ROLE" | "FORBIDDEN_PENDING";

export interface AdminApiAccessInput {
  role:             UserRole;
  requireTotpSetup: boolean;
}

/**
 * The admin-API authorization rule, lifted out of requireSystemAdmin() /
 * requireFreshSystemAdmin() so it is provable in isolation. Those guards
 * delegate here; this function is the authority.
 *
 * There is NO opt-out parameter, by design. The enrolment endpoints
 * (/api/user/totp/*) are ordinary-user surfaces guarded by requireUser({
 * allowTotpSetupPending: true }) — no admin route may ever take that path.
 */
export function decideAdminApiAccess(input: AdminApiAccessInput): AdminApiAccess {
  if (input.role !== UserRole.SYSTEM_ADMIN) return "FORBIDDEN_ROLE";
  if (input.requireTotpSetup)               return "FORBIDDEN_PENDING";
  return "ALLOW";
}
