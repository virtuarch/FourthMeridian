"use client";

/**
 * components/platform/workspace-session.tsx  (OPS-2C-6 — Shared Consumption)
 *
 * THE WORKSPACE OWNS THE OPERATIONAL SESSION.
 *
 *     Workspace  →  shared operational state  →  widgets  →  inspection surfaces
 *
 * Before this, every widget owned an independent fetch lifecycle, so two widgets
 * reading the same route in one workspace issued two identical requests and held
 * two independently-timed copies of the same operational moment. That is not
 * merely wasteful — it means two cards in one view can disagree about the state
 * of the platform because they observed it milliseconds apart.
 *
 * ── WHAT THIS CONSOLIDATES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────
 * It consolidates CONSUMPTION. It does not touch AUTHORITY:
 *
 *   • no routes merged, no aggregate DTO, no "dashboard endpoint";
 *   • the frozen OPS-2C-1 routes are called exactly as authored, one per URL;
 *   • the session stores each response VERBATIM under its own URL — nothing is
 *     combined, folded, or reconciled, so no truth is computed here;
 *   • widgets still DECLARE their own URL. Ownership of "what do I need" stays
 *     with the widget; the workspace owns only "when is it fetched, and for how
 *     long is it the session's answer".
 *
 * ── SESSION LIFETIME IS THE WORKSPACE ─────────────────────────────────────────
 * The store is created per mounted workspace and discarded when the workspace
 * unmounts. Leaving a workspace and returning therefore REFETCHES — the verified
 * OPS-2C-2 behaviour is preserved exactly. This is intentional: an operational
 * read has no staleness window, and silently serving a cached answer from a
 * previous visit would present a stale platform state as current.
 *
 * ── INSPECTION SURFACES DO NOT JOIN THE SESSION ───────────────────────────────
 * Keyed object-inspection reads (the execution timeline panel) stay independent
 * by design. A workspace-scoped resource is a stable endpoint shared by many
 * widgets; an inspection read is one object's identity, fetched on demand and
 * discarded when the operator closes the panel. Caching those in the session
 * would retain per-object payloads for the life of the workspace to no benefit.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** What a subscriber sees. Identical in shape to `useWidgetFetch`'s return. */
export interface SharedFetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** The one shared loading snapshot — a stable reference, required by useSyncExternalStore. */
const LOADING: SharedFetchState<unknown> = { data: null, loading: true, error: null };

interface Entry {
  /** Current snapshot. Replaced (never mutated) so identity change signals a change. */
  snap: SharedFetchState<unknown>;
  listeners: Set<() => void>;
  /** True once a request has been issued for this url in this session. */
  started: boolean;
  abort: AbortController | null;
}

export interface WorkspaceSessionStore {
  /** Begin the request for `url` if this session has not already. Idempotent. */
  ensure(url: string): void;
  /** The current snapshot for `url`. Stable identity between changes. */
  read(url: string): SharedFetchState<unknown>;
  subscribe(url: string, listener: () => void): () => void;
  /** Abort everything in flight — called when the workspace unmounts. */
  dispose(): void;
  /** Test/verification aid: how many requests this session has issued. */
  requestCount(): number;
}

export function createWorkspaceSessionStore(): WorkspaceSessionStore {
  const entries = new Map<string, Entry>();
  let requests = 0;

  const entryFor = (url: string): Entry => {
    let e = entries.get(url);
    if (!e) {
      e = { snap: LOADING, listeners: new Set(), started: false, abort: null };
      entries.set(url, e);
    }
    return e;
  };

  const emit = (e: Entry) => {
    for (const l of e.listeners) l();
  };

  return {
    ensure(url) {
      const e = entryFor(url);
      // THE DEDUPE: the first widget to ask starts the request; every later widget
      // in this session subscribes to that same one.
      if (e.started) return;
      e.started = true;
      requests++;

      const controller = new AbortController();
      e.abort = controller;

      fetch(url, { credentials: "same-origin", signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
          return (await r.json()) as unknown;
        })
        .then((json) => {
          if (controller.signal.aborted) return;
          e.snap = { data: json, loading: false, error: null };
          emit(e);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          e.snap = {
            data: null,
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load",
          };
          emit(e);
        });
    },

    read(url) {
      return entryFor(url).snap;
    },

    subscribe(url, listener) {
      const e = entryFor(url);
      e.listeners.add(listener);
      return () => {
        e.listeners.delete(listener);
      };
    },

    dispose() {
      for (const e of entries.values()) e.abort?.abort();
      entries.clear();
    },

    requestCount() {
      return requests;
    },
  };
}

const WorkspaceSessionContext = createContext<WorkspaceSessionStore | null>(null);

/**
 * Owns one workspace's operational session. Mount it around a workspace body and
 * give it a `key` tied to the workspace id, so switching workspaces discards the
 * session rather than carrying a previous view's answers forward.
 */
export function WorkspaceSessionProvider({
  children,
  store,
}: {
  children: ReactNode;
  /** Injectable for tests; production omits it and gets a fresh session. */
  store?: WorkspaceSessionStore;
}) {
  const created = useMemo(() => store ?? createWorkspaceSessionStore(), [store]);

  useEffect(() => () => created.dispose(), [created]);

  return (
    <WorkspaceSessionContext.Provider value={created}>{children}</WorkspaceSessionContext.Provider>
  );
}

/**
 * Subscribe to a workspace-shared resource.
 *
 * Call-site contract is identical to `useWidgetFetch`, including the STATIC URL
 * requirement: the url must be a string literal, because a changing url would
 * show the previous resource's data as current. A widget whose url varies is an
 * inspection surface, not a workspace resource — key-remount it instead.
 *
 * Outside a provider it degrades to an independent per-hook session, so a widget
 * rendered on its own behaves exactly as it did before this slice.
 */
export function useSharedWidgetFetch<T>(url: string): SharedFetchState<T> {
  const shared = useContext(WorkspaceSessionContext);
  // Lazy useState, NOT a ref: reading `ref.current` during render is a React
  // rule violation (and lint error). The initializer runs once, so this is a
  // stable per-hook store; when a provider exists it simply goes unused.
  const [fallback] = useState(createWorkspaceSessionStore);
  const store = shared ?? fallback;

  // Dispose the fallback on unmount. A shared store is owned — and disposed — by
  // its provider, so it is never torn down from here.
  useEffect(() => () => { if (!shared) fallback.dispose(); }, [shared, fallback]);

  // Requests start in an EFFECT, never during render — getSnapshot must stay pure.
  useEffect(() => {
    store.ensure(url);
  }, [store, url]);

  const snap = useSyncExternalStore(
    (cb) => store.subscribe(url, cb),
    () => store.read(url),
    () => LOADING,
  );

  return snap as SharedFetchState<T>;
}
