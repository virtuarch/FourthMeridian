"use client";

/**
 * components/presence/PresenceHeartbeat.tsx  (PB-10 — the client half of presence)
 *
 * Mounted once in the authenticated dashboard shell. Renders nothing. Wires the
 * browser to lib/presence/heartbeat-client.ts, which owns every decision:
 *
 *   · beats ONLY while the tab is VISIBLE — immediately on mount, every
 *     PRESENCE_CONFIG.clientBeatIntervalMs, and when the tab becomes visible again;
 *   · each beat carries ONE boolean, "interacted since the last beat", set by
 *     coarse local events (pointerdown, keydown, scroll, wheel, touchstart, the
 *     tab becoming visible). The handlers read NOTHING from the event;
 *   · a refused (429) or lost beat keeps its interaction for the next one;
 *     401/403 stop the heartbeat;
 *   · no timestamp, count or duration is sent — the server stamps time.
 */

import { useEffect } from "react";
import { PRESENCE_CONFIG } from "@/lib/presence/definitions";
import { createHeartbeatController, type BeatOutcome } from "@/lib/presence/heartbeat-client";

export const PRESENCE_ENDPOINT = "/api/user/presence";
/** The coarse events that mean "a human touched this tab". Nothing is read from them. */
export const INTERACTION_EVENTS = ["pointerdown", "keydown", "scroll", "wheel", "touchstart"] as const;

export function PresenceHeartbeat(): null {
  useEffect(() => {
    const controller = createHeartbeatController({
      now: () => Date.now(),
      isVisible: () => document.visibilityState === "visible",
      send: (body) => fetch(PRESENCE_ENDPOINT, {
        method: "POST", body, cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      }).then((res): BeatOutcome => ({ status: res.status }), (): BeatOutcome => ({ networkError: true })),
    });
    const onInteraction = () => { controller.interaction(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void controller.visible(); };

    const opts: AddEventListenerOptions = { passive: true, capture: true };
    for (const e of INTERACTION_EVENTS) window.addEventListener(e, onInteraction, opts);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => { void controller.tick(); }, PRESENCE_CONFIG.clientBeatIntervalMs);
    void controller.mount();

    return () => {
      controller.stop();
      window.clearInterval(timer);
      for (const e of INTERACTION_EVENTS) window.removeEventListener(e, onInteraction, opts);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return null;
}
