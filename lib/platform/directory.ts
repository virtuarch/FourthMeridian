/**
 * lib/platform/directory.ts  (UX-P2 — Platform Spaces directory)
 *
 * ONE row shape for "the Platform Spaces this operator's grants reach", and the
 * pure mapper that builds it from the two reads every consumer already makes
 * (the viewer's ACTIVE PlatformGrant rows + the Space rows whose `platformArea`
 * those grants name).
 *
 * Before this file the same list had TWO row shapes — `PlatformSpaceItem
 * {id,name,area,access}` on the Spaces page and `/api/spaces` `platform[]
 * {id,name,platformArea,access}` — and two copies of the sort. The directory
 * page (app/(shell)/dashboard/platform/page.tsx) is now the one home of the HQ
 * cards, and it builds its rows here.
 *
 * PURE and client-safe: no Prisma client, no `server-only`, only the registry's
 * area order (lib/platform/policy.ts exports types + a static table). The reads
 * live in directory.server.ts.
 *
 * ORDER is the registry's (`ALL_PLATFORM_AREAS`), never DB insertion order, so
 * the directory, the sidebar's Platform list and `/api/spaces` agree on every
 * environment. The mapper WALKS the registry: a Space whose area the viewer
 * holds no grant on cannot appear even if a caller hands it in (the server
 * filter already excludes it; this is the second lock, not the first).
 */

import type { PlatformArea } from "@prisma/client";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";

export interface PlatformDirectoryRow {
  /** Space.id — a key, never a link target (platform Spaces are not switch targets). */
  id:     string;
  /** Space.name — the display name, from the row, never from a literal. */
  name:   string;
  /** PlatformArea as a string — the ONLY thing a link is built from. */
  area:   string;
  /** The viewer's access level on that area, as granted (READ / MANAGE / CONTROL …). */
  access: string;
}

export interface PlatformDirectoryGrant {
  area:  PlatformArea;
  level: string;
}

export interface PlatformDirectorySpace {
  id:           string;
  name:         string;
  platformArea: PlatformArea | null;
}

/** The ONLY render path for a platform Space: the bare area URL (= its default
 *  workspace). No cookie, no switch call, no `?workspace=` — never auto-open. */
export function platformAreaHref(area: string): string {
  return `/dashboard/platform/${area}`;
}

/**
 * Rows in registry order, one per area the viewer is granted AND a Space row
 * exists for. A grant without its seeded Space yields no row (there is nothing
 * to open); a Space without a grant yields no row (there is no right to).
 */
export function platformDirectoryRows(
  spaces: readonly PlatformDirectorySpace[],
  grants: readonly PlatformDirectoryGrant[],
): PlatformDirectoryRow[] {
  const out: PlatformDirectoryRow[] = [];
  for (const area of ALL_PLATFORM_AREAS) {
    const grant = grants.find((g) => g.area === area);
    if (!grant) continue;
    const space = spaces.find((s) => s.platformArea === area);
    if (!space) continue;
    out.push({ id: space.id, name: space.name, area, access: grant.level });
  }
  return out;
}
