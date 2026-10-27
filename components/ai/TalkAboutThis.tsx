/**
 * components/ai/TalkAboutThis.tsx  (v2.7 R6 — contextual AI entry, option A / D-8)
 *
 * A quiet text link from a dashboard view to the Analyze conversation, carrying
 * only the view's topic and relative window (talk-about-this.ts). It navigates;
 * it never sends. The Analyze page turns the topic into a suggested chip that the
 * user may click — or ignore.
 *
 * Presentation is the caller's. v2.7 mobile/desktop parity — every dashboard hero
 * whose perspective has a TalkSection mounts it in BOTH layouts: row 5 of the
 * compact card (<lg) and the last line of the desktop hero (≥lg). It used to be
 * compact-only, so desktop had no contextual AI entry at all.
 */

import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { talkAboutHref, type TalkSection } from "./talk-about-this";

export const TALK_ABOUT_THIS_LABEL = "Talk with Fourth Meridian about this";

export function TalkAboutThis({
  section,
  period,
}: {
  section: TalkSection;
  /** The view's time state; kept only when it is an allowlisted relative preset. */
  period?: unknown;
}) {
  return (
    <Link
      href={talkAboutHref(section, period)}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-1 -mx-1 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
    >
      <MessageCircle size={14} aria-hidden />
      <span>{TALK_ABOUT_THIS_LABEL}</span>
    </Link>
  );
}
