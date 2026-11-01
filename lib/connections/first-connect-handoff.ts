/**
 * lib/connections/first-connect-handoff.ts  (Connections pass — Preview findings)
 *
 * A one-shot, per-tab note from the onboarding view to the Connections list:
 * "a first connection was started here". The list's "Your financial snapshot is
 * ready" moment normally fires on the poller's importing → idle transition; a
 * source that finishes before the list ever polls (an empty wallet syncs inside
 * the add request) skipped it. With the note, the list shows the moment once,
 * when the server already reports a READY connection — still from persisted
 * state, never from a timer.
 *
 * sessionStorage only; when it is unavailable the note is simply absent and
 * the list falls back to its steady-state link.
 */

const KEY = "fm.connections.firstConnectStarted";

export function noteFirstConnectStarted(): void {
  try { window.sessionStorage.setItem(KEY, "1"); } catch { /* storage unavailable: no handoff */ }
}

/** Read-and-clear. True at most once per note. */
export function takeFirstConnectStarted(): boolean {
  try {
    if (window.sessionStorage.getItem(KEY) !== "1") return false;
    window.sessionStorage.removeItem(KEY);
    return true;
  } catch { return false; }
}
