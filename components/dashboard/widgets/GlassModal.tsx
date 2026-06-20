"use client";

/**
 * GlassModal
 *
 * Shared shell for every modal introduced by the Dashboard IA Refactor (KPI
 * detail modals, Perspective-card modals, TimelineModal). Extracted from the
 * backdrop/sheet recipe NetWorthChartModal already established — same
 * translucent + blurred backdrop, same GlassPanel depth/elevation/radius,
 * same header treatment — so every new modal in this pass is built from
 * GlassPanel/GlassButton + theme tokens "by construction" (point 9 of the
 * IA refactor) instead of six bespoke shells that could drift apart or leak
 * a hardcoded bg-gray-* surface.
 *
 * Not a replacement for existing modals (NetWorthChartModal, AccountModal,
 * etc.) — those already follow this recipe inline and are left as-is to
 * avoid touching working code for no functional gain.
 */

import { ReactNode, ElementType } from "react";
import { X } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";

const SIZE_CLASS: Record<NonNullable<GlassModalProps["size"]>, string> = {
  md:   "sm:max-w-xl sm:max-h-[88dvh]",
  lg:   "sm:max-w-3xl sm:max-h-[88dvh]",
  xl:   "sm:max-w-5xl sm:max-h-[90dvh]",
  full: "sm:max-w-[96vw] sm:h-[92dvh]",
};

export interface GlassModalProps {
  title: string;
  subtitle?: string;
  icon?: ElementType;
  onClose: () => void;
  children: ReactNode;
  /** Optional sticky footer slot (e.g. a "Manage accounts →" link). */
  footer?: ReactNode;
  /** Optional sub-nav / filter row rendered between header and body. */
  toolbar?: ReactNode;
  /** md (default) ≈ NetWorthChartModal's max-w-3xl; full ≈ near-fullscreen, for Timeline. */
  size?: "md" | "lg" | "xl" | "full";
}

export function GlassModal({
  title,
  subtitle,
  icon: Icon,
  onClose,
  children,
  footer,
  toolbar,
  size = "lg",
}: GlassModalProps) {
  return (
    // Backdrop — translucent + blurred, matching the rest of the app's
    // glass-modal recipe (NetWorthChartModal/CreateSpaceModal/AccountModal).
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-2 sm:p-4"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      {/* Sheet — stops propagation so clicking inside doesn't close */}
      <GlassPanel
        depth="thick"
        elevation="e4"
        radius="xl"
        className={`w-full h-[94dvh] ${SIZE_CLASS[size]} flex flex-col`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="h-full flex flex-col p-5">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 mb-1 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {Icon && (
                <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center shrink-0">
                  <Icon size={15} className="text-[var(--text-secondary)]" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{title}</p>
                {subtitle && <p className="text-xs text-[var(--text-muted)] truncate">{subtitle}</p>}
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors touch-manipulation shrink-0"
            >
              <X size={16} />
            </button>
          </div>

          {toolbar && <div className="shrink-0 mt-3">{toolbar}</div>}

          {/* Body — scrolls; header/toolbar/footer stay put */}
          <div className="flex-1 min-h-0 overflow-y-auto mt-4 -mx-1 px-1">{children}</div>

          {footer && <div className="shrink-0 mt-4 pt-4 border-t border-[var(--border-hairline)]">{footer}</div>}
        </div>
      </GlassPanel>
    </div>
  );
}
