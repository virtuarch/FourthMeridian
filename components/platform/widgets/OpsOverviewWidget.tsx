"use client";

/**
 * components/platform/widgets/OpsOverviewWidget.tsx  (UX-P1 · ops_overview · coordinator-owned)
 *
 * THE OVERVIEW COMPOSER. Platform Operations' landing surface answers six
 * questions — is Fourth Meridian healthy, what needs attention, who or what is
 * affected, what is happening, how is it changing, what can an operator do —
 * and each answer is a BLOCK owned by one workstream and rendered here in the
 * approved order. This file lays them out; it fetches nothing, derives nothing
 * and knows no route.
 *
 * Why one section key: the Overview keeps `ops_overview` (the DB row every
 * environment already holds) so no environment needs re-seeding (owner decision
 * D3). The blocks are sub-surfaces of that one section, each its own
 * `SectionSurface` (frame rule holds per block), stacked in the editorial
 * rhythm every platform workspace uses. `ops_platform_health` follows as the
 * compact technical-posture surface.
 *
 * Order is the reading order an operator needs: verdicts → what needs action →
 * who is affected → what is scheduled and what ran → how usage and cost move →
 * what operators did. Blocks never import each other and never repeat a
 * workspace; each ends in a doorway into the workspace that holds its detail.
 *
 * The previous single-widget cockpit (six domain blocks of KeyRows over
 * /platform-ops/overview) is superseded by StatusBoard; its route and its
 * view-model vocabulary (`ops-overview-view.ts`) are reused there.
 */

import type { SpaceMountAccess } from "@/lib/space/mount-context";
import type { PlatformSection } from "../widget-kit";
import { StatusBoard } from "./overview/StatusBoard";
import { AttentionBlock } from "./overview/AttentionBlock";
import { ConnectionHealthBlock } from "./overview/ConnectionHealthBlock";
import { JobsMatrixBlock } from "./overview/JobsMatrixBlock";
import { RefreshActivityBlock } from "./overview/RefreshActivityBlock";
import { AiActivityBlock } from "./overview/AiActivityBlock";
import { EconomicsBlock } from "./overview/EconomicsBlock";
import { ActivityFeedBlock } from "./overview/ActivityFeedBlock";

export function OpsOverviewWidget({
  section,
  onOpenWorkspace,
  access,
}: {
  section: PlatformSection;
  onOpenWorkspace?: (workspaceId: string) => void;
  access?: SpaceMountAccess;
}) {
  const shared = { onOpenWorkspace, access };
  return (
    <div className="flex flex-col gap-8 md:gap-10">
      {/* 1 · Is Fourth Meridian healthy? */}
      <StatusBoard title={section.label} {...shared} />

      {/* 2 · What requires attention? */}
      <AttentionBlock {...shared} />

      {/* 3 · Who or what is affected? */}
      <ConnectionHealthBlock {...shared} />

      {/* 4 · What is happening across the platform? */}
      <div className="grid gap-8 md:gap-10 lg:grid-cols-2">
        <JobsMatrixBlock {...shared} />
        <RefreshActivityBlock {...shared} />
      </div>

      {/* 5 · How is platform performance changing? */}
      <div className="grid gap-8 md:gap-10 lg:grid-cols-2">
        <AiActivityBlock {...shared} />
        <EconomicsBlock {...shared} />
      </div>

      {/* 6 · What did operators do? */}
      <ActivityFeedBlock {...shared} />
    </div>
  );
}
