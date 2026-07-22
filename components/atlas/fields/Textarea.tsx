/**
 * components/atlas/fields/Textarea.tsx  (UI Convergence — AI-0)
 *
 * The one Atlas multiline text input, on the canonical field surface tokens (the
 * textarea counterpart to `Input`). Auto-grows with its content up to an optional
 * cap, then scrolls. A pure primitive: it owns sizing + surface, nothing else —
 * keyboard semantics (Enter-to-send, etc.) belong to the caller via `onKeyDown`.
 * Not AI-specific; it retires the bare `<textarea>` hand-rolled across the app.
 */

import { forwardRef, useCallback, useEffect, useRef, type TextareaHTMLAttributes } from "react";
import { INPUT_BASE, inputStyle } from "@/components/atlas/fields/tokens";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow the field to fit its content (default true). */
  autoGrow?: boolean;
  /** Cap the auto-grown height in px; beyond it the field scrolls. */
  maxHeightPx?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { autoGrow = true, maxHeightPx, className = "", rows = 1, value, onInput, style, ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const resize = useCallback(() => {
    const el = innerRef.current;
    if (!el || !autoGrow) return;
    el.style.height = "auto";
    const next = maxHeightPx ? Math.min(el.scrollHeight, maxHeightPx) : el.scrollHeight;
    el.style.height = `${next}px`;
    el.style.overflowY = maxHeightPx && el.scrollHeight > maxHeightPx ? "auto" : "hidden";
  }, [autoGrow, maxHeightPx]);

  // Re-measure whenever the controlled value changes (incl. reset to empty on send).
  useEffect(resize, [resize, value]);

  return (
    <textarea
      ref={setRef}
      rows={rows}
      value={value}
      onInput={(e) => { resize(); onInput?.(e); }}
      className={`${INPUT_BASE} px-3 py-2.5 resize-none ${className}`}
      style={{ ...inputStyle, ...style }}
      {...rest}
    />
  );
});
