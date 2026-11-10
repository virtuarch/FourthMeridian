/**
 * lib/platform/intelligence/ai/eval/scripted-model.ts  (Platform AI E0-CI — the deterministic model)
 *
 * Design §12. No live model, no network: the model is a SCRIPT of turns (tool calls
 * or a final content). Two seams, both recording every serialised provider request
 * VERBATIM (the IDENTITY_LEAK / injection gates scan these strings):
 *
 *   installScriptedProvider()  replaces globalThis.fetch for the provider
 *                              chokepoint's chat-completions requests (the real route
 *                              → ledger → lib/ai/provider path); any other URL throws.
 *   scriptedGenerate(steps)    a PlatformAiGenerate for core-level cases (memory hooks).
 *
 * Adversarial transcripts are ordinary scripts whose steps "obey" a planted injection
 * (link to the evil host, forge placeholders, call tools that do not exist, pass scope
 * arguments, propose a memory with a customer identity) — see cases/*.
 */

import type { PlatformAiGenerate } from "../core";

export interface ScriptStep {
  calls?: { name: string; args: unknown }[];
  content?: string;
}

export interface ScriptedProvider {
  /** Load the next turn's script (steps are consumed in order; an empty script answers "done"). */
  load(steps: readonly ScriptStep[]): void;
  /** Every request body the provider received, verbatim, since the last `load`. */
  readonly requests: string[];
  /** Every request body since install. */
  readonly allRequests: string[];
  restore(): void;
}

const completion = (model: unknown, s: ScriptStep, n: number) => {
  const message = s.calls
    ? { role: "assistant", content: null, tool_calls: s.calls.map((c, i) => ({ id: `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
    : { role: "assistant", content: s.content ?? "" };
  return {
    id: "chatcmpl-e0", object: "chat.completion", created: 0, model,
    choices: [{ index: 0, message, finish_reason: s.calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
};

/** Fake the provider at the network edge (the real route's provider chokepoint). */
export function installScriptedProvider(): ScriptedProvider {
  const original = globalThis.fetch;
  let script: ScriptStep[] = [];
  const requests: string[] = [];
  const allRequests: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String((input as { url?: string })?.url ?? input);
    if (!url.endsWith("/chat/completions")) throw new Error("E0: unexpected network call");
    const raw = String(init?.body ?? "{}");
    requests.push(raw);
    allRequests.push(raw);
    const body = JSON.parse(raw) as { model?: unknown };
    const s = script.shift() ?? { content: "done" };
    return new Response(JSON.stringify(completion(body.model, s, allRequests.length)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    load(steps) { script = [...steps]; requests.length = 0; },
    requests, allRequests,
    restore() { globalThis.fetch = original; },
  };
}

/** A scripted PlatformAiGenerate (core-level cases); records each request as the provider would receive it. */
export function scriptedGenerate(steps: readonly ScriptStep[]): { generate: PlatformAiGenerate; requests: string[] } {
  const queue = [...steps];
  const requests: string[] = [];
  let n = 0;
  const generate: PlatformAiGenerate = async ({ model, messages, tools, maxTokens }) => {
    requests.push(JSON.stringify({ model, messages, tools, max_tokens: maxTokens }));
    n++;
    const s = queue.shift() ?? { content: "done" };
    const calls = (s.calls ?? []).map((c, i) => ({ id: `c${n}_${i}`, name: c.name, arguments: JSON.stringify(c.args) }));
    return {
      content: s.content ?? null,
      toolCalls: calls,
      raw: { role: "assistant", content: s.content ?? null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}) },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 0 },
    };
  };
  return { generate, requests };
}
