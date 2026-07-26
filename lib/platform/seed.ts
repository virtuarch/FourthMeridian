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
 * Creates genuinely-new (spaceId, key) pairs, and converges SYSTEM-OWNED
 * metadata on rows that already exist. Operator-owned columns keep the original
 * create-only guarantee — see the ownership table above the function.
 *
 * Runs AFTER `ensurePlatformSpaces` (it needs the Space rows to exist); wired
 * into the same entry points. If a Space is somehow absent it is skipped
 * defensively rather than throwing.
 */
export interface PlatformSectionSeedResult {
  /** (spaceId, key) pairs inserted because no row existed. */
  created: number;
  /** Rows whose SYSTEM-OWNED metadata had drifted and was converged. */
  relabelled: number;
}

/**
 * ── FIELD OWNERSHIP ──────────────────────────────────────────────────────────
 *
 * The create-only rule was right about one thing and wrong about another, and
 * the difference is who owns the field.
 *
 *   SYSTEM-OWNED (canonical, must converge)
 *     `label` — display text declared by PLATFORM_AREAS. There is no operator UI
 *               that renames a platform section: platform Spaces render no
 *               SpaceControls and no ManageSpaceModal, so the registry is the
 *               only writer there has ever been. A create-only `label` therefore
 *               does not protect an operator edit — it preserves a stale copy of
 *               our own constant, and the sidebar then disagrees with the code.
 *     `tab`   — always OVERVIEW for platform sections.
 *
 *   OPERATOR-OWNED (must be preserved)
 *     `enabled` — whether the surface shows. Resetting this to `true` would
 *                 silently un-hide a section an operator deliberately disabled.
 *     `order`   — position. For platform areas display order actually comes from
 *                 PLATFORM_AREA_WORKSPACES and this column is just a unique Int,
 *                 but it is operator-shaped and nothing here needs to touch it.
 *     `config`  — section-specific settings, never ours.
 *
 * So this reconciles `label` ONLY, and only where it has actually drifted. That
 * is the narrowest change that makes canonical metadata converge; every other
 * column keeps the create-only guarantee it had.
 *
 * IDEMPOTENT IN THE STRICT SENSE: the convergence is a `updateMany` filtered on
 * `label: { not: … }`, so a second run matches zero rows and writes nothing —
 * `updatedAt` does not churn on a no-op re-run.
 */
export async function ensurePlatformSections(
  client: PrismaClient = db,
): Promise<PlatformSectionSeedResult> {
  let created = 0;
  let relabelled = 0;

  for (const area of ALL_PLATFORM_AREAS) {
    const meta = PLATFORM_AREAS[area];
    const space = await client.space.findUnique({
      where:  { platformArea: area },
      select: { id: true },
    });
    if (!space) continue; // ensurePlatformSpaces guarantees this; be defensive.

    for (const s of meta.sections) {
      const existing = await client.spaceDashboardSection.findUnique({
        where:  { spaceId_key: { spaceId: space.id, key: s.key } },
        select: { label: true },
      });

      if (!existing) {
        await client.spaceDashboardSection.create({
          data: {
            spaceId: space.id,
            key:     s.key,
            label:   s.label,
            tab:     "OVERVIEW",
            enabled: true,
            order:   s.order,
          },
        });
        created += 1;
        continue;
      }

      // Converge system-owned metadata, and ONLY where it drifted. Scoped by
      // (spaceId, key) — the unique pair — so this can touch exactly one row.
      if (existing.label !== s.label) {
        await client.spaceDashboardSection.updateMany({
          where: { spaceId: space.id, key: s.key },
          data:  { label: s.label },
        });
        relabelled += 1;
      }
    }
  }

  return { created, relabelled };
}
