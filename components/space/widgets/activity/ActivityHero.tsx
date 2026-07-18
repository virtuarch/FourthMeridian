"use client";

/**
 * components/space/widgets/activity/ActivityHero.tsx
 *
 * Surface ① of the Activity workspace — the editorial lede, in the bare Net Worth
 * / prototype idiom (no card): an eyebrow, a plain headline, an honest one-line
 * count of what's shown, and the category filter (the same Atlas SegmentedControl
 * + member vocabulary the TimelineWidget uses). It states only what is true — how
 * many events are in view — and makes no claim about trend, meaning, or cause.
 * Activity is envelope: "none", so there is no trust chip or As-Of delta here.
 */

import { History } from "lucide-react";
import type { ActivityCategory } from "@/lib/timeline-types";
import { ACTIVITY_FILTER_GROUPS } from "@/lib/timeline-types";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";

export type ActivityFilter = ActivityCategory | "all";

export function ActivityHero({
  shownCount,
  filter,
  onFilterChange,
}: {
  /** Events currently in view (after the active category filter). */
  shownCount: number;
  filter:     ActivityFilter;
  onFilterChange: (id: ActivityFilter) => void;
}) {
  const filtered = filter !== "all";
  const activeLabel = ACTIVITY_FILTER_GROUPS.find((g) => g.id === filter)?.label ?? "";

  const countLine =
    shownCount === 0
      ? filtered ? `No ${activeLabel.toLowerCase()} events in view` : "No activity yet"
      : filtered
        ? `${shownCount} ${activeLabel.toLowerCase()} ${shownCount === 1 ? "event" : "events"} in view`
        : `The ${shownCount} most recent ${shownCount === 1 ? "event" : "events"} in this space`;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <History size={13} className="text-[var(--text-faint)]" aria-hidden />
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Activity</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">What&rsquo;s happened here</h1>
        <p className="text-sm text-[var(--text-muted)]">{countLine}</p>
      </div>

      <SegmentedControl
        options={ACTIVITY_FILTER_GROUPS}
        value={filter}
        onChange={onFilterChange}
        aria-label="Filter activity by category"
      />
    </div>
  );
}
