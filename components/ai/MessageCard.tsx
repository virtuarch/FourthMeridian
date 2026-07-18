/**
 * components/ai/MessageCard.tsx  (AI Experience Convergence — AI-1)
 *
 * A user turn — a quiet, right-aligned bubble (the prototype's read-surface idiom:
 * the user's words are calm; the AI's grounded answer carries the accent). Read-only,
 * no actions. Presentation only.
 */

export function MessageCard({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] rounded-2xl rounded-tr-sm border px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" }}
      >
        {content}
      </div>
    </div>
  );
}
