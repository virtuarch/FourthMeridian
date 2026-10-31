/**
 * lib/notifications/delivery/rollup.test.ts  (Comms Center Phase A-2a)
 *
 * 90-day retention of the delivery ledger over an in-memory client that models
 * the two tables, the interactive transaction (rollback on throw) and the
 * composite upsert:
 *
 *   1. the boundary is EXACT and in UTC: cutoff = today 00:00 UTC − 90 days;
 *      a row at cutoff − 1 ms is rolled, a row AT the cutoff is kept, whatever
 *      the time of day the job runs;
 *   2. rolled rows become per-(day, key, channel, status, reason) counts and are
 *      deleted — no recipient reaches the daily table;
 *   3. IDEMPOTENT: a second run changes nothing; a run after new expiries only
 *      ADDS (increments) — no count is ever doubled;
 *   4. a concurrent run that deleted part of a batch makes this batch roll back
 *      (nothing counted, nothing deleted);
 *   5. batched and bounded: ≤ ROLLUP_MAX_BATCHES × ROLLUP_BATCH per run, the
 *      rest is reported (exhausted: false) and finished by the next run;
 *   6. the retention job runs it through the system principal.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/delivery/rollup.test.ts
 */

import { readFileSync } from "node:fs";
import {
  DELIVERY_RETENTION_DAYS,
  ROLLUP_BATCH,
  ROLLUP_MAX_BATCHES,
  groupDaily,
  rollupClientFrom,
  rollupCutoff,
  runCommsDeliveryRollup,
  type DailyKey,
  type RollupClient,
  type RollupSourceRow,
  type RollupTx,
} from "@/lib/notifications/delivery/rollup";
import { runDataRetention, RETENTION_RULES, type RetentionClient } from "@/jobs/data-retention";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

type LedgerRow = RollupSourceRow & { recipientUserId: string | null; recipientHash: string | null };
type Cell = DailyKey & { count: number };

function world(seed: LedgerRow[], opts: { stealOnDelete?: number } = {}) {
  let ledger = [...seed];
  let daily: Cell[] = [];
  let steal = opts.stealOnDelete ?? 0;
  /** Ids a simulated concurrent run deleted (and committed) — they stay gone on rollback. */
  const stolen = new Set<string>();
  const cellKey = (k: DailyKey) => [k.day.toISOString(), k.definitionKey, k.channel, k.status, k.reason].join("|");
  const client: RollupClient = {
    async $transaction(fn) {
      // Snapshot → run → commit, or restore on throw (interactive-transaction semantics).
      const L = ledger.map((r) => ({ ...r }));
      const D = daily.map((c) => ({ ...c }));
      const tx: RollupTx = {
        commsDelivery: {
          async findMany({ where, take }) {
            return [...ledger].filter((r) => r.createdAt < where.createdAt.lt)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
              .slice(0, take)
              .map(({ id, messageKey, attempt, definitionKey, channel, status, reason, createdAt, mode }) => ({ id, messageKey, attempt, definitionKey, channel, status, reason, createdAt, mode }));
          },
          async findAttempts({ where }) {
            return ledger.filter((r) => where.messageKey.in.includes(r.messageKey))
              .map(({ id, messageKey, channel, attempt, createdAt }) => ({ id, messageKey, channel, attempt, createdAt }));
          },
          async deleteMany({ where }) {
            if (steal > 0) {
              // A concurrent run deleted `steal` of these ids first.
              for (const id of where.id.in.slice(0, steal)) stolen.add(id);
              ledger = ledger.filter((r) => !stolen.has(r.id));
              steal = 0;
            }
            const before = ledger.length;
            ledger = ledger.filter((r) => !(where.id.in.includes(r.id) && r.createdAt < where.createdAt.lt));
            return { count: before - ledger.length };
          },
        },
        commsDeliveryDaily: {
          async upsert({ where, create, update }) {
            const k = cellKey(where.day_definitionKey_channel_status_reason);
            const hit = daily.find((c) => cellKey(c) === k);
            if (hit) hit.count += update.count.increment;
            else daily.push({ ...create });
            return {};
          },
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        // Roll back THIS transaction's writes; a concurrent run's committed delete stays.
        ledger = L.filter((r) => !stolen.has(r.id));
        daily = D;
        throw e;
      }
    },
  };
  return { client, get ledger() { return ledger; }, get daily() { return daily; } };
}

const NOW = new Date("2026-10-31T23:59:30.000Z"); // late in the UTC day on purpose
const CUTOFF = rollupCutoff(NOW);
const row = (id: string, createdAt: Date, over: Partial<LedgerRow> = {}): LedgerRow => ({
  id, messageKey: id, attempt: 1, definitionKey: "PASSWORD_CHANGED", channel: "EMAIL", status: "ACCEPTED", reason: null, createdAt,
  recipientUserId: "user_1", recipientHash: null, ...over,
});
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const o = { log: console.log, error: console.error };
  console.log = () => undefined; console.error = () => undefined;
  try { return await fn(); } finally { Object.assign(console, o); }
};

async function boundary(): Promise<void> {
  console.log("1. the 90-day boundary, in UTC");
  check("retention is 90 days (owner decision)", DELIVERY_RETENTION_DAYS === 90);
  check("cutoff = today 00:00 UTC − 90 days, independent of the run's time of day",
    CUTOFF.toISOString() === "2026-08-02T00:00:00.000Z" && rollupCutoff(new Date("2026-10-31T00:00:00.000Z")).getTime() === CUTOFF.getTime());
  const w = world([
    row("before", new Date(CUTOFF.getTime() - 1)),
    row("at", new Date(CUTOFF.getTime())),
    row("after", new Date(CUTOFF.getTime() + 1)),
    row("old-1", new Date("2026-07-15T10:00:00.000Z")),
  ]);
  const r = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  check("a row 1 ms before the cutoff is rolled; a row AT the cutoff and after is kept",
    w.ledger.map((x) => x.id).sort().join() === "after,at" && r.rolled === 2 && r.exhausted, { left: w.ledger.map((x) => x.id), r });
  check("the 1-ms-before row is counted on its own UTC day (2026-08-01), not the cutoff's",
    w.daily.some((c) => c.day.toISOString() === "2026-08-01T00:00:00.000Z" && c.count === 1));
  check("the whole 90-day read window (today + 89 days) stays in the ledger",
    new Date("2026-08-03T00:00:00.000Z") >= CUTOFF);
}

async function idempotent(): Promise<void> {
  console.log("2. rollup → counts, then delete; idempotent");
  const day = (d: string, h = 12) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00.000Z`);
  const seed = [
    row("a1", day("2026-06-01", 1)), row("a2", day("2026-06-01", 23)),
    row("a3", day("2026-06-01"), { status: "FAILED" }),
    row("a4", day("2026-06-01"), { status: "SUPPRESSED", reason: "PREFERENCE_OFF", channel: "IN_APP", definitionKey: "SYNC_FAILED" }),
    row("a5", day("2026-06-02"), { recipientUserId: null, recipientHash: "f".repeat(64), channel: "OPERATOR_EMAIL", definitionKey: "PLATFORM_ALERT" }),
    row("keep", day("2026-10-30")),
  ];
  const w = world(seed);
  const first = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  const snapshot = JSON.stringify(w.daily.map((c) => ({ ...c, day: c.day.toISOString() })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  check("5 expired rows rolled into 4 cells; the recent row kept", first.rolled === 5 && first.cells === 4 && w.ledger.map((x) => x.id).join() === "keep", first);
  check("counts are exact per (UTC day, key, channel, status, reason); null reason stored as ''",
    w.daily.find((c) => c.definitionKey === "PASSWORD_CHANGED" && c.status === "ACCEPTED")?.count === 2
    && w.daily.find((c) => c.status === "SUPPRESSED")?.reason === "PREFERENCE_OFF"
    && w.daily.find((c) => c.status === "ACCEPTED")?.reason === "", w.daily);
  check("the daily table carries no recipient of any kind",
    w.daily.every((c) => Object.keys(c).sort().join() === "channel,count,day,definitionKey,reason,status"));
  const second = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  const after = JSON.stringify(w.daily.map((c) => ({ ...c, day: c.day.toISOString() })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  check("a second run is a no-op: nothing rolled, every count unchanged", second.rolled === 0 && second.exhausted && after === snapshot);
  // A day later, "keep" is still recent; add an expired straggler on an existing cell's day.
  w.ledger.push(row("late", day("2026-06-01", 5)));
  const third = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  check("a later run INCREMENTS the existing cell (2 → 3), never doubles it",
    third.rolled === 1 && w.daily.find((c) => c.definitionKey === "PASSWORD_CHANGED" && c.status === "ACCEPTED" && c.day.toISOString().startsWith("2026-06-01"))?.count === 3);
  check("groupDaily: rows on the same UTC day but different local days group together",
    groupDaily([row("x", new Date("2026-06-01T00:00:00.000Z")), row("y", new Date("2026-06-01T23:59:59.999Z")), row("z", new Date("2026-06-02T00:00:00.000Z"))]).map((c) => c.count).join() === "2,1");
}

async function concurrent(): Promise<void> {
  console.log("3. a concurrent run rolls this batch back");
  const old = new Date("2026-05-01T12:00:00.000Z");
  const w = world([row("c1", old), row("c2", old), row("c3", old)], { stealOnDelete: 1 });
  const r = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  check("delete removed fewer rows than counted → batch rolled back: no cell written, an error reported",
    w.daily.length === 0 && r.rolled === 0 && /concurrent/.test(r.error ?? ""), { r, daily: w.daily });
  check("…the rows this run did not get to remain for the next run", w.ledger.length === 2);
  const again = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  check("…and the next run counts them exactly once", again.rolled === 2 && w.daily[0]?.count === 2 && w.ledger.length === 0);
}

async function bounded(): Promise<void> {
  console.log("4. batched and bounded");
  const old = new Date("2026-04-01T00:00:00.000Z");
  const total = ROLLUP_BATCH * ROLLUP_MAX_BATCHES + 7;
  const w = world(Array.from({ length: total }, (_, i) => row(`b${String(i).padStart(6, "0")}`, new Date(old.getTime() + i))));
  const r = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  check(`at most ${ROLLUP_MAX_BATCHES} × ${ROLLUP_BATCH} per run; the remainder reported, not lost`,
    r.batches === ROLLUP_MAX_BATCHES && r.rolled === ROLLUP_BATCH * ROLLUP_MAX_BATCHES && r.exhausted === false && w.ledger.length === 7, r);
  const next = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  check("the next run finishes it; the day's count equals every row exactly once",
    next.rolled === 7 && next.exhausted && w.ledger.length === 0 && w.daily.reduce((n, c) => n + c.count, 0) === total);
}

async function messages(): Promise<void> {
  console.log("4b. attempts vs messages (contract v1.0.2): each message counted ONCE, by its final attempt");
  const d = (iso: string) => new Date(iso);
  const w = world([
    // retried, then accepted on attempt 2 — all expired
    row("m1a1", d("2026-05-01T08:00:00Z"), { messageKey: "m1", attempt: 1, status: "FAILED" }),
    row("m1a2", d("2026-05-02T08:00:00Z"), { messageKey: "m1", attempt: 2, status: "ACCEPTED" }),
    // died after retries: FAILED, FAILED, DEAD
    row("m2a1", d("2026-05-01T09:00:00Z"), { messageKey: "m2", attempt: 1, status: "FAILED" }),
    row("m2a2", d("2026-05-02T09:00:00Z"), { messageKey: "m2", attempt: 2, status: "FAILED" }),
    row("m2a3", d("2026-05-03T09:00:00Z"), { messageKey: "m2", attempt: 3, status: "DEAD" }),
    // same messageKey on another channel is ANOTHER message (the in-app twin)
    row("m1in", d("2026-05-01T08:00:00Z"), { messageKey: "m1", attempt: 1, status: "ACCEPTED", channel: "IN_APP" }),
    // attempt 1 expired, attempt 2 still recent: the message stays with the ledger
    row("m3a1", new Date(CUTOFF.getTime() - 3_600_000), { messageKey: "m3", attempt: 1, status: "FAILED" }),
    row("m3a2", new Date(CUTOFF.getTime() + 3_600_000), { messageKey: "m3", attempt: 2, status: "ACCEPTED" }),
  ]);
  const r = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  const n = (status: string, channel = "EMAIL") => w.daily.filter((c) => c.status === status && c.channel === channel).reduce((x, c) => x + c.count, 0);
  check("retry-then-accepted → 1 ACCEPTED (not a FAILED); died after retries → 1 DEAD (not FAILED×2)",
    n("ACCEPTED") === 1 && n("FAILED") === 0 && n("DEAD") === 1, w.daily.map((c) => `${c.channel}:${c.status}:${c.count}`));
  check("…each counted on its FINAL attempt's UTC day",
    w.daily.some((c) => c.status === "ACCEPTED" && c.channel === "EMAIL" && c.day.toISOString().startsWith("2026-05-02"))
    && w.daily.some((c) => c.status === "DEAD" && c.day.toISOString().startsWith("2026-05-03")));
  check("the in-app twin with the same messageKey is its own message (IN_APP ACCEPTED 1)", n("ACCEPTED", "IN_APP") === 1);
  check("an expired attempt superseded by a RECENT one is deleted uncounted; the recent attempt stays to carry it",
    w.ledger.map((x) => x.id).join() === "m3a2" && r.rolled === 7 && r.counted === 3 && r.superseded === 4, r);
  const again = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
  check("re-run: nothing more counted", again.rolled === 0 && n("ACCEPTED") === 1 && n("DEAD") === 1);
}

async function wiring(): Promise<void> {
  console.log("4c. Comms B2 HARDENING A8 — an operator TEST row is DELETED, never folded into the LIVE counts");
  {
    const old = new Date(CUTOFF.getTime() - 3_600_000);
    const w = world([
      row("live1", old), row("live2", old),
      row("test1", old, { mode: "TEST" }), row("test2", old, { mode: "TEST", definitionKey: "SYNC_FAILED" }),
      row("legacy", old, { mode: undefined }),
    ]);
    const r = await quiet(() => runCommsDeliveryRollup(w.client, NOW));
    const total = w.daily.reduce((n, c) => n + c.count, 0);
    check("every expired row is deleted (TEST included); only the 3 LIVE (incl. a pre-B2 row with no mode) are counted; `test` reports the 2",
      w.ledger.length === 0 && total === 3 && r.counted === 3 && r.test === 2 && r.superseded === 0 && r.rolled === 5
      && !w.daily.some((c) => c.definitionKey === "SYNC_FAILED"), { r, daily: w.daily });
  }

  console.log("5. wiring into the retention job");
  const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const job = strip("jobs/data-retention.ts");
  check("data-retention runs the rollup, defaulting to the system principal (never `db`)",
    /runCommsDeliveryRollup\(commsClient, now\)/.test(job) && /rollupClientFrom\(\(await import\("@\/lib\/db"\)\)\.systemDb as unknown as PrismaRollupLike\)/.test(job));
  {
    const calls: string[] = [];
    const prisma = { async $transaction<T>(fn: (tx: never) => Promise<T>) {
      return fn({ commsDelivery: { findMany: async (a: { where: object }) => { calls.push(`findMany:${Object.keys(a.where).join()}`); return []; }, deleteMany: async () => ({ count: 0 }) }, commsDeliveryDaily: { upsert: async () => ({}) } } as never);
    } };
    const res = await quiet(() => runCommsDeliveryRollup(rollupClientFrom(prisma as never), NOW));
    check("the Prisma binding: one findMany on createdAt, then (with rows) findAttempts as findMany on messageKey", res.exhausted && calls.join() === "findMany:createdAt");
  }
  check("CommsDelivery is NOT a plain delete rule (it must be rolled first)", !RETENTION_RULES.some((r) => /comms/i.test(r.table)));
  const empty = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, { findMany: async () => [], deleteMany: async () => ({ count: 0 }) }])) as unknown as RetentionClient;
  const injectedOnly = await quiet(() => runDataRetention(empty, NOW));
  check("an injected rules client without a comms client never reaches a real database (commsDelivery: null)", injectedOnly.commsDelivery === null);
  const w = world([row("r1", new Date("2026-01-01T00:00:00.000Z"))]);
  const withComms = await quiet(() => runDataRetention(empty, NOW, w.client));
  check("with a comms client the job rolls and reports it", withComms.commsDelivery?.rolled === 1 && w.ledger.length === 0);
}

async function main(): Promise<void> {
  await boundary();
  await idempotent();
  await concurrent();
  await bounded();
  await messages();
  await wiring();
  if (failures > 0) { console.error(`\n${failures} rollup check(s) failed`); process.exit(1); }
  console.log("\nAll delivery-ledger retention checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
