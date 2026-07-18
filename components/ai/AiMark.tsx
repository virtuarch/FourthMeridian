/**
 * components/ai/AiMark.tsx  (AI Experience Convergence — AI-1)
 *
 * The single AI brand mark: one accent dot with a soft glow — the whole visual
 * identity of the AI surface (no avatar, no badge, no gradient), per the prototype.
 * A brand mark, not an "AI-only styling system": it is a dot on the shared accent
 * token.
 */

export function AiMark({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${className}`}
      style={{ background: "var(--accent-info)", boxShadow: "0 0 10px 1px var(--accent-info)" }}
    />
  );
}
