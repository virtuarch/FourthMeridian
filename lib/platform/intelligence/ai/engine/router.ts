/**
 * lib/platform/intelligence/ai/engine/router.ts  (Platform AI P2 pack flags + P3 deterministic router + `more_tools`)
 *
 * PACK FLAGS (design v2 §11, I-8). Which server flag governs each declared pack:
 *   metrics, navigation   PLATFORM_AI_ENABLED (env.isPlatformAiEnabled) — the packs Platform AI
 *                         has always had; ON wherever Platform AI itself is ON, so today's
 *                         behaviour is unchanged (no new flag to set).
 *   memory                the existing memory flag (memory/gate.ts isMemoryEffective: Platform AI
 *                         + conversations + purge + memory + memory purge, 7-day retention).
 *   future packs (P5+)    their own PLATFORM_AI_PACK_<P>_ENABLED getter in lib/env.ts (strict,
 *                         implies the master flag, default OFF) — added to PACK_FLAG with the
 *                         pack's PR, never ahead of it.
 * A pack with no entry is OFF. invokeTool (authz/boundary.ts step 1) re-checks this on EVERY call.
 *
 * ROUTER (P3, design v2 §4 / §10). Which packs' tools the model is OFFERED this turn —
 * deterministic, in code, no model involved:
 *   · the CORE packs (metrics, navigation; memory only when the turn carries memory hooks)
 *     are always routed — exactly today's six tools, so every existing answer is unchanged;
 *   · a non-core pack is routed when the operator's (already scrubbed) question matches one
 *     of its ROUTER_RULES keyword patterns, in rule order, at most ROUTER_MAX_PACKS of them;
 *   · EVERY routed pack (core included) must be DECLARED (tools/contract.ts TOOL_PACKS), have
 *     its server flag ON and be CALLABLE in this turn's area scope: one of its tools is
 *     AGGREGATE with a required area in scope, or RECORD with every required area in scope
 *     (the same rule as invokeTool step 3). Anything else is never offered.
 * A rule naming a pack that is not declared yet is INERT (P5+ packs land with their own PR;
 * their rules are written here now so the routing table is reviewed once, at P3).
 *
 * `more_tools` (the meta-tool): offered only while there is a pack it could add — declared,
 * flag ON, callable in scope, not yet routed, under ROUTER_MAX_PACKS non-core packs, and fewer
 * than MORE_TOOLS_MAX_EXPANSIONS expansions this turn. Its one argument is a CLOSED enum of
 * exactly those packs. It goes through invokeTool like any tool (authz/boundary.ts: offered,
 * strict parse, flag re-read, area scope, per-call recheck of the pack's areas) and costs one
 * tool call; the schemas it adds are sent with every later model call of the turn, so they
 * count toward PLATFORM_AI_TURN_TOKEN_CEILING through the provider's usage like any prompt.
 * Today (only the three core packs declared) nothing is ever expandable ⇒ `more_tools` is
 * never offered ⇒ the schemas sent are byte-identical to before P3 (engine/router.test.ts).
 *
 * SCHEMA TOKEN BUDGET (§10 "~12 schemas ≈ 3k tokens"): the serialised schemas of any single
 * turn — core + up to ROUTER_MAX_PACKS packs + more_tools — stay under
 * PLATFORM_AI_SCHEMA_TOKEN_BUDGET, estimated as ceil(chars / 4) of the JSON (the repo's
 * convention, lib/ai/conversation). engine/router.test.ts enforces core ≤ CORE budget, every
 * declared non-core pack ≤ PACK budget, and the worst case (core + the 3 largest packs +
 * more_tools) ≤ the turn budget — so a P5+ pack PR that bloats its schemas fails there.
 */

import type { PlatformArea } from "@prisma/client";
import { env as liveEnv } from "@/lib/env";
import { isMemoryEffective } from "../memory/gate";
import { TOOL_PACKS, contractToolSchema, type PlatformAiToolContract, type ToolPack } from "../tools/contract";
import { CORE_TOOL_NAMES, PLATFORM_AI_TOOL_REGISTRY, platformAiRegistrySchemas } from "../tools/registry";

/** The env getters the pack flags read (a test passes its own; an absent pack getter is OFF). */
export type PackFlagEnv = Pick<typeof liveEnv, "isPlatformAiEnabled" | "isPlatformAiMemoryEnabled">
  & Partial<Pick<typeof liveEnv, "isPlatformAiPackCustomersEnabled">>;

const PACK_FLAG: Readonly<Record<ToolPack, (e: PackFlagEnv) => boolean>> = {
  metrics: (e) => e.isPlatformAiEnabled === true,
  navigation: (e) => e.isPlatformAiEnabled === true,
  memory: (e) => e.isPlatformAiEnabled === true && isMemoryEffective(e),
  // P5 (PACK-PR-CONDITIONS 3): the strict getter (master AND PLATFORM_AI_PACK_CUSTOMERS_ENABLED === "true"; default OFF).
  customers: (e) => e.isPlatformAiEnabled === true && e.isPlatformAiPackCustomersEnabled === true,
};

/** Is this pack's server flag ON? Unknown pack ⇒ false. */
export function platformAiPackEnabled(pack: ToolPack, e: PackFlagEnv = liveEnv): boolean {
  const f = (PACK_FLAG as Record<string, ((x: PackFlagEnv) => boolean) | undefined>)[pack];
  return typeof f === "function" && f(e) === true;
}

// ── The routing table ────────────────────────────────────────────────────────

/** Routed on every turn (today's behaviour); memory only with the turn's memory hooks. */
export const CORE_PACKS: readonly string[] = ["metrics", "navigation", "memory"];

/** Non-core packs a turn may carry (keyword-routed + more_tools expansions together). Design §10: ≤ 3. */
export const ROUTER_MAX_PACKS = 3;
/** more_tools calls that may ADD a pack per turn (each adds one; each costs one tool call). */
export const MORE_TOOLS_MAX_EXPANSIONS = 2;
export const MORE_TOOLS_NAME = "more_tools";

/** Token estimate of a serialised value: ceil(chars / 4) (repo convention, lib/ai/conversation). */
export const estimateSchemaTokens = (v: unknown): number => Math.ceil(JSON.stringify(v ?? "").length / 4);
/** Every tool schema sent in ONE model call of a turn (core + ≤ 3 packs + more_tools). */
export const PLATFORM_AI_SCHEMA_TOKEN_BUDGET = 4_000;
/** The core packs' schemas (today's six tools, memory on, the widest page-filter set). */
export const CORE_SCHEMA_TOKEN_BUDGET = 1_600;
/** One non-core pack's schemas (design §10: ~4 tools ≈ 1k tokens per pack). */
export const PACK_SCHEMA_TOKEN_BUDGET = 750;

/**
 * Keyword rules, in PRIORITY order (the first ROUTER_MAX_PACKS matching packs win). Matched
 * against the scrubbed question only, case-insensitive, whole words. A rule's pack routes
 * only when declared + flag ON + callable in scope. Changing this table is an S2 P3 item.
 */
export const ROUTER_RULES: readonly { readonly pack: string; readonly match: RegExp }[] = [
  { pack: "incidents", match: /\b(?:incidents?|outages?|alerts?|alerting|investigat(?:e|ed|ing|ion)|root cause|broken|degraded|degradation)\b/i },
  { pack: "connections", match: /\b(?:connections?|connected|wallets?|institutions?|banks?|re-?auth(?:enticate|orization)?|relink|link(?:ed)? accounts?|plaid)\b/i },
  { pack: "jobs", match: /\b(?:jobs?|cron|scheduler|scheduled|refresh(?:es|ed|ing)?|sync(?:s|ed|ing)?|pipeline|executions?|retries|backlog)\b/i },
  // S2 P5 follow-up (e): NARROWED. Bare "users?" / "members?" / "new users?" are gone — they matched
  // growth questions ("how many users signed up"), staff ("members of the ops team") and anything
  // about operators. Kept: the CS vocabulary itself (customer(s) — also the resolved-subject marker
  // "[customer h_…]"), the two unambiguous synonyms "account holder(s)" / "member account(s)", and
  // the existing CS phrases (accounts needing, attention, recently/newly joined). Sign-ups stay with
  // growth. Conservative on purpose: a missed route still has more_tools; a false route spends schema.
  { pack: "customers", match: /\b(?:customers?|account holders?|member accounts?|accounts? needing|attention|(?:recently|newly) joined)\b/i },
  { pack: "onboarding", match: /\b(?:onboard(?:ing|ed)?|imports?|imported|importing|first connection|activation)\b/i },
  { pack: "providers", match: /\b(?:providers?|vendors?|upstream|email deliver(?:y|ability)|bounces?|provider cost|call volume)\b/i },
  { pack: "ai_usage", match: /\b(?:ai (?:usage|spend|cost|calls?|budget)|tokens?|llm|model (?:cost|usage|calls?)|briefs?|invocations?)\b/i },
  { pack: "audit_history", match: /\b(?:audit(?: log| trail)?|history|who (?:changed|did|approved)|operator actions?|activity log)\b/i },
  { pack: "policies", match: /\b(?:polic(?:y|ies)|cadence|controls?|kill switch|cost freeze|rate limits?)\b/i },
  { pack: "growth", match: /\b(?:growth|sign-?ups?|waitlist|beta requests?|retention|churn|acquisition|funnel)\b/i },
  { pack: "merchants", match: /\b(?:merchants?|descriptors?|merchant aliases?|categori[sz]ation)\b/i },
];

// ── The rule over packs ──────────────────────────────────────────────────────

type Tool = PlatformAiToolContract<never>;
export interface RouterDeps {
  /** The pack's server flag (default: platformAiPackEnabled over the live env). */
  enabled?: (pack: string) => boolean;
  /** Tests only: a registry other than the real one. */
  registry?: readonly Tool[];
  /** Tests only: the declared packs (default TOOL_PACKS). */
  declared?: readonly string[];
}

const depsOf = (d: RouterDeps) => ({
  enabled: d.enabled ?? ((p: string) => platformAiPackEnabled(p as ToolPack)),
  registry: (d.registry ?? PLATFORM_AI_TOOL_REGISTRY) as readonly Tool[],
  declared: d.declared ?? (TOOL_PACKS as readonly string[]),
});

/** invokeTool step 3, per tool: AGGREGATE ⇒ some required area in scope; RECORD ⇒ every one. */
export function toolCallableIn(t: Pick<Tool, "scope" | "requires">, areas: readonly PlatformArea[]): boolean {
  const req = t.requires.areas;
  return t.scope === "RECORD" ? req.every((a) => areas.includes(a)) : req.some((a) => areas.includes(a));
}

/** Declared, flag ON (a throwing flag is OFF), with at least one tool callable in `areas`. */
function packOffered(pack: string, areas: readonly PlatformArea[], d: ReturnType<typeof depsOf>): boolean {
  if (!d.declared.includes(pack)) return false;
  let on = false;
  try { on = d.enabled(pack) === true; } catch { on = false; }
  return on && d.registry.some((t) => t.pack === pack && toolCallableIn(t, areas));
}

export interface RouteInput {
  /** The SCRUBBED question; null = not known yet (before the turn reads it, or a composed briefing) ⇒ core packs only. */
  readonly question: string | null;
  /** This turn's area scope (route-issued ScopedAreas' areas). */
  readonly areas: readonly PlatformArea[];
  /** The turn carries memory hooks (memory is effective for it). */
  readonly memory: boolean;
}

/** The core packs this turn can serve, in TOOL_PACKS order. */
function corePacks(input: RouteInput, d: ReturnType<typeof depsOf>): string[] {
  return d.declared.filter((p) => CORE_PACKS.includes(p) && (p !== "memory" || input.memory) && packOffered(p, input.areas, d));
}

/**
 * THE ROUTER: the packs whose tools this turn offers — the core packs it can serve, then up to
 * ROUTER_MAX_PACKS keyword-matched packs (rule order). Deterministic; no I/O beyond the flag getters.
 */
export function routePlatformAiPacks(input: RouteInput, e: PackFlagEnv = liveEnv, deps: RouterDeps = {}): ToolPack[] {
  const d = depsOf({ enabled: (p) => platformAiPackEnabled(p as ToolPack, e), ...deps });
  const out = corePacks(input, d);
  const q = typeof input.question === "string" ? input.question : "";
  let extra = 0;
  for (const r of ROUTER_RULES) {
    if (extra >= ROUTER_MAX_PACKS) break;
    if (CORE_PACKS.includes(r.pack) || out.includes(r.pack) || !r.match.test(q)) continue;
    if (!packOffered(r.pack, input.areas, d)) continue;
    out.push(r.pack);
    extra++;
  }
  return out as ToolPack[];
}

/**
 * The packs `more_tools` may add now: declared, flag ON, callable in `areas`, not routed, not
 * core, while fewer than ROUTER_MAX_PACKS non-core packs are routed and fewer than
 * MORE_TOOLS_MAX_EXPANSIONS expansions were made. Empty ⇒ more_tools is not offered.
 */
export function expandablePlatformAiPacks(
  input: { routed: readonly string[]; areas: readonly PlatformArea[]; expansions: number },
  e: PackFlagEnv = liveEnv, deps: RouterDeps = {},
): ToolPack[] {
  const d = depsOf({ enabled: (p) => platformAiPackEnabled(p as ToolPack, e), ...deps });
  if (input.expansions >= MORE_TOOLS_MAX_EXPANSIONS) return [];
  if (input.routed.filter((p) => !CORE_PACKS.includes(p)).length >= ROUTER_MAX_PACKS) return [];
  return d.declared.filter((p) => !CORE_PACKS.includes(p) && !input.routed.includes(p) && packOffered(p, input.areas, d)) as ToolPack[];
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const MORE_TOOLS_DESCRIPTION = "Add ONE more tool pack to this turn when the tools you have cannot answer the question. "
  + "Choose a pack from the enum; its tools are offered from your next step. Costs one tool call; at most "
  + `${MORE_TOOLS_MAX_EXPANSIONS} per turn.`;

/** The more_tools schema over exactly these packs (a closed enum; never offered with an empty one). */
export function moreToolsSchema(packs: readonly string[]): unknown {
  return {
    type: "function",
    function: {
      name: MORE_TOOLS_NAME, description: MORE_TOOLS_DESCRIPTION,
      parameters: { type: "object", properties: { pack: { type: "string", enum: [...packs] } }, required: ["pack"], additionalProperties: false },
    },
  };
}

/**
 * The tool schemas one model call of the turn is sent: the existing six tools' schemas exactly
 * as core.ts serialises them (filtered to routed + callable — today: all of them, unchanged),
 * then every other routed pack's callable tools (tools/contract.ts contractToolSchema), then
 * more_tools when `expandable` is non-empty. Order = registry order.
 */
export function platformAiOfferedSchemas(
  input: { packs: readonly string[]; areas: readonly PlatformArea[]; memory: boolean; paramKeys: readonly string[]; expandable: readonly string[] },
  deps: Pick<RouterDeps, "registry"> = {},
): unknown[] {
  const registry = (deps.registry ?? PLATFORM_AI_TOOL_REGISTRY) as readonly Tool[];
  const offered = (t: Tool) => input.packs.includes(t.pack) && (t.pack !== "memory" || input.memory) && toolCallableIn(t, input.areas);
  const legacy = new Set(registry.filter((t) => CORE_TOOL_NAMES.includes(t.name) && offered(t)).map((t) => t.name));
  const out: unknown[] = (platformAiRegistrySchemas(input.paramKeys, { memory: input.memory }) as { function: { name: string } }[])
    .filter((s) => legacy.has(s.function.name));
  for (const t of registry) if (!CORE_TOOL_NAMES.includes(t.name) && offered(t)) out.push(contractToolSchema(t, input.paramKeys));
  if (input.expandable.length > 0) out.push(moreToolsSchema(input.expandable));
  return out;
}

// ── The per-turn router the production callers inject into the boundary ──────

/** What authz/boundary.ts needs from the router (injected; the boundary reads no env itself). */
export interface PlatformAiTurnRouter {
  route(question: string | null, areas: readonly PlatformArea[]): readonly ToolPack[];
  expandable(routed: readonly ToolPack[], areas: readonly PlatformArea[], expansions: number): readonly ToolPack[];
  schemas(input: { packs: readonly ToolPack[]; areas: readonly PlatformArea[]; paramKeys: readonly string[]; expandable: readonly ToolPack[] }): unknown[];
}

/** The production router for a turn (`memory` = the turn carries memory hooks). */
export function platformAiTurnRouter(turn: { memory: boolean }, e: PackFlagEnv = liveEnv, deps: RouterDeps = {}): PlatformAiTurnRouter {
  return {
    route: (question, areas) => routePlatformAiPacks({ question, areas, memory: turn.memory }, e, deps),
    expandable: (routed, areas, expansions) => expandablePlatformAiPacks({ routed, areas, expansions }, e, deps),
    schemas: (i) => platformAiOfferedSchemas({ ...i, memory: turn.memory }, deps),
  };
}
