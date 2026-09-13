/**
 * components/brief/brief-flow.ts
 *
 * THE DAILY BRIEF PAGE'S FLOW — a small controller with no React in it.
 *
 *   response FRESH                        → SHOWING
 *   CHECK_REQUIRED / STALE (Brief shown)  → UPDATING    POST, then settle
 *   ABSENT (nothing safe to show)         → GENERATING  POST, then settle
 *   IN_PROGRESS                           → WAITING     GET every 2 s, for at most 40 s
 *   FAILED + a Brief                      → COULD_NOT_UPDATE  (retry after retryAfterMs)
 *   FAILED, nothing                       → FAILED_EMPTY      (retry after retryAfterMs)
 *   NO_DATA                               → NO_DATA
 *
 * ⚠️ THE SERVER DECIDES; THIS ONLY SEQUENCES. Whether generation is needed, whether a
 * fallback is safe and when a retry is allowed all arrive in the response. The
 * controller never regenerates because a tab became visible — it asks (GET), and
 * acts on the answer.
 *
 * ⚠️ ONE FLOW AT A TIME, ALL OF IT ABORTABLE. A flow is one AbortController covering
 * its GETs, its POST and its poll timers. Starting a flow while one runs is a no-op
 * (so a visibility event cannot fire a second POST during a generation), and
 * `dispose` aborts everything. A response naming another Space is ignored.
 *
 * ⚠️ AT MOST TWO POSTS PER FLOW: the one the first answer asks for, and one more if
 * a poll finds the other request's claim expired without a Brief. Never a loop.
 */

import type { BriefArtifactView, BriefMetricsView, BriefResponse } from "@/lib/brief-types";

export const BRIEF_POLL_INTERVAL_MS = 2_000;
export const BRIEF_POLL_MAX_MS = 40_000;
export const BRIEF_RECHECK_THROTTLE_MS = 60_000;
/** A server-rendered state older than this (e.g. restored from history) is re-asked. */
export const BRIEF_INITIAL_MAX_AGE_MS = 5_000;
const MAX_POSTS_PER_FLOW = 2;

export type BriefPhase =
  | "LOADING"
  | "SHOWING"
  | "UPDATING"
  | "GENERATING"
  | "WAITING"
  | "COULD_NOT_UPDATE"
  | "FAILED_EMPTY"
  | "NO_DATA"
  | "LOAD_ERROR";

export interface BriefView {
  phase:   BriefPhase;
  brief:   BriefArtifactView | null;
  metrics: BriefMetricsView | null;
  /** Epoch ms after which a retry may be attempted, when one is being withheld. */
  retryAt: number | null;
}

export interface BriefTransport {
  get(spaceId: string, signal: AbortSignal): Promise<BriefResponse>;
  generate(spaceId: string, signal: AbortSignal): Promise<BriefResponse>;
}

export interface BriefClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BriefController {
  start(): void;
  /** The tab became visible, or was restored from the back-forward cache. Throttled. */
  onVisible(): void;
  /** The retry control. Re-reads after a load error; re-requests generation after a failure. */
  retry(): void;
  dispose(): void;
  view(): BriefView;
}

export function initialView(initial: BriefResponse | null): BriefView {
  if (!initial) return { phase: "LOADING", brief: null, metrics: null, retryAt: null };
  const phase: BriefPhase = initial.state === "NO_DATA" ? "NO_DATA"
    : initial.brief ? "SHOWING" : "LOADING";
  return { phase, brief: initial.brief, metrics: initial.metrics ?? null, retryAt: null };
}

class Aborted extends Error {}

export function createBriefController(opts: {
  spaceId: string;
  initial: BriefResponse | null;
  transport: BriefTransport;
  clock: BriefClock;
  onView(view: BriefView): void;
}): BriefController {
  const { spaceId, transport, clock } = opts;
  let view = initialView(opts.initial);
  let flow: AbortController | null = null;
  let lastCheckAt = -Infinity;
  let disposed = false;

  const emit = (patch: Partial<BriefView>) => {
    view = { ...view, ...patch };
    if (!disposed) opts.onView(view);
  };

  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Aborted()); return; }
    const handle = clock.setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clock.clearTimeout(handle); reject(new Aborted()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const guard = (res: BriefResponse, signal: AbortSignal) => {
    if (signal.aborted || disposed) throw new Aborted();
    if (res.spaceId !== spaceId) throw new Aborted();   // another Space's answer: not ours to show
    return res;
  };

  /** Act on one response; returns when the flow has settled. */
  async function settle(res: BriefResponse, signal: AbortSignal): Promise<void> {
    let posts = 0;
    let pollDeadline: number | null = null;
    let current = res;
    for (;;) {
      guard(current, signal);
      if (current.metrics !== undefined) view = { ...view, metrics: current.metrics };
      // A response without a Brief while IN_PROGRESS/FAILED keeps what is on screen:
      // it was a safe Brief for this Space a moment ago.
      const keep = (current.state === "IN_PROGRESS" || current.state === "FAILED") && !current.brief;
      const brief = keep ? view.brief : current.brief;

      switch (current.state) {
        case "FRESH":
          emit({ phase: "SHOWING", brief, retryAt: null });
          return;
        case "NO_DATA":
          emit({ phase: "NO_DATA", brief: null, retryAt: null });
          return;
        case "FAILED":
          emit({ phase: brief ? "COULD_NOT_UPDATE" : "FAILED_EMPTY", brief,
            retryAt: clock.now() + (current.retryAfterMs ?? 0) });
          return;
        case "IN_PROGRESS": {
          pollDeadline ??= clock.now() + BRIEF_POLL_MAX_MS;
          if (clock.now() >= pollDeadline) {
            emit({ phase: brief ? "COULD_NOT_UPDATE" : "FAILED_EMPTY", brief, retryAt: clock.now() });
            return;
          }
          emit({ phase: "WAITING", brief });
          await sleep(BRIEF_POLL_INTERVAL_MS, signal);
          current = guard(await transport.get(spaceId, signal), signal);
          continue;
        }
        case "CHECK_REQUIRED":
        case "STALE":
        case "ABSENT": {
          if (!current.needsGeneration || posts >= MAX_POSTS_PER_FLOW) {
            emit({ phase: brief ? "COULD_NOT_UPDATE" : "FAILED_EMPTY", brief, retryAt: clock.now() });
            return;
          }
          emit({ phase: brief ? "UPDATING" : "GENERATING", brief });
          posts++;
          current = guard(await transport.generate(spaceId, signal), signal);
          continue;
        }
      }
    }
  }

  function run(first: (signal: AbortSignal) => Promise<BriefResponse>) {
    if (disposed || flow) return;
    const controller = new AbortController();
    flow = controller;
    lastCheckAt = clock.now();
    void (async () => {
      try {
        await settle(await first(controller.signal), controller.signal);
      } catch (err) {
        if (err instanceof Aborted || controller.signal.aborted || disposed) return;
        emit(view.brief
          ? { phase: "COULD_NOT_UPDATE", retryAt: clock.now() }
          : { phase: view.phase === "NO_DATA" ? "NO_DATA" : "LOAD_ERROR", retryAt: clock.now() });
      } finally {
        if (flow === controller) flow = null;
      }
    })();
  }

  return {
    start() {
      const initial = opts.initial;
      if (initial && initial.spaceId === spaceId && clock.now() - Date.parse(initial.checkedAt) <= BRIEF_INITIAL_MAX_AGE_MS) {
        run(async () => initial);
      } else {
        run((signal) => transport.get(spaceId, signal));
      }
    },
    onVisible() {
      if (disposed || flow) return;
      if (clock.now() - lastCheckAt < BRIEF_RECHECK_THROTTLE_MS) return;
      run((signal) => transport.get(spaceId, signal));
    },
    retry() {
      if (disposed || flow) return;
      if (view.retryAt !== null && clock.now() < view.retryAt) return;
      if (view.phase === "FAILED_EMPTY" || view.phase === "COULD_NOT_UPDATE") {
        emit({ phase: view.brief ? "UPDATING" : "GENERATING" });
        run((signal) => transport.generate(spaceId, signal));
      } else {
        emit({ phase: view.brief ? view.phase : "LOADING" });
        run((signal) => transport.get(spaceId, signal));
      }
    },
    dispose() {
      disposed = true;
      flow?.abort();
      flow = null;
    },
    view: () => view,
  };
}

/** The browser transport: same-origin JSON, never cached. */
export const httpBriefTransport: BriefTransport = {
  async get(spaceId, signal) {
    const res = await fetch(`/api/brief?spaceId=${encodeURIComponent(spaceId)}`, { signal, cache: "no-store" });
    if (!res.ok) throw new Error(`brief read failed: ${res.status}`);
    return (await res.json()) as BriefResponse;
  },
  async generate(spaceId, signal) {
    const res = await fetch("/api/brief/generate", {
      method: "POST", signal, cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId }),
    });
    if (!res.ok) throw new Error(`brief generation request failed: ${res.status}`);
    return (await res.json()) as BriefResponse;
  },
};

export const browserClock: BriefClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
