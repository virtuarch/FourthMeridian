"use client";

/**
 * context/PlaidContext.tsx
 *
 * Single source of truth for Plaid Link across the entire app.
 * `usePlaidLink` is called ONCE here — mounting it in multiple components
 * caused Plaid's link-initialize.js to be injected more than once.
 *
 * Usage:
 *   const { openLink, isLoading, error } = usePlaid();
 *   <button onClick={() => openLink(onDone)}>Connect Account</button>
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  usePlaidLink,
  PlaidLinkOnSuccess,
  PlaidLinkOnExit,
  PlaidLinkOnEvent,
} from "react-plaid-link";
import { useRouter } from "next/navigation";

interface PlaidContextValue {
  /** plaidItemId (optional): D2-7E reconnect — opens Link in update mode for that item. */
  openLink:        (onDone?: () => void, plaidItemId?: string) => void;
  isLoading:       boolean;
  error:           string;
  cancelled:       boolean;
  clearError:      () => void;
  /** Whether Plaid Link is open (showing the Link UI) */
  isOpen:          boolean;
}

const PlaidContext = createContext<PlaidContextValue>({
  openLink:   () => {},
  isLoading:  false,
  error:      "",
  cancelled:  false,
  clearError: () => {},
  isOpen:     false,
});

export function PlaidProvider({ children }: { children: React.ReactNode }) {
  const router     = useRouter();
  const onDoneRef  = useRef<(() => void) | undefined>(undefined);

  const [linkToken,  setLinkToken]  = useState<string | null>(null);
  const [fetching,   setFetching]   = useState(false);
  const [importing,  setImporting]  = useState(false);
  const [error,      setError]      = useState("");
  const [cancelled,  setCancelled]  = useState(false);

  // isOpen is derived — true while linkToken is held (Link is initialised or open)
  const isOpen = linkToken !== null;

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token, metadata) => {
      setImporting(true);
      setError("");
      setCancelled(false);
      sessionStorage.removeItem("plaid_link_token");
      try {
        const res = await fetch("/api/plaid/exchange-token", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            public_token,
            institution_id:   metadata.institution?.institution_id ?? "",
            institution_name: metadata.institution?.name           ?? "Unknown",
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? "Import failed");
        }
        onDoneRef.current?.();
        // D2.x Slice 3 — all Plaid connects resolve to the permanent
        // Connections hub, the single destination where first-run sync
        // progress and provider management live. Replaces the prior bare
        // router.refresh() (which gave no visible post-connect feedback). The
        // new institution renders there as an "importing" card among any
        // existing "ready" ones. onDone still runs first for callers that need
        // to close a modal, etc.
        router.push("/dashboard/connections");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to import accounts.");
      } finally {
        setImporting(false);
        setLinkToken(null);
        onDoneRef.current = undefined;
      }
    },
    [router]
  );

  // ── onExit: fired when Link closes (user cancel, error, or OAuth failure) ───
  const onExit = useCallback<PlaidLinkOnExit>((err, metadata) => {
    setLinkToken(null);
    setFetching(false);
    onDoneRef.current = undefined;
    sessionStorage.removeItem("plaid_link_token");

    // ── Safe diagnostic log — never logs tokens or secrets ────────────────────
    console.group("[Plaid] onExit");
    console.log("error_type:",      err?.error_type      ?? null);
    console.log("error_code:",      err?.error_code      ?? null);
    console.log("error_message:",   err?.error_message   ?? null);
    console.log("display_message:", err?.display_message      ?? null);
    console.log("request_id:",      metadata?.request_id      ?? null);
    console.log("status:",          metadata?.status           ?? null);
    console.log("link_session_id:", metadata?.link_session_id ?? null);
    console.log("institution:",     metadata?.institution?.name ?? null,
                                    metadata?.institution?.institution_id ?? null);
    console.groupEnd();

    if (!err) {
      // Clean user cancel (closed X button, clicked back, etc.)
      setCancelled(true);
    } else {
      // Surface specific OAuth / config errors to the user
      const code = err.error_code ?? "";
      if (
        code === "OAUTH_STATE_ID_MISMATCH" ||
        code === "OAUTH_INVALID_STATE" ||
        code === "REDIRECT_URI_MISMATCH" ||
        code === "INVALID_LINK_TOKEN" ||
        code === "LINK_TOKEN_EXPIRED"
      ) {
        setError(err.display_message ?? "Link session error. Please try again.");
      } else {
        // Generic error from Plaid — show display_message if safe, else generic
        setError(err.display_message ?? "Connection closed unexpectedly. Please try again.");
      }
    }
  }, []);

  // ── onEvent: every step Plaid Link takes — great for diagnosing silent exits ─
  const onEvent = useCallback<PlaidLinkOnEvent>((eventName, metadata) => {
    // Safe fields only — no tokens
    console.log("[Plaid] onEvent:", eventName, {
      error_type:      metadata.error_type      ?? null,
      error_code:      metadata.error_code      ?? null,
      error_message:   metadata.error_message   ?? null,
      institution_id:  metadata.institution_id  ?? null,
      institution_name:metadata.institution_name?? null,
      link_session_id: metadata.link_session_id ?? null,
      request_id:      metadata.request_id      ?? null,
      view_name:       metadata.view_name        ?? null,
      exit_status:     metadata.exit_status     ?? null,
    });
  }, []);

  const { open, ready } = usePlaidLink({
    token:    linkToken ?? "",
    onSuccess,
    onExit,
    onEvent,
  });

  // Auto-open as soon as token arrives and Plaid is ready
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const openLink = useCallback(async (onDone?: () => void, plaidItemId?: string) => {
    setError("");
    setCancelled(false);
    setFetching(true);
    onDoneRef.current = onDone;
    try {
      const url  = plaidItemId
        ? `/api/plaid/link-token?plaidItemId=${encodeURIComponent(plaidItemId)}`
        : "/api/plaid/link-token";
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start Plaid Link.");
      // Store in sessionStorage so /plaid-oauth-return can re-initialise Link
      // after an OAuth bank redirect. Cleared after onSuccess or onExit.
      sessionStorage.setItem("plaid_link_token", data.link_token);
      setLinkToken(data.link_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect.");
      onDoneRef.current = undefined;
    } finally {
      setFetching(false);
    }
  }, []);

  return (
    <PlaidContext.Provider
      value={{
        openLink,
        isLoading:  fetching || importing,
        error,
        cancelled,
        isOpen,
        clearError: () => { setError(""); setCancelled(false); },
      }}
    >
      {children}
    </PlaidContext.Provider>
  );
}

export function usePlaid() {
  return useContext(PlaidContext);
}
