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
 * D2.x resume — automatic history-import continuation. If a Plaid connection is
 * still "importing" after RESUME_GRACE_MS (i.e. the post-connect background sync
 * timed out / stalled rather than finishing), the poller starts POSTing
 * /api/plaid/resume-sync for that item every RESUME_INTERVAL_MS, up to
 * MAX_RESUME_ATTEMPTS, then defers to the daily cron. The server enforces the
 * real anti-collision guard (a min-age gate on the item's incomplete marker);
 * these client timings are deliberately conservative so the first attempt only
 * fires well after the 60s connect budget could have completed on its own.
 * Reconnect is still handled inside ConnectionCard via ReconnectAccountButton.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConnectionCard, type AccountLite } from "@/components/connections/ConnectionCard";
import type { SyncStatus } from "@/lib/sync/status";

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 45; // ~3 min safety cap, then stop polling.

// D2.x resume tuning. Grace is comfortably past the 60s connect/background
// budget so a healthy sync finishes on its own before we ever intervene; the
// server's own min-age gate (RESUME_MIN_AGE_MS) is the real anti-collision
// guard. After the grace, resume once per interval, capped, then defer to cron.
const RESUME_GRACE_MS = 90_000;
const RESUME_INTERVAL_MS = 30_000;
const MAX_RESUME_ATTEMPTS = 5;

interface ResumeEntry {
  firstImportingAt: number;
  lastResumeAt: number;
  attempts: number;
}

// Max cards that may mount the Liquid material at once. Each AtlasLiquidCard
// holds a dedicated WebGL context (browsers cap active contexts ~16); capping
// keeps a large institution list safe. Importing cards are prioritized, then
// ready/other cards by order. Cards beyond the cap use the DataCard (Glass)
// fallback — same card family.
const LIQUID_CAP = 6;

interface Props {
  initialStatus: SyncStatus;
  /** Plaid FinancialAccounts grouped by institution name (server-rendered). */
  accountsByInstitution: Record<string, AccountLite[]>;
  /** Wallet accounts grouped by Connection id — wallets never group by the
   *  (colliding) institution string. Default empty for Plaid-only callers. */
  accountsByConnectionId?: Record<string, AccountLite[]>;
}

export function ConnectionsList({ initialStatus, accountsByInstitution, accountsByConnectionId = {} }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatus>(initialStatus);
  const [slow, setSlow] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  const pollCountRef = useRef(0);
  const prevBuildingRef = useRef(initialStatus.building);
  // D2.x resume — per-connection resume bookkeeping (id → timing/attempts).
  const resumeRef = useRef<Map<string, ResumeEntry>>(new Map());

  // Re-seed from a fresh server render. useState(initialStatus) only reads the
  // prop on first mount, so a router.refresh() (e.g. after an in-app
  // "Enable Investments" success updates a connection's capability) would
  // otherwise leave the card showing stale state. initialStatus's reference
  // only changes on a real server re-render (navigation/refresh), never during
  // client-side polling, so this never clobbers live poll updates.
  useEffect(() => {
    // Intentional prop→state sync on a fresh server render — see comment above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(initialStatus);
  }, [initialStatus]);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // D2.x resume — for each Plaid connection still importing past the grace
  // window, POST /api/plaid/resume-sync on an interval (capped). Fire-and-forget
  // and best-effort: the server gates and reports; the next status poll reflects
  // any progress. Connections that leave "importing" are dropped from the map.
  const driveResume = useCallback((next: SyncStatus) => {
    const map = resumeRef.current;
    const now = Date.now();
    const importingIds = new Set<string>();

    for (const c of next.connections) {
      if (c.provider !== "PLAID" || c.state !== "importing") continue;
      importingIds.add(c.id);

      const entry = map.get(c.id) ?? { firstImportingAt: now, lastResumeAt: 0, attempts: 0 };
      if (!map.has(c.id)) map.set(c.id, entry);

      const importingFor = now - entry.firstImportingAt;
      const sinceLast = now - entry.lastResumeAt;
      if (
        importingFor >= RESUME_GRACE_MS &&
        sinceLast >= RESUME_INTERVAL_MS &&
        entry.attempts < MAX_RESUME_ATTEMPTS
      ) {
        entry.lastResumeAt = now;
        entry.attempts += 1;
        // Fire-and-forget; errors are non-fatal (status poll drives the UI).
        void fetch("/api/plaid/resume-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plaidItemId: c.id }),
        }).catch(() => {});
        // Exhausted attempts → stop pretending it's fast; defer to daily cron.
        if (entry.attempts >= MAX_RESUME_ATTEMPTS) setSlow(true);
      }
    }

    // Drop bookkeeping for connections that are no longer importing.
    for (const id of map.keys()) {
      if (!importingIds.has(id)) map.delete(id);
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

        // Auto-resume any stalled Plaid history imports (see driveResume).
        driveResume(next);

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
  }, [router, stop, driveResume]);

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
    // Centered flagship column (max-w-[1400px] mx-auto) — same design language
    // as the Daily Brief content area. Presentation-only change: the cards now
    // flow in a responsive grid instead of a single full-width vertical stack.
    <div className="max-w-[1400px] mx-auto space-y-4">
      {/* Responsive card grid: 1-up on mobile (full width, comfortable touch
          targets), 2-up from md, 3-up on xl where the card content stays
          readable. `items-stretch` (grid default) keeps cards in a row visually
          aligned; card internals already use a min-height + flex-col so a short
          state never collapses next to a tall one. No fixed heights (long
          syncing/error states still grow), no clipped content. */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {status.connections.map((c) => (
          <ConnectionCard
            key={c.id}
            connection={c}
            // Wallets group by connection id (institution strings collide);
            // Plaid keeps its institution grouping unchanged.
            accounts={
              c.provider === "WALLET"
                ? (accountsByConnectionId[c.id] ?? [])
                : (accountsByInstitution[c.institution] ?? [])
            }
            slow={slow}
            allowLiquid={liquidAllowed.has(c.id)}
          />
        ))}
      </div>

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
