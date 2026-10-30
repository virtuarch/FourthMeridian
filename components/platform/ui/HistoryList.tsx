/**
 * components/platform/ui/HistoryList.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * Compact audit / history rows — when (absolute UTC), what, who — capped at
 * `limit` (default 5), with a "View full history" doorway (a link, or a button
 * that opens a DetailDrawer). An empty list says so in words, never blank.
 */

import Link from "next/link";
import { utcClock } from "./ProvenanceChip";

export interface HistoryEntry {
  key: string;
  /** ISO instant. */
  at: string;
  title: string;
  detail?: string;
  actor?: string;
}

function dayAndClock(iso: string): string {
  const clock = utcClock(iso);
  return clock ? `${iso.slice(0, 10)} ${clock}` : "—";
}

export function HistoryList({
  title = "History",
  entries,
  limit = 5,
  emptyText = "Nothing recorded yet.",
  fullHref,
  onViewAll,
}: {
  title?: string;
  entries: readonly HistoryEntry[];
  limit?: number;
  emptyText?: string;
  fullHref?: string;
  onViewAll?: () => void;
}) {
  const shown = entries.slice(0, limit);
  const more = entries.length > shown.length || Boolean(fullHref) || Boolean(onViewAll);
  const doorway = "inline-flex min-h-11 items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h3>
      {shown.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{emptyText}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-[var(--border-hairline)]">
          {shown.map((e) => (
            <li key={e.key} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-3">
              <time dateTime={e.at} className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{dayAndClock(e.at)}</time>
              <span className="min-w-0 flex-1 text-xs text-[var(--text-primary)]">
                {e.title}
                {e.detail && <span className="text-[var(--text-secondary)]"> — {e.detail}</span>}
              </span>
              {e.actor && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{e.actor}</span>}
            </li>
          ))}
        </ol>
      )}
      {more && fullHref && <Link href={fullHref} prefetch={false} className={doorway}>View full history</Link>}
      {more && !fullHref && onViewAll && <button type="button" onClick={onViewAll} className={doorway}>View full history</button>}
    </section>
  );
}
