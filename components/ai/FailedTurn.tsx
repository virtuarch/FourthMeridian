/**
 * components/ai/FailedTurn.tsx  (AI RELIABILITY — F1)
 *
 * A request that got no answer — NOT an answer. It sits where the answer would
 * have, but it never wears the answer's grammar: no AI mark, no Markdown, no
 * prose colour. It says plainly that no answer was produced, shows the server's
 * own sentence (plain text, never rendered as Markdown), and offers Retry on the
 * newest failure only.
 *
 * `announce` is true only for a failure that happened in this session: a failure
 * restored from the browser cache is shown, but not re-announced to a screen
 * reader on page load. Presentation only.
 */

import { AlertCircle, RotateCcw } from "lucide-react";

export const FAILED_TURN_LABEL = "No answer — this request didn’t complete";

export function FailedTurn({ message, onRetry, announce = false, busy = false }: {
  message: string;
  onRetry?: () => void;
  announce?: boolean;
  busy?: boolean;
}) {
  return (
    <div role="group" aria-label={FAILED_TURN_LABEL} data-turn="failed" className="flex gap-3">
      <div className="pt-1 shrink-0" aria-hidden>
        <AlertCircle size={16} style={{ color: "var(--accent-warning)" }} />
      </div>
      <div className="min-w-0 flex-1 rounded-lg border px-3 py-2.5 text-sm"
        style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
        <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{FAILED_TURN_LABEL}</p>
        <p role={announce ? "alert" : undefined} className="mt-1 leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: "var(--text-secondary)" }}>
          {message}
        </p>
        {onRetry && (
          <button type="button" onClick={onRetry} disabled={busy}
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
            <RotateCcw size={12} aria-hidden /> Retry
          </button>
        )}
      </div>
    </div>
  );
}
