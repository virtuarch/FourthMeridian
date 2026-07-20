"use client";

/**
 * /prototype/timeline-component-v4 — live harness for the PROMOTED TimelineLens.
 *
 * This page imports the real Atlas primitive and the real PerspectiveTimeAdapter
 * and drives them through the real shellTimeReducer. There is no prototype copy
 * of the component any more, so the harness cannot drift from what ships.
 *
 * It stands in for usePerspectiveShellState only — no URL writes, no fetching.
 * Production rendering is Slice 3; nothing here touches PerspectiveShell.
 */

import { useEffect, useMemo, useReducer } from "react";
import { TimelineLens } from "@/components/atlas/TimelineLens";
import type { TimelineBoundaryError, TimelineIntent, TimelineLensCapability } from "@/components/atlas/TimelineLens";
import {
  PERIOD_OPTIONS,
  capabilityForLens,
  deriveActiveOptionId,
  deriveBoundaries,
  shellActionForIntent,
  summarize,
} from "@/components/space/shell/perspective-time-adapter";
import {
  hydrateShellTimeState,
  shellTimeReducer,
  type PerspectiveTimeState,
  type ShellTimeAction,
} from "@/lib/perspectives/time-range";

const TODAY = "2026-07-19";
const CTX = { today: TODAY, coverageFrom: "2016-02-12" };

interface HostState {
  time: PerspectiveTimeState;
  error: TimelineBoundaryError | null;
  log: { action: ShellTimeAction; result: PerspectiveTimeState }[];
}

type HostAction = { type: "intent"; intent: TimelineIntent } | { type: "external"; time: PerspectiveTimeState };

function hostReducer(state: HostState, action: HostAction): HostState {
  // "external" = URL back-navigation, async coverage arrival, a deep link. The
  // lens never sees it, yet the readout follows — everything it shows is derived.
  if (action.type === "external") return { ...state, time: action.time, error: null };

  const result = shellActionForIntent(action.intent, { today: TODAY });
  if (!result.ok) {
    return action.intent.type === "customBoundary"
      ? { ...state, error: { boundary: action.intent.boundary, message: result.error } }
      : state;
  }

  const time = shellTimeReducer(state.time, result.action, CTX);
  return { time, error: null, log: [{ action: result.action, result: time }, ...state.log].slice(0, 6) };
}

/**
 * Deep-link hydration, exercised the same way the shell does it: read the URL
 * params, run them through the REAL hydrateShellTimeState. Lets the harness
 * verify that a `?asof=…&preset=…` link produces the right anchor readout.
 */
function initialState(): HostState {
  const time = (() => {
    if (typeof window === "undefined") return { preset: "PAST_YEAR", asOf: TODAY, compareTo: "2025-07-19" } as PerspectiveTimeState;
    const q = new URLSearchParams(window.location.search);
    const raw = { asOf: q.get("asof"), compareTo: q.get("compareto"), preset: q.get("preset") };
    if (!raw.asOf && !raw.compareTo && !raw.preset) {
      return { preset: "PAST_YEAR", asOf: TODAY, compareTo: "2025-07-19" } as PerspectiveTimeState;
    }
    return hydrateShellTimeState(raw, CTX);
  })();
  return { time, error: null, log: [] };
}

const INITIAL: HostState = {
  time: { preset: "PAST_YEAR", asOf: TODAY, compareTo: "2025-07-19" },
  error: null,
  log: [],
};

function Specimen({
  title,
  capability,
  note,
}: {
  title: string;
  capability?: TimelineLensCapability;
  note: string;
}) {
  const [state, dispatch] = useReducer(hostReducer, INITIAL);
  // Post-mount hydration, exactly as the shell does it (avoids SSR mismatch).
  useEffect(() => { dispatch({ type: "external", time: initialState().time }); }, []);
  const summary = useMemo(() => summarize(state.time, TODAY), [state.time]);

  return (
    <div className="rounded-[var(--radius-xl)] border border-[var(--border-hairline)] bg-[var(--bg-base)] p-6 sm:p-8">
      <header className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
            Perspective
          </p>
          <h2 className="text-3xl font-normal tracking-[-0.02em] text-[var(--text-primary)]">{title}</h2>
          <p className="mt-2 max-w-sm text-[11px] leading-relaxed text-[var(--text-muted)]">{note}</p>
        </div>
        <TimelineLens
          activeOptionId={deriveActiveOptionId(state.time)}
          boundaries={deriveBoundaries(state.time)}
          summary={summary}
          periodOptions={PERIOD_OPTIONS}
          capability={capability ?? capabilityForLens(undefined)}
          maxDate={TODAY}
          boundaryError={state.error}
          onIntent={(intent) => dispatch({ type: "intent", intent })}
        />
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
          Dispatched shell actions
        </span>
        <button
          type="button"
          onClick={() =>
            dispatch({ type: "external", time: { preset: "QTD", asOf: "2026-05-04", compareTo: "2026-04-01" } })
          }
          className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          Simulate back-navigation
        </button>
      </div>

      {state.log.length === 0 ? (
        <p className="text-[11px] text-[var(--text-faint)]">
          Change the period to see the exact action the shell receives today.
        </p>
      ) : (
        <ul className="grid gap-1">
          {state.log.map((entry, index) => (
            <li
              key={index}
              className="overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--surface-inset)] px-2 py-1.5 font-mono text-[11px] whitespace-nowrap text-[var(--text-muted)]"
            >
              <span className="text-[var(--meridian-400)]">{JSON.stringify(entry.action)}</span>
              <span className="mx-2 text-[var(--text-faint)]">→</span>
              <span>{JSON.stringify(entry.result)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function TimelineLensHarnessPage() {
  return (
    <main className="min-h-screen bg-[var(--bg-deep)] px-4 py-12 text-[var(--text-primary)] sm:px-8 sm:py-16">
      <header className="mx-auto mb-14 max-w-5xl">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--meridian-400)]">
          Atlas primitive · Slice 1–2 harness
        </p>
        <h1 className="text-4xl font-normal tracking-[-0.02em] sm:text-5xl">TimelineLens</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
          The promoted <code>components/atlas/TimelineLens</code> driven by the real
          PerspectiveTimeAdapter and the real <code>shellTimeReducer</code>. One user action, one
          existing shell action, one commit. Not wired into PerspectiveShell — that is Slice 3.
        </p>
      </header>

      <div className="mx-auto grid max-w-5xl gap-14">
        <section>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
            Full temporal capability · Wealth / Investments
          </p>
          <Specimen
            title="Wealth"
            note="Boundary fields shown. A comparison date after the as-of date stays expressible — Wealth depends on it."
          />
        </section>

        <section>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
            Period axis only · Cash Flow
          </p>
          <Specimen
            title="Cash Flow"
            capability={capabilityForLens({ asOf: "none", compareTo: "none", period: "full" })}
            note="Explicit boundary inputs are capability-gated off, exactly as ShellContextRow hides them today. The preset strip stays universal."
          />
        </section>
      </div>

      <footer className="mx-auto mt-14 max-w-5xl border-t border-[var(--border-hairline)] pt-5 text-[11px] leading-relaxed text-[var(--text-faint)]">
        Everything the lens displays is derived from canonical state each render, so back-navigation
        and async coverage arrival are reflected without the component knowing they happened.
      </footer>
    </main>
  );
}
