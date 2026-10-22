/**
 * lib/plaid/webhook-dedupe.ts  (IDEMP-006)
 *
 * Short-TTL duplicate suppression for VERIFIED Plaid webhook deliveries.
 *
 * Plaid's signature check bounds a replay to its 5-minute `iat` window, but
 * inside that window a duplicate delivery (Plaid retry, network replay) of a
 * sync trigger re-ran the whole pipeline: one /transactions/sync, one
 * /accounts/get and a regeneration per copy. The body of a trigger carries no
 * timestamp, so two GENUINE notifications for the same Item can be
 * byte-identical — a permanent dedupe on the body hash would drop real work.
 * Hence a TTL: the same sha256(rawBody) within DEDUPE_WINDOW_MS is a duplicate.
 *
 * The store is the existing RateLimit table (fm_system holds CRUD; swept after
 * 24 h by jobs/sweep-rate-limits.ts): key `plaid-webhook:<sha256>`, one row per
 * 10-minute bucket, claimed with the same atomic upsert the rate limiter uses
 * (@@unique([key, windowStart]) makes the increment race-safe). A delivery is
 * a duplicate when its bucket's count after the increment is > 1, or the
 * previous bucket also saw the body (straddling a boundary). No schema change.
 *
 * Fails OPEN: if the store is unreachable the delivery is treated as new — a
 * duplicate pipeline run is serialised by the Item lease and is idempotent on
 * rows; a dropped real notification is not recoverable until the daily cron.
 */

import { createHash } from "node:crypto";

export const WEBHOOK_DEDUPE_WINDOW_MS = 10 * 60_000;

export interface WebhookDedupeClient {
  rateLimit: {
    upsert(args: {
      where: { key_windowStart: { key: string; windowStart: Date } };
      create: { key: string; windowStart: Date; count: number };
      update: { count: { increment: number } };
      select: { count: true };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { key_windowStart: { key: string; windowStart: Date } }; select: { count: true } }): Promise<{ count: number } | null>;
  };
}

export function webhookBodySha256(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** True when this exact body was already delivered within the window. Never throws. */
export async function isDuplicateWebhookDelivery(
  bodySha256: string,
  now: Date = new Date(),
  client?: WebhookDedupeClient,
): Promise<boolean> {
  try {
    const c = client ?? ((await import("@/lib/db")).systemDb as unknown as WebhookDedupeClient);
    const key = `plaid-webhook:${bodySha256}`;
    const bucket = new Date(Math.floor(now.getTime() / WEBHOOK_DEDUPE_WINDOW_MS) * WEBHOOK_DEDUPE_WINDOW_MS);
    const previous = new Date(bucket.getTime() - WEBHOOK_DEDUPE_WINDOW_MS);
    const row = await c.rateLimit.upsert({
      where:  { key_windowStart: { key, windowStart: bucket } },
      create: { key, windowStart: bucket, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    if (row.count > 1) return true;
    const prior = await c.rateLimit.findUnique({ where: { key_windowStart: { key, windowStart: previous } }, select: { count: true } });
    return (prior?.count ?? 0) > 0;
  } catch (err) {
    console.warn("[plaid webhook] dedupe store unavailable — treating delivery as new (fail-open):", err instanceof Error ? err.message : String(err));
    return false;
  }
}
