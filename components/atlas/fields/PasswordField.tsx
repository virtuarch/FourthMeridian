/**
 * components/atlas/fields/PasswordField.tsx  (UI Convergence Wave 2 — W2-0)
 *
 * The one Atlas password input: the canonical field surface (via Input) plus a
 * self-contained show/hide eye toggle. Promoted to the shared kit so the four
 * hand-rolled password + confirm-password toggles across the (auth) routes stop
 * re-implementing the same absolutely-positioned Eye/EyeOff button. Pure
 * presentation — value/onChange/autoComplete/minLength/required all forward to
 * the underlying <input>, so it never changes form behavior.
 */

"use client";

import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/atlas/fields/Input";

type PasswordFieldProps = Omit<ComponentPropsWithoutRef<typeof Input>, "type" | "trailing">;

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(props, ref) {
    const [show, setShow] = useState(false);
    return (
      <Input
        ref={ref}
        type={show ? "text" : "password"}
        trailing={
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Hide password" : "Show password"}
            className="p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        }
        {...props}
      />
    );
  },
);
