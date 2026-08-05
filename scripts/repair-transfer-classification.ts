/**
 * scripts/repair-transfer-classification.ts   (v2.6-L4-REPAIR-3)
 *
 * The APPROVED R1 + R3 repair — 17 rows. DRY-RUN BY DEFAULT.
 *
 *   npx tsx scripts/repair-transfer-classification.ts             # dry run
 *   npx tsx scripts/repair-transfer-classification.ts --verbose   # full table
 *   npx tsx scripts/repair-transfer-classification.ts --apply
 *
 * ── What it repairs ─────────────────────────────────────────────────────────
 *
 *   R1  16 rows  stored DEBT_PAYMENT · destination candidates span BOTH debt and
 *                savings accounts · TYPE_AMBIGUOUS ⇒ unresolved transfer.
 *                reason AMBIGUOUS_UNKNOWN, confidence 0.2.
 *
 *   R3   1 row   stored DEBT_PAYMENT · EVERY candidate is a savings account ·
 *                TYPE_CERTAIN_ACCOUNT_AMBIGUOUS ⇒ savings transfer.
 *                reason ACCOUNT_TYPE_CONTEXT, confidence 1.0.
 *
 * Both write `flowType → TRANSFER` and leave `counterpartyAccountId` NULL. R3's
 * maturity is SAVINGS_TRANSFER, derived from the TYPE; no specific savings
 * account is fabricated, because none is knowable.
 *
 * ── Why R3 carries confidence 1.0 ──────────────────────────────────────────
 *
 * `classificationConfidence` measures confidence in the CLASSIFICATION, and for
 * R3 the classification is deterministic: every candidate destination is a
 * savings account, so "this is a transfer and not a debt payment" follows with
 * certainty. That matches the repository's existing convention, where
 * ACCOUNT_TYPE_CONTEXT is 0.7 for the heuristic cases and 1.0 where the account
 * type settles the row outright (lib/transactions/flow-classifier.ts:398).
 *
 * The ACCOUNT uncertainty is NOT encoded here. It lives in
 * `counterpartyAccountId = null`, which is its own field. Lowering the
 * confidence to gesture at it would put two different facts in one number —
 * exactly the conflation this arc has spent four slices removing.
 *
 * ── Not touched ────────────────────────────────────────────────────────────
 *
 *   · the 3 R2 rows (TRANSFER → DEBT_PAYMENT, ACCOUNT_CERTAIN) — separate approval
 *   · the 21 TYPE_CERTAIN → DEBT_PAYMENT rows — stored value is already correct
 *   · the 7 counterparty repairs — already TRANSFER with a persisted counterparty
 *   · amount · date · authorizedAt · settlementState · pending · deletedAt ·
 *     financialAccountId · currency · flowDirection · balances · snapshots
 *
 * `flowDirection` is preserved: it is already INTERNAL, and `TRANSFER` +
 * `INTERNAL` is the pair lib/transactions/transaction-facts.ts reads as
 * INTERNAL_TRANSFER — which is what keeps these rows out of income and ordinary
 * spending, so Cash Flow totals cannot move.
 */

import { db } from "@/lib/db";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import {
  resolveDestinationEvidenceFor, maturityForEvidence,
  type TransferLeg,
} from "@/lib/transactions/transfer-maturation";

/**
 * ── v2.6-TRUTH-1 addendum ────────────────────────────────────────────────────
 *
 * R1 and R3 are APPLIED and this script is idempotent — it now short-circuits at
 * "nothing to do" before any gate. It is kept runnable, and re-pointed at the
 * corrected authority (`resolveDestinationEvidenceFor`), so it can never silently
 * describe the corpus using the superseded one-directional rule.
 *
 * `EXPECT` still records the shape that was APPROVED at the time, unchanged — a
 * repair's approval record is history and must not be edited to match a later
 * reading of the corpus. Two of its counts no longer reproduce, and both are
 * expected:
 *
 *   R2               3 → 0   the ATM-withdrawal row is vetoed as a cash movement,
 *                            and the other two fail mutual uniqueness (each of
 *                            their destination legs has two qualifying funding
 *                            rows), landing at TYPE_CERTAIN_ACCOUNT_AMBIGUOUS
 *                            where no counterparty is persistable.
 *   TYPE_CERTAIN_DEBT 21 → 52  rows the one-directional rule called ACCOUNT_CERTAIN
 *                            are correctly demoted to type-certain.
 *
 * Neither can cause a write: R1 and R3 are applied, so the idempotence check
 * returns before the gate is consulted.
 */
const EXPECT = { R1: 16, R3: 1, R2: 3, TYPE_CERTAIN_DEBT: 21 } as const;
const R1_REASON = "AMBIGUOUS_UNKNOWN" as const;
const R1_CONFIDENCE = 0.2;
const R3_REASON = "ACCOUNT_TYPE_CONTEXT" as const;
const R3_CONFIDENCE = 1.0;
// Amount tolerance and the ± day window now live in the authority
// (TRANSFER_AMOUNT_EPSILON / TRANSFER_MATCH_WINDOW_DAYS), so this script cannot
// drift from the rule it is auditing against.

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");
  console.log(`\n[repair-transfer-classification] ${apply ? "APPLY" : "DRY RUN"}\n`);

  const accounts = await db.financialAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, institution: true, type: true, ownerUserId: true },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));

  const all = await db.transaction.findMany({
    select: {
      id: true, financialAccountId: true, date: true, authorizedAt: true, amount: true,
      currency: true, flowType: true, flowDirection: true, deletedAt: true, pending: true,
      settlementState: true, counterpartyAccountId: true, merchant: true,
      plaidTransactionId: true, pendingTransactionRef: true, pfcDetailed: true,
      classificationReason: true, classificationConfidence: true,
    },
  });
  const liveRefs = new Set(
    all.filter((r) => r.deletedAt == null && r.pendingTransactionRef).map((r) => r.pendingTransactionRef!),
  );
  const lifecycleOf = (t: (typeof all)[number]) => resolveLifecycle({
    settlementState: t.settlementState, pending: t.pending, deletedAt: t.deletedAt,
    hasLivePostedSuccessor: t.plaidTransactionId ? liveRefs.has(t.plaidTransactionId) : false,
  });
  const shaped = (f: string | null) => f === null || f === "TRANSFER" || f === "DEBT_PAYMENT" || f === "UNKNOWN";
  const corpus = all.filter((t) => shaped(t.flowType) && !lifecycleOf(t).superseded);

  // v2.6-TRUTH-1 — legs, not ad-hoc candidate tuples. The authority owns the match
  // predicate and BOTH directions now; this script no longer restates either.
  const legs: TransferLeg[] = corpus.map((t) => ({
    id: t.id,
    accountId: t.financialAccountId ?? "",
    accountType: A.get(t.financialAccountId ?? "")?.type ?? "other",
    ownerId: A.get(t.financialAccountId ?? "")?.ownerUserId ?? "",
    amount: t.amount,
    currency: t.currency ?? null,
    dateMs: t.date.getTime(),
    superseded: lifecycleOf(t).superseded,
    providerLinkKey: null, maskedDestinationAccountId: null, railType: null, movementForm: plaidTransferEvidence({ pfcDetailed: t.pfcDetailed, amount: t.amount, name: t.merchant }).movementForm ?? null,
  }));

  const R1: typeof corpus = [], R3: typeof corpus = [], R2: typeof corpus = [], typeCertainDebt: typeof corpus = [];
  const detail = new Map<string, { level: string; mature: string; cands: string; types: string }>();

  for (let i = 0; i < corpus.length; i++) {
    const t = corpus[i];
    const e = resolveDestinationEvidenceFor(legs[i], legs);
    // This historical repair predates the external terminal leaves and made no
    // claim about them; passing nulls keeps its verdicts byte-identical.
    const own = {
      accountType: legs[i].accountType, amount: t.amount,
      railType: null, venueClass: null, counterpartyClass: null,
    };
    const mature = maturityForEvidence(e, own);
    detail.set(t.id, {
      level: e.level, mature,
      cands: e.candidateAccountIds.map((id) => A.get(id)?.name ?? id).join(" | ") || "none",
      types: e.candidateTypes.join("+") || "none",
    });

    if (t.flowType === "DEBT_PAYMENT" && e.level === "TYPE_AMBIGUOUS" && mature === "UNRESOLVED_TRANSFER") R1.push(t);
    else if (t.flowType === "DEBT_PAYMENT" && e.level === "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS" && mature === "SAVINGS_TRANSFER") R3.push(t);
    else if (t.flowType === "TRANSFER" && e.level === "ACCOUNT_CERTAIN" && mature === "DEBT_PAYMENT") R2.push(t);
    else if (t.flowType === "DEBT_PAYMENT" && e.level === "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS" && mature === "DEBT_PAYMENT") typeCertainDebt.push(t);
  }

  // ── Gate: every population must match the approved shape exactly ──────────
  const found = { R1: R1.length, R3: R3.length, R2: R2.length, TYPE_CERTAIN_DEBT: typeCertainDebt.length };
  console.log("  population check (approved-at-the-time → found-now):");
  console.log("    R2 and TYPE_CERTAIN_DEBT are EXPECTED to differ post-v2.6-TRUTH-1; see the header.");
  let mismatch = false;
  for (const k of Object.keys(EXPECT) as (keyof typeof EXPECT)[]) {
    const ok = EXPECT[k] === found[k];
    if (!ok) mismatch = true;
    console.log(`    ${k.padEnd(18)} ${String(EXPECT[k]).padStart(3)} → ${String(found[k]).padStart(3)}  ${ok ? "✓" : "✗"}`);
  }
  console.log("");

  const proposals = [...R1.map((t) => ({ t, group: "R1" as const })), ...R3.map((t) => ({ t, group: "R3" as const }))];
  proposals.sort((a, b) => a.t.date.getTime() - b.t.date.getTime());

  if (verbose || proposals.length <= 20) {
    console.log(`  ${"tx".padEnd(26)} ${"acct".padEnd(20)} ${"amount".padStart(9)} ${"econ".padEnd(11)} ${"posted".padEnd(11)} ${"lc".padEnd(8)} ${"cur".padEnd(13)} ${"lvl".padEnd(30)} ${"→ mature".padEnd(20)} grp`);
    for (const { t, group } of proposals) {
      const d = detail.get(t.id)!;
      const econ = resolveEconomicDate({ postingDate: t.date, authorizedAt: t.authorizedAt });
      console.log(
        `  ${t.id.padEnd(26)} ${(A.get(t.financialAccountId!)?.name ?? "?").slice(0,19).padEnd(20)} ${t.amount.toFixed(2).padStart(9)} ` +
        `${econ.economicDate} ${econ.postingDate} ${lifecycleOf(t).state.padEnd(8)} ${String(t.flowType).padEnd(13)} ${d.level.padEnd(30)} ${d.mature.padEnd(20)} ${group}`,
      );
      console.log(`     candidates: ${d.cands}   types: ${d.types}   dir=${t.flowDirection} (preserved)   reason ${t.classificationReason}/${t.classificationConfidence} → ${group === "R1" ? `${R1_REASON}/${R1_CONFIDENCE}` : `${R3_REASON}/${R3_CONFIDENCE}`}   counterparty ${t.counterpartyAccountId ?? "null"} → null (unchanged)`);
    }
    console.log("");
  }

  // Every proposal must already have a null counterparty, and keep it.
  const withCp = proposals.filter((p) => p.t.counterpartyAccountId != null);
  if (withCp.length) { console.error(`  ABORT — ${withCp.length} proposal(s) already carry a counterparty.`); process.exit(1); }

  console.log(`  proposals: ${proposals.length} (R1 ${R1.length} + R3 ${R3.length}; approved 17)`);

  const alreadyR1 = await db.transaction.count({
    where: { deletedAt: null, flowType: "TRANSFER", classificationReason: R1_REASON,
             classificationConfidence: R1_CONFIDENCE, counterpartyAccountId: null, amount: { lt: 0 } },
  });
  if (proposals.length === 0 && alreadyR1 >= EXPECT.R1) {
    console.log("\n  Nothing to do — R1 + R3 are already applied. Idempotent and complete.\n");
    return;
  }

  if (mismatch || proposals.length !== EXPECT.R1 + EXPECT.R3) {
    console.error(`\n  ABORT — the corpus no longer matches the approved shape. Re-approve before applying.\n`);
    process.exit(1);
  }
  if (!apply) { console.log("\n  Dry run — nothing written. Re-run with --apply to write.\n"); return; }

  // ONE transaction: all 17 land together or none do.
  const written = await db.$transaction([
    ...R1.map((t) => db.transaction.update({
      where: { id: t.id },
      data: { flowType: "TRANSFER", classificationReason: R1_REASON, classificationConfidence: R1_CONFIDENCE },
    })),
    ...R3.map((t) => db.transaction.update({
      where: { id: t.id },
      data: { flowType: "TRANSFER", classificationReason: R3_REASON, classificationConfidence: R3_CONFIDENCE },
    })),
  ]);
  console.log(`\n  APPLIED — ${written.length} rows (R1 ${R1.length}, R3 ${R3.length}).\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
