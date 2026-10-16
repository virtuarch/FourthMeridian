/**
 * lib/platform/ai/allowance-reservation.test.ts  (AI COST CONTROLS — the bounded in-flight reservation)
 *
 * The transaction takes the per-customer advisory lock, reads the enforcement
 * flag + today's spend + the in-flight count, decides, reserves, and the handle
 * releases (idempotent, never below 0). FIVE concurrent admissions against a
 * fake client that SERIALISES transactions the way the lock does; the fallback
 * when the transaction cannot run. No live database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/allowance-reservation.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { RESERVE_USD } from "@/lib/ai/allowance-core";
import {
  INFLIGHT_BUCKET_MS, allowanceLockKey, enforcedFrom, inflightBucket, inflightKey, reserveAiTurn,
  type ReservationClient, type ReservationTx,
} from "./allowance-reservation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const NOW = new Date("2026-10-15T10:59:30.000Z");
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** A stand-in that serialises $transaction bodies (the advisory lock's effect) and keeps the RateLimit buckets. */
function makeClient(opts: { spentGroups?: { n: number; p: number; o: number }[]; enforced?: string | null; txFails?: boolean; enforcedFails?: boolean } = {}) {
  const buckets = new Map<string, number>();
  const locks: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const bucketKey = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const groups = (opts.spentGroups ?? []).map((g) => ({ provider: "OPENAI", model: "gpt-5.1", _count: { _all: g.n }, _sum: { promptTokens: g.p, cachedPromptTokens: 0, completionTokens: g.o } }));
  const base = {
    aiInvocation: { groupBy: async () => groups },
    platformSetting: { findUnique: async () => { if (opts.enforcedFails) throw new Error("unreadable"); return opts.enforced == null ? null : { value: opts.enforced }; } },
  };
  const tx: ReservationTx = {
    ...base,
    $executeRaw: async (_q: TemplateStringsArray, ...v: unknown[]) => { locks.push(String(v[0])); return 1; },
    rateLimit: {
      findMany: async ({ where }: { where: { key: string; windowStart: { in: Date[] } } }) => where.windowStart.in.map((w: Date) => ({ count: buckets.get(bucketKey(where.key, w)) ?? 0 })).filter((b: { count: number }) => b.count > 0),
      upsert: async ({ where, create }: { where: { key_windowStart: { key: string; windowStart: Date } }; create: { count: number } }) => { const k = bucketKey(where.key_windowStart.key, where.key_windowStart.windowStart); const n = (buckets.get(k) ?? 0) + create.count; buckets.set(k, n); return { count: n }; },
    },
  } as unknown as ReservationTx;
  const client: ReservationClient = {
    ...base,
    $transaction: <T,>(fn: (t: ReservationTx) => Promise<T>): Promise<T> => {
      if (opts.txFails) return Promise.reject(new Error("no transaction"));
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    },
    rateLimit: { updateMany: async ({ where, data }: { where: { key: string; windowStart: Date; count: { gt: number } }; data: { count: { decrement: number } } }) => { const k = bucketKey(where.key, where.windowStart); const n = buckets.get(k) ?? 0; if (n <= where.count.gt) return { count: 0 }; buckets.set(k, n - data.count.decrement); return { count: 1 }; } },
  } as unknown as ReservationClient;
  const inflight = () => [...buckets.values()].reduce((a, b) => a + b, 0);
  return { client, buckets, locks, inflight };
}

async function main() {
  console.log("1. keys and buckets");
  {
    check("the counter key and the lock key are the user's, with no other predicate", inflightKey("u1") === "user:ai-inflight:u1" && allowanceLockKey("u1") === "ai-allowance:u1");
    check("the bucket is the hour", inflightBucket(NOW).toISOString() === "2026-10-15T10:00:00.000Z" && INFLIGHT_BUCKET_MS === 3_600_000);
    check('enforcement: only "false" turns it off — missing, "true", garbage all enforce', !enforcedFrom("false") && enforcedFrom(null) && enforcedFrom("true") && enforcedFrom("maybe"));
  }

  console.log("\n2. one turn: lock taken, reserved, released once");
  {
    const { client, locks, inflight } = makeClient({ spentGroups: [{ n: 1, p: 1_000_000, o: 0 }] }); // $1.25
    const r = await reserveAiTurn("u1", 5, NOW, client);
    check("allowed, RESERVED, 0 in flight before it, spend read through the transaction", r.verdict.allowed && r.verdict.reservation === "RESERVED" && r.verdict.inFlight === 0 && close(r.verdict.spentUsd, 1.25) && r.verdict.enforced);
    check("the advisory lock was taken on the user's key", locks.length === 1 && locks[0] === "ai-allowance:u1");
    check("one reservation is held", inflight() === 1);
    await r.release(); await r.release();
    check("release decrements once (idempotent), never below 0", inflight() === 0);
    await client.rateLimit.updateMany({ where: { key: inflightKey("u1"), windowStart: inflightBucket(NOW), count: { gt: 0 } }, data: { count: { decrement: 1 } } });
    check("a stray extra decrement cannot go negative", inflight() === 0);
  }

  console.log("\n3. five concurrent turns: the lock serialises them and the reserve bounds admission");
  {
    // $3.80 spent of $5; RESERVE_USD ≈ $0.315 ⇒ 3.8 + 4 × 0.315 = 5.06 ≥ 5 refuses the FIFTH.
    const { client, inflight, locks } = makeClient({ spentGroups: [{ n: 1, p: 3_040_000, o: 0 }] }); // 3.04M × 1.25 = $3.80
    const results = await Promise.all(Array.from({ length: 5 }, () => reserveAiTurn("u1", 5, NOW, client)));
    const admitted = results.filter((r) => r.verdict.allowed);
    check(`exactly 4 of 5 admitted (reserve $${RESERVE_USD.toFixed(3)}); the fifth sees 4 in flight`, admitted.length === 4 && results[4].verdict.inFlight === 4 && !results[4].verdict.allowed && results[4].verdict.reason === "ALLOWANCE_EXHAUSTED", results.map((r) => `${r.verdict.allowed}/${r.verdict.inFlight}`).join());
    check("in-flight counts seen in order 0,1,2,3,4 — the decisions were serialised", results.map((r) => r.verdict.inFlight).join() === "0,1,2,3,4");
    check("five locks taken", locks.length === 5 && inflight() === 4);
    await Promise.all(results.map((r) => r.release()));
    check("every admitted turn released; a refused turn's release is a no-op", inflight() === 0);
    const after = await reserveAiTurn("u1", 5, NOW, client);
    check("after the releases a new turn is judged on the ledger alone again (0 in flight)", after.verdict.allowed && after.verdict.inFlight === 0);
  }

  console.log("\n4. the previous hour's bucket counts too (a release lost at the boundary ages out, never under-reserves)");
  {
    const { client, buckets } = makeClient({ spentGroups: [{ n: 1, p: 3_040_000, o: 0 }] });
    const prev = new Date(inflightBucket(NOW).getTime() - INFLIGHT_BUCKET_MS);
    buckets.set(`${inflightKey("u1")}@${prev.toISOString()}`, 4); // four turns admitted at 09:xx and never released
    const r = await reserveAiTurn("u1", 5, NOW, client);
    check("the stale reservations still count ⇒ refused", !r.verdict.allowed && r.verdict.inFlight === 4);
    const later = await reserveAiTurn("u1", 5, new Date(NOW.getTime() + 2 * INFLIGHT_BUCKET_MS), client);
    check("two hours later the bucket is out of the window ⇒ self-healed, admitted", later.verdict.allowed && later.verdict.inFlight === 0);
  }

  console.log("\n5. enforcement off, unpriced, and the fallback");
  {
    const off = await reserveAiTurn("u1", 5, NOW, makeClient({ spentGroups: [{ n: 1, p: 8_000_000, o: 0 }], enforced: "false" }).client); // $10 spent
    check("enforced=false ⇒ allowed over the allowance, verdict says enforced:false, still RESERVED (the counter keeps running)", off.verdict.allowed && off.verdict.enforced === false && off.verdict.reservation === "RESERVED");
    const unreadable = await reserveAiTurn("u1", 5, NOW, makeClient({ spentGroups: [{ n: 1, p: 8_000_000, o: 0 }], enforcedFails: true }).client);
    check("an unreadable enforcement flag ENFORCES (FALLBACK_TO_DEFAULT)", !unreadable.verdict.allowed && unreadable.verdict.enforced);
    const fb = makeClient({ spentGroups: [{ n: 1, p: 1_000_000, o: 0 }], txFails: true });
    const r = await reserveAiTurn("u1", 5, NOW, fb.client);
    check("no transaction ⇒ the plain check decides, reservation UNAVAILABLE, no counter touched", r.verdict.allowed && r.verdict.reservation === "UNAVAILABLE" && r.verdict.inFlight === 0 && fb.inflight() === 0);
    const fbOver = await reserveAiTurn("u1", 1, NOW, fb.client);
    check("…and it still refuses over the allowance", !fbOver.verdict.allowed && fbOver.verdict.reservation === "UNAVAILABLE");
  }

  console.log("\n6. source: fm_system, the lock inside the transaction, no model call inside it");
  {
    const src = strip("lib/platform/ai/allowance-reservation.ts");
    check("fm_system, never the migration principal", /import \{ systemDb \} from "@\/lib\/db"/.test(src) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*"@\/lib\/db"/.test(src));
    check("pg_advisory_xact_lock(hashtext(…)) is the first statement of the transaction", /\$transaction\(async \(tx\) => \{\s*await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(/.test(src));
    // P2010 regression — `pg_advisory_xact_lock` returns void and $queryRaw must deserialize it; a fake cannot see that, so this
    // pin keeps the statement on $executeRaw and scripts/ai-allowance-acceptance.ts proves it against a real fm_system principal.
    check("the void-returning lock never goes through $queryRaw (P2010 'Failed to deserialize column of type void')", !/\$queryRaw`[^`]*pg_advisory/.test(src) && !/\$queryRaw\b/.test(src));
    check("no provider import — the model call is never inside the lock", !/@\/lib\/ai\/provider|openai/.test(src));
    check("the allowance loader (lib/ai) holds no database client and no delegate call (evidence ratchet)", !/@\/lib\/db|\.(rateLimit|platformSetting|aiInvocation)\./.test(strip("lib/ai/allowance.ts")));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
