"use client";

/**
 * components/space/widgets/activity/useActivityFeed.ts
 *
 * The Activity workspace's read hook. It fetches the CANONICAL, permission-scoped,
 * privacy-safe event feed from `GET /api/spaces/[id]/activity` — the same route,
 * the same TimelineEvent[] contract, the same 60-event cap the TimelineWidget
 * already consumes. It introduces NO new authority, endpoint, or DB read; it only
 * lifts the fetch out of the widget so the editorial workspace can own the data
 * and its loading/error/empty states declaratively (mirroring the *SpaceData hooks
 * the financial workspaces use, minus the temporal windowing Activity doesn't have
 * — Activity is envelope: "none").
 */

import { useEffect, useState, useCallback } from "react";
import type { TimelineEvent } from "@/lib/timeline-types";

export interface ActivityFeed {
  events:  TimelineEvent[];
  loading: boolean;
  error:   string | null;
  /** Re-run the fetch (wired to the error-state Retry). */
  reload:  () => void;
}

export function useActivityFeed(spaceId: string | undefined): ActivityFeed {
  const [events,  setEvents]  = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [nonce,   setNonce]   = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res  = await fetch(`/api/spaces/${spaceId}/activity`);
        const data = await res.json() as { events?: TimelineEvent[]; error?: string };
        if (cancelled) return;
        if (!res.ok) { setError(data.error ?? "Failed to load activity."); return; }
        setEvents(data.events ?? []);
      } catch {
        if (!cancelled) setError("Failed to load activity.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [spaceId, nonce]);

  return { events, loading, error, reload };
}
