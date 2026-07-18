"use client";

/**
 * components/ai/Composer.tsx  (AI Experience Convergence — AI-1)
 *
 * The persistent conversation composer: the Atlas `Textarea` (auto-grow) inside a
 * focus-ringed bar, with a send button that activates on a non-empty draft and a
 * stop button while a reply is in flight. Enter sends, Shift+Enter inserts a newline.
 * Presentation + input only — it calls `onSubmit` / `onStop`; it never fetches. The
 * host makes it sticky.
 */

import { Send, X } from "lucide-react";
import { Textarea } from "@/components/atlas/fields";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  busy?: boolean;
  placeholder?: string;
  hint?: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy = false,
  placeholder = "Ask Fourth Meridian anything…",
  hint = "Enter to send · Shift+Enter for a new line",
}: ComposerProps) {
  return (
    <div className="max-w-3xl mx-auto w-full">
      <div
        className="flex items-end gap-2 rounded-2xl border p-1.5 pl-3 transition-colors focus-within:border-[var(--accent-info)]"
        style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
      >
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          maxHeightPx={160}
          placeholder={placeholder}
          aria-label="Message Fourth Meridian AI"
          className="flex-1 border-0 px-0 py-2"
          style={{ background: "transparent" }}
        />
        {busy && onStop ? (
          <button
            onClick={onStop}
            aria-label="Stop generation"
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-colors shrink-0 hover:bg-[var(--surface-hover-strong)]"
            style={{ background: "var(--surface-inset)" }}
          >
            <X size={16} style={{ color: "var(--text-primary)" }} />
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={!value.trim()}
            aria-label="Send message"
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-colors shrink-0 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "var(--accent-info)" }}
          >
            <Send size={16} />
          </button>
        )}
      </div>
      {hint && (
        <p className="mt-1.5 px-1 text-[11px]" style={{ color: "var(--text-faint)" }}>{hint}</p>
      )}
    </div>
  );
}
