"use client";

/**
 * TimelineModal
 *
 * Fullscreen glass modal for the Space's full Timeline — the spec's point
 * 1: Timeline stops being a top-level rail tab and becomes a modal launched
 * from Overview's "Recent activity" preview (and, later, from AI Daily
 * Brief links and notifications, none of which exist yet). Composes the
 * existing SpaceTimelineWidget (variant="full", unmodified) inside the
 * shared GlassModal shell, with the sub-nav filter row dropped into
 * GlassModal's `toolbar` slot — same InlineFilter component, same filtering
 * logic, the host already had; only the container changed from an inline
 * tab body to a modal.
 *
 * Generic over the filter id (`<F extends string>`) rather than importing a
 * single shared TimelineFilterId: DashboardClient.tsx and
 * SpaceDashboard.tsx intentionally keep their own short id vocabularies
 * (see lib/perspectives.ts's doc comment on this same host-local-glue
 * pattern for Perspective routing), so this stays host-agnostic on *which*
 * filters exist while still sharing the one modal shell + timeline
 * presenter between both dashboards.
 *
 * Future:
 * selecting a timeline snapshot should hydrate the dashboard
 * using historical DailySnapshot + transaction state. Not implemented here
 * — TimelineEvent has no snapshot reference yet, and SpaceTimelineWidget's
 * EventRow only supports `href` navigation today. When that lands, the
 * natural seam is EventRow gaining an `onSelectSnapshot` callback alongside
 * its existing `href` case, threaded down through this modal's props.
 */

import { Clock } from "lucide-react";
import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { SpaceTimelineWidget } from "@/components/dashboard/widgets/SpaceTimelineWidget";
import { InlineFilter, InlineFilterOption } from "@/components/atlas/InlineFilter";
import type { TimelineEvent } from "@/lib/timeline-types";

export function TimelineModal<F extends string>({
  events,
  loading,
  filters,
  filterValue,
  onFilterChange,
  onClose,
  emptyLabel = "Nothing has happened in this Space yet.",
}: {
  events: TimelineEvent[];
  loading: boolean;
  /** Sub-nav row, e.g. DashboardClient.tsx's All/Today/Week/Month/AI/Transactions/Documents
   *  chips. Omit entirely for hosts with no Timeline sub-nav yet (e.g. SpaceDashboard.tsx,
   *  which renders every event with no filter) — the modal just skips the toolbar slot. */
  filters?: InlineFilterOption<F>[];
  filterValue?: F;
  onFilterChange?: (id: F) => void;
  onClose: () => void;
  emptyLabel?: string;
}) {
  return (
    <GlassModal
      title="Timeline"
      subtitle="Full history for this Space"
      icon={Clock}
      onClose={onClose}
      size="full"
      toolbar={
        filters && filterValue !== undefined && onFilterChange ? (
          <InlineFilter
            options={filters}
            value={filterValue}
            onChange={onFilterChange}
            aria-label="Filter Timeline"
            align="start"
          />
        ) : undefined
      }
    >
      <SpaceTimelineWidget
        events={events}
        loading={loading}
        variant="full"
        emptyLabel={emptyLabel}
      />
    </GlassModal>
  );
}
