"use client";

/**
 * components/space/workspaces/RoutedWorkspaceModal.tsx  (SD-7)
 *
 * The routed-workspace GlassModal, extracted verbatim from SpaceDashboard's
 * `isRoutedWorkspaceTab(activeTab)` branch. It renders the active routed tab's DB
 * section-template stack (GOALS / DEBT / INVESTMENTS / RETIREMENT) in a floating sheet
 * — this is the GOALS destination's render path (the mission's "GoalsWorkspace"), and
 * it is generic across the routed tabs, so it is named for what it is. The Add-Goal
 * capability itself lives in AddGoalModal (a shell overlay); this only composes the
 * section stack + modal chrome. Byte-identical: same GlassModal chrome (derived from
 * the canonical registry), same SectionCard prop subset, same empty state.
 */

import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { getWorkspaceModalMeta } from "@/lib/perspectives";
import { PERSPECTIVE_ICON_MAP, PERSPECTIVE_ICON_FALLBACK } from "@/lib/perspective-icons";
import { SectionCard } from "@/components/space/sections/SectionCard";
import { NoSectionsCard } from "./SpaceSectionStack";
import type { DashboardSection, SpaceAccount } from "@/lib/space/dashboard-types";
import type { ConversionContext } from "@/lib/money/types";

export function RoutedWorkspaceModal({
  activeTab,
  sections,
  canManage,
  onClose,
  onManage,
  onAddGoal,
  accounts,
  spaceId,
  spaceType,
  category,
  ctx,
}: {
  activeTab: string;
  sections: DashboardSection[];
  canManage: boolean;
  onClose: () => void;
  onManage: () => void;
  onAddGoal: () => void;
  accounts: SpaceAccount[];
  spaceId: string;
  spaceType: string;
  category: string;
  ctx?: ConversionContext;
}) {
  // SD-2: modal chrome is derived from the canonical registry (the owning workspace's
  // own label + icon NAME), resolved to a component via the shared perspective-icon map.
  const modalMeta = getWorkspaceModalMeta(activeTab);
  const ModalIcon = modalMeta ? (PERSPECTIVE_ICON_MAP[modalMeta.icon] ?? PERSPECTIVE_ICON_FALLBACK) : undefined;
  return (
    <GlassModal title={modalMeta?.title ?? activeTab} icon={ModalIcon} size="xl" onClose={onClose}>
      <div className="space-y-3">
        {sections.length === 0 ? (
          <NoSectionsCard canManage={canManage} onManage={onManage} />
        ) : (
          sections.map((s) => (
            <SectionCard
              key={s.id}
              section={s}
              accounts={accounts}
              spaceId={spaceId}
              spaceType={spaceType}
              category={category}
              canManage={canManage}
              onAddGoal={onAddGoal}
              ctx={ctx}
            />
          ))
        )}
      </div>
    </GlassModal>
  );
}
