"use client";

/**
 * components/space/workspaces/ActivityWorkspace.tsx
 *
 * The Activity destination — a first-class rail tab (activeTab === "ACTIVITY"),
 * migrated into the Fourth Meridian editorial Workspace idiom.
 *
 * Activity answers ONE question — "what happened in this Space?" — as a narrative
 * timeline, not a transaction ledger, audit log, or notification centre. It reads
 * the CANONICAL, permission-scoped, privacy-safe event feed (GET
 * /api/spaces/[id]/activity → TimelineEvent[]) through useActivityFeed and lays it
 * out as:
 *
 *   ① ActivityHero    — editorial lede + category filter (member vocabulary).
 *   ② ActivityTimeline — the feed, grouped into date bands (Today · Yesterday ·
 *                        Earlier this week · by month), each a tone-marked rail.
 *
 * Interaction: click any event → its detail opens in a RightPanel (context is
 * preserved; no navigation, no duplicate detail page). The panel shows only the
 * event's own contract facts and its existing `href` link.
 *
 * This layer is PRESENTATION ONLY. The authority (the activity route), the
 * TimelineEvent contract, the permission gate (activity:read, ACTIVE member), the
 * privacy scrubbing, and the audit behaviour are all untouched and unmerged — the
 * embeddable `recent_activity` section still renders through the TimelineWidget
 * elsewhere; this rebuilds only the Activity TAB experience.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Clock } from "lucide-react";
import { ACTIVITY_FILTER_GROUPS } from "@/lib/timeline-types";
import type { TimelineEvent } from "@/lib/timeline-types";
import { useSpaceSectionsPublisher } from "@/lib/space/space-chrome-context";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { useActivityFeed } from "@/components/space/widgets/activity/useActivityFeed";
import { groupActivityEvents } from "@/components/space/widgets/activity/activity-grouping";
import { ActivityHero, type ActivityFilter } from "@/components/space/widgets/activity/ActivityHero";
import { ActivityTimeline } from "@/components/space/widgets/activity/ActivityTimeline";
import { ActivityEventDetail } from "@/components/space/widgets/activity/ActivityEventDetail";

export function ActivityWorkspace({ spaceId }: { spaceId: string }) {
  const { events, loading, error, reload } = useActivityFeed(spaceId);

  const [filter, setFilter]     = useState<ActivityFilter>("all");
  const [selected, setSelected] = useState<TimelineEvent | null>(null);

  // One clock captured on mount — keeps the date-band cut and relative stamps
  // stable across re-renders (grouping stays a pure function of a fixed `now`).
  const [now] = useState(() => new Date());

  const filtered = useMemo(
    () => (filter === "all" ? events : events.filter((e) => e.category === filter)),
    [events, filter],
  );

  const groups = useMemo(() => groupActivityEvents(filtered, now), [filtered, now]);

  // Publish the visible date bands as the shell sidebar's "what's inside" anchors,
  // exactly like the financial workspaces publish their section list.
  const publishSections = useSpaceSectionsPublisher();
  const anchorKey = groups.map((g) => g.anchor).join("|");
  useEffect(() => {
    publishSections(groups.map((g) => ({ label: g.label, anchor: g.anchor })));
    return () => publishSections([]);
    // Keyed on the anchor set (stable string) so this re-publishes only when the
    // bands actually change, never on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, publishSections]);

  const eyebrowFor = (e: TimelineEvent) =>
    ACTIVITY_FILTER_GROUPS.find((g) => g.id === e.category)?.label ?? "Event";

  // First load, nothing yet on screen.
  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[var(--text-faint)]">
        <Loader2 size={15} className="animate-spin" />
        <span className="text-sm">Loading activity…</span>
      </div>
    );
  }

  if (error && events.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-[var(--accent-negative)]">{error}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-2 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-8">
      {loading && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-faint)]">
          <Loader2 size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}

      <ActivityHero shownCount={filtered.length} filter={filter} onFilterChange={setFilter} />

      {events.length === 0 ? (
        <EmptyState />
      ) : filtered.length === 0 ? (
        <FilteredEmptyState />
      ) : (
        <ActivityTimeline groups={groups} now={now} selectedId={selected?.id ?? null} onSelect={setSelected} />
      )}

      <RightPanel open={selected != null} onClose={() => setSelected(null)} ariaLabel="Activity event detail">
        {selected && (
          <>
            <PanelHeader eyebrow={eyebrowFor(selected)} title={selected.title} />
            <PanelContent>
              <ActivityEventDetail event={selected} now={now} />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl" style={{ background: "var(--surface-inset)" }}>
        <Clock size={18} className="text-[var(--text-faint)]" />
      </div>
      <p className="text-sm font-medium text-[var(--text-muted)]">No activity yet</p>
      <p className="mt-1 max-w-[220px] text-xs text-[var(--text-faint)]">
        Space actions will appear here as they happen.
      </p>
    </div>
  );
}

function FilteredEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl" style={{ background: "var(--surface-inset)" }}>
        <Clock size={18} className="text-[var(--text-faint)]" />
      </div>
      <p className="text-sm font-medium text-[var(--text-muted)]">Nothing in this filter</p>
      <p className="mt-1 max-w-[220px] text-xs text-[var(--text-faint)]">
        Try a different category to see other events in this space.
      </p>
    </div>
  );
}
