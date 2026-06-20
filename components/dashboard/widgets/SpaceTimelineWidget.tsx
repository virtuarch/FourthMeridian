"use client";

/**
 * SpaceTimelineWidget
 *
 * The richer "history of the Space" Timeline described in the redesign
 * spec — distinct from (and built on top of the same TimelineEvent
 * contract as) the existing components/workspace/widgets/TimelineWidget.tsx,
 * which remains untouched and keeps powering the legacy Activity surface.
 * This widget adds the date-grouped presentation ("APR 28 / + Salary
 * deposited") and Atlas Glass styling the spec calls for, and is reusable
 * across every Space type and both dashboard implementations.
 *
 * Pure presenter: it never fetches. The host fetches real events from the
 * existing GET /api/workspaces/[id]/activity route (unmodified) and may
 * concat lib/timeline-placeholder.ts's FUTURE_TIMELINE_EVENTS to demonstrate
 * event types with no backend aggregation yet. Preview rows
 * (`isPreview: true`) are visually de-emphasized and badged "Preview" so
 * they're never mistaken for real Space history.
 *
 * `variant="preview"` renders a short, ungrouped list for the Overview tab
 * with a "View all" affordance. `variant="full"` renders the complete,
 * date-grouped Timeline tab.
 */

import {
  Activity, Archive, CheckCircle2, Clock, Landmark, LayoutDashboard, LogOut,
  PackageCheck, PackageMinus, PackagePlus, RotateCcw, Settings, Shield,
  Target, UserCheck, UserMinus, UserPlus, Receipt, FileUp, Link2, Sparkles,
  Wallet, Repeat, Trophy, BellRing, Loader2, ArrowRight,
} from "lucide-react";
import Link from "next/link";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { TONE_CHIP_BG, TONE_ICON } from "@/components/atlas/tones";
import type { TimelineEvent, TimelineTone } from "@/lib/timeline-types";

const ICON_MAP: Record<string, React.ElementType> = {
  Activity, Archive, CheckCircle2, Clock, Landmark, LayoutDashboard, LogOut,
  PackageCheck, PackageMinus, PackagePlus, RotateCcw, Settings, Shield,
  Target, UserCheck, UserMinus, UserPlus, Receipt, FileUp, Link2, Sparkles,
  Wallet, Repeat, Trophy, BellRing,
};

function EventIcon({ name }: { name?: string }) {
  const Icon = (name && ICON_MAP[name]) || Activity;
  return <Icon size={14} />;
}

function dateGroupLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isThisYear = d.getFullYear() === today.getFullYear();
  return d
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: isThisYear ? undefined : "numeric" })
    .toUpperCase();
}

function timeAgo(iso: string): string {
  const diffMs  = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function groupByDate(events: TimelineEvent[]): { label: string; events: TimelineEvent[] }[] {
  const groups: { label: string; events: TimelineEvent[] }[] = [];
  for (const event of events) {
    const label = dateGroupLabel(event.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
  }
  return groups;
}

function EventRow({ event }: { event: TimelineEvent }) {
  const tone: TimelineTone = event.tone ?? "neutral";
  const Body = (
    <div
      className={[
        "flex items-start gap-3 px-3 py-2.5 rounded-[var(--radius-sm)] transition-colors",
        event.href ? "hover:bg-[var(--surface-hover)] cursor-pointer" : "",
        event.isPreview ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className={`w-7 h-7 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${TONE_CHIP_BG[tone]}`}>
        <span className={TONE_ICON[tone]}><EventIcon name={event.icon} /></span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{event.title}</p>
          {event.isPreview && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-full px-1.5 py-0.5 shrink-0">
              Preview
            </span>
          )}
        </div>
        {event.subtitle && (
          <p className="text-xs text-[var(--text-secondary)] mt-0.5 line-clamp-2">{event.subtitle}</p>
        )}
        {event.actorName && (
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{event.actorName}</p>
        )}
      </div>
      <span className="text-[11px] text-[var(--text-muted)] shrink-0 mt-1">{timeAgo(event.date)}</span>
    </div>
  );

  return event.href && !event.isPreview ? <Link href={event.href}>{Body}</Link> : Body;
}

export function SpaceTimelineWidget({
  events,
  loading = false,
  variant = "full",
  previewCount = 4,
  onViewAll,
  emptyLabel = "Nothing has happened in this Space yet.",
}: {
  events: TimelineEvent[];
  loading?: boolean;
  variant?: "preview" | "full";
  previewCount?: number;
  onViewAll?: () => void;
  emptyLabel?: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading timeline…
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <Clock size={20} className="text-[var(--text-muted)] mb-2" />
        <p className="text-sm text-[var(--text-secondary)]">{emptyLabel}</p>
      </div>
    );
  }

  if (variant === "preview") {
    const rows = events.slice(0, previewCount);
    return (
      <div>
        <div className="space-y-0.5">
          {rows.map((e) => <EventRow key={e.id} event={e} />)}
        </div>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors px-3"
          >
            View full timeline <ArrowRight size={12} />
          </button>
        )}
      </div>
    );
  }

  const groups = groupByDate(events);
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="text-[11px] font-semibold tracking-wide text-[var(--text-muted)] px-3 mb-1.5">{group.label}</p>
          <div className="space-y-0.5">
            {group.events.map((e) => <EventRow key={e.id} event={e} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Convenience wrapper: drops a GlassPanel frame around the widget, since every host renders it inside one. */
export function SpaceTimelinePanel(props: Parameters<typeof SpaceTimelineWidget>[0] & { title?: string }) {
  const { title, ...rest } = props;
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
      {title && <p className="text-sm font-semibold text-[var(--text-primary)] px-3 mb-2">{title}</p>}
      <SpaceTimelineWidget {...rest} />
    </GlassPanel>
  );
}
