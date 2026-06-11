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
import { usePlaidLink, PlaidLinkOnSuccess } from "react-plaid-link";
import { useRouter } from "next/navigation";

interface PlaidContextValue {
  openLink:  (onDone?: () => void) => void;
  isLoading: boolean;
  error:     string;
  clearError: () => void;
}

const PlaidContext = createContext<PlaidContextValue>({
  openLink:   () => {},
  isLoading:  false,
  error:      "",
  clearError: () => {},
});

export function PlaidProvider({ children }: { children: React.ReactNode }) {
  const router     = useRouter();
  const onDoneRef  = useRef<(() => void) | undefined>(undefined);

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [fetching,  setFetching]  = useState(false);
  const [importing, setImporting] = useState(false);
  const [error,     setError]     = useState("");

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token, metadata) => {
      setImporting(true);
      setError("");
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
        router.refresh();
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

  const { open, ready } = usePlaidLink({
    token:    linkToken ?? "",
    onSuccess,
    onExit:   () => {
      setLinkToken(null);
      setFetching(false);
      onDoneRef.current = undefined;
    },
  });

  // Auto-open as soon as token arrives and Plaid is ready
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const openLink = useCallback(async (onDone?: () => void) => {
    setError("");
    setFetching(true);
    onDoneRef.current = onDone;
    try {
      const res  = await fetch("/api/plaid/link-token");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start Plaid Link.");
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
        clearError: () => setError(""),
      }}
    >
      {children}
    </PlaidContext.Provider>
  );
}

export function usePlaid() {
  return useContext(PlaidContext);
}
