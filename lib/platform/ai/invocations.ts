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
 * environment. There is no user or Space filter YET: the ledger records both
 * since 2026-10-07 (owner ruling, lib/ai/invocation.ts), but a per-user reader
 * is a P1 surface with its own identity-fence ruling (CUSTOMER_SUCCESS), so
 * this fleet-level PLATFORM_OPS reader exposes neither and says so.
 *
 * OUTCOMES (OPERATIONALIZATION P0): the ledger now holds FAILURE rows beside
 * billed ones (outcome != RETURNED, zero tokens). Every token, latency and
 * dollar figure here is folded over RETURNED rows ONLY — a failure costs
 * nothing and must not dilute a mean latency — and failures are reported as
 * their own counts.
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
  /** Opaque conversation/brief correlator (for chat, the conversation id), never a user id. */
  correlationId: string | null;
  turnIndex: number | null;
  /** "chat:answer" | "chat:guidance" | "brief:generate" | null. */
  subSurface: string | null;
  /** RETURNED | FAILED | TIMEOUT | RATE_LIMITED | QUOTA. */
  outcome: string;
  /** Provider error CODE for a non-RETURNED row; null otherwise. */
  errorCode: string | null;
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
  /** Provider calls in the window that did NOT return usage, by outcome. Unpriced by construction. */
  failures: AiFailureCounts;
  /**
   * What this authority records and does not expose, stated so a reader never
   * infers a zero: failures ARE recorded (since 2026-10-07); user and Space ARE
   * recorded but not exposed on this fleet-level reader.
   */
  limits: {
    failuresRecorded: true;
    userDimension: "RECORDED_NOT_EXPOSED";
    spaceDimension: "RECORDED_NOT_EXPOSED";
    note: string;
  };
  checkedAt: string;
}

export interface AiFailureCounts {
  failed: number;
  timeouts: number;
  rateLimited: number;
  quota: number;
  total: number;
}

/** Pure: fold (outcome, count) groups into the failure counts. RETURNED is excluded. */
export function buildAiFailureCounts(groups: readonly { outcome: string; count: number }[]): AiFailureCounts {
  const n = (o: string) => groups.filter((g) => g.outcome === o).reduce((a, g) => a + g.count, 0);
  const failed = n("FAILED"), timeouts = n("TIMEOUT"), rateLimited = n("RATE_LIMITED"), quota = n("QUOTA");
  return { failed, timeouts, rateLimited, quota, total: failed + timeouts + rateLimited + quota };
}

export interface AiOperationsReaders {
  now(): Date;
  /** RETURNED rows only — the billed population. */
  groups(since: Date, until: Date, f: AiOperationsFilter): Promise<InvocationGroup[]>;
  recent(since: Date, until: Date, f: AiOperationsFilter, take: number): Promise<RecentInvocation[]>;
  /** Non-RETURNED rows, grouped by outcome. */
  failures(since: Date, until: Date, f: AiOperationsFilter): Promise<{ outcome: string; count: number }[]>;
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
        WHERE ${where(since, until, f)} AND "outcome" = 'RETURNED'
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
          correlationId: true, turnIndex: true, subSurface: true, outcome: true, errorCode: true,
          promptTokens: true, cachedPromptTokens: true,
          completionTokens: true, reasoningTokens: true, toolCallCount: true, latencyMs: true, finishReason: true,
        },
      });
      return rows.map((r) => ({
        occurredAt: r.occurredAt.toISOString(), provider: r.provider, model: r.model, surface: r.surface,
        environment: r.environment, correlationId: r.correlationId, turnIndex: r.turnIndex,
        subSurface: r.subSurface, outcome: r.outcome, errorCode: r.errorCode,
        promptTokens: r.promptTokens, cachedPromptTokens: r.cachedPromptTokens, completionTokens: r.completionTokens,
        reasoningTokens: r.reasoningTokens, toolCalls: r.toolCallCount, latencyMs: r.latencyMs, finishReason: r.finishReason,
      }));
    },
    async failures(since, until, f) {
      const rows = await db.aiInvocation.groupBy({
        by: ["outcome"],
        where: {
          occurredAt: { gte: since, lte: until },
          outcome: { not: "RETURNED" },
          ...(f.surface ? { surface: f.surface } : {}),
          ...(f.model ? { model: f.model } : {}),
          ...(f.environment ? { environment: f.environment } : {}),
        },
        _count: { _all: true },
      });
      return rows.map((r) => ({ outcome: r.outcome, count: r._count._all }));
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
  const [groups, allGroups, recent, failureGroups] = await Promise.all([
    readers.groups(since, now, filter),
    readers.groups(since, now, unfiltered),
    readers.recent(since, now, filter, RECENT_INVOCATIONS),
    readers.failures(since, now, filter),
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
    failures: buildAiFailureCounts(failureGroups),
    limits: {
      failuresRecorded: true,
      userDimension: "RECORDED_NOT_EXPOSED",
      spaceDimension: "RECORDED_NOT_EXPOSED",
      note: "Tokens, latency and dollars fold over RETURNED (billed) rows only; provider calls that threw are recorded as zero-token failure rows and counted under 'failures'. User and Space are recorded (owner ruling 2026-10-07) but not exposed on this fleet-level reader.",
    },
    checkedAt: now.toISOString(),
  };
}
