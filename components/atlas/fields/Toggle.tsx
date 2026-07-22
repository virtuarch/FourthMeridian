/**
 * components/atlas/fields/Toggle.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one Atlas boolean control — a checkbox on the accent color. `busy` swaps it
 * for an inline spinner (the settings matrix pattern: a saving cell shows progress
 * in place). Replaces the raw `<input type=checkbox className="accent-blue-500">`
 * scattered through the notification matrix.
 */

import { Loader2 } from "lucide-react";

export function Toggle({
  checked,
  onChange,
  disabled,
  busy,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Show a spinner in place of the control while a save is in flight. */
  busy?: boolean;
  "aria-label"?: string;
}) {
  if (busy) {
    return <Loader2 size={14} className="animate-spin" style={{ color: "var(--text-muted)" }} aria-label={ariaLabel} />;
  }
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={ariaLabel}
      className="w-4 h-4 accent-[var(--accent-info)] disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
    />
  );
}
