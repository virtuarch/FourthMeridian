"use client";

/**
 * components/ai/Composer.tsx  (AI Experience Convergence — AI-1, conversation-first AI-3)
 *
 * The one conversation composer, used centered (empty) and docked (conversation) —
 * the host decides where it sits. A real <form> around the Atlas `Textarea`
 * (auto-grow, capped), a send button that activates on a non-empty draft and a stop
 * button while a reply is in flight. Enter sends, Shift+Enter inserts a newline, an
 * IME-confirming Enter does neither. The draft stays editable while a reply is in
 * flight (the host refuses the send). Presentation + input only — it calls
 * `onSubmit` / `onStop`; it never fetches.
 */

import { useId, type Ref } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Textarea } from "@/components/atlas/fields";
import { isSendKey } from "@/components/ai/conversation-surface";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onFocus?: () => void;
  busy?: boolean;
  placeholder?: string;
  hint?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  onFocus,
  busy = false,
  placeholder = "Ask about your money…",
  hint = "Enter to send · Shift+Enter for a new line",
  textareaRef,
}: ComposerProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const hintId = `${id}-hint`;

  return (
    <form
      className="max-w-3xl mx-auto w-full"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">Message Fourth Meridian AI</label>
      <div className="flex items-end gap-2 rounded-[22px] border border-[var(--border-hairline-strong)] bg-[var(--surface-inset)] p-2 pl-4 shadow-[0_10px_30px_-18px_rgba(0,0,0,0.6)] transition-[border-color,box-shadow] focus-within:border-[var(--accent-info)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent-info)_18%,transparent)]">
        <Textarea
          ref={textareaRef}
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
              e.preventDefault();
              onSubmit();
            }
          }}
          maxHeightPx={200}
          placeholder={placeholder}
          aria-describedby={hint ? hintId : undefined}
          enterKeyHint="send"
          className="flex-1 border-0 px-0 py-2 leading-6 max-sm:text-base sm:text-[15px]"
          style={{ background: "transparent" }}
        />
        {busy && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors bg-[var(--surface-hover-strong)] text-[var(--text-primary)] hover:bg-[var(--border-hairline-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
          >
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim()}
            aria-label="Send message"
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-[opacity,background-color] text-white bg-[var(--accent-info)] disabled:opacity-35 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
          >
            <ArrowUp size={17} strokeWidth={2.25} />
          </button>
        )}
      </div>
      {hint && (
        <p id={hintId} className="hidden sm:block mt-2 px-1 text-center text-[11px] text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </form>
  );
}
