/**
 * scripts/repair-type-certain-debt-payment.ts   (v2.6-TRUTH-1-REPAIR)
 *
 * The APPROVED corrected R2 repair — 2 rows. DRY-RUN BY DEFAULT.
 *
 *   npx tsx scripts/repair-type-certain-debt-payment.ts             # dry run
 *   npx tsx scripts/repair-type-certain-debt-payment.ts --apply
 *
 * ── What it repairs ─────────────────────────────────────────────────────────
 *
 * Two rows stored TRANSFER whose destination TYPE is certainly a liability, but
 * whose destination ACCOUNT is not mutually deterministic:
 *
 *   cmrrmeoib01pm7znwav7h4w13   Amex Rewards Checking  2025-12-01  −1,500.00
 *   cmrrmeoeq01p47znw3c5kat5v   Amex Rewards Checking  2026-05-11    −500.00
 *
 *   flowType                TRANSFER → DEBT_PAYMENT
 *   classificationReason    → ACCOUNT_TYPE_CONTEXT
 *   classificationConfidence → 1.0
 *   counterpartyAccountId   → UNCHANGED (null)
 *
 * ── Why the counterparty stays null ────────────────────────────────────────
 *
 * This is the whole point of the repair, so it is enforced rather than trusted:
 * the script ABORTS if either row resolves ACCOUNT_CERTAIN, and it never writes
 * `counterpartyAccountId` at all. Each row's single qualifying destination leg is
 * itself matched by TWO source events (the second being an Amex HYSA outflow the
 * same day), so the pairing does not close in both directions. The destination
 * TYPE is settled — every candidate is the Platinum Card® — and that is exactly
 * what `ACCOUNT_TYPE_CONTEXT` at confidence 1.0 records.
 *
 * The superseded R2 proposal would have written a counterparty on these two and
 * on a third row — an ATM cash withdrawal, which the corrected authority now
 * vetoes as a CASH_MOVEMENT. That third row is deliberately NOT in this repair,
 * and the gate below fails if it ever appears in the proposal set.
 *
 * ── Not touched ────────────────────────────────────────────────────────────
 *
 *   · the ATM-withdrawal row (cmrrmn3rh08ur7znwd3u5vbk0) — cash, no counterparty
 *   · the 17 R1 + R3 rows           · the 7 counterparty repairs
 *   · amount · date · authorizedAt · settlementState · pending · deletedAt ·
 *     flowDirection · financialAccountId · currency · counterpartyAccountId ·
 *     balances · snapshots · historical values
 *
 * `flowDirection` is preserved. Both rows are already OUTFLOW, and DEBT_PAYMENT +
 * OUTFLOW is not counted as income or ordinary spending by the Cash Flow
 * projection, so its totals cannot move. Proven by fingerprint, not asserted.
 */

import { db } from "@/lib/db";
// v2.6-OWN-1 — this repair applies the TRANSFER AUTHORITY's verdict, and says so
// on the row. `foreignFlowOwnershipFields` also nulls `classifierVersion`: once
// these columns hold the transfer authority's answer, "the classifier at version
// N produced these" is no longer a true statement about the row. Leaving that
// number behind is precisely what made these repairs look like classifier output
// and put them one `backfill-flowtype --only-version=4 --apply` from reversion.
import { foreignFlowOwnershipFields } from "@/lib/transactions/flow-authority";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import {
  resolveDestinationEvidenceFor, maturityForEvidence, isTransferPrefilterCandidate,
  type TransferLeg,
} from "@/lib/transactions/transfer-maturation";

/** The approved rows. The proposal set must equal this EXACTLY — no more, no fewer. */
const APPROVED = [
  "cmrrmeoib01pm7znwav7h4w13",
  "cmrrmeoeq01p47znw3c5kat5v",
] as const;

/** The row the corrected authority vetoed. Must never enter a proposal. */
const VETOED_ATM = "cmrrmn3rh08ur7znwd3u5vbk0";

const REASON = "ACCOUNT_TYPE_CONTEXT" as const;
const CONFIDENCE = 1.0;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`\n[repair-type-certain-debt-payment] ${apply ? "APPLY" : "DRY RUN"}\n`);

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
  const corpus = all.filter((t) => isTransferPrefilterCandidate(t.flowType) && !lifecycleOf(t).superseded);

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

  // ── Derive the proposal set from the AUTHORITY, never from the id list ─────
  // The id list is only ever used to CHECK the derived set. A repair that
  // selected rows by id would apply an approval to whatever those ids hold now.
  const proposals: Array<{ t: (typeof corpus)[number]; i: number }> = [];
  let vetoedSeen = false;
  for (let i = 0; i < corpus.length; i++) {
    const t = corpus[i];
    const e = resolveDestinationEvidenceFor(legs[i], legs);
    const mature = maturityForEvidence(e, { accountType: legs[i].accountType, amount: t.amount, railType: null, venueClass: null, counterpartyClass: null });
    if (t.id === VETOED_ATM && e.level !== "CASH_NO_COUNTERPARTY") {
      vetoedSeen = true;
      console.error(`  ABORT — the ATM-withdrawal row is no longer CASH_NO_COUNTERPARTY (${e.level}).`);
    }
    if (
      t.flowType === "TRANSFER" &&
      e.level === "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS" &&
      e.accountType === "debt" &&
      mature === "DEBT_PAYMENT" &&
      e.persistableCounterparty === false
    ) proposals.push({ t, i });
  }
  proposals.sort((a, b) => a.t.date.getTime() - b.t.date.getTime());

  // ── Dry-run table ─────────────────────────────────────────────────────────
  for (const { t, i } of proposals) {
    const e = resolveDestinationEvidenceFor(legs[i], legs);
    const econ = resolveEconomicDate({ postingDate: t.date, authorizedAt: t.authorizedAt });
    const lc = lifecycleOf(t);
    console.log(`  ── ${t.id}`);
    console.log(`     "${t.merchant}"`);
    console.log(`     account         ${A.get(t.financialAccountId ?? "")?.name} (${legs[i].accountType})   amount ${t.amount.toFixed(2)} ${t.currency}`);
    console.log(`     economic ${econ.economicDate}  posted ${econ.postingDate}  lifecycle ${lc.state}/${lc.basis}  superseded=${lc.superseded}`);
    console.log(`     evidence        ${e.level}  destinationType=${e.accountType}  persistable=${e.persistableCounterparty}`);
    console.log(`     refusal         ${e.mutualityRefusal ?? "-"}`);
    console.log(`     flowType        ${t.flowType} → DEBT_PAYMENT`);
    console.log(`     reason/conf     ${t.classificationReason}/${t.classificationConfidence} → ${REASON}/${CONFIDENCE}`);
    console.log(`     counterparty    ${t.counterpartyAccountId ?? "null"} → UNCHANGED (never written)`);
    console.log(`     flowDirection   ${t.flowDirection} (preserved)\n`);
  }

  // ── Idempotence FIRST ─────────────────────────────────────────────────────
  // Applying the repair removes both rows from the TRANSFER-gated proposal set,
  // so on a second pass the set-equality gate below would legitimately fail. That
  // is a completed repair, not a drift, and it must not be reported as an abort —
  // otherwise a routine re-run looks like a corpus emergency. The check is
  // narrow: it fires only when the approved rows are ALREADY in the exact target
  // state, counterparty still null.
  const done = await db.transaction.count({
    where: { id: { in: [...APPROVED] }, flowType: "DEBT_PAYMENT",
             classificationReason: REASON, classificationConfidence: CONFIDENCE,
             counterpartyAccountId: null },
  });
  if (proposals.length === 0 && done === APPROVED.length) {
    console.log(`  Nothing to do — both rows are already applied, counterparty still null.`);
    console.log(`  Idempotent and complete.\n`);
    return;
  }

  // ── Gates ────────────────────────────────────────────────────────────────
  const ids = proposals.map((p) => p.t.id).sort();
  const approved = [...APPROVED].sort();
  const same = ids.length === approved.length && ids.every((x, k) => x === approved[k]);

  console.log(`  proposals: ${proposals.length} (approved ${APPROVED.length})`);
  console.log(`  set matches the approval exactly: ${same ? "✓" : "✗"}`);
  if (!same) {
    console.error(`\n  ABORT — derived ${JSON.stringify(ids)} ≠ approved ${JSON.stringify(approved)}.\n`);
    process.exit(1);
  }
  if (vetoedSeen) { console.error(`\n  ABORT — the vetoed ATM row changed evidence level.\n`); process.exit(1); }
  for (const { t } of proposals) {
    if (t.counterpartyAccountId != null) { console.error(`  ABORT — ${t.id} already carries a counterparty.`); process.exit(1); }
    if (lifecycleOf(t).state !== "POSTED") { console.error(`  ABORT — ${t.id} is not POSTED.`); process.exit(1); }
  }

  if (!apply) { console.log(`\n  Dry run — nothing written. Re-run with --apply to write.\n`); return; }

  // ONE transaction. `counterpartyAccountId` is absent from `data` by design.
  const written = await db.$transaction(
    proposals.map(({ t }) => db.transaction.update({
      where: { id: t.id },
      data: { flowType: "DEBT_PAYMENT", classificationReason: REASON, classificationConfidence: CONFIDENCE,
              ...foreignFlowOwnershipFields("TRANSFER_AUTHORITY") },
    })),
  );
  console.log(`\n  APPLIED — ${written.length} rows.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
