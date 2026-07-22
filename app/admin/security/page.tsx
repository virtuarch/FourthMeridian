/**
 * app/admin/security/page.tsx — Security Admin route
 *
 * PO-1A — a SERVER component whose only job is to choose the surface BEFORE any
 * gated data is composed.
 *
 * The bug this fixes: proxy.ts sends a pending SYSTEM_ADMIN here
 * (/admin/security?setup2fa=true) to enrol, but this route used to be the
 * client console, whose enrolment widget was nested inside a branch gated on
 * /api/admin/security/admin-status. requireSystemAdmin() 403s that endpoint for
 * a pending session — correctly — so the branch never opened, the widget never
 * mounted, and the admin was pinned on "Loading…" with no route to enrolment
 * and no route out. The enrolment surface depended on data that only an
 * enrolled admin could obtain.
 *
 * Resolving the phase from the SESSION here means the two branches are
 * mutually exclusive by construction: AdminTotpEnrollment (no gated fetches) or
 * AdminSecurityConsole (all of them), never a console trying to degrade
 * gracefully around its own 403s.
 *
 * This is a rendering decision, not an authorization one. It reads only the
 * caller's own role and enrolment flag and returns no privileged data;
 * requireSystemAdmin() remains the sole authority on every /api/admin/* route
 * and is untouched. The redirects below mirror proxy.ts so a direct hit
 * behaves the same when the proxy is bypassed.
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { resolveAdminTotpPhase } from "@/lib/admin-totp-enrollment";
import { AdminSecurityConsole } from "@/components/admin/AdminSecurityConsole";
import { AdminTotpEnrollment } from "@/components/admin/AdminTotpEnrollment";

export default async function AdminSecurityPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== UserRole.SYSTEM_ADMIN) redirect("/dashboard");

  const phase = resolveAdminTotpPhase({
    requireTotpSetup: session.requireTotpSetup ?? false,
  });

  if (phase === "ENROLLING") return <AdminTotpEnrollment />;

  return <AdminSecurityConsole />;
}
