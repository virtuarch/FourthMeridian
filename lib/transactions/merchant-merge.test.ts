/**
 * lib/transactions/merchant-merge.test.ts  (MI2 S1)
 *
 * Unit tests for the merge engine (lib/transactions/merchant-merge.ts).
 * Standalone tsx script (house pattern):
 *
 *     npx tsx lib/transactions/merchant-merge.test.ts
 *
 * Exits 0 on pass / 1 on failure. Deterministic and Prisma-free: a tiny
 * in-memory fake stands in for the Prisma client (cast to the client type), so
 * the whole merge surface is exercised without a database. The fake's
 * `$transaction` snapshots state and restores it on throw, so atomic rollback is
 * a real, observable property of the test — not a mock assertion.
 *
 * Proves the MI2 S1 checklist: alias migration, transaction migration, rule
 * move, rule fold (with categoryRule provenance re-point), plaidEntityId
 * transfer-if-empty, dry-run performs no writes, idempotency, rollback on
 * failure, and the survivor/duplicate guards.
 */

import type { PrismaClient } from "@prisma/client";
import { mergeMerchants } from "./merchant-merge";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
async function throwsWith(name: string, fn: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn();
    failures.push(`✗ ${name} — expected throw, got none`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, msg.includes(needle), `got "${msg}", want substring "${needle}"`);
  }
}

// ── In-memory fake Prisma client ──────────────────────────────────────────────
interface MRec { id: string; canonicalKey: string; displayName: string; plaidEntityId: string | null; }
interface ARec { id: string; aliasKey: string; merchantId: string; source: string; }
interface RRec { id: string; merchantId: string; scope: string; ownerUserId: string | null; category: string; }
interface TRec { id: string; merchantId: string | null; categoryRuleId: string | null; }

interface Seed {
  merchants: MRec[];
  aliases?: ARec[];
  rules?: RRec[];
  txns?: TRec[];
  failDeleteMerchantId?: string;
}

function makeFake(seed: Seed) {
  const merchants = new Map<string, MRec>(seed.merchants.map((m) => [m.id, { ...m }]));
  const aliases: ARec[] = (seed.aliases ?? []).map((a) => ({ ...a }));
  const rules: RRec[] = (seed.rules ?? []).map((r) => ({ ...r }));
  const txns: TRec[] = (seed.txns ?? []).map((t) => ({ ...t }));
  const failDeleteMerchantId = seed.failDeleteMerchantId ?? null;

  const snapshot = () =>
    JSON.stringify({ merchants: [...merchants.entries()], aliases, rules, txns });
  const restore = (s: string) => {
    const o = JSON.parse(s) as { merchants: [string, MRec][]; aliases: ARec[]; rules: RRec[]; txns: TRec[] };
    merchants.clear();
    for (const [k, v] of o.merchants) merchants.set(k, v);
    aliases.length = 0; aliases.push(...o.aliases);
    rules.length = 0; rules.push(...o.rules);
    txns.length = 0; txns.push(...o.txns);
  };

  const api = {
    merchant: {
      findUnique: async (args: { where: { id?: string; canonicalKey?: string } }) => {
        const { id, canonicalKey } = args.where;
        if (id != null) return merchants.get(id) ?? null;
        if (canonicalKey != null) return [...merchants.values()].find((m) => m.canonicalKey === canonicalKey) ?? null;
        return null;
      },
      findMany: async (args: { where: { id: { in: string[]; not?: string } } }) => {
        const inSet = new Set(args.where.id.in);
        const not = args.where.id.not;
        return [...merchants.values()]
          .filter((m) => inSet.has(m.id) && m.id !== not)
          .map((m) => ({
            id: m.id,
            canonicalKey: m.canonicalKey,
            displayName: m.displayName,
            plaidEntityId: m.plaidEntityId,
            aliases: aliases.filter((a) => a.merchantId === m.id).map((a) => ({ id: a.id, aliasKey: a.aliasKey })),
            rules: rules
              .filter((r) => r.merchantId === m.id)
              .map((r) => ({ id: r.id, scope: r.scope, ownerUserId: r.ownerUserId, category: r.category })),
            _count: { transactions: txns.filter((t) => t.merchantId === m.id).length },
          }));
      },
      count: async (args: { where: { id: { in: string[] } } }) => {
        const inSet = new Set(args.where.id.in);
        return [...merchants.values()].filter((m) => inSet.has(m.id)).length;
      },
      update: async (args: { where: { id: string }; data: { plaidEntityId: string | null } }) => {
        const m = merchants.get(args.where.id);
        if (m) m.plaidEntityId = args.data.plaidEntityId;
        return { id: args.where.id };
      },
      delete: async (args: { where: { id: string } }) => {
        if (failDeleteMerchantId && args.where.id === failDeleteMerchantId) {
          throw new Error(`injected failure deleting merchant ${args.where.id}`);
        }
        merchants.delete(args.where.id);
        return { id: args.where.id };
      },
    },
    merchantAlias: {
      updateMany: async (args: { where: { merchantId: string }; data: { merchantId: string; source: string } }) => {
        let count = 0;
        for (const a of aliases) {
          if (a.merchantId === args.where.merchantId) {
            a.merchantId = args.data.merchantId;
            a.source = args.data.source;
            count++;
          }
        }
        return { count };
      },
      count: async (args: { where: { merchantId: string } }) =>
        aliases.filter((a) => a.merchantId === args.where.merchantId).length,
    },
    transaction: {
      updateMany: async (args: {
        where: { merchantId?: string; categoryRuleId?: string };
        data: { merchantId?: string; categoryRuleId?: string };
      }) => {
        let count = 0;
        for (const t of txns) {
          if (args.where.merchantId !== undefined && t.merchantId === args.where.merchantId) {
            if (args.data.merchantId !== undefined) t.merchantId = args.data.merchantId;
            count++;
          } else if (args.where.categoryRuleId !== undefined && t.categoryRuleId === args.where.categoryRuleId) {
            if (args.data.categoryRuleId !== undefined) t.categoryRuleId = args.data.categoryRuleId;
            count++;
          }
        }
        return { count };
      },
      count: async (args: { where: { merchantId: { in: string[] } } }) => {
        const inSet = new Set(args.where.merchantId.in);
        return txns.filter((t) => t.merchantId != null && inSet.has(t.merchantId)).length;
      },
    },
    merchantRule: {
      findFirst: async (args: { where: { merchantId: string; scope: string; ownerUserId: string | null } }) => {
        const r = rules.find(
          (x) => x.merchantId === args.where.merchantId && x.scope === args.where.scope && x.ownerUserId === args.where.ownerUserId,
        );
        return r ? { id: r.id } : null;
      },
      update: async (args: { where: { id: string }; data: { merchantId: string } }) => {
        const r = rules.find((x) => x.id === args.where.id);
        if (r) r.merchantId = args.data.merchantId;
        return { id: args.where.id };
      },
      delete: async (args: { where: { id: string } }) => {
        const i = rules.findIndex((x) => x.id === args.where.id);
        if (i >= 0) rules.splice(i, 1);
        return { id: args.where.id };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snap = snapshot();
      try {
        return await fn(api);
      } catch (e) {
        restore(snap); // atomic rollback
        throw e;
      }
    },
  };

  return { client: api as unknown as PrismaClient, merchants, aliases, rules, txns };
}

const SURVIVOR: MRec = { id: "S", canonicalKey: "WESTERN GOVERNORS UNIVERSITY", displayName: "Western Governors University", plaidEntityId: null };

async function main() {
  // ── 1 & 2. Alias + transaction migration (apply) ────────────────────────────
  {
    const { client, merchants, aliases, txns } = makeFake({
      merchants: [SURVIVOR, { id: "D", canonicalKey: "WESTERN GOVERNORS UN", displayName: "Western Governors Un", plaidEntityId: null }],
      aliases: [{ id: "a1", aliasKey: "WESTERN GOVERNORS UN", merchantId: "D", source: "PLAID" }, { id: "a2", aliasKey: "WGU X", merchantId: "D", source: "IMPORT" }],
      txns: [{ id: "t1", merchantId: "D", categoryRuleId: null }, { id: "t2", merchantId: "D", categoryRuleId: null }, { id: "t3", merchantId: "D", categoryRuleId: null }],
    });
    const r = await mergeMerchants(client, { survivorId: "S", duplicateIds: ["D"], dryRun: false });
    eq("apply: applied true", r.applied, true);
    eq("apply: aliasesRepointed", r.perDuplicate[0].aliasesRepointed, 2);
    eq("apply: transactionsRepointed", r.perDuplicate[0].transactionsRepointed, 3);
    eq("apply: dup deleted flag", r.perDuplicate[0].deleted, true);
    eq("apply: dup merchant gone", merchants.has("D"), false);
    eq("apply: all aliases now on survivor", aliases.every((a) => a.merchantId === "S"), true);
    eq("apply: all aliases stamped USER", aliases.every((a) => a.source === "USER"), true);
    eq("apply: all txns now on survivor", txns.every((t) => t.merchantId === "S"), true);
    eq("apply: verification remaining 0", r.verification.duplicateMerchantsRemaining, 0);
    eq("apply: verification onOldIds 0", r.verification.transactionsOnOldIds, 0);
    eq("apply: survivor alias count", r.verification.survivorAliasCount, 2);
  }

  // ── 3. Rule move (no conflicting survivor rule) ─────────────────────────────
  {
    const { client, rules } = makeFake({
      merchants: [SURVIVOR, { id: "D", canonicalKey: "WGU", displayName: "WGU", plaidEntityId: null }],
      rules: [{ id: "rD", merchantId: "D", scope: "USER", ownerUserId: "u1", category: "Payment" }],
    });
    const r = await mergeMerchants(client, { survivorId: "S", duplicateIds: ["D"], dryRun: false });
    eq("move: rulesMoved 1", r.perDuplicate[0].rulesMoved, 1);
    eq("move: rulesFolded 0", r.perDuplicate[0].rulesFolded, 0);
    eq("move: rule now on survivor", rules.find((x) => x.id === "rD")?.merchantId, "S");
    eq("move: rule still exists", rules.length, 1);
  }

  // ── 4. Rule fold (survivor already has a rule for same scope/owner) ─────────
  {
    const { client, rules, txns } = makeFake({
      merchants: [SURVIVOR, { id: "D", canonicalKey: "WGU", displayName: "WGU", plaidEntityId: null }],
      rules: [
        { id: "rS", merchantId: "S", scope: "USER", ownerUserId: "u1", category: "Payment" },
        { id: "rD", merchantId: "D", scope: "USER", ownerUserId: "u1", category: "Payment" },
      ],
      txns: [{ id: "t1", merchantId: "D", categoryRuleId: "rD" }],
    });
    const r = await mergeMerchants(client, { survivorId: "S", duplicateIds: ["D"], dryRun: false });
    eq("fold: rulesFolded 1", r.perDuplicate[0].rulesFolded, 1);
    eq("fold: rulesMoved 0", r.perDuplicate[0].rulesMoved, 0);
    eq("fold: dup rule deleted", rules.some((x) => x.id === "rD"), false);
    eq("fold: survivor rule kept", rules.some((x) => x.id === "rS"), true);
    eq("fold: provenance re-pointed to survivor rule", txns.find((t) => t.id === "t1")?.categoryRuleId, "rS");
  }

  // ── 5. plaidEntityId transfer-if-empty (+ drop when survivor already has one) ─
  {
    const { client, merchants } = makeFake({
      merchants: [
        { ...SURVIVOR, plaidEntityId: null },
        { id: "D1", canonicalKey: "WGU A", displayName: "WGU A", plaidEntityId: "ent_wgu" },
        { id: "D2", canonicalKey: "WGU B", displayName: "WGU B", plaidEntityId: "ent_other" },
      ],
    });
    const r = await mergeMerchants(client, { survivorId: "S", duplicateIds: ["D1", "D2"], dryRun: false });
    const d1 = r.perDuplicate.find((d) => d.id === "D1")!;
    const d2 = r.perDuplicate.find((d) => d.id === "D2")!;
    eq("entity: D1 transferred", d1.plaidEntityTransferred, true);
    eq("entity: survivor got entity id", merchants.get("S")?.plaidEntityId, "ent_wgu");
    eq("entity: D2 dropped (survivor already has one)", d2.plaidEntityDropped, "ent_other");
    eq("entity: D2 not transferred", d2.plaidEntityTransferred, false);
  }

  // ── 6. Dry-run performs NO writes ───────────────────────────────────────────
  {
    const { client, merchants, aliases, txns } = makeFake({
      merchants: [SURVIVOR, { id: "D", canonicalKey: "WGU", displayName: "WGU", plaidEntityId: null }],
      aliases: [{ id: "a1", aliasKey: "WGU", merchantId: "D", source: "PLAID" }],
      txns: [{ id: "t1", merchantId: "D", categoryRuleId: null }],
    });
    const r = await mergeMerchants(client, { survivorId: "S", duplicateIds: ["D"] }); // dryRun defaults true
    eq("dry: applied false", r.applied, false);
    eq("dry: projected aliasesRepointed", r.perDuplicate[0].aliasesRepointed, 1);
    eq("dry: projected transactionsRepointed", r.perDuplicate[0].transactionsRepointed, 1);
    eq("dry: dup NOT deleted", r.perDuplicate[0].deleted, false);
    eq("dry: dup still present", merchants.has("D"), true);
    eq("dry: alias untouched", aliases[0].merchantId, "D");
    eq("dry: alias source untouched", aliases[0].source, "PLAID");
    eq("dry: txn untouched", txns[0].merchantId, "D");
  }

  // ── 7. Idempotency: a second apply finds nothing to do ──────────────────────
  {
    const { client, merchants } = makeFake({
      merchants: [SURVIVOR, { id: "D", canonicalKey: "WGU", displayName: "WGU", plaidEntityId: null }],
      aliases: [{ id: "a1", aliasKey: "WGU", merchantId: "D", source: "PLAID" }],
    });
    await mergeMerchants(client, { survivorId: "S", duplicateIds: ["D"], dryRun: false });
    const second = await mergeMerchants(client, { survivorId: "S", duplicateIds: ["D"], dryRun: false });
    eq("idempotent: second applied false (nothing to do)", second.applied, false);
    eq("idempotent: no perDuplicate", second.perDuplicate.length, 0);
    eq("idempotent: verification remaining 0", second.verification.duplicateMerchantsRemaining, 0);
    eq("idempotent: only survivor remains", merchants.size, 1);
  }

  // ── 8. Rollback on failure: partial merge is fully undone, engine re-throws ──
  {
    const { client, merchants, aliases, txns } = makeFake({
      merchants: [
        SURVIVOR,
        { id: "D1", canonicalKey: "WGU A", displayName: "WGU A", plaidEntityId: null },
        { id: "D2", canonicalKey: "WGU B", displayName: "WGU B", plaidEntityId: null },
      ],
      aliases: [{ id: "a1", aliasKey: "WGU A", merchantId: "D1", source: "PLAID" }],
      txns: [{ id: "t1", merchantId: "D1", categoryRuleId: null }],
      failDeleteMerchantId: "D2", // fail while processing the SECOND duplicate
    });
    await throwsWith(
      "rollback: engine re-throws",
      () => mergeMerchants(client, { survivorId: "S", duplicateIds: ["D1", "D2"], dryRun: false }),
      "injected failure",
    );
    // First duplicate's changes must be rolled back — full original state restored.
    eq("rollback: D1 still present", merchants.has("D1"), true);
    eq("rollback: D2 still present", merchants.has("D2"), true);
    eq("rollback: alias back on D1", aliases[0].merchantId, "D1");
    eq("rollback: alias source restored", aliases[0].source, "PLAID");
    eq("rollback: txn back on D1", txns[0].merchantId, "D1");
  }

  // ── 9. Survivor guard ───────────────────────────────────────────────────────
  {
    const { client } = makeFake({ merchants: [{ id: "D", canonicalKey: "WGU", displayName: "WGU", plaidEntityId: null }] });
    await throwsWith(
      "guard: survivor not found",
      () => mergeMerchants(client, { survivorId: "MISSING", duplicateIds: ["D"], dryRun: false }),
      "survivor merchant not found",
    );
  }

  // ── 10. Duplicate guards ────────────────────────────────────────────────────
  {
    const { client } = makeFake({ merchants: [SURVIVOR] });
    await throwsWith(
      "guard: empty duplicateIds",
      () => mergeMerchants(client, { survivorId: "S", duplicateIds: [], dryRun: false }),
      "no duplicate ids supplied",
    );
    await throwsWith(
      "guard: duplicate equals survivor",
      () => mergeMerchants(client, { survivorId: "S", duplicateIds: ["S"], dryRun: false }),
      "a duplicate id equals the survivor id",
    );
  }

  // ── 11. Missing duplicate row is noted, not fatal ───────────────────────────
  {
    const { client } = makeFake({ merchants: [SURVIVOR] });
    const r = await mergeMerchants(client, { survivorId: "S", duplicateIds: ["GHOST"], dryRun: false });
    eq("missing: applied false", r.applied, false);
    check("missing: note recorded", r.notes.some((n) => n.includes("GHOST")));
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  if (failures.length === 0) {
    console.log(`merchant-merge: all ${passed} checks passed.`);
    process.exit(0);
  } else {
    console.error(`merchant-merge: ${failures.length} FAILED (of ${passed + failures.length}):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error("merchant-merge test crashed:", e); process.exit(1); });
