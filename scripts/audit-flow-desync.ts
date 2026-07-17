/**
 * scripts/audit-flow-desync.ts
 *
 * FlowType/Category desync audit — permanent VALIDATION COMMAND. READ-ONLY.
 *
 * Proves the standing corpus invariant:
 *   "Every classifier-OWNED row's persisted flow facts equal what the CURRENT
 *    canonical classifier computes from that row's stored inputs."
 *
 * ── Why this was rewritten (CCPAY-2F) ────────────────────────────────────────
 * The original audit encoded three hand-coded shortcuts — Transfer⇒TRANSFER,
 * Payment⇒DEBT_PAYMENT, Fee⇒FEE — as if category alone determined flowType. Two
 * shipped changes disproved that:
 *   • CF-4 (v2): a liability TRANSFER_OUT_ACCOUNT_TRANSFER is SPENDING, so
 *     category=Transfer + flowType=SPENDING is CORRECT, yet the old audit flagged
 *     27 such rows as desynced.
 *   • CCPAY-2B (v3): a liability OUTFLOW carrying category=Payment is SPENDING,
 *     not DEBT_PAYMENT — the same context dependence, now on Payment.
 * A category→flowType lookup cannot express context-dependent semantics. So this
 * audit no longer duplicates classifier logic in SQL: it RECOMPUTES each row
 * through the real canonical authorities and compares the persisted derived
 * fields. There is exactly one source of truth (classifyFlow), and the audit is
 * a consumer of it — the single-authority principle
 * (docs/doctrine/financial-semantics.md (§ Liability payment classification)).
 *
 * ── Certification populations (CCPAY-2F) ─────────────────────────────────────
 * classifierVersion is OWNERSHIP metadata, not merely staleness. Rows fall into
 * three populations with different owners, and the audit MUST distinguish them
 * rather than lump them as "desynced":
 *
 *   1. CLASSIFIER-OWNED  (classifierVersion IS NOT NULL) — this classifier wrote
 *      these. They are the certified population: a stored/recomputed disagreement
 *      here is a REAL desync and fails the audit.
 *
 *   2. NEVER-CLASSIFIED  (classifierVersion IS NULL AND flowType IS NULL) — no
 *      classifier output was ever persisted (the P4 seed/demo backlog). Reported
 *      as an uncertified backlog, NOT a desync — there is nothing to disagree with.
 *
 *   3. FOREIGN-AUTHORITY (classifierVersion IS NULL AND flowType IS NOT NULL) —
 *      a DIFFERENT authority authored the flow facts by hand: today
 *      lib/crypto/btc-sync.ts, which derives category FROM flowType (the inverse
 *      of classifyFlow) and cannot yet be canonically recomputed by this audit.
 *      Reported separately and NOT failed — recomputing it here would assert this
 *      classifier owns facts it does not. (Follow-up: BTC flow-authority
 *      convergence.)
 *
 * Detection is NOT weakened: a corrupted classifier-OWNED row still fails. The
 * change is that legitimately context-dependent rows (CF-4, CCPAY-2B) and rows
 * owned by another authority are no longer false positives.
 *
 * Run:
 *   npx tsx scripts/audit-flow-desync.ts        # or: npm run audit:flow-desync
 *
 * Exit 0 when the classifier-owned population is fully certified; 1 otherwise
 * (with a per-transition, non-PII breakdown). Backlog and foreign-authority
 * counts are reported but never fail the audit. Safe for CI — no writes.
 */

import { db } from "@/lib/db";
import { classifyFlow } from "@/lib/transactions/flow-classifier";
import { buildFlowInputFromRow } from "@/lib/transactions/plaid-flow-input";

const PAGE = 1000;

/** Non-PII tally of one stored→recomputed disagreement shape. */
type DesyncKey = string; // `${category} | ${stored} → ${recomputed}`

async function main(): Promise<void> {
  console.log("\n[AUDIT] FlowType/Category desync — canonical recomputation, READ-ONLY\n");

  let owned = 0;             // population 1 — certified
  let neverClassified = 0;   // population 2 — backlog
  let foreignAuthority = 0;  // population 3 — btc-sync et al.
  let desynced = 0;
  const desyncTally = new Map<DesyncKey, number>();

  // Keyset pagination by id — resume-safe, drift-free, mirrors the backfill.
  let lastId = "";
  for (;;) {
    const rows = await db.transaction.findMany({
      where: lastId ? { id: { gt: lastId } } : undefined,
      orderBy: { id: "asc" },
      take: PAGE,
      select: {
        id: true, category: true, amount: true,
        flowType: true, flowDirection: true, classifierVersion: true,
        pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true, merchantEntityId: true,
        // description/merchant deliberately not selected — the classifier is
        // descriptor-blind (CCPAY-2C-5) and this audit prints no PII.
        financialAccount: { select: { type: true, debtSubtype: true } },
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      // Population 3 — a foreign authority persisted flow facts with no version.
      if (r.classifierVersion == null && r.flowType != null) { foreignAuthority++; continue; }
      // Population 2 — never classified by anyone.
      if (r.classifierVersion == null) { neverClassified++; continue; }

      // Population 1 — classifier-owned. Recompute through the canonical path.
      owned++;
      const { input } = buildFlowInputFromRow(
        {
          category:           r.category,
          amount:             r.amount,
          pfcPrimary:         r.pfcPrimary,
          pfcDetailed:        r.pfcDetailed,
          pfcConfidenceLevel: r.pfcConfidenceLevel,
          merchantEntityId:   r.merchantEntityId,
        },
        {
          accountType: (r.financialAccount?.type as string | null) ?? null,
          debtSubtype: r.financialAccount?.debtSubtype ?? null,
        },
      );
      const c = classifyFlow(input);
      if (c.flowType !== r.flowType || c.flowDirection !== r.flowDirection) {
        desynced++;
        const key = `${r.category} | stored ${r.flowType}/${r.flowDirection} → canonical ${c.flowType}/${c.flowDirection}`;
        desyncTally.set(key, (desyncTally.get(key) ?? 0) + 1);
      }
    }
    lastId = rows[rows.length - 1].id;
  }

  console.log(`  classifier-owned rows (certified population) : ${owned}`);
  console.log(`  never-classified backlog (not a desync)      : ${neverClassified}`);
  console.log(`  foreign-authority rows, e.g. btc-sync        : ${foreignAuthority}`);
  console.log("");

  if (desynced > 0) {
    console.log(`  ✗ ${desynced} classifier-owned row(s) disagree with canonical recomputation:`);
    for (const [key, count] of [...desyncTally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${key}  ×${count}`);
    }
    console.error(
      "\n[AUDIT] FAILED — classifier-owned rows are NOT certified.\n" +
      "Their persisted flow facts differ from the current classifier. Re-run the\n" +
      "ownership-scoped backfill for the affected version:\n" +
      "  npx tsx scripts/backfill-flowtype.ts --only-version=<N> --apply --exclude-deleted\n" +
      "See docs/doctrine/financial-semantics.md (§ Liability payment classification) (versioned derived facts).\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log("[AUDIT] PASSED — every classifier-owned row matches canonical recomputation. ✓");
  if (neverClassified > 0 || foreignAuthority > 0) {
    console.log(
      `        (${neverClassified} never-classified + ${foreignAuthority} foreign-authority rows are ` +
      `outside the certified population by design — not desyncs.)`,
    );
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error("audit-flow-desync failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
