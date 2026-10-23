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
 *   - UtcStamp / fmtUtc    (UI-009) the ABSOLUTE UTC instant beside relative ages
 *
 * Deliberately NO customer-axis machinery — widgets only fetch their own
 * platform data route (gated by requirePlatformAccess) and render JSON. This
 * file lives under components/, outside the platform-surface source-scan roots,
 * but is kept axis-clean anyway.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2, AlertTriangle } from "lucide-react";
import { Block, Surface, Figure } from "@/components/atlas/Surface";

/** The section shape the host (PlatformSpaceDashboard) hands each widget. */
export type PlatformSection = { id: string; key: string; label: string };

/**
 * Self-fetch a platform read route. Same-origin so the session cookie rides
 * along; the route's own requirePlatformAccess gate is the authority. Aborts
 * cleanly on unmount so a slow response never sets state on a torn-down widget.
 *
 * CONTRACT — `url` is static for the lifetime of a mounted widget. Every call
 * site passes a string literal, which is what lets the effect below fetch
 * without first resetting `loading`/`error`: they are already `true`/`null` from
 * the initial state, and no second run can occur. A dynamic `url` would break
 * that (the widget would show the previous route's data as if it were current),
 * so the invariant is enforced by widget-fetch-static-url.test.ts rather than
 * left to a comment. Give a widget a changing url only by remounting it with a
 * React `key`, which resets this state honestly.
 */
export function useWidgetFetch<T>(url: string): {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** UI-009 — ISO instant the response landed (null until then): the anchor every
   *  relative age in the widget was computed against, for a UtcStamp. */
  fetchedAt: string | null;
} {
  const [data, setData]       = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
        return (await r.json()) as T;
      })
      .then((j) => {
        if (!alive) return;
        setData(j);
        setFetchedAt(new Date().toISOString());
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

  return { data, loading, error, fetchedAt };
}

/**
 * UI-009 — an ISO instant as an absolute UTC wall-clock string,
 * "2026-10-22 14:03:12 UTC". Pure; "—" on an unparseable value. Relative ages
 * ("3m") are computed once and never tick, so an open tab would show "3m" for
 * hours; the absolute instant beside them is what makes a stale tab visible.
 */
export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return `${new Date(t).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * UI-009 — "<label> 2026-10-22 14:03:12 UTC" as a <time> element. Render it
 * beside any relative age (or once per card — see PlatformWidgetCard).
 */
export function UtcStamp({ iso, label = "Checked" }: { iso: string | null | undefined; label?: string }) {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return (
    <span className="text-[10px] tabular-nums text-[var(--text-faint)]" data-utc-stamp>
      {label} <time dateTime={iso}>{fmtUtc(iso)}</time>
    </span>
  );
}

/** A relative age with its absolute UTC instant as the tooltip and beside it:
 *  "3m ago · 2026-10-22 14:03:12 UTC". */
export function AgeWithUtc({ iso }: { iso: string | null | undefined }) {
  if (!iso || Number.isNaN(Date.parse(iso))) return <span>—</span>;
  return (
    <span>
      {timeAgo(iso)} ago <span className="text-[var(--text-faint)]">· <time dateTime={iso}>{fmtUtc(iso)}</time></span>
    </span>
  );
}

/**
 * PO-2 — the editorial section shell every platform widget renders through. It
 * composes the SAME Atlas read-surface language customer Spaces use: an Atlas
 * `Block` (the quiet uppercase eyebrow — "the label found once, then ignored")
 * with a `Surface` carrying the widget's content. The old bordered dashboard
 * card (icon badge + bold title) is gone — a stack of these Blocks reads as an
 * editorial workspace, not a grid of isolated metric cards.
 *
 * The `icon` is kept as a FAINT marker in the Block's hint slot (a scanning aid
 * on a dense operational surface), never the loud badge it was. Signature is
 * unchanged, so no widget call site changes.
 */
export function PlatformWidgetCard({
  label,
  icon: Icon,
  children,
  checkedAt,
}: {
  label:    string;
  icon:     LucideIcon;
  children: ReactNode;
  /**
   * UI-009 — the payload's own `checkedAt` when the widget has one. Absent ⇒ the
   * instant this card mounted in the browser (≈ when its data was fetched and its
   * relative ages were computed). Either way the card header states an ABSOLUTE
   * UTC instant, so a tab left open shows how old its "3m ago" really is.
   */
  checkedAt?: string | null;
}) {
  // Client-only: set after mount (never during SSR) so server and client markup
  // agree; a rAF keeps the setState out of the effect body.
  const [mountedAt, setMountedAt] = useState<string | null>(null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMountedAt(new Date().toISOString()));
    return () => cancelAnimationFrame(raf);
  }, []);
  const stampIso = checkedAt ?? mountedAt;
  return (
    <Block
      label={label}
      hint={<Icon size={12} aria-hidden className="text-[var(--text-faint)]" />}
      action={stampIso ? <UtcStamp iso={stampIso} label={checkedAt ? "Checked" : "Loaded"} /> : undefined}
    >
      <Surface className="min-w-0 p-4 md:p-5 flex flex-col gap-3">{children}</Surface>
    </Block>
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
  // UX-P1 — live regions: the loading→error→empty transitions were silent to
  // assistive technology across ~29 widgets. `status` is polite (loading/empty),
  // `alert` is assertive (error). Icons are decorative; the text is the content.
  if (loading) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
        <Loader2 size={12} className="animate-spin" aria-hidden /> Loading…
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="flex items-center gap-1.5 text-xs" style={{ color: "var(--coral-400)" }}>
        <AlertTriangle size={12} aria-hidden /> {error}
      </p>
    );
  }
  return <p role="status" className="text-xs text-[var(--text-secondary)]">{empty ?? "Nothing to show."}</p>;
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

/** A single operational figure — the platform reading of the Atlas `Figure`
 *  primitive (tabular, no brand tone: a number's colour is a claim). Used across
 *  the summary widgets so every platform metric renders in the same editorial
 *  type as customer-Space figures. */
export function WidgetStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 break-words">
      <Figure value={value} size="figure" />
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}
