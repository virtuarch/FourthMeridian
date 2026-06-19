"use client";

/**
 * TimelineWidget
 *
 * Fifth primitive in the workspace widget family alongside:
 *   AssetValueWidget, ProgressWidget, BreakdownWidget, SummaryWidget
 *
 * Pure presenter — renders a normalized TimelineEvent[].
 * All data fetching and normalization happen in the caller (API adapter
 * in WorkspaceDashboard SectionRegistry, or a server component wrapper).
 *
 * Design contract:
 *   - Accept a TimelineEvent[] prop (or fetch internally via workspaceId)
 *   - Never know where events came from (AuditLog, goals, manual assets, etc.)
 *   - Daily Briefing can reuse this widget with a different event array
 *   - Icon prop is a Lucide icon name string; the widget maps it to a component
 *
 * Tone → color mapping:
 *   positive → emerald
 *   info     → blue
 *   warning  → amber
 *   danger   → red
 *   neutral  → gray (default)
 */

import { useState, useEffect } from "react";
import {
  Activity, Archive, CheckCircle2, Clock, Landmark, LayoutDashboard,
  LogOut, PackageCheck, PackageMinus, PackagePlus, RotateCcw, Settings,
  Shield, Target, UserCheck, UserMinus, UserPlus, Loader2,
} from "lucide-react";
import type { TimelineEvent, TimelineTone } from "@/lib/timeline-types";
import Link from "next/link";

// ─── Icon map ─────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  Activity,
  Archive,
  CheckCircle2,
  Clock,
  Landmark,
  LayoutDashboard,
  LogOut,
  PackageCheck,
  PackageMinus,
  PackagePlus,
  RotateCcw,
  Settings,
  Shield,
  Target,
  UserCheck,
  UserMinus,
  UserPlus,
};

function EventIcon({ name }: { name?: string }) {
  const Icon = (name && ICON_MAP[name]) || Activity;
  return <Icon size={14} />;
}

// ─── Tone → styles ────────────────────────────────────────────────────────────

const TONE_ICON_CLS: Record<TimelineTone, string> = {
  positive: "bg-emerald-500/15 text-emerald-400",
  info:     "bg-blue-500/15    text-blue-400",
  warning:  "bg-amber-500/15   text-amber-400",
  danger:   "bg-red-500/15     text-red-400",
  neutral:  "bg-gray-700/60    text-gray-400",
};

const TONE_DOT_CLS: Record<TimelineTone, string> = {
  positive: "bg-emerald-400",
  info:     "bg-blue-400",
  warning:  "bg-amber-400",
  danger:   "bg-red-400",
  neutral:  "bg-gray-600",
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffMs  = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)   return "just now";
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH   < 24)  return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD   < 7)   return `${diffD}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
    year:  new Date(iso).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

// ─── Single event row ─────────────────────────────────────────────────────────

function EventRow({ event }: { event: TimelineEvent }) {
  const tone    = event.tone ?? "neutral";
  const iconCls = TONE_ICON_CLS[tone];
  const dotCls  = TONE_DOT_CLS[tone];

  const titleNode = event.href ? (
    <Link href={event.href} className="hover:text-blue-300 transition-colors">
      {event.title}
    </Link>
  ) : (
    <>{event.title}</>
  );

  return (
    <div className="flex gap-3 py-3.5">
      {/* Left column: icon */}
      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${iconCls}`}>
        <EventIcon name={event.icon} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-white leading-snug">{titleNode}</p>
          <span className="text-[11px] text-gray-600 shrink-0 mt-0.5 tabular-nums">
            {timeAgo(event.date)}
          </span>
        </div>
        {event.subtitle && (
          <p className="text-xs text-gray-500 mt-0.5 leading-snug">{event.subtitle}</p>
        )}
        {event.actorName && (
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotCls}`} />
            <span className="text-[11px] text-gray-600">{event.actorName}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="w-10 h-10 rounded-xl bg-gray-800/60 flex items-center justify-center mb-3">
        <Clock size={18} className="text-gray-600" />
      </div>
      <p className="text-sm text-gray-500 font-medium">No activity yet</p>
      <p className="text-xs text-gray-600 mt-1 max-w-[200px]">
        Space actions will appear here as they happen.
      </p>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  /**
   * Pre-fetched events to render. If provided, the widget is a pure presenter.
   * If omitted, the widget fetches from /api/workspaces/[workspaceId]/activity.
   */
  events?: TimelineEvent[];

  /**
   * Required when `events` is not provided — used to fetch the activity feed.
   */
  workspaceId?: string;

  /** Events per page. Default: 10 */
  pageSize?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TimelineWidget({ events: propEvents, workspaceId, pageSize = 10 }: Props) {
  // Self-fetch state — only used when propEvents is absent
  const [fetchedEvents, setFetchedEvents] = useState<TimelineEvent[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [retryCount,    setRetryCount]    = useState(0);
  const [page,          setPage]          = useState(0);

  useEffect(() => {
    // Pure presenter mode — no fetch needed
    if (propEvents || !workspaceId) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res  = await fetch(`/api/workspaces/${workspaceId}/activity`);
        const data = await res.json() as { events?: TimelineEvent[]; error?: string };
        if (cancelled) return;
        if (!res.ok) { setError(data.error ?? "Failed to load activity."); return; }
        setFetchedEvents(data.events ?? []);
        setPage(0);
      } catch {
        if (!cancelled) setError("Failed to load activity.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  // retryCount is intentionally included so the Retry button can trigger a re-fetch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, retryCount]);

  // In pure presenter mode, derive directly from props (no state sync effect needed)
  // Events are already sorted newest-first by the API (orderBy: createdAt desc)
  const allEvents  = propEvents ?? fetchedEvents;
  const totalPages = Math.max(1, Math.ceil(allEvents.length / pageSize));
  const safePage   = Math.min(page, totalPages - 1);
  const visible    = allEvents.slice(safePage * pageSize, (safePage + 1) * pageSize);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 gap-2 text-gray-600">
        <Loader2 size={15} className="animate-spin" />
        <span className="text-sm">Loading activity…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-6 text-center">
        <p className="text-xs text-red-400">{error}</p>
        {workspaceId && (
          <button
            onClick={() => setRetryCount((n) => n + 1)}
            className="mt-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (allEvents.length === 0) return <EmptyState />;

  return (
    <div>
      <div className="divide-y divide-gray-800/60">
        {visible.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>

      {/* Pagination footer — only shown when there is more than one page */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-3 mt-1 border-t border-gray-800/60">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded-lg hover:bg-gray-800 transition-colors"
          >
            ← Newer
          </button>
          <span className="text-[11px] text-gray-600 tabular-nums">
            {safePage + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage === totalPages - 1}
            className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Older →
          </button>
        </div>
      )}
    </div>
  );
}
