/**
 * lib/auth/totp-page-gate.ts — SEC-001: the server wrapper around the pure
 * page gate (lib/auth/page-gate.ts) for Server Components.
 *
 * Reads the page's own path from the proxy-stamped RETURN_TO_HEADER (re-
 * validated through lib/auth/return-to.ts, exactly as login-redirect does —
 * a client-supplied value is never trusted) and redirects a TOTP-pending
 * session to its enrolment surface. Called by app/admin/layout.tsx,
 * app/admin/page.tsx and app/(shell)/dashboard/layout.tsx AFTER the session
 * and role checks; lib/auth/page-gate.test.ts pins those call sites.
 *
 * `redirect()` throws, so a caller that reaches the next line is rendering a
 * session that is either enrolled or on its enrolment surface.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { RETURN_TO_HEADER, validateReturnTo } from "./return-to";
import { decideTotpPageGate, pathnameOf } from "./page-gate";

export interface GateableSession {
  requireTotpSetup?: boolean | null;
  user: { role: UserRole };
}

export async function enforceTotpPageGate(session: GateableSession): Promise<void> {
  if (!session.requireTotpSetup) return;
  const returnTo = validateReturnTo((await headers()).get(RETURN_TO_HEADER));
  const decision = decideTotpPageGate({
    requireTotpSetup: true,
    role:             session.user.role,
    pathname:         pathnameOf(returnTo),
  });
  if (decision.kind === "redirect") redirect(decision.to);
}
