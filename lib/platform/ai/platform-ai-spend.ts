/**
 * lib/platform/ai/platform-ai-spend.ts  (Platform AI P2b — the daily $ caps: read + reservation; design v2 §10, I-10)
 *
 * THE ONE PLACE A PLATFORM AI TURN'S DOLLARS ARE JUDGED. The house reservation
 * primitive (lib/platform/ai/allowance-reservation.ts; the Comms authoring
 * allowance is the same shape) applied to `surface = platform_ai`, in ONE short
 * fm_system transaction:
 *
 *   1. pg_advisory_xact_lock(hashtext('platform-ai-spend:<operatorId>')), then
 *      pg_advisory_xact_lock(hashtext('platform-ai-spend:fleet')) — always in that
 *      order (no deadlock). The fleet lock serialises EVERY Platform AI admission,
 *      so the platform in-flight count read below includes every turn admitted
 *      before this one (Platform AI volume is small: ≤ PLATFORM_AI_DAILY_TURNS per
 *      operator per day). The model call is NEVER inside the transaction;
 *   2. reads today's RETURNED platform_ai ledger rows (ONE read; the operator's are
 *      a subset by userId), the in-flight buckets (RateLimit
 *      `user:platform-ai-inflight:<id>`, current + previous HOUR bucket —
 *      self-healing, no migration) and the AI ledger's write-failure signal
 *      (ledger-health.ts — a ledger failing its writes cannot vouch for `spent`);
 *   3. applies the pure rule (platform-ai-spend.core.ts platformAiSpendDecision);
 *   4. when admitted, INCREMENTS the operator's in-flight bucket and hands back a
 *      release the caller runs in `finally` (decrement, never below 0) — the
 *      SETTLEMENT: the turn's real cost is in the ledger rows its calls wrote, and
 *      the reserve stops counting.
 *
 * FAIL CLOSED, every path: caps INVALID or MISSING outside preview/development,
 * an unpriced model or row, a ledger that has been failing its writes, the
 * transaction / lock / counter erroring ⇒ a refusal, never an admission.
 * No `ai_daily_allowance_enforced` bypass: that switch is the CUSTOMER allowance's.
 *
 * Codes only in logs (cause / scope enums) — never an id, a figure or text.
 * fm_system: AiInvocation is revoked from fm_app; RateLimit carries no tenant data.
 * NO SCHEMA CHANGE: AiInvocation and RateLimit are used exactly as the customer
 * allowance and the Comms authoring allowance use them.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { todayUTCISO } from "@/lib/time/clock";
import { inflightBucket, INFLIGHT_BUCKET_MS } from "@/lib/platform/ai/allowance-reservation";
import { utcDayStart } from "@/lib/platform/ai/customer-spend-today";
import { consecutiveLedgerWriteFailures, ledgerUntrusted, readLedgerWriteFailures } from "@/lib/platform/ai/ledger-health";
import { PLATFORM_AI_ASK_SURFACE } from "@/lib/platform/intelligence/ai/core";
import type { TodaySpendGroup } from "@/lib/ai/allowance-core";
import {
  envOnlyCapsInput, platformAiReserveUsd, platformAiSpendDecision, resolvePlatformAiCaps, toResolvedCaps,
  type CapInputs, type PlatformAiSpendVerdict,
} from "@/lib/platform/ai/platform-ai-spend.core";

export const PLATFORM_AI_INFLIGHT_PREFIX = "user:platform-ai-inflight:";
export const platformAiInflightKey = (operatorId: string) => `${PLATFORM_AI_INFLIGHT_PREFIX}${operatorId}`;
export const platformAiSpendLockKey = (operatorId: string) => `platform-ai-spend:${operatorId}`;
export const PLATFORM_AI_SPEND_FLEET_LOCK_KEY = "platform-ai-spend:fleet";

interface LedgerRow { userId: string | null; provider: string; model: string; promptTokens: number; cachedPromptTokens: number; completionTokens: number }

export interface SpendReadClient {
  aiInvocation: { findMany(args: unknown): Promise<LedgerRow[]> };
  rateLimit: { findMany(args: unknown): Promise<Array<{ key?: string; count: number }>> };
}
export interface SpendTxClient extends SpendReadClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  rateLimit: SpendReadClient["rateLimit"] & { upsert(args: unknown): Promise<unknown> };
}
export interface SpendClient {
  $transaction<T>(fn: (tx: SpendTxClient) => Promise<T>): Promise<T>;
  rateLimit: { updateMany(args: unknown): Promise<{ count: number }> };
}

const DEFAULT_CLIENT = (): SpendClient => systemDb as unknown as SpendClient;

export interface SpendReservation {
  verdict: PlatformAiSpendVerdict;
  /** Give the reservation back. Idempotent; never throws; a no-op when nothing was reserved. */
  release(): Promise<void>;
}

export interface ReserveOptions {
  client?: SpendClient;
  /** The caps' raw inputs (default: lib/env.ts). */
  caps?: CapInputs;
  /** The model the turn will run on — the route passes platformAiModel().model, the runner's own. */
  model: string;
}

const NO_RELEASE = async () => {};

function groupsOf(rows: readonly LedgerRow[]): TodaySpendGroup[] {
  const by = new Map<string, TodaySpendGroup>();
  for (const r of rows) {
    const k = `${r.provider}\u0000${r.model}`;
    const g = by.get(k) ?? { provider: r.provider, model: r.model, invocations: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
    g.invocations++; g.promptTokens += r.promptTokens ?? 0; g.cachedPromptTokens += r.cachedPromptTokens ?? 0; g.completionTokens += r.completionTokens ?? 0;
    by.set(k, g);
  }
  return [...by.values()];
}

const logRefusal = (v: PlatformAiSpendVerdict) => {
  if (v.allowed) return;
  if (v.detail === "COST_CAP") console.warn(`[platform-ai] cost cap reached: scope=${v.scope}; refusing before any provider request`);
  else console.error(`[platform-ai] cost cap check unavailable: cause=${v.cause}; refusing (fail closed)`);
};

/**
 * Judge one operator's next Platform AI turn against both daily $ caps under the
 * locks and, when admitted, reserve it. Never throws: any failure is a refusal.
 */
export async function reservePlatformAiSpend(operatorId: string, now: Date, opts: ReserveOptions): Promise<SpendReservation> {
  // D5 PR1: the one caps resolver, env only (override + settings null), so the result is as before.
  const caps = toResolvedCaps(resolvePlatformAiCaps(envOnlyCapsInput(opts.caps ?? env.platformAiSpendCapInputs)));
  if (caps.state === "REFUSE") {
    const verdict: PlatformAiSpendVerdict = { allowed: false, detail: "UNAVAILABLE", cause: caps.cause };
    logRefusal(verdict);
    return { verdict, release: NO_RELEASE };
  }
  const today = todayUTCISO(now);
  let reserveUsd: number | null = null;
  try { reserveUsd = platformAiReserveUsd(opts.model, today); } catch { reserveUsd = null; }

  const client = opts.client ?? DEFAULT_CLIENT();
  const key = platformAiInflightKey(operatorId);
  const bucket = inflightBucket(now);
  const previous = new Date(bucket.getTime() - INFLIGHT_BUCKET_MS);
  try {
    const verdict = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${platformAiSpendLockKey(operatorId)}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PLATFORM_AI_SPEND_FLEET_LOCK_KEY}))`;
      const [rows, buckets, ledgerFailures] = await Promise.all([
        tx.aiInvocation.findMany({
          where: { surface: PLATFORM_AI_ASK_SURFACE, outcome: "RETURNED", occurredAt: { gte: utcDayStart(now) } },
          select: { userId: true, provider: true, model: true, promptTokens: true, cachedPromptTokens: true, completionTokens: true },
        }),
        tx.rateLimit.findMany({ where: { key: { startsWith: PLATFORM_AI_INFLIGHT_PREFIX }, windowStart: { in: [bucket, previous] } }, select: { key: true, count: true } }),
        readLedgerWriteFailures(tx as unknown as Parameters<typeof readLedgerWriteFailures>[0], now),
      ]);
      if (ledgerUntrusted(ledgerFailures, consecutiveLedgerWriteFailures())) {
        return { allowed: false, detail: "UNAVAILABLE", cause: "LEDGER_UNTRUSTED" } satisfies PlatformAiSpendVerdict;
      }
      const v = platformAiSpendDecision({
        caps, todayISO: today, reserveUsd,
        operatorGroups: groupsOf(rows.filter((r) => r.userId === operatorId)),
        platformGroups: groupsOf(rows),
        operatorInFlight: buckets.filter((b) => b.key === key).reduce((n, b) => n + Math.max(0, b.count), 0),
        platformInFlight: buckets.reduce((n, b) => n + Math.max(0, b.count), 0),
      });
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
    if (!verdict.allowed) { logRefusal(verdict); return { verdict, release: NO_RELEASE }; }
    let released = false;
    return {
      verdict,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.rateLimit.updateMany({ where: { key, windowStart: bucket, count: { gt: 0 } }, data: { count: { decrement: 1 } } });
        } catch (e) {
          // A lost release over-reserves for at most two hours (the bucket ages out); it never under-reserves.
          console.error(`[platform-ai] cost reservation release failed (self-heals within the bucket window): ${e instanceof Error ? e.name : "unknown"}`);
        }
      },
    };
  } catch (e) {
    const verdict: PlatformAiSpendVerdict = { allowed: false, detail: "UNAVAILABLE", cause: "RESERVATION_UNAVAILABLE" };
    console.error(`[platform-ai] cost reservation unavailable (${e instanceof Error ? e.name : "unknown"}); refusing (fail closed)`);
    return { verdict, release: NO_RELEASE };
  }
}
