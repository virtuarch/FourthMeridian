/**
 * jobs/product-event-retention.test.ts  (BETA A6)
 *
 * The retention job deletes product events older than 13 months and nothing
 * else, in bounded batches, idempotently, with a counts-only summary. Proven
 * against an in-memory AuditLog fake and by source.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/product-event-retention.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AuditAction, PRODUCT_EVENT_ACTIONS } from "@/lib/audit-actions";
import {
  PRODUCT_EVENT_RETENTION_BATCH, PRODUCT_EVENT_RETENTION_MAX_BATCHES, PRODUCT_EVENT_RETENTION_MONTHS,
  retainProductEvents, retentionCutoff, type ProductEventRetentionClient,
} from "./product-event-retention";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface Row { id: string; action: string; createdAt: Date; userId: string | null; metadata: unknown }

/** An AuditLog that honours exactly the two predicates the job may state. */
function fakeLog(initial: Row[]) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const calls: { op: "findMany" | "deleteMany"; where: unknown; take?: number }[] = [];
  const client: ProductEventRetentionClient = {
    auditLog: {
      async findMany(args) {
        calls.push({ op: "findMany", where: args.where, take: args.take });
        return [...rows.values()]
          .filter((r) => args.where.action.in.includes(r.action) && r.createdAt < args.where.createdAt.lt)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take)
          .map((r) => ({ id: r.id }));
      },
      async deleteMany(args) {
        calls.push({ op: "deleteMany", where: args.where });
        let count = 0;
        for (const id of args.where.id.in) {
          const r = rows.get(id);
          if (r && args.where.action.in.includes(r.action) && r.createdAt < args.where.createdAt.lt) { rows.delete(id); count++; }
        }
        return { count };
      },
    },
  };
  return { client, rows, calls };
}

const NOW = new Date("2026-10-15T07:30:00.000Z");
const CUTOFF = retentionCutoff(NOW);
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

async function main() {
  console.log("0. the cutoff");
  check("13 calendar months before now, UTC", PRODUCT_EVENT_RETENTION_MONTHS === 13 && CUTOFF.toISOString() === "2025-09-15T07:30:00.000Z");
  check("month overflow rolls forward rather than throwing", retentionCutoff(new Date("2026-03-31T00:00:00Z"), 1).toISOString() === "2026-03-03T00:00:00.000Z");

  console.log("1. deletes product events older than the cutoff and NOTHING else");
  {
    const seed: Row[] = [
      { id: "old-sad", action: AuditAction.SESSION_ACTIVE_DAY, createdAt: ms(CUTOFF, -1), userId: "u1", metadata: { day: "2025-09-15" } },
      { id: "old-sv", action: AuditAction.SPACE_VIEWED, createdAt: ms(CUTOFF, -86_400_000), userId: "u1", metadata: {} },
      { id: "old-bv", action: AuditAction.BRIEF_VIEWED, createdAt: ms(CUTOFF, -2), userId: null, metadata: {} },
      { id: "old-tv", action: AuditAction.TRANSACTIONS_VIEWED, createdAt: ms(CUTOFF, -3), userId: "u2", metadata: {} },
      { id: "old-mv", action: AuditAction.MANUAL_ASSET_VALUE_UPDATED, createdAt: ms(CUTOFF, -4), userId: "u2", metadata: {} },
      { id: "at-cutoff", action: AuditAction.SPACE_VIEWED, createdAt: new Date(CUTOFF), userId: "u1", metadata: {} },
      { id: "new-sv", action: AuditAction.SPACE_VIEWED, createdAt: ms(CUTOFF, +1), userId: "u1", metadata: {} },
      // never touched, however old
      { id: "old-login", action: AuditAction.LOGIN, createdAt: ms(CUTOFF, -1e9), userId: "u1", metadata: {} },
      { id: "old-register", action: AuditAction.REGISTER, createdAt: ms(CUTOFF, -1e9), userId: "u1", metadata: {} },
      { id: "old-account-add", action: AuditAction.ACCOUNT_ADD, createdAt: ms(CUTOFF, -1e9), userId: "u1", metadata: {} },
      { id: "old-wallet-add", action: AuditAction.WALLET_ADD, createdAt: ms(CUTOFF, -1e9), userId: "u1", metadata: {} },
      { id: "old-manual-add", action: AuditAction.MANUAL_ASSET_ADD, createdAt: ms(CUTOFF, -1e9), userId: "u1", metadata: {} },
      { id: "old-operator", action: AuditAction.OPERATOR_REFRESH_ALL, createdAt: ms(CUTOFF, -1e9), userId: "u1", metadata: {} },
      { id: "old-grant", action: AuditAction.PLATFORM_GRANT_CREATED, createdAt: ms(CUTOFF, -1e9), userId: "u1", metadata: {} },
      { id: "old-transition", action: AuditAction.PLAID_ITEM_STATUS_CHANGED, createdAt: ms(CUTOFF, -1e9), userId: null, metadata: {} },
    ];
    const { client, rows, calls } = fakeLog(seed);
    const r = await retainProductEvents(client, NOW);
    check("five old product events deleted; the row AT the cutoff and the newer one survive (strict <)", r.deleted === 5 && rows.has("at-cutoff") && rows.has("new-sv"), JSON.stringify(r));
    check("every non-product action survives, however old",
      ["old-login", "old-register", "old-account-add", "old-wallet-add", "old-manual-add", "old-operator", "old-grant", "old-transition"].every((id) => rows.has(id)));
    check("a null-user product row (deleted account) is still retention-eligible", !rows.has("old-bv"));
    check("every statement names the action list AND the cutoff", calls.every((c) => {
      const w = c.where as { action: { in: string[] }; createdAt: { lt: Date } };
      return w.action.in.join() === PRODUCT_EVENT_ACTIONS.join() && w.createdAt.lt.getTime() === CUTOFF.getTime();
    }));
    check("summary is counts + ISO cutoff only", Object.keys(r).sort().join() === "batches,cutoff,deleted,exhausted" && r.cutoff === CUTOFF.toISOString() && r.exhausted === true);
    const again = await retainProductEvents(client, NOW);
    check("idempotent: an immediate re-run deletes zero", again.deleted === 0 && again.exhausted && rows.size === 10);
  }

  console.log("2. bounded batches");
  {
    const many: Row[] = [];
    const total = PRODUCT_EVENT_RETENTION_BATCH * PRODUCT_EVENT_RETENTION_MAX_BATCHES + 7;
    for (let i = 0; i < total; i++) many.push({ id: `r${i}`, action: AuditAction.SESSION_ACTIVE_DAY, createdAt: ms(CUTOFF, -1 - i), userId: "u", metadata: {} });
    const { client, rows, calls } = fakeLog(many);
    const r = await retainProductEvents(client, NOW);
    check(`at most ${PRODUCT_EVENT_RETENTION_MAX_BATCHES} batches of ${PRODUCT_EVENT_RETENTION_BATCH} per run; the rest waits (exhausted=false)`,
      r.deleted === PRODUCT_EVENT_RETENTION_BATCH * PRODUCT_EVENT_RETENTION_MAX_BATCHES && r.batches === PRODUCT_EVENT_RETENTION_MAX_BATCHES && r.exhausted === false && rows.size === 7, JSON.stringify(r));
    check("each select is bounded by take and oldest-first", calls.filter((c) => c.op === "findMany").every((c) => c.take === PRODUCT_EVENT_RETENTION_BATCH));
    const r2 = await retainProductEvents(client, NOW);
    check("the next run finishes the tail in one short batch", r2.deleted === 7 && r2.batches === 1 && r2.exhausted && rows.size === 0);
    const r3 = await retainProductEvents(client, NOW);
    check("an empty table is one probe and done", r3.deleted === 0 && r3.batches === 1 && r3.exhausted);
  }

  console.log("3. by source");
  {
    const root = process.cwd();
    const strip = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const job = strip("jobs/product-event-retention.ts");
    check("the action list is PRODUCT_EVENT_ACTIONS imported from the canon — never hand-typed", /import \{ PRODUCT_EVENT_ACTIONS \} from "@\/lib\/audit-actions"/.test(job)
      && !/"(SESSION_ACTIVE_DAY|SPACE_VIEWED|BRIEF_VIEWED|TRANSACTIONS_VIEWED|MANUAL_ASSET_VALUE_UPDATED)"/.test(job));
    check("no unbounded delete: every deleteMany is keyed by ids AND action AND cutoff", (job.match(/c\.auditLog\.deleteMany\(/g) ?? []).length === 1 && /id: \{ in: rows\.map\(\(r\) => r\.id\) \}, action: \{ in: actions \}, createdAt: \{ lt: cutoff \}/.test(job));
    check("the database client is a lazy fm_system import (loading the module touches no database)", /await import\("@\/lib\/db"\)\)\.systemDb/.test(job) && !/^import .*from "@\/lib\/db"/m.test(job));
    check("the registry still binds the job body under its frozen name", /"product-event-retention": async \(\) => \(await import\("@\/jobs\/product-event-retention"\)\)\.retainProductEvents\(\)/.test(strip("lib/jobs/registry.ts")));
  }

  if (failures > 0) { console.error(`\nproduct-event-retention.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nproduct-event-retention.test: all passed.");
}

void main();
