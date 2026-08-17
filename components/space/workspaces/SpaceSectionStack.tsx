"use client";

/**
 * components/space/workspaces/SpaceSectionStack.tsx  (SD-7)
 *
 * REVIEW-3 (slice F): the <SpaceSectionStack> component itself was deleted with
 * its last mount (the Overview summary canvas — Accounts and Activity had
 * already migrated to their editorial workspaces). What survives here is the
 * shared vocabulary the remaining section surfaces still use:
 *   • NoSectionsCard — the empty state the GOALS/RETIREMENT routed modal renders;
 *   • SectionCardBundle — the SectionCard prop bundle the host materializes.
 */

import { LayoutDashboard } from "lucide-react";
import type { SpaceAccount } from "@/lib/space/dashboard-types";
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
  /**
   * The shell's selected as-of date — the window anchor for any interval widget
   * on this path.
   *
   * This bundle carries no `transactions`, so an interval section here renders
   * its loading state and never windows at all. The as-of is carried anyway so
   * that wiring transactions in later cannot silently re-introduce a widget
   * that windows against the wall clock.
   */
  asOf?:            string;
};
