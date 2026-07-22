/**
 * components/atlas/fields/OtpInput.tsx  (UI Convergence Wave 2 — W2-0)
 *
 * The one Atlas one-time-code field: a row of segmented cells over a single,
 * transparent, focus-capturing <input>. Backing the display with ONE real input
 * (rather than N inputs) keeps native paste, autofill (`one-time-code`), and
 * form-submit-on-Enter behavior intact — the ref forwards to it, so callers can
 * still `ref.current?.focus()`. Digits only; the value is owned by the caller.
 *
 * Used by the sign-in TOTP step; promoted to the shared kit so any future code
 * entry (SMS OTP, device confirmation) renders identically.
 */

"use client";

import { forwardRef, useState } from "react";

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Number of cells / max digits. Default 6. */
  length?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  "aria-label"?: string;
}

export const OtpInput = forwardRef<HTMLInputElement, OtpInputProps>(function OtpInput(
  {
    value,
    onChange,
    length = 6,
    autoFocus,
    disabled,
    name,
    id,
    "aria-label": ariaLabel = "Verification code",
  },
  ref,
) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="relative">
      <div className="flex justify-center gap-2 sm:gap-2.5" aria-hidden="true">
        {Array.from({ length }).map((_, i) => {
          const char = value[i] ?? "";
          // The cell awaiting the next digit gets the lit ring while focused.
          const active = focused && i === value.length && value.length < length;
          return (
            <div
              key={i}
              className="flex h-14 w-11 items-center justify-center rounded-lg border text-lg font-semibold tabular-nums transition-[border-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-standard)]"
              style={{
                background: "var(--surface-inset)",
                borderColor: active ? "var(--meridian-500)" : "var(--border-hairline)",
                boxShadow: active ? "0 0 0 3px rgba(59,130,246,0.14)" : "none",
                color: "var(--text-primary)",
              }}
            >
              {char}
            </div>
          );
        })}
      </div>

      <input
        ref={ref}
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, length))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        pattern="\d*"
        maxLength={length}
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={ariaLabel}
        suppressHydrationWarning
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent opacity-0 outline-none"
      />
    </div>
  );
});
