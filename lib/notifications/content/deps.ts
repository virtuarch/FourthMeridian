/**
 * lib/notifications/content/deps.ts  (Comms Center B1 — the production wiring)
 *
 * The rate buckets (contract v1.1 §3.1), the store over fm_system, the AI gate
 * readers and the ONE model call. The gates themselves are called in each route
 * file, where the route-guard census can see them. Tests build their own
 * ContentServices over the in-memory Prisma fake and a fake AI client.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { systemDb } from "@/lib/db";
import { limitByUser } from "@/lib/rate-limit";
import { generateStructuredWithUsage, type StructuredClient, type UsageSinks } from "@/lib/ai/provider";
import { runWithAiInvocationContext } from "@/lib/ai/invocation-context";
import { readPaidRequestsAdmission } from "@/lib/platform/ai/paid-requests-admission";
import { readGlobalCostFreeze } from "@/lib/platform/cost-freeze";
import {
  CS_COMMS_AI_BUCKET, CS_COMMS_AI_LIMIT, CS_COMMS_CONTROL_BUCKET, CS_COMMS_CONTROL_LIMIT, CS_COMMS_RENDER_BUCKET, CS_COMMS_RENDER_LIMIT,
  CS_COMMS_WRITE_BUCKET, CS_COMMS_WRITE_LIMIT, type AiServices, type ContentServices,
} from "./http";
import { COMMS_AUTHORING_SURFACE, readAuthoringAllowance, reserveAuthoringCall } from "./ai-allowance";
import { listVersionRows, liveVersionNumber, publishVersion, readHeads, readStream, readVersion, recordSuggestion, rollbackVersion, saveDraft } from "./store";

export const csCommsRenderLimit = (userId: string) => limitByUser(userId, CS_COMMS_RENDER_BUCKET, CS_COMMS_RENDER_LIMIT);
export const csCommsWriteLimit = (userId: string) => limitByUser(userId, CS_COMMS_WRITE_BUCKET, CS_COMMS_WRITE_LIMIT);
export const csCommsAiLimit = (userId: string) => limitByUser(userId, CS_COMMS_AI_BUCKET, CS_COMMS_AI_LIMIT);
export const csCommsControlLimit = (userId: string) => limitByUser(userId, CS_COMMS_CONTROL_BUCKET, CS_COMMS_CONTROL_LIMIT);

/**
 * The model call: the one provider seam (generateStructuredWithUsage — the kill
 * switch and the rate card are re-checked there), inside an AI invocation
 * context so the AiInvocation ledger records cost and outcome under surface
 * "comms_authoring" (never content). `deps` is the test seam (a fake client).
 */
export function makeStructuredCall(deps?: { client?: StructuredClient; sinks?: UsageSinks }): AiServices["call"] {
  return async ({ suggestionId, operatorId, mode, system, messages, schema }) =>
    runWithAiInvocationContext(
      { correlationId: suggestionId, surface: COMMS_AUTHORING_SURFACE, subSurface: `${COMMS_AUTHORING_SURFACE}:${mode === "POLISH" ? "polish" : "check"}`, userId: operatorId },
      async () => {
        const r = await generateStructuredWithUsage<unknown>(system, messages, schema, undefined, deps);
        return { value: r.value, model: r.model };
      },
    );
}

export const productionAiServices: AiServices = {
  admission: () => readPaidRequestsAdmission(),
  freeze: () => readGlobalCostFreeze(),
  readAllowance: (id, now) => readAuthoringAllowance(id, now),
  reserve: (id, now) => reserveAuthoringCall(id, now),
  call: makeStructuredCall(),
  newId: () => randomUUID(),
};

interface SelfReadClient { user: { findUnique(args: unknown): Promise<{ email: string; emailVerifiedAt: Date | null } | null> } }

export const contentServices: ContentServices = {
  readStream: (s) => readStream(s),
  listVersionRows: (templateId) => listVersionRows(templateId, { beforeVersion: null, limit: 1000 }),
  readVersion: (key, id) => readVersion(key, id),
  readHeads: (key) => readHeads(key),
  liveVersionNumber: (head) => liveVersionNumber(head),
  saveDraft: (input) => saveDraft(input),
  publishVersion: (input) => publishVersion(input),
  rollbackVersion: (input) => rollbackVersion(input),
  recordSuggestion: (stream, row, actor, reason) => recordSuggestion(stream, row, actor, reason),
  // The operator's OWN row (test-send eligibility); fm_system like the rest of the console.
  readSelf: async (userId) => {
    const u = await (systemDb as unknown as SelfReadClient).user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
    return u ? { email: u.email, verified: u.emailVerifiedAt !== null } : null;
  },
  env: process.env as ContentServices["env"],
  ai: productionAiServices,
};
