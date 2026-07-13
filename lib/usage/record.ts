/**
 * lib/usage/record.ts  (Wave 2 S7)
 *
 * `recordApiUsage` — the single entry point for incrementing durable daily
 * API-usage counters (ApiUsageCounter). Every provider hook (OpenAI in
 * lib/ai/provider.ts, the Plaid client proxy in lib/plaid/client.ts) calls this
 * and nothing else.
 *
 * FIRE-AND-FORGET + NON-THROWING: a metrics-write failure must NEVER fail a
 * sync or a chat call. This function swallows every error internally (logs a
 * warning) and resolves, so callers can `void recordApiUsage(...)` without a
 * try/catch and without risking an unhandled rejection. It is the same
 * best-effort posture as the email seam and touchWalletConnectionStatus.
 *
 * The write is an atomic upsert-increment on the @@unique([provider, metric,
 * unit, day]) constraint — the exact race-safe idiom proven in
 * lib/rate-limit.ts (create at n, else increment by n), so concurrent
 * serverless invocations never lose a count.
 */

import { db } from "@/lib/db";

/** Start of the current UTC day (00:00:00.000Z) — the counter's day bucket. */
function utcDayBucket(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Increment today's counter for (provider, metric, unit) by `n` (default 1).
 * Never throws; never rejects. A non-positive `n` is a no-op (nothing to count).
 *
 * @param provider  "PLAID" | "OPENAI" (free string — extensible vocabulary).
 * @param metric    Plaid: the method name; OpenAI: "chat.completions:<model>".
 * @param unit      "calls" | "prompt_tokens" | "completion_tokens".
 * @param n         Amount to add (calls: 1; tokens: the token count).
 */
export async function recordApiUsage(
  provider: string,
  metric: string,
  unit: string,
  n = 1,
): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return;
  const inc = BigInt(Math.floor(n));
  try {
    const day = utcDayBucket();
    await db.apiUsageCounter.upsert({
      where:  { provider_metric_unit_day: { provider, metric, unit, day } },
      create: { provider, metric, unit, day, count: inc },
      update: { count: { increment: inc } },
      select: { id: true },
    });
  } catch (e) {
    console.warn(`[usage] recordApiUsage(${provider}, ${metric}, ${unit}) failed (non-fatal):`, e);
  }
}
