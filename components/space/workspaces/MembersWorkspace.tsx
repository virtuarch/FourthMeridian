"use client";

/**
 * components/space/workspaces/MembersWorkspace.tsx  (SD-7)
 *
 * The Members destination, extracted from SpaceDashboard's inline `activeTab ===
 * "MEMBERS"` branch. Architecture-only: byte-identical render (the same
 * SpaceMembersWidget with the same props). The host now mounts <MembersWorkspace>
 * instead of owning the branch; "Manage" still routes up to the host-owned
 * ManageSpaceModal via `onManage` (shared with the toolbar + section empty states).
 */

import { SpaceMembersWidget } from "@/components/dashboard/widgets/SpaceMembersWidget";

export function MembersWorkspace({
  spaceId,
  onManage,
}: {
  spaceId: string;
  /** Opens the host-owned ManageSpaceModal (shared overlay). */
  onManage: () => void;
}) {
  return <SpaceMembersWidget spaceId={spaceId} onManage={onManage} />;
}
