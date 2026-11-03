/**
 * lib/presence/heartbeat-client.ts  (PB-10 — the client heartbeat's decisions, DOM-free)
 *
 * components/presence/PresenceHeartbeat.tsx wires browser events to this
 * controller; every decision lives here so it is testable without a DOM.
 *
 * WHEN A BEAT IS SENT (only ever while the tab is VISIBLE):
 *   · on MOUNT — immediately (presence on arrival, interacted=false: loading a
 *     page is not proof of a human);
 *   · every PRESENCE_CONFIG.clientBeatIntervalMs (`tick`);
 *   · when the tab becomes visible again — PRESENCE ONLY.
 * An interaction only MARKS the pending flag; it never sends a beat itself.
 *
 * F4 (Preview, macOS) — visibility is NOT an interaction. Chrome flips
 * visibilitychange on window occlusion, screen lock/unlock and other windows
 * covering or uncovering the tab, with no human touching it; counting it showed
 * "Active now" for a session idle 6+ minutes. Only the real INTERACTION_EVENTS
 * (components/presence/PresenceHeartbeat.tsx) set the flag; the visible beat
 * carries whatever REAL input is still pending (normally none ⇒ false).
 *
 * STALE CAP. The server stamps an interaction at beat ARRIVAL, so an input just
 * before the tab was hidden is credited when the next beat lands. A pending
 * flag is dropped — that beat goes out interacted=false — when the INPUT it
 * records is more than STALE_INTERACTION_MS (2 × the client interval) old. The
 * age is the input's, not the beat's, and a flag RESTORED after a 429 / 5xx /
 * network failure keeps its original age — so an old interaction can never be
 * replayed late (S2 ruling).
 *
 * F1 (S2 review) — CARRY-OVER. The rate-limit bucket is per SESSION, shared by
 * every tab, so a beat can be refused (429) or lost (network). The pending
 * `interacted` is cleared optimistically when a beat is sent; when that beat is
 * NOT accepted (429, 5xx, network failure) it is RESTORED, so the next beat
 * carries it. 401/403 stop the heartbeat (session gone / gated); 400/413 are a
 * client bug and are not retried with the same claim.
 *
 * Nothing here reads event contents, coordinates or page content; nothing sends
 * a time. The server stamps every clock.
 */

import { PRESENCE_CONFIG } from "./definitions";

/** A pending interaction older than this (measured from the INPUT) is dropped, never sent. */
export const STALE_INTERACTION_MS = 2 * PRESENCE_CONFIG.clientBeatIntervalMs;

export type BeatOutcome = { status: number } | { networkError: true };

export interface HeartbeatDeps {
  now: () => number;
  isVisible: () => boolean;
  /** POST the beat body; resolve with the HTTP status, or networkError. */
  send: (body: string) => Promise<BeatOutcome>;
}

export interface HeartbeatController {
  mount(): Promise<void>;
  tick(): Promise<void>;
  visible(): Promise<void>;
  interaction(): void;
  stop(): void;
  /** Test/inspection only. */
  state(): { interacted: boolean; stopped: boolean; lastBeatAt: number | null; inFlight: boolean };
}

export function createHeartbeatController(deps: HeartbeatDeps): HeartbeatController {
  let interacted = false;
  /** When the LATEST pending input happened (kept across an F1 restore). */
  let pendingSince: number | null = null;
  let stopped = false;
  let lastBeatAt: number | null = null;
  let inFlight = false;

  async function beat(): Promise<void> {
    if (stopped || inFlight || !deps.isVisible()) return;
    const now = deps.now();
    // Age of the pending flag = time since the INPUT (kept across an F1 restore), never since a beat.
    const stale = pendingSince !== null && now - pendingSince > STALE_INTERACTION_MS;
    const carried = interacted && !stale;
    const carriedSince = carried ? pendingSince : null;
    interacted = false;
    pendingSince = null;
    inFlight = true;
    lastBeatAt = now;
    let outcome: BeatOutcome;
    try { outcome = await deps.send(JSON.stringify({ interacted: carried })); }
    catch { outcome = { networkError: true }; }
    inFlight = false;
    const restore = () => { if (carried && !interacted) { interacted = true; pendingSince = carriedSince; } };
    if ("networkError" in outcome) { restore(); return; }
    const { status } = outcome;
    if (status === 401 || status === 403) { stopped = true; return; }
    if (status === 429 || status >= 500) restore();
  }

  return {
    mount: () => beat(),
    tick: () => beat(),
    // F4 — presence only: visibility never sets the flag (occlusion / lock flips it).
    visible: () => beat(),
    // Every input refreshes the age: the flag is as fresh as the LATEST pending input (S2 nit).
    interaction() { interacted = true; pendingSince = deps.now(); },
    stop() { stopped = true; },
    state: () => ({ interacted, stopped, lastBeatAt, inFlight }),
  };
}
