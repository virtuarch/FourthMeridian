/**
 * lib/platform/ai/invocations.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The AI operations read model over the per-invocation ledger (AiInvocation)
 * — the first production reader of that table. Bounded and server-side:
 *
 *   · ONE grouped query per read, at the (provider, model, surface,
 *     environment, UTC day) grain — the row population is never loaded;
 *   · ONE bounded page of the newest invocations (the request/turn grain the
 *     ledger genuinely records: correlationId is an opaque digest, turnIndex an
 *     ordinal; neither resolves to a person);
 *   · dollars from the ONE rate card via the pure fold (invocations-core.ts).
 *
 * Filters are the ledger's own recorded dimensions: window, surface, model,
 * environment. There is deliberately no user or Space filter — the ledger does
 * not record them (lib/ai/invocation.ts), and the result says so rather than
 * accepting a parameter it cannot honour.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isPricingConfigured } from "@/lib/usage/pricing";
import {
  buildAiOperations,
  parseAiWindow,
  windowStart,
  type AiOperationsCore,
  type AiWindow,
  type InvocationGroup,
} from "@/lib/platform/ai/invocations-core";

export interface AiOperationsFilter {
  window: AiWindow;
  surface?: string;
  model?: string;
  environment?: string;
}

export interface RecentInvocation {
  occurredAt: string;
  provider: string;
  model: string;
  surface: string | null;
  environment: string;
  /** Opaque conversation/brief correlator (a digest), never a user id. */
  correlationId: string | null;
  turnIndex: number | null;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  latencyMs: number;
  finishReason: string | null;
}

export interface AiOperations extends AiOperationsCore {
  window: { key: AiWindow; from: string; to: string };
  filter: { surface: string | null; model: string | null; environment: string | null };
  /** Distinct values seen in the window, for the operator's filter controls. */
  available: { surfaces: string[]; models: string[]; environments: string[] };
  recent: RecentInvocation[];
  pricingConfigured: boolean;
  /**
   * What this authority does NOT record, stated so a reader never infers a
   * zero: no failures (billed, returned calls only) and no user/Space.
   */
  limits: {
    failuresRecorded: false;
    userDimension: "NOT_RECORDED";
    spaceDimension: "NOT_RECORDED";
    note: string;
  };
  checkedAt: string;
}

export interface AiOperationsReaders {
  now(): Date;
  groups(since: Date, until: Date, f: AiOperationsFilter): Promise<InvocationGroup[]>;
  recent(since: Date, until: Date, f: AiOperationsFilter, take: number): Promise<RecentInvocation[]>;
}

export const RECENT_INVOCATIONS = 20;

interface RawGroup {
  provider: string; model: string; surface: string | null; environment: string; day: string;
  invocations: bigint | number; prompt: bigint | number; cached: bigint | number; completion: bigint | number;
  reasoning: bigint | number; tool_calls: bigint | number; latency_total: bigint | number; latency_max: bigint | number | null;
}

function realReaders(): AiOperationsReaders {
  const where = (since: Date, until: Date, f: AiOperationsFilter) => Prisma.sql`
    "occurredAt" >= ${since} AND "occurredAt" <= ${until}
    ${f.surface ? Prisma.sql`AND "surface" = ${f.surface}` : Prisma.empty}
    ${f.model ? Prisma.sql`AND "model" = ${f.model}` : Prisma.empty}
    ${f.environment ? Prisma.sql`AND "environment" = ${f.environment}` : Prisma.empty}`;
  return {
    now: () => new Date(),
    async groups(since, until, f) {
      const rows = await db.$queryRaw<RawGroup[]>`
        SELECT "provider", "model", "surface", "environment",
               to_char(("occurredAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "day",
               count(*)::bigint AS "invocations",
               sum("promptTokens")::bigint AS "prompt",
               sum("cachedPromptTokens")::bigint AS "cached",
               sum("completionTokens")::bigint AS "completion",
               sum("reasoningTokens")::bigint AS "reasoning",
               sum("toolCallCount")::bigint AS "tool_calls",
               sum("latencyMs")::bigint AS "latency_total",
               max("latencyMs")::bigint AS "latency_max"
        FROM "AiInvocation"
        WHERE ${where(since, until, f)}
        GROUP BY 1, 2, 3, 4, 5`;
      return rows.map((r) => ({
        provider: r.provider, model: r.model, surface: r.surface, environment: r.environment, day: r.day,
        invocations: Number(r.invocations), promptTokens: Number(r.prompt), cachedPromptTokens: Number(r.cached),
        completionTokens: Number(r.completion), reasoningTokens: Number(r.reasoning), toolCalls: Number(r.tool_calls),
        latencyMsTotal: Number(r.latency_total), latencyMsMax: Number(r.latency_max ?? 0),
      }));
    },
    async recent(since, until, f, take) {
      const rows = await db.aiInvocation.findMany({
        where: {
          occurredAt: { gte: since, lte: until },
          ...(f.surface ? { surface: f.surface } : {}),
          ...(f.model ? { model: f.model } : {}),
          ...(f.environment ? { environment: f.environment } : {}),
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take,
        select: {
          occurredAt: true, provider: true, model: true, surface: true, environment: true,
          correlationId: true, turnIndex: true, promptTokens: true, cachedPromptTokens: true,
          completionTokens: true, reasoningTokens: true, toolCallCount: true, latencyMs: true, finishReason: true,
        },
      });
      return rows.map((r) => ({
        occurredAt: r.occurredAt.toISOString(), provider: r.provider, model: r.model, surface: r.surface,
        environment: r.environment, correlationId: r.correlationId, turnIndex: r.turnIndex,
        promptTokens: r.promptTokens, cachedPromptTokens: r.cachedPromptTokens, completionTokens: r.completionTokens,
        reasoningTokens: r.reasoningTokens, toolCalls: r.toolCallCount, latencyMs: r.latencyMs, finishReason: r.finishReason,
      }));
    },
  };
}

export function parseAiOperationsFilter(params: URLSearchParams): AiOperationsFilter {
  const pick = (k: string) => { const v = params.get(k)?.trim(); return v && v.length <= 80 ? v : undefined; };
  return { window: parseAiWindow(params.get("window")), surface: pick("surface"), model: pick("model"), environment: pick("environment") };
}

export async function getAiOperations(
  filter: AiOperationsFilter,
  deps: { readers?: AiOperationsReaders } = {},
): Promise<AiOperations> {
  const readers = deps.readers ?? realReaders();
  const now = readers.now();
  const since = windowStart(filter.window, now);
  // The filter values are sourced from the unfiltered window so a chosen
  // surface never hides the others from the control that chose it.
  const unfiltered: AiOperationsFilter = { window: filter.window };
  const [groups, allGroups, recent] = await Promise.all([
    readers.groups(since, now, filter),
    readers.groups(since, now, unfiltered),
    readers.recent(since, now, filter, RECENT_INVOCATIONS),
  ]);
  const core = buildAiOperations(groups);
  const distinct = (pick: (g: InvocationGroup) => string | null) =>
    [...new Set(allGroups.map(pick).filter((v): v is string => v !== null))].sort();
  return {
    ...core,
    window: { key: filter.window, from: since.toISOString(), to: now.toISOString() },
    filter: { surface: filter.surface ?? null, model: filter.model ?? null, environment: filter.environment ?? null },
    available: {
      surfaces: distinct((g) => g.surface),
      models: distinct((g) => `${g.provider}:${g.model}`),
      environments: distinct((g) => g.environment),
    },
    recent,
    pricingConfigured: isPricingConfigured(),
    limits: {
      failuresRecorded: false,
      userDimension: "NOT_RECORDED",
      spaceDimension: "NOT_RECORDED",
      note: "The invocation ledger records billed, returned provider calls only — a timeout or refused request writes no row — and carries no user or Space identity by design.",
    },
    checkedAt: now.toISOString(),
  };
}
