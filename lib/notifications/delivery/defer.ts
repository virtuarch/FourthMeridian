/**
 * lib/notifications/delivery/defer.ts  (Comms Center Phase A-2a)
 *
 * Run bookkeeping AFTER the response when a request scope exists — Next's
 * `after()` (next/server, stable in this Next version) — and inline otherwise.
 * Outside a request (jobs run from scripts, unit tests, CLI tools) `after()`
 * throws, and the task runs right here instead, so non-request callers are
 * unaffected. Inside a request the response is never held by the ledger write.
 * Also used by lib/notifications/create.ts (where the pattern started: the
 * D2.x deferred-history precedent).
 */

export async function runAfterResponse(task: () => Promise<void>): Promise<void> {
  try {
    const { after } = await import("next/server");
    after(task);
  } catch {
    await task();
  }
}
