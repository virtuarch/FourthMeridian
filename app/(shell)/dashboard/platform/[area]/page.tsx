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
 * This page deliberately uses NO customer-Space machinery: no resolveSpace-
 * Context, no ACTIVE_SPACE_COOKIE, no SpaceMember lookup, no can()/require-
 * SpaceRole, no SPACE_TAB_ORDER rail, no WIDGET_REGISTRY. Visibility and gating
 * are grant-derived only (tripwired in lib/platform-surface.test.ts).
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { PlatformArea } from "@prisma/client";
import { PLATFORM_AREAS, hasPlatformAccess } from "@/lib/platform/policy";
import { PlatformSpaceDashboard } from "@/components/platform/PlatformSpaceDashboard";

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

  return (
    <PlatformSpaceDashboard
      areaLabel={PLATFORM_AREAS[area].label}
      spaceName={space.name}
      accessLevel={grant.level}
      sections={space.dashboardSections}
    />
  );
}
