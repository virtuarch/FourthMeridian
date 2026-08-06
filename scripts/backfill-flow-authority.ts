/**
 * scripts/backfill-flow-authority.ts
 *
 * v2.6-OWN-1 — the ONE-TIME ownership stamp for `Transaction.flowAuthority`.
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-flow-authority.ts
 *   npx tsx --env-file=.env.local scripts/backfill-flow-authority.ts --apply
 *
 * ── What it refuses to do ───────────────────────────────────────────────────
 *
 * It does not GUESS. Every row is assigned an authority only where authorship is
 * PROVEN from facts already on the row; anything else is reported and the script
 * exits 1 having written nothing. That refusal is the point: a backfill that
 * assumed "not obviously crypto ⇒ classifier" would re-create, in one pass, the
 * exact false claim the column exists to prevent.
 *
 * ── The four proofs ─────────────────────────────────────────────────────────
 *
 *  1. UNOWNED        flowType IS NULL
 *                    No value, so no author. The never-classified seed backlog.
 *
 *  2. CRYPTO_LEDGER  classifierVersion IS NULL ∧ flowType IS NOT NULL
 *                    ∧ the owning account is `type: crypto` WITH a walletAddress
 *                    lib/crypto/btc-sync.ts is the only writer in the repository
 *                    that produces flow facts without a classifier version, and
 *                    it only ever writes onto a self-custody wallet account. A
 *                    version-less row that is NOT on such an account fails the
 *                    proof and is refused.
 *
 *  3. CLASSIFIER     classifierVersion IS NOT NULL
 *                    ∧ classifyFlow(row) == (stored flowType, flowDirection)
 *                    `classifyFlow` is pure and deterministic over stored
 *                    columns. If re-running it reproduces the stored value, the
 *                    classifier can attest that row — which is precisely what
 *                    CLASSIFIER ownership means and exactly what audit:flow-desync
 *                    certifies. This is a proof, not an inference.
 *
 *  4. TRANSFER_AUTHORITY
 *                    classifierVersion IS NOT NULL
 *                    ∧ classifyFlow(row) != stored          ← the classifier
 *                                                             DID NOT write this
 *                    ∧ the stored (flowType, reason, confidence) triple matches
 *                      a REGISTERED repair write signature   ← and this did
 *
 *                    The first clause eliminates the classifier: a pure function
 *                    cannot have produced a value it does not produce. The second
 *                    identifies the author from the closed, in-repo set of
 *                    non-classifier banking writers (scripts/repair-*.ts). Both
 *                    are required. A row that fails EITHER is refused, printed,
 *                    and stops the run.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────────
 *
 * Rows that already carry a `flowAuthority` are skipped, and the script asserts
 * that the stamp it WOULD have derived equals the stamp already there — so a
 * second run is both a no-op and a re-verification. A disagreement is a failure,
 * not a silent overwrite.
 *
 * ── What it writes, and what it never touches ───────────────────────────────
 *
 * WRITES, and only these:
 *   · flowAuthority      — on every row that proved to have one
 *   · classifierVersion  — set to NULL on NON-classifier rows only
 *
 * The second is not incidental. `classifierVersion` means "the version of the
 * classifier whose output is in these columns". Once the transfer authority
 * overwrote them, that stopped being a true statement about the row, and leaving
 * the number behind is exactly what made the repairs indistinguishable from
 * classifier output. Nulling it also makes the pre-OWN-1 logic
 * (`classifierVersion IS NULL ⇒ not certified`) agree with the new column by
 * construction rather than by luck, and it is what `audit:flow-desync` INV-C
 * asserts corpus-wide. On this corpus it affects 12 rows; the 28 crypto-ledger
 * rows already carry null.
 *
 * Nothing branches on `classifierVersion` — it is emitted to the DTO and read by
 * no fold, no total, no UI (verified by grep across lib/, app/, components/), so
 * this moves ownership metadata and nothing else.
 *
 * NEVER TOUCHES: flowType · flowDirection · classificationReason ·
 * classificationConfidence · counterpartyAccountId · category · amount · date ·
 * any timestamp. The raw UPDATE deliberately does not bump `updatedAt`. Every
 * FINANCIAL fingerprint in the corpus is unchanged by construction — ownership
 * metadata is the only thing that moves, which is the one change this intends.
 */

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { classifyFlow } from "@/lib/transactions/flow-classifier";
import { buildFlowInputFromRow } from "@/lib/transactions/plaid-flow-input";
import {
  FLOW_AUTHORITY_LABEL,
  FLOW_AUTHORITY_SOURCE,
  type FlowAuthorityName,
} from "@/lib/transactions/flow-authority";

const APPLY = process.argv.includes("--apply");
const PAGE  = 1000;

/**
 * The write signatures of every NON-CLASSIFIER banking authority in this
 * repository, as `flowType | classificationReason | classificationConfidence`.
 *
 * Sourced from the repair scripts themselves:
 *   repair-transfer-classification.ts   R1  TRANSFER     / AMBIGUOUS_UNKNOWN   / 0.2
 *                                       R3  TRANSFER     / ACCOUNT_TYPE_CONTEXT / 1.0
 *   repair-type-certain-debt-payment.ts     DEBT_PAYMENT / ACCOUNT_TYPE_CONTEXT / 1.0
 *   repair-transfer-counterparty.ts         TRANSFER     / ACCOUNT_TYPE_CONTEXT / 1.0
 *   repair-unearned-debt-payment.ts         TRANSFER     / AMBIGUOUS_UNKNOWN   / 0.2
 *   repair-transfer-authority.ts            TRANSFER | DEBT_PAYMENT
 *                                                        / ACCOUNT_TYPE_CONTEXT / 1.0
 *
 * ⚠️ These signatures are NOT unique to the repairs — the classifier can emit
 * every one of them. They are therefore never used ALONE: a row must ALSO have
 * been proven not-classifier-written (proof 4, clause 1). The signature answers
 * "which of the known non-classifier writers", never "was this a repair".
 *
 * This registry is a MIGRATION artifact and does not grow. Every authority now
 * stamps itself at its own write site, so a future authority needs no entry
 * here — only a write site that names itself.
 */
const REPAIR_WRITE_SIGNATURES: ReadonlySet<string> = new Set([
  "TRANSFER|AMBIGUOUS_UNKNOWN|0.2",
  "TRANSFER|ACCOUNT_TYPE_CONTEXT|1",
  "DEBT_PAYMENT|ACCOUNT_TYPE_CONTEXT|1",
]);

function signatureOf(r: {
  flowType: string | null;
  classificationReason: string | null;
  classificationConfidence: number | null;
}): string {
  return `${r.flowType}|${r.classificationReason}|${r.classificationConfidence}`;
}

/** A row the script could not prove. Reported, never assigned. */
interface Refusal {
  id:        string;
  why:       string;
  signature: string;
}

function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  console.log(`\n[${APPLY ? "APPLY" : "DRY RUN"}] v2.6-OWN-1 flow-authority ownership stamp\n`);

  const counts: Record<string, number> = {
    UNOWNED: 0, CLASSIFIER: 0, TRANSFER_AUTHORITY: 0, CRYPTO_LEDGER: 0,
  };
  const refusals: Refusal[] = [];
  const conflicts: { id: string; stored: string; derived: string }[] = [];
  const writes: { id: string; authority: FlowAuthorityName }[] = [];
  /** Non-classifier rows still carrying a classifier version (INV-C). */
  let versionsCleared = 0;
  let alreadyStamped = 0;
  let scanned = 0;
  // Ordered id→authority pairs, so two runs over an unchanged corpus are provably
  // the same decision and not merely the same totals.
  const decisionParts: string[] = [];

  let lastId = "";
  for (;;) {
    const rows = await db.transaction.findMany({
      where:   lastId ? { id: { gt: lastId } } : undefined,
      orderBy: { id: "asc" },
      take:    PAGE,
      select: {
        id: true, category: true, amount: true, currency: true,
        flowType: true, flowDirection: true,
        classificationReason: true, classificationConfidence: true, classifierVersion: true,
        flowAuthority: true,
        pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true, merchantEntityId: true,
        // description/merchant deliberately not selected — the classifier is
        // descriptor-blind and this script prints no PII.
        financialAccount: { select: { type: true, debtSubtype: true, walletAddress: true } },
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      scanned++;
      const sig = signatureOf(r);
      const acct = r.financialAccount;

      /** Re-run the canonical classifier over this row's own stored columns.
       *  Pure and deterministic, so agreement IS attestation. */
      const classifierAttests = (): boolean => {
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
            accountType: (acct?.type as string | null) ?? null,
            debtSubtype: acct?.debtSubtype ?? null,
          },
        );
        const c = classifyFlow(input);
        return c.flowType === r.flowType && c.flowDirection === r.flowDirection;
      };

      // ── Already stamped: RE-VERIFY, never re-derive ────────────────────────
      //
      // Re-derivation is not available here, and deliberately so. Stamping a
      // non-classifier row also nulls its `classifierVersion` (INV-C), which
      // removes the very input proofs 3 and 4 keyed on — a second derivation
      // would read a TRANSFER_AUTHORITY row as version-less and refuse it. What
      // IS still checkable is every invariant the stamp must satisfy, so that is
      // what a re-run checks. This makes the second run a genuine audit rather
      // than an accidental no-op.
      if (r.flowAuthority !== null) {
        const stamped = r.flowAuthority as FlowAuthorityName;
        alreadyStamped++;
        counts[stamped]++;
        decisionParts.push(`${r.id}=${stamped}`);

        if (r.flowType == null) {
          conflicts.push({ id: r.id, stored: stamped, derived: "UNOWNED (flowType IS NULL)" });
        } else if (stamped !== "CLASSIFIER" && r.classifierVersion != null) {
          conflicts.push({ id: r.id, stored: stamped, derived: `${stamped} but classifierVersion=${r.classifierVersion}` });
        } else if (stamped === "CLASSIFIER" && !classifierAttests()) {
          conflicts.push({ id: r.id, stored: stamped, derived: "not reproducible by classifyFlow" });
        } else if (stamped === "CRYPTO_LEDGER" && !(acct?.type === "crypto" && !!acct.walletAddress)) {
          conflicts.push({ id: r.id, stored: stamped, derived: "not on a self-custody wallet account" });
        }
        continue;
      }

      // ── Unstamped: DERIVE, proving authorship or refusing ──────────────────
      let authority: FlowAuthorityName | null;

      if (r.flowType == null) {
        // Proof 1 — no value, no author.
        authority = null;
      } else if (r.classifierVersion == null) {
        // Proof 2 — the on-chain ledger is the only version-less writer, and it
        // only ever writes onto a self-custody wallet account.
        if (!(acct?.type === "crypto" && !!acct.walletAddress)) {
          refusals.push({
            id: r.id, signature: sig,
            why: "flow facts with NO classifierVersion, but not on a self-custody wallet account — " +
                 "no known authority writes that shape",
          });
          continue;
        }
        authority = "CRYPTO_LEDGER";
      } else if (classifierAttests()) {
        // Proof 3 — classifyFlow reproduces the stored value, so the classifier
        // can attest this row. That IS what CLASSIFIER ownership means.
        authority = "CLASSIFIER";
      } else if (REPAIR_WRITE_SIGNATURES.has(sig)) {
        // Proof 4 — classifyFlow does NOT produce this value, so the classifier
        // did not write it; and the signature names a registered repair write.
        authority = "TRANSFER_AUTHORITY";
      } else {
        refusals.push({
          id: r.id, signature: sig,
          why: `classifyFlow does not reproduce the stored ${r.flowType}/${r.flowDirection}, ` +
               `and ${sig} matches no registered authority`,
        });
        continue;
      }

      counts[authority ?? "UNOWNED"]++;
      decisionParts.push(`${r.id}=${authority ?? "UNOWNED"}`);
      if (authority !== null) {
        writes.push({ id: r.id, authority });
        if (authority !== "CLASSIFIER" && r.classifierVersion != null) versionsCleared++;
      }
    }
    lastId = rows[rows.length - 1].id;
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`  rows scanned            : ${scanned}`);
  console.log(`  already stamped         : ${alreadyStamped}  (re-verified, never rewritten)`);
  console.log("");
  console.log("  derived ownership:");
  for (const k of ["CLASSIFIER", "TRANSFER_AUTHORITY", "CRYPTO_LEDGER"] as const) {
    console.log(
      `    ${String(counts[k]).padStart(5)}  ${k.padEnd(20)} ${FLOW_AUTHORITY_LABEL[k]}` +
      `\n           ${" ".repeat(20)} ${FLOW_AUTHORITY_SOURCE[k]}`,
    );
  }
  console.log(`    ${String(counts.UNOWNED).padStart(5)}  ${"(unowned)".padEnd(20)} flowType IS NULL — nobody has classified these`);
  console.log("");

  if (conflicts.length > 0) {
    console.error(`  ✗ ${conflicts.length} row(s) carry a stamp that disagrees with the derived authority:`);
    for (const c of conflicts.slice(0, 20)) {
      console.error(`      ${c.id}  stored=${c.stored}  derived=${c.derived}`);
    }
    console.error("\n[BACKFILL] FAILED — the stamp is not reproducible. Nothing written.\n");
    process.exitCode = 1;
    return;
  }

  if (refusals.length > 0) {
    console.error(`  ✗ ${refusals.length} row(s) REFUSED — authorship could not be proven:`);
    for (const f of refusals.slice(0, 40)) {
      console.error(`      ${f.id}  sig=${f.signature}\n          ${f.why}`);
    }
    console.error(
      "\n[BACKFILL] FAILED — nothing written.\n" +
      "A row here has flow facts no registered authority can account for. Assigning one\n" +
      "would be a guess, and a guessed owner is exactly the false claim this column exists\n" +
      "to prevent. Identify the writer, give it a FlowAuthority value and a write site that\n" +
      "stamps itself, then re-run.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`  ownership decision fingerprint: ${fingerprint(decisionParts)}  (${decisionParts.length} rows)`);
  console.log(`  rows needing a stamp          : ${writes.length}`);
  console.log(`  ...also clearing classifierVersion (INV-C, non-classifier rows): ${versionsCleared}`);

  if (writes.length === 0) {
    console.log("\n[BACKFILL] Nothing to write — every row already carries the authority it derives to. ✓\n");
    return;
  }
  if (!APPLY) {
    console.log("\n  Dry run — nothing written. Re-run with --apply to write.\n");
    return;
  }

  // ONE column, parameterized, no @updatedAt bump. Chunked so a large corpus
  // does not build a single unbounded statement list.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const slice = writes.slice(i, i + CHUNK);
    await db.$transaction(
      slice.map((w) => (w.authority === "CLASSIFIER"
        ? db.$executeRaw`
            UPDATE "Transaction" SET "flowAuthority" = ${w.authority}::"FlowAuthority"
            WHERE "id" = ${w.id}
          `
        // INV-C — a non-classifier row must not wear the classifier's version.
        : db.$executeRaw`
            UPDATE "Transaction" SET "flowAuthority" = ${w.authority}::"FlowAuthority",
                                     "classifierVersion" = NULL
            WHERE "id" = ${w.id}
          `)),
    );
    written += slice.length;
  }
  console.log(`\n[BACKFILL] APPLIED — ${written} row(s) stamped. Re-run to verify 0 remain.\n`);
}

main()
  .catch((err) => {
    console.error("backfill-flow-authority failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
