/**
 * lib/transactions/merchant-merge-decisions.test.ts  (MI2 S2)
 *
 * Unit tests for the decision store helpers. Standalone tsx script:
 *
 *     npx tsx lib/transactions/merchant-merge-decisions.test.ts
 *
 * Exits 0 on pass / 1 on failure. A tiny in-memory fake stands in for the Prisma
 * client (only merchantMergeDecision). Proves: pair-key is order-independent and
 * unique; a human DECISION is persisted (upsert); SUGGESTIONS are never persisted
 * (the detector output is filtered by decided pairs, in memory).
 */

import type { Prisma } from "@prisma/client";
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

interface DecRec {
  pairKey: string; verdict: string; survivorKey: string; absorbedKey: string;
  evidenceTier: string; evidenceSignal: string | null; decidedByUserId: string | null;
}
function makeFake() {
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
  // ── 1. Pair key is order-independent and case-normalized ────────────────────
  {
    eq("pairKey symmetric", mergePairKey("A", "B"), mergePairKey("B", "A"));
    eq("pairKey normalized case", mergePairKey("wgu", "WESTERN"), mergePairKey("WGU", "western"));
    check("pairKey distinct for distinct pairs", mergePairKey("A", "B") !== mergePairKey("A", "C"));
  }

  // ── 2. A human decision is persisted (and is idempotent by pair) ────────────
  {
    const { client, decisions } = makeFake();
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

  // ── 3. Suggestions are never persisted — decided pairs are filtered out ─────
  {
    const { client } = makeFake();
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
    console.log(`merchant-merge-decisions: all ${passed} checks passed.`);
    process.exit(0);
  } else {
    console.error(`merchant-merge-decisions: ${failures.length} FAILED (of ${passed + failures.length}):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error("merchant-merge-decisions test crashed:", e); process.exit(1); });
