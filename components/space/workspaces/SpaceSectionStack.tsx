"use client";

/**
 * components/space/workspaces/SpaceSectionStack.tsx  (SD-7)
 *
 * The shared section-stack render, extracted verbatim from SpaceDashboard's
 * section-backed-tab block. Every section-backed destination (Overview / Accounts /
 * Activity) renders the SAME stack:
 *   • sections empty → the caller's `emptyState`
 *   • otherwise      → the plain SectionCard map
 * Relocated so each Workspace mounts <SpaceSectionStack> instead of the host owning
 * the stack inline.
 */

import type { ReactNode } from "react";
import { LayoutDashboard } from "lucide-react";
import { SectionCard } from "@/components/space/sections/SectionCard";
import type { DashboardSection, SpaceAccount } from "@/lib/space/dashboard-types";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";

/** The "No sections on this tab" empty-state card — the shared markup Accounts /
 *  Activity / Overview / the routed modal all render. */
export function NoSectionsCard({ canManage, onManage }: { canManage: boolean; onManage: () => void }) {
  return (
    <div className="text-center py-12">
      <LayoutDashboard size={30} className="text-[var(--text-faint)] mx-auto mb-3" />
      <p className="text-sm text-[var(--text-muted)]">No sections on this tab</p>
      {canManage && (
        <button
          onClick={onManage}
          className="mt-2 text-xs text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors"
        >
          Manage sections →
        </button>
      )}
    </div>
  );
}

/** The SectionCard prop bundle the section-backed tabs pass identically. */
export type SectionCardBundle = {
  accounts:         SpaceAccount[];
  spaceId:          string;
  spaceType:        string;
  category:         string;
  canManage:        boolean;
  onAddGoal:        () => void;
  ctx?:             ConversionContext;
  snapshots:        Snapshot[] | null;
  snapshotCurrency: string;
};

export function SpaceSectionStack({
  sections,
  emptyState,
  card,
}: {
  /** The active tab's visible sections (host's `sectionsForTab`). */
  sections: DashboardSection[];
  /** Rendered when `sections` is empty (Overview passes its hero-aware variant). */
  emptyState: ReactNode;
  card: SectionCardBundle;
}) {
  if (sections.length === 0) return <>{emptyState}</>;

  return <>{sections.map((s) => <SectionCard key={s.id} section={s} {...card} />)}</>;
}
