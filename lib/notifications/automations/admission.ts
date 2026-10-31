/**
 * lib/notifications/automations/admission.ts  (Comms Center B2 HARDENING A5 — the admission guard)
 *
 * MAY AN AUTOMATION PASS BEGIN, AND MAY THIS AUTOMATION SEND GO OUT? Contract v1.1 §6.6
 * names "admission" at trigger (step 4) and at send (step 2). The platform's ONE admission
 * authority (lib/platform/admission) decides it for the COMMS_AUTOMATION_SEND work class:
 * maintenance_mode denies it, ingestion_paused does not (an automation calls no data
 * provider), and an unreadable or unavailable control plane denies it (fail closed).
 *
 * This module is the class's ONLY consumer (censused in admission-boundary.test.ts). The
 * engine never imports the admission module itself: it receives this function as a port
 * (EngineDeps.admission), so its tests inject a verdict and the census stays closed.
 *
 * fm_system: PlatformSetting is an operator table; the read is a key lookup.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { admitOperationalWork, type ControlPlaneReader } from "@/lib/platform/admission/facts";

/** What the engine needs from a verdict: admitted, or the typed reason it was not. Never content. */
export interface AutomationAdmission {
  admitted: boolean;
  /** The admission verdict's reason (carried through from the evaluator, never re-typed); "UNAVAILABLE" when the check itself failed; null when admitted. */
  reason: string | null;
}

interface SettingClient {
  platformSetting: { findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>> };
}

/** One read per call, uncached: a maintenance declaration is visible to the very next send. Never throws (fail closed). */
export async function admitAutomationSend(client: SettingClient = systemDb as unknown as SettingClient): Promise<AutomationAdmission> {
  const reader: ControlPlaneReader = {
    async read(keys) {
      const rows = await client.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
  };
  try {
    const v = await admitOperationalWork({ work: "COMMS_AUTOMATION_SEND" }, reader);
    return v.decision === "ADMIT" ? { admitted: true, reason: null } : { admitted: false, reason: v.reason ?? "UNAVAILABLE" };
  } catch {
    return { admitted: false, reason: "UNAVAILABLE" };
  }
}
