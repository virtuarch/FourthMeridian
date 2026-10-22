"use client";

/**
 * components/space/SpaceReadFailure.tsx  (UI-006)
 *
 * The ONE way a customer Space says "this read failed". A failed read is not an
 * empty Space: an outage used to render "No wealth history yet" / "No accounts"
 * and look like a brand-new account. This states the failure in words, keeps it
 * distinct from every empty state, and offers Retry.
 *
 *   variant="card"   — replaces the content the failed read would have produced
 *   variant="inline" — a one-line notice above STALE content (an earlier read
 *                      succeeded, a later refresh failed)
 *
 * role="alert" so the transition is announced; the icon is decorative.
 */

import { AlertTriangle, RotateCw } from "lucide-react";

export function SpaceReadFailure({
  what,
  message,
  onRetry,
  variant = "card",
}: {
  /** What could not be loaded, e.g. "wealth history". */
  what:     string;
  /** The SpaceReadError sentence (status-specific). */
  message:  string;
  onRetry?: () => void;
  variant?: "card" | "inline";
}) {
  const retry = onRetry ? (
    <button
      type="button"
      onClick={onRetry}
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs font-medium text-[var(--meridian-400)] transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
    >
      <RotateCw size={12} aria-hidden /> Retry
    </button>
  ) : null;

  if (variant === "inline") {
    return (
      <div
        role="alert"
        data-space-read-failure="inline"
        className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs"
        style={{ borderColor: "rgba(237,82,71,.3)", background: "rgba(237,82,71,.06)" }}
      >
        <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
          <AlertTriangle size={12} aria-hidden className="text-[var(--coral-400)]" />
          Couldn&rsquo;t refresh {what} — showing what was last loaded. {message}
        </span>
        {retry}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-space-read-failure="card"
      className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-2xl border p-8 text-center"
      style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
    >
      <AlertTriangle size={22} aria-hidden className="text-[var(--coral-400)]" />
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Couldn&rsquo;t load {what}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{message}</p>
      </div>
      {retry}
    </div>
  );
}
