/**
 * app/api/platform/ai/conversations/turn-runner.ts  (B11 — the REAL turn seam; not a route)
 *
 * The handlers' `runTurn` (lib/platform/intelligence/ai/conversations/handlers.ts
 * TurnRunDeps): loads the ONE conversation's stored COMPLETE messages (the data
 * module, withTenantDb as the operator), then runs runConversationTurn with
 *   · the binding from `access` — the conversation's OWN area, FRESH, built by
 *     ./area-access.ts from its own guard result (never the request, never the row);
 *     P4b: plus every other area the operator holds NOW (access.turnAreas, each from
 *     its own fresh guard; composed) — the boundary rechecks each per tool call; a
 *     prior answer that read a lost area is replayed as "[no longer available]";
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
import { platformAiToolAudit } from "@/lib/platform/intelligence/ai/authz/audit";
import { fillSubjectSlots, resolveSubjects } from "@/lib/platform/intelligence/ai/authz/subject";
import { platformAiSubjectDeps } from "@/lib/platform/intelligence/ai/authz/subject.server";
import { STORED_NOTES_MAX } from "@/lib/platform/intelligence/ai/conversations/answer";
import { answerReadable, packAreasRead, withAreasRead } from "@/lib/platform/intelligence/ai/conversations/multi-area";
import { CORE_PACKS } from "@/lib/platform/intelligence/ai/engine/router";
import { platformAiToolTrace } from "@/lib/platform/intelligence/ai/tools/tool-trace";
import { placedSpansOf } from "@/lib/platform/intelligence/ai/tools/figure-sources";

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
  // P4b: an answer that read an area not held now never feeds memory either.
  const historyNewestFirst = [...history].reverse().filter((m) => typeof m.content === "string" || !m.content || answerReadable(m.evidenceRefs, m.content, access.heldAreas)).map((m) => (typeof m.content === "string" ? m.content : m.content ? renderAnswerText(m.content) : "")).filter(Boolean);
  return buildMemoryTurn({
    operatorId, area, facts, question, historyNewestFirst,
    metricLabel: (id) => access.binding.describeMetric(id)?.label ?? null,
    pageLabel: (id) => access.binding.listPages({}).find((t) => t.id === id)?.label ?? null,
    now: () => new Date(),
  });
}

export const runConversationTurnForRoute: TurnRunDeps["runTurn"] = async ({ operatorId, conversationId, question, access, subjects }) => {
  const history = (await store.loadConversationHistory(operatorId, conversationId)) ?? [];
  const { model, reasoning } = platformAiModel();
  let memory: MemoryTurn | undefined;
  try { memory = await memoryTurnFor(operatorId, question, access, history); }
  catch { memory = undefined; console.warn(`[platform-ai] memory unavailable for this turn (${ROUTE_KEY})`); }
  // P2 — THE turn boundary: every tool call re-authorized (pack flag, strict args, every area of the
  // turn re-checked FRESH per call, per-turn handles). No scope ⇒ no tool runs.
  // P4b: the turn's areas = the conversation's own scope + every other area held NOW (access.turnAreas,
  // each from its own fresh guard). Without widening ⇒ the own scope only (the pre-P4b turn).
  const turnAreas = access.turnAreas ?? (access.scope ? [{ scope: access.scope, binding: access.binding }] : []);
  const correlationId = randomUUID();
  const boundary = createTurnBoundary({
    operatorId, correlationId,
    areas: turnAreas,
    binding: access.binding,
    recheck: platformAiFreshRecheck,
    // P3: core packs until the turn routes its scrubbed question (engine/router.ts); more_tools within the bounds.
    packs: routePlatformAiPacks({ question: null, areas: turnAreas.map((p) => p.scope.area), memory: !!memory }),
    router: platformAiTurnRouter({ memory: !!memory }),
    packEnabled: (p) => platformAiPackEnabled(p),
    onDenial: (r) => console.warn(`[platform-ai] tool refused: tool=${r.tool} pack=${r.pack} reason=${r.reason} (${ROUTE_KEY})`),
    // P5 — THE fail-closed audit writer for customer-linkable RECORD tools (actor = this call's fresh guard).
    audit: platformAiToolAudit(),
  });
  // P5 — exact customer identifiers (cut out before the scrub by the handler) resolved through THIS turn's
  // boundary: the model sees `[customer h_…]` or the one `[customer not resolved]`; the stored text keeps `[customer]`.
  let modelQuestion = question;
  let subjectNote: string | null = null;
  if (subjects && access.area) {
    const r = await resolveSubjects(subjects.ids, platformAiSubjectDeps({ operatorId, primaryArea: access.area, boundary }));
    modelQuestion = fillSubjectSlots(subjects.slotted, r.fills);
    subjectNote = r.note;
  }
  const run = await runConversationTurn({
    conversationId, question: modelQuestion, binding: access.binding, history,
    ...(memory ? {
      memory,
      onMemoryRefusals: (codes: readonly string[]) => { void memoryStore.recordProposalRefusals(operatorId, access.area!, codes).catch(() => {}); },
    } : {}),
    generate: makePlatformAiGenerate({ operatorId, conversationId, turnId: correlationId }),
    invoke: boundary.invoke,
    ...(boundary.tools ? { tools: boundary.tools } : {}),
    // P4 — {{r:h|field}} resolves against THIS turn's handles only; prior record spans get a handle of
    // THIS turn only after replay re-authz (the boundary's area recheck + the kind's revalidate).
    records: boundary.recordRef,
    remint: boundary.remint,
    // P4b — a prior answer that read an area not held now replays as "[no longer available]" (never re-minted).
    ...(access.heldAreas ? { heldAreas: access.heldAreas } : {}),
    model, reasoningModel: reasoning, classify: classifyPlatformAiFailure,
    onUngrounded: (verdict, unresolved) => console.warn(`[platform-ai] answer replaced: verdict=${verdict} unresolved=${unresolved} (${ROUTE_KEY})`),
    onTrace: (line) => console.info(`[platform-ai] turn ${line} (${ROUTE_KEY})`),
  });
  if (run.outcome.status === "FAILED") console.warn(`[platform-ai] turn failed: code=${run.outcome.failureCode} (${ROUTE_KEY})`);
  // P4b — a multi-area turn's provenance also names every area a PACK tool ran over (metric reads already carry
  // their envelope surface), so losing any of them later hides this answer. One-area turns: stored exactly as before.
  const outcome = access.turnAreas && run.outcome.status === "COMPLETE"
    ? { ...run.outcome, evidenceRefs: withAreasRead(run.outcome.evidenceRefs, packAreasRead(boundary.toolAreas(), CORE_PACKS)) }
    : run.outcome;
  // S2 09hu G1 — the response's metadata-only tool trace (tool / pack / tier / outcome / calls; the same for every
  // operator). The handler splits it off BEFORE the settle: it is never stored.
  const toolTrace = platformAiToolTrace(run.result?.trace ?? []);
  // B1 — the placed spans' closed sources (record kind + field code / metric key + result path; never an id or a
  // value). The handler splits them off BEFORE the settle (never stored) and positions them on the response.
  const figureSources = run.outcome.status === "COMPLETE" ? placedSpansOf(run.typed ?? []) : [];
  // P5: the one uniform server note for any unresolved subject (code-written; never says why).
  if (subjectNote && outcome.status === "COMPLETE" && !outcome.answer.notes.includes(subjectNote) && outcome.answer.notes.length < STORED_NOTES_MAX) {
    return { ...outcome, answer: { ...outcome.answer, notes: [...outcome.answer.notes, subjectNote] }, toolTrace, figureSources };
  }
  return { ...outcome, toolTrace, figureSources };
};

