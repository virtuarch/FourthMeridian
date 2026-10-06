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
 *
 * Also hosts the decision-store helper tests merged from
 * merchant-merge-decisions.test.ts (MI2 S2): a tiny in-memory fake stands in
 * for the Prisma client (only merchantMergeDecision) and proves pair-key is
 * order-independent and unique; a human DECISION is persisted (upsert);
 * SUGGESTIONS are never persisted (the detector output is filtered by decided
 * pairs, in memory).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { applyMergeReviewDecision, MergeReviewIneligibleError } from "./merchant-merge-review";
import {
  mergePairKey,
  recordMergeDecision,
  loadDecidedPairKeys,
  filterPendingCandidates,
} from "./merchant-merge-decisions";
import type { MergeCandidate } from "./merchant-merge-suggest";

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
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  let inTransaction = false;
  const writesOutsideTx: string[] = [];
  const track = (op: string) => { if (!inTransaction) writesOutsideTx.push(op); };

  const guard = (op: string) => { if (guardMutations) throw new Error(`reject-invariant violated: ${op} was called`); };

  const api = {
    merchant: {
      findUnique: async (args: { where: { id?: string; canonicalKey?: string }; select?: unknown }) => {
        const id = args.where.id ?? (args.where.canonicalKey != null ? byKey.get(args.where.canonicalKey) : undefined);
        const rec = id ? merchants.get(id) : undefined;
        return rec ? { id: rec.id, canonicalKey: rec.canonicalKey, displayName: rec.displayName, plaidEntityId: rec.plaidEntityId } : null;
      },
      findMany: async (args: { where?: { id: { in: string[]; not?: string } } }) => {
        // The detector read (getPendingMergeCandidates): every merchant + counts.
        if (!args.where) {
          return [...merchants.values()].map((m) => ({
            id: m.id, canonicalKey: m.canonicalKey, displayName: m.displayName, plaidEntityId: m.plaidEntityId,
            _count: { aliases: aliasesOn.get(m.id) ?? 0, transactions: txnsOn.get(m.id) ?? 0, rules: 0 },
          }));
        }
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
        guard("merchant.update"); track("merchant.update");
        const m = merchants.get(args.where.id); if (m) m.plaidEntityId = args.data.plaidEntityId; return { id: args.where.id };
      },
      delete: async (args: { where: { id: string } }) => {
        guard("merchant.delete"); track("merchant.delete");
        const m = merchants.get(args.where.id); if (m) byKey.delete(m.canonicalKey); merchants.delete(args.where.id); return { id: args.where.id };
      },
    },
    merchantAlias: {
      findMany: async (args: { where: { merchantId: string } }) =>
        Array.from({ length: aliasesOn.get(args.where.merchantId) ?? 0 }, (_, i) => ({ id: `a${i}`, aliasKey: `alias#${i}`, merchantId: args.where.merchantId, source: "PROVIDER" })),
      updateMany: async (args: { where: { merchantId: string } }) => { guard("merchantAlias.updateMany"); track("merchantAlias.updateMany"); const n = aliasesOn.get(args.where.merchantId) ?? 0; return { count: n }; },
      count: async () => 0,
    },
    transaction: {
      groupBy: async () => [],
      findMany: async (args: { where: { merchantId?: string } }) =>
        Array.from({ length: args.where.merchantId ? (txnsOn.get(args.where.merchantId) ?? 0) : 0 }, (_, i) => ({ id: `t${i}` })),
      updateMany: async (args: { where: { merchantId?: string } }) => { guard("transaction.updateMany"); track("transaction.updateMany"); const n = args.where.merchantId ? (txnsOn.get(args.where.merchantId) ?? 0) : 0; return { count: n }; },
      count: async () => 0,
    },
    merchantRule: {
      findMany: async () => [],
      findFirst: async () => null,
      update: async (a: { where: { id: string } }) => { guard("merchantRule.update"); return { id: a.where.id }; },
      delete: async (a: { where: { id: string } }) => { guard("merchantRule.delete"); return { id: a.where.id }; },
    },
    merchantMergeDecision: {
      upsert: async (args: { where: { pairKey: string }; create: Record<string, unknown> }) => {
        track("merchantMergeDecision.upsert");
        const i = decisions.findIndex((d) => d.pairKey === args.where.pairKey);
        if (i >= 0) decisions[i] = { ...decisions[i], ...args.create }; else decisions.push({ ...args.create });
        return { id: args.where.pairKey };
      },
      findMany: async () => decisions.map((d) => ({ pairKey: d.pairKey })),
    },
    auditLog: {
      create: async (args: { data: { action: string; metadata: Record<string, unknown> } }) => {
        track("auditLog.create");
        audits.push({ action: args.data.action, metadata: args.data.metadata });
        return { id: `al${audits.length}` };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      inTransaction = true;
      try { return await fn(api); } finally { inTransaction = false; }
    },
  };
  return { client: api as unknown as PrismaClient, merchants, decisions, audits, writesOutsideTx };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── merged from lib/transactions/merchant-merge-decisions.test.ts (MI2 S2) ───
// Decision-store helpers: in-memory fake over merchantMergeDecision only.
// ─────────────────────────────────────────────────────────────────────────────

interface DecRec {
  pairKey: string; verdict: string; survivorKey: string; absorbedKey: string;
  evidenceTier: string; evidenceSignal: string | null; decidedByUserId: string | null;
}
function makeDecisionFake() {
  const decisions = new Map<string, DecRec>();
  const client = {
    merchantMergeDecision: {
      upsert: async (args: {
        where: { pairKey: string };
        create: DecRec;
        update: Partial<DecRec>;
      }) => {
        const existing = decisions.get(args.where.pairKey);
        if (existing) { Object.assign(existing, args.update); return { id: args.where.pairKey }; }
        decisions.set(args.where.pairKey, { ...args.create });
        return { id: args.where.pairKey };
      },
      findMany: async (_args: { select: { pairKey: true } }) =>
        [...decisions.values()].map((d) => ({ pairKey: d.pairKey })),
    },
  };
  return { client: client as unknown as Prisma.TransactionClient, decisions };
}

function candidate(survivorKey: string, absorbedKey: string): MergeCandidate {
  return {
    survivorKey, survivorId: `id_${survivorKey}`,
    absorbedKey, absorbedId: `id_${absorbedKey}`,
    tier: "T2", signal: "CANONICAL_CONTAINMENT", explanation: "test",
  };
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

  // ── 4. MERCHANT-OPS AUTHORITY: audit + recovery, eligibility, detector evidence ─
  const WGU = [
    { id: "S", canonicalKey: "WESTERN GOVERNORS UNIVERSITY", displayName: "Western Governors University", plaidEntityId: null },
    { id: "D", canonicalKey: "WESTERN GOVERNORS UN", displayName: "Western Governors Un", plaidEntityId: null },
  ];
  {
    const { client, audits, decisions, writesOutsideTx } = makeFake({ merchants: WGU, aliasesOn: { D: 2 }, txnsOn: { D: 3 } });
    await applyMergeReviewDecision(
      client,
      // The request LIES about the evidence; the detector's tier must be recorded.
      { verdict: "MERGED", survivorKey: "WESTERN GOVERNORS UNIVERSITY", absorbedKey: "WESTERN GOVERNORS UN", evidenceTier: "T9-FORGED", evidenceSignal: "FORGED" },
      "op1",
    );
    const a = audits[0];
    const recovery = (a?.metadata?.recovery ?? []) as Array<{ merchant: { id?: string }; aliases: unknown[]; transactionIds: string[] }>;
    eq("audit: exactly one MERCHANT_MERGE_APPLIED record", audits.length === 1 && a.action === "MERCHANT_MERGE_APPLIED", true);
    eq("audit: carries the full per-duplicate report", JSON.stringify((a.metadata.perDuplicate as Array<{ id: string; transactionsRepointed: number }>).map((d) => [d.id, d.transactionsRepointed])), JSON.stringify([["D", 3]]));
    eq("recovery: snapshot of the merged-away merchant row", recovery[0]?.merchant?.id, "D");
    eq("recovery: its aliases with their ORIGINAL source", (recovery[0]?.aliases as Array<{ source: string }>).map((x) => x.source).join(), "PROVIDER,PROVIDER");
    eq("recovery: the re-pointed transaction ids", recovery[0]?.transactionIds.length, 3);
    eq("evidence: the DETECTOR's tier is recorded, not the request's", decisions[0]?.evidenceTier, "T2");
    eq("audit: evidence in the audit record is the detector's too", (a.metadata.evidence as { tier: string }).tier, "T2");
    eq("atomicity: every write (merge, decision, audit) happened INSIDE the transaction", writesOutsideTx.join(), "");
  }
  {
    const { client, audits, decisions, writesOutsideTx } = makeFake({ merchants: WGU }, /* guardMutations */ true);
    await applyMergeReviewDecision(client, { verdict: "DISMISSED", survivorKey: "WESTERN GOVERNORS UNIVERSITY", absorbedKey: "WESTERN GOVERNORS UN", evidenceTier: "T2" }, "op1");
    eq("dismiss: audited as MERCHANT_MERGE_DISMISSED", audits.length === 1 && audits[0].action === "MERCHANT_MERGE_DISMISSED", true);
    eq("dismiss: decision + audit written inside one transaction", writesOutsideTx.join(), "");
    eq("dismiss: one decision", decisions.length, 1);
  }
  {
    // Two merchants the detector does NOT propose as a pair.
    const { client, merchants, audits, decisions } = makeFake({ merchants: [
      { id: "A", canonicalKey: "STARBUCKS", displayName: "Starbucks", plaidEntityId: null },
      { id: "B", canonicalKey: "HOME DEPOT", displayName: "Home Depot", plaidEntityId: null },
    ] });
    let err: unknown = null;
    try {
      await applyMergeReviewDecision(client, { verdict: "MERGED", survivorKey: "STARBUCKS", absorbedKey: "HOME DEPOT", evidenceTier: "T1" }, "op1");
    } catch (e) { err = e; }
    eq("eligibility: an arbitrary pair is REFUSED", err instanceof MergeReviewIneligibleError, true);
    eq("eligibility: nothing merged, decided or audited", merchants.size === 2 && decisions.length === 0 && audits.length === 0, true);
    let err2: unknown = null;
    try {
      await applyMergeReviewDecision(client, { verdict: "DISMISSED", survivorKey: "STARBUCKS", absorbedKey: "HOME DEPOT", evidenceTier: "T1" }, "op1");
    } catch (e) { err2 = e; }
    eq("eligibility: an arbitrary pair cannot be DISMISSED either", err2 instanceof MergeReviewIneligibleError, true);
  }
  {
    // The operator may flip which side survives: the same unordered pair stays eligible.
    const { client, merchants } = makeFake({ merchants: WGU });
    await applyMergeReviewDecision(client, { verdict: "MERGED", survivorKey: "WESTERN GOVERNORS UN", absorbedKey: "WESTERN GOVERNORS UNIVERSITY", evidenceTier: "T2" }, "op1");
    eq("flip: the operator-chosen survivor survives", merchants.has("D") && !merchants.has("S"), true);
  }
  {
    // A pair already decided is no longer pending, so it cannot be re-decided.
    const { client } = makeFake({ merchants: WGU });
    await applyMergeReviewDecision(client, { verdict: "DISMISSED", survivorKey: "WESTERN GOVERNORS UNIVERSITY", absorbedKey: "WESTERN GOVERNORS UN", evidenceTier: "T2" }, "op1");
    let err: unknown = null;
    try { await applyMergeReviewDecision(client, { verdict: "MERGED", survivorKey: "WESTERN GOVERNORS UNIVERSITY", absorbedKey: "WESTERN GOVERNORS UN", evidenceTier: "T2" }, "op2"); }
    catch (e) { err = e; }
    eq("decided: a dismissed pair cannot later be merged through the review", err instanceof MergeReviewIneligibleError, true);
  }

  // ── merged from merchant-merge-decisions.test.ts (MI2 S2) ───────────────────

  // ── D1. Pair key is order-independent and case-normalized ───────────────────
  {
    eq("pairKey symmetric", mergePairKey("A", "B"), mergePairKey("B", "A"));
    eq("pairKey normalized case", mergePairKey("wgu", "WESTERN"), mergePairKey("WGU", "western"));
    check("pairKey distinct for distinct pairs", mergePairKey("A", "B") !== mergePairKey("A", "C"));
  }

  // ── D2. A human decision is persisted (and is idempotent by pair) ───────────
  {
    const { client, decisions } = makeDecisionFake();
    await recordMergeDecision(client, {
      survivorKey: "WESTERN GOVERNORS UNIVERSITY", absorbedKey: "WESTERN GOVERNORS UN",
      verdict: "DISMISSED", evidenceTier: "T2", evidenceSignal: "CANONICAL_CONTAINMENT", decidedByUserId: "u1",
    });
    eq("decision persisted", decisions.size, 1);
    const only = [...decisions.values()][0];
    eq("verdict stored", only.verdict, "DISMISSED");
    eq("survivorKey stored", only.survivorKey, "WESTERN GOVERNORS UNIVERSITY");
    eq("evidence snapshot stored", only.evidenceTier, "T2");
    eq("actor stored", only.decidedByUserId, "u1");

    // Re-deciding the same pair (opposite direction) upserts, not duplicates.
    await recordMergeDecision(client, {
      survivorKey: "WESTERN GOVERNORS UN", absorbedKey: "WESTERN GOVERNORS UNIVERSITY",
      verdict: "MERGED", evidenceTier: "T2", decidedByUserId: "u2",
    });
    eq("still one row (upsert by pair)", decisions.size, 1);
    eq("verdict updated", [...decisions.values()][0].verdict, "MERGED");
  }

  // ── D3. Suggestions are never persisted — decided pairs are filtered out ────
  {
    const { client } = makeDecisionFake();
    await recordMergeDecision(client, {
      survivorKey: "COSTCO WHOLESALE CORP", absorbedKey: "COSTCO WHOLESALE",
      verdict: "DISMISSED", evidenceTier: "T2", decidedByUserId: "u1",
    });
    const decided = await loadDecidedPairKeys(client);
    const live = [
      candidate("COSTCO WHOLESALE CORP", "COSTCO WHOLESALE"), // dismissed → suppressed
      candidate("WESTERN GOVERNORS UNIVERSITY", "WESTERN GOVERNORS UN"), // still pending
    ];
    const pending = filterPendingCandidates(live, decided);
    eq("dismissed pair suppressed", pending.length, 1);
    eq("pending pair survives", pending[0].survivorKey, "WESTERN GOVERNORS UNIVERSITY");
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
