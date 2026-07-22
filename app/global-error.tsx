"use client";

/**
 * app/global-error.tsx  (V25-FINAL-2 — Area A)
 *
 * The App Router GLOBAL error boundary — Next.js renders it when an error escapes
 * the root layout (the last-resort client crash surface). It reports the error to
 * Sentry (no-op when the SDK is unconfigured) and renders a minimal, honest
 * fallback. Financial data is never placed in the UI or the report; the shared
 * scrubber (lib/monitoring/sentry-options.ts) strips residual request payloads.
 *
 * Must render its own <html>/<body> because it replaces the root layout.
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ color: "#666", marginTop: "0.5rem" }}>
          An unexpected error occurred. The issue has been logged. You can try again.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            marginTop: "1rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid #ccc",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
