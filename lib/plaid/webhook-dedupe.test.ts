/**
 * lib/plaid/webhook-dedupe.test.ts  (IDEMP-006)
 *
 * The short-TTL store over a fake that implements the RateLimit upsert's
 * (key, windowStart) uniqueness. Standalone tsx:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/webhook-dedupe.test.ts
 */

import { isDuplicateWebhookDelivery, webhookBodySha256, WEBHOOK_DEDUPE_WINDOW_MS, type WebhookDedupeClient } from "@/lib/plaid/webhook-dedupe";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function fake() {
  const rows = new Map<string, number>();
  const k = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const client: WebhookDedupeClient = {
    rateLimit: {
      async upsert({ where }) {
        await new Promise((r) => setImmediate(r));
        const id = k(where.key_windowStart.key, where.key_windowStart.windowStart);
        const n = (rows.get(id) ?? 0) + 1; rows.set(id, n); return { count: n };
      },
      async findUnique({ where }) {
        const n = rows.get(k(where.key_windowStart.key, where.key_windowStart.windowStart));
        return n === undefined ? null : { count: n };
      },
    },
  };
  return { client, rows };
}

async function main() {
  const T = new Date("2026-10-22T10:03:00Z");
  const sha = webhookBodySha256('{"webhook_type":"TRANSACTIONS"}');
  check("sha256 hex of the raw body", /^[0-9a-f]{64}$/.test(sha) && sha !== webhookBodySha256('{"webhook_type":"TRANSACTIONS" }'));
  {
    const f = fake();
    const [a, b] = await Promise.all([isDuplicateWebhookDelivery(sha, T, f.client), isDuplicateWebhookDelivery(sha, T, f.client)]);
    check("two concurrent identical deliveries ⇒ exactly one is new", [a, b].filter((x) => !x).length === 1);
  }
  {
    const f = fake();
    await isDuplicateWebhookDelivery(sha, T, f.client);
    const nextBucket = new Date(Math.ceil(T.getTime() / WEBHOOK_DEDUPE_WINDOW_MS) * WEBHOOK_DEDUPE_WINDOW_MS + 1_000);
    check("a copy just across the bucket boundary is still a duplicate", await isDuplicateWebhookDelivery(sha, nextBucket, f.client));
    check("the same body two windows later is NEW (genuine repeat notification)",
      !(await isDuplicateWebhookDelivery(sha, new Date(T.getTime() + 3 * WEBHOOK_DEDUPE_WINDOW_MS), f.client)));
  }
  {
    const broken = { rateLimit: { upsert: async () => { throw new Error("db down"); }, findUnique: async () => null } } as unknown as WebhookDedupeClient;
    const w = console.warn; console.warn = () => {};
    check("store unavailable ⇒ fail-open (treated as new)", (await isDuplicateWebhookDelivery(sha, T, broken)) === false);
    console.warn = w;
  }
  if (failures > 0) { console.error(`\n❌ webhook dedupe: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ webhook dedupe: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
