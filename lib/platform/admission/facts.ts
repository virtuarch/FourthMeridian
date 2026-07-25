/**
 * lib/platform/admission/facts.ts  (OPS-2D-3)
 *
 * The impure half: resolve control-plane facts from their authority, hand them
 * to the pure evaluator, stamp the moment. Contributes I/O and a clock and
 * nothing else — no decision is taken here.
 *
 * AUTHORITY: `PlatformSetting`, deliberately reused rather than replaced.
 * Investigated before writing this: it is already a typed-key registry with
 * declared defaults, an existing admin mutation surface, audit coverage, and no
 * competing store. A second settings table would have bought a JSON value shape
 * and cost a second place to look for "what did the operator declare", which is
 * the exact failure the platform keeps a single authority to avoid.
 *
 * Read DIRECTLY rather than through getSetting(): that helper resolves a missing
 * row to its default, which collapses MISSING into OFF before admission can see
 * the difference. Admission needs the five states apart — "nobody ever set this"
 * and "someone set something unreadable" get different answers.
 */

import "server-only";

import { db } from "@/lib/db";
import { PlatformSettingKey } from "@/lib/platform-settings";
import { evaluateAdmission, readFactState } from "./policy-core";
import type {
  AdmissionRequest,
  ControlPlaneFacts,
  StampedAdmissionVerdict,
} from "./types";

/** Minimal read seam, so tests exercise this adapter without a database. */
export interface ControlPlaneReader {
  read(keys: string[]): Promise<Record<string, string>>;
}

const settingReader: ControlPlaneReader = {
  async read(keys) {
    const rows = await db.platformSetting.findMany({
      where:  { key: { in: keys } },
      select: { key: true, value: true },
    });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
};

const KEYS = {
  maintenanceMode: PlatformSettingKey.MAINTENANCE_MODE,
  ingestionPaused: PlatformSettingKey.INGESTION_PAUSED,
} as const;

/**
 * Resolve every control-plane fact in ONE read.
 *
 * One query, not one per key: two reads could observe different moments and
 * produce a verdict describing a platform state that never existed.
 *
 * A read failure is a FACT, not an exception. Every key resolves to UNAVAILABLE
 * and the pure core decides what that means — which keeps "we could not tell"
 * inside the decision model instead of leaking as a thrown error that each
 * producer would have to interpret for itself, differently.
 */
export async function resolveControlPlaneFacts(
  reader: ControlPlaneReader = settingReader,
): Promise<ControlPlaneFacts> {
  let values: Record<string, string> | null = null;
  try {
    values = await reader.read(Object.values(KEYS));
  } catch {
    values = null;
  }
  if (values === null) {
    return {
      maintenanceMode: { key: KEYS.maintenanceMode, state: "UNAVAILABLE", raw: null },
      ingestionPaused: { key: KEYS.ingestionPaused, state: "UNAVAILABLE", raw: null },
    };
  }
  return {
    maintenanceMode: readFactState(KEYS.maintenanceMode, values[KEYS.maintenanceMode] ?? null),
    ingestionPaused: readFactState(KEYS.ingestionPaused, values[KEYS.ingestionPaused] ?? null),
  };
}

/**
 * The route/job-facing entry point: may this work begin now?
 *
 * Consults NO session, role, grant or capability — by construction, not by
 * convention. That is what keeps authorization and admission separate, and it is
 * why a CONTROL holder is subject to the pause they declared and why
 * SYSTEM_ADMIN is not an admission bypass. Both facts are asserted structurally
 * in admission-boundary.test.ts.
 */
export async function admitOperationalWork(
  request: AdmissionRequest,
  reader: ControlPlaneReader = settingReader,
): Promise<StampedAdmissionVerdict> {
  const facts = await resolveControlPlaneFacts(reader);
  return { ...evaluateAdmission(request, facts), evaluatedAt: new Date().toISOString() };
}
