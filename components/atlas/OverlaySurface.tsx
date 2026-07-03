"use client";

/**
 * components/atlas/OverlaySurface.tsx
 *
 * Canonical Atlas Glass overlay primitive — the single surface that owns
 * modal *behaviour* for Fourth Meridian. Peer to GlassPanel and DataCard.
 *
 * Established by docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md. This is
 * Phase 1 of that roadmap: the primitive is introduced ADDITIVELY and wired
 * to nothing. No existing modal imports it yet; migrating the current modal
 * family (AddWalletModal, TotpSection, …) onto it happens in later phases.
 *
 * What this primitive centralises — the concerns each of today's ~8 modal
 * recipes re-implements (and each gets slightly wrong):
 *
 *   - Portal into document.body. This is the fix for the "Add Wallet opens
 *     pinned to the top" defect: a `position: fixed` overlay resolves
 *     against the nearest ancestor that has transform/filter/backdrop-filter
 *     as its containing block, and GlassPanel (backdrop-filter) is used
 *     pervasively — so an inline-rendered modal lands relative to a glass
 *     card, not the viewport. BriefModal already documents and solves this;
 *     the primitive generalises it.
 *   - Scrim + backdrop blur, backdrop-click to close (guarded).
 *   - Centered on desktop; intent-driven sheet / full-screen on mobile.
 *   - GlassPanel material (thick / e4 / xl) — the design language's "E4 —
 *     Modal" elevation.
 *   - Three-zone flex layout: fixed header, scrolling body, fixed footer —
 *     the height cap lives on the PANEL and the body scrolls internally.
 *     This is the fix for the "2FA modal clips vertically" defect (that
 *     surface has no max-height and no scroll container at all).
 *   - Body scroll lock while open (+ restore).
 *   - Focus: move focus in on open, trap for the surface's lifetime, return
 *     to the invoking trigger on close.
 *   - role="dialog" (or "alertdialog") + aria-modal + aria-labelledby.
 *   - Escape to close (respecting a busy / preventClose guard).
 *   - Calm entrance (fade + ≤8px rise), no positional movement under
 *     prefers-reduced-motion.
 *   - Layering from named z-index tokens (see globals.css --z-modal*).
 *
 * Presentation intent (not a new primitive per feature — see doctrine §2):
 *   - "dialog"    → short, bounded. Mobile: bottom sheet sized to content.
 *   - "form"      → data entry. Mobile: full-screen.
 *   - "workspace" → large / tool-like. Mobile: full-screen. Desktop: wide.
 *
 * The edge-anchored Drawer variant (ProviderDiagnosticsDrawer) is a future
 * refinement (doctrine Phase 6) and is intentionally NOT implemented here to
 * keep Phase 1 focused; centered anchoring only.
 *
 * Thin presets Dialog / FormModal live alongside this file and set
 * intent-specific defaults over this primitive.
 */

import {
  ReactNode,
  ElementType,
  CSSProperties,
  useEffect,
  useRef,
  useState,
  useId,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { useBodyScrollLock } from "@/components/atlas/useBodyScrollLock";

export type OverlayIntent = "dialog" | "form" | "workspace";
export type OverlaySize = "sm" | "md" | "lg" | "xl" | "full";

/** Desktop max-width ladder — the scale GlassModal already proved out. */
const WIDTH_CLASS: Record<OverlaySize, string> = {
  sm:   "sm:max-w-md",     // ≈448px — confirmations / small dialogs
  md:   "sm:max-w-xl",     // ≈576px — standard forms
  lg:   "sm:max-w-3xl",    // ≈768px — dense forms / detail
  xl:   "sm:max-w-5xl",    // ≈1024px — workspace overlays
  full: "sm:max-w-[96vw]", // immersive
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface OverlaySurfaceProps {
  /** Controlled visibility. When false the primitive renders nothing. */
  open: boolean;
  onClose: () => void;
  /** Accessible name; rendered as the header title unless `hideHeader`. */
  title: string;
  subtitle?: string;
  icon?: ElementType;
  /**
   * Optional control rendered in the header row opposite the title, to the
   * left of the built-in close button (e.g. a time-range filter). Additive:
   * when omitted the header is byte-for-byte identical to before, so existing
   * consumers are unaffected. Introduced so header-anchored controls (as
   * BriefModal has) can converge onto this primitive without moving them into
   * the toolbar row.
   */
  headerRight?: ReactNode;
  intent?: OverlayIntent;
  size?: OverlaySize;
  /** Optional sub-nav / filter row between header and body. */
  toolbar?: ReactNode;
  /** Optional sticky footer (typically the action bar). */
  footer?: ReactNode;
  children: ReactNode;
  /**
   * Blocks Escape and backdrop-click dismissal (e.g. while an async commit
   * is in flight, or when there are unsaved changes). The close control in
   * the header still calls onClose — callers guard that themselves, as
   * CreateSpaceModal already does.
   */
  preventClose?: boolean;
  /** Backdrop click closes. Default true for dialog/form, false for workspace. */
  closeOnBackdrop?: boolean;
  /** "alertdialog" for destructive confirmations; defaults to "dialog". */
  role?: "dialog" | "alertdialog";
  /** Hide the built-in header (caller renders its own inside children). */
  hideHeader?: boolean;
  /**
   * Keep the header (title/icon) but omit the built-in close button. For
   * flows whose dismissal is only via explicit in-content actions, or that
   * must not be dismissable at a given step (e.g. enforced 2FA setup). Pair
   * with preventClose to also block Escape / backdrop.
   */
  hideClose?: boolean;
  /** Restrained ambient bloom, passed through to GlassPanel. */
  glow?: "none" | "meridian" | "brass" | "coral" | "violet" | "ai";
  /**
   * Explicit stacking override. Defaults to the --z-modal token. Used to
   * raise this surface above another, not-yet-migrated overlay during the
   * modal-doctrine transition (e.g. AddWalletModal opened from within the
   * still-legacy CreateSpaceModal, which sits at z-[200]). Prefer the named
   * token layers once all hosting modals are on the primitive.
   */
  zIndex?: number;
  className?: string;
}

/** matchMedia-based reduced-motion check (SSR-safe). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function OverlaySurface({
  open,
  onClose,
  title,
  subtitle,
  icon: Icon,
  headerRight,
  intent = "form",
  size = "md",
  toolbar,
  footer,
  children,
  preventClose = false,
  closeOnBackdrop,
  role = "dialog",
  hideHeader = false,
  hideClose = false,
  glow = "none",
  zIndex,
  className = "",
}: OverlaySurfaceProps) {
  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const reducedMotion = usePrefersReducedMotion();

  // Portal target only exists on the client. Flip the flag inside a rAF
  // callback (not synchronously in the effect body) so we don't trigger a
  // cascading render on mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Escape to close — guarded by preventClose.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !preventClose) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, preventClose]);

  // Body scroll lock — shared nest-safe helper that also preserves and
  // restores window.scrollY, so opening/closing never jumps the page to the
  // top (see useBodyScrollLock / doctrine §14).
  useBodyScrollLock(open);

  // Focus: capture the trigger, move focus in, restore on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    // Defer so the portalled panel is in the DOM.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      // preventScroll: focusing must never scroll the page/panel into view —
      // the surface is already fixed + centered (doctrine §14).
      (first ?? panel).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      // preventScroll: restoring focus to the trigger must not scroll it into
      // view / shift the page on close.
      restoreFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  // Entrance trigger — mount hidden, animate in next frame.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(open));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open || !mounted) return null;

  // Tab focus trap — keeps focus within the panel.
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
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const backdropCloses =
    closeOnBackdrop ?? (intent !== "workspace");

  // Mobile presentation: dialog = bottom sheet sized to content; form /
  // workspace = full-screen. Desktop is always a centered floating surface.
  const fullscreenMobile = intent !== "dialog";
  const overlayAlign = fullscreenMobile
    ? "items-stretch sm:items-center justify-center"
    : "items-end sm:items-center justify-center";

  // Height: the cap lives on the PANEL (the correct location — some current
  // modals mistakenly cap an inner wrapper, which is why they clip).
  const desktopHeight =
    size === "full" ? "sm:h-[92dvh]" : "sm:h-auto sm:max-h-[88dvh]";
  const mobileHeight = fullscreenMobile
    ? "h-[100dvh] sm:h-auto"                 // full-screen form / workspace
    : "h-auto max-h-[92dvh] sm:max-h-none";  // content-sized bottom sheet

  const panelStyle: CSSProperties = {
    opacity: entered ? 1 : 0,
    transform:
      reducedMotion || entered ? "translateY(0)" : "translateY(8px)",
    transition: reducedMotion
      ? "opacity var(--dur-fast) var(--ease-enter)"
      : "opacity var(--dur-base) var(--ease-enter), transform var(--dur-base) var(--ease-enter)",
  };

  return createPortal(
    <div
      className={`fixed inset-0 flex ${overlayAlign} p-0 sm:p-4`}
      style={{
        zIndex: zIndex ?? ("var(--z-modal)" as unknown as number),
        background: "var(--scrim)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        opacity: entered ? 1 : 0,
        transition: "opacity var(--dur-fast) var(--ease-enter)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropCloses && !preventClose) onClose();
      }}
    >
      <GlassPanel
        as="div"
        ref={panelRef as React.Ref<HTMLElement>}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        depth="thick"
        elevation="e4"
        radius="xl"
        glow={glow}
        onKeyDown={onKeyDownTrap}
        className={`w-full ${WIDTH_CLASS[size]} ${mobileHeight} ${desktopHeight} flex flex-col focus:outline-none ${className}`}
        style={panelStyle}
      >
        {/* SCROLL-1 fix (doctrine §8.10 / §13): carry the dvh-based height cap
            on THIS inner flex container rather than relying on `h-full`.
            GlassPanel wraps children in a plain `relative z-10` block (no flex,
            no height), which breaks any height:100% chain passing through it —
            so `h-full` here collapsed to auto, the column became content-height,
            and the body's `flex-1 min-h-0 overflow-y-auto` never bounded (tall
            modals like CreateSpace clipped instead of scrolling). The
            viewport-relative caps are definite, so the body now has a real
            height to overflow. Panel classes are unchanged. */}
        <div className={`min-h-0 flex flex-col p-5 ${mobileHeight} ${desktopHeight}`}>
          {!hideHeader && (
            <div className="flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                {Icon && (
                  <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center shrink-0">
                    <Icon size={15} className="text-[var(--text-secondary)]" />
                  </div>
                )}
                <div className="min-w-0">
                  <p
                    id={titleId}
                    className="text-sm font-semibold text-[var(--text-primary)] truncate"
                  >
                    {title}
                  </p>
                  {subtitle && (
                    <p className="text-xs text-[var(--text-muted)] truncate">{subtitle}</p>
                  )}
                </div>
              </div>
              {/* Right cluster: optional headerRight control + close button.
                  With no headerRight the cluster wraps only the close button,
                  so output is identical to the pre-headerRight header. */}
              <div className="flex items-center gap-2 shrink-0">
                {headerRight}
                {!hideClose && (
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors touch-manipulation shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Screen-reader label when the header is hidden. */}
          {hideHeader && <span id={titleId} className="sr-only">{title}</span>}

          {toolbar && <div className="shrink-0 mt-3">{toolbar}</div>}

          {/* Body — the only scrolling region. */}
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden mt-4 -mx-1 px-1">
            {children}
          </div>

          {footer && (
            <div
              className="shrink-0 mt-4 pt-4 border-t border-[var(--border-hairline)]"
              style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            >
              {footer}
            </div>
          )}
        </div>
      </GlassPanel>
    </div>,
    document.body
  );
}
