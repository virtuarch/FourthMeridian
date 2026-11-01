/**
 * components/platform/ui/KpiTile.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * value · change vs prior period (only when the caller can compute it) · a tiny
 * trend (only from a persisted series — MiniBars, gaps stay gaps) · a provenance
 * chip. When `href` is given the whole tile is ONE link (≥ 44 px, visible focus)
 * into the Space that holds the evidence. A null value renders an em-dash plus
 * the reason, never a zero.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { MiniBars, TONE_COLOR, type MiniBarPoint, type StatusTone } from "@/components/platform/platform-surface";

export interface KpiTileProps {
  label: string;
  /** The figure, already formatted; null ⇒ unavailable (see `unavailableReason`). */
  value: string | null;
  unavailableReason?: string;
  /** Change vs the prior period, already worded ("+3 vs prior 14 d"). */
  change?: { text: string; tone?: StatusTone } | null;
  /** A persisted day series; empty ⇒ no chart. */
  points?: readonly MiniBarPoint[];
  format?: (n: number) => string;
  /** The series' caption ("UTC days · last 14"). */
  caption?: ReactNode;
  /** A ProvenanceChip (or nothing while loading). */
  provenance?: ReactNode;
  /** One quiet line under the figure (a floor, a window). */
  note?: string;
  href?: string;
  /** The accessible name of the doorway, e.g. "Open Platform Operations". */
  hrefLabel?: string;
}

const plain = (n: number) => n.toLocaleString("en-US");

export function KpiTile({ label, value, unavailableReason, change, points = [], format = plain, caption, provenance, note, href, hrefLabel }: KpiTileProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
        {provenance}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {value === null ? (
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold leading-none text-[var(--text-muted)]">—</span>
            <span className="text-[11px] text-[var(--text-faint)]">{unavailableReason ?? "unavailable"}</span>
          </span>
        ) : (
          <span className="text-2xl font-semibold leading-none tracking-tight tabular-nums text-[var(--text-primary)]">{value}</span>
        )}
        {change && (
          <span className="text-[11px] tabular-nums" style={{ color: change.tone ? TONE_COLOR[change.tone] : "var(--text-muted)" }}>
            {change.text}
          </span>
        )}
      </div>
      {note && <span className="text-[11px] leading-snug text-[var(--text-muted)]">{note}</span>}
      {points.length > 0 && <MiniBars label={`${label} per day`} points={points} format={format} caption={caption} height={28} />}
    </>
  );
  const frame = "flex h-full min-h-11 min-w-0 flex-col gap-2.5 rounded-[var(--radius-lg)] border border-[var(--border-hairline)] p-3 sm:p-4";
  const style = { background: "var(--surface-inset)" };
  if (!href) return <div className={frame} style={style}>{body}</div>;
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={hrefLabel ? `${label} — ${hrefLabel}` : undefined}
      className={`${frame} transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:border-[var(--border-hairline-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]`}
      style={style}
    >
      {body}
    </Link>
  );
}
