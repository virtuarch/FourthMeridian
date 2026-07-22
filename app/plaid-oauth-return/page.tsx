"use client";

/**
 * app/plaid-oauth-return/page.tsx
 *
 * OAuth redirect landing page for Plaid Link.
 *
 * How this works:
 *   1. User selects an OAuth institution (Chase, BoA, etc.) in Plaid Link.
 *   2. Plaid Link opens the institution's OAuth page in a new tab/redirect.
 *   3. After the user authenticates, the institution redirects back here.
 *      The URL will contain an `oauth_state_id` query param added by Plaid.
 *   4. This page re-initialises Plaid Link in "OAuth return" mode by passing
 *      the full current URL as `receivedRedirectUri` to usePlaidLink.
 *   5. Plaid Link completes the flow automatically and calls onSuccess.
 *   6. We exchange the public token server-side and redirect home.
 *
 * Requirements:
 *   - PLAID_REDIRECT_URI must point to this page (e.g. https://xyz.ngrok.io/plaid-oauth-return)
 *   - That URI must be registered in Plaid Dashboard → Team → API → Allowed redirect URIs
 *   - The original link token must be in localStorage (stored by PlaidContext
 *     before opening Link). localStorage rather than sessionStorage because the
 *     latter is per-tab: on mobile the OAuth return frequently lands in a NEW
 *     tab with an empty sessionStorage, so the token vanished and this page
 *     reported "Link session expired" — desktop worked only because it returns
 *     in the same tab.
 */

import { useEffect, useRef, useState, startTransition } from "react";
import { usePlaidLink, PlaidLinkOnSuccess, PlaidLinkOnExit } from "react-plaid-link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function PlaidOAuthReturn() {
  const router = useRouter();

  const [linkToken,       setLinkToken]       = useState<string | null>(null);
  const [receivedUri,     setReceivedUri]      = useState<string>("");
  const [status,          setStatus]           = useState<"loading" | "ready" | "importing" | "error">("loading");
  const [errorMessage,    setErrorMessage]     = useState("");
  // True when this OAuth round-trip completes a connection-specific Investments
  // consent (update mode) rather than a normal connect. Set from localStorage
  // on mount (written by PlaidContext.openInvestmentsConsent before redirect).
  const [isInvestments,   setIsInvestments]    = useState(false);
  const hasOpened = useRef(false);

  // Read the link token and current URL on mount.
  // startTransition avoids the "setState in effect" lint rule — these are
  // non-urgent UI updates that don't need to block the browser paint.
  useEffect(() => {
    const token = localStorage.getItem("plaid_link_token");
    const uri   = window.location.href;
    const mode  = localStorage.getItem("plaid_link_mode");

    startTransition(() => {
      if (!token) {
        setStatus("error");
        setErrorMessage("Link session expired. Please close this tab and try connecting your account again.");
        return;
      }
      setIsInvestments(mode === "investments");
      setLinkToken(token);
      setReceivedUri(uri);
      setStatus("ready");
    });
  }, []);

  const onSuccess = async (public_token: Parameters<PlaidLinkOnSuccess>[0], metadata: Parameters<PlaidLinkOnSuccess>[1]) => {
    setStatus("importing");

    // ── Investments-consent completion (update mode) ──────────────────────────
    // Same access_token — no exchange. Run the existing holdings refresh via the
    // dedicated enable route, then return to Connections. No duplicate Item.
    if (localStorage.getItem("plaid_link_mode") === "investments") {
      const plaidItemId = localStorage.getItem("plaid_investments_item_id") ?? "";
      localStorage.removeItem("plaid_link_token");
      localStorage.removeItem("plaid_link_mode");
      localStorage.removeItem("plaid_investments_item_id");
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
        router.replace("/dashboard/connections");
      } catch (err) {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Failed to enable Investments.");
      }
      return;
    }

    localStorage.removeItem("plaid_link_token");

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

      // Return to dashboard — replace so back button doesn't re-trigger OAuth
      router.replace("/");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to import accounts.");
    }
  };

  const onExit: PlaidLinkOnExit = (err, metadata) => {
    console.group("[Plaid] OAuth onExit");
    console.log("error_type:",      err?.error_type      ?? null);
    console.log("error_code:",      err?.error_code      ?? null);
    console.log("error_message:",   err?.error_message   ?? null);
    console.log("display_message:", err?.display_message      ?? null);
    console.log("request_id:",      metadata?.request_id      ?? null);
    console.log("status:",          metadata?.status           ?? null);
    console.log("link_session_id:", metadata?.link_session_id ?? null);
    console.groupEnd();

    const investmentsMode = localStorage.getItem("plaid_link_mode") === "investments";
    localStorage.removeItem("plaid_link_token");
    localStorage.removeItem("plaid_link_mode");
    localStorage.removeItem("plaid_investments_item_id");

    if (err) {
      setStatus("error");
      setErrorMessage(err.display_message ?? "Connection failed. Please try again from the dashboard.");
    } else if (investmentsMode) {
      // Cancelled Investments consent — non-destructive; back to Connections.
      router.replace("/dashboard/connections");
    } else {
      // User cancelled — send them home
      router.replace("/");
    }
  };

  const { open, ready } = usePlaidLink({
    token:               linkToken ?? "",
    receivedRedirectUri: receivedUri || undefined,
    onSuccess,
    onExit,
  });

  // Auto-open once ready (only once)
  useEffect(() => {
    if (ready && linkToken && receivedUri && !hasOpened.current) {
      hasOpened.current = true;
      open();
    }
  }, [ready, linkToken, receivedUri, open]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="text-center space-y-4 max-w-sm px-6">
        {status === "loading" && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-400" />
            <p className="text-gray-400 text-sm">Preparing your connection…</p>
          </>
        )}

        {status === "ready" && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-400" />
            <p className="text-gray-400 text-sm">Completing bank authentication…</p>
          </>
        )}

        {status === "importing" && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-green-400" />
            <p className="text-gray-300 text-sm font-medium">
              {isInvestments ? "Enabling investments…" : "Importing accounts…"}
            </p>
            <p className="text-gray-500 text-xs">
              {isInvestments ? "Syncing your holdings." : "This only takes a moment."}
            </p>
          </>
        )}

        {status === "error" && (
          <div className="space-y-4">
            <p className="text-red-400 text-sm">{errorMessage}</p>
            <button
              onClick={() => router.replace("/")}
              className="text-blue-400 text-sm underline hover:text-blue-300"
            >
              Return to dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
