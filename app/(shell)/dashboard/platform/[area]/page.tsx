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
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
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
  if (!session?.user?.id) redirect("/login");

  // 3. ACTIVE grant on this area — access-derived, no SpaceMember lookup.
  const grant = await db.platformGrant.findUnique({
    where:  { userId_area: { userId: session.user.id, area } },
    select: { area: true, level: true, status: true },
  });
  if (!grant || !hasPlatformAccess(area, "READ", [grant])) {
    redirect("/dashboard/spaces");
  }

  // 4. The platform Space + its enabled sections (same section model customer
  //    dashboards use, ordered by `order`).
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
