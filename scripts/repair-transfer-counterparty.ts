/**
 * scripts/repair-transfer-counterparty.ts   (v2.6-L4-REPAIR)
 *
 * The APPROVED seven-row counterparty repair, as a permanent, re-runnable
 * command. DRY-RUN BY DEFAULT — `--apply` is required to write anything.
 *
 *   npx tsx scripts/repair-transfer-counterparty.ts            # dry run
 *   npx tsx scripts/repair-transfer-counterparty.ts --apply    # apply
 *
 * ── What it repairs, and why only this ──────────────────────────────────────
 *
 * Outflows currently stored as `DEBT_PAYMENT` whose opposite leg deterministically
 * and uniquely resolves to an owned SAVINGS account. Plaid's own category decided
 * these at first sight, from the source descriptor alone, while the row was still
 * pending and its counterparty unknown — and "AMERICANEXPRESS" appears in both a
 * real card payment and a transfer to an Amex savings account.
 *
 * The scope is deliberately narrow. The corpus also contains 38 DEBT_PAYMENT rows
 * with NO destination evidence: the honest assessment for those is "unresolved
 * transfer", but that is a DEMOTION of a stored claim on rows nobody has approved
 * touching, so this script does not consider them. It also leaves the 79 rows that
 * correctly resolve to a liability entirely alone.
 *
 * ── The eight admission gates ───────────────────────────────────────────────
 *
 * A row is proposed ONLY when every one of these holds. Any failure aborts the
 * whole run — this repairs seven rows or none, never a subset.
 *
 *   1 deterministic      the pure matcher returns RESOLVED/DETERMINISTIC_UNIQUE
 *   2 unique             the matched legs name exactly ONE counterparty ACCOUNT
 *   3 window             |date gap| ≤ 5 days (the approved evidence-derived bound)
 *   4 opposite direction the legs have opposite signs
 *   5 equal amount       within the canonical half-cent tolerance
 *   6 same owner         both accounts share an ownerUserId
 *   7 destination type   the counterparty is a SAVINGS account
 *   8 no competitor      every qualifying owned leg names the SAME destination
 *                        ACCOUNT (see the note below)
 *
 * ── What it writes ─────────────────────────────────────────────────────────
 *
 *   counterpartyAccountId      null → the matched account
 *   flowType                   DEBT_PAYMENT → TRANSFER
 *   classificationReason       → ACCOUNT_TYPE_CONTEXT
 *   classificationConfidence   → 1.0
 *
 * `flowDirection` is deliberately UNTOUCHED. It is already INTERNAL, and
 * `TRANSFER` + `INTERNAL` is exactly the pair lib/transactions/transaction-facts.ts
 * reads as INTERNAL_TRANSFER — the correct semantic for a transfer between owned
 * accounts, and the one that keeps the row out of income and spending. Changing it
 * would alter cash-flow behaviour nobody approved.
 *
 * `classificationReason` reuses ACCOUNT_TYPE_CONTEXT ("debtSubtype / accountType
 * disambiguated the row"), which is what happened here — the DESTINATION account
 * type disambiguated it. The enum has no dedicated "matured from counterparty"
 * member, and adding one is a schema change this slice is not authorised to make.
 * The audit signature is unambiguous in practice: these are the only rows in the
 * corpus with BOTH that reason and a non-null counterpartyAccountId.
 *
 * NEVER written: amount · date · authorizedAt · settlementState · pending ·
 * deletedAt · balances · snapshots · anything historical.
 *
 * ── Gate 8 is ACCOUNT-level, and that is deliberate ────────────────────────
 *
 * My first draft of this script required exactly ONE qualifying leg, and it
 * rejected two rows the approved analysis had included. Reading them settled it:
 *
 *     source  2025-12-23  −1,000  CHASE COLLEGE
 *     source  2025-12-26  −1,000  CHASE COLLEGE
 *     dest    2025-12-22  +1,000  Amex HYSA
 *     dest    2025-12-24  +1,000  Amex HYSA
 *
 * Two $1,000 transfers, four legs, and within a 5-day window each source matches
 * both destinations. The LEG pairing is genuinely undecidable — nothing in the
 * evidence says which source produced which destination.
 *
 * But the field this script writes is `counterpartyAccountId`, an ACCOUNT. Both
 * candidate legs live in the SAME account, so under EVERY possible leg
 * assignment the written value is identical and correct. A leg-level gate was
 * measuring something this write does not depend on.
 *
 * So gate 8 requires that every qualifying leg resolve to ONE destination
 * account — which is the real "no competing candidate" test for an
 * account-valued field, and is exactly the ambiguity doctrine
 * lib/transactions/RelationshipResolver.ts already documents ("Many legs in ONE
 * account still name a single unambiguous counterparty → RESOLVED"). Legs across
 * MORE THAN ONE account remain a genuine ambiguity and are still refused.
 *
 * This script must therefore never be extended to write a counterparty
 * TRANSACTION id: for these two rows that value is not knowable.
 */

import { db } from "@/lib/db";
// v2.6-OWN-1 — this repair applies the TRANSFER AUTHORITY's verdict, and says so
// on the row. `foreignFlowOwnershipFields` also nulls `classifierVersion`: once
// these columns hold the transfer authority's answer, "the classifier at version
// N produced these" is no longer a true statement about the row. Leaving that
// number behind is precisely what made these repairs look like classifier output
// and put them one `backfill-flowtype --only-version=4 --apply` from reversion.
import { foreignFlowOwnershipFields } from "@/lib/transactions/flow-authority";
import { matchTransferCandidate, type RelationshipTransaction } from "@/lib/transactions/RelationshipResolver";
import { matureClassification, TRANSFER_MATCH_WINDOW_DAYS } from "@/lib/transactions/transfer-maturation";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";

/** The exact number of rows this repair was approved for. */
const APPROVED_ROW_COUNT = 7;
/** Canonical half-cent tolerance — the same the pure matcher uses. */
const AMOUNT_EPSILON = 0.005;
const DAY_MS = 86_400_000;

interface Proposal {
  id: string;
  sourceAccount: string;
  sourceAccountId: string;
  destAccount: string;
  destAccountId: string;
  destType: string;
  amount: number;
  economicDate: string;
  postingDate: string;
  lifecycle: string;
  currentFlowType: string | null;
  proposedFlowType: string;
  proposedMaturity: string;
  existingCounterparty: string | null;
  proposedCounterparty: string;
  matchReason: string;
  uniqueness: string;
  dayGap: number;
  competitors: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`\n[repair-transfer-counterparty] ${apply ? "APPLY" : "DRY RUN"}\n`);

  const accounts = await db.financialAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, institution: true, type: true, ownerUserId: true },
  });
  const acct = new Map(accounts.map((a) => [a.id, a]));

  // Every transfer-shaped leg, once. The candidate pool is the same set the
  // resolver admits — TRANSFER / DEBT_PAYMENT / UNKNOWN / null.
  const legs = await db.transaction.findMany({
    where: {
      deletedAt: null,
      OR: [{ flowType: { in: ["TRANSFER", "DEBT_PAYMENT", "UNKNOWN"] } }, { flowType: null }],
    },
    select: {
      id: true, financialAccountId: true, date: true, authorizedAt: true, amount: true,
      currency: true, flowType: true, flowDirection: true, deletedAt: true,
      counterpartyAccountId: true, pending: true, settlementState: true, merchant: true,
      pfcDetailed: true, pfcPrimary: true,
      plaidTransactionId: true, pendingTransactionRef: true,
    },
  });
  /** Project a row into the pure matcher's shape. Every field is supplied — no
   *  cast, so a change to RelationshipTransaction breaks this at compile time. */
  const rel = (t: (typeof legs)[number]): RelationshipTransaction => ({
    id:                    t.id,
    financialAccountId:    t.financialAccountId,
    plaidTransactionId:    t.plaidTransactionId,
    pendingTransactionRef: t.pendingTransactionRef,
    date:                  t.date,
    amount:                t.amount,
    merchant:              t.merchant,
    pending:               t.pending,
    deletedAt:             t.deletedAt,
    flowType:              t.flowType,
    currency:              t.currency,
    // v2.6-TRUTH-2 — required by the canonical authority: owner scope, lifecycle
    // supersession, movement form (the cash veto).
    ownerUserId:           acct.get(t.financialAccountId ?? "")?.ownerUserId ?? null,
    settlementState:       t.settlementState,
    pfcDetailed:           t.pfcDetailed,
    pfcPrimary:            t.pfcPrimary,
    category: null, counterpartyClass: null, institutionId: null, descriptor: null,
    // Historical repairs, already applied. They matched on POSTING dates and
    // their verdicts are history; feeding the posting date keeps them replayable
    // and byte-identical rather than silently re-deciding on a new chronology.
    economicDate: t.date,
    persistedCounterpartyAccountId: t.counterpartyAccountId ?? null,
  });

  // v2.6-TRUTH-2 — the canonical authority decides from account TYPE; supply it
  // once rather than letting the matcher guess.
  const matchCtx = { accountTypeById: new Map(accounts.map((a) => [a.id, a.type as string])) };

  const byOwner = new Map<string, typeof legs>();
  for (const l of legs) {
    const o = acct.get(l.financialAccountId ?? "")?.ownerUserId ?? "";
    const list = byOwner.get(o) ?? [];
    list.push(l);
    byOwner.set(o, list);
  }

  const proposals: Proposal[] = [];
  const rejected: string[] = [];

  for (const t of legs) {
    if (t.flowType !== "DEBT_PAYMENT") continue;   // scope: stored debt payments
    if (t.amount >= 0) continue;                   // scope: the OUTFLOW leg
    if (t.counterpartyAccountId != null) continue; // a persisted link is higher authority

    const src = acct.get(t.financialAccountId ?? "");
    if (!src?.ownerUserId) continue;
    const pool = (byOwner.get(src.ownerUserId) ?? []).map(rel);

    // Gates 1–6 are exactly what the pure matcher enforces.
    const m = matchTransferCandidate(rel(t), pool, matchCtx);
    if (m.status !== "RESOLVED" || !m.counterpartyAccountId) continue;

    const dest = acct.get(m.counterpartyAccountId);
    if (!dest) continue;
    if (dest.type !== "savings") continue;         // gate 7: scope is savings only

    // Gate 8, verified INDEPENDENTLY of the matcher: enumerate every owned leg
    // that could have matched and require they all name ONE account.
    const qualifying = (byOwner.get(src.ownerUserId) ?? []).filter((c) =>
      c.id !== t.id &&
      c.deletedAt == null &&
      c.financialAccountId !== t.financialAccountId &&
      (c.currency ?? null) === (t.currency ?? null) &&
      Math.sign(c.amount) === -Math.sign(t.amount) &&
      Math.abs(Math.abs(c.amount) - Math.abs(t.amount)) <= AMOUNT_EPSILON &&
      Math.abs(c.date.getTime() - t.date.getTime()) / DAY_MS <= TRANSFER_MATCH_WINDOW_DAYS,
    );
    if (qualifying.length === 0) {
      rejected.push(`${t.id} — no qualifying leg on independent enumeration`);
      continue;
    }
    const qualifyingAccounts = new Set(qualifying.map((c) => c.financialAccountId));
    if (qualifyingAccounts.size !== 1) {
      rejected.push(
        `${t.id} — qualifying legs span ${qualifyingAccounts.size} accounts: a genuine ambiguity, refused`,
      );
      continue;
    }
    if (!qualifyingAccounts.has(m.counterpartyAccountId)) {
      rejected.push(`${t.id} — independent enumeration disagrees with the matcher`);
      continue;
    }
    // Nearest leg, for reporting the gap only — never for choosing the account.
    const winner = [...qualifying].sort(
      (a, b) => Math.abs(a.date.getTime() - t.date.getTime()) - Math.abs(b.date.getTime() - t.date.getTime()),
    )[0];

    const mat = matureClassification({
      flowType: t.flowType,
      amount: t.amount,
      counterparty: { accountId: dest.id, accountType: dest.type, evidence: "MATCHED_LEG" },
    });
    if (mat.maturity !== "SAVINGS_TRANSFER" || !mat.persistable) {
      rejected.push(`${t.id} — matured to ${mat.maturity}, not the approved SAVINGS_TRANSFER`);
      continue;
    }

    const econ = resolveEconomicDate({ postingDate: t.date, authorizedAt: t.authorizedAt });
    const lc = resolveLifecycle({
      settlementState: t.settlementState, pending: t.pending, deletedAt: t.deletedAt,
    });

    proposals.push({
      id: t.id,
      sourceAccount: `${src.institution}/${src.name}`,
      sourceAccountId: src.id,
      destAccount: `${dest.institution}/${dest.name}`,
      destAccountId: dest.id,
      destType: dest.type,
      amount: t.amount,
      economicDate: econ.economicDate,
      postingDate: econ.postingDate,
      lifecycle: lc.state,
      currentFlowType: t.flowType,
      proposedFlowType: "TRANSFER",
      proposedMaturity: mat.maturity,
      existingCounterparty: t.counterpartyAccountId,
      proposedCounterparty: dest.id,
      matchReason: m.reason,
      uniqueness: qualifying.length === 1
        ? `1 qualifying leg (${winner.id.slice(0, 10)}, ${winner.amount})`
        : `${qualifying.length} qualifying legs, ALL in one account (${qualifying.map((c) => c.id.slice(0, 10)).join(", ")})`,
      dayGap: Math.round(Math.abs(winner.date.getTime() - t.date.getTime()) / DAY_MS),
      competitors: qualifying.length === 1
        ? "none — exactly one owned leg qualifies on amount, sign, currency and window"
        : "none for the ACCOUNT — every qualifying leg is in the same destination account, so the written value is identical under any leg assignment",
    });
  }

  // ── Report ───────────────────────────────────────────────────────────────
  proposals.sort((a, b) => a.postingDate.localeCompare(b.postingDate));
  for (const p of proposals) {
    console.log(`  ${p.id}`);
    console.log(`    source          ${p.sourceAccount}  (${p.sourceAccountId})`);
    console.log(`    destination     ${p.destAccount}  (${p.destAccountId})  type=${p.destType}`);
    console.log(`    amount          ${p.amount.toFixed(2)}`);
    console.log(`    economic date   ${p.economicDate}     posting date ${p.postingDate}     lifecycle ${p.lifecycle}`);
    console.log(`    flowType        ${p.currentFlowType} → ${p.proposedFlowType}   (maturity ${p.proposedMaturity})`);
    console.log(`    counterparty    ${p.existingCounterparty ?? "null"} → ${p.proposedCounterparty}`);
    console.log(`    match           ${p.matchReason}; ${p.uniqueness}; gap ${p.dayGap}d (≤ ${TRANSFER_MATCH_WINDOW_DAYS})`);
    console.log(`    competitors     ${p.competitors}`);
    console.log("");
  }
  if (rejected.length) {
    console.log("  REJECTED (not proposed):");
    for (const r of rejected) console.log(`    ${r}`);
    console.log("");
  }
  console.log(`  proposals: ${proposals.length} (approved: ${APPROVED_ROW_COUNT})`);

  // Already applied? Recognise it explicitly. A repair command that errors on a
  // second run trains an operator to ignore its exit code; one that says "done,
  // nothing to do" stays trustworthy and safe to re-run.
  const alreadyRepaired = await db.transaction.count({
    where: {
      deletedAt: null,
      flowType: "TRANSFER",
      classificationReason: "ACCOUNT_TYPE_CONTEXT",
      counterpartyAccountId: { not: null },
      counterpartyAccount: { type: "savings" },
    },
  });
  if (proposals.length === 0 && alreadyRepaired === APPROVED_ROW_COUNT) {
    console.log(
      `\n  Nothing to do — all ${APPROVED_ROW_COUNT} rows already carry their counterparty` +
      `\n  and matured classification. The repair is idempotent and complete.\n`,
    );
    return;
  }

  if (proposals.length !== APPROVED_ROW_COUNT) {
    console.error(
      `\n  ABORT — the approved repair covers exactly ${APPROVED_ROW_COUNT} rows and this run found ${proposals.length}.` +
      `\n  The evidence has changed since approval; re-approve before applying.\n`,
    );
    process.exit(1);
  }

  if (!apply) {
    console.log("\n  Dry run — nothing written. Re-run with --apply to write.\n");
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  // One transaction, so seven rows land together or none do.
  const written = await db.$transaction(
    proposals.map((p) =>
      db.transaction.update({
        where: { id: p.id },
        data: {
          counterpartyAccountId:    p.proposedCounterparty,
          flowType:                 "TRANSFER",
          classificationReason:     "ACCOUNT_TYPE_CONTEXT",
          classificationConfidence: 1.0,
          ...foreignFlowOwnershipFields("TRANSFER_AUTHORITY"),
          // amount, date, authorizedAt, settlementState, pending, deletedAt and
          // flowDirection are deliberately absent — see the header.
        },
      }),
    ),
  );
  console.log(`\n  APPLIED — ${written.length} rows updated.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
