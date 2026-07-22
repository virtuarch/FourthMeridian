/**
 * components/atlas/fields/FieldError.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one Atlas inline field error — a single negative-toned line under a control
 * (distinct from InlineBanner, which is a boxed section-level message). Renders
 * nothing when there is no error, so callers can pass a possibly-empty string.
 */

import type { ReactNode } from "react";

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="text-xs" role="alert" style={{ color: "var(--accent-negative)" }}>{children}</p>;
}
