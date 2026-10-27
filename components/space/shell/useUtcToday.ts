"use client";

/**
 * components/space/shell/useUtcToday.ts  (v2.7)
 *
 * The shell's "today" (UTC calendar day — the app's day boundary, see
 * lib/time/clock.ts) as LIVE state: it advances at UTC midnight while the page
 * stays open (a timer to the next boundary, re-armed each day) and re-checks on
 * tab focus / visibility (background tabs throttle timers). Before this the
 * shell computed today once per mount, so a page opened before midnight kept
 * treating yesterday as today until a reload.
 */

import { useEffect, useState } from "react";
import { todayUTCISO } from "@/lib/time/clock";

/** Milliseconds until the next UTC midnight (+250ms so the new day has begun). */
export function msUntilNextUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime() + 250;
}

export function useUtcToday(): string {
  const [today, setToday] = useState(() => todayUTCISO());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => setToday((prev) => { const t = todayUTCISO(); return t === prev ? prev : t; });
    const arm = () => { timer = setTimeout(() => { check(); arm(); }, msUntilNextUtcMidnight()); };
    arm();
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);
  return today;
}
