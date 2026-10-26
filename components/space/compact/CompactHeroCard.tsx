"use client";

/**
 * components/space/compact/CompactHeroCard.tsx  (v2.7 visual-first cleanup — five-row contract)
 *
 * THE compact (<1024px) header card for Net Worth, Total Assets, Cash,
 * Investments (WealthHero) and Total Debt (DebtHero). Every caller renders the
 * SAME five rows with the SAME classes, so identical structure ⇒ identical
 * height — no per-card heights, no spacer hacks:
 *
 *   R1  title (left) · freshness claim (right, truncated) · trust chip
 *   R2  the primary value — one line, never wraps, fluid type
 *   R3  the change ($ and %) — always present: the shared DeltaBadge for
 *       +/−/0, or a muted one-line label when there is nothing to compare
 *   R4  the date range alone on its row (nowrap + truncate, full text in title),
 *       or "As of <date>" when there is no comparison
 *   R5  the existing "Talk with Fourth Meridian about this" link (navigates only)
 *
 * Exceptional disclosures (withheld details, "Balances are current…", the crypto
 * price basis) are NOT rows: they render as a visible compact note directly
 * BELOW the card, so the five rows never change. The whole subtree is
 * `lg:hidden` — at ≥1024px the callers render their desktop hero instead.
 *
 * Presentation only: every figure and label arrives formatted from the caller.
 */

import type { ReactNode } from "react";
import { COMPACT_HERO } from "./compact-hero";
import { DeltaBadge } from "@/components/space/widgets/wealth/wealth-ui";
import { TalkAboutThis } from "@/components/ai/TalkAboutThis";
import type { TalkSection } from "@/components/ai/talk-about-this";

/** The row classes — one list per row, shared by every caller. */
export const COMPACT_HERO_ROWS = [
  "flex h-6 min-w-0 items-center gap-2",
  "flex h-12 min-w-0 items-center",
  "flex h-6 min-w-0 items-center",
  "flex h-5 min-w-0 items-center",
  "flex h-10 min-w-0 items-center",
] as const;

export const NO_COMPARISON_LABEL = "No comparison selected";

export interface CompactHeroChange {
  abs: number;
  pct: number | null;
  goodDirection: "up" | "down";
}

export function CompactHeroCard({
  title,
  freshness,
  trust,
  value,
  valueTone = "neutral",
  change,
  noChangeLabel = NO_COMPARISON_LABEL,
  range,
  currency,
  talkSection,
  talkPeriod,
  notes = [],
}: {
  title: string;
  /** The canonical freshness claim ("Last checked 2 hr ago"), or null. */
  freshness: string | null;
  /** The caller's trust chip (TrustIndicator compact — silent on the clean tier). */
  trust: ReactNode;
  /** The headline, already formatted. */
  value: string;
  /** Debt reads in the negative accent; colour only (the classes never differ). */
  valueTone?: "neutral" | "negative";
  /** The change, or null when there is nothing to compare. */
  change: CompactHeroChange | null;
  /** R3 text when `change` is null. */
  noChangeLabel?: string;
  /** R4: "Sep 26, 2026 → Oct 16, 2026", or "As of Oct 16, 2026". */
  range: string;
  currency: string;
  talkSection: TalkSection;
  talkPeriod?: unknown;
  /** Exceptional disclosures — rendered below the card, never inside it. */
  notes?: ReactNode[];
}) {
  const shownNotes = notes.filter(Boolean);
  return (
    <div className="lg:hidden" data-compact-hero-wrap>
      <section
        data-compact-hero
        className={`lg:hidden grid grid-rows-[auto_auto_auto_auto_auto] gap-1 ${COMPACT_HERO}`}
      >
        <div data-compact-hero-row="1" className={COMPACT_HERO_ROWS[0]}>
          <p className="shrink-0 whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{title}</p>
          <span className="ml-auto min-w-0 truncate text-[11px] text-[var(--text-muted)]" title={freshness ?? undefined} data-compact-hero-freshness>
            {freshness ?? ""}
          </span>
          <span className="flex shrink-0 items-center overflow-hidden p-0.5">{trust}</span>
        </div>
        <div data-compact-hero-row="2" className={COMPACT_HERO_ROWS[1]}>
          <p
            className="min-w-0 overflow-hidden whitespace-nowrap text-[clamp(28px,9vw,40px)] font-semibold leading-tight tracking-tight tabular-nums"
            style={{ color: valueTone === "negative" ? "var(--accent-negative)" : "var(--text-primary)" }}
          >
            {value}
          </p>
        </div>
        <div data-compact-hero-row="3" className={COMPACT_HERO_ROWS[2]}>
          {change ? (
            <DeltaBadge
              abs={change.abs}
              pct={change.pct}
              currency={currency}
              goodDirection={change.goodDirection}
              className="whitespace-nowrap !text-[14px] font-medium leading-6"
            />
          ) : (
            <p className="truncate text-[12px] leading-6 text-[var(--text-muted)]">{noChangeLabel}</p>
          )}
        </div>
        <div data-compact-hero-row="4" className={COMPACT_HERO_ROWS[3]}>
          <p className="min-w-0 truncate whitespace-nowrap text-[12px] leading-5 tabular-nums text-[var(--text-muted)]" title={range}>
            {range}
          </p>
        </div>
        <div data-compact-hero-row="5" className={COMPACT_HERO_ROWS[4]}>
          <TalkAboutThis section={talkSection} period={talkPeriod} />
        </div>
      </section>
      {shownNotes.length > 0 && (
        <div className="lg:hidden mt-2 space-y-0.5 px-1 text-[11px] leading-snug text-[var(--text-muted)]" data-compact-hero-notes>
          {shownNotes.map((n, i) => <p key={i}>{n}</p>)}
        </div>
      )}
    </div>
  );
}
