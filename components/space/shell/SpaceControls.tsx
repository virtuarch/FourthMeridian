"use client";

/**
 * components/space/shell/SpaceControls.tsx
 *
 * The canonical Space-level control cluster — display-currency ("view as" / FX)
 * + Manage. ONE component, ONE state source, rendered at two responsive mount
 * points:
 *
 *   • wide (lg+)   — in the Space-mode ContextualNavbar, under the identity
 *                    (the prototype's sidebar placement).
 *   • narrow (<lg) — near the WorkspaceRail in SpaceShell, because the sidebar
 *                    is hidden on a phone and these controls must not vanish.
 *
 * It holds NO state: the FX control is a fully-formed node owned above
 * (PersonalDashboard's ViewCurrencyOverride), and Manage is the host's handler.
 * So rendering it in two places is two mount points of one behaviour, never two
 * copies of state — which is exactly the "one source of truth" the shell brief
 * requires. Which mount point is visible is decided by CSS at the call sites.
 */

import type { ReactNode } from "react";

export function SpaceControls({
  currencyControl,
  onManage,
  className = "",
}: {
  /** The display-currency control node (or null — e.g. shared Spaces). */
  currencyControl: ReactNode;
  /** Opens the Manage dialog. Omitted ⇒ no Manage affordance. */
  onManage?: () => void;
  className?: string;
}) {
  if (!currencyControl && !onManage) return null;

  return (
    <div className={["flex items-center gap-1.5", className].join(" ")}>
      {currencyControl}
      {onManage && (
        <button
          onClick={onManage}
          className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--glass-ultrathin)] px-2.5 py-1 text-[13px] font-medium text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:border-[var(--border-hairline-strong)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          Manage
        </button>
      )}
    </div>
  );
}
