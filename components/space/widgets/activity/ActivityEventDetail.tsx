"use client";

/**
 * components/space/widgets/activity/ActivityEventDetail.tsx
 *
 * The body of the Activity RightPanel — the contextual detail for one event.
 *
 * DISCIPLINE: it surfaces ONLY the event's own contract facts (the title in the
 * panel header, the subtitle as the plain explanation, when it happened, who did
 * it, its category, and — for the rare event that carries one — its amount) plus
 * the event's EXISTING navigation link (`href`, e.g. an archived-assets view).
 * It fabricates nothing: no interpretation, no causality, no synthesized totals,
 * no "why". If the contract doesn't carry a fact, this panel doesn't show it.
 */

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { TimelineEvent } from "@/lib/timeline-types";
import { ACTIVITY_FILTER_GROUPS } from "@/lib/timeline-types";
import { formatDateTime, formatCurrency } from "@/lib/format";
import { EventIcon, toneColor, isColoredTone, timeAgo } from "./event-visuals";

/** Member-facing label for a category id ("connection" → "Connections"). */
function categoryLabel(category: TimelineEvent["category"]): string | null {
  if (!category) return null;
  return ACTIVITY_FILTER_GROUPS.find((g) => g.id === category)?.label ?? null;
}

export function ActivityEventDetail({ event, now }: { event: TimelineEvent; now: Date }) {
  const color   = toneColor(event.tone);
  const colored = isColoredTone(event.tone);
  const catLabel = categoryLabel(event.category);

  return (
    <div className="space-y-5">
      {/* Lead — the tone marker + the event's own plain explanation. */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{
            background: "var(--surface-inset)",
            color,
            boxShadow: colored ? `inset 0 0 0 1px ${color}` : "inset 0 0 0 1px var(--border-hairline)",
          }}
        >
          <EventIcon name={event.icon} size={16} />
        </span>
        <p className="min-w-0 flex-1 text-sm leading-snug text-[var(--text-secondary)]">
          {event.subtitle ?? event.title}
        </p>
      </div>

      {/* Facts — each row is a field the event actually carries. */}
      <dl className="divide-y divide-[var(--border-hairline)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
        <Fact label="When">
          <span className="text-[var(--text-primary)]">{formatDateTime(event.date)}</span>
          <span className="ml-2 text-[var(--text-faint)]">· {timeAgo(event.date, now)}</span>
        </Fact>
        {event.actorName && (
          <Fact label="Who">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{ background: colored ? color : "var(--text-faint)" }} />
              {event.actorName}
            </span>
          </Fact>
        )}
        {catLabel && <Fact label="Category">{catLabel}</Fact>}
        {typeof event.amount === "number" && event.currency && (
          <Fact label="Amount">
            <span className="tabular-nums text-[var(--text-primary)]">{formatCurrency(event.amount, event.currency)}</span>
          </Fact>
        )}
      </dl>

      {/* Related — the event's OWN link, when it has one. Not invented: only the
          events whose contract already carries an href (e.g. archived assets)
          offer a jump, and it goes exactly where the feed row always pointed. */}
      {event.href && (
        <Link
          href={event.href}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--meridian-400)] hover:underline"
        >
          View related
          <ArrowUpRight size={13} aria-hidden />
        </Link>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{label}</dt>
      <dd className="text-right text-xs text-[var(--text-muted)]">{children}</dd>
    </div>
  );
}
