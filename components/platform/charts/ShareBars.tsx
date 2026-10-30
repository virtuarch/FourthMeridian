"use client";

/**
 * components/platform/charts/ShareBars.tsx  (Platform Spaces 2.0 — "share of a stated whole")
 *
 * Horizontal bars where each bar is a count's share of an EXPLICIT denominator
 * the caller names (accounts, requesters) — not of the bars' own sum. That is
 * the difference from BreakdownWidget's bar mode (share of total), which would
 * misstate adoption (several features per account) or a partial population.
 * A null share (no denominator) draws no bar and reads "—". Domain-free.
 */

export interface ShareBar {
  key: string;
  label: string;
  count: number;
  /** count ÷ the stated denominator; null = no denominator. */
  share: number | null;
  /** Muted bar (e.g. "No source recorded"). */
  muted?: boolean;
}

const n = (v: number) => v.toLocaleString("en-US");
/** A tiny non-zero share never reads "0%" beside a visible bar. */
const pctText = (share: number, count: number) => (count > 0 && Math.round(share * 100) === 0 ? "<1%" : `${Math.round(share * 100)}%`);

export function ShareBars({ items, ariaLabel, noun, denominator }: {
  items: readonly ShareBar[];
  ariaLabel: string;
  /** Singular noun for the count ("account"). */
  noun: string;
  /** The whole the shares are of, in words ("of 11 accounts"). */
  denominator: string;
}) {
  return (
    <div className="min-w-0" data-share-bars>
    <ul aria-label={ariaLabel} className="flex min-w-0 flex-col gap-2.5">
      {items.map((i) => (
        <li key={i.key} className="min-w-0">
          <span className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-[var(--text-primary)]">{i.label}</span>
            <span className="shrink-0 text-xs tabular-nums">
              <span className="font-medium text-[var(--text-primary)]">{i.share === null ? "—" : pctText(i.share, i.count)}</span>
              <span className="ml-1.5 text-[11px] text-[var(--text-muted)]">{`${n(i.count)} ${i.count === 1 ? noun : `${noun}s`}`}</span>
            </span>
          </span>
          <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text-muted)_10%,transparent)]">
            {i.share !== null && (
              <span className="block h-full rounded-full"
                style={{ width: `${Math.max(i.count > 0 ? 2 : 0, Math.min(100, i.share * 100))}%`, background: i.muted ? "var(--text-faint)" : "color-mix(in srgb, var(--meridian-400) 75%, transparent)" }} />
            )}
          </span>
        </li>
      ))}
    </ul>
    <p className="mt-2.5 text-[10px] text-[var(--text-muted)]">{`Shares are ${denominator}`}</p>
    </div>
  );
}
