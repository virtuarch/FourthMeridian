/**
 * lib/spaces/create-shared-space.ts
 *
 * The write sequence behind POST /api/spaces, run on the CALLER'S tenant client
 * (fm_app under FM_RLS_STRICT). Shared by the route and the foreground RLS suite
 * (scripts/rls-foreground-acceptance.ts), so the suite executes exactly what the
 * route executes.
 *
 * ORDER IS LOAD-BEARING (RLS slice B, see the route's comment):
 *   1. Space        INSERT policy WITH CHECK (true) — but WITHOUT RETURNING.
 *                   PostgreSQL applies the SELECT policy to rows an INSERT
 *                   returns, and the new Space is not visible until step 2.
 *                   Prisma's `create` always RETURNs, so `createMany` (which
 *                   does not) under a pre-generated id is the only Prisma
 *                   shape that works. A7, 2026-10-22: `space.create` here was
 *                   refused with 42501 on Preview, so every Space creation 500'd.
 *   2. SpaceMember  OWNER, admitted by `userId = current_fm_user_id()`.
 *   3. read back, sections, AiAgent — now `spaceId IN fm_visible_space_ids()`.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type SpaceCategory } from "@prisma/client";
import type { TenantClient } from "@/lib/db/tenant-context";

import type { planTemplateApplication } from "@/lib/space-templates/apply";

/** One planned section, exactly as the SP-1 planner emits it. */
export type SharedSpaceSection = ReturnType<typeof planTemplateApplication>["sectionsToCreate"][number];

export interface CreateSharedSpaceInput {
  creatorUserId: string;
  name: string;
  description: string | null;
  category: SpaceCategory;
  isPublic: boolean;
  reportingCurrency: string;
  sections: readonly SharedSpaceSection[];
}

export async function createSharedSpace(tx: TenantClient, input: CreateSharedSpaceInput) {
  const spaceId = randomUUID();
  await tx.space.createMany({
    data: [{
      id:                spaceId,
      name:              input.name,
      description:       input.description,
      type:              "SHARED",
      category:          input.category,
      isPublic:          input.isPublic,
      reportingCurrency: input.reportingCurrency,
    }],
  });
  await tx.spaceMember.create({
    data: { spaceId, userId: input.creatorUserId, role: "OWNER" },
  });
  const created = await tx.space.findUniqueOrThrow({
    where:   { id: spaceId },
    include: { members: { include: { user: { select: { id: true, name: true, username: true } } } } },
  });

  await tx.spaceDashboardSection.createMany({
    data: input.sections.map((s) => ({
      spaceId,
      key:     s.key,
      label:   s.label,
      tab:     s.tab,
      enabled: s.enabled,
      order:   s.order,
      config:  s.config == null ? Prisma.DbNull : s.config as Prisma.InputJsonValue,
    })),
  });
  const dashboardSections = await tx.spaceDashboardSection.findMany({
    where:   { spaceId },
    orderBy: [{ tab: "asc" }, { order: "asc" }],
  });

  await tx.aiAgent.create({
    data: {
      spaceId,
      name:       `${created.name} Agent`,
      agentScope: [],   // empty → full template manifest is used
    },
  });

  return { ...created, dashboardSections };
}
