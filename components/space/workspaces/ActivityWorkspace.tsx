"use client";

/**
 * components/space/workspaces/ActivityWorkspace.tsx  (SD-7)
 *
 * The Activity destination — a first-class rail tab that renders its `recent_activity`
 * section through the shared section stack (Activity slice). Byte-identical to the
 * host's prior inline render for `activeTab === "ACTIVITY"`: the same section stack and
 * "No sections on this tab" empty state. Activity never reorders (canReorder is false
 * for ACTIVITY), so the Edit-Layout branch is inert here — the controls still thread
 * through for a single stack contract shared with Accounts/Overview.
 */

import {
  SpaceSectionStack,
  NoSectionsCard,
  type SectionCardBundle,
  type SectionStackControls,
} from "./SpaceSectionStack";
import type { DashboardSection } from "@/lib/space/dashboard-types";

export function ActivityWorkspace({
  sections,
  canManage,
  onManage,
  controls,
  card,
}: {
  sections: DashboardSection[];
  canManage: boolean;
  onManage: () => void;
  controls: SectionStackControls;
  card: SectionCardBundle;
}) {
  return (
    <div className="space-y-3">
      <SpaceSectionStack
        sections={sections}
        emptyState={<NoSectionsCard canManage={canManage} onManage={onManage} />}
        {...controls}
        card={card}
      />
    </div>
  );
}
