"use client";

/**
 * components/space/widgets/activity/ActivityTimeline.tsx
 *
 * The editorial Activity feed — "what happened in this Space?" as a narrative
 * broken into date bands, each a vertical rail of tone-marked events (the DS-5
 * ActivityTimeline idiom, on production tokens and the canonical TimelineEvent
 * contract). Every row is a button: clicking it opens that event's detail in a
 * RightPanel (owned by the workspace) — no navigation, no duplicate page.
 *
 * Presentation only. It renders exactly the events it is handed, in the order and
 * grouping the pure `groupActivityEvents` produced; it computes nothing, fetches
 * nothing, and invents no copy beyond the event's own title/subtitle/actor.
 */

import type { TimelineEvent } from "@/lib/timeline-types";
import type { ActivityGroup } from "./activity-grouping";
import { EventIcon, toneColor, isColoredTone, timeAgo } from "./event-visuals";

export function ActivityTimeline({
  groups,
  now,
  selectedId,
  onSelect,
}: {
  groups:     ActivityGroup[];
  now:        Date;
  selectedId: string | null;
  onSelect:   (event: TimelineEvent) => void;
}) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <section key={group.key} id={group.anchor} className="scroll-mt-20">
          <header className="mb-3 flex items-baseline gap-2.5">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
              {group.label}
            </h3>
            <span className="text-[11px] tabular-nums text-[var(--text-faint)]">{group.events.length}</span>
          </header>

          <ol className="relative">
            {/* The connecting rail — sits behind the markers. */}
            <span aria-hidden className="absolute bottom-3 left-[13px] top-3 w-px bg-[var(--border-hairline)]" />
            {group.events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                now={now}
                selected={event.id === selectedId}
                onSelect={() => onSelect(event)}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function EventRow({
  event,
  now,
  selected,
  onSelect,
}: {
  event:    TimelineEvent;
  now:      Date;
  selected: boolean;
  onSelect: () => void;
}) {
  const color   = toneColor(event.tone);
  const colored = isColoredTone(event.tone);

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={[
          "group flex w-full items-start gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left transition-colors",
          "hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]",
          selected ? "bg-[var(--surface-hover)]" : "",
        ].join(" ")}
      >
        {/* Marker — a tone-coloured icon chip that sits over the rail. */}
        <span
          aria-hidden
          className="relative z-10 mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full"
          style={{
            background: "var(--surface-inset)",
            color,
            boxShadow: colored ? `inset 0 0 0 1px ${color}` : "inset 0 0 0 1px var(--border-hairline)",
          }}
        >
          <EventIcon name={event.icon} size={12} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-medium text-[var(--text-primary)]">{event.title}</p>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-faint)]">{timeAgo(event.date, now)}</span>
          </div>
          {event.subtitle && (
            <p className="mt-0.5 truncate text-xs leading-snug text-[var(--text-muted)]">{event.subtitle}</p>
          )}
          {event.actorName && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: colored ? color : "var(--text-faint)" }} />
              <span className="text-[11px] text-[var(--text-faint)]">{event.actorName}</span>
            </div>
          )}
        </div>
      </button>
    </li>
  );
}
