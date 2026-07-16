"use client";

/**
 * components/space/shell/SpaceShell.tsx
 *
 * SD-1 — the permanent visual FRAME of every Space, extracted out of the
 * monolithic SpaceDashboard. The shell owns only chrome + layout:
 *
 *   overlays (dialog mount point)
 *   └─ frame container (max-w-5xl, centered)
 *      ├─ header  (title + subtitle)
 *      ├─ toolbar (frame-level action slot)
 *      ├─ navigation rail (the Space-level tab SegmentedControl)
 *      └─ workspace slot (children — the active tab's content)
 *
 * It is deliberately workspace-AGNOSTIC: nothing here knows what Investments,
 * Wealth, Debt, or Cash Flow do. Anything workspace-specific (the toolbar
 * buttons, the header text, the dialogs, the body) arrives as props/slots the
 * host composes. URL and time authorities (SD-0A / SD-0B) stay with the host and
 * the shell time hook respectively — the shell frame does not touch them.
 *
 * The app-global chrome (Sidebar, mobile/desktop header bars, BottomNav, the
 * Transaction drawer, Create Space modal) lives ABOVE this frame in
 * DashboardChrome and is shared by every dashboard route — it is intentionally
 * NOT part of the Space shell.
 */

import type { ReactNode } from "react";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { FloatingNavWrapper, RAIL_PILL_TOP } from "@/components/atlas/FloatingNavWrapper";

/** One Space-level navigation tab (already resolved to id/label/icon-node). */
export interface SpaceShellRailOption {
  id:    string;
  label: string;
  icon:  ReactNode;
}

export interface SpaceShellProps {
  /**
   * Global shell overlays (Manage / Leave / AddGoal dialogs, …) mounted as
   * siblings ABOVE the frame — the shell owns WHERE they mount; the host owns
   * WHAT they are and their open state.
   */
  overlays?: ReactNode;

  /** Header — the Space's display name. */
  title: ReactNode;
  /** Header — the subtitle line (category · members · updated). */
  subtitle: ReactNode;

  /**
   * Frame-level action buttons (Edit Layout / Manage / Leave). A slot, not
   * structured props, so the shell stays agnostic of what each button opens.
   */
  toolbar?: ReactNode;

  /**
   * SD-2C — the Space-level display-currency ("view as" / FX) control. Display
   * currency governs the WHOLE Space, so its mount point is a shell capability,
   * not an Overview-workspace one. This is a pure ReactNode SLOT: the host builds
   * the control and its state; the shell owns only WHERE it mounts (the header)
   * and performs NO currency conversion or FX math. Absent (e.g. shared Spaces)
   * ⇒ nothing renders.
   */
  displayCurrencyControl?: ReactNode;

  /** The Space-level navigation rail. */
  railOptions: SpaceShellRailOption[];
  activeTab:   string;
  onSelectTab: (tab: string) => void;
  /**
   * When true the rail renders static/in-flow (the Perspectives track below
   * becomes the surface that floats + shrinks instead); otherwise the rail
   * itself floats + shrinks on scroll. Behavioral parity with the pre-extraction
   * `activeTab === "PERSPECTIVES"` branch — the shell never names the tab.
   */
  railStatic?: boolean;

  /** The workspace viewport — the active tab's content (render ladder, section
   *  stacks, per-tab overlays). Owned by the host; rendered inside the frame. */
  children: ReactNode;
}

export function SpaceShell({
  overlays,
  title,
  subtitle,
  toolbar,
  displayCurrencyControl,
  railOptions,
  activeTab,
  onSelectTab,
  railStatic = false,
  children,
}: SpaceShellProps) {
  // The Space-level rail control — the ONE fixed Spaces rail (lib/space-nav.ts),
  // shared order across every Space type. Atlas SegmentedControl.
  const rail = (
    <SegmentedControl
      aria-label="Space section"
      options={railOptions}
      value={activeTab}
      onChange={onSelectTab}
      labelVisibility="activeOnly"
    />
  );

  return (
    <>
      {overlays}

      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="text-xl font-bold text-white">{title}</h1>
            <p className="text-sm text-[var(--text-muted)]">{subtitle}</p>
          </div>

          {/* Shell-owned Space capabilities + frame actions. Display currency is
              a Space-level control (mounted here, not in Overview); the shell
              performs no FX math — it only renders the host-provided control. */}
          <div className="flex items-center gap-2 shrink-0 ml-3">
            {displayCurrencyControl}
            {toolbar}
          </div>
        </div>

        {/* Navigation rail — a centered floating pill (sticky below the app
            header) on every tab except Perspectives, where it goes fully static
            so the Perspective track below owns the float/shrink (SHELL_NAV §2.3). */}
        {railStatic ? (
          <div className="mb-5">{rail}</div>
        ) : (
          <FloatingNavWrapper top={RAIL_PILL_TOP} className="mb-5">
            {rail}
          </FloatingNavWrapper>
        )}

        {/* Workspace slot */}
        {children}
      </div>
    </>
  );
}
