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
 * ── Certification populations (CCPAY-2F, made explicit by v2.6-OWN-1) ───────
 * WHICH authority wrote a row's flow facts is now a COLUMN — `flowAuthority` —
 * not an inference from `classifierVersion`. Rows fall into four populations
 * with different owners, and the audit MUST distinguish them rather than lump
 * them as "desynced":
 *
 *   1. CLASSIFIER  — this classifier wrote these. They are the certified
 *      population: a stored/recomputed disagreement here is a REAL desync and
 *      fails the audit.
 *
 *   2. UNOWNED (flowAuthority IS NULL, flowType IS NULL) — no classifier output
 *      was ever persisted (the seed/demo backlog). Reported as an uncertified
 *      backlog, NOT a desync — there is nothing to disagree with.
 *
 *   3. TRANSFER_AUTHORITY — lib/transactions/transfer-maturation.ts decided these
 *      and an approved repair applied them. Strictly better informed than the
 *      classifier on these rows (it weighed the counterparty leg, the venue and
 *      the account type), so recomputing them asserts ownership the classifier
 *      does not have.
 *
 *   4. CRYPTO_LEDGER — lib/crypto/btc-sync.ts, which derives category FROM
 *      flowType (the inverse of classifyFlow) and cannot be canonically
 *      recomputed here.
 *
 * ⚠️ WHY THIS WAS REWRITTEN AGAIN (v2.6-OWN-1). Populations 3 and 4 used to be
 * detected as "classifierVersion IS NULL". That worked for btc-sync and failed
 * completely for the repairs, which left `classifierVersion = 4` and reused the
 * classifier's own reason codes — so 12 approved transfer-authority rows were
 * reported as desyncs, this audit FAILED, and its remediation text told the
 * operator to run `backfill-flowtype --only-version=4 --apply`, which would have
 * REVERTED all twelve. The remediation is gone; the ownership column replaced the
 * inference; and the backfill's predicate now refuses those rows outright.
 *
 * Detection is NOT weakened: a corrupted CLASSIFIER-owned row still fails, and
 * this audit additionally enforces the ownership invariants themselves (INV-A/B/C
 * below), which is strictly more than it checked before.
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
import {
  FLOW_AUTHORITIES,
  FLOW_AUTHORITY_SOURCE,
  isClassifierCertifiable,
  isFlowOwnershipCoupled,
  type FlowAuthorityName,
} from "@/lib/transactions/flow-authority";

const PAGE = 1000;

/** Non-PII tally of one stored→recomputed disagreement shape. */
type DesyncKey = string; // `${category} | ${stored} → ${recomputed}`

/** An ownership-invariant breach, non-PII. */
interface Breach { id: string; detail: string }

async function main(): Promise<void> {
  console.log("\n[AUDIT] FlowType ownership + canonical recomputation — READ-ONLY\n");

  /** Rows per authority, plus the unowned population. */
  const byAuthority: Record<string, number> = { UNOWNED: 0 };
  for (const a of FLOW_AUTHORITIES) byAuthority[a] = 0;

  let desynced = 0;
  const desyncTally = new Map<DesyncKey, number>();

  // The ownership invariants. Each is a property of the corpus, checked on the
  // same single pass that certifies the classifier population.
  const uncoupled:      Breach[] = []; // INV-A
  const versionMissing: Breach[] = []; // INV-B
  const versionStrayed: Breach[] = []; // INV-C

  // Keyset pagination by id — resume-safe, drift-free, mirrors the backfill.
  let lastId = "";
  for (;;) {
    const rows = await db.transaction.findMany({
      where: lastId ? { id: { gt: lastId } } : undefined,
      orderBy: { id: "asc" },
      take: PAGE,
      select: {
        id: true, category: true, amount: true,
        flowType: true, flowDirection: true,
        flowAuthority: true, classifierVersion: true,
        pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true, merchantEntityId: true,
        // description/merchant deliberately not selected — the classifier is
        // descriptor-blind (CCPAY-2C-5) and this audit prints no PII.
        financialAccount: { select: { type: true, debtSubtype: true } },
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const authority = r.flowAuthority as FlowAuthorityName | null;
      byAuthority[authority ?? "UNOWNED"]++;

      // INV-A — ownership is COUPLED to the value: a classified row has exactly
      // one owner, an unclassified row has none. This is the invariant that makes
      // "unowned" mean "nobody classified it" rather than "we forgot to stamp it".
      if (!isFlowOwnershipCoupled(r)) {
        uncoupled.push({
          id: r.id,
          detail: `flowType=${r.flowType ?? "null"} but flowAuthority=${authority ?? "null"}`,
        });
      }

      // INV-B — a CLASSIFIER row carries the version of the classifier that wrote
      // it. Without it the certified population cannot be version-migrated.
      if (authority === "CLASSIFIER" && r.classifierVersion == null) {
        versionMissing.push({ id: r.id, detail: "CLASSIFIER row with no classifierVersion" });
      }

      // INV-C — a NON-classifier row must NOT carry a classifier version. Leaving
      // one behind is the precise defect this slice closed: it made the transfer
      // authority's rows look like classifier output and put them one
      // ownership-scoped backfill away from reversion.
      if (authority != null && authority !== "CLASSIFIER" && r.classifierVersion != null) {
        versionStrayed.push({
          id: r.id,
          detail: `${authority} row still carries classifierVersion=${r.classifierVersion}`,
        });
      }

      // Only the CLASSIFIER population is recomputable. Recomputing anything else
      // proves nothing about that row and asserts ownership it does not have.
      if (!isClassifierCertifiable(authority)) continue;

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

  console.log("  ownership census:");
  for (const a of FLOW_AUTHORITIES) {
    console.log(`    ${String(byAuthority[a]).padStart(6)}  ${a.padEnd(20)} ${FLOW_AUTHORITY_SOURCE[a]}`);
  }
  console.log(`    ${String(byAuthority.UNOWNED).padStart(6)}  ${"(unowned)".padEnd(20)} no flowType — nobody has classified these`);
  console.log("");
  console.log(`  certified population (CLASSIFIER-owned) : ${byAuthority.CLASSIFIER}`);
  console.log("");

  // ── Ownership invariants ──────────────────────────────────────────────────
  const invariantBreaches: [string, string, Breach[]][] = [
    ["INV-A", "ownership is coupled to the value (flowType IS NULL ⟺ flowAuthority IS NULL)", uncoupled],
    ["INV-B", "every CLASSIFIER row carries a classifierVersion", versionMissing],
    ["INV-C", "no non-CLASSIFIER row carries a classifierVersion", versionStrayed],
  ];
  let invariantsHeld = true;
  for (const [id, statement, breaches] of invariantBreaches) {
    if (breaches.length === 0) {
      console.log(`  ✓ ${id} ${statement}`);
      continue;
    }
    invariantsHeld = false;
    console.log(`  ✗ ${id} ${statement} — ${breaches.length} breach(es):`);
    for (const b of breaches.slice(0, 20)) console.log(`        ${b.id}  ${b.detail}`);
    if (breaches.length > 20) console.log(`        …and ${breaches.length - 20} more`);
  }
  console.log("");

  if (!invariantsHeld) {
    console.error(
      "[AUDIT] FAILED — the flow-ownership invariants do not hold.\n" +
      "A write path is producing flow facts without naming its authority, or is leaving\n" +
      "another authority's metadata behind. Fix the WRITE SITE — every authority stamps\n" +
      "itself (lib/transactions/flow-authority.ts). Do not backfill over it.\n",
    );
    process.exitCode = 1;
    return;
  }

  if (desynced > 0) {
    console.log(`  ✗ ${desynced} CLASSIFIER-owned row(s) disagree with canonical recomputation:`);
    for (const [key, count] of [...desyncTally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${key}  ×${count}`);
    }
    console.error(
      "\n[AUDIT] FAILED — CLASSIFIER-owned rows are NOT certified.\n" +
      "Their persisted flow facts differ from what the current classifier computes from\n" +
      "their own stored columns, and the ownership column says the classifier wrote them.\n" +
      "Exactly one of those two statements is wrong:\n" +
      "  · if the CLASSIFIER genuinely owns them, re-run its ownership-scoped backfill\n" +
      "      npx tsx scripts/backfill-flowtype.ts --only-version=<N> --apply --exclude-deleted\n" +
      "    which now selects ONLY flowAuthority = CLASSIFIER or NULL, so it cannot reach\n" +
      "    another authority's rows;\n" +
      "  · if another authority decided them, that authority must STAMP them at its own\n" +
      "    write site — never leave them wearing the classifier's name.\n" +
      "See lib/transactions/flow-authority.ts and docs/doctrine/financial-semantics.md\n" +
      "(§ Liability payment classification).\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log("[AUDIT] PASSED — every CLASSIFIER-owned row matches canonical recomputation,");
  console.log("        and every row's flow facts name the authority that produced them. ✓");
  const outside = byAuthority.UNOWNED + byAuthority.TRANSFER_AUTHORITY + byAuthority.CRYPTO_LEDGER;
  if (outside > 0) {
    console.log(
      `        (${byAuthority.UNOWNED} unowned + ${byAuthority.TRANSFER_AUTHORITY} transfer-authority + ` +
      `${byAuthority.CRYPTO_LEDGER} crypto-ledger rows are outside the certified population by design — not desyncs.)`,
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
