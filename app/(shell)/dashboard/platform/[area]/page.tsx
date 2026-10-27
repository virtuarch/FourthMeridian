/**
 * app/(shell)/dashboard/platform/[area]/page.tsx
 *
 * PO1.0 — the ONLY render path for a platform Space. Server component.
 *
 * Gate order (never discloses existence — an unknown/ungranted area redirects,
 * it does not 404):
 *   1. [area] must be a known PlatformArea            → else /dashboard/platform
 *   2. requirePlatformAccess(area, "READ") — the SAME shared guard every
 *      /api/platform route uses (SEC-PLAT-2):
 *        401 no / revoked session                     → /login (deep link kept)
 *        403 no / insufficient / revoked grant, or a
 *            session still pending TOTP enrolment     → /dashboard/platform
 *            (the refusal is RECORDED by the guard — OBS-009 — which the old
 *             page-local grant read never did)
 *        503 session authority unavailable            → thrown to error.tsx
 *                                                        (fail closed, honestly)
 * SYSTEM_ADMIN never reaches this page — proxy.ts redirects them off
 * /dashboard/* to /admin; they administer grants from there.
 *
 * UX-P2 — the redirect target is the Platform Spaces DIRECTORY
 * (app/(shell)/dashboard/platform/page.tsx), not the launcher: an operator who
 * mistyped or lost an area lands among the areas they DO hold, and the
 * directory itself sends a viewer with zero grants on to /dashboard/spaces. One
 * target here, one zero-grant rule there — simpler than counting grants twice.
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

import { redirect } from "next/navigation";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import { db } from "@/lib/db";
import { PlatformArea } from "@prisma/client";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { PlatformSpaceDashboard } from "@/components/platform/PlatformSpaceDashboard";
import { platformMountContext } from "@/lib/space/mount-context.server";

export const runtime = "nodejs";

export default async function PlatformSpacePage({
  params,
  searchParams,
}: {
  params: Promise<{ area: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { area: areaParam } = await params;
  // UX-P1 Change A — `?workspace=<id>` is the open workspace (the same param the
  // client's navigation authority writes), read here so the FIRST PAINT already
  // shows the deep-linked workspace. A repeated or absent key reads as "none";
  // validation happens ONCE, in platformMountContext's shared resolver (an
  // unknown id degrades to the area default, never to a ghost workspace).
  const { workspace } = await searchParams;
  const requestedWorkspace = typeof workspace === "string" ? workspace : null;

  // 1. Known area? (unknown ⇒ redirect, never 404 — no existence disclosure)
  if (!(Object.values(PlatformArea) as string[]).includes(areaParam)) {
    redirect("/dashboard/platform");
  }
  const area = areaParam as PlatformArea;

  // 2. SEC-PLAT-2 — the shared platform guard, not a page-local grant read: the
  //    session (with its revocation + pending-TOTP checks), the ACTIVE grant
  //    and the denial record all come from lib/platform/authorize.ts, exactly
  //    as for every /api/platform route.
  const [auth, err] = await requirePlatformAccess(area, "READ");
  if (err) {
    if (err.status === 401) return redirectToLogin();
    if (err.status === 403) redirect("/dashboard/platform");
    throw new Error("Platform access could not be verified right now.");
  }
  // SYSTEM_ADMIN (grant === null, break-glass) never reaches this page —
  // proxy.ts sends them to /admin. Fail closed if one somehow does.
  const grant = auth.grant;
  if (!grant) redirect("/dashboard/platform");

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
  if (!space) redirect("/dashboard/platform");

  // PS-6A/6C — compose the SAME domain-neutral SpaceMountContext from the ALREADY-
  // AUTHORIZED platform inputs (area validated, ACTIVE PlatformGrant checked via
  // hasPlatformAccess above, canonical Space.platformArea loaded). This proves the
  // shared contract is domain-neutral: no getSpaceContext, no cookie, no
  // SpaceMember. PS-6C — the dashboard now CONSUMES it for identity / display /
  // navigation / access / shell config, so those are no longer passed separately.
  const mountContext = platformMountContext(
    {
      spaceId:     space.id,
      spaceName:   space.name,
      area,
      areaLabel:   PLATFORM_AREAS[area].label,
      accessLevel: grant.level,
      userId:      auth.user.id,
    },
    { selectedKey: requestedWorkspace },
  );

  return (
    <PlatformSpaceDashboard
      area={area}
      sections={space.dashboardSections}
      mountContext={mountContext}
    />
  );
}
