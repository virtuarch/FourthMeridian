"use client";

/**
 * ManageSpaceModal  (MSM decomposition — shell)
 *
 * Full space management panel. Rendered through the shared Atlas Glass modal
 * primitive (FormModal → OverlaySurface) per the Modal Doctrine Phase 3
 * (migration 3.3, retires recipe R3): the tab bar lives in the primitive's
 * toolbar slot and the tab content is its scrolling body; portal, focus-trap,
 * body-scroll-lock, panel height cap, and named z-scale come from the
 * primitive. Backdrop/Escape close (unchanged, always allowed here).
 * Tabs: General · Members · Add Accounts · Overview · Delete/Leave Space
 *
 * This file is now a THIN SHELL — it owns only: load the Space, the selected
 * tab, the permission-gated tab list, and the FormModal frame. Every tab's own
 * state / fetches / mutations live in its extracted panel under this directory
 * (GeneralSettingsPanel, MembersPanel, FinancesPanel, OverviewSectionsPanel,
 * DangerZonePanel). The former inline GoalsTab was unreachable dead code
 * (show:false, never selectable) and a stale, narrower duplicate of the
 * canonical GoalsCard / AddGoalModal capability — it was removed, not extracted.
 *
 * The last tab is the single entry point for owner-initiated archive/trash
 * actions, or member-initiated leave (see DangerZonePanel) —
 * SpacesClient's separate SpaceDetail modal no longer duplicates a
 * delete control. Labeled "Delete Space" for owners and "Leave Space" for
 * everyone else — deliberately plain account-management language, not
 * security-warning language (the internal tab id/type stays "danger" since
 * that's just an identifier, not anything user-facing).
 *
 * Permission gating mirrors the server:
 *   OWNER  — all tabs + actions
 *   ADMIN  — Members (invite/remove non-owners), Add Accounts, Overview
 *   MEMBER — Add Accounts (share own accounts only), no management tabs
 *   VIEWER — read only, no management tabs
 */

import { useState, useEffect, useCallback } from "react";
import {
  Settings, Users, Landmark, LayoutDashboard, Trash2, LogOut, Loader2,
} from "lucide-react";
import { displaySpaceName } from "@/lib/format";
import { FormModal } from "@/components/atlas/FormModal";
import { ROLE_LABELS, type SpaceDetail } from "./manage-shared";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { MembersPanel } from "./MembersPanel";
import { FinancesPanel } from "./FinancesPanel";
import { OverviewSectionsPanel } from "./OverviewSectionsPanel";
import { DangerZonePanel } from "./DangerZonePanel";

interface Props {
  spaceId:   string;
  spaceName: string;
  myRole:        string;
  currentUserId: string;
  onClose:       () => void;
  onRefresh:     () => void;
  onDeleted?:    () => void;
}

type ManageTab = "general" | "members" | "finances" | "dashboard" | "danger";

export function ManageSpaceModal({
  spaceId,
  spaceName,
  myRole,
  currentUserId,
  onClose,
  onRefresh,
  onDeleted,
}: Props) {
  const isOwner   = myRole === "OWNER";
  const canManage = ["OWNER", "ADMIN"].includes(myRole);
  const canEdit   = isOwner;

  // "general" is only visible to OWNERs — default to "members" for everyone else
  const [activeTab, setActiveTab] = useState<ManageTab>(canEdit ? "general" : "members");
  const [space, setSpace] = useState<SpaceDetail | null>(null);
  const [loading,   setLoading]   = useState(true);

  const loadSpace = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}`);
    if (res.ok) {
      const data = await res.json();
      setSpace(data);
    }
    setLoading(false);
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadSpace(); }, [loadSpace]);

  const allTabs: { id: ManageTab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { id: "general",   label: "General",     icon: <Settings    size={14} />, show: canEdit },
    { id: "members",   label: "Members",     icon: <Users       size={14} />, show: true },
    { id: "finances",  label: "Add Accounts", icon: <Landmark    size={14} />, show: true },
    { id: "dashboard", label: "Overview",    icon: <LayoutDashboard size={14} />, show: canManage },
    // A Personal Space can never be deleted, archived, trashed, or left, so the
    // danger tab has no valid action there — hide it entirely. Server routes
    // also fail closed for PERSONAL (defense in depth; not UI-only). Gated on a
    // loaded space so the Delete affordance never flashes before type is known.
    { id: "danger",    label: isOwner ? "Delete Space" : "Leave Space", icon: isOwner ? <Trash2 size={14} /> : <LogOut size={14} />, show: !!space && space.type !== "PERSONAL" },
  ];
  const tabs = allTabs.filter((t) => t.show);

  return (
    <FormModal
      open
      onClose={onClose}
      title={displaySpaceName(spaceName)}
      subtitle={`${ROLE_LABELS[myRole] ?? myRole} · Manage Space`}
      size="md"
      toolbar={
        <div className="flex gap-0.5 overflow-x-auto scrollbar-hide">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                activeTab === t.id
                  ? t.id === "danger"
                    ? "bg-[rgba(237,82,71,.16)] text-[var(--coral-400)]"
                    : "bg-[var(--surface-hover-strong)] text-[var(--text-primary)]"
                  : t.id === "danger"
                    ? "text-[rgba(237,82,71,.6)] hover:text-[var(--coral-400)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
        </div>
      ) : !space ? (
        <div className="text-center py-12">
          <p className="text-sm text-[var(--text-muted)]">Could not load Space</p>
        </div>
      ) : (
        <>
          {activeTab === "general"   && canEdit   && (
            <GeneralSettingsPanel
              space={space}
              onSaved={(updated) => {
                setSpace((prev) => prev ? { ...prev, ...updated } : prev);
                onRefresh();
              }}
            />
          )}
          {activeTab === "members"              && (
            <MembersPanel
              space={space}
              myRole={myRole}
              currentUserId={currentUserId}
              reloadSpace={loadSpace}
              onRefresh={onRefresh}
            />
          )}
          {activeTab === "finances"             && (
            <FinancesPanel spaceId={spaceId} myRole={myRole} onRefresh={onRefresh} />
          )}
          {activeTab === "dashboard" && canManage && (
            <OverviewSectionsPanel spaceId={spaceId} />
          )}
          {activeTab === "danger" && space?.type !== "PERSONAL" && (
            <DangerZonePanel
              space={space}
              myRole={myRole}
              currentUserId={currentUserId}
              onClose={onClose}
              onRefresh={onRefresh}
              onDeleted={onDeleted}
            />
          )}
        </>
      )}
    </FormModal>
  );
}
