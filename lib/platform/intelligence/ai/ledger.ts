/**
 * lib/platform/intelligence/ai/ledger.ts  (Platform AI v0 — the ONE provider seam, ledgered)
 *
 * Every model call of a Platform AI turn goes through the house provider
 * chokepoint `generateWithTools` (lib/ai/provider.ts) — never a parallel AI
 * client — inside an AI invocation context, so:
 *   · the kill switch (paid-requests admission) and the rate card are
 *     re-checked by the chokepoint itself before the provider is reached;
 *   · AiInvocation records cost and outcome with surface `platform_ai`,
 *     sub-surface `platform_ai:ask`, the operator as userId and the turn's
 *     random id as correlationId — METADATA ONLY (no prompt, no answer);
 *   · Economics reads it as Platform AI (PLATFORM_AI_SURFACES), i.e. OVERHEAD,
 *     never customer spend, and the customer allowance never counts it.
 *
 * `deps` is the test seam (a fake client and fake sinks), exactly as for the
 * Comms authoring call (lib/notifications/content/deps.ts makeStructuredCall).
 */

import "server-only";
import { randomUUID } from "node:crypto";
import {
  chatModel, generateWithTools, isAiPausedFailure, usesModernParams, type StructuredClient, type UsageSinks,
} from "@/lib/ai/provider";
import { runWithAiInvocationContext } from "@/lib/ai/invocation-context";
import { TurnTimeoutError } from "@/lib/ai/turn-deadline";
import { PLATFORM_AI_ASK_SURFACE, PLATFORM_AI_SUB_SURFACE, type PlatformAiGenerate } from "./core";

export function makePlatformAiGenerate(args: { operatorId: string; turnId?: string; client?: StructuredClient; sinks?: UsageSinks }): PlatformAiGenerate {
  const correlationId = args.turnId ?? randomUUID();
  const deps = args.client || args.sinks ? { client: args.client, sinks: args.sinks } : undefined;
  return ({ model, messages, tools, maxTokens, signal }) =>
    runWithAiInvocationContext(
      { correlationId, turnIndex: 0, surface: PLATFORM_AI_ASK_SURFACE, subSurface: PLATFORM_AI_SUB_SURFACE, userId: args.operatorId },
      () => generateWithTools({ model, messages, tools, maxTokens, signal }, deps),
    );
}

export function platformAiModel(): { model: string; reasoning: boolean } {
  const model = chatModel();
  return { model, reasoning: usesModernParams(model) };
}

/** A thrown provider error, as a reason CODE (never its message). */
export function classifyPlatformAiFailure(err: unknown): "KILL_SWITCH" | "TIMEOUT" | "PROVIDER" {
  if (err instanceof Error && (err.name === "AiPausedError" || isAiPausedFailure(err.message))) return "KILL_SWITCH";
  if (err instanceof TurnTimeoutError) return "TIMEOUT";
  return "PROVIDER";
}
