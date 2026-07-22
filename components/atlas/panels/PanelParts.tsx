"use client";

/**
 * components/atlas/panels/PanelParts.tsx
 *
 * The composition slots for <Panel>: PanelHeader, PanelContent, PanelFooter. They
 * read the enclosing panel's context (close handler, title id) so the consumer never
 * threads props. Presentation-only — a slot never knows what domain content it wraps.
 *
 *   <RightPanel open={o} onClose={close}>
 *     <PanelHeader eyebrow="Holding" title="VTSAX" />
 *     <PanelContent>{…detail…}</PanelContent>
 *     <PanelFooter>{…actions…}</PanelFooter>
 *   </RightPanel>
 */

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { usePanelContext } from "./panel-context";

export interface PanelHeaderProps {
  /** Optional uppercase kicker above the title (e.g. "Holding", "Transaction"). */
  eyebrow?: ReactNode;
  /** The panel's visible title — also its accessible name (wired to aria-labelledby). */
  title: ReactNode;
  /** Optional controls opposite the title, left of the close button. */
  actions?: ReactNode;
  /** Omit the built-in close button (dismissal handled elsewhere in content). */
  hideClose?: boolean;
}

export function PanelHeader({ eyebrow, title, actions, hideClose = false }: PanelHeaderProps) {
  const { onClose, titleId, registerTitle } = usePanelContext("PanelHeader");

  // Tell <Panel> a visible title exists, so the dialog labels by it (aria-labelledby)
  // rather than the fallback ariaLabel. Cleared on unmount.
  useEffect(() => {
    registerTitle(true);
    return () => registerTitle(false);
  }, [registerTitle]);

  return (
    <header className="flex items-start justify-between gap-4 px-5 pb-4 pt-4 sm:pt-5 shrink-0">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {eyebrow}
          </div>
        )}
        <h2 id={titleId} className="truncate text-sm font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {!hideClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-[var(--radius-sm)] p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover-strong)] hover:text-[var(--text-primary)] touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </header>
  );
}

export interface PanelContentProps {
  children: ReactNode;
  className?: string;
}

/** The one scrolling region of a panel (the height cap lives on the Panel frame). */
export function PanelContent({ children, className = "" }: PanelContentProps) {
  return <div className={`min-h-0 flex-1 overflow-y-auto px-5 pb-5 ${className}`}>{children}</div>;
}

export interface PanelFooterProps {
  children: ReactNode;
  className?: string;
}

/** Sticky footer (typically the action bar), safe-area aware on mobile. */
export function PanelFooter({ children, className = "" }: PanelFooterProps) {
  return (
    <footer
      className={`shrink-0 border-t border-[var(--border-hairline)] px-5 py-3.5 ${className}`}
      style={{ paddingBottom: "max(14px, env(safe-area-inset-bottom))" }}
    >
      {children}
    </footer>
  );
}
