/**
 * lib/notifications/automations/deps.ts  (Comms Center B2 — the production wiring)
 *
 * The rate buckets, the store over fm_system, the dry-run and engine readers
 * (the GLOBAL cost freeze — readGlobalCostFreeze, uncached — and the per-user
 * lifecycle batch — getBetaLifecycleStatesForUsers), and the two delivery
 * chokepoints (createNotification, sendEmail). The gates are called in each
 * route file, where the route-guard census can see them. Tests build their own
 * services over the in-memory Prisma fake and fake transports.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { limitByUser } from "@/lib/rate-limit";
import { recordOperatorAction } from "@/lib/audit";
import { readGlobalCostFreeze } from "@/lib/platform/cost-freeze";
import { getBetaLifecycleStatesForUsers } from "@/lib/entitlements/beta-lifecycle";
import { sendEmail } from "@/lib/email/send";
import { createNotification } from "@/lib/notifications/create";
import { writeDeliveryRow } from "@/lib/notifications/delivery/store";
import { defaultLiveContentResolver } from "@/lib/notifications/content/store";
import { contentServices } from "@/lib/notifications/content/deps";
import { currentJobRun } from "@/lib/jobs/run";
import * as store from "./store";
import { CS_COMMS_DRYRUN_BUCKET, CS_COMMS_DRYRUN_LIMIT, CS_COMMS_TEST_BUCKET, CS_COMMS_TEST_LIMIT, type AutomationServices } from "./http";
import type { EngineDb, EngineDeps } from "./engine";

export const csCommsDryRunLimit = (userId: string) => limitByUser(userId, CS_COMMS_DRYRUN_BUCKET, CS_COMMS_DRYRUN_LIMIT);
export const csCommsTestLimit = (userId: string) => limitByUser(userId, CS_COMMS_TEST_BUCKET, CS_COMMS_TEST_LIMIT);

const engineDb = systemDb as unknown as EngineDb;
const lifecycle = (ids: readonly string[]) => getBetaLifecycleStatesForUsers(ids);

export const automationServices: AutomationServices = {
  store,
  dryRun: { db: engineDb, freeze: () => readGlobalCostFreeze(), lifecycle, content: defaultLiveContentResolver },
  content: contentServices,
  liveContent: defaultLiveContentResolver,
  ledger: writeDeliveryRow,
  ledgerEnv: process.env,
  sendEmail,
  createNotification: (input, ctx) => createNotification(input, ctx),
  auditTestSend: async (row) => {
    const tx = systemDb as unknown as { $transaction<T>(fn: (tx: Parameters<typeof recordOperatorAction>[0]) => Promise<T>): Promise<T> };
    const { id } = await tx.$transaction((t) => recordOperatorAction(t, row));
    if (!id) throw new Error("comms test-send: the audit row returned no id");
    return id;
  },
};

/** The engine's production ports (jobs/comms-automations.ts). */
export function productionEngineDeps(): EngineDeps {
  return {
    db: engineDb,
    freeze: () => readGlobalCostFreeze(),
    lifecycle,
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
  };
}
