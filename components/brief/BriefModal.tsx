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
 * Glass recipe — "Liquid Glass", not dark acrylic:
 *   The panel uses Atlas Glass "thick" depth as its base, tuned to read as
 *   smoked crystal rather than an opaque navy sheet: a low-opacity navy
 *   fill (rgba(10,14,23,.55) instead of the default .88 token), a heavier
 *   56px blur with saturate(180%) so whatever shows through stays soft and
 *   diffused rather than legible, and a diagonal reflection sheen layered
 *   just above the panel's own specular edge to suggest a faint internal
 *   light bleed across the glass. Modals are the deepest layer in the
 *   visual hierarchy, so they get the most blur and the most presence, but
 *   should never feel like a flat dark box. This is a deliberate,
 *   documented one-off tuning of the shared --glass-thick token, scoped to
 *   this file only (same precedent as the --dur-shimmer exception in
 *   globals.css).
 *
 * Behaviour:
 *   - Renders into document.body via ReactDOM.createPortal
 *   - Fixed full-viewport overlay on the named --z-modal token (Overlay
 *     Convergence: normalized off the former z-[9999] outlier)
 *   - Dark navy scrim + backdrop-blur + a faint meridian ambient glow
 *   - Glass panel centered on desktop, inset with safe margins on mobile
 *     (p-4 sm:p-6 md:p-10 on the overlay itself)
 *   - max-h-[85dvh] with internal overflow-y-auto *and* overflow-x-hidden —
 *     the explicit overflow-x-hidden matters: setting only
 *     overflow-y-auto leaves the browser to compute overflow-x as auto
 *     too, which silently adds a horizontal scrollbar the moment any
 *     header content (e.g. a wide headerRight control) is even a pixel
 *     too wide. That made the close button reachable only via an
 *     unintuitive sideways scroll on narrow viewports.
 *   - Header is two separate renders below sm/sm-and-up, not one
 *     responsive row: on mobile, headerRight (when present) gets pushed
 *     onto a second full-width row below the title instead of sharing
 *     the title's row, so the close button always stays pinned top-right
 *     on its own row and is never pushed off-panel by a wide control.
 *   - ESC closes
 *   - Backdrop click closes
 *   - Glass icon close button, top-right, always visible/tappable
 *   - Content scrolls inside the panel if it's taller than max-h
 *   - Body scroll locked while open
 *   - Focus moves into the panel on open, is trapped (Tab/Shift+Tab), and
 *     returns to the invoking trigger on close (Overlay Convergence parity)
 *   - role="dialog" + aria-modal
 *   - Entrance: fade + slight scale/translate, respects prefers-reduced-motion
 *     (global *,*::before,*::after { transition-duration: .01ms !important }
 *     rule in globals.css neutralizes this automatically)
 */

import { useEffect, useRef, useState, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { useBodyScrollLock } from "@/components/atlas/useBodyScrollLock";

// Same focusable-selector the OverlaySurface primitive uses — kept local so
// this parity change stays scoped to BriefModal without a full rebase.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

export function BriefModal({ open, onClose, title, children, wide, headerRight }: BriefModalProps) {
  // Drives the entrance transition — starts false on every mount, flips to
  // true one frame later so the browser has an initial state to animate from.
  const [entered, setEntered] = useState(false);

  // Focus management (parity with OverlaySurface, added without a full rebase):
  // capture the invoking trigger, move focus into the panel on open, trap Tab
  // within it, and restore focus to the trigger on close.
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // ESC to close — onClose is stable (callers use useCallback)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Body scroll lock — shared nest-safe helper that preserves/restores
  // window.scrollY so open/close never jumps the page to the top (doctrine §14).
  useBodyScrollLock(open);

  // Entrance trigger — mount hidden, then animate in on next frame.
  // Both branches set state inside the rAF callback (never synchronously in
  // the effect body) so the component re-arms cleanly for the next open.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(open));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Move focus in on open; restore to the trigger on close/unmount.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      // preventScroll: focusing must never scroll the portalled panel into view.
      (first ?? panel).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      restoreFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  // Tab focus trap — keeps focus within the panel while open.
  function onKeyDownTrap(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    if (nodes.length === 0) { e.preventDefault(); panel.focus(); return; }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const activeEl = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (activeEl === first || !panel.contains(activeEl))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Close button — embedded into the glass rather than floating on top of
  // it. No resting background or border at all; the hit target is still a
  // full 7x7 circle for accessibility, but visually it's just the icon
  // until hover/focus reveal a faint glass disc. Shared between the
  // desktop and mobile header renders below so both stay pixel-identical.
  function closeButton(handleClose: () => void) {
    return (
      <button
        onClick={handleClose}
        className={[
          "w-7 h-7 flex items-center justify-center rounded-full shrink-0",
          "text-[var(--text-muted)]/70 hover:text-[var(--text-primary)]",
          "bg-transparent hover:bg-[var(--surface-hover-strong)]",
          "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]",
        ].join(" ")}
        aria-label="Close"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    );
  }

  return createPortal(
    /*
     * Root — fills the viewport, sits above everything.
     * Backdrop is a separate absolutely-positioned child so clicking it
     * closes the modal without the panel itself triggering the same handler.
     */
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 sm:p-6 md:p-10">

      {/* Backdrop — scrim + blur + a faint navy/meridian ambient glow */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 38%, rgba(59,130,246,0.10), transparent 70%), var(--scrim)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          opacity: entered ? 1 : 0,
          transition: "opacity var(--dur-base) var(--ease-enter)",
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Glass panel — centered, does NOT close on click */}
      <GlassPanel
        as="div"
        ref={panelRef as React.Ref<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDownTrap}
        depth="thick"
        elevation="e4"
        radius="lg"
        glow="meridian"
        className={[
          "w-full",
          wide ? "max-w-3xl" : "max-w-2xl",
          "max-h-[85dvh] overflow-y-auto overflow-x-hidden focus:outline-none",
        ].join(" ")}
        style={{
          background: "var(--modal-surface)",
          backdropFilter: "blur(56px) saturate(180%)",
          WebkitBackdropFilter: "blur(56px) saturate(180%)",
          border: "1px solid var(--border-hairline-strong)",
          boxShadow:
            "var(--shadow-e4), inset 0 1px 0 rgba(255,255,255,.10), inset 0 -1px 32px rgba(0,0,0,.14)",
          opacity: entered ? 1 : 0,
          transform: entered ? "translateY(0) scale(1)" : "translateY(10px) scale(0.97)",
          transition:
            "opacity var(--dur-base) var(--ease-enter), transform var(--dur-base) var(--ease-enter)",
        }}
      >
        {/*
          Internal reflection sheen — a faint diagonal light bleed across the
          upper-left of the panel, like a glass surface catching ambient
          light. Purely decorative (aria-hidden, pointer-events-none) and
          painted first so header/body content — later in DOM order — sits
          above it without any extra z-index bookkeeping.
        */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(125deg, rgba(255,255,255,.08) 0%, rgba(255,255,255,.02) 18%, transparent 38%, transparent 72%, rgba(255,255,255,.04) 100%)",
          }}
        />

        {/*
          Header — no separate tint, no border, no divider. It shares the
          panel's own background exactly (rather than its own blurred plate)
          so the title reads as sitting directly on the glass surface, with
          zero visible seam between header and body. Sticky positioning
          still works because the background is solid enough to mask
          content scrolling underneath; it just no longer looks like a
          second layer. Title sits left; an optional filter/control and the
          close button sit right, grouped together, opposite the title.

          Rendered twice — once for sm-and-up, once for mobile — rather
          than as a single responsive row. On mobile there often isn't
          room for the title, a control like InlineFilter, *and* the close
          button on one line; squeezing them together either truncates the
          title unpredictably or pushes the close button out of the
          panel's safe area. Below sm, the close button stays paired with
          the title on its own row (always visible, always tappable) and
          headerRight — already responsive on its own — drops to a second
          full-width row underneath. Both blocks share the exact same
          background/sticky treatment so there's no visible seam between
          the two render paths.
        */}
        <div
          className="hidden sm:flex sticky top-0 z-10 items-center justify-between gap-4 px-6 md:px-8 py-7"
          style={{ background: "var(--modal-surface)" }}
        >
          <h2 className="min-w-0 truncate text-xl md:text-2xl font-semibold text-[var(--text-primary)] tracking-tight">
            {title}
          </h2>

          <div className="flex items-center gap-4 shrink-0">
            {headerRight}
            {closeButton(onClose)}
          </div>
        </div>

        <div
          className="flex sm:hidden flex-col gap-3 sticky top-0 z-10 px-6 pt-6 pb-5"
          style={{ background: "var(--modal-surface)" }}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="min-w-0 truncate text-xl font-semibold text-[var(--text-primary)] tracking-tight">
              {title}
            </h2>
            {closeButton(onClose)}
          </div>
          {headerRight && <div className="flex justify-end">{headerRight}</div>}
        </div>

        {/* Scrollable body — pt-4 keeps a breath of space below the header
            now that the time filter (when present) lives in the header row
            rather than acting as its own spacer above the content. */}
        <div className="relative px-6 md:px-8 pt-4 pb-8">
          {children}
        </div>
      </GlassPanel>
    </div>,

    document.body,
  );
}
