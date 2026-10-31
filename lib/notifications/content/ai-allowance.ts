/**
 * lib/notifications/content/ai-allowance.ts  (Comms Center B1 — the AUTHORING allowance, contract v1.1 §4.6)
 *
 * The customer allowance counts only the customer surfaces (chat, brief). An
 * operator is not a customer, so AI-assisted authoring has its OWN cap, ALWAYS
 * enforced (independent of `ai_daily_allowance_enforced`):
 *
 *   per operator  COMMS_AUTHORING_DAILY_USD   = $2.00 per UTC day
 *                 COMMS_AUTHORING_DAILY_CALLS = 40 calls per UTC day (the backstop when spend is unpriced)
 *   fleet         COMMS_AUTHORING_FLEET_DAILY_USD = $10.00 per UTC day, all operators
 *
 * MEASURED FROM THE EXISTING AI LEDGER: every authoring call goes through the one
 * provider chokepoint inside an invocation context with surface
 * "comms_authoring", so AiInvocation already holds its cost and outcome (and
 * never its content). Calls = today's rows of any outcome; spend = today's
 * RETURNED rows priced by the rate card (allowance-core sumTodaySpend).
 *
 * THE RESERVATION is the house primitive of lib/platform/ai/allowance-reservation.ts
 * applied to this surface: one short fm_system transaction under
 * pg_advisory_xact_lock(hashtext('ai-allowance:comms_authoring:' || operatorId))
 * reads the ledger AND the in-flight count (a RateLimit hour bucket, self-healing),
 * decides, and reserves; the handler releases in `finally`. A read that fails is
 * a REFUSAL (fail closed). The FLEET cap counts every operator's in-flight
 * reservations too; the lock is per operator, so two operators admitted at the
 * same instant can each see the other's call unreserved — the fleet overshoot is
 * bounded by one reserve-sized call per concurrently admitted operator (and by
 * the cs-comms-ai bucket, 10 calls per 10 min each). `readAuthoringAllowance` is the same judgement with no
 * lock and no reservation — the advisory `ai` block on GET /versions (D4).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { todayUTCISO } from "@/lib/time/clock";
import { sumTodaySpend } from "@/lib/ai/allowance-core";
import { inflightBucket, INFLIGHT_BUCKET_MS } from "@/lib/platform/ai/allowance-reservation";
import { utcDayStart } from "@/lib/platform/ai/customer-spend-today";

export const COMMS_AUTHORING_SURFACE = "comms_authoring";
export const COMMS_AUTHORING_DAILY_USD = 2.0;
export const COMMS_AUTHORING_DAILY_CALLS = 40;
export const COMMS_AUTHORING_FLEET_DAILY_USD = 10.0;
/** What one in-flight authoring call is reserved at (one small structured call). */
export const COMMS_AUTHORING_RESERVE_USD = 0.05;

export const authoringLockKey = (operatorId: string) => `ai-allowance:${COMMS_AUTHORING_SURFACE}:${operatorId}`;
const INFLIGHT_PREFIX = "user:comms-ai-inflight:";
export const authoringInflightKey = (operatorId: string) => `${INFLIGHT_PREFIX}${operatorId}`;

export interface AuthoringUsage {
  calls: number;
  spentUsd: number;
  unpriced: number;
  fleetUsd: number;
  fleetUnpriced: number;
  inFlight: number;
  /** In-flight authoring calls of EVERY operator (the fleet cap reserves across operators). */
  fleetInFlight?: number;
}

export type AuthoringVerdict =
  | { allowed: true; remainingCalls: number; remainingUsd: number | null }
  | { allowed: false; detail: "CALLS" | "USD" | "FLEET_USD" | "UNAVAILABLE"; remainingCalls: number; remainingUsd: number | null };

/** PURE — the decision over one usage read. */
export function judgeAuthoring(u: AuthoringUsage): AuthoringVerdict {
  const reserved = u.inFlight * COMMS_AUTHORING_RESERVE_USD;
  const fleetReserved = Math.max(u.inFlight, u.fleetInFlight ?? 0) * COMMS_AUTHORING_RESERVE_USD;
  const remainingCalls = Math.max(0, COMMS_AUTHORING_DAILY_CALLS - u.calls - u.inFlight);
  const remainingUsd = u.unpriced > 0 || u.fleetUnpriced > 0 ? null
    : Math.max(0, Math.min(COMMS_AUTHORING_DAILY_USD - u.spentUsd - reserved, COMMS_AUTHORING_FLEET_DAILY_USD - u.fleetUsd - fleetReserved));
  const round = (n: number | null) => (n === null ? null : Math.round(n * 10_000) / 10_000);
  if (u.calls + u.inFlight >= COMMS_AUTHORING_DAILY_CALLS) return { allowed: false, detail: "CALLS", remainingCalls, remainingUsd: round(remainingUsd) };
  if (u.spentUsd + reserved >= COMMS_AUTHORING_DAILY_USD) return { allowed: false, detail: "USD", remainingCalls, remainingUsd: round(remainingUsd) };
  if (u.fleetUsd + fleetReserved >= COMMS_AUTHORING_FLEET_DAILY_USD) return { allowed: false, detail: "FLEET_USD", remainingCalls, remainingUsd: round(remainingUsd) };
  return { allowed: true, remainingCalls, remainingUsd: round(remainingUsd) };
}

/** Seconds to the next UTC midnight (the allowance's Retry-After). */
export function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

interface InvocationRow { userId: string | null; provider: string; model: string; outcome: string; promptTokens: number; cachedPromptTokens: number; completionTokens: number }

export interface AllowanceReadClient {
  aiInvocation: { findMany(args: unknown): Promise<InvocationRow[]> };
  rateLimit: { findMany(args: unknown): Promise<Array<{ key: string; count: number }>> };
}
export interface AllowanceTxClient extends AllowanceReadClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  rateLimit: AllowanceReadClient["rateLimit"] & { upsert(args: unknown): Promise<unknown> };
}
export interface AllowanceClient extends AllowanceReadClient {
  $transaction<T>(fn: (tx: AllowanceTxClient) => Promise<T>): Promise<T>;
  rateLimit: AllowanceReadClient["rateLimit"] & { updateMany(args: unknown): Promise<{ count: number }> };
}

const DEFAULT_CLIENT = (): AllowanceClient => systemDb as unknown as AllowanceClient;

function groups(rows: readonly InvocationRow[]) {
  const by = new Map<string, { provider: string; model: string; invocations: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number }>();
  for (const r of rows) {
    const k = `${r.provider}\u0000${r.model}`;
    const g = by.get(k) ?? { provider: r.provider, model: r.model, invocations: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
    g.invocations++; g.promptTokens += r.promptTokens; g.cachedPromptTokens += r.cachedPromptTokens; g.completionTokens += r.completionTokens;
    by.set(k, g);
  }
  return [...by.values()];
}

async function readUsage(client: AllowanceReadClient, operatorId: string, now: Date): Promise<AuthoringUsage> {
  const bucket = inflightBucket(now);
  const previous = new Date(bucket.getTime() - INFLIGHT_BUCKET_MS);
  const [rows, buckets] = await Promise.all([
    client.aiInvocation.findMany({
      where: { surface: COMMS_AUTHORING_SURFACE, occurredAt: { gte: utcDayStart(now) } },
      select: { userId: true, provider: true, model: true, outcome: true, promptTokens: true, cachedPromptTokens: true, completionTokens: true },
    }),
    client.rateLimit.findMany({ where: { key: { startsWith: INFLIGHT_PREFIX }, windowStart: { in: [bucket, previous] } }, select: { key: true, count: true } }),
  ]);
  const today = todayUTCISO(now);
  const mine = rows.filter((r) => r.userId === operatorId);
  const own = sumTodaySpend(groups(mine.filter((r) => r.outcome === "RETURNED")), today);
  const fleet = sumTodaySpend(groups(rows.filter((r) => r.outcome === "RETURNED")), today);
  return {
    calls: mine.length,
    spentUsd: own.spentUsd, unpriced: own.unpricedInvocations,
    fleetUsd: fleet.spentUsd, fleetUnpriced: fleet.unpricedInvocations,
    inFlight: buckets.filter((b) => b.key === authoringInflightKey(operatorId)).reduce((n, b) => n + Math.max(0, b.count), 0),
    fleetInFlight: buckets.reduce((n, b) => n + Math.max(0, b.count), 0),
  };
}

/** The advisory read (no lock, no reservation). Never throws: a failed read is a refusal. */
export async function readAuthoringAllowance(operatorId: string, now: Date = new Date(), client: AllowanceReadClient = DEFAULT_CLIENT()): Promise<AuthoringVerdict> {
  try {
    return judgeAuthoring(await readUsage(client, operatorId, now));
  } catch (e) {
    console.error(`[comms-ai] authoring allowance unreadable; refusing (fail closed): ${e instanceof Error ? e.name : "unknown"}`);
    return { allowed: false, detail: "UNAVAILABLE", remainingCalls: 0, remainingUsd: null };
  }
}

export interface AuthoringReservation { verdict: AuthoringVerdict; release(): Promise<void> }
const NO_RELEASE = async () => {};

/** Judge and, when admitted, reserve one authoring call under the operator's lock. Never throws. */
export async function reserveAuthoringCall(operatorId: string, now: Date = new Date(), client: AllowanceClient = DEFAULT_CLIENT()): Promise<AuthoringReservation> {
  const key = authoringInflightKey(operatorId);
  const bucket = inflightBucket(now);
  try {
    const verdict = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${authoringLockKey(operatorId)}))`;
      const v = judgeAuthoring(await readUsage(tx, operatorId, now));
      if (v.allowed) {
        await tx.rateLimit.upsert({
          where: { key_windowStart: { key, windowStart: bucket } },
          create: { key, windowStart: bucket, count: 1 },
          update: { count: { increment: 1 } },
          select: { count: true },
        });
      }
      return v;
    });
    if (!verdict.allowed) return { verdict, release: NO_RELEASE };
    let released = false;
    return {
      verdict,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.rateLimit.updateMany({ where: { key, windowStart: bucket, count: { gt: 0 } }, data: { count: { decrement: 1 } } });
        } catch (e) {
          console.error(`[comms-ai] reservation release failed (self-heals within the bucket window): ${e instanceof Error ? e.name : "unknown"}`);
        }
      },
    };
  } catch (e) {
    console.error(`[comms-ai] authoring reservation unavailable; refusing (fail closed): ${e instanceof Error ? e.name : "unknown"}`);
    return { verdict: { allowed: false, detail: "UNAVAILABLE", remainingCalls: 0, remainingUsd: null }, release: NO_RELEASE };
  }
}
