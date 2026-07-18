/**
 * components/auth/AuthStatus.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * A centered status block — a tinted icon, a title, and a subtitle — for the
 * terminal states of the token flows (email verified / link expired / password
 * updated / confirming…). The `neutral` tone with a spinning icon is the loading
 * state. Sibling to AuthCallout (left-aligned, actionable); this one is a calm,
 * centered outcome.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "success" | "error" | "info" | "neutral";

const TONE: Record<StatusTone, { color: string; bg: string; border: string }> = {
  success: { color: "var(--accent-positive)", bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.28)" },
  error: { color: "var(--accent-negative)", bg: "rgba(237,82,71,0.10)", border: "rgba(237,82,71,0.28)" },
  info: { color: "var(--accent-info)", bg: "rgba(59,130,246,0.08)", border: "rgba(125,168,255,0.28)" },
  neutral: { color: "var(--text-secondary)", bg: "var(--surface-inset)", border: "var(--border-hairline)" },
};

export function AuthStatus({
  tone = "neutral",
  icon: Icon,
  iconSpin,
  title,
  children,
}: {
  tone?: StatusTone;
  icon: LucideIcon;
  /** Spin the icon (loading state). */
  iconSpin?: boolean;
  title: ReactNode;
  /** Subtitle / supporting copy. */
  children?: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div
      className="space-y-1 rounded-xl border px-4 py-4 text-center"
      style={{ background: t.bg, borderColor: t.border }}
    >
      <Icon
        size={20}
        aria-hidden
        className={iconSpin ? "mx-auto animate-spin" : "mx-auto"}
        style={{ color: t.color }}
      />
      <p className="text-sm font-medium" style={{ color: t.color }}>
        {title}
      </p>
      {children && <p className="text-xs text-[var(--text-muted)]">{children}</p>}
    </div>
  );
}
