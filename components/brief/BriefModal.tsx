"use client";

/**
 * BriefModal
 *
 * Shared modal shell for the Daily Brief interaction layer.
 *
 * WHY createPortal:
 *   The Daily Brief stagger animation applies `transform: translateY()` to
 *   .briefSection ancestor elements. Any CSS `transform` on an ancestor —
 *   even `translateY(0)` at rest — creates a new containing block that traps
 *   `position: fixed` descendants, causing the modal to position relative to
 *   the card rather than the viewport. createPortal renders into document.body,
 *   completely escaping the component tree's stacking context.
 *
 * Behaviour:
 *   - Renders into document.body via ReactDOM.createPortal
 *   - Fixed full-viewport overlay, z-[9999]
 *   - Dark translucent backdrop + backdrop-blur
 *   - Glass panel centered on desktop, near full-width on mobile
 *   - max-h-[85vh] with internal overflow-y-auto
 *   - ESC closes
 *   - Backdrop click closes
 *   - Close button top-right
 *   - Body scroll locked while open
 *   - role="dialog" + aria-modal
 */

import { useEffect, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface BriefModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Optional wider panel. Default max-w-2xl. */
  wide?: boolean;
}

export function BriefModal({ open, onClose, title, children, wide }: BriefModalProps) {
  // ESC to close — onClose is stable (callers use useCallback)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Body scroll lock
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return createPortal(
    /*
     * Root — fills the viewport, sits above everything.
     * Backdrop is a separate absolutely-positioned child so clicking it
     * closes the modal without the panel itself triggering the same handler.
     */
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 md:p-10">

      {/* Backdrop — full screen, closes on click */}
      <div
        className="absolute inset-0"
        style={{
          background: "rgba(2,5,14,0.75)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Glass panel — centered, does NOT close on click */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={[
          "relative w-full",
          wide ? "max-w-3xl" : "max-w-2xl",
          "max-h-[85vh] overflow-y-auto",
          "rounded-2xl",
        ].join(" ")}
        style={{
          backdropFilter: "blur(28px) saturate(140%)",
          WebkitBackdropFilter: "blur(28px) saturate(140%)",
          background: "rgba(8,14,28,0.92)",
          border: "1px solid rgba(125,180,255,0.13)",
          boxShadow: [
            "inset 0 1px 0 rgba(255,255,255,0.08)",
            "0 32px 80px rgba(0,0,0,0.70)",
            "0 0 60px rgba(37,99,235,0.07)",
          ].join(", "),
        }}
      >
        {/* Sticky header */}
        <div
          className="sticky top-0 z-10 flex items-center justify-between px-6 md:px-8 py-5 border-b border-white/[0.07]"
          style={{
            background: "rgba(8,14,28,0.97)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          <h2 className="text-sm font-semibold text-white tracking-wide">{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/[0.08] transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="px-6 md:px-8 py-6">
          {children}
        </div>
      </div>
    </div>,

    document.body,
  );
}
