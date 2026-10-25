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
 *   POST refused 503 AI_PAUSED            → PAUSED            (Brief kept; no re-ask for BRIEF_PAUSED_HOLD_MS)
 *   POST refused 503 allowance/pacing
 *        couldn't be checked (retryable) → UNAVAILABLE       (Brief kept; no re-ask for the unavailable hold)
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

import type { BriefArtifactView, BriefDataHealthView, BriefMetricsView, BriefResponse } from "@/lib/brief-types";
import { AI_PAUSED_SENTENCE } from "@/lib/ai/conversation/refusal-sentences";

export const BRIEF_POLL_INTERVAL_MS = 2_000;
export const BRIEF_POLL_MAX_MS = 40_000;
export const BRIEF_RECHECK_THROTTLE_MS = 60_000;
/** A server-rendered state older than this (e.g. restored from history) is re-asked. */
export const BRIEF_INITIAL_MAX_AGE_MS = 5_000;
const MAX_POSTS_PER_FLOW = 2;
/**
 * PAID AI PAUSED — the kill switch or maintenance mode refused the POST before any
 * model work (503 `{ error, code: "AI_PAUSED" }`, no claim, no row). That is an
 * operator's declared state, not a failure: the page says so in a neutral tone,
 * keeps the Brief it has, and does not ask again — not on a visibility event, not
 * from the retry control — until this hold has passed.
 */
export const BRIEF_PAUSED_HOLD_MS = 5 * 60_000;
/** The refusal code (lib/platform/ai/paid-requests-admission.ts AI_PAUSED_CODE — server-only, so restated; pinned by test). */
export const AI_PAUSED_CODE = "AI_PAUSED";
/** The customer sentence, word for word what Conversations shows — one source (refusal-sentences.ts). */
export const BRIEF_PAUSED_MESSAGE = AI_PAUSED_SENTENCE;

/**
 * AI RELIABILITY (F4) — the allowance or pacing store COULD NOT BE CHECKED.
 *
 * 503 `{ code: "AI_ALLOWANCE" | "PACING_UNAVAILABLE", retryable: true, retryAfterSeconds }`
 * from the gate before any model work (lib/ai/allowance-core.ts, lib/ai/pacing.ts).
 * Neither a pause (no operator declared anything) nor a generation failure (no
 * model ran): a transient platform fault. The page says so neutrally, keeps the
 * Brief it has, and holds — at least a minute, at most five, whatever the server
 * suggests — before anything may ask again. No loop: a visibility event during
 * the hold sends nothing.
 */
export const BRIEF_UNAVAILABLE_MESSAGE = "Your Brief is briefly unavailable. Nothing was changed. Please try again in a moment.";
export const BRIEF_UNAVAILABLE_MIN_HOLD_MS = 60_000;
export const BRIEF_UNAVAILABLE_MAX_HOLD_MS = 5 * 60_000;
/** The retryable gate codes (lib/ai/allowance-core.ts ALLOWANCE_CODE, lib/ai/pacing.ts PACING_UNAVAILABLE_CODE — server-only, so restated; pinned by test). */
export const RETRYABLE_GATE_CODES: readonly string[] = ["AI_ALLOWANCE", "PACING_UNAVAILABLE"];

export type BriefPhase =
  | "LOADING"
  | "SHOWING"
  | "UPDATING"
  | "GENERATING"
  | "WAITING"
  | "COULD_NOT_UPDATE"
  | "FAILED_EMPTY"
  | "PAUSED"
  | "UNAVAILABLE"
  | "NO_DATA"
  | "LOAD_ERROR";

export interface BriefView {
  phase:   BriefPhase;
  brief:   BriefArtifactView | null;
  metrics: BriefMetricsView | null;
  /** When each source last delivered; carried from the last page/GET response. */
  dataHealth: BriefDataHealthView | null;
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
  if (!initial) return { phase: "LOADING", brief: null, metrics: null, dataHealth: null, retryAt: null };
  const phase: BriefPhase = initial.state === "NO_DATA" ? "NO_DATA"
    : initial.brief ? "SHOWING" : "LOADING";
  return { phase, brief: initial.brief, metrics: initial.metrics ?? null, dataHealth: initial.dataHealth ?? null, retryAt: null };
}

class Aborted extends Error {}

/** The POST was refused because paid AI is paused. Carries no server text: the page shows its own sentence. */
export class BriefPausedError extends Error {
  constructor() { super("brief generation paused"); this.name = "BriefPausedError"; }
}

/** The POST was refused because the allowance/pacing store could not be checked. Carries only the hold. */
export class BriefUnavailableError extends Error {
  constructor(readonly holdMs: number) { super("brief generation briefly unavailable"); this.name = "BriefUnavailableError"; }
}

/** The hold for an unavailable refusal: the server's hint, bounded to [1 min, 5 min]. */
export function unavailableHoldMs(retryAfterSeconds: unknown): number {
  const hinted = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
  return Math.min(BRIEF_UNAVAILABLE_MAX_HOLD_MS, Math.max(BRIEF_UNAVAILABLE_MIN_HOLD_MS, hinted));
}

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
      if (current.dataHealth !== undefined) view = { ...view, dataHealth: current.dataHealth };
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
        if (err instanceof BriefPausedError) {
          // The Brief on screen (if any) stays — `emit` patches only phase and retryAt.
          emit({ phase: "PAUSED", retryAt: clock.now() + BRIEF_PAUSED_HOLD_MS });
          return;
        }
        if (err instanceof BriefUnavailableError) {
          emit({ phase: "UNAVAILABLE", retryAt: clock.now() + err.holdMs });
          return;
        }
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
      if ((view.phase === "PAUSED" || view.phase === "UNAVAILABLE") && view.retryAt !== null && clock.now() < view.retryAt) return;
      if (clock.now() - lastCheckAt < BRIEF_RECHECK_THROTTLE_MS) return;
      run((signal) => transport.get(spaceId, signal));
    },
    retry() {
      if (disposed || flow) return;
      if (view.retryAt !== null && clock.now() < view.retryAt) return;
      if (view.phase === "FAILED_EMPTY" || view.phase === "COULD_NOT_UPDATE" || view.phase === "PAUSED" || view.phase === "UNAVAILABLE") {
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
    if (!res.ok) {
      const refusal = await classifyBriefRefusal(res);
      if (refusal?.kind === "PAUSED") throw new BriefPausedError();
      if (refusal?.kind === "UNAVAILABLE") throw new BriefUnavailableError(refusal.holdMs);
      throw new Error(`brief generation request failed: ${res.status}`);
    }
    return (await res.json()) as BriefResponse;
  },
};

/**
 * Only a 503 whose body carries `code: "AI_PAUSED"` is a pause. Network errors,
 * 401/403, 429 pacing, the AI allowance and every other 5xx stay ordinary
 * failures. Reads the code alone — the body's text is never shown.
 */
export async function isPaidAiPaused(res: Pick<Response, "status" | "json">): Promise<boolean> {
  return (await classifyBriefRefusal(res))?.kind === "PAUSED";
}

/**
 * What a refused POST means, from its status and CODE fields alone — the body's
 * text is never read for display. Only a 503 can be either: 503 + `AI_PAUSED` is
 * a pause; 503 + a retryable gate code with `retryable: true` is "couldn't be
 * checked". Everything else (network, 401/403, 429 pacing or allowance used up,
 * UNPRICED_MODEL, other 5xx) is null — an ordinary failure, unchanged.
 */
export async function classifyBriefRefusal(res: Pick<Response, "status" | "json">):
  Promise<{ kind: "PAUSED" } | { kind: "UNAVAILABLE"; holdMs: number } | null> {
  if (res.status !== 503) return null;
  const body = await res.json().catch(() => null) as { code?: unknown; retryable?: unknown; retryAfterSeconds?: unknown } | null;
  if (body === null || typeof body !== "object") return null;
  if (body.code === AI_PAUSED_CODE) return { kind: "PAUSED" };
  if (typeof body.code === "string" && RETRYABLE_GATE_CODES.includes(body.code) && body.retryable === true) {
    return { kind: "UNAVAILABLE", holdMs: unavailableHoldMs(body.retryAfterSeconds) };
  }
  return null;
}

export const browserClock: BriefClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
