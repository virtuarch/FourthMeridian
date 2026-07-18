"use client";

/**
 * components/space/shell/SpaceShell.tsx
 *
 * The in-Space content frame — the prototype's WorkspaceRegion. After the shell
 * migration it owns only the CONTENT column: the centred Workspace rail and the
 * active workspace body. The Space's IDENTITY, its display-currency + Manage
 * controls, and its section anchors now live in the ContextualNavbar's Space
 * mode (published there by the host through SpaceChrome) — exactly the
 * prototype's transforming sidebar. So on desktop this frame has NO header; the
 * rail is the first thing in the column, matching the prototype side-by-side.
 *
 * RESPONSIVE RELOCATION (<lg): the Space-mode sidebar is hidden on a phone, so
 * the identity and the canonical SpaceControls (FX + Manage) would vanish. They
 * are re-presented here, above the rail, ONLY at narrow widths (lg:hidden). Same
 * control, same state — this is a second mount point, never a second copy (see
 * SpaceControls). Which one shows is pure CSS.
 *
 * The app-global chrome (GlobalHeader, ContextualNavbar, BottomNav, the
 * Transaction drawer, Create Space modal) lives ABOVE this frame in
 * DashboardChrome and is shared by every dashboard route — intentionally NOT
 * part of the Space frame.
 */

import type { ReactNode } from "react";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { SpaceControls } from "@/components/space/shell/SpaceControls";

/** One Space-level navigation tab (already resolved to id/label). */
export interface SpaceShellRailOption {
  id:    string;
  label: string;
  /** Optional icon node. M3-Reset: the prototype rail is TEXT-ONLY, so the host
   *  no longer passes icons; kept optional for any caller that still wants one. */
  icon?: ReactNode;
}

export interface SpaceShellProps {
  /**
   * Global shell overlays (Manage / Leave / AddGoal dialogs, …) mounted as
   * siblings ABOVE the frame — the shell owns WHERE they mount; the host owns
   * WHAT they are and their open state.
   */
  overlays?: ReactNode;

  /** The Space's display name — rendered only in the mobile (<lg) relocation
   *  row, where the Space-mode sidebar is hidden. On desktop it lives in the
   *  ContextualNavbar. */
  title: ReactNode;
  /** The subtitle line (category · members) — mobile relocation row only. */
  subtitle: ReactNode;

  /**
   * The canonical Space controls, for the mobile relocation near the rail. The
   * FX control node + Manage handler; on desktop the SAME cluster renders in the
   * ContextualNavbar (published via SpaceChrome), so this is the second, CSS-
   * gated mount point — never duplicated state.
   */
  currencyControl?: ReactNode;
  onManage?: () => void;

  /** The Space-level navigation rail. */
  railOptions: SpaceShellRailOption[];
  activeTab:   string;
  onSelectTab: (tab: string) => void;

  /** The workspace viewport — the active tab's content. Owned by the host. */
  children: ReactNode;
}

export function SpaceShell({
  overlays,
  title,
  subtitle,
  currencyControl,
  onManage,
  railOptions,
  activeTab,
  onSelectTab,
  children,
}: SpaceShellProps) {
  // The Space-level rail control — the ONE fixed Spaces rail (lib/space-nav.ts),
  // TEXT-ONLY labels (the prototype's rail language), every label always visible.
  const rail = (
    <SegmentedControl
      aria-label="Space section"
      options={railOptions}
      value={activeTab}
      onChange={onSelectTab}
      labelVisibility="always"
    />
  );

  return (
    <>
      {overlays}

      <div className="max-w-5xl mx-auto">
        {/* Mobile-only relocation row (<lg) — identity + the canonical
            SpaceControls, because the Space-mode sidebar that normally hosts them
            is hidden on a phone. Hidden on desktop, where the sidebar owns them. */}
        <div className="lg:hidden mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-[var(--text-primary)]">{title}</h1>
            <p className="truncate text-[13px] text-[var(--text-muted)]">{subtitle}</p>
          </div>
          <div className="shrink-0">
            <SpaceControls currencyControl={currencyControl} onManage={onManage} />
          </div>
        </div>

        {/* Navigation rail — the prototype's STABLE, CENTERED rail. Centered and
            in-flow on every Workspace AND every lens: no left-shift when a
            Perspective engages, no scroll-shrink float. Switching pages never
            moves the rail. */}
        <div className="mb-7 flex justify-center">{rail}</div>

        {/* Workspace slot */}
        {children}
      </div>
    </>
  );
}
