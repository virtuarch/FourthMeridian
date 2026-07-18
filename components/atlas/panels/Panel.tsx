"use client";

/**
 * components/atlas/panels/Panel.tsx
 *
 * The canonical Fourth Meridian PANEL primitive — the edge-anchored sibling of the
 * centered `OverlaySurface` (modal). A Panel is a PERSISTENT CONTEXTUAL surface: it
 * preserves the workspace behind it and answers "tell me more" (right / detail) or
 * "what am I operating in" (left / context) — never "pause and complete a decision"
 * (that is a modal; see OverlaySurface / Dialog / ConfirmDialog).
 *
 * Panels are NOT modals and do NOT own domain meaning. This file knows layout,
 * animation, open/close, accessibility, responsiveness, and stacking — nothing about
 * transactions, investments, AI, or workspaces. Domain panels (a holding detail, a
 * transaction detail, an AI context) are COMPOSED from these slots by their domain;
 * this primitive never grows a `<TransactionPanel>`.
 *
 * Reuse, not a second behavior language: the material is `GlassPanel`, the a11y/motion
 * is the shared `useOverlayBehavior` (focus trap / escape / focus capture-restore /
 * reduced-motion) plus `useBodyScrollLock` — the same primitives `OverlaySurface`
 * uses. Only the SPATIAL model differs (edge-docked + slide + presence-driven exit).
 *
 * Direction is a claim about what the surface is (prototype DS-4 §3):
 *   right  DRILL-DOWN detail. Arrives from the far edge, workspace stays put behind a
 *          blurred scrim, narrower. "Here's the detail for what you selected."
 *   left   THE CONTEXT / the thing itself. Wider, lighter scrim (workspace stays
 *          legible beside it), docked like a miniature workspace. "You're operating
 *          in this."
 * On mobile BOTH collapse to one bottom sheet — a phone has one gesture, and
 * left-vs-right is a desktop distinction. One component, CSS-driven; no mobile fork.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { useBodyScrollLock } from "@/components/atlas/useBodyScrollLock";
import {
  usePrefersReducedMotion,
  useEscapeKey,
  useReturnFocus,
  useAutoFocus,
  useFocusTrap,
  usePresence,
} from "@/components/atlas/useOverlayBehavior";
import { PanelContext, type PanelSide, type PanelContextValue } from "./panel-context";
import { usePanelStack } from "./PanelStack";

/** Exit is faster than entrance — leaving should feel decisive (prototype DUR). */
const EXIT_MS = 160;

/** Base overlay layer — mirrors `--z-modal` in app/globals.css. A stacked panel
 *  offsets from here; a modal opened from a panel portals later and paints above. */
const Z_PANEL_BASE = 100;

export type PanelSize = "sm" | "md" | "lg" | "xl";

/** Desktop docked widths. Mobile is always a full-width bottom sheet. */
const WIDTH_CLASS: Record<PanelSize, string> = {
  sm: "sm:w-[400px]",
  md: "sm:w-[480px]",
  lg: "sm:w-[600px]",
  xl: "sm:w-[720px]",
};

export interface PanelProps {
  /** Controlled visibility. Kept mounted through its exit animation, then unmounts. */
  open: boolean;
  onClose: () => void;
  /** Docked edge. Default "right" (detail). "left" is context/navigation. */
  side?: PanelSide;
  /** Desktop width. Defaults by side: left→lg, right→md. */
  size?: PanelSize;
  /**
   * Accessible name used when the panel has no <PanelHeader>. When a <PanelHeader>
   * is present its title becomes the accessible name (aria-labelledby) instead.
   */
  ariaLabel?: string;
  /** Blocks Escape + scrim dismissal (e.g. an in-flight commit). Close button still
   *  calls onClose — the caller guards it. */
  preventClose?: boolean;
  /** Scrim click closes. Default true. */
  closeOnScrim?: boolean;
  /** Explicit stacking override; otherwise derived from <PanelStack> depth. */
  zIndex?: number;
  className?: string;
  children: ReactNode;
}

export function Panel({
  open,
  onClose,
  side = "right",
  size,
  ariaLabel,
  preventClose = false,
  closeOnScrim = true,
  zIndex,
  className = "",
  children,
}: PanelProps) {
  const { mounted, state } = usePresence(open, EXIT_MS);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const [titled, setTitled] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const onKeyDownTrap = useFocusTrap(panelRef);
  const stack = usePanelStack();

  // Shared overlay behavior — identical to the modal's, driven off `open` (not the
  // presence `mounted`, so restore-focus fires when the caller closes, and the lock
  // releases immediately rather than after the exit).
  useEscapeKey(open, onClose, preventClose);
  useBodyScrollLock(open);
  useReturnFocus(open);
  useAutoFocus(open, panelRef);

  // Claim a stacking depth for this panel's lifetime (mount → unmount), so a panel
  // opened from within another layers above it. No <PanelStack> ⇒ depth 0.
  const [depth, setDepth] = useState(0);
  useEffect(() => {
    if (!stack) return;
    // Acquire synchronously (so concurrent opens get distinct depths in mount order);
    // publish to state on the next frame (a one-frame z-index settle is invisible and
    // avoids a synchronous setState in the effect body).
    const d = stack.acquire();
    const raf = requestAnimationFrame(() => setDepth(d));
    return () => {
      cancelAnimationFrame(raf);
      stack.release(d);
    };
  }, [stack]);

  const ctx: PanelContextValue = {
    onClose,
    side,
    preventClose,
    titleId,
    registerTitle: setTitled,
  };

  if (!mounted || typeof document === "undefined") return null;

  const shown = state === "open";
  const left = side === "left";
  const resolvedSize: PanelSize = size ?? (left ? "lg" : "md");
  const resolvedZ = zIndex ?? Z_PANEL_BASE + depth;

  // The slide: mobile is always a bottom sheet (translate-y); desktop slides in from
  // its docked edge (translate-x). Reduced motion drops the transform (opacity only).
  const hiddenTransform = left ? "sm:-translate-x-full" : "sm:translate-x-full";
  const panelTransition = reducedMotion
    ? `opacity var(--dur-fast) ${shown ? "var(--ease-enter)" : "var(--ease-exit)"}`
    : `transform var(--dur-base) ${shown ? "var(--ease-enter)" : "var(--ease-exit)"}, ` +
      `opacity var(--dur-base) ${shown ? "var(--ease-enter)" : "var(--ease-exit)"}`;

  const panelStyle: CSSProperties = {
    opacity: shown ? 1 : 0,
    transition: panelTransition,
    // borderRadius is set responsively via `!` utilities below (mobile rounded-top,
    // desktop square) — unset GlassPanel's inline radius so those win.
    borderRadius: undefined,
  };

  return createPortal(
    <div
      className={`fixed inset-0 flex items-end sm:items-stretch ${
        left ? "sm:justify-start" : "sm:justify-end"
      }`}
      style={{ zIndex: resolvedZ }}
    >
      {/* Scrim. LEFT dims LESS and does not blur — the workspace stays legible beside
          the context. RIGHT dims more and blurs — the detail is the point, the
          workspace is background. */}
      <button
        type="button"
        aria-label="Close panel"
        tabIndex={-1}
        onClick={() => {
          if (closeOnScrim && !preventClose) onClose();
        }}
        className="absolute inset-0 cursor-default"
        style={{
          background: "var(--scrim)",
          backdropFilter: left ? "none" : "blur(3px)",
          WebkitBackdropFilter: left ? "none" : "blur(3px)",
          opacity: shown ? (left ? 0.6 : 1) : 0,
          transition: `opacity var(--dur-fast) ${shown ? "var(--ease-enter)" : "var(--ease-exit)"}`,
        }}
      />

      <GlassPanel
        as="aside"
        depth="thick"
        elevation="e4"
        edge={false}
        className={[
          "relative flex w-full flex-col",
          // Mobile: bottom sheet — full width, capped height, rounded top only.
          "max-h-[92dvh] !rounded-t-[var(--radius-xl)] !rounded-b-none",
          // Desktop: docked full-height to its edge, fixed width, square, hairline seam.
          "sm:h-dvh sm:max-h-none sm:!rounded-none sm:max-w-[92vw]",
          WIDTH_CLASS[resolvedSize],
          left ? "sm:border-r sm:border-[var(--border-hairline-strong)]" : "sm:border-l sm:border-[var(--border-hairline-strong)]",
          "will-change-transform",
          // Slide state: hidden ⇒ off-edge (desktop) / below (mobile); shown ⇒ home.
          shown
            ? "translate-y-0 sm:translate-x-0"
            : reducedMotion
              ? ""
              : `translate-y-full sm:translate-y-0 ${hiddenTransform}`,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={panelStyle}
      >
        <PanelContext.Provider value={ctx}>
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titled ? titleId : undefined}
            aria-label={titled ? undefined : ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDownTrap}
            // SCROLL-1 fix (same root cause as OverlaySurface): GlassPanel wraps
            // children in a plain `relative z-10` block (no flex, no height), which
            // breaks any height:100% chain passing through it — so `h-full` here
            // collapsed to auto, this column became content-height, and
            // PanelContent's `flex-1 min-h-0 overflow-y-auto` never bounded (long
            // lists clipped instead of scrolling). Carry the same DEFINITE
            // viewport-relative caps the GlassPanel frame uses directly on this
            // inner flex column (mobile sheet cap → desktop full dvh), so the body
            // has a real height to overflow against. Header/footer stay shrink-0.
            className="flex min-h-0 flex-col outline-none max-h-[92dvh] sm:h-dvh sm:max-h-none"
          >
            {/* Mobile grab handle — signals the bottom sheet is draggable-feeling;
                hidden on desktop where the panel is edge-docked. */}
            <div className="flex justify-center pt-2.5 sm:hidden" aria-hidden>
              <div className="h-1 w-9 rounded-full bg-[var(--border-hairline-strong)]" />
            </div>
            {children}
          </div>
        </PanelContext.Provider>
      </GlassPanel>
    </div>,
    document.body,
  );
}
