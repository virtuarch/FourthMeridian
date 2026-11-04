/**
 * app/api/platform/ai/conversations/turn-runner.ts  (B11 — the REAL turn seam; not a route)
 *
 * The handlers' `runTurn` (lib/platform/intelligence/ai/conversations/handlers.ts
 * TurnRunDeps): loads the ONE conversation's stored COMPLETE messages (the data
 * module, withTenantDb as the operator), then runs runConversationTurn with
 *   · the binding from `access` — the conversation's OWN area, FRESH, built by
 *     ./area-access.ts from its own guard result (never the request, never the row);
 *   · the ledgered provider seam (makePlatformAiGenerate): surface platform_ai
 *     (overhead, the same per-operator daily cap), sub-surface
 *     platform_ai:conversation, a fresh correlationId per turn and the
 *     conversation's id as AiInvocation.conversationId (metadata only).
 * Runs OUTSIDE any transaction (design §5.2). Logs METADATA ONLY: the v0 trace
 * line (tool codes, registry ids, counts) — never a question, answer, label or id.
 */

import "server-only";

import { classifyPlatformAiFailure, makePlatformAiGenerate, platformAiModel } from "@/lib/platform/intelligence/ai/ledger";
import { runConversationTurn } from "@/lib/platform/intelligence/ai/conversations/turn";
import type { TurnRunDeps } from "@/lib/platform/intelligence/ai/conversations/handlers";
import * as store from "@/lib/platform/intelligence/ai/conversations/store";

const ROUTE_KEY = "platform-ai-conversation";

export const runConversationTurnForRoute: TurnRunDeps["runTurn"] = async ({ operatorId, conversationId, question, access }) => {
  const history = (await store.loadConversationHistory(operatorId, conversationId)) ?? [];
  const { model, reasoning } = platformAiModel();
  const run = await runConversationTurn({
    conversationId, question, binding: access.binding, history,
    generate: makePlatformAiGenerate({ operatorId, conversationId }),
    model, reasoningModel: reasoning, classify: classifyPlatformAiFailure,
    onUngrounded: (verdict, unresolved) => console.warn(`[platform-ai] answer replaced: verdict=${verdict} unresolved=${unresolved} (${ROUTE_KEY})`),
    onTrace: (line) => console.info(`[platform-ai] turn ${line} (${ROUTE_KEY})`),
  });
  if (run.outcome.status === "FAILED") console.warn(`[platform-ai] turn failed: code=${run.outcome.failureCode} (${ROUTE_KEY})`);
  return run.outcome;
};
