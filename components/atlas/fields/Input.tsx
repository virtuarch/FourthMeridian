/**
 * components/atlas/fields/Input.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one Atlas text input (text / password / date / …) on the canonical field
 * surface tokens. `trailing` mounts an affordance inside the field (e.g. a
 * password show/hide toggle) with the input padded to clear it. Everything else is
 * a normal <input> prop, forwarded — no bespoke behavior, so it drops into any form.
 */

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { INPUT_BASE, inputStyle } from "@/components/atlas/fields/tokens";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** An affordance rendered at the right edge of the field (e.g. a show/hide eye). */
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { trailing, className = "", type = "text", ...rest },
  ref,
) {
  // `date` needs the dark color-scheme so the native picker matches the theme.
  const scheme = type === "date" ? " [color-scheme:dark]" : "";
  const input = (
    <input
      ref={ref}
      type={type}
      className={`${INPUT_BASE} px-3 py-2.5${scheme}${trailing ? " pr-10" : ""} ${className}`}
      style={inputStyle}
      {...rest}
    />
  );
  if (!trailing) return input;
  return (
    <div className="relative">
      {input}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center">{trailing}</div>
    </div>
  );
});
