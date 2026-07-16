"use client";

/**
 * components/space/workspaces/AccountsWorkspace.tsx  (SD-7)
 *
 * The Accounts destination — a section-backed tab. Byte-identical to the host's prior
 * inline render for `activeTab === "ACCOUNTS"`: the shared section stack (with Edit
 * Layout reorder) and the "No sections on this tab" empty state. No hero, no doorways,
 * no day-zero setup card — those are Overview-only. The host owns the shared data +
 * Edit-Layout state and passes them in.
 */

import {
  SpaceSectionStack,
  NoSectionsCard,
  type SectionCardBundle,
  type SectionStackControls,
} from "./SpaceSectionStack";
import type { DashboardSection } from "@/lib/space/dashboard-types";

export function AccountsWorkspace({
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
