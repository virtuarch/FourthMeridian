/**
 * components/atlas/fields/Label.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one Atlas field label — the quiet caption above a form control. Replaces the
 * hand-repeated `text-xs text-[var(--text-muted)]` labels across the settings forms.
 */

import type { ReactNode } from "react";

export function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
      {children}
    </label>
  );
}
