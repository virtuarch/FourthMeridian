"use client";

/**
 * components/ui/RouteErrorFallback.tsx  (UI-007)
 *
 * The body every segment `error.tsx` under /dashboard renders. A segment error
 * boundary sits INSIDE its segment's layout, so the dashboard chrome (header,
 * navigation, BottomNav) stays mounted and the customer is never dropped onto
 * the unstyled `app/global-error.tsx` page for a single failed render.
 *
 * Honest and minimal: it says the page failed, never shows `error.message`
 * (a server error's message can carry internals; Next.js redacts it in
 * production anyway), offers the boundary's `reset`, and a way out. The error
 * is reported to Sentry the same way global-error does (no-op when unconfigured).
 */

import * as Sentry from "@sentry/core";
import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";

export interface RouteErrorFallbackProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** What failed, e.g. "this page" / "this platform Space". */
  what?: string;
  /** Where "Go back" leads. */
  backHref?: string;
  backLabel?: string;
}

export function RouteErrorFallback({
  error,
  reset,
  what = "this page",
  backHref = "/dashboard",
  backLabel = "Go to My Space",
}: RouteErrorFallbackProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4 py-12">
      <div
        role="alert"
        data-route-error
        className="w-full max-w-md rounded-2xl border p-8 text-center"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
      >
        <AlertTriangle size={24} aria-hidden className="mx-auto text-[var(--coral-400)]" />
        <h1 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
          Something went wrong loading {what}
        </h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          The error has been logged. Your data is unaffected — try again, or go back.
        </p>
        {error.digest && (
          <p className="mt-2 text-[11px] text-[var(--text-faint)]">Reference: {error.digest}</p>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] px-3.5 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
          >
            <RotateCw size={14} aria-hidden /> Try again
          </button>
          <Link
            href={backHref}
            className="inline-flex items-center rounded-[var(--radius-md)] px-3.5 py-2 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            {backLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * The skeleton every dashboard `loading.tsx` renders INSIDE the chrome while a
 * server segment streams — a hero block and three rows, aria-busy, so a slow
 * RSC render is visibly "loading" rather than a frozen previous page.
 */
export function RouteLoadingSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-route-loading className="mx-auto w-full max-w-[1400px] space-y-6 px-1 py-6">
      <span className="sr-only">{label}</span>
      <div aria-hidden className="h-8 w-48 animate-pulse rounded-[var(--radius-md)] bg-[var(--surface-muted)]" />
      <div aria-hidden className="h-40 w-full animate-pulse rounded-2xl bg-[var(--surface-muted)]" />
      <div aria-hidden className="grid gap-4 lg:grid-cols-3">
        <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-muted)]" />
        <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-muted)]" />
        <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-muted)]" />
      </div>
    </div>
  );
}
