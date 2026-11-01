/**
 * components/platform/comms/unsaved-content.ts  (Customer Success — Communications Center › the unsaved-content guard)
 *
 * ONE page-wide flag: does a content editor hold unsaved text right now? The
 * Library drawer sets it; anything that would unmount the drawer — closing it,
 * opening another row, switching the Comms view (Library → Automations …) or
 * the Platform workspace — asks `confirmLeaveCommsContent()` first. A tiny
 * module store on purpose: the dashboard needs one boolean, not a context
 * threaded through every lead. Client-only state; no I/O.
 */

import { DISCARD_CONTENT_TEXT } from "./content-model";

let dirty = false;

export function setUnsavedCommsContent(next: boolean): void { dirty = next; }
export function hasUnsavedCommsContent(): boolean { return dirty; }

/** True ⇒ go ahead (nothing unsaved, or the operator chose to discard; the flag is cleared). */
export function confirmLeaveCommsContent(confirm: (text: string) => boolean = (t) => typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(t) : true): boolean {
  if (!dirty) return true;
  if (!confirm(DISCARD_CONTENT_TEXT)) return false;
  dirty = false;
  return true;
}
