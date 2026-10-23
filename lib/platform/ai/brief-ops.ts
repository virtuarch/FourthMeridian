/**
 * lib/platform/ai/brief-ops.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * Daily Brief OPERATIONS: what the Brief persistence (DailyBrief) and the
 * invocation ledger (AiInvocation, joined on the Brief's correlationId) can
 * prove about generation, failure, staleness and cost. The first operator
 * reader of either for the Brief.
 *
 * WHAT IS PROVABLE FROM THE ROWS, and how each state is derived
 * (lib/ai/brief/state.ts is the product rule; this mirrors its columns):
 *   GENERATED     generatedAt set (content persisted)
 *   FAILED        lastFailedAt set and newer than generatedAt (or no generation)
 *   IN_PROGRESS   generationStartedAt set within the lease
 *   VERSION_STALE generated under an older generation version than the code's
 *                 (generationVersionOf(promptVersion) ≠ BRIEF_GENERATION_VERSION)
 *   EMPTY         a row with neither a generation nor a failure (claimed then
 *                 released, or NO_DATA)
 *
 * WHAT IS NOT PROVABLE, stated on the result rather than approximated:
 *   · cache hits / reuse — a CACHED read and a WATERMARK_REFRESHED read write
 *     no counter and no timestamp; reuse cannot be counted from persistence;
 *   · generation duration — measured in-process and never persisted; the
 *     provider round-trip on the joined invocation is the only latency;
 *   · failed-attempt cost — a failed generation persists no correlationId and
 *     a timed-out call writes no invocation; failures cost is not derivable.
 *
 * ECONOMICS: exact per-Brief cost for SUCCESSFUL generations, because the join
 * is 1:1 on correlationId (schema DailyBrief.correlationId). The surface-level
 * total (`surface = 'brief'` invocations in the window) is reported beside it so
 * an uncorrelated generation is visible as a difference, never hidden.
 */

import "server-only";
import { db } from "@/lib/db";
import {
  BRIEF_GENERATION_VERSION,
  GENERATION_FAILURE_COOLDOWN_MS,
  GENERATION_LEASE_MS,
  generationVersionOf,
} from "@/lib/ai/brief/policy";
import { priceInvocation, type InvocationFact } from "@/lib/platform/ai/invocation-economics";
import { parseAiWindow, windowStart, type AiWindow } from "@/lib/platform/ai/invocations-core";

export type BriefRowState = "GENERATED" | "FAILED" | "IN_PROGRESS" | "EMPTY";

export interface BriefRowFact {
  spaceId: string;
  ownerUserId: string;
  /** YYYY-MM-DD */
  briefDay: string;
  generatedAt: Date | null;
  generationStartedAt: Date | null;
  lastFailedAt: Date | null;
  lastFailureReason: string | null;
  model: string | null;
  promptVersion: string | null;
  correlationId: string | null;
  updatedAt: Date;
}

export interface BriefInvocationFact extends InvocationFact {
  correlationId: string;
}

export interface BriefOpsRow {
  /** Opaque Space reference (last 6 of the id) — never a name, never an owner. */
  spaceRef: string;
  briefDay: string;
  state: BriefRowState;
  /** "daily" | "change" | "version" | null — recovered from the correlationId prefix on success. */
  generationReason: string | null;
  versionStale: boolean;
  coolingDown: boolean;
  generatedAt: string | null;
  lastFailedAt: string | null;
  lastFailureReason: string | null;
  model: string | null;
  generationVersion: string | null;
  /** The joined invocation, when one exists (success only). */
  invocation: { latencyMs: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number; usd: number | null } | null;
}

export interface BriefOps {
  window: { key: AiWindow; from: string; to: string };
  currentGenerationVersion: string;
  counts: {
    rows: number;
    generated: number;
    failed: number;
    inProgress: number;
    empty: number;
    versionStale: number;
    coolingDown: number;
    distinctSpaces: number;
    distinctOwners: number;
  };
  failureReasons: Readonly<Record<string, number>>;
  generationReasons: Readonly<Record<string, number>>;
  byDay: readonly { day: string; generated: number; failed: number }[];
  economics: {
    /** Invocations joined to a Brief row in the window (exact per-Brief). */
    correlated: { invocations: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number; usd: number | null; unpricedInvocations: number; meanLatencyMs: number | null };
    /** Every `surface = 'brief'` invocation in the window (the surface total). */
    surfaceTotal: { invocations: number; usd: number | null };
    /** Successful generations in the window with no invocation row to join. */
    uncorrelatedGenerations: number;
  };
  rows: readonly BriefOpsRow[];
  limits: {
    reuseCounted: false;
    generationDurationRecorded: false;
    failedAttemptCostRecorded: false;
    note: string;
  };
  checkedAt: string;
}

export interface BriefOpsReaders {
  now(): Date;
  /** Brief rows whose day falls in the window, newest first, bounded. */
  rows(fromDay: string, take: number): Promise<BriefRowFact[]>;
  /** Invocations joined by correlationId (bounded by the ids given). */
  invocationsFor(correlationIds: readonly string[]): Promise<BriefInvocationFact[]>;
  /** The surface's invocations in the window, as facts (bounded). */
  surfaceInvocations(since: Date, until: Date, take: number): Promise<InvocationFact[]>;
}

export const BRIEF_ROWS_LIMIT = 500;
export const BRIEF_LIST_LIMIT = 30;
const SURFACE_INVOCATIONS_LIMIT = 5000;

const dayISO = (d: Date) => d.toISOString().slice(0, 10);

function realReaders(): BriefOpsReaders {
  return {
    now: () => new Date(),
    async rows(fromDay, take) {
      const rows = await db.dailyBrief.findMany({
        where: { briefDay: { gte: new Date(`${fromDay}T00:00:00.000Z`) } },
        orderBy: [{ briefDay: "desc" }, { updatedAt: "desc" }],
        take,
        select: {
          spaceId: true, ownerUserId: true, briefDay: true, generatedAt: true, generationStartedAt: true,
          lastFailedAt: true, lastFailureReason: true, model: true, promptVersion: true, correlationId: true, updatedAt: true,
        },
      });
      return rows.map((r) => ({ ...r, briefDay: dayISO(r.briefDay) }));
    },
    async invocationsFor(correlationIds) {
      if (correlationIds.length === 0) return [];
      const rows = await db.aiInvocation.findMany({
        where: { correlationId: { in: [...correlationIds] } },
        select: {
          provider: true, model: true, occurredAt: true, promptTokens: true, cachedPromptTokens: true,
          completionTokens: true, reasoningTokens: true, latencyMs: true, toolCallCount: true,
          environment: true, correlationId: true, turnIndex: true, surface: true,
        },
      });
      return rows.filter((r): r is typeof r & { correlationId: string } => r.correlationId !== null);
    },
    async surfaceInvocations(since, until, take) {
      return db.aiInvocation.findMany({
        where: { surface: "brief", occurredAt: { gte: since, lte: until } },
        take,
        select: {
          provider: true, model: true, occurredAt: true, promptTokens: true, cachedPromptTokens: true,
          completionTokens: true, reasoningTokens: true, latencyMs: true, toolCallCount: true,
          environment: true, correlationId: true, turnIndex: true, surface: true,
        },
      });
    },
  };
}

/** The generation reason encoded in a success correlationId (`brief_<reason>_<uuid>`). */
export function briefGenerationReason(correlationId: string | null): string | null {
  if (!correlationId) return null;
  const m = /^brief_(daily|change|version)_/.exec(correlationId);
  return m ? m[1] : null;
}

export function classifyBriefRow(row: BriefRowFact, now: Date): { state: BriefRowState; versionStale: boolean; coolingDown: boolean } {
  const generated = row.generatedAt !== null;
  const failed = row.lastFailedAt !== null && (row.generatedAt === null || row.lastFailedAt > row.generatedAt);
  const inProgress = row.generationStartedAt !== null && now.getTime() - row.generationStartedAt.getTime() < GENERATION_LEASE_MS;
  const state: BriefRowState = inProgress ? "IN_PROGRESS" : failed ? "FAILED" : generated ? "GENERATED" : "EMPTY";
  const versionStale = generated && generationVersionOf(row.promptVersion) !== BRIEF_GENERATION_VERSION;
  const coolingDown = failed && row.lastFailedAt !== null && now.getTime() - row.lastFailedAt.getTime() < GENERATION_FAILURE_COOLDOWN_MS;
  return { state, versionStale, coolingDown };
}

function sumPriced(invocations: readonly InvocationFact[]) {
  let usd: number | null = null; let unpriced = 0; let latency = 0;
  const t = { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
  for (const inv of invocations) {
    const p = priceInvocation(inv);
    if (p.usd === null) unpriced += 1; else usd = (usd ?? 0) + p.usd;
    t.promptTokens += inv.promptTokens; t.cachedPromptTokens += inv.cachedPromptTokens; t.completionTokens += inv.completionTokens;
    latency += inv.latencyMs;
  }
  return { invocations: invocations.length, ...t, usd, unpricedInvocations: unpriced, meanLatencyMs: invocations.length ? Math.round(latency / invocations.length) : null };
}

export function parseBriefOpsWindow(params: URLSearchParams): AiWindow {
  return parseAiWindow(params.get("window"));
}

export async function getBriefOps(window: AiWindow, deps: { readers?: BriefOpsReaders } = {}): Promise<BriefOps> {
  const readers = deps.readers ?? realReaders();
  const now = readers.now();
  const since = windowStart(window, now);
  const rows = await readers.rows(dayISO(since), BRIEF_ROWS_LIMIT);
  const correlationIds = rows.map((r) => r.correlationId).filter((c): c is string => c !== null);
  const [joined, surfaceRows] = await Promise.all([
    readers.invocationsFor(correlationIds),
    readers.surfaceInvocations(since, now, SURFACE_INVOCATIONS_LIMIT),
  ]);
  const byCorrelation = new Map(joined.map((inv) => [inv.correlationId, inv]));

  const counts = { rows: rows.length, generated: 0, failed: 0, inProgress: 0, empty: 0, versionStale: 0, coolingDown: 0, distinctSpaces: 0, distinctOwners: 0 };
  const failureReasons: Record<string, number> = {};
  const generationReasons: Record<string, number> = {};
  const byDayMap = new Map<string, { day: string; generated: number; failed: number }>();
  const spaces = new Set<string>(); const owners = new Set<string>();
  let uncorrelated = 0;
  const list: BriefOpsRow[] = [];

  for (const row of rows) {
    const c = classifyBriefRow(row, now);
    spaces.add(row.spaceId); owners.add(row.ownerUserId);
    if (c.state === "GENERATED") counts.generated++;
    if (c.state === "FAILED") counts.failed++;
    if (c.state === "IN_PROGRESS") counts.inProgress++;
    if (c.state === "EMPTY") counts.empty++;
    if (c.versionStale) counts.versionStale++;
    if (c.coolingDown) counts.coolingDown++;
    if (c.state === "FAILED" && row.lastFailureReason) failureReasons[row.lastFailureReason] = (failureReasons[row.lastFailureReason] ?? 0) + 1;
    const reason = briefGenerationReason(row.correlationId);
    if (row.generatedAt && reason) generationReasons[reason] = (generationReasons[reason] ?? 0) + 1;
    const day = byDayMap.get(row.briefDay) ?? { day: row.briefDay, generated: 0, failed: 0 };
    if (row.generatedAt) day.generated++;
    if (c.state === "FAILED") day.failed++;
    byDayMap.set(row.briefDay, day);
    const inv = row.correlationId ? byCorrelation.get(row.correlationId) ?? null : null;
    if (row.generatedAt && !inv) uncorrelated++;
    if (list.length < BRIEF_LIST_LIMIT) {
      list.push({
        spaceRef: `…${row.spaceId.slice(-6)}`,
        briefDay: row.briefDay,
        state: c.state,
        generationReason: reason,
        versionStale: c.versionStale,
        coolingDown: c.coolingDown,
        generatedAt: row.generatedAt?.toISOString() ?? null,
        lastFailedAt: row.lastFailedAt?.toISOString() ?? null,
        lastFailureReason: row.lastFailureReason,
        model: row.model,
        generationVersion: generationVersionOf(row.promptVersion),
        invocation: inv ? { latencyMs: inv.latencyMs, promptTokens: inv.promptTokens, cachedPromptTokens: inv.cachedPromptTokens, completionTokens: inv.completionTokens, usd: priceInvocation(inv).usd } : null,
      });
    }
  }
  counts.distinctSpaces = spaces.size; counts.distinctOwners = owners.size;
  const surfaceTotal = sumPriced(surfaceRows);

  return {
    window: { key: window, from: since.toISOString(), to: now.toISOString() },
    currentGenerationVersion: BRIEF_GENERATION_VERSION,
    counts,
    failureReasons,
    generationReasons,
    byDay: [...byDayMap.values()].sort((a, b) => b.day.localeCompare(a.day)),
    economics: {
      correlated: sumPriced(joined),
      surfaceTotal: { invocations: surfaceTotal.invocations, usd: surfaceTotal.usd },
      uncorrelatedGenerations: uncorrelated,
    },
    rows: list,
    limits: {
      reuseCounted: false,
      generationDurationRecorded: false,
      failedAttemptCostRecorded: false,
      note: "A cached or watermark-refreshed read writes nothing, so reuse cannot be counted; generation duration is not persisted; a failed attempt persists no invocation, so its cost is unknown.",
    },
    checkedAt: now.toISOString(),
  };
}
