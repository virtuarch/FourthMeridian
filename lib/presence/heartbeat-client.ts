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
 *   · when the tab becomes visible again (interacted=true).
 * An interaction only MARKS the pending flag; it never sends a beat itself.
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
  let stopped = false;
  let lastBeatAt: number | null = null;
  let inFlight = false;

  async function beat(): Promise<void> {
    if (stopped || inFlight || !deps.isVisible()) return;
    const carried = interacted;
    interacted = false;
    inFlight = true;
    lastBeatAt = deps.now();
    let outcome: BeatOutcome;
    try { outcome = await deps.send(JSON.stringify({ interacted: carried })); }
    catch { outcome = { networkError: true }; }
    inFlight = false;
    if ("networkError" in outcome) { if (carried) interacted = true; return; }
    const { status } = outcome;
    if (status === 401 || status === 403) { stopped = true; return; }
    if (status === 429 || status >= 500) { if (carried) interacted = true; }
  }

  return {
    mount: () => beat(),
    tick: () => beat(),
    async visible() { interacted = true; await beat(); },
    interaction() { interacted = true; },
    stop() { stopped = true; },
    state: () => ({ interacted, stopped, lastBeatAt, inFlight }),
  };
}
