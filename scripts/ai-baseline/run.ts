/**
 * scripts/ai-baseline/run.ts
 *
 * THE RUNNER — replay one conversation, one arm, one model; write an artifact.
 *
 * ⚠️ IT NO LONGER OWNS A TURN. The turn loop, the instruction and the transcript
 * record live in lib/ai/conversation/turn.ts, because the production chat route
 * runs them too. What is left here is the experiment around them: which probe,
 * which arm, which model, and the artifact a human reads afterwards.
 *
 * ⚠️ RESEARCH CODE. No production caller, no route, no persistence beyond local
 * artifact files and the provider's existing usage counter. Reads real financial
 * data through canonical authorities and writes none of it.
 *
 * ⚠️ CONVERSATION HISTORY IS THE STATE, and that is the experiment. There is no
 * lifecycle, no assumption store, no scenario object. Every turn appends to one
 * message array — including each tool call and its JSON result — and the model
 * gets the whole thing. If that is not enough for "assume 6k … February?", the
 * transcript will show it, and THAT is the finding.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findProbe, type Probe } from './probes';
import { ARM_USES_TOOLS, ARM_QUESTION, type Arm } from '@/lib/ai/conversation/evidence';
import { openTranscript } from '@/lib/ai/conversation/engine';
import { executeTurn, SYSTEM_INSTRUCTION, type TurnRecord } from '@/lib/ai/conversation/turn';
import { newScenarioSlot } from '@/lib/ai/conversation/active-scenario';
import {
  compactToolHistory, DEFAULT_COMPACTION, type CompactionPolicy,
} from '@/lib/ai/conversation/compaction';
import type { SpaceContext } from '@/lib/space';

export interface CaseResult {
  probe: string;
  arm: Arm;
  model: string;
  ok: boolean;
  turns: TurnRecord[];
  totals: { latencyMs: number; promptTokens: number; completionTokens: number;
    totalTokens: number; reasoningTokens: number; toolCalls: number; roundTrips: number;
    retries: number; rateLimitWaitMs: number };
  artifactPath: string;
}

/** Sum a set of turn records the way both modes report totals. */
export function sumTurns(turns: readonly TurnRecord[]): CaseResult['totals'] {
  return turns.reduce((t, r) => ({
    latencyMs: t.latencyMs + r.latencyMs,
    promptTokens: t.promptTokens + (r.usage?.promptTokens ?? 0),
    completionTokens: t.completionTokens + (r.usage?.completionTokens ?? 0),
    totalTokens: t.totalTokens + (r.usage?.totalTokens ?? 0),
    reasoningTokens: t.reasoningTokens + (r.usage?.reasoningTokens ?? 0),
    toolCalls: t.toolCalls + r.toolCalls.length,
    roundTrips: t.roundTrips + r.roundTrips,
    retries: t.retries + r.retries.length,
    // ⚠️ KEPT OUT OF `latencyMs`. Waiting on a quota is not the model being slow.
    rateLimitWaitMs: t.rateLimitWaitMs + r.retries.reduce((w, x) => w + x.waitedMs, 0),
  }), { latencyMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
        reasoningTokens: 0, toolCalls: 0, roundTrips: 0, retries: 0, rateLimitWaitMs: 0 });
}

export async function runCase(args: {
  probeId: string;
  arm: Arm;
  model: string;
  spaceCtx: SpaceContext;
  agentId: string;
  asOfISO: string;
  runDir: string;
  /** null disables context compaction, for a before/after comparison. */
  compaction?: CompactionPolicy | null;
}): Promise<CaseResult> {
  const { probeId, arm, model, spaceCtx, agentId, asOfISO, runDir } = args;
  const compaction = args.compaction === undefined ? DEFAULT_COMPACTION : args.compaction;
  const probe = findProbe(probeId);
  if (!probe) throw new Error(`unknown probe: ${probeId}`);

  // ⚠️ THE SHARED PROLOGUE. Instruction, dated, then the orientation evidence —
  // opened by the same function the product route opens its transcript with, so
  // a recorded run and a user's conversation begin identically.
  const { messages: opened, evidence, toolSchemas, toolCtx, usesTools: useTools } =
    await openTranscript({ spaceCtx, agentId, asOfISO, model, arm });
  let messages: unknown[] = opened;

  const turns: TurnRecord[] = [];
  // ⚠️ ONE SLOT, ONE CONVERSATION. Not an array and not a history: the failure
  // involved a single hypothetical revised in place, and a second slot would need
  // user-visible identity nobody asked for.
  const scenario = newScenarioSlot();
  let ok = true;

  for (const [index, user] of probe.turns.entries()) {
    const rec = await executeTurn({ messages, user, index, model, toolSchemas, toolCtx,
      scenario, correlationId: `${probeId}:${arm}:${model}:${runDir}` });
    turns.push(rec);
    if (rec.error) { ok = false; break; }
    // ⚠️ AFTER THE ANSWER LANDS, NEVER BEFORE. `executeTurn` has appended the final
    // prose, so the turn is closed and its evidence has served its purpose. The
    // helper decides what is old enough; this only says when to ask.
    if (compaction) {
      const { messages: next, stats } = compactToolHistory(messages, compaction);
      messages = next;
      rec.compaction = stats;
    }
  }

  const totals = sumTurns(turns);

  const artifactPath = join(runDir, `${probeId}__${arm}__${model.replace(/[^\w.-]/g, '_')}.json`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(artifactPath, JSON.stringify({
    probe: { id: probe.id, title: probe.title, whatItDiscriminates: probe.whatItDiscriminates,
      goldens: probe.goldens },
    arm, armQuestion: ARM_QUESTION[arm], model,
    toolsOffered: useTools ? toolSchemas.map((t) => (t as { function: { name: string } }).function.name) : [],
    toolsUnavailableReason: ARM_USES_TOOLS[arm] && !useTools
      ? `${model} does not support function tools via /v1/chat/completions` : null,
    spaceId: spaceCtx.spaceId, spaceName: spaceCtx.space.name, asOfISO,
    systemInstruction: SYSTEM_INSTRUCTION,
    evidence: { arm: evidence.arm, summary: evidence.summary,
      includesAssessment: evidence.includesAssessment, approxTokens: evidence.approxTokens,
      body: evidence.body },
    turns, totals, ok,
    humanReview: blankReview(probe),
  }, null, 2));

  return { probe: probeId, arm, model, ok, turns, totals, artifactPath };
}

/**
 * Blank human-review fields. Deliberately NOT populated by a model.
 *
 * ⚠️ NO LLM JUDGE. The previous architecture's scorers were wrong before the
 * model twice as often, and later ten times. Chris reads the transcripts.
 */
function blankReview(probe: Probe) {
  return {
    _instructions: 'Score 1–5. Leave blank until read. No automated scorer populates these.',
    accuracy: null, relevance: null, conversation: null,
    conciseness: null, judgment: null, followUp: null,
    notes: '',
    lookFor: probe.whatItDiscriminates,
  };
}
