"use client";

/**
 * components/connections/ConnectionsList.tsx
 *
 * D2.x Slice 3 — client poller for the permanent Connections hub.
 *
 * Seeded with server-rendered status + grouped accounts so first paint is
 * correct with no flicker. While any connection is "importing" (building), it
 * polls GET /api/sync/status every 4s to drive each ConnectionCard from
 * importing → ready. Stops when building clears or after a safety cap; pauses
 * while the tab is hidden. On the building→false transition it calls
 * router.refresh() once so the server page repulls now-complete data.
 *
 * No POST / triggers here (Slice 3 is read-only). Reconnect is handled inside
 * ConnectionCard via the existing ReconnectAccountButton.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConnectionCard, type AccountLite } from "@/components/connections/ConnectionCard";
import type { SyncStatus } from "@/lib/sync/status";

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 45; // ~3 min safety cap, then stop polling.

// Max cards that may mount the Liquid material at once. Each AtlasLiquidCard
// holds a dedicated WebGL context (browsers cap active contexts ~16); capping
// keeps a large institution list safe. Importing cards are prioritized, then
// ready/other cards by order. Cards beyond the cap use the DataCard (Glass)
// fallback — same card family.
const LIQUID_CAP = 6;

interface Props {
  initialStatus: SyncStatus;
  /** FinancialAccounts grouped by institution name (server-rendered). */
  accountsByInstitution: Record<string, AccountLite[]>;
}

export function ConnectionsList({ initialStatus, accountsByInstitution }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatus>(initialStatus);
  const [slow, setSlow] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  const pollCountRef = useRef(0);
  const prevBuildingRef = useRef(initialStatus.building);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (inFlightRef.current) return; // no overlapping requests
    inFlightRef.current = true;
    try {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (res.ok) {
        const next = (await res.json()) as SyncStatus;
        setStatus(next);

        // building true → false: refresh the server page once to pull the
        // now-complete data (lastSyncedAt, any late accounts), then stop.
        if (prevBuildingRef.current && !next.building) {
          router.refresh();
        }
        prevBuildingRef.current = next.building;
        if (!next.building) stop();
      }
    } catch {
      // Transient network error — leave the last known state; next tick retries.
    } finally {
      inFlightRef.current = false;
      pollCountRef.current += 1;
      if (pollCountRef.current >= MAX_POLLS) {
        setSlow(true);
        stop();
      }
    }
  }, [router, stop]);

  const start = useCallback(() => {
    if (intervalRef.current) return;
    if (pollCountRef.current >= MAX_POLLS) return;
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [poll]);

  useEffect(() => {
    if (!status.building) return; // nothing to poll — all settled at first paint

    start();

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void poll(); // immediate catch-up on refocus
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
    // Intentionally run once on mount; poll/start/stop are stable callbacks and
    // subsequent state is driven by the interval, not by re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anyReady = status.connections.some((c) => c.state === "ready");

  // Cap Liquid usage for WebGL-context safety: importing cards first, then the
  // rest by order, up to LIQUID_CAP. Cards beyond the cap use the DataCard
  // (Glass) fallback — same card family.
  const liquidOrder = [...status.connections].sort((a, b) => {
    const rank = (s: SyncStatus["connections"][number]["state"]) => (s === "importing" ? 0 : 1);
    return rank(a.state) - rank(b.state);
  });
  const liquidAllowed = new Set(liquidOrder.slice(0, LIQUID_CAP).map((c) => c.id));

  return (
    // Brief-style flagship column: same section rhythm (space-y-4) and centered
    // max-width column as the Daily Brief content area (max-w-[1400px] mx-auto),
    // so every card belongs to the same design language.
    <div className="space-y-4 max-w-[1400px] mx-auto">
      {status.connections.map((c) => (
        <ConnectionCard
          key={c.id}
          connection={c}
          accounts={accountsByInstitution[c.institution] ?? []}
          slow={slow}
          allowLiquid={liquidAllowed.has(c.id)}
        />
      ))}

      {!status.building && anyReady && (
        <div className="pt-1">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--meridian-400)] hover:underline"
          >
            Go to Dashboard →
          </Link>
        </div>
      )}
    </div>
  );
}
