/**
 * components/atlas/useBodyScrollLock.ts
 *
 * The one place Fourth Meridian locks background scroll for an overlay.
 *
 * Why this exists (doctrine §14): the app scrolls on the window, and its body
 * is `min-h-full flex flex-col` under `html { height: 100% }`. Setting
 * `document.body.style.overflow = "hidden"` on that layout collapses the flex
 * body to the viewport height and clips the overflow, which forces
 * `window.scrollY` to 0 — so a bare overflow toggle makes the page jump to the
 * top on open and reveals the top on close. (SpaceDashboard previously worked
 * around this by hand with a scrollY save/restore.)
 *
 * This hook locks scroll AND preserves the exact scroll position:
 *   - captures `window.scrollY` when the first lock engages,
 *   - sets `body { overflow: hidden }`,
 *   - on release, restores the previous overflow value and `scrollTo`s back to
 *     the captured position.
 *
 * Nest-safe via reference counting: if several overlays are open at once (e.g.
 * a FormModal launched from another modal), only the first lock captures the
 * position and only the last release restores it — intermediate opens/closes
 * don't fight over the body style or scroll position.
 */

import { useEffect } from "react";

let lockCount = 0;
let savedScrollY = 0;
let savedOverflow = "";

function engageLock() {
  if (typeof document === "undefined") return;
  if (lockCount === 0) {
    savedScrollY = window.scrollY;
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
}

function releaseLock() {
  if (typeof document === "undefined") return;
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0) {
    document.body.style.overflow = savedOverflow;
    // Restore the exact position the user was at when the overlay opened.
    window.scrollTo(0, savedScrollY);
  }
}

/**
 * Locks background (body) scroll while `active` is true and restores the exact
 * pre-lock scroll position when it becomes false / the component unmounts.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    engageLock();
    return releaseLock;
  }, [active]);
}
