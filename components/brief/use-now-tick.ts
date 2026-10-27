"use client";

/**
 * components/brief/use-now-tick.ts
 *
 * v2.7 — a light clock for relative times ("Updated 37 min ago"). One shared
 * interval for every subscriber, ticking each minute and on returning to the tab,
 * so a phrase ages as time passes — across midnight too — with no new Brief
 * generation and no request of any kind.
 *
 * Returns null during server render and hydration (the server's clock must never
 * be printed as the viewer's), then the current instant in ms.
 */

import { useSyncExternalStore } from "react";

const TICK_MS = 60_000;
let now = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  now = Date.now();
  for (const l of listeners) l();
}

function onVisible() {
  if (document.visibilityState === "visible") tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

const getSnapshot = () => (now === 0 ? (now = Date.now()) : now);
const getServerSnapshot = (): number | null => null;

export function useNowTick(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
