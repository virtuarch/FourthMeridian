"use client";

/**
 * components/space/workspaces/SpaceSectionStack.tsx  (SD-7)
 *
 * The shared section-stack render, extracted verbatim from SpaceDashboard's
 * section-backed-tab block. Every section-backed destination (Overview / Accounts /
 * Activity) renders the SAME three-way stack:
 *   • sections empty        → the caller's `emptyState`
 *   • Edit Layout + reorder → the drag-reorder stack (DndContext/SortableContext)
 *   • otherwise             → the plain SectionCard map
 * Byte-identical to the host's prior inline logic — only relocated so each Workspace
 * mounts <SpaceSectionStack> instead of the host owning the stack inline.
 *
 * Edit-Layout state stays HOST-owned (the toggle lives in the shell toolbar, so
 * `editingLayout` / `sensors` / `onDragEnd` are shared with it and come in as props);
 * this component only renders the stack those inputs describe.
 */

import type { ReactNode, ComponentProps } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { LayoutDashboard } from "lucide-react";
import { SectionCard, SortableSectionCard } from "@/components/space/sections/SpaceSections";
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

/** The host-owned Edit-Layout controls, threaded through every section-backed tab
 *  (the toggle lives in the shell toolbar, so these stay host state). */
export type SectionStackControls = {
  editingLayout: boolean;
  canReorder: boolean;
  sensors: ComponentProps<typeof DndContext>["sensors"];
  onDragEnd: (e: DragEndEvent) => void;
};

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
  editingLayout,
  canReorder,
  sensors,
  onDragEnd,
  card,
}: {
  /** The active tab's visible sections (host's `sectionsForTab`). */
  sections: DashboardSection[];
  /** Rendered when `sections` is empty (Overview passes its hero-aware variant). */
  emptyState: ReactNode;
  editingLayout: boolean;
  canReorder: boolean;
  sensors: ComponentProps<typeof DndContext>["sensors"];
  onDragEnd: (e: DragEndEvent) => void;
  card: SectionCardBundle;
}) {
  if (sections.length === 0) return <>{emptyState}</>;

  if (editingLayout && canReorder) {
    return (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {sections.map((s) => (
            <SortableSectionCard key={s.id} section={s}>
              <SectionCard section={s} {...card} />
            </SortableSectionCard>
          ))}
        </SortableContext>
      </DndContext>
    );
  }

  return <>{sections.map((s) => <SectionCard key={s.id} section={s} {...card} />)}</>;
}
