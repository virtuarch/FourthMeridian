/**
 * lib/platform/seed.ts
 *
 * PO1.0 — the idempotent bootstrap that materializes the four system-singleton
 * platform Spaces (one per PlatformArea), each identified by its Space.platform-
 * Area @unique marker. Safe to run any number of times, anywhere:
 *   - prisma/seed.ts calls it so dev databases always have the four Spaces;
 *   - scripts/seed-platform-spaces.ts is the thin prod CLI over it.
 *
 * NOT `server-only` — this runs inside plain `tsx` scripts (prisma seed + the
 * CLI), not just the Next.js server.
 *
 * DELIBERATELY ABSENT (07-07 design): NO SpaceMember rows (visibility is
 * access-derived from PlatformGrant — the grant is the single source of truth),
 * NO AiAgent (platform Spaces never enter buildContext/brief paths — those are
 * membership-driven), no invites, goals, or snapshots. The upsert's empty
 * `update: {}` guarantees a re-run never mutates a live platform Space.
 */

import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { PLATFORM_AREAS, ALL_PLATFORM_AREAS } from "./policy";

/**
 * Ensure the four platform Spaces exist. Idempotent via the @unique
 * platformArea marker: the upsert keys on it, so a second run is a no-op
 * (`update: {}` never touches an existing row). Returns nothing — call for
 * effect.
 */
export async function ensurePlatformSpaces(
  client: PrismaClient = db,
): Promise<void> {
  for (const area of ALL_PLATFORM_AREAS) {
    const meta = PLATFORM_AREAS[area];
    await client.space.upsert({
      where:  { platformArea: area }, // the @unique marker IS the identity
      update: {},                     // never mutate an existing platform Space
      create: {
        name:         meta.spaceName,
        description:  meta.spaceDescription,
        type:         "SHARED",
        category:     "OTHER",        // mundane; never rendered for platform Spaces
        isPublic:     false,
        platformArea: area,
        dashboardSections: {
          create: meta.sections.map((s) => ({
            key:     s.key,
            label:   s.label,
            tab:     "OVERVIEW" as const,
            enabled: true,
            order:   s.order,
          })),
        },
      },
    });
  }
}

/**
 * Ensure every section declared in PLATFORM_AREAS exists on its already-seeded
 * platform Space.
 *
 * WHY THIS EXISTS (Wave 1 S0): `ensurePlatformSpaces` materializes sections only
 * inside its Space-*create* branch, and its `update: {}` deliberately never
 * touches a live Space (line 37). So once the four Spaces are seeded, ADDING a
 * new entry to `PLATFORM_AREAS[area].sections` does nothing for them — the new
 * section never appears. This closes that gap: for each area it upserts each
 * declared section against the existing `@@unique([spaceId, key])` on
 * SpaceDashboardSection.
 *
 * CREATE-ONLY, exactly like the Space upsert's empty `update`: an existing row
 * is left untouched (`update: {}`), so an operator's manual `enabled`/`order`
 * edit on a live section is never clobbered by a re-run. Only genuinely-new
 * (spaceId, key) pairs are inserted. Idempotent and safe to run anywhere.
 *
 * Runs AFTER `ensurePlatformSpaces` (it needs the Space rows to exist); wired
 * into the same entry points. If a Space is somehow absent it is skipped
 * defensively rather than throwing.
 */
export async function ensurePlatformSections(
  client: PrismaClient = db,
): Promise<void> {
  for (const area of ALL_PLATFORM_AREAS) {
    const meta = PLATFORM_AREAS[area];
    const space = await client.space.findUnique({
      where:  { platformArea: area },
      select: { id: true },
    });
    if (!space) continue; // ensurePlatformSpaces guarantees this; be defensive.

    for (const s of meta.sections) {
      await client.spaceDashboardSection.upsert({
        where:  { spaceId_key: { spaceId: space.id, key: s.key } },
        update: {}, // create-only — never overwrite enabled/order on a live row
        create: {
          spaceId: space.id,
          key:     s.key,
          label:   s.label,
          tab:     "OVERVIEW",
          enabled: true,
          order:   s.order,
        },
      });
    }
  }
}
