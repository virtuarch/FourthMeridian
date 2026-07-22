/**
 * components/atlas/fields/HelpText.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one Atlas field help line — faint guidance under a control. Replaces the
 * hand-repeated `text-xs text-[var(--text-faint)]` help strings in the forms.
 */

import type { ReactNode } from "react";

export function HelpText({ children }: { children: ReactNode }) {
  return <p className="text-xs" style={{ color: "var(--text-faint)" }}>{children}</p>;
}
