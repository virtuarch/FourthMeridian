"use client";

/**
 * components/space/workspaces/SpaceSectionStack.tsx  (SD-7)
 *
 * REVIEW-3 (slice F): the <SpaceSectionStack> component itself was deleted with
 * its last mount (the Overview summary canvas). W2: NoSectionsCard and the
 * `onAddGoal` field went with the GOALS/RETIREMENT routed modal — its last
 * renderer/consumer (Goals retired; SectionCard/SectionRegistry deleted). What
 * survives is one type:
 *   • SectionCardBundle — the workspace prop bundle the host materializes
 *     (AccountsWorkspace consumes it).
 */

import type { SpaceAccount } from "@/lib/space/dashboard-types";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";

/** The workspace prop bundle the section-backed tabs pass identically. */
export type SectionCardBundle = {
  accounts:         SpaceAccount[];
  spaceId:          string;
  spaceType:        string;
  category:         string;
  canManage:        boolean;
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
