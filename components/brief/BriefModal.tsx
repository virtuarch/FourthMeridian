"use client";

import type { ReactNode } from "react";
import { OverlaySurface } from "@/components/atlas/OverlaySurface";

interface BriefModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Optional wider panel. Default max-w-2xl. */
  wide?: boolean;
  /**
   * Optional content rendered opposite the title, in the same header row
   * (e.g. a time-range filter). Sits to the left of the close button.
   * Keeps controls out of the body so the title stays the one visual
   * anchor and the content below remains the focal point.
   */
  headerRight?: ReactNode;
}

/** Brief reading surfaces share sheet gestures, focus, motion and viewport handling. */
export function BriefModal({ open, onClose, title, children, wide, headerRight }: BriefModalProps) {
  return (
    <OverlaySurface
      open={open}
      onClose={onClose}
      title={title}
      headerRight={headerRight}
      intent="dialog"
      size="lg"
      glow="meridian"
      className={wide ? "" : "sm:!max-w-2xl"}
    >
      <div className="px-1 pb-3 sm:px-3">{children}</div>
    </OverlaySurface>
  );
}
