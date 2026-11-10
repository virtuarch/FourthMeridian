"use client";

/**
 * components/ai/Composer.tsx  (AI Experience Convergence — AI-1, conversation-first AI-3)
 *
 * The one conversation composer, anchored beneath the reading region —
 * the host decides where it sits. A real <form> around the Atlas `Textarea`
 * (auto-grow, capped), a send button that activates on a non-empty draft and a stop
 * button while a reply is in flight. Enter sends, Shift+Enter inserts a newline, an
 * IME-confirming Enter does neither. The draft stays editable while a reply is in
 * flight (the host refuses the send). Beneath it, the persistent AI disclosure
 * (AiDisclosure) at every width. Presentation + input only — it calls
 * `onSubmit` / `onStop`; it never fetches.
 */

import { useId, type AriaAttributes, type AriaRole, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Textarea } from "@/components/atlas/fields";
import { isSendKey } from "@/components/ai/conversation-surface";
import { AiDisclosure } from "@/components/ai/AiDisclosure";

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

export interface ComposerFrameProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onFocus?: () => void;
  /** Accessible name of the input (rendered as an sr-only <label>). */
  label?: string;
  placeholder?: string;
  /** The textarea id. Defaults to an id of the frame's own. */
  inputId?: string;
  maxLength?: number;
  describedBy?: string;
  /** Disables the input and the send button. */
  disabled?: boolean;
  /** Replaces the send button (e.g. a stop button while a reply is in flight). */
  trailing?: ReactNode;
  /** Rendered beneath the input pill. */
  footer?: ReactNode;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /**
   * A key handler that runs BEFORE Enter-to-send, in the capture phase (a suggestion list's arrows / Enter / Escape).
   * Return true when it handled the key: propagation stops, so Enter-to-send never sees it.
   */
  onKeyIntercept?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Caret moves (click / keys) — for a caret-anchored suggestion list. */
  onCaret?: (caret: number) => void;
  /** Extra ARIA on the input (a combobox: role, aria-expanded, aria-controls, aria-activedescendant…). */
  inputAria?: Readonly<AriaAttributes & { role?: AriaRole }>;
  /** Rendered above the pill, inside the form (e.g. a suggestion list). */
  overlay?: ReactNode;
}

/**
 * The composer frame shared by every conversation surface: a real <form>, the
 * pill around the auto-growing Atlas `Textarea`, the round send button, and
 * Enter-to-send (Shift+Enter for a newline, IME-safe). What sits beneath it is
 * the host's `footer`.
 */
export function ComposerFrame({
  value,
  onChange,
  onSubmit,
  onFocus,
  label = "Message Fourth Meridian AI",
  placeholder,
  inputId: inputIdProp,
  maxLength,
  describedBy,
  disabled,
  trailing,
  footer,
  textareaRef,
  onKeyIntercept,
  onCaret,
  inputAria,
  overlay,
}: ComposerFrameProps) {
  const ownId = useId();
  const inputId = inputIdProp ?? `${ownId}-input`;

  return (
    <form
      className="max-w-3xl mx-auto w-full"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">{label}</label>
      {overlay ? <div className="relative">{overlay}</div> : null}
      <div className="flex items-end gap-2 rounded-[22px] border border-[var(--border-hairline-strong)] bg-[var(--surface-inset)] p-2 pl-4 shadow-[0_10px_30px_-18px_rgba(0,0,0,0.6)] transition-[border-color,box-shadow] focus-within:border-[var(--accent-info)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent-info)_18%,transparent)]">
        <Textarea
          ref={textareaRef}
          id={inputId}
          value={value}
          onChange={(e) => { onChange(e.target.value); onCaret?.(e.target.selectionStart ?? e.target.value.length); }}
          onFocus={onFocus}
          onSelect={onCaret ? (e) => onCaret(e.currentTarget.selectionStart ?? 0) : undefined}
          {...(inputAria ?? {})}
          // A suggestion list's keys run first (capture phase); a handled key never reaches Enter-to-send.
          onKeyDownCapture={onKeyIntercept ? (e) => { if (onKeyIntercept(e)) e.stopPropagation(); } : undefined}
          onKeyDown={(e) => {
            if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
              e.preventDefault();
              onSubmit();
            }
          }}
          maxHeightPx={200}
          placeholder={placeholder}
          aria-describedby={describedBy}
          enterKeyHint="send"
          maxLength={maxLength}
          disabled={disabled}
          className="min-w-0 flex-1 !overflow-y-auto border-0 px-0 py-2 leading-6 max-sm:text-base sm:text-[15px]"
          style={{ background: "transparent", maxHeight: "min(200px, 25dvh)" }}
        />
        {trailing ?? (
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-[opacity,background-color] text-white bg-[var(--accent-info)] disabled:opacity-35 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
          >
            <ArrowUp size={17} strokeWidth={2.25} />
          </button>
        )}
      </div>
      {footer}
    </form>
  );
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
    <ComposerFrame
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      onFocus={onFocus}
      placeholder={placeholder}
      inputId={inputId}
      describedBy={hint ? hintId : undefined}
      textareaRef={textareaRef}
      trailing={busy && onStop ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop generating"
          className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-colors bg-[var(--surface-hover-strong)] text-[var(--text-primary)] hover:bg-[var(--border-hairline-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
        >
          <Square size={12} fill="currentColor" />
        </button>
      ) : undefined}
      footer={
        /* Advice-boundary slice — the persistent disclosure, at every width and in
           both layouts. The keyboard hint stays desktop-only beneath it. */
        <div className="mt-2 px-1 text-[11px] text-[var(--text-muted)]">
          <AiDisclosure />
          {hint && (
            <p id={hintId} className="hidden sm:block mt-0.5 text-center">
              {hint}
            </p>
          )}
        </div>
      }
    />
  );
}
