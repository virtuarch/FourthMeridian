/**
 * components/space/hero/HeroParts.tsx  (v2.7 — one header skeleton)
 *
 * The pieces Net Worth, Assets and Debt share so switching perspectives swaps
 * CONTENT inside a stable structure instead of re-laying the page out:
 *
 *   HeroEyebrow — the desktop label row: metric label (left) + the trust chip
 *     (right) in a FIXED-height row (h-6). The chip (TrustIndicator compact) is
 *     silent on the clean tier and a ~22px pill when a tier is noteworthy
 *     ("Estimated", "Reconstructed"); a content-sized row grew the header by the
 *     pill's height whenever it appeared. Fixed height ⇒ identical geometry with
 *     or without it. The chip stays: it is the ONLY surface that states the
 *     figure's confidence tier (ShellTrustRow renders orthogonal warnings only).
 *
 *   HeroNotes — exceptional disclosures that qualify the headline (Debt's
 *     "balances are current" in a past As-Of, withheld details, the crypto price
 *     basis). They render UNDER THE CHART, never below the header card, so a
 *     note can never push the page skeleton down on one perspective only.
 *
 *   HeroTalk — the desktop hero's last line: "Talk with Fourth Meridian about
 *     this" (v2.7 mobile/desktop parity). The compact card states the SAME link
 *     on its row 5; every perspective with a TalkSection offers it at every width.
 *
 * Presentation only.
 */

import type { ReactNode } from "react";
import { TalkAboutThis } from "@/components/ai/TalkAboutThis";
import type { TalkSection } from "@/components/ai/talk-about-this";

export function HeroEyebrow({ label, trust }: { label: ReactNode; trust?: ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-between gap-3" data-hero-eyebrow>
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      {trust}
    </div>
  );
}

export function HeroTalk({ section, period }: { section: TalkSection; period?: unknown }) {
  return (
    <div className="mt-3" data-hero-talk={section}>
      <TalkAboutThis section={section} period={period} />
    </div>
  );
}

export function HeroNotes({ notes, className = "" }: { notes: (ReactNode | null | undefined | false)[]; className?: string }) {
  const shown = notes.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div className={`mt-2 space-y-0.5 px-1 text-[11px] leading-snug text-[var(--text-muted)] ${className}`.trim()} data-hero-notes>
      {shown.map((n, i) => <p key={i}>{n}</p>)}
    </div>
  );
}
