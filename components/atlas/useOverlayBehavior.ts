"use client";

/**
 * components/atlas/useOverlayBehavior.ts
 *
 * The shared, DOMAIN-FREE behavior primitives every Fourth Meridian overlay needs:
 * reduced-motion, escape-to-close, focus capture/restore, initial focus, a Tab focus
 * trap, and mount-through-exit presence. Peer to `useBodyScrollLock` — the two are the
 * only behavior an overlay surface should hand-roll.
 *
 * This is the single home for overlay a11y/motion. `OverlaySurface` (the centered
 * modal primitive) and the `panels/` family (the edge-anchored primitive) both consume
 * these, so there is ONE focus-trap / escape / reduced-motion implementation — not a
 * second behavior language per surface. These hooks know nothing about modals, panels,
 * finance, or any domain; they operate on a ref and a boolean.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

/** The one focusable-element selector used by the focus trap + initial focus. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ── reduced motion ───────────────────────────────────────────────────────────────
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
}

/**
 * `useSyncExternalStore`, not `useState` + `useEffect`: matchMedia IS an external
 * store, so this reads the correct value on the first client render (no wrong-value
 * flash) and never trips react-hooks/set-state-in-effect. `getServerSnapshot` returns
 * false — the honest SSR answer, since the server cannot know.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => (typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(REDUCED_QUERY).matches
      : false),
    () => false,
  );
}

// ── escape-to-close ────────────────────────────────────────────────────────────────
/** Closes on Escape while `active`, unless `disabled` (e.g. an in-flight commit). */
export function useEscapeKey(active: boolean, onClose: () => void, disabled = false): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !disabled) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [active, onClose, disabled]);
}

// ── focus capture / restore ──────────────────────────────────────────────────────
/**
 * Captures the element that had focus when `active` became true and restores focus to
 * it on close/unmount (preventScroll — restoring must never scroll the trigger into
 * view). The overlay's own initial focus is a separate concern (useAutoFocus).
 */
export function useReturnFocus(active: boolean): void {
  const restoreTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    return () => {
      restoreTo.current?.focus?.({ preventScroll: true });
    };
  }, [active]);
}

/**
 * Moves focus INTO the surface when it opens — the first focusable descendant, or the
 * container itself. Deferred to the next frame so the portalled node is in the DOM;
 * preventScroll because the surface is already positioned (focusing must not scroll).
 */
export function useAutoFocus(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  selector: string = FOCUSABLE_SELECTOR,
): void {
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      const first = node.querySelector<HTMLElement>(selector);
      (first ?? node).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [active, ref, selector]);
}

// ── Tab focus trap ───────────────────────────────────────────────────────────────
/**
 * Returns an `onKeyDown` handler that keeps Tab focus within `ref`. Only visible
 * focusables participate (offsetParent !== null), so a hidden control never becomes a
 * dead tab stop. With none, Tab is swallowed and focus parks on the container.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  selector: string = FOCUSABLE_SELECTOR,
): (e: React.KeyboardEvent) => void {
  return useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const node = ref.current;
      if (!node) return;
      const nodes = Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !node.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [ref, selector],
  );
}

// ── presence (mount through exit) ─────────────────────────────────────────────────
export type PresenceState = "entering" | "open" | "exiting";

/**
 * Keeps `open`-driven UI mounted long enough to animate OUT. Returns `mounted` (render
 * or not) and `state` (which transition classes to apply). The consumer never unmounts
 * on `open === false` — it unmounts when this hook says so, `exitMs` later.
 *
 * Both writes happen in a rAF/timeout callback, not the effect body: a synchronous
 * setState in an effect is a second pre-paint render, and for the ENTER case it is also
 * the classic transition bug — mount and "release" land in one frame, the browser never
 * sees two distinct styles, and the entrance silently doesn't play. The rAF guarantees
 * the two frames.
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; state: PresenceState } {
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (open) {
      const r = requestAnimationFrame(() => setSettled(true));
      return () => cancelAnimationFrame(r);
    }
    const t = setTimeout(() => setSettled(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);

  const mounted = open || settled;
  const state: PresenceState = open ? (settled ? "open" : "entering") : "exiting";
  return { mounted, state };
}
