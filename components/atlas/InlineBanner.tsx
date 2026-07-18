/**
 * components/atlas/InlineBanner.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one boxed, section-level status message (distinct from FieldError's single
 * line and Toast's transient popup). Replaces the copy-pasted
 * `rgba(237,82,71,0.10)` / `rgba(34,197,94,0.10)` banner boxes across the settings
 * forms. Renders nothing when there is no message.
 */

import type { ReactNode } from "react";

export type BannerTone = "error" | "success" | "info";

const TONE: Record<BannerTone, { bg: string; border: string; color: string }> = {
  error:   { bg: "rgba(237,82,71,0.10)", border: "rgba(237,82,71,0.30)", color: "var(--accent-negative)" },
  success: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.30)", color: "var(--accent-positive)" },
  info:    { bg: "var(--surface-inset)", border: "var(--border-hairline)", color: "var(--text-secondary)" },
};

export function InlineBanner({ tone = "error", children }: { tone?: BannerTone; children?: ReactNode }) {
  if (!children) return null;
  const t = TONE[tone];
  return (
    <div
      className="rounded-xl border px-3 py-2.5 text-sm"
      role={tone === "error" ? "alert" : "status"}
      style={{ background: t.bg, borderColor: t.border, color: t.color }}
    >
      {children}
    </div>
  );
}
