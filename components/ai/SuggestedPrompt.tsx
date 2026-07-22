/**
 * components/ai/SuggestedPrompt.tsx  (AI Experience Convergence — AI-1)
 *
 * A suggested prompt in two presentations: a full-width "card" for empty-state
 * starters, and a light "row" (corner-arrow glyph) for in-answer follow-ups.
 * Presentation only — it calls back `onSelect`; the orchestrator decides what asking
 * it means.
 */

import { CornerDownRight } from "lucide-react";

export function SuggestedPrompt({
  label,
  onSelect,
  variant = "card",
}: {
  label: string;
  onSelect: () => void;
  variant?: "card" | "row";
}) {
  if (variant === "row") {
    return (
      <button
        onClick={onSelect}
        className="flex items-center gap-2 w-full text-left text-sm py-1.5 transition-colors hover:text-[var(--text-primary)]"
        style={{ color: "var(--text-secondary)" }}
      >
        <CornerDownRight size={13} className="shrink-0" style={{ color: "var(--text-faint)" }} />
        <span className="min-w-0">{label}</span>
      </button>
    );
  }
  return (
    <button
      onClick={onSelect}
      className="text-left text-sm border px-3.5 py-2.5 rounded-xl transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
    >
      {label}
    </button>
  );
}
