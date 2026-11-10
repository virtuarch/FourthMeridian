/**
 * lib/platform/intelligence/ai/tools/registry.ts  (Platform AI P1b — the tool registry facade)
 *
 * The SIX existing Platform AI tools, declared through tools/contract.ts:
 *   metrics     list_metrics, get_metric
 *   navigation  find_page, open_page
 *   memory      recall_memory, propose_memory   (offered only when memory is effective)
 *
 * A FACADE, not a rewrite: every `run` delegates to the existing executor
 * (core.ts executePlatformAiTool) with the same arguments, and
 * `platformAiRegistrySchemas` returns exactly what core.ts platformAiToolSchemas
 * serialises for the model. The live turn loop is unchanged in P1b (it still calls
 * the executor directly); P2's boundary (authz/boundary.ts invokeTool) dispatches
 * through this registry. tools/registry.test.ts pins: every declaration passes
 * contractProblems, each contract agrees with the serialised schema the model sees,
 * the contract parse is never weaker than the executor's own argument checks, and the
 * serialised schemas match the committed snapshot (a change is a deliberate update).
 *
 * None of these tools returns a record: all are AGGREGATE, customerLinkable false,
 * tier OPS, and available in every Platform area (each area's binding scopes what
 * they can see — requires.areas lists the areas explicitly, never a wildcard).
 *
 * PURE: imports the pure core and the metric registry definitions only.
 */

import type { MetricDomain } from "@/lib/platform/intelligence/metrics/registry";
import { METRICS } from "@/lib/platform/intelligence/metrics/registry";
import {
  PLATFORM_AI_MEMORY_TOOLS, PLATFORM_AI_TOOLS, executePlatformAiTool, platformAiToolSchemas,
  type PlatformAiBinding, type PlatformAiMemoryHooks, type ToolEvidence,
} from "../core";
import type { PlatformArea } from "@prisma/client";
import type { FreshGuard } from "../authz/recheck";
import type { PlatformAiToolContract, ToolAreas } from "./contract";
import { CUSTOMERS_PACK_TOOLS } from "./packs/customers.server";
import { INCIDENTS_PACK_TOOLS } from "./packs/incidents.server";

/** What the existing executor needs for one call — the per-turn context P1b passes through unchanged. */
export interface LegacyToolContext {
  binding: PlatformAiBinding;
  ev: ToolEvidence;
  paramKeys: readonly string[];
  asked?: readonly { hours: number }[];
  memory?: PlatformAiMemoryHooks;
  /**
   * P5 — THIS call's fresh guards per area (authz/boundary.ts step 4, the per-call recheck): a
   * RECORD pack reads only through the token minted from them (never stored, never serialised).
   */
  fresh?: ReadonlyMap<PlatformArea, FreshGuard>;
}

export type PlatformAiTool = PlatformAiToolContract<LegacyToolContext>;

/** Every Platform area, listed explicitly (the tools are scoped by each area's binding, not by a wildcard). */
const EVERY_AREA: ToolAreas = ["PLATFORM_OPS", "SECURITY_OPS", "GROWTH_REVENUE", "CUSTOMER_SUCCESS", "MERCHANT_OPS"];

/** The executor's own id shape (core.ts ID_SHAPE) — a registry id is looked up, never interpreted. */
const REGISTRY_ID = /^[A-Za-z0-9_:@.-]{1,120}$/;
const MEMORY_FACT_ID = /^[a-z0-9]{1,40}$/i;

const DOMAINS = [...new Set(METRICS.map((m) => m.domain))] as MetricDomain[];
const WINDOW_DAYS: number[] = [...new Set(METRICS.flatMap((m) => [...(m.window.days ?? [])]))].sort((a, b) => a - b);

/** The executor, unchanged: args re-serialised exactly as parsed. */
const viaExecutor = (name: string) => (args: Readonly<Record<string, unknown>>, ctx: LegacyToolContext) =>
  executePlatformAiTool(name, JSON.stringify(args), ctx.binding, ctx.ev, ctx.paramKeys, ctx.asked ?? [], ctx.memory);

/** The description the model sees, read from the serialised schema (one source of truth: core.ts). */
const descriptionOf = (name: string): string => {
  const all = platformAiToolSchemas([], { memory: true }) as { function: { name: string; description: string } }[];
  return all.find((s) => s.function.name === name)?.function.description ?? "";
};

const common = { requires: { areas: EVERY_AREA, level: "READ", tier: "OPS" }, scope: "AGGREGATE", customerLinkable: false, pii: 0, cost: { toolCalls: 1 } } as const;

const TOOLS: PlatformAiTool[] = [
  {
    ...common, name: "list_metrics", pack: "metrics", description: descriptionOf("list_metrics"),
    args: { properties: { domain: { kind: "enum", values: DOMAINS, optional: true } } },
    run: viaExecutor("list_metrics"),
  },
  {
    ...common, name: "get_metric", pack: "metrics", description: descriptionOf("get_metric"),
    args: { properties: {
      id: { kind: "registryId", registry: "METRIC", pattern: REGISTRY_ID, maxLength: 120 },
      window: { kind: "int", min: 1, max: 366, offered: WINDOW_DAYS, optional: true },
    } },
    run: viaExecutor("get_metric"),
  },
  {
    ...common, name: "find_page", pack: "navigation", description: descriptionOf("find_page"),
    args: { properties: { query: { kind: "guardedText", sink: "REGISTRY_LABEL_MATCH", maxLength: 80 } } },
    run: viaExecutor("find_page"),
  },
  {
    ...common, name: "open_page", pack: "navigation", description: descriptionOf("open_page"),
    args: { properties: {
      id: { kind: "registryId", registry: "PAGE", pattern: REGISTRY_ID, maxLength: 120 },
      params: { kind: "registryParams", maxValueLength: 80, optional: true },
    } },
    run: viaExecutor("open_page"),
  },
  {
    ...common, name: "recall_memory", pack: "memory", description: descriptionOf("recall_memory"),
    args: { properties: { id: { kind: "registryId", registry: "MEMORY_FACT", pattern: MEMORY_FACT_ID, maxLength: 40, optional: true } } },
    run: viaExecutor("recall_memory"),
  },
  {
    ...common, name: "propose_memory", pack: "memory", description: descriptionOf("propose_memory"),
    args: { properties: {
      factType: { kind: "enum", values: ["WATCHING_ISSUE", "OPERATIONAL_STATE", "FOLLOW_UP"] },
      concern: { kind: "enum", values: ["RECURRING_FAILURE", "DEGRADATION", "COST_SPIKE", "CUSTOMER_IMPACT", "AWAITING_FIX", "MONITOR_ONLY"], optional: true },
      subjectRef: { kind: "registryId", registry: "MEMORY_SUBJECT", pattern: REGISTRY_ID, maxLength: 120 },
      note: { kind: "guardedText", sink: "MEMORY_NOTE_GUARD", maxLength: 140, optional: true },
    } },
    run: viaExecutor("propose_memory"),
  },
  // P5 — the customers pack (tools/packs/customers.ts): CS-tier, customer-linkable RECORD tools,
  // behind PLATFORM_AI_PACK_CUSTOMERS_ENABLED (engine/router.ts PACK_FLAG; default OFF).
  ...(CUSTOMERS_PACK_TOOLS as PlatformAiTool[]),
  // P8 — the incidents pack (tools/packs/incidents.ts): an identity-free aggregate, OPS-tier RECORD tools on
  // PLATFORM_OPS and CS-tier customer-linkable RECORD tools on CUSTOMER_SUCCESS, behind
  // PLATFORM_AI_PACK_INCIDENTS_ENABLED (engine/router.ts PACK_FLAG; default OFF).
  ...(INCIDENTS_PACK_TOOLS as PlatformAiTool[]),
];

export const PLATFORM_AI_TOOL_REGISTRY: readonly PlatformAiTool[] = Object.freeze(TOOLS);

/** The tool names the registry declares, in the order the model is offered them. */
export const PLATFORM_AI_REGISTERED_TOOLS: readonly string[] = PLATFORM_AI_TOOL_REGISTRY.map((t) => t.name);

/** The declaration for a tool name, or null (an unknown tool is the boundary's NOT_FOUND). */
export function platformAiTool(name: string): PlatformAiTool | null {
  return PLATFORM_AI_TOOL_REGISTRY.find((t) => t.name === name) ?? null;
}

/**
 * The tool schemas the model is sent — THE facade over core.ts platformAiToolSchemas
 * (identical output; the snapshot test pins it). Memory tools only when memory is effective.
 */
export function platformAiRegistrySchemas(paramKeys: readonly string[], opts: { memory?: boolean } = {}): unknown[] {
  return platformAiToolSchemas(paramKeys, opts);
}

/** The core's own tool-name lists, re-exported so a reviewer can see the registry covers exactly them. */
export const CORE_TOOL_NAMES: readonly string[] = [...PLATFORM_AI_TOOLS, ...PLATFORM_AI_MEMORY_TOOLS];
