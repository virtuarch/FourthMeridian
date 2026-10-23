/**
 * components/ai/SuggestedPrompt.tsx  (AI Experience Convergence — AI-1, AI-3)
 *
 * A suggested prompt in two presentations: a quiet rounded "chip" for the empty-state
 * starters beneath the centered composer, and a light "row" (corner-arrow glyph) for
 * in-answer follow-ups. Presentation only — it calls back `onSelect`; the
 * orchestrator decides what asking it means.
 */

import { CornerDownRight } from "lucide-react";

export function SuggestedPrompt({
  label,
  onSelect,
  variant = "chip",
}: {
  label: string;
  onSelect: () => void;
  variant?: "chip" | "row";
}) {
  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-2 w-full text-left text-sm py-1.5 transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <CornerDownRight size={13} className="shrink-0" style={{ color: "var(--text-faint)" }} />
        <span className="min-w-0">{label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      className="rounded-full border border-[var(--border-hairline)] px-3.5 py-1.5 text-[13px] transition-colors text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
    >
      {label}
    </button>
  );
}
