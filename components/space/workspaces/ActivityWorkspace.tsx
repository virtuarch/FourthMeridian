"use client";

/**
 * components/space/workspaces/ActivityWorkspace.tsx  (SD-7)
 *
 * The Activity destination — a first-class rail tab that renders its `recent_activity`
 * section through the shared section stack (Activity slice). Byte-identical to the
 * host's prior inline render for `activeTab === "ACTIVITY"`: the same section stack and
 * "No sections on this tab" empty state.
 */

import {
  SpaceSectionStack,
  NoSectionsCard,
  type SectionCardBundle,
} from "./SpaceSectionStack";
import type { DashboardSection } from "@/lib/space/dashboard-types";

export function ActivityWorkspace({
  sections,
  canManage,
  onManage,
  card,
}: {
  sections: DashboardSection[];
  canManage: boolean;
  onManage: () => void;
  card: SectionCardBundle;
}) {
  return (
    <div className="space-y-3">
      <SpaceSectionStack
        sections={sections}
        emptyState={<NoSectionsCard canManage={canManage} onManage={onManage} />}
        card={card}
      />
    </div>
  );
}
