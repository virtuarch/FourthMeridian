/**
 * lib/transactions/merchant-merge-review.test.ts  (MI2 S2)
 *
 * Unit tests for the review orchestration. Standalone tsx script:
 *
 *     npx tsx lib/transactions/merchant-merge-review.test.ts
 *
 * Exits 0 on pass / 1 on failure. An in-memory fake stands in for the Prisma
 * client. Proves the two invariants that matter most:
 *   • MERGED delegates to the merge ENGINE (the duplicate merchant is deleted)
 *     and records a MERGED decision — no merge logic is re-implemented here.
 *   • DISMISSED records a decision and touches NO merchant record (the reject
 *     invariant): every merchant/alias/rule/transaction MUTATION method throws
 *     if called, so a passing dismiss proves none was.
 */

import type { PrismaClient } from "@prisma/client";
import { applyMergeReviewDecision } from "./merchant-merge-review";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

interface MRec { id: string; canonicalKey: string; displayName: string; plaidEntityId: string | null; }

/**
 * Full fake supporting the engine's operations + canonicalKey lookup + the
 * decision table. `guardMutations` makes every merchant-table MUTATION throw —
 * used to prove the DISMISS path never mutates merchant records.
 */
function makeFake(seed: { merchants: MRec[]; aliasesOn?: Record<string, number>; txnsOn?: Record<string, number> }, guardMutations = false) {
  const merchants = new Map<string, MRec>(seed.merchants.map((m) => [m.id, { ...m }]));
  const byKey = new Map<string, string>(seed.merchants.map((m) => [m.canonicalKey, m.id]));
  const aliasesOn = new Map<string, number>(Object.entries(seed.aliasesOn ?? {}));
  const txnsOn = new Map<string, number>(Object.entries(seed.txnsOn ?? {}));
  const decisions: Record<string, unknown>[] = [];

  const guard = (op: string) => { if (guardMutations) throw new Error(`reject-invariant violated: ${op} was called`); };

  const api = {
    merchant: {
      findUnique: async (args: { where: { id?: string; canonicalKey?: string }; select?: unknown }) => {
        const id = args.where.id ?? (args.where.canonicalKey != null ? byKey.get(args.where.canonicalKey) : undefined);
        const rec = id ? merchants.get(id) : undefined;
        return rec ? { id: rec.id, canonicalKey: rec.canonicalKey, displayName: rec.displayName, plaidEntityId: rec.plaidEntityId } : null;
      },
      findMany: async (args: { where: { id: { in: string[]; not?: string } } }) => {
        const inSet = new Set(args.where.id.in);
        const not = args.where.id.not;
        return [...merchants.values()].filter((m) => inSet.has(m.id) && m.id !== not).map((m) => ({
          id: m.id, canonicalKey: m.canonicalKey, displayName: m.displayName, plaidEntityId: m.plaidEntityId,
          aliases: Array.from({ length: aliasesOn.get(m.id) ?? 0 }, (_, i) => ({ id: `a${i}`, aliasKey: `${m.canonicalKey}#${i}` })),
          rules: [],
          _count: { transactions: txnsOn.get(m.id) ?? 0 },
        }));
      },
      count: async (args: { where: { id: { in: string[] } } }) => {
        const inSet = new Set(args.where.id.in);
        return [...merchants.values()].filter((m) => inSet.has(m.id)).length;
      },
      update: async (args: { where: { id: string }; data: { plaidEntityId: string | null } }) => {
        guard("merchant.update");
        const m = merchants.get(args.where.id); if (m) m.plaidEntityId = args.data.plaidEntityId; return { id: args.where.id };
      },
      delete: async (args: { where: { id: string } }) => {
        guard("merchant.delete");
        const m = merchants.get(args.where.id); if (m) byKey.delete(m.canonicalKey); merchants.delete(args.where.id); return { id: args.where.id };
      },
    },
    merchantAlias: {
      updateMany: async (args: { where: { merchantId: string } }) => { guard("merchantAlias.updateMany"); const n = aliasesOn.get(args.where.merchantId) ?? 0; return { count: n }; },
      count: async () => 0,
    },
    transaction: {
      updateMany: async (args: { where: { merchantId?: string } }) => { guard("transaction.updateMany"); const n = args.where.merchantId ? (txnsOn.get(args.where.merchantId) ?? 0) : 0; return { count: n }; },
      count: async () => 0,
    },
    merchantRule: {
      findFirst: async () => null,
      update: async (a: { where: { id: string } }) => { guard("merchantRule.update"); return { id: a.where.id }; },
      delete: async (a: { where: { id: string } }) => { guard("merchantRule.delete"); return { id: a.where.id }; },
    },
    merchantMergeDecision: {
      upsert: async (args: { where: { pairKey: string }; create: Record<string, unknown> }) => {
        const i = decisions.findIndex((d) => d.pairKey === args.where.pairKey);
        if (i >= 0) decisions[i] = { ...decisions[i], ...args.create }; else decisions.push({ ...args.create });
        return { id: args.where.pairKey };
      },
      findMany: async () => decisions.map((d) => ({ pairKey: d.pairKey })),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(api),
  };
  return { client: api as unknown as PrismaClient, merchants, decisions };
}

async function main() {
  // ── 1. MERGED delegates to the engine (duplicate deleted) + records MERGED ──
  {
    const { client, merchants, decisions } = makeFake({
      merchants: [
        { id: "S", canonicalKey: "WESTERN GOVERNORS UNIVERSITY", displayName: "Western Governors University", plaidEntityId: null },
        { id: "D", canonicalKey: "WESTERN GOVERNORS UN", displayName: "Western Governors Un", plaidEntityId: null },
      ],
      aliasesOn: { D: 1 }, txnsOn: { D: 4 },
    });
    const res = await applyMergeReviewDecision(
      client,
      { verdict: "MERGED", survivorKey: "WESTERN GOVERNORS UNIVERSITY", absorbedKey: "WESTERN GOVERNORS UN", evidenceTier: "T2", evidenceSignal: "CANONICAL_CONTAINMENT" },
      "u1",
    );
    eq("merge: reported merged", res.merged, true);
    eq("merge: engine ran — duplicate deleted", merchants.has("D"), false);
    eq("merge: survivor kept", merchants.has("S"), true);
    eq("merge: one decision recorded", decisions.length, 1);
    eq("merge: decision verdict MERGED", decisions[0].verdict, "MERGED");
    eq("merge: evidence snapshot recorded", decisions[0].evidenceTier, "T2");
  }

  // ── 2. DISMISSED records a decision and touches NO merchant record ──────────
  {
    const { client, merchants, decisions } = makeFake(
      { merchants: [
        { id: "S", canonicalKey: "WESTERN GOVERNORS UNIVERSITY", displayName: "WGU", plaidEntityId: null },
        { id: "D", canonicalKey: "WESTERN GOVERNORS UN", displayName: "WGU trunc", plaidEntityId: null },
      ] },
      /* guardMutations */ true, // any merchant mutation now throws
    );
    const res = await applyMergeReviewDecision(
      client,
      { verdict: "DISMISSED", survivorKey: "WESTERN GOVERNORS UNIVERSITY", absorbedKey: "WESTERN GOVERNORS UN", evidenceTier: "T2" },
      "u1",
    );
    eq("dismiss: not merged", res.merged, false);
    eq("dismiss: both merchants untouched", merchants.size, 2);
    eq("dismiss: one decision recorded", decisions.length, 1);
    eq("dismiss: verdict DISMISSED", decisions[0].verdict, "DISMISSED");
  }

  // ── 3. MERGED with an unresolved key throws, records nothing ────────────────
  {
    const { client, decisions } = makeFake({ merchants: [
      { id: "S", canonicalKey: "REAL MERCHANT", displayName: "Real", plaidEntityId: null },
    ] });
    let threw = false;
    try {
      await applyMergeReviewDecision(
        client,
        { verdict: "MERGED", survivorKey: "REAL MERCHANT", absorbedKey: "GHOST KEY", evidenceTier: "T2" },
        "u1",
      );
    } catch { threw = true; }
    eq("unresolved: threw", threw, true);
    eq("unresolved: no decision recorded", decisions.length, 0);
  }

  if (failures.length === 0) {
    console.log(`merchant-merge-review: all ${passed} checks passed.`);
    process.exit(0);
  } else {
    console.error(`merchant-merge-review: ${failures.length} FAILED (of ${passed + failures.length}):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error("merchant-merge-review test crashed:", e); process.exit(1); });
