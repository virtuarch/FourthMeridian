/**
 * lib/connections/action-errors.ts  (Connections redesign — PR 1)
 *
 * PURE, client-safe. The refresh routes answer refusals with short MACHINE codes
 * ("cooldown", "in-flight", "not-admitted") that the Connections menu and the
 * wallet Refresh button used to print verbatim. This maps each code to a
 * sentence a customer can act on; any other string is already prose written for
 * the customer by its route and passes through unchanged.
 */

const CODE_COPY: Record<string, string> = {
  "cooldown":     "This connection was refreshed recently. You can refresh it again in a little while.",
  "in-flight":    "An update is already running for this connection. It will finish on its own.",
  "not-admitted": "Updates are paused for the moment. Your data will refresh automatically once they resume.",
};

/** Customer copy for a route's `error` field, or null when there is none. */
export function connectionActionError(error: unknown): string | null {
  if (typeof error !== "string" || !error) return null;
  return CODE_COPY[error] ?? error;
}
