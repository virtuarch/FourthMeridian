/**
 * lib/platform/intelligence/ai/assessment/incident.server.ts  (Incident drawer PR-D — the Production wiring)
 *
 * The two assessment routes (POST …/platform-ops/incidents/[id]/assessment and
 * …/customer-success/incidents/[id]/assessment) guard, limit and mint in their OWN function (the
 * guard-provenance pins), then hand this file:
 *   · `recovery` — the drawer's own read for that guard's token (recoveryActionsFor at the tier);
 *   · `access`   — the area's fresh scope + binding (conversations/area-access.ts conversationAreaAccess:
 *                  the ONE scope rule, never break-glass), from which THE turn boundary is built here —
 *                  the incidents pack only, the pack flag re-read per call, the per-call fresh recheck,
 *                  the P5 fail-closed audit writer (the CS tool's PLATFORM_AI_RECORD_VIEWED row).
 * The admission gates are the ask route's, unchanged: paid-requests admission (kill switch), the global
 * cost freeze, the per-operator daily turn cap, the $ caps reservation (with the runner's model). The
 * model call is the ledgered seam (makePlatformAiGenerate: surface platform_ai, THIS assessment's own
 * correlation id ⇒ exactly one turn on the daily cap). Logs: codes only.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import type { PlatformArea } from "@prisma/client";
import { env } from "@/lib/env";
import { readPaidRequestsAdmission } from "@/lib/platform/ai/paid-requests-admission";
import { readGlobalCostFreeze } from "@/lib/platform/cost-freeze";
import { readPlatformAiTurns } from "@/lib/platform/ai/platform-ai-turns";
import { reservePlatformAiSpend } from "@/lib/platform/ai/platform-ai-spend";
import { createTurnBoundary, type ScopedArea } from "../authz/boundary";
import { platformAiFreshRecheck } from "../authz/recheck.server";
import { platformAiToolAudit } from "../authz/audit";
import { platformAiPackEnabled } from "../engine/router";
import type { PlatformAiBinding } from "../core";
import { makePlatformAiGenerate, platformAiModel } from "../ledger";
import { investigateForAssessment, type AssessmentTier, type IncidentAssessmentDeps, type RecoveryKind } from "./incident";

export const INCIDENT_ASSESSMENT_ROUTE_KEY = "incident-ai-assessment";

export function incidentAssessmentDeps(input: {
  tier: AssessmentTier;
  operatorId: string;
  incidentId: string;
  recovery(): Promise<readonly RecoveryKind[] | null>;
  access(): Promise<{ binding: PlatformAiBinding; area?: PlatformArea; scope?: ScopedArea } | null>;
}): IncidentAssessmentDeps {
  const correlationId = randomUUID();
  const { model, reasoning } = platformAiModel();
  const area: PlatformArea = input.tier === "cs" ? "CUSTOMER_SUCCESS" : "PLATFORM_OPS";
  return {
    enabled: env.isPlatformAiPackIncidentsEnabled,
    tier: input.tier,
    operatorId: input.operatorId,
    recovery: input.recovery,
    admission: () => readPaidRequestsAdmission(),
    freeze: () => readGlobalCostFreeze(),
    turns: (id, now) => readPlatformAiTurns(id, now),
    spend: (id, now) => reservePlatformAiSpend(id, now, { model }),
    investigate: async () => {
      const a = await input.access();
      if (!a || a.area !== area || !a.scope) return { status: "MISSING", records: [] };
      const boundary = createTurnBoundary({
        operatorId: input.operatorId, correlationId, areas: [{ scope: a.scope, binding: a.binding }], binding: a.binding,
        recheck: platformAiFreshRecheck,
        packs: ["incidents"],
        packEnabled: (p) => platformAiPackEnabled(p),
        onDenial: (r) => console.warn(`[platform-ai] tool refused: tool=${r.tool} pack=${r.pack} reason=${r.reason} (${INCIDENT_ASSESSMENT_ROUTE_KEY})`),
        audit: platformAiToolAudit(),
      });
      return investigateForAssessment(boundary, input.tier, input.incidentId);
    },
    generate: makePlatformAiGenerate({ operatorId: input.operatorId, turnId: correlationId }),
    model,
    reasoningModel: reasoning,
    now: () => new Date(),
    trace: (line) => console.info(`[platform-ai] assessment ${line} (${INCIDENT_ASSESSMENT_ROUTE_KEY})`),
  };
}
