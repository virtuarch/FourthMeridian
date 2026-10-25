/**
 * lib/platform/notices/maintenance-notice.ts  (UNIFIED NOTICES — the customer maintenance read)
 *
 * IS THE PLATFORM IN MAINTENANCE — as a customer may know it: one boolean.
 *
 * ⚠️ THE SECOND READ-ONLY SURFACE OVER ADMISSION, AND NOTHING MORE. Like the
 * operator surface (lib/platform/policies/operational-controls.ts) it reaches
 * the admission module only to READ the maintenance fact's state through the
 * one fact adapter (`resolveControlPlaneFacts`); it never evaluates admission,
 * never names a key, never writes, and never returns the raw value, the
 * version, the writer, the ingestion pause or the AI kill switch. The census in
 * admission-boundary.test.ts names it and pins all of that.
 *
 * What a customer sees, per fact state:
 *   ON       → true   (maintenance declared)
 *   INVALID  → true   (unreadable ⇒ admission refuses the same work, so the
 *                      same sentence is true: AI and syncing are paused)
 *   OFF / MISSING → false
 *   UNAVAILABLE   → null (we could not tell — the notice shows nothing rather
 *                         than claim maintenance; enforcement is unaffected)
 *
 * Enforcement never reads this: dismissing or failing to load the notice
 * changes nothing about what admission refuses.
 */

import "server-only";
import { resolveControlPlaneFacts, type ControlPlaneReader } from "@/lib/platform/admission/facts";

export async function readMaintenanceNotice(reader?: ControlPlaneReader): Promise<boolean | null> {
  const facts = await resolveControlPlaneFacts(reader);
  switch (facts.maintenanceMode.state) {
    case "ON":
    case "INVALID":
      return true;
    case "OFF":
    case "MISSING":
      return false;
    default:
      return null;
  }
}
