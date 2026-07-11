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

/**
 * Terminal callbacks for the connection-specific "Enable Investments" flow.
 * Let a single card drive its own local syncing/error UI without polluting the
 * shared context error state (which every button reads).
 */
export interface InvestmentsConsentHandlers {
  /** Link succeeded; the post-consent holdings refresh has started. */
  onSyncing?: () => void;
  /**
   * Terminal. ok=true → consent granted + holdings imported (the context has
   * already called router.refresh()). ok=false with a message → real failure
   * to surface. ok=false with no message → clean user cancel (non-destructive).
   */
  onResult?: (ok: boolean, error?: string) => void;
}

interface PlaidContextValue {
  /** plaidItemId (optional): D2-7E reconnect — opens Link in update mode for that item. */
  openLink:        (onDone?: () => void, plaidItemId?: string) => void;
  /**
   * Connection-specific Investments consent. Opens Link update mode for the
   * given Item with `additional_consented_products: [investments]`; on success
   * runs the existing holdings refresh (POST /api/plaid/investments/enable).
   * Never exchanges a token and never creates a duplicate Item.
   */
  openInvestmentsConsent: (plaidItemId: string, handlers?: InvestmentsConsentHandlers) => void;
  isLoading:       boolean;
  error:           string;
  cancelled:       boolean;
  clearError:      () => void;
  /** Whether Plaid Link is open (showing the Link UI) */
  isOpen:          boolean;
}

const PlaidContext = createContext<PlaidContextValue>({
  openLink:                () => {},
  openInvestmentsConsent:  () => {},
  isLoading:  false,
  error:      "",
  cancelled:  false,
  clearError: () => {},
  isOpen:     false,
});

// sessionStorage keys shared with app/plaid-oauth-return/page.tsx so an OAuth
// institution (which redirects out of this component and back to a different
// page) still resolves to the correct post-Link action. Absent mode = normal
// connect/reconnect (exchange-token).
const PLAID_MODE_KEY     = "plaid_link_mode";
const PLAID_INV_ITEM_KEY = "plaid_investments_item_id";

export function PlaidProvider({ children }: { children: React.ReactNode }) {
  const router     = useRouter();
  const onDoneRef  = useRef<(() => void) | undefined>(undefined);
  // Handlers for the in-app (non-OAuth) Investments-consent flow. OAuth
  // institutions resolve on the OAuth-return page instead, which has its own
  // UI, so these are only consumed when Link completes in-place.
  const investmentsHandlersRef = useRef<InvestmentsConsentHandlers | undefined>(undefined);

  const [linkToken,  setLinkToken]  = useState<string | null>(null);
  const [fetching,   setFetching]   = useState(false);
  const [importing,  setImporting]  = useState(false);
  const [error,      setError]      = useState("");
  const [cancelled,  setCancelled]  = useState(false);

  // isOpen is derived — true while linkToken is held (Link is initialised or open)
  const isOpen = linkToken !== null;

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token, metadata) => {
      // ── Investments-consent completion (update mode) ────────────────────────
      // No token exchange — the access_token is unchanged. Run the existing
      // holdings refresh, which re-derives consent (→ ENABLED) and imports
      // holdings. Branch first so the normal path below is byte-for-byte
      // unchanged for every reconnect/new-link session.
      if (sessionStorage.getItem(PLAID_MODE_KEY) === "investments") {
        const plaidItemId = sessionStorage.getItem(PLAID_INV_ITEM_KEY) ?? "";
        sessionStorage.removeItem("plaid_link_token");
        sessionStorage.removeItem(PLAID_MODE_KEY);
        sessionStorage.removeItem(PLAID_INV_ITEM_KEY);
        const handlers = investmentsHandlersRef.current;
        investmentsHandlersRef.current = undefined;
        handlers?.onSyncing?.();
        try {
          const res = await fetch("/api/plaid/investments/enable", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ plaidItemId }),
          });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error ?? "Could not enable Investments.");
          }
          handlers?.onResult?.(true);
          // Re-pull the server page so the card re-renders with the now-ENABLED
          // capability (and any newly imported holdings elsewhere).
          router.refresh();
        } catch (e) {
          handlers?.onResult?.(false, e instanceof Error ? e.message : "Could not enable Investments.");
        } finally {
          setLinkToken(null);
        }
        return;
      }

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

    // ── Investments-consent flow: route terminal state to the card's handler ──
    // Cancel is non-destructive (the Item is untouched); a real error surfaces
    // to the card only. Never sets the shared error/cancelled state.
    if (sessionStorage.getItem(PLAID_MODE_KEY) === "investments") {
      sessionStorage.removeItem(PLAID_MODE_KEY);
      sessionStorage.removeItem(PLAID_INV_ITEM_KEY);
      const handlers = investmentsHandlersRef.current;
      investmentsHandlersRef.current = undefined;
      if (err) {
        handlers?.onResult?.(false, err.display_message ?? "Couldn’t enable Investments. Please try again.");
      } else {
        handlers?.onResult?.(false); // clean cancel — silent, non-destructive
      }
      return;
    }

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
    // Normal connect/reconnect — never carries the Investments-consent mode.
    // Clear any stale flag so a prior cancelled Investments attempt can't leak
    // into this session.
    sessionStorage.removeItem(PLAID_MODE_KEY);
    sessionStorage.removeItem(PLAID_INV_ITEM_KEY);
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

  const openInvestmentsConsent = useCallback(
    async (plaidItemId: string, handlers?: InvestmentsConsentHandlers) => {
      setError("");
      setCancelled(false);
      setFetching(true);
      investmentsHandlersRef.current = handlers;
      // Set the mode BEFORE opening Link so both this component's onSuccess and
      // the OAuth-return page resolve to the enable action (not exchange-token).
      sessionStorage.setItem(PLAID_MODE_KEY, "investments");
      sessionStorage.setItem(PLAID_INV_ITEM_KEY, plaidItemId);
      try {
        const res  = await fetch(
          `/api/plaid/link-token?plaidItemId=${encodeURIComponent(plaidItemId)}&consent=investments`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not start Plaid Link.");
        sessionStorage.setItem("plaid_link_token", data.link_token);
        setLinkToken(data.link_token);
      } catch (err) {
        sessionStorage.removeItem(PLAID_MODE_KEY);
        sessionStorage.removeItem(PLAID_INV_ITEM_KEY);
        investmentsHandlersRef.current = undefined;
        handlers?.onResult?.(false, err instanceof Error ? err.message : "Could not start Plaid Link.");
      } finally {
        setFetching(false);
      }
    },
    [],
  );

  return (
    <PlaidContext.Provider
      value={{
        openLink,
        openInvestmentsConsent,
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
