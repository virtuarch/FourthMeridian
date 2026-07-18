/**
 * components/atlas/fields/tokens.ts  (UI Convergence Wave 1 — W1-D)
 *
 * The canonical Atlas form-control surface tokens — the ONE definition of how an
 * input/select looks (border, radius, focus ring, placeholder). Promoted here from
 * the former components/settings/InlineField.tsx so the whole field kit + any other
 * consumer share a single source (InlineField now re-exports these for the handful
 * of pre-existing importers). Matching the shipped look byte-for-byte.
 */

import type { CSSProperties } from "react";

/** Base class for a full-width Atlas text input / select (add padding per control). */
export const INPUT_BASE =
  "w-full border rounded-lg text-sm focus:outline-none focus:border-[var(--accent-info)] transition-colors placeholder:text-[var(--text-faint)]";

/** The surface/border/text colors for an Atlas input, as inline CSS-var styles. */
export const inputStyle: CSSProperties = {
  background:  "var(--surface-inset)",
  borderColor: "var(--border-hairline)",
  color:       "var(--text-primary)",
};

/**
 * The ONE form-save contract shared across the field kit and its consumers:
 * `null` ⇒ success; a non-null string ⇒ a user-facing error message. This is the
 * contract InlineField already used; W1-E converges every Settings save onto it.
 */
export type SaveResult = string | null;
/** A save action over a single string value (the field-kit convention). */
export type FieldSaveFn = (value: string) => Promise<SaveResult>;
