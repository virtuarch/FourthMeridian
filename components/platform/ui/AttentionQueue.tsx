/**
 * components/platform/ui/AttentionQueue.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * The top 3–5 prioritised exceptions: severity dot + WORD, the subject, a
 * one-line why, one next action (a link), and "View all (n)" doorways. The
 * caller orders and selects the items (its authority decides priority); this
 * renders at most `limit` of them, and only `mobileLimit` below `sm`.
 *
 * States are explicit and honest: `loading` says so; an `empty` queue is only
 * claimed by the caller when every source answered; `notes` carry the sources
 * that could not be read ("… unavailable"), never folded into "nothing to do".
 */

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Surface } from "@/components/atlas/Surface";
import { ToneBadge, type StatusTone } from "@/components/platform/platform-surface";

export interface AttentionQueueItem {
  key: string;
  severity: { word: string; tone: StatusTone };
  /** The subject (a connection, a job, an incident title). */
  title: string;
  /** One line: why it needs attention. */
  why: string;
  /** Short context ("Customer Success · 2 h ago"). */
  meta?: string;
  /** The ONE next action. */
  action: { label: string; href: string };
}

export interface AttentionViewAll {
  key: string;
  label: string;
  href: string;
  /** Total behind the doorway; a floor is worded by the caller ("≥50"). */
  count: string;
}

export function AttentionQueue({
  title = "Needs attention",
  items,
  limit = 5,
  mobileLimit = 3,
  loading = false,
  emptyText,
  viewAll = [],
  notes = [],
}: {
  title?: string;
  items: readonly AttentionQueueItem[];
  limit?: number;
  mobileLimit?: number;
  loading?: boolean;
  /** Shown when there are no items AND the caller vouches every source answered. */
  emptyText?: string | null;
  viewAll?: readonly AttentionViewAll[];
  notes?: readonly string[];
}) {
  const shown = items.slice(0, limit);
  return (
    <Surface as="section" className="flex flex-col gap-3 p-4 sm:p-5">
      <h2 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h2>
      {shown.length > 0 ? (
        <ul className="flex flex-col divide-y divide-[var(--border-hairline)]">
          {shown.map((it, i) => (
            <li key={it.key} className={i >= mobileLimit ? "max-sm:hidden" : undefined}>
              <Link
                href={it.action.href}
                prefetch={false}
                className="group flex min-h-11 items-start gap-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
              >
                <span className="mt-0.5 w-[68px] shrink-0"><ToneBadge word={it.severity.word} tone={it.severity.tone} /></span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-[var(--text-primary)]">{it.title}</span>
                  <span className="line-clamp-2 text-xs text-[var(--text-secondary)]">{it.why}</span>
                  {it.meta && <span className="truncate text-[11px] text-[var(--text-muted)]">{it.meta}</span>}
                </span>
                <span className="mt-0.5 hidden shrink-0 text-[11px] text-[var(--text-muted)] group-hover:text-[var(--text-primary)] sm:inline">{it.action.label}</span>
                <ChevronRight size={14} aria-hidden className="mt-1 shrink-0 text-[var(--text-muted)]" />
              </Link>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <p role="status" className="text-xs text-[var(--text-muted)]">Reading…</p>
      ) : emptyText ? (
        <p className="text-sm text-[var(--text-secondary)]">{emptyText}</p>
      ) : null}
      {notes.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {notes.map((n) => <li key={n} role="status" className="text-[11px] text-[var(--text-muted)]">{n}</li>)}
        </ul>
      )}
      {viewAll.length > 0 && (
        <nav aria-label="View all" className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border-hairline)] pt-2">
          {viewAll.map((v) => (
            <Link
              key={v.key}
              href={v.href}
              prefetch={false}
              className="inline-flex min-h-11 items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] sm:min-h-8"
            >
              View all in {v.label} ({v.count})
            </Link>
          ))}
        </nav>
      )}
    </Surface>
  );
}
