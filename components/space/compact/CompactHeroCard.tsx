"use client";

/**
 * components/space/compact/CompactHeroCard.tsx  (v2.7 visual-first cleanup — five-row contract)
 *
 * THE compact (<1024px) header card for Net Worth, Total Assets, Cash,
 * Investments (WealthHero), Total Debt (DebtHero), Cash Flow (CashFlowHero) and
 * Spending (SpendingHero). Every caller renders the
 * SAME five rows with the SAME classes, so identical structure ⇒ identical
 * height — no per-card heights, no spacer hacks:
 *
 *   R1  title (left) · freshness claim (right, truncated) · trust chip
 *   R2  the primary value — one line, never wraps, fluid type
 *   R3  the change ($ and %) — always present: the shared DeltaBadge for
 *       +/−/0, or a muted one-line label when there is nothing to compare
 *   R4  the date range alone on its row (nowrap + truncate, full text in title),
 *       or "As of <date>" when there is no comparison
 *   R5  the existing "Talk with Fourth Meridian about this" link (navigates only);
 *       kept empty at the same height where a perspective has no TalkSection
 *
 * v2.7 mobile/desktop parity — `note`: a perspective's STANDING explanation (Cash
 * Flow / Spending: what the figure counts, and the window the change compares
 * against — both stated beside the desktop headline) renders as one muted line
 * directly UNDER the card, outside the fixed-height section, so the card itself
 * never changes size. It is always present on those perspectives (never
 * conditional on data), so their skeleton is stable too.
 *
 * Exceptional disclosures (withheld details, "Balances are current…", the crypto
 * price basis) are NOT part of the card at all: v2.7 header parity moved them
 * UNDER EACH PAGE'S CHART (HeroNotes), so neither the card nor the page skeleton
 * below it can change height on one perspective only. The whole subtree is
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
  note,
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
  /** R5's conversation link. Absent (no TalkSection for this perspective) ⇒ R5
   *  stays, empty, at its fixed height so the card never changes size. */
  talkSection?: TalkSection;
  talkPeriod?: unknown;
  /** A standing explanation line under the card (outside its fixed height). */
  note?: ReactNode;
}) {
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
          {talkSection && <TalkAboutThis section={talkSection} period={talkPeriod} />}
        </div>
      </section>
      {note && (
        // FIXED three-line box: the note gains "Change vs <window> · " once a
        // comparison exists (e.g. a heatmap period is pinned), which wrapped it one
        // line longer and pushed the Activity controls down 15px on phones. The box
        // never changes height; overflow clamps (full text in the title).
        <p
          className="mt-2 h-[45px] overflow-hidden px-1 text-[11px] leading-[15px] text-[var(--text-muted)] line-clamp-3"
          title={typeof note === "string" ? note : undefined}
          data-compact-hero-note
        >
          {note}
        </p>
      )}
    </div>
  );
}
