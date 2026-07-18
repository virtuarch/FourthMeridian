/**
 * components/auth/AuthCallout.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * A boxed callout with an icon chip, title, and body — the richer sibling of
 * atlas/InlineBanner (which is a single line). Used for the sign-in flow's
 * standout panels: the two-factor prompt, the recovery-code prompt, and the
 * reactivate / cancel-deletion offers. `tone` sets the accent; an action (e.g. an
 * AuthButton) is passed as children below the copy where the panel needs one.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type CalloutTone = "info" | "warning";

const TONE: Record<CalloutTone, { color: string; bg: string; border: string }> = {
  info: { color: "var(--accent-info)", bg: "rgba(59,130,246,0.08)", border: "rgba(125,168,255,0.28)" },
  warning: { color: "var(--accent-warning)", bg: "rgba(251,191,36,0.08)", border: "rgba(251,191,36,0.26)" },
};

export function AuthCallout({
  tone = "info",
  icon: Icon,
  title,
  children,
  action,
}: {
  tone?: CalloutTone;
  icon: LucideIcon;
  title: ReactNode;
  /** Supporting copy under the title. */
  children?: ReactNode;
  /** Optional action row (e.g. an AuthButton) rendered below the copy. */
  action?: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div
      className="space-y-3 rounded-xl border p-4"
      style={{ background: t.bg, borderColor: t.border }}
    >
      <div className="flex items-center gap-3">
        <div
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border"
          style={{ background: t.bg, borderColor: t.border, color: t.color }}
        >
          <Icon size={18} aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
          {children && (
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{children}</p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}
