"use client";

/**
 * TimelineWidget
 *
 * Fifth primitive in the space widget family alongside:
 *   AssetValueWidget, ProgressWidget, BreakdownWidget, SummaryWidget
 *
 * Pure presenter — renders a normalized TimelineEvent[].
 * All data fetching and normalization happen in the caller (API adapter
 * in SpaceDashboard SectionRegistry, or a server component wrapper).
 *
 * Design contract:
 *   - Accept a TimelineEvent[] prop (or fetch internally via spaceId)
 *   - Never know where events came from (AuditLog, goals, manual assets, etc.)
 *   - Daily Briefing can reuse this widget with a different event array
 *   - Icon prop is a Lucide icon name string; the widget maps it to a component
 *
 * Tone → colour mapping (Atlas tokens, Step B):
 *   positive → --accent-positive
 *   danger   → --accent-negative
 *   info / warning / neutral → neutral ink (colour reserved for genuine
 *     positive/negative severity; no warning token)
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

// ─── Tone → colour tokens ─────────────────────────────────────────────────────
// Only genuine positive/negative severity carries colour; info/warning/neutral
// resolve to ink. The icon chip is a uniform inset surface — tone shows on the
// glyph and the actor dot, not a background wash.

const TONE_FG: Record<TimelineTone, string> = {
  positive: "var(--accent-positive)",
  danger:   "var(--accent-negative)",
  info:     "var(--text-secondary)",
  warning:  "var(--text-secondary)",
  neutral:  "var(--text-secondary)",
};

const TONE_DOT: Record<TimelineTone, string> = {
  positive: "var(--accent-positive)",
  danger:   "var(--accent-negative)",
  info:     "var(--text-muted)",
  warning:  "var(--text-muted)",
  neutral:  "var(--text-muted)",
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
  const tone = event.tone ?? "neutral";
  const fg   = TONE_FG[tone];
  const dot  = TONE_DOT[tone];

  const titleNode = event.href ? (
    <Link href={event.href} className="transition-colors" style={{ color: "var(--accent-info)" }}>
      {event.title}
    </Link>
  ) : (
    <>{event.title}</>
  );

  return (
    <div className="flex gap-3 py-3.5">
      {/* Left column: icon */}
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: "var(--surface-inset)", color: fg }}
      >
        <EventIcon name={event.icon} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-snug" style={{ color: "var(--text-primary)" }}>{titleNode}</p>
          <span className="text-[11px] shrink-0 mt-0.5 tabular-nums" style={{ color: "var(--text-faint)" }}>
            {timeAgo(event.date)}
          </span>
        </div>
        {event.subtitle && (
          <p className="text-xs mt-0.5 leading-snug" style={{ color: "var(--text-muted)" }}>{event.subtitle}</p>
        )}
        {event.actorName && (
          <div className="flex items-center gap-1.5 mt-1">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>{event.actorName}</span>
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
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: "var(--surface-inset)" }}>
        <Clock size={18} style={{ color: "var(--text-faint)" }} />
      </div>
      <p className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>No activity yet</p>
      <p className="text-xs mt-1 max-w-[200px]" style={{ color: "var(--text-faint)" }}>
        Space actions will appear here as they happen.
      </p>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  /**
   * Pre-fetched events to render. If provided, the widget is a pure presenter.
   * If omitted, the widget fetches from /api/spaces/[spaceId]/activity.
   */
  events?: TimelineEvent[];

  /**
   * Required when `events` is not provided — used to fetch the activity feed.
   */
  spaceId?: string;

  /** Events per page. Default: 10 */
  pageSize?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TimelineWidget({ events: propEvents, spaceId, pageSize = 10 }: Props) {
  // Self-fetch state — only used when propEvents is absent
  const [fetchedEvents, setFetchedEvents] = useState<TimelineEvent[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [retryCount,    setRetryCount]    = useState(0);
  const [page,          setPage]          = useState(0);

  useEffect(() => {
    // Pure presenter mode — no fetch needed
    if (propEvents || !spaceId) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res  = await fetch(`/api/spaces/${spaceId}/activity`);
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
  }, [spaceId, retryCount]);

  // In pure presenter mode, derive directly from props (no state sync effect needed)
  // Events are already sorted newest-first by the API (orderBy: createdAt desc)
  const allEvents  = propEvents ?? fetchedEvents;
  const totalPages = Math.max(1, Math.ceil(allEvents.length / pageSize));
  const safePage   = Math.min(page, totalPages - 1);
  const visible    = allEvents.slice(safePage * pageSize, (safePage + 1) * pageSize);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 gap-2" style={{ color: "var(--text-faint)" }}>
        <Loader2 size={15} className="animate-spin" />
        <span className="text-sm">Loading activity…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-6 text-center">
        <p className="text-xs" style={{ color: "var(--accent-negative)" }}>{error}</p>
        {spaceId && (
          <button
            onClick={() => setRetryCount((n) => n + 1)}
            className="mt-2 text-xs hover:text-[var(--text-secondary)] transition-colors"
            style={{ color: "var(--text-muted)" }}
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
      <div className="divide-y divide-[var(--border-hairline)]">
        {visible.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>

      {/* Pagination footer — only shown when there is more than one page */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-3 mt-1 border-t" style={{ borderColor: "var(--border-hairline)" }}>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="text-xs hover:text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            ← Newer
          </button>
          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
            {safePage + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage === totalPages - 1}
            className="text-xs hover:text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            Older →
          </button>
        </div>
      )}
    </div>
  );
}
