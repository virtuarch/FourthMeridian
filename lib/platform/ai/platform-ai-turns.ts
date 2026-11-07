/**
 * lib/platform/ai/platform-ai-turns.ts  (Platform AI v0 — the per-operator DAILY TURN CAP read)
 *
 * The customer allowance counts only the customer surfaces (chat, brief); the
 * fleet ceiling (fleet-ceiling.core.ts) is customer-surface spend too. An
 * operator is not a customer, so Platform AI has its OWN bound, ALWAYS enforced
 * (independent of `ai_daily_allowance_enforced` and of RATE_LIMIT_ENABLED):
 *
 *   PLATFORM_AI_DAILY_TURNS per operator per UTC day
 *
 * MEASURED FROM THE EXISTING AI LEDGER — no new table, no new row. Every model
 * call of a Platform AI turn runs inside an invocation context with surface
 * `platform_ai`, the operator's userId and the turn's random id as
 * `correlationId` (lib/platform/intelligence/ai/ledger.ts), so a TURN is one
 * distinct correlationId among today's rows of that operator, of ANY outcome
 * (a paused or failed call still counts against the cap).
 *
 * FAILS CLOSED: an unreadable ledger is a refusal ("UNAVAILABLE"), never an
 * admission. Concurrency: the count is read before the turn and the rows are
 * written during it, so N simultaneous requests from ONE operator can each pass
 * at cap − 1 — the overshoot is bounded by that operator's concurrent requests
 * (the UI sends one at a time; the #352 limiter bounds the rate). Stated, not
 * hidden.
 *
 * Read-only, fm_system (AiInvocation is revoked from fm_app). Reads ids only —
 * never a prompt or an answer (the ledger holds neither).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { utcDayStart } from "@/lib/platform/ai/customer-spend-today";
import { PLATFORM_AI_ASK_SURFACE, PLATFORM_AI_DAILY_TURNS } from "@/lib/platform/intelligence/ai/core";

export type PlatformAiTurnVerdict =
  | { allowed: true; used: number; remaining: number }
  | { allowed: false; detail: "DAILY_TURNS" | "UNAVAILABLE"; used: number | null; remaining: 0 };

/** PURE — the decision over one count. */
export function judgePlatformAiTurns(used: number, cap: number = PLATFORM_AI_DAILY_TURNS): PlatformAiTurnVerdict {
  if (!Number.isFinite(used) || used < 0) return { allowed: false, detail: "UNAVAILABLE", used: null, remaining: 0 };
  if (used >= cap) return { allowed: false, detail: "DAILY_TURNS", used, remaining: 0 };
  return { allowed: true, used, remaining: cap - used };
}

export interface PlatformAiTurnsReadClient {
  aiInvocation: { findMany(args: unknown): Promise<Array<{ correlationId: string | null }>> };
}

const DEFAULT_CLIENT = (): PlatformAiTurnsReadClient => systemDb as unknown as PlatformAiTurnsReadClient;

/** Today's Platform AI turns for one operator, judged against the cap. Never throws. */
export async function readPlatformAiTurns(operatorId: string, now: Date = new Date(), client: PlatformAiTurnsReadClient = DEFAULT_CLIENT()): Promise<PlatformAiTurnVerdict> {
  try {
    const rows = await client.aiInvocation.findMany({
      where: { surface: PLATFORM_AI_ASK_SURFACE, userId: operatorId, occurredAt: { gte: utcDayStart(now) } },
      select: { correlationId: true },
    });
    const turns = new Set(rows.map((r) => r.correlationId ?? "(ungrouped)"));
    return judgePlatformAiTurns(turns.size);
  } catch (e) {
    console.error(`[platform-ai] daily turn count unreadable; refusing (fail closed): ${e instanceof Error ? e.name : "unknown"}`);
    return { allowed: false, detail: "UNAVAILABLE", used: null, remaining: 0 };
  }
}
