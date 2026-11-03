"use client";

/**
 * components/presence/PresenceHeartbeat.tsx  (PB-10 — the client half of presence)
 *
 * Mounted once in the authenticated dashboard shell. Renders nothing.
 *
 *   · Beats ONLY while the tab is VISIBLE: every PRESENCE_CONFIG.clientBeatIntervalMs,
 *     plus one beat when the tab becomes visible again. A hidden tab, a closed
 *     browser, a suspended phone or a dropped network sends nothing — the server
 *     lets presence EXPIRE (lib/presence/definitions.ts). There is no "going
 *     offline" message to forge or lose.
 *   · Each beat carries ONE boolean: "interacted since the last beat", set by
 *     coarse local events — pointerdown, keydown, scroll, wheel, touchstart, and
 *     the tab becoming visible. The handlers read NOTHING from the event: no key,
 *     no coordinate, no target, no page content. The flag resets per beat.
 *   · No timestamp, count or duration is sent; the server stamps time.
 *   · A 401/403 stops the heartbeat (the session is gone or gated); a 429 or a
 *     network error is ignored — the next interval simply tries again.
 */

import { useEffect } from "react";
import { PRESENCE_CONFIG } from "@/lib/presence/definitions";

export const PRESENCE_ENDPOINT = "/api/user/presence";
/** The coarse events that mean "a human touched this tab". Nothing is read from them. */
export const INTERACTION_EVENTS = ["pointerdown", "keydown", "scroll", "wheel", "touchstart"] as const;

export function PresenceHeartbeat(): null {
  useEffect(() => {
    let interacted = false;
    let stopped = false;
    const mark = () => { interacted = true; };

    const beat = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const body = JSON.stringify({ interacted });
      interacted = false;
      fetch(PRESENCE_ENDPOINT, {
        method: "POST", body, cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      }).then((res) => {
        if (res.status === 401 || res.status === 403) stopped = true;
      }, () => { /* offline / dropped — the next interval retries */ });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") { interacted = true; beat(); }
    };

    const opts: AddEventListenerOptions = { passive: true, capture: true };
    for (const e of INTERACTION_EVENTS) window.addEventListener(e, mark, opts);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(beat, PRESENCE_CONFIG.clientBeatIntervalMs);
    beat(); // presence on arrival (interacted=false: loading a page is not proof of a human)

    return () => {
      stopped = true;
      window.clearInterval(timer);
      for (const e of INTERACTION_EVENTS) window.removeEventListener(e, mark, opts);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return null;
}
