/**
 * lib/analytics/link-exit-client.ts  (S2-(a) — browser half of CONNECTION_LINK_EXITED)
 *
 * Called from Plaid Link's `onExit` (context/PlaidContext.tsx and the OAuth
 * return page). Sends exactly three fields — the provider, Plaid's exit
 * `status` and `error_code` — and NOTHING ELSE from the error or the metadata:
 * no institution, no error_message / display_message, no link_session_id, no
 * request_id. The server maps both values onto closed vocabularies anyway.
 *
 * Fire-and-forget: never awaited by the caller, never throws, never changes
 * what the user sees. `keepalive` lets it finish while the page navigates.
 */

export function reportPlaidLinkExit(
  err: { error_code?: string | null } | null | undefined,
  metadata: { status?: string | null } | null | undefined,
): void {
  try {
    const body = JSON.stringify({
      provider: "PLAID",
      stage: typeof metadata?.status === "string" ? metadata.status : null,
      errorCode: typeof err?.error_code === "string" ? err.error_code : null,
    });
    void fetch("/api/analytics/link-exit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    /* analytics must never affect the Link flow */
  }
}
