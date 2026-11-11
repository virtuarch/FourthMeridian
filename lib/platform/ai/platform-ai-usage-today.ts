/**
 * lib/platform/ai/platform-ai-usage-today.ts  (PLATFORM AI COST MANAGEMENT — today's usage, the READ)
 *
 * One read-only snapshot of today's Platform AI usage against the daily caps, for
 * DISPLAY. The reservation (platform-ai-spend.ts) stays the only authority: it re-reads
 * everything under its locks before each question. This read takes no lock and writes
 * nothing; a figure here can be a few seconds stale, never more permissive than the
 * reservation (the same caps, the same pricing, the same in-flight buckets).
 *
 *   loadPlatformAiUsageToday(model, { operatorIds })
 *     → { fleet, byOperator }   fleet = the PLATFORM_OPS READ projection (no identity);
 *                               byOperator = per-operator views keyed by userId — only
 *                               the SYSTEM_ADMIN caps route returns them (and the
 *                               Cost Controls route returns the viewer's own as `self`).
 *
 * Reads (fm_system; AiInvocation is revoked from fm_app): today's `platform_ai` ledger
 * rows (ids + token counts + outcome, never a prompt or an answer), the in-flight
 * RateLimit buckets, the ledger write-failure signal, the two blanket cap settings and
 * the PlatformAiOperatorCap rows of the operators asked about. No migration.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { todayUTCISO } from "@/lib/time/clock";
import { inflightBucket, INFLIGHT_BUCKET_MS } from "@/lib/platform/ai/allowance-reservation";
import { utcDayStart } from "@/lib/platform/ai/customer-spend-today";
import { consecutiveLedgerWriteFailures, ledgerUntrusted, readLedgerWriteFailures } from "@/lib/platform/ai/ledger-health";
import { PLATFORM_AI_ASK_SURFACE, PLATFORM_AI_DAILY_TURNS } from "@/lib/platform/intelligence/ai/core";
import { PLATFORM_AI_INFLIGHT_PREFIX, platformAiInflightKey } from "@/lib/platform/ai/platform-ai-spend";
import { PLATFORM_AI_CAP_SETTING_KEYS, platformAiReserveUsd, type CapInputs, type PlatformAiCapOutcome } from "@/lib/platform/ai/platform-ai-spend.core";
import { resolveForAdmin, type PlatformAiCapsReadModel } from "@/lib/platform/ai/platform-ai-caps-admin";
import {
  byFeature, byModel, foldPlatformAiUsage, platformAiBudget, platformAiOperatorUsage, type PlatformAiUsageRow,
} from "@/lib/platform/ai/platform-ai-usage-today.core";
import {
  PLATFORM_AI_ESTIMATE_NOTE, type PlatformAiFleetUsageToday, type PlatformAiOperatorUsageView,
} from "@/lib/platform/ai/cost-controls.types";

export interface UsageTodayReadClient {
  aiInvocation: { findMany(args: unknown): Promise<PlatformAiUsageRow[]> };
  rateLimit: { findMany(args: unknown): Promise<Array<{ key?: string; count: number }>> };
  platformSetting: { findMany(args: unknown): Promise<Array<{ key: string; value: string }>> };
  platformAiOperatorCap: { findMany(args: unknown): Promise<Array<{ userId: string; dailyUsd: unknown }>> };
}

const DEFAULT_CLIENT = (): UsageTodayReadClient => systemDb as unknown as UsageTodayReadClient;

export interface UsageTodayDeps {
  client?: UsageTodayReadClient;
  capInputs?: CapInputs;
  now?: Date;
  /** Operators to describe even with no usage today (the caps page's list, or the viewer). */
  operatorIds?: readonly string[];
  /** In-process consecutive ledger failures (default: the live counter the reservation reads). */
  consecutiveFailures?: number;
}

export interface PlatformAiUsageToday {
  /** No operator identity in here: safe for PLATFORM_OPS READ (with `self` filled by the caller). */
  fleet: Omit<PlatformAiFleetUsageToday, "self">;
  /** Per-operator views keyed by userId — SYSTEM_ADMIN surfaces only (or the viewer's own). */
  byOperator: Map<string, PlatformAiOperatorUsageView>;
}

const capOf = (o: PlatformAiCapOutcome) => (o.ok ? { usd: o.usd, refusal: null } : { usd: null, refusal: o.cause });

/** Today's Platform AI usage, priced and judged like the reservation. Throws on a read error (callers degrade to "not available"). */
export async function loadPlatformAiUsageToday(model: string, deps: UsageTodayDeps = {}): Promise<PlatformAiUsageToday> {
  const client = deps.client ?? DEFAULT_CLIENT();
  const capInputs = deps.capInputs ?? env.platformAiSpendCapInputs;
  const now = deps.now ?? new Date();
  const today = todayUTCISO(now);
  const bucket = inflightBucket(now);
  const previous = new Date(bucket.getTime() - INFLIGHT_BUCKET_MS);

  const [rows, buckets, settingRows, ledgerFailures] = await Promise.all([
    client.aiInvocation.findMany({
      where: { surface: PLATFORM_AI_ASK_SURFACE, occurredAt: { gte: utcDayStart(now) } },
      select: { userId: true, provider: true, model: true, subSurface: true, outcome: true, correlationId: true, promptTokens: true, cachedPromptTokens: true, completionTokens: true },
    }),
    client.rateLimit.findMany({ where: { key: { startsWith: PLATFORM_AI_INFLIGHT_PREFIX }, windowStart: { in: [bucket, previous] } }, select: { key: true, count: true } }),
    client.platformSetting.findMany({ where: { key: { in: [PLATFORM_AI_CAP_SETTING_KEYS.perOperator, PLATFORM_AI_CAP_SETTING_KEYS.platform] } }, select: { key: true, value: true } }),
    readLedgerWriteFailures(client as unknown as Parameters<typeof readLedgerWriteFailures>[0], now),
  ]);
  const untrusted = ledgerUntrusted(ledgerFailures, deps.consecutiveFailures ?? consecutiveLedgerWriteFailures());

  let reserveUsd: number | null = null;
  try { reserveUsd = platformAiReserveUsd(model, today); } catch { reserveUsd = null; }

  const inFlightOf = (key?: string) => buckets.filter((b) => key === undefined || b.key === key).reduce((n, b) => n + Math.max(0, b.count), 0);

  // The platform budget (no override applies to it).
  const blanket = resolveForAdmin(capInputs, settingRows, null);
  const platformUsage = foldPlatformAiUsage(rows, today);
  const platformBudget = platformAiBudget({ cap: capOf(blanket.platform), usage: platformUsage, inFlight: inFlightOf(), reserveUsd, ledgerUntrusted: untrusted });

  // Every operator with usage or a running question today, plus the ones asked about.
  const ids = new Set<string>(deps.operatorIds ?? []);
  for (const r of rows) if (r.userId) ids.add(r.userId);
  for (const b of buckets) if (b.key?.startsWith(PLATFORM_AI_INFLIGHT_PREFIX) && Math.max(0, b.count) > 0) ids.add(b.key.slice(PLATFORM_AI_INFLIGHT_PREFIX.length));
  const overrides = ids.size > 0
    ? await client.platformAiOperatorCap.findMany({ where: { userId: { in: [...ids] } }, select: { userId: true, dailyUsd: true } })
    : [];

  const byOperator = new Map<string, PlatformAiOperatorUsageView>();
  const counts = { activeToday: 0, low: 0, exhausted: 0, refusing: 0 };
  for (const id of ids) {
    const mine = rows.filter((r) => r.userId === id);
    const usage = foldPlatformAiUsage(mine, today);
    const overrideRow = overrides.find((o) => o.userId === id) ?? null;
    const own = resolveForAdmin(capInputs, settingRows, overrideRow).operator;
    const budget = platformAiBudget({ cap: capOf(own), usage, inFlight: inFlightOf(platformAiInflightKey(id)), reserveUsd, ledgerUntrusted: untrusted });
    const view = platformAiOperatorUsage({ usage, budget, platform: platformBudget, turnsCap: PLATFORM_AI_DAILY_TURNS });
    byOperator.set(id, view);
    if (mine.length > 0 || budget.inFlight > 0) {
      counts.activeToday++;
      if (view.state === "LOW") counts.low++;
      else if (view.state === "EXHAUSTED") counts.exhausted++;
      else if (view.state === "REFUSING") counts.refusing++;
    }
  }

  return {
    fleet: {
      day: today,
      checkedAt: now.toISOString(),
      model,
      reserveUsd,
      platform: { usage: platformUsage, budget: platformBudget },
      byModel: byModel(rows, today),
      byFeature: byFeature(rows, today),
      operatorCounts: counts,
      estimateNote: PLATFORM_AI_ESTIMATE_NOTE,
    },
    byOperator,
  };
}

/**
 * The SYSTEM_ADMIN caps model with today's usage attached: the fleet figures as
 * `usageToday` and each listed operator's own view as `today`. A read failure leaves
 * both null ("not available"); it never fails the caps page.
 */
export async function withPlatformAiUsageToday(m: PlatformAiCapsReadModel, deps: Omit<UsageTodayDeps, "operatorIds"> = {}): Promise<PlatformAiCapsReadModel> {
  try {
    const u = await loadPlatformAiUsageToday(m.model, { ...deps, operatorIds: m.operators.map((op) => op.userId) });
    return { ...m, usageToday: u.fleet, operators: m.operators.map((op) => ({ ...op, today: u.byOperator.get(op.userId) ?? null })) };
  } catch (e) {
    console.error(`[platform-ai] usage-today read unavailable (${e instanceof Error ? e.name : "unknown"})`);
    return { ...m, usageToday: null, operators: m.operators.map((op) => ({ ...op, today: null })) };
  }
}

/**
 * The PLATFORM_OPS READ projection: the fleet figures plus the VIEWER's own view.
 * Never another operator's figures or identity. A read failure ⇒ null ("not available").
 */
export async function loadPlatformAiFleetUsageToday(model: string, viewerId: string, deps: Omit<UsageTodayDeps, "operatorIds"> = {}): Promise<PlatformAiFleetUsageToday | null> {
  try {
    const u = await loadPlatformAiUsageToday(model, { ...deps, operatorIds: [viewerId] });
    return { ...u.fleet, self: u.byOperator.get(viewerId) ?? null };
  } catch (e) {
    console.error(`[platform-ai] usage-today read unavailable (${e instanceof Error ? e.name : "unknown"})`);
    return null;
  }
}
