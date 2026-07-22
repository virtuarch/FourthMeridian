/**
 * components/atlas/fields/Select.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one Atlas dropdown on the canonical field surface tokens. Options are data
 * (`{value,label}[]`); an optional `placeholder` renders a leading empty option.
 * Replaces the three hand-rolled `appearance-none` selects across the settings forms.
 */

import { forwardRef, type SelectHTMLAttributes } from "react";
import { INPUT_BASE, inputStyle } from "@/components/atlas/fields/tokens";

export interface SelectOption { value: string; label: string; }

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: readonly SelectOption[];
  /** Leading empty option label (e.g. "Select…"). Omit for no placeholder row. */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, className = "", ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={`${INPUT_BASE} px-3 py-2 appearance-none ${className}`}
      style={inputStyle}
      {...rest}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
});
