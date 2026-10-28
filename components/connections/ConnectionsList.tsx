"use client";

/**
 * components/connections/ConnectionsList.tsx
 *
 * D2.x Slice 3 — client poller for the permanent Connections hub.
 *
 * Seeded with server-rendered status + grouped accounts so first paint is
 * correct with no flicker. While any connection is "importing" (building), it
 * polls GET /api/sync/status every 4s to drive each connection row and drawer from
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
 * Reconnect is still handled inside the drawer (ConnectionDetail) via ReconnectAccountButton.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConnectionDetail, type AccountLite } from "@/components/connections/ConnectionCard";
import { ConnectionRow } from "@/components/connections/ConnectionRow";
import { ConnectionMenu } from "@/components/connections/ConnectionMenu";
import { Surface } from "@/components/atlas/Surface";
import { GlassButton } from "@/components/atlas/GlassButton";
import { CheckCircle2, ChevronLeft } from "lucide-react";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { providerName } from "@/lib/sync/status";
import { BuildIntelligencePanel } from "@/components/connections/BuildIntelligencePanel";
import type { SyncStatus } from "@/lib/sync/status";
import {
  isBuildingIntelligence,
  type ConnectionIntelligenceStatus,
} from "@/lib/connections/intelligence";
import type { ConnectionsSyncView } from "@/lib/connections/space-data";
import { takeFirstConnectStarted } from "@/lib/connections/first-connect-handoff";

const POLL_INTERVAL_MS = 4000;
// Must outlast ONE server-side sync budget (maxDuration = 300s) plus margin,
// or the poller gives up in the middle of a pass that is still running and the
// row freezes on a stale count. 120 × 4s = ~8 min.
const MAX_POLLS = 120;

// D2.x resume tuning. Grace is comfortably past the 60s connect/background
// budget so a healthy sync finishes on its own before we ever intervene; the
// server's own min-age gate (RESUME_MIN_AGE_MS) is the real anti-collision
// guard. After the grace, resume once per interval, capped, then defer to cron.
// Mirrors RESUME_MIN_AGE_MS in app/api/plaid/resume-sync/route.ts. The server
// rejects a resume younger than that (it would race the in-flight connect
// sync), so firing earlier only burns rate-limit budget on calls that cannot
// succeed. Keep the two in lockstep.
const RESUME_GRACE_MS = 315_000;
const RESUME_INTERVAL_MS = 30_000;
const MAX_RESUME_ATTEMPTS = 5;

interface ResumeEntry {
  firstImportingAt: number;
  lastResumeAt: number;
  attempts: number;
}

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
  // The connection whose drawer is open. Looked up in the LIVE status below, so
  // an open drawer follows the poller (importing → ready) without reopening.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Connections pass PR 3 — set when work THIS VISIT watched finishes (the
  // poller's true → false transition), so the "ready" moment is shown once, from
  // persisted state, never from a timer or a guess.
  const [justCompleted, setJustCompleted] = useState(false);

  // CONN-2 — poll while ACQUIRING (status.building) OR BUILDING intelligence.
  // Intelligence-building runs AFTER syncIncompleteAt clears, so status.building alone
  // would stop the poller before intelligence finishes; the card would freeze at
  // "ready" mid-build. This superset keeps it live until intelligence is READY.
  const buildingIntelligence = isBuildingIntelligence(Object.values(intelligence));
  // A paused import keeps the poller alive: the poller is what drives its resume.
  const anyPaused = status.connections.some((c) => c.state === "import_paused");
  const shouldPoll = status.building || buildingIntelligence || anyPaused;

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
      // "import_paused" is the case resume exists for: the server has positive
      // evidence that nothing is running, so it needs no client-side grace (the
      // server's own age gate still applies).
      const paused = c.state === "import_paused";
      if (c.provider !== "PLAID" || (c.state !== "importing" && !paused)) continue;
      importingIds.add(c.id);

      const entry = map.get(c.id) ?? { firstImportingAt: now, lastResumeAt: 0, attempts: 0 };
      if (!map.has(c.id)) map.set(c.id, entry);

      const importingFor = now - entry.firstImportingAt;
      const sinceLast = now - entry.lastResumeAt;
      if (
        (paused || importingFor >= RESUME_GRACE_MS) &&
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
          next.status.connections.some((c) => c.state === "import_paused") ||
          isBuildingIntelligence(Object.values(next.intelligenceByConnectionId));
        if (prevShouldPollRef.current && !nextShouldPoll) {
          router.refresh();
          takeFirstConnectStarted(); // the watched transition consumes the handoff
          setJustCompleted(true);
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
  // building). Both belong in the in-progress queue and sort first.
  const inProgressPhase = (id: string) =>
    intelligence[id]?.phase === "IMPORTING" || intelligence[id]?.phase === "BUILDING_INTELLIGENCE";
  const isInProgress = (c: SyncStatus["connections"][number]) =>
    // OPS-2D-4A — deliberately does NOT include "sync_deferred": nothing is
    // running, so polling for progress would never settle.
    c.state === "importing" || c.state === "import_paused" || inProgressPhase(c.id);

  const anyReady = status.connections.some((c) => intelligence[c.id]?.phase === "READY");

  // A first connection started from the onboarding view in this tab that was
  // already READY before the poller ever ran (an empty wallet syncs inside the
  // add request) still gets its ready moment — once, from persisted READY state.
  useEffect(() => {
    if (shouldPoll || !anyReady) return;
    // One-shot handoff read on a settled, server-reported READY list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (takeFirstConnectStarted()) setJustCompleted(true);
  }, [shouldPoll, anyReady]);

  // One list. Work in progress (importing OR reconstructing) sorts first so a
  // just-added connection is the row the user sees; the rest keep server order.
  const ordered = [...status.connections].sort(
    (a, b) => (isInProgress(a) ? 0 : 1) - (isInProgress(b) ? 0 : 1),
  );
  // Genuinely running work only — a paused import waits on resume, not on us.
  const inFlight = ordered.filter((c) => c.state === "importing" || inProgressPhase(c.id));

  // "Add another connection" — the page's own actions, not a second copy of them.
  const focusAddConnection = () => {
    const first = document.querySelector<HTMLButtonElement>("[data-connections-actions] button");
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
    first?.focus();
  };

  // A disconnected connection leaves the status; its drawer simply closes.
  const selected = selectedId ? status.connections.find((c) => c.id === selectedId) ?? null : null;

  return (
    // Centered flagship column (max-w-[1400px] mx-auto) — same design language
    // as the Daily Brief content area.
    <div className="max-w-[1400px] mx-auto space-y-4">
      {/* Connections pass PR 3 — work in progress is said at the top, in the
          drawer's own words, with a way in. No percentages: the import has no
          denominator (see SyncConnection.importedCount). */}
      {inFlight.length > 0 && (
        <div role="status" aria-live="polite" data-connections-in-progress
          className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[rgba(125,168,255,.24)] bg-[rgba(125,168,255,.06)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">
              {inFlight.length === 1 ? `${inFlight[0].institution} is being set up.` : `${inFlight.length} connections are being set up.`}
            </span>{" "}
            {slow
              ? "This is taking longer than usual — it keeps going on our side."
              : "This keeps going on our side, even if you leave this page."}
          </p>
          <button type="button" onClick={() => setSelectedId(inFlight[0].id)}
            className="shrink-0 self-start rounded-[var(--radius-sm)] px-2 py-1 text-sm font-medium text-[var(--meridian-400)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] sm:self-auto">
            View progress
          </button>
        </div>
      )}

      {/* No overflow-hidden: it clipped each row's ⋯ menu (Preview 2026-10-28). */}
      <Surface>
        <ul aria-label="Connections" className="divide-y divide-[var(--border-hairline)]">
          {ordered.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              // One id space for every provider — Plaid and wallet accounts both
              // look up by connection id (PCS-2).
              accountCount={(accountsByConnectionId[c.id] ?? []).length}
              intelligence={intelligence[c.id]}
              onOpen={() => setSelectedId(c.id)}
            />
          ))}
        </ul>
      </Surface>

      {/* The connection's detail — docked right on desktop, a bottom sheet on
          mobile (RightPanel). Overview, accounts, health, history coverage, last
          sync, work in progress and recovery actions, all from the same state. */}
      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel="Connection detail" size="lg">
        {selected && (
          <>
            <PanelHeader
              // Phone: the sheet reads as a page — "‹ Connections" dismisses it,
              // and the close button returns at sm+ where the drawer docks.
              leading={
                <button type="button" onClick={() => setSelectedId(null)}
                  className="-ml-1 mb-2 inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] px-1 text-sm text-[var(--meridian-400)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] sm:hidden">
                  <ChevronLeft aria-hidden size={16} /> Connections
                </button>
              }
              closeClassName="hidden sm:inline-flex sm:items-center sm:justify-center"
              eyebrow={providerName(selected.provider)}
              title={selected.institution}
              actions={selected.state !== "importing" ? <ConnectionMenu connection={selected} /> : undefined}
            />
            <PanelContent>
              <ConnectionDetail
                connection={selected}
                accounts={accountsByConnectionId[selected.id] ?? []}
                intelligence={intelligence[selected.id]}
                slow={slow}
              />
            </PanelContent>
          </>
        )}
      </RightPanel>

      {/* CONN-2B — master multi-account intelligence rebuild. Renders itself only
          when ≥2 connections have transactions to rebuild from. */}
      <BuildIntelligencePanel
        connections={status.connections}
        intelligence={intelligence}
        accountsByConnectionId={accountsByConnectionId}
      />

      {/* Connections pass PR 3 — the first usable snapshot. Shown when work this
          visit watched has finished and at least one connection is READY. */}
      {!shouldPoll && anyReady && justCompleted && (
        <Surface className="p-4 sm:p-5">
          <div role="status" data-connections-ready className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 aria-hidden size={18} className="mt-0.5 shrink-0 text-[var(--accent-positive,#34d399)]" />
              <div>
                <p className="text-sm font-semibold text-[var(--text-primary)]">Your financial snapshot is ready</p>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">Net worth, cash flow and history are built from what you connected. More history may keep arriving.</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:shrink-0">
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--meridian-600)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--meridian-500,#3b82f6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
              >
                Explore My Space
              </Link>
              <GlassButton tone="neutral" onClick={focusAddConnection}>Add another connection</GlassButton>
            </div>
          </div>
        </Surface>
      )}

      {!shouldPoll && anyReady && !justCompleted && (
        <div className="pt-1">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--meridian-400)] hover:underline"
          >
            Explore My Space →
          </Link>
        </div>
      )}
    </div>
  );
}
