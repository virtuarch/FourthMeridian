/**
 * scripts/ai-baseline/run.ts
 *
 * THE RUNNER — replay one conversation, one arm, one model; write an artifact.
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
import { generateWithTools } from '@/lib/ai/provider';
import { findProbe, type Probe } from './probes';
import {
  buildEvidence, assembleFullContext, ARM_USES_TOOLS, ARM_QUESTION, type Arm,
} from './evidence';
import { openAiToolSchemas, findTool, type ToolContext } from './tools';
import type { SpaceContext } from '@/lib/space';

/**
 * The behavioural instruction. ~140 words, identical in every arm and every
 * model tier.
 *
 * ⚠️ IT IS NOT DOCTRINE AND MUST NOT BECOME IT. No phrase tables, no worked
 * examples, no financial ontology, no rules about which figure may be stated.
 * The previous architecture's prompt reached ~4,250 tokens of doctrine; if this
 * one starts growing to fix a transcript, the growth IS the finding.
 */
export const SYSTEM_INSTRUCTION = [
  'You are Fourth Meridian, a financial assistant talking to the person whose money this is.',
  '',
  'Answer the question actually asked. Be brief by default — a few sentences — and go',
  'deeper only when asked. Talk like a person, not like a report.',
  '',
  'Use the financial evidence and tools you are given. Never state a figure you were not',
  'given or cannot compute from what you were given. If something is unknown or',
  'unknowable, say so once and move on.',
  '',
  'Keep these apart, in your own words: what is measured, what is an observed pattern,',
  'what the user assumed, and what is an illustrative scenario.',
  '',
  'Lead with what matters. Something immaterial does not become important because a field',
  'about it is missing. Correct a wrong premise rather than answering around it.',
  'Form a view when asked for one.',
].join('\n');

export interface TurnRecord {
  index: number;
  user: string;
  toolCalls: { name: string; arguments: unknown; result: unknown; latencyMs: number; error?: string }[];
  roundTrips: number;
  /** 429s absorbed on this turn, with how long each wait was. Reported, never hidden. */
  retries: { attempt: number; waitedMs: number; reason: string }[];
  assistant: string | null;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  finishReason: string | null;
  error?: string;
}

export interface CaseResult {
  probe: string;
  arm: Arm;
  model: string;
  ok: boolean;
  turns: TurnRecord[];
  totals: { latencyMs: number; promptTokens: number; completionTokens: number;
    totalTokens: number; toolCalls: number; roundTrips: number;
    retries: number; rateLimitWaitMs: number };
  artifactPath: string;
}

const MAX_TOOL_ROUNDTRIPS = 6;
const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Absorb a provider rate limit, and record that it happened.
 *
 * ⚠️ THIS IS QUOTA, NOT BEHAVIOUR. The first smoke run lost three of twelve cases
 * to a 30,000 tokens-per-minute organisation cap while sending ~20,000-token
 * A0/A1 prompts — two turns in a minute exceeds it. That measures the account,
 * not the architecture, and letting it stand would have read as "the broad-context
 * arms fail". Only a 429 is retried; every other provider error still fails the
 * turn immediately, and the waits are written into the artifact so a slow case is
 * never mistaken for a slow model.
 */
async function callWithRateLimitRetry<T>(
  call: () => Promise<T>, rec: TurnRecord,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = /rate limit|429/i.test(message);
      if (!isRateLimit || attempt > MAX_RATE_LIMIT_RETRIES) throw err;
      // The provider states how long to wait; honour it, with a small margin.
      const suggested = /try again in ([\d.]+)s/i.exec(message);
      const waitedMs = suggested
        ? Math.ceil(Number(suggested[1]) * 1000) + 1500
        : Math.min(60_000, 5_000 * attempt);
      rec.retries.push({ attempt, waitedMs, reason: message.slice(0, 160) });
      await new Promise((r) => setTimeout(r, waitedMs));
    }
  }
}

/** Models that cannot take function tools through /v1/chat/completions (measured). */
export function supportsTools(model: string): boolean {
  return !/^(gpt-6|gpt-5\.6)/.test(model);
}

export async function runCase(args: {
  probeId: string;
  arm: Arm;
  model: string;
  spaceCtx: SpaceContext;
  agentId: string;
  asOfISO: string;
  runDir: string;
}): Promise<CaseResult> {
  const { probeId, arm, model, spaceCtx, agentId, asOfISO, runDir } = args;
  const probe = findProbe(probeId);
  if (!probe) throw new Error(`unknown probe: ${probeId}`);

  const ctx = await assembleFullContext(spaceCtx, agentId);
  const evidence = await buildEvidence(arm, ctx, spaceCtx.spaceId);
  const useTools = ARM_USES_TOOLS[arm] && supportsTools(model);
  const toolSchemas = useTools ? openAiToolSchemas() : [];
  const toolCtx: ToolContext = { spaceCtx, spaceId: spaceCtx.spaceId, asOfISO };

  const messages: unknown[] = [
    { role: 'system', content: `${SYSTEM_INSTRUCTION}\n\nToday is ${asOfISO}.` },
  ];
  if (evidence.body) messages.push({ role: 'user', content: evidence.body });

  const turns: TurnRecord[] = [];
  let ok = true;

  for (const [index, user] of probe.turns.entries()) {
    messages.push({ role: 'user', content: user });
    const rec: TurnRecord = {
      index, user, toolCalls: [], roundTrips: 0, retries: [], assistant: null,
      latencyMs: 0, usage: null, finishReason: null,
    };

    try {
      for (let hop = 0; hop < MAX_TOOL_ROUNDTRIPS; hop++) {
        rec.roundTrips++;
        const out = await callWithRateLimitRetry(
          () => generateWithTools({ model, messages, tools: toolSchemas }), rec);
        rec.latencyMs += out.latencyMs;
        if (out.usage) {
          rec.usage = rec.usage
            ? { promptTokens: rec.usage.promptTokens + out.usage.promptTokens,
                completionTokens: rec.usage.completionTokens + out.usage.completionTokens,
                totalTokens: rec.usage.totalTokens + out.usage.totalTokens }
            : out.usage;
        }
        rec.finishReason = out.finishReason;
        messages.push(out.raw);

        if (out.toolCalls.length === 0) { rec.assistant = out.content; break; }

        // ⚠️ TOOL RESULTS STAY IN THE TRANSCRIPT. They are the only "state" this
        // experiment has: a later "break it down" can see the object that
        // produced the earlier number, because it is still in the messages.
        for (const call of out.toolCalls) {
          const started = Date.now();
          let result: unknown; let error: string | undefined;
          try {
            const tool = findTool(call.name);
            if (!tool) throw new Error(`no such tool: ${call.name}`);
            const parsed = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
            result = await tool.run(parsed, toolCtx);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            result = { error };
          }
          rec.toolCalls.push({
            name: call.name,
            arguments: safeParse(call.arguments),
            result, latencyMs: Date.now() - started, ...(error ? { error } : {}),
          });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      if (rec.assistant === null && !rec.error) {
        rec.error = `no final answer after ${MAX_TOOL_ROUNDTRIPS} tool round trips`;
        ok = false;
      }
    } catch (err) {
      // ⚠️ ONE CASE'S PROVIDER FAILURE MUST NOT KILL THE RUN. The artifact is
      // written either way — a failure is a result.
      rec.error = err instanceof Error ? err.message : String(err);
      ok = false;
      turns.push(rec);
      break;
    }
    turns.push(rec);
  }

  const totals = turns.reduce((t, r) => ({
    latencyMs: t.latencyMs + r.latencyMs,
    promptTokens: t.promptTokens + (r.usage?.promptTokens ?? 0),
    completionTokens: t.completionTokens + (r.usage?.completionTokens ?? 0),
    totalTokens: t.totalTokens + (r.usage?.totalTokens ?? 0),
    toolCalls: t.toolCalls + r.toolCalls.length,
    roundTrips: t.roundTrips + r.roundTrips,
    retries: t.retries + r.retries.length,
    // ⚠️ KEPT OUT OF `latencyMs`. Waiting on a quota is not the model being slow.
    rateLimitWaitMs: t.rateLimitWaitMs + r.retries.reduce((w, x) => w + x.waitedMs, 0),
  }), { latencyMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: 0, roundTrips: 0, retries: 0, rateLimitWaitMs: 0 });

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

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw || '{}'); } catch { return { unparseable: raw }; }
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
