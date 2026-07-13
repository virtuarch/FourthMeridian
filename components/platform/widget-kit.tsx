"use client";

/**
 * components/platform/widget-kit.tsx
 *
 * PO1.1/PO1.2 — the small shared kit every platform widget is built from, so
 * the six widgets stay thin and visually consistent with the PO1.0
 * PlaceholderCard they replace:
 *   - PlatformSection      the (id/key/label) shape the host passes each widget
 *   - useWidgetFetch<T>    self-fetch hook (same-origin GET, {data,loading,error})
 *   - PlatformWidgetCard   the card shell (header icon + label, muted surface)
 *   - WidgetMessage        the loading / error / empty single-line states
 *
 * Deliberately NO customer-axis machinery — widgets only fetch their own
 * platform data route (gated by requirePlatformAccess) and render JSON. This
 * file lives under components/, outside the platform-surface source-scan roots,
 * but is kept axis-clean anyway.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2, AlertTriangle } from "lucide-react";

/** The section shape the host (PlatformSpaceDashboard) hands each widget. */
export type PlatformSection = { id: string; key: string; label: string };

/**
 * Self-fetch a platform read route. Same-origin so the session cookie rides
 * along; the route's own requirePlatformAccess gate is the authority. Aborts
 * cleanly on unmount / url change so a slow response never sets state on a
 * torn-down widget.
 */
export function useWidgetFetch<T>(url: string): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData]       = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
        return (await r.json()) as T;
      })
      .then((j) => {
        if (!alive) return;
        setData(j);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to load");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  return { data, loading, error };
}

/** The card shell — mirrors PlaceholderCard's surface so widgets sit flush with
 *  any still-placeholder cards on the same grid. */
export function PlatformWidgetCard({
  label,
  icon: Icon,
  children,
}: {
  label:    string;
  icon:     LucideIcon;
  children: ReactNode;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-[var(--radius-lg)] border p-5 flex flex-col gap-3"
      style={{ background: "var(--surface-muted)", borderColor: "var(--border-hairline)" }}
    >
      <div className="flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
          style={{ background: "var(--glass-ultrathin)", color: "var(--text-muted)" }}
        >
          <Icon size={14} />
        </div>
        <p className="font-semibold text-[var(--text-primary)] text-sm">{label}</p>
      </div>
      {children}
    </div>
  );
}

/** The loading / error / empty single-line state, shown when a widget has no
 *  data to render. Exactly one of loading/error/empty is meaningful. */
export function WidgetMessage({
  loading,
  error,
  empty,
}: {
  loading?: boolean;
  error?:   string | null;
  empty?:   string;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
        <Loader2 size={12} className="animate-spin" /> Loading…
      </p>
    );
  }
  if (error) {
    return (
      <p className="flex items-center gap-1.5 text-xs" style={{ color: "var(--danger-400, #f87171)" }}>
        <AlertTriangle size={12} /> {error}
      </p>
    );
  }
  return <p className="text-xs text-[var(--text-secondary)]">{empty ?? "Nothing to show."}</p>;
}

/** Compact relative time ("3m", "2h", "5d") from an ISO timestamp. Pure; falls
 *  back to "—" on an unparseable value. Client-only (uses Date.now). */
export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Small stat used across the summary widgets. */
export function WidgetStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xl font-semibold text-[var(--text-primary)] tabular-nums">{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}
