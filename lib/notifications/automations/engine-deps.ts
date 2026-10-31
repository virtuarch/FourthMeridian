/**
 * lib/notifications/automations/engine-deps.ts  (Comms Center B2 — the ENGINE's production ports)
 *
 * Kept apart from deps.ts (the HTTP wiring) on purpose: the registered job
 * (jobs/comms-automations.ts) must never pull the route layer — and through it
 * the session gate — into the background import graph
 * (lib/snapshots/background-authority.test.ts, lib/jobs/registry-boundary.test.ts).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { readGlobalCostFreeze } from "@/lib/platform/cost-freeze";
import { getBetaLifecycleStatesForUsers } from "@/lib/entitlements/beta-lifecycle";
import { sendEmail } from "@/lib/email/send";
import { createNotification } from "@/lib/notifications/create";
import { writeDeliveryRow } from "@/lib/notifications/delivery/store";
import { defaultLiveContentResolver } from "@/lib/notifications/content/store";
import { currentJobRun } from "@/lib/jobs/run";
import { admitAutomationSend } from "./admission";
import type { EngineDb, EngineDeps } from "./engine";
import { AUTOMATION_ACTIVATION_ENABLED } from "./types";

/** The engine's production ports (jobs/comms-automations.ts). */
export function productionEngineDeps(): EngineDeps {
  return {
    db: systemDb as unknown as EngineDb,
    freeze: () => readGlobalCostFreeze(),
    // HARDENING A5 — platform admission (COMMS_AUTOMATION_SEND): maintenance stops every pass and every send.
    admission: () => admitAutomationSend(),
    lifecycle: (ids) => getBetaLifecycleStatesForUsers(ids),
    sendEmail,
    createNotification: (input, ctx) => createNotification(input, ctx),
    ledger: writeDeliveryRow,
    content: defaultLiveContentResolver,
    alert: async (kind, detail) => {
      // One fixed, redacted line; the auto-pause itself is the action (every automation is PAUSED / STORM_BREAKER).
      console.error(`[comms-automations] ${kind}: ${detail.accepted} accepted automation sends in the breaker window; ${detail.paused} automation(s) auto-paused`);
    },
    env: process.env,
    appBaseUrl: process.env.NEXT_PUBLIC_APP_URL,
    now: () => new Date(),
    jobRunId: currentJobRun()?.id ?? null,
    activationEnabled: AUTOMATION_ACTIVATION_ENABLED,
  };
}
