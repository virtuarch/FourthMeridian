/**
 * components/ai/GuidanceNote.tsx  (advice-boundary slice)
 *
 * The CONTEXTUAL disclosure beside one answer. It is drawn from a plan the
 * orchestrator computes (lib/ai/conversation/guidance.ts `disclosurePlan`) from
 * each answer's label; this component only says it.
 *
 *   FULL     — the note, the first time a conversation reaches a tier (and again
 *              for a subject it has not yet spoken to).
 *   COMPACT  — one line, on every later consequential answer, so a follow-up
 *              keeps the boundary without repeating the paragraph.
 *
 * ⚠️ BESIDE THE ANSWER, NEVER OVER IT. Rendered after the prose in the answer's
 * extras slot, at small type, with no dismiss state and nothing that hides or
 * collapses the answer.
 *
 * ⚠️ THE MODEL NEVER WRITES THIS. Copy is fixed here, keyed by tier and subject;
 * the model's only contribution is the label the plan was computed from.
 *
 * Presentation only.
 */

import { Info } from "lucide-react";
import type { AiGuidanceAdjacency } from "@/types";

export interface GuidanceNoteProps {
  tier: "STANDARD" | "HEIGHTENED";
  form: "FULL" | "COMPACT";
  adjacencies: readonly AiGuidanceAdjacency[];
}

export const GUIDANCE_NOTE_STANDARD =
  "This is AI-generated planning guidance based on the data connected to this Space, not advice from a licensed financial adviser. Check the figures and assumptions above before you act on it.";

export const GUIDANCE_NOTE_COMPACT = "AI-generated planning guidance · not licensed financial advice";

/** What the product adds for a subject. One sentence each; the set is closed. */
export const GUIDANCE_NOTE_ADJACENCY: Record<AiGuidanceAdjacency, string> = {
  SECURITIES: "Fourth Meridian doesn't select securities or funds for you, and no market research stands behind this answer.",
  TAX: "Tax consequences depend on details Fourth Meridian can't see; a tax professional can confirm them.",
  LEGAL: "Legal questions turn on facts and rules Fourth Meridian can't assess; an attorney can confirm them.",
  RETIREMENT_ACCOUNTS: "Withdrawals or loans from retirement accounts can carry taxes and penalties this answer may not capture.",
  LEVERAGE: "Borrowing to invest magnifies losses as well as gains.",
};

export function GuidanceNote({ tier, form, adjacencies }: GuidanceNoteProps) {
  if (form === "COMPACT") {
    return (
      <p data-guidance-note="compact" data-guidance-tier={tier} role="note"
        className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
        <Info size={11} aria-hidden className="shrink-0" />
        {GUIDANCE_NOTE_COMPACT}
      </p>
    );
  }
  const extra = tier === "HEIGHTENED" ? adjacencies.map((a) => GUIDANCE_NOTE_ADJACENCY[a]) : [];
  return (
    <aside data-guidance-note="full" data-guidance-tier={tier} role="note" aria-label="About this answer"
      className="flex gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed"
      style={{ borderColor: "var(--border-hairline)", color: "var(--text-muted)" }}>
      <Info size={13} aria-hidden className="mt-0.5 shrink-0" />
      <p>{[GUIDANCE_NOTE_STANDARD, ...extra].join(" ")}</p>
    </aside>
  );
}
