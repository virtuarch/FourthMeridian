/**
 * lib/platform/intelligence/ai/tools/tool-trace.ts  (Platform AI — the RESPONSE's metadata-only tool trace, S2 09hu G1)
 *
 * Every answered turn's response (POST /api/platform/ai/ask, and the conversations' create /
 * append turn: app/api/platform/ai/conversations/…) carries `toolTrace`: what the turn's tools
 * did, as an array of entries aggregated per (tool, outcome):
 *
 *   { tool, pack, tier, outcome, calls }      — THE CLOSED KEY SET (TOOL_TRACE_KEYS; pinned by tool-trace.test.ts)
 *
 *   tool     a REGISTERED tool name (tools/registry.ts), `more_tools` (the router's meta-tool), or
 *            "unknown" (a name the model invented, or one the turn did not offer — the turn's
 *            own trace already says "unknown" for those). Always taken from the registry /
 *            these constants, never from the model's text.
 *   pack     the registry pack of that tool (TOOL_PACKS); "meta" for more_tools and "unknown".
 *   tier     the registry tier the tool requires (TOOL_TIERS); "NONE" for more_tools and "unknown".
 *   outcome  one of TOOL_TRACE_OUTCOMES (the mapping below — closed).
 *   calls    how many calls of that tool ended with that outcome this turn (a positive integer).
 *
 * NEVER an argument, a result, a value, a record id, a registry ref (metric key / page id), a
 * handle or any customer data: the source is the turn's existing metadata trace (core.ts
 * PlatformAiTraceStep), and this projection reads ONLY its `tool`, `outcome` and `refused`
 * fields — `refs`, `count`, `unavailable`, `drillLink` and `windowIgnored` are dropped.
 * The same projection for EVERY operator (no per-operator or synthetic-operator case exists).
 * Response only: nothing here is stored (the conversations store keeps no trace).
 *
 * OUTCOME MAPPING (every PlatformAiTraceStep outcome; the `Record` type makes it exhaustive):
 *   OK                                     → ok           (the executor / a pack tool / more_tools answered)
 *   MEASURED | ESTIMATED | PARTIAL         → ok           (a metric envelope was returned)
 *   UNAVAILABLE                            → unavailable  (an UNAVAILABLE envelope; a pack reader that failed;
 *                                                          the boundary's UNAVAILABLE_AUDIT / _ENVELOPE / _READER)
 *   NOT_FOUND                              → not_found    (no such tool — boundary UNKNOWN_TOOL; an unknown or
 *                                                          not-visible registry id; memory not offered)
 *   NOT_FOUND + refused (boundary flag)    → refused      (boundary PACK_NOT_ROUTED, PACK_DISABLED,
 *                                                          AREA_NOT_IN_SCOPE, RECHECK_REFUSED, TIER_REFUSED,
 *                                                          HANDLE_UNRESOLVED, REVALIDATE_REFUSED)
 *   INVALID_ARGS                           → refused      (the executor's shape check; boundary ARGS_INVALID)
 *   BUDGET                                 → refused      (the per-turn tool-call bound was spent)
 *
 * Imports the registry (server code): call it from the routes / turn runner only, never from core.ts.
 */

import type { PlatformAiTraceStep } from "../core";
import { MORE_TOOLS_NAME } from "../engine/router";
import type { ToolPack, ToolTier } from "./contract";
import { PLATFORM_AI_TOOL_REGISTRY } from "./registry";

/** THE closed key set of one entry (adding a key fails tool-trace.test.ts). */
export const TOOL_TRACE_KEYS = ["tool", "pack", "tier", "outcome", "calls"] as const;

/** THE closed outcome set. */
export const TOOL_TRACE_OUTCOMES = ["ok", "refused", "not_found", "unavailable"] as const;
export type ToolTraceOutcome = (typeof TOOL_TRACE_OUTCOMES)[number];

/** The pack / tier of the meta entries (more_tools, unknown). */
export const TOOL_TRACE_META_PACK = "meta";
export const TOOL_TRACE_META_TIER = "NONE";
export const TOOL_TRACE_UNKNOWN_TOOL = "unknown";

export interface PlatformAiToolTraceEntry {
  readonly tool: string;
  readonly pack: ToolPack | typeof TOOL_TRACE_META_PACK;
  readonly tier: ToolTier | typeof TOOL_TRACE_META_TIER;
  readonly outcome: ToolTraceOutcome;
  readonly calls: number;
}

/** The mapping above, exhaustive over the trace step's closed outcome type. */
const OUTCOME_OF: Readonly<Record<PlatformAiTraceStep["outcome"], ToolTraceOutcome>> = Object.freeze({
  OK: "ok", MEASURED: "ok", ESTIMATED: "ok", PARTIAL: "ok",
  UNAVAILABLE: "unavailable",
  NOT_FOUND: "not_found",
  INVALID_ARGS: "refused",
  BUDGET: "refused",
});

/** One step's outcome code (an unknown outcome — impossible by type — reads "unavailable", never "ok"). */
export function toolTraceOutcome(step: Pick<PlatformAiTraceStep, "outcome" | "refused">): ToolTraceOutcome {
  if (step.refused === true) return "refused";
  return Object.prototype.hasOwnProperty.call(OUTCOME_OF, step.outcome) ? OUTCOME_OF[step.outcome] : "unavailable";
}

type RegistryView = readonly { readonly name: string; readonly pack: ToolPack; readonly requires: { readonly tier: ToolTier } }[];

/**
 * The turn's metadata trace → the response's `toolTrace` (aggregated per (tool, outcome), in first-seen
 * order). Each entry is built from registry values and the constants above only.
 */
export function platformAiToolTrace(steps: readonly Pick<PlatformAiTraceStep, "tool" | "outcome" | "refused">[], registry: RegistryView = PLATFORM_AI_TOOL_REGISTRY): PlatformAiToolTraceEntry[] {
  const out: { tool: string; pack: PlatformAiToolTraceEntry["pack"]; tier: PlatformAiToolTraceEntry["tier"]; outcome: ToolTraceOutcome; calls: number }[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    const name: unknown = s?.tool;
    const reg = registry.find((t) => t.name === name) ?? null;
    const tool: string = reg ? reg.name : name === MORE_TOOLS_NAME ? MORE_TOOLS_NAME : TOOL_TRACE_UNKNOWN_TOOL;
    const pack = reg ? reg.pack : TOOL_TRACE_META_PACK;
    const tier = reg ? reg.requires.tier : TOOL_TRACE_META_TIER;
    const outcome = toolTraceOutcome(s);
    const hit = out.find((e) => e.tool === tool && e.outcome === outcome);
    if (hit) hit.calls++;
    else out.push({ tool, pack, tier, outcome, calls: 1 });
  }
  return out.map((e) => Object.freeze({ tool: e.tool, pack: e.pack, tier: e.tier, outcome: e.outcome, calls: e.calls }));
}
