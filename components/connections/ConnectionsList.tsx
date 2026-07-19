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
import { BuildIntelligencePanel } from "@/components/connections/BuildIntelligencePanel";
import type { SyncStatus } from "@/lib/sync/status";
import {
  isBuildingIntelligence,
  type ConnectionIntelligenceStatus,
} from "@/lib/connections/intelligence";
import type { ConnectionsSyncView } from "@/lib/connections/space-data";

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
  /** Per-connection account inventory (NAMES/TYPES only), keyed by
   *  SyncConnection.id for EVERY provider — Plaid and wallet alike. PCS-2
   *  unified the two grouping schemes onto one stable-id map. Default empty. */
  accountsByConnectionId?: Record<string, AccountLite[]>;
  /** CONN-2A — per-connection intelligence status, keyed by SyncConnection.id.
   *  Drives the BUILDING_INTELLIGENCE lifecycle + keep-polling-through-build. */
  initialIntelligence?: Record<string, ConnectionIntelligenceStatus>;
}

export function ConnectionsList({
  initialStatus,
  accountsByConnectionId = {},
  initialIntelligence = {},
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatus>(initialStatus);
  const [intelligence, setIntelligence] =
    useState<Record<string, ConnectionIntelligenceStatus>>(initialIntelligence);
  const [slow, setSlow] = useState(false);

  // CONN-2 — poll while ACQUIRING (status.building) OR BUILDING intelligence.
  // Intelligence-building runs AFTER syncIncompleteAt clears, so status.building alone
  // would stop the poller before intelligence finishes; the card would freeze at
  // "ready" mid-build. This superset keeps it live until intelligence is READY.
  const buildingIntelligence = isBuildingIntelligence(Object.values(intelligence));
  const shouldPoll = status.building || buildingIntelligence;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  const pollCountRef = useRef(0);
  const prevShouldPollRef = useRef(shouldPoll);
  // D2.x resume — per-connection resume bookkeeping (id → timing/attempts).
  const resumeRef = useRef<Map<string, ResumeEntry>>(new Map());

  // Re-seed from a fresh server render. useState() only reads the prop on first
  // mount, so a router.refresh() (e.g. after an in-app "Enable Investments"
  // success, or when a second connection is added) would otherwise leave the
  // cards showing stale state. The initial* references only change on a real
  // server re-render (navigation/refresh), never during client-side polling, so
  // this never clobbers live poll updates.
  useEffect(() => {
    // Intentional prop→state sync on a fresh server render — see comment above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(initialStatus);
    setIntelligence(initialIntelligence);
  }, [initialStatus, initialIntelligence]);

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
        const next = (await res.json()) as ConnectionsSyncView;
        setStatus(next.status);
        setIntelligence(next.intelligenceByConnectionId);

        // Auto-resume any stalled Plaid history imports (see driveResume).
        driveResume(next.status);

        // Keep polling while acquiring OR reconstructing intelligence. On the
        // true → false transition (everything ready), refresh the server page
        // once to pull now-complete data (lastSyncedAt, late accounts), then stop.
        const nextShouldPoll =
          next.status.building ||
          isBuildingIntelligence(Object.values(next.intelligenceByConnectionId));
        if (prevShouldPollRef.current && !nextShouldPoll) {
          router.refresh();
        }
        prevShouldPollRef.current = nextShouldPoll;
        if (!nextShouldPoll) stop();
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
    // CONN-2 — (re)arm live tracking whenever the connection set is ACQUIRING or
    // BUILDING intelligence (shouldPoll), keyed on that flag rather than only at mount.
    // Adding a SECOND connection while this page is already open re-renders
    // ConnectionsList IN PLACE (router.push to the current route → no remount, no
    // key), so the re-seed effect flips shouldPoll false→true without ever
    // remounting. The old empty-deps effect captured only the mount-time value,
    // so for an already-ready page it returned early and never started the poller
    // — leaving the new card spinning until a manual hard refresh. Keying on
    // shouldPoll starts the poller for the newly-importing connection AND keeps it
    // alive through the reconstruction window (which begins after syncIncompleteAt
    // clears). Completion still comes SOLELY from persisted state, read via the
    // poll → /api/sync/status (never from a notification).
    if (!shouldPoll) return; // nothing to poll — acquired AND intelligence built

    // Fresh live-tracking window: reset the poll budget + slow flag so a just-added
    // connection gets the full budget, and seed prevShouldPoll=true so the
    // shouldPoll→false transition still fires the single router.refresh() that
    // pulls the now-complete data. (prevShouldPollRef is otherwise only updated
    // inside poll(), so without this a poller that starts late would miss it.)
    pollCountRef.current = 0;
    // Intentional reset on entering a polling period (see comment above) — same
    // sanctioned prop/flag→state sync the re-seed effect uses.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSlow(false);
    prevShouldPollRef.current = true;
    start();

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Part-5 — a user returning to the tab is a real interaction: give live
        // tracking a FRESH budget and clear the paused ("slow") state so they
        // see real progress again instead of a frozen status. Plaid's historical
        // ingestion is webhook-driven and can outlast the 3-min budget; the
        // budget only bounds background polling of a focused-and-idle tab, and
        // refocus re-arms it. (The sync also still completes server-side and
        // fires the Part-3 notification regardless.)
        pollCountRef.current = 0;
        setSlow(false);
        void poll(); // immediate catch-up on refocus
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
    // Keyed on shouldPoll: (re)arm on false→true, tear down on true→false.
    // poll/start/stop are stable callbacks; live state is driven by the interval,
    // not by re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPoll]);

  // CONN-2 — a connection is still "in progress" while acquiring (importing) OR
  // reconstructing intelligence (state ready, but derived intelligence still
  // building). Both belong in the in-progress queue and are Liquid-prioritized.
  const inProgressPhase = (id: string) =>
    intelligence[id]?.phase === "IMPORTING" || intelligence[id]?.phase === "BUILDING_INTELLIGENCE";
  const isInProgress = (c: SyncStatus["connections"][number]) =>
    c.state === "importing" || inProgressPhase(c.id);

  const anyReady = status.connections.some((c) => intelligence[c.id]?.phase === "READY");

  // Cap Liquid usage for WebGL-context safety: in-progress cards first, then the
  // rest by order, up to LIQUID_CAP. Cards beyond the cap use the DataCard
  // (Glass) fallback — same card family.
  const liquidOrder = [...status.connections].sort(
    (a, b) => (isInProgress(a) ? 0 : 1) - (isInProgress(b) ? 0 : 1),
  );
  const liquidAllowed = new Set(liquidOrder.slice(0, LIQUID_CAP).map((c) => c.id));

  // Part-4 / CONN-2 — split the in-progress queue (importing OR reconstructing)
  // from everything resolved (ready-with-intelligence / needs_reauth / error).
  // The queue renders as a full-width vertical stack ABOVE the grid.
  const inProgress = status.connections.filter(isInProgress);
  const resolved   = status.connections.filter((c) => !isInProgress(c));

  const renderCard = (c: SyncStatus["connections"][number]) => (
    <ConnectionCard
      key={c.id}
      connection={c}
      // One id space for every provider — Plaid and wallet accounts both look up
      // by connection id (PCS-2). No more institution-string grouping.
      accounts={accountsByConnectionId[c.id] ?? []}
      intelligence={intelligence[c.id]}
      slow={slow}
      allowLiquid={liquidAllowed.has(c.id)}
    />
  );

  return (
    // Centered flagship column (max-w-[1400px] mx-auto) — same design language
    // as the Daily Brief content area.
    <div className="max-w-[1400px] mx-auto space-y-4">
      {/* In-progress queue — full-width vertical stack, ABOVE the grid. Only
          rendered when something is genuinely importing (no empty container /
          heading otherwise). Each card is the SAME ConnectionCard (same
          AtlasLiquidCard/DataCard + ImportingContent), just in a stacking flex
          container instead of a grid cell, so it takes the list's full width.
          When a card finishes it leaves this stack and appears in the grid
          below on the next status poll — that cross-container move remounts it
          (keys are stable within a container, but React can't preserve identity
          across parents), which here coincides exactly with the card's own
          importing→ready content switch, so it reads as the intended "snaps
          down into the grid" transition rather than a gratuitous re-mount. */}
      {inProgress.length > 0 && (
        <div className="flex flex-col gap-4">
          {inProgress.map(renderCard)}
        </div>
      )}

      {/* Resolved connections — the existing responsive grid (1/2/3-up).
          `items-stretch` (grid default) keeps a row visually aligned; card
          internals already use a min-height + flex-col. Rendered only when
          there's at least one resolved connection. */}
      {resolved.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {resolved.map(renderCard)}
        </div>
      )}

      {/* CONN-2B — master multi-account intelligence rebuild. Renders itself only
          when ≥2 connections have transactions to rebuild from. */}
      <BuildIntelligencePanel
        connections={status.connections}
        intelligence={intelligence}
        accountsByConnectionId={accountsByConnectionId}
      />

      {!shouldPoll && anyReady && (
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
