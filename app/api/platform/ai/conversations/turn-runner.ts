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

import { randomUUID } from "node:crypto";

import { classifyPlatformAiFailure, makePlatformAiGenerate, platformAiModel } from "@/lib/platform/intelligence/ai/ledger";
import { runConversationTurn } from "@/lib/platform/intelligence/ai/conversations/turn";
import type { AreaAccess, TurnRunDeps } from "@/lib/platform/intelligence/ai/conversations/handlers";
import type { HistoryMessage } from "@/lib/platform/intelligence/ai/conversations/history";
import { renderAnswerText } from "@/lib/platform/intelligence/ai/conversations/export";
import { env } from "@/lib/env";
import { isMemoryEffective } from "@/lib/platform/intelligence/ai/memory/gate";
import { retrieveFacts } from "@/lib/platform/intelligence/ai/memory/retrieve";
import { buildMemoryTurn, type MemoryTurn } from "@/lib/platform/intelligence/ai/memory/turn";
import * as memoryStore from "@/lib/platform/intelligence/ai/memory/store";
import * as store from "@/lib/platform/intelligence/ai/conversations/store";
import { createTurnBoundary } from "@/lib/platform/intelligence/ai/authz/boundary";
import { platformAiFreshRecheck } from "@/lib/platform/intelligence/ai/authz/recheck.server";
import { platformAiPackEnabled, platformAiTurnRouter, routePlatformAiPacks } from "@/lib/platform/intelligence/ai/engine/router";

const ROUTE_KEY = "platform-ai-conversation";

/**
 * Platform AI memory (design v2 §3–§4) — ONLY when memory is effective
 * (isMemoryEffective, checked here, server-side): the facts of THIS
 * conversation's area are retrieved (revalidated through the readers of the same
 * fresh guard; the B3 rule applied) and handed to the turn as hooks. Memory off ⇒
 * undefined ⇒ the turn is exactly as before (no tools, no injection).
 */
async function memoryTurnFor(operatorId: string, question: string, access: AreaAccess, history: readonly HistoryMessage[]): Promise<MemoryTurn | undefined> {
  if (!isMemoryEffective(env) || !access.area || !access.memoryReaders) return undefined;
  const area = access.area, readers = access.memoryReaders;
  const { facts } = await retrieveFacts({ operatorId, areas: [area], readersFor: async () => readers, store: memoryStore, mode: "inject" });
  const historyNewestFirst = [...history].reverse().map((m) => (typeof m.content === "string" ? m.content : m.content ? renderAnswerText(m.content) : "")).filter(Boolean);
  return buildMemoryTurn({
    operatorId, area, facts, question, historyNewestFirst,
    metricLabel: (id) => access.binding.describeMetric(id)?.label ?? null,
    pageLabel: (id) => access.binding.listPages({}).find((t) => t.id === id)?.label ?? null,
    now: () => new Date(),
  });
}

export const runConversationTurnForRoute: TurnRunDeps["runTurn"] = async ({ operatorId, conversationId, question, access }) => {
  const history = (await store.loadConversationHistory(operatorId, conversationId)) ?? [];
  const { model, reasoning } = platformAiModel();
  let memory: MemoryTurn | undefined;
  try { memory = await memoryTurnFor(operatorId, question, access, history); }
  catch { memory = undefined; console.warn(`[platform-ai] memory unavailable for this turn (${ROUTE_KEY})`); }
  // P2 — THE turn boundary: every tool call re-authorized (pack flag, strict args, the
  // conversation's own area re-checked FRESH per call, per-turn handles). No scope ⇒ no tool runs.
  const correlationId = randomUUID();
  const boundary = createTurnBoundary({
    operatorId, correlationId,
    areas: access.scope ? [{ scope: access.scope, binding: access.binding }] : [],
    binding: access.binding,
    recheck: platformAiFreshRecheck,
    // P3: core packs until the turn routes its scrubbed question (engine/router.ts); more_tools within the bounds.
    packs: routePlatformAiPacks({ question: null, areas: access.scope ? [access.scope.area] : [], memory: !!memory }),
    router: platformAiTurnRouter({ memory: !!memory }),
    packEnabled: (p) => platformAiPackEnabled(p),
    onDenial: (r) => console.warn(`[platform-ai] tool refused: tool=${r.tool} pack=${r.pack} reason=${r.reason} (${ROUTE_KEY})`),
  });
  const run = await runConversationTurn({
    conversationId, question, binding: access.binding, history,
    ...(memory ? {
      memory,
      onMemoryRefusals: (codes: readonly string[]) => { void memoryStore.recordProposalRefusals(operatorId, access.area!, codes).catch(() => {}); },
    } : {}),
    generate: makePlatformAiGenerate({ operatorId, conversationId, turnId: correlationId }),
    invoke: boundary.invoke,
    ...(boundary.tools ? { tools: boundary.tools } : {}),
    model, reasoningModel: reasoning, classify: classifyPlatformAiFailure,
    onUngrounded: (verdict, unresolved) => console.warn(`[platform-ai] answer replaced: verdict=${verdict} unresolved=${unresolved} (${ROUTE_KEY})`),
    onTrace: (line) => console.info(`[platform-ai] turn ${line} (${ROUTE_KEY})`),
  });
  if (run.outcome.status === "FAILED") console.warn(`[platform-ai] turn failed: code=${run.outcome.failureCode} (${ROUTE_KEY})`);
  return run.outcome;
};
