/**
 * app/(shell)/dashboard/platform/[area]/page.tsx
 *
 * PO1.0 — the ONLY render path for a platform Space. Server component.
 *
 * Gate order (never discloses existence — an unknown/ungranted area redirects,
 * it does not 404):
 *   1. [area] must be a known PlatformArea            → else /dashboard/spaces
 *   2. a session must exist                            → else /login
 *   3. an ACTIVE PlatformGrant on this area must exist → else /dashboard/spaces
 * SYSTEM_ADMIN never reaches this page — proxy.ts redirects them off
 * /dashboard/* to /admin; they administer grants from there.
 *
 * This page deliberately uses NO customer-Space DATA/AUTH machinery: no
 * resolveSpaceContext, no ACTIVE_SPACE_COOKIE, no SpaceMember lookup, no
 * can()/requireSpaceRole, no SPACE_TAB_ORDER rail, no WIDGET_REGISTRY. Visibility
 * and gating are grant-derived only (tripwired in lib/platform-surface.test.ts).
 *
 * SD-2E: the render surface (PlatformSpaceDashboard) now composes the SHARED,
 * domain-agnostic SpaceShell FRAME — the same primitive customer Spaces use — so
 * Platform Spaces no longer require a fork of the shell architecture. That is a
 * frame convergence only; the grant-derived gating and self-fetching platform
 * widgets above/below are unchanged, and none of the customer data/authz machinery
 * listed above is introduced.
 *
 * ── RLS-T3 — THIS PAGE STAYS ON `db`, AND THE REASON IS A MEASURED HOLE ──────
 *
 * This is an OPERATOR surface, not a tenant one. An operator reaching a platform
 * Space is acting OUTSIDE their own tenancy by definition: the four platform
 * Spaces hold ZERO SpaceMember rows (verified on the dev corpus — Platform
 * Operations, Security Operations, Growth & Revenue, Customer Success: 0, 0, 0,
 * 0), so `fm_visible_space_ids()` can never contain one. The right authority is
 * `systemDb`, as it already is for every other platform reader
 * (`lib/platform/`, `app/api/platform/`).
 *
 * fm_app would COMPILE here, and two of the three reads would even work, which
 * is exactly the trap:
 *
 *   · the grant read is `userId = current_fm_user_id()` (§9) — fine, and it is
 *     also a question about the caller, so there is no authority to gain;
 *   · the Space row is admitted by `Space.fm_app_sel`'s platform arm (§11),
 *     written so operators can see the Spaces they own;
 *   · the Space's SECTIONS are NOT. `SpaceDashboardSection` is a §7
 *     `spaceId IN (SELECT fm_visible_space_ids())` table and NO migration gives
 *     it a platform arm. `dashboardSections` is a to-MANY relation, so under
 *     fm_app it would come back `[]` — SILENTLY. On the dev corpus Platform
 *     Operations has 27 enabled sections and would render with none of them,
 *     with no error, no log and no 404 to notice.
 *
 * So routing this page through fm_app would be a silent product regression
 * dressed as a security win, and it is not taken. The page is left on the
 * migration principal EXPLICITLY, behind the three gates above, pending ONE
 * audit allowlist entry that is not this slice's to write:
 *
 *     scripts/audit-db-authority.ts → CONFINED.systemDb.allowed +=
 *       "app/(shell)/dashboard/platform/[area]/page.tsx"
 *
 * listed as a FILE and never as `app/(shell)/dashboard/platform/`, for the same
 * reason `lib/users/availability.ts` and `lib/accounts/links-everywhere.ts` are
 * files: the widest authority is reached through the narrowest opening. Granting
 * the directory would hand fm_system to every future page under it.
 *
 * The alternative — a platform arm on §7's thirteen-table loop — is a tenancy
 * change, not a page change, and belongs to whoever owns the policies.
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { PlatformArea } from "@prisma/client";
import { PLATFORM_AREAS, hasPlatformAccess } from "@/lib/platform/policy";
import { PlatformSpaceDashboard } from "@/components/platform/PlatformSpaceDashboard";
import { platformMountContext } from "@/lib/space/mount-context.server";

export const runtime = "nodejs";

export default async function PlatformSpacePage({
  params,
}: {
  params: Promise<{ area: string }>;
}) {
  const { area: areaParam } = await params;

  // 1. Known area? (unknown ⇒ redirect, never 404 — no existence disclosure)
  if (!(Object.values(PlatformArea) as string[]).includes(areaParam)) {
    redirect("/dashboard/spaces");
  }
  const area = areaParam as PlatformArea;

  // 2. Session (same pattern as app/(shell)/dashboard/spaces/page.tsx).
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  // 3. ACTIVE grant on this area — access-derived, no SpaceMember lookup.
  // RLS-T3 — on `db` explicitly; see the header. fm_app could serve this one
  // read, but splitting a single gate across two authorities buys nothing: the
  // lookup is keyed on the session's OWN userId, so it cannot return anybody
  // else's grant whatever principal asks.
  const grant = await db.platformGrant.findUnique({
    where:  { userId_area: { userId: session.user.id, area } },
    select: { area: true, level: true, status: true },
  });
  if (!grant || !hasPlatformAccess(area, "READ", [grant])) {
    redirect("/dashboard/spaces");
  }

  // 4. The platform Space + its enabled sections (same section model customer
  //    dashboards use, ordered by `order`).
  // RLS-T3 — on `db` explicitly; see the header. THIS is the read fm_app cannot
  // serve: the Space row is admitted by §11's platform arm, the
  // SpaceDashboardSection rows beneath it are not, and a to-many relation
  // returns `[]` rather than failing.
  const space = await db.space.findUnique({
    where:  { platformArea: area },
    select: {
      id:   true,
      name: true,
      dashboardSections: {
        where:   { enabled: true },
        orderBy: { order: "asc" },
        select:  { id: true, key: true, label: true },
      },
    },
  });
  // The seed guarantees the Space exists; if it somehow doesn't, fail closed.
  if (!space) redirect("/dashboard/spaces");

  // PS-6A/6C — compose the SAME domain-neutral SpaceMountContext from the ALREADY-
  // AUTHORIZED platform inputs (area validated, ACTIVE PlatformGrant checked via
  // hasPlatformAccess above, canonical Space.platformArea loaded). This proves the
  // shared contract is domain-neutral: no getSpaceContext, no cookie, no
  // SpaceMember. PS-6C — the dashboard now CONSUMES it for identity / display /
  // navigation / access / shell config, so those are no longer passed separately.
  const mountContext = platformMountContext({
    spaceId:     space.id,
    spaceName:   space.name,
    area,
    areaLabel:   PLATFORM_AREAS[area].label,
    accessLevel: grant.level,
    userId:      session.user.id,
  });

  return (
    <PlatformSpaceDashboard
      area={area}
      sections={space.dashboardSections}
      mountContext={mountContext}
    />
  );
}
