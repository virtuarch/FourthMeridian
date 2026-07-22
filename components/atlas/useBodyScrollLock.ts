/**
 * components/atlas/useBodyScrollLock.ts
 *
 * The one place Fourth Meridian locks background scroll for an overlay.
 *
 * Why fixed-position and not `overflow: hidden` (SCROLL-2, runtime-proven):
 * the app scrolls on the WINDOW (`document.scrollingElement === documentElement`),
 * with a sidebar shell whose body is `min-h-full flex flex-col`. On that layout
 * `document.body.style.overflow = "hidden"` is **inert** — measured live: with it
 * applied, `window.scrollTo(900)` still scrolled the page to 900 and `maxScroll`
 * was unchanged. It neither locks the background nor preserves position. (An
 * earlier fix that toggled body overflow + captured `window.scrollY` therefore
 * did nothing, and the page still jumped toward the top when a portalled modal
 * opened.)
 *
 * The fixed-position technique DOES lock and preserve position (also measured
 * live on the real layout):
 *   - capture `window.scrollY`,
 *   - pin the body: `position: fixed; top: -scrollY; left/right: 0; width: 100%`,
 *     which collapses the document to the viewport (`maxScroll → 0`, truly
 *     locked) while keeping the content visually in place via the `top` offset,
 *   - on release, clear those styles and `window.scrollTo(0, scrollY)` to land
 *     back on the exact original position.
 * This is also the iOS-Safari-correct approach (where `overflow: hidden` on the
 * body famously does not lock).
 *
 * Capture timing: engaged in a layout effect (pre-paint) so `scrollY` is read
 * — and the body pinned — before the browser performs the open-time scroll
 * shift, capturing the pre-jump position rather than the post-jump one.
 *
 * Scrollbar compensation: pinning removes the vertical scrollbar; we add
 * matching `padding-right` so page content doesn't shift horizontally.
 *
 * Nest-safe via reference counting: with several overlays open at once, only
 * the first lock captures the position + pins the body, and only the last
 * release restores it.
 */

import { useEffect, useLayoutEffect } from "react";

// useLayoutEffect on the client (runs before paint, so we pin the body before
// the open-time scroll shift); useEffect on the server to avoid React's SSR
// warning. The overlays are client components, so in practice this is always
// the layout effect.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

let lockCount = 0;
let savedScrollY = 0;
let savedStyles: {
  position: string;
  top: string;
  left: string;
  right: string;
  width: string;
  paddingRight: string;
} | null = null;

function engageLock() {
  if (typeof document === "undefined") return;
  if (lockCount === 0) {
    const b = document.body;
    savedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    // Width of the (about-to-be-removed) vertical scrollbar, so we can pad it
    // back and avoid a horizontal content shift.
    const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
    savedStyles = {
      position: b.style.position,
      top: b.style.top,
      left: b.style.left,
      right: b.style.right,
      width: b.style.width,
      paddingRight: b.style.paddingRight,
    };
    b.style.position = "fixed";
    b.style.top = `-${savedScrollY}px`;
    b.style.left = "0";
    b.style.right = "0";
    b.style.width = "100%";
    if (scrollbarW > 0) b.style.paddingRight = `${scrollbarW}px`;
  }
  lockCount += 1;
}

function releaseLock() {
  if (typeof document === "undefined") return;
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0 && savedStyles) {
    const b = document.body;
    b.style.position = savedStyles.position;
    b.style.top = savedStyles.top;
    b.style.left = savedStyles.left;
    b.style.right = savedStyles.right;
    b.style.width = savedStyles.width;
    b.style.paddingRight = savedStyles.paddingRight;
    savedStyles = null;
    // Restore the exact position the user was at when the overlay opened.
    window.scrollTo(0, savedScrollY);
  }
}

/**
 * Locks background (body) scroll while `active` is true and restores the exact
 * pre-lock scroll position when it becomes false / the component unmounts.
 */
export function useBodyScrollLock(active: boolean): void {
  useIsoLayoutEffect(() => {
    if (!active) return;
    engageLock();
    return releaseLock;
  }, [active]);
}
