/**
 * scripts/repair-unearned-debt-payment.ts   (V27-L4-REPAIR-2)
 *
 * The APPROVED 38-row demotion. DRY-RUN BY DEFAULT — `--apply` is required.
 *
 *   npx tsx scripts/repair-unearned-debt-payment.ts            # dry run
 *   npx tsx scripts/repair-unearned-debt-payment.ts --apply    # apply
 *
 * ── What it repairs ─────────────────────────────────────────────────────────
 *
 * Outflows stored as `DEBT_PAYMENT` that the transfer-maturation authority
 * cannot support: no destination account is provable, so nothing earns the
 * "debt payment" leaf. Plaid's category decided them at first sight from the
 * source descriptor alone. The honest answer is the least-specific one — a
 * transfer whose destination is unknown.
 *
 * This is a RETRACTION, not a maturation. See the note on monotonicity below.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * OUTFLOWS only (`amount < 0`). The corpus also holds 15 DEBT_PAYMENT INFLOWS
 * that mature to UNRESOLVED — but those are the CARD-side legs (money arriving
 * at a liability account). A payment landing on a card is a debt payment by the
 * receiving account's own type, which is evidence this repair has no business
 * overriding, and they are outside the approval. They are left alone.
 *
 * The 7 rows repaired by scripts/repair-transfer-counterparty.ts are already
 * TRANSFER and carry a counterparty, so they cannot re-enter this set. The ~80
 * rows that resolve to a liability keep their earned leaf.
 *
 * ── What it writes ─────────────────────────────────────────────────────────
 *
 *   flowType                   DEBT_PAYMENT → TRANSFER
 *   classificationReason       → AMBIGUOUS_UNKNOWN   ("below confidence
 *                                threshold → never forced" — the existing
 *                                vocabulary's canonical honest "we don't know")
 *   classificationConfidence   → 0.2 (the confidence every AMBIGUOUS_UNKNOWN
 *                                row in the corpus already carries)
 *
 * `flowDirection` is PRESERVED at INTERNAL. Only the destination-TYPE leaf was
 * unearned; the direction and internality claims are untouched. It is also what
 * keeps these rows out of income and ordinary spending — `TRANSFER` + `INTERNAL`
 * is exactly the pair lib/transactions/transaction-facts.ts reads as
 * INTERNAL_TRANSFER.
 *
 * `counterpartyAccountId` stays NULL. No counterparty is fabricated.
 *
 * NEVER written: amount · date · authorizedAt · settlementState · pending ·
 * deletedAt · financialAccountId · currency · balances · snapshots.
 *
 * ── Monotonicity vs retraction ─────────────────────────────────────────────
 *
 * `adoptIfMonotonic` says specificity may only rise. That rule governs
 * MATURATION — re-assessing a row as evidence ARRIVES — and it is right there:
 * new evidence should never make the product less certain about something it
 * already established.
 *
 * A repair is the other direction. It asserts that a stored leaf was never
 * earned in the first place, so there is no established certainty to protect —
 * only a claim the evidence never supported. Preserving it "for monotonicity"
 * would use a rule designed to protect knowledge to protect a guess instead.
 *
 * `adoptRetraction` in lib/transactions/transfer-maturation.ts makes that
 * distinction explicit and requires the caller to state that the prior
 * classification was unearned. Monotonicity is unchanged for maturation.
 */

import { db } from "@/lib/db";
import { matchTransferCandidate, type RelationshipTransaction } from "@/lib/transactions/RelationshipResolver";
import {
  matureClassification, adoptRetraction, TRANSFER_MATCH_WINDOW_DAYS,
} from "@/lib/transactions/transfer-maturation";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";

const APPROVED_ROW_COUNT = 38;
const UNRESOLVED_REASON = "AMBIGUOUS_UNKNOWN" as const;
const UNRESOLVED_CONFIDENCE = 0.2;
const AMOUNT_EPSILON = 0.005;
const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");
  console.log(`\n[repair-unearned-debt-payment] ${apply ? "APPLY" : "DRY RUN"}\n`);

  const accounts = await db.financialAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, institution: true, type: true, ownerUserId: true },
  });
  const acct = new Map(accounts.map((a) => [a.id, a]));

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
      classificationReason: true, classificationConfidence: true,
    },
  });
  const rel = (t: (typeof legs)[number]): RelationshipTransaction => ({
    id: t.id, financialAccountId: t.financialAccountId,
    plaidTransactionId: t.plaidTransactionId, pendingTransactionRef: t.pendingTransactionRef,
    date: t.date, amount: t.amount, merchant: t.merchant, pending: t.pending,
    deletedAt: t.deletedAt, flowType: t.flowType, currency: t.currency,
    // V27-TRUTH-2 — required by the canonical authority: owner scope, lifecycle
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

  // V27-TRUTH-2 — the canonical authority decides from account TYPE; supply it
  // once rather than letting the matcher guess.
  const matchCtx = { accountTypeById: new Map(accounts.map((a) => [a.id, a.type as string])) };

  const byOwner = new Map<string, typeof legs>();
  for (const l of legs) {
    const o = acct.get(l.financialAccountId ?? "")?.ownerUserId ?? "";
    const list = byOwner.get(o) ?? [];
    list.push(l);
    byOwner.set(o, list);
  }

  const proposals: string[] = [];
  const rows: {
    id: string; account: string; amount: number; economicDate: string; postingDate: string;
    lifecycle: string; flowType: string | null; flowDirection: string | null;
    reason: string | null; confidence: number | null; counterparty: string | null;
    resolverResult: string; candidates: string; whyUnproven: string; totalsImpact: string;
  }[] = [];
  const blockers: string[] = [];

  for (const t of legs) {
    if (t.flowType !== "DEBT_PAYMENT") continue;
    if (t.amount >= 0) continue;                     // scope: OUTFLOWS only
    if (t.counterpartyAccountId != null) continue;   // a persisted link is higher authority

    const src = acct.get(t.financialAccountId ?? "");
    if (!src?.ownerUserId) continue;
    const pool = (byOwner.get(src.ownerUserId) ?? []);

    const m = matchTransferCandidate(rel(t), pool.map(rel), matchCtx);
    const cp = m.status === "RESOLVED" && m.counterpartyAccountId ? acct.get(m.counterpartyAccountId) : null;
    const mat = matureClassification({
      flowType: t.flowType, amount: t.amount,
      counterparty: cp ? { accountId: cp.id, accountType: cp.type, evidence: "MATCHED_LEG" } : null,
    });
    if (mat.maturity !== "UNRESOLVED_TRANSFER") continue;

    // ── Stop conditions, checked per row ───────────────────────────────────
    if (cp) { blockers.push(`${t.id} — now resolves to ${cp.type} account ${cp.name}`); continue; }
    if (m.status === "RESOLVED") { blockers.push(`${t.id} — deterministic counterparty appeared`); continue; }

    // Enumerate the candidate destinations that made this ambiguous, so the
    // "why unproven" answer is evidence, not a shrug.
    const qualifying = pool.filter((c) =>
      c.id !== t.id && c.deletedAt == null &&
      c.financialAccountId !== t.financialAccountId &&
      (c.currency ?? null) === (t.currency ?? null) &&
      Math.sign(c.amount) === -Math.sign(t.amount) &&
      Math.abs(Math.abs(c.amount) - Math.abs(t.amount)) <= AMOUNT_EPSILON &&
      Math.abs(c.date.getTime() - t.date.getTime()) / DAY_MS <= TRANSFER_MATCH_WINDOW_DAYS,
    );
    const candAccounts = [...new Set(qualifying.map((c) => c.financialAccountId))]
      .map((id) => acct.get(id ?? ""))
      .filter(Boolean) as { id: string; name: string; type: string }[];

    // ── STOP CONDITION, enforced here rather than only in a report ─────────
    //
    // The approval's own stop list includes "any row now resolves to a liability
    // account" and "any row resolves to a savings/cash/investment account".
    // Neither fires on `matchTransferCandidate` alone, because it answers about
    // the destination ACCOUNT and returns AMBIGUOUS when candidates span more
    // than one. But when every candidate shares ONE TYPE, the destination TYPE
    // is certain even though the account is not — and the TYPE is what decides
    // the classification.
    //
    // Demoting such a row would delete a claim the evidence supports. This is
    // the mirror of the account-level argument in the counterparty repair: there
    // the ACCOUNT was certain across candidate legs; here the TYPE is certain
    // across candidate accounts. Both are cases where ambiguity at one level
    // leaves the level that matters fully determined.
    const candTypes = [...new Set(candAccounts.map((a) => a.type))];
    if (candTypes.length === 1) {
      blockers.push(
        `${t.id} — every candidate destination is ${candTypes[0].toUpperCase()}` +
        ` (${candAccounts.map((a) => a.name).join(", ")}): the destination TYPE is certain` +
        ` even though the account is not, so "${candTypes[0] === "debt" ? "debt payment" : candTypes[0] + " transfer"}"` +
        ` is supported and must not be retracted`,
      );
      continue;
    }

    const whyUnproven =
      candAccounts.length === 0
        ? "no owned leg of equal magnitude and opposite sign exists inside the 5-day window, so no destination is observable at all"
        : `${qualifying.length} qualifying legs span ${candAccounts.length} DIFFERENT accounts (${candAccounts.map((a) => `${a.name}[${a.type}]`).join(", ")}) — the destination is genuinely undecidable, and a leaf chosen from a descriptor would be a guess`;

    const econ = resolveEconomicDate({ postingDate: t.date, authorizedAt: t.authorizedAt });
    const lc = resolveLifecycle({ settlementState: t.settlementState, pending: t.pending, deletedAt: t.deletedAt });

    // The retraction gate — explicit about what it is doing.
    const retraction = adoptRetraction("DEBT_PAYMENT", mat, { priorWasUnearned: true });
    if (!retraction.adopt) { blockers.push(`${t.id} — retraction refused: ${retraction.reason}`); continue; }

    proposals.push(t.id);
    rows.push({
      id: t.id,
      account: `${src.institution}/${src.name}`,
      amount: t.amount,
      economicDate: econ.economicDate,
      postingDate: econ.postingDate,
      lifecycle: lc.state,
      flowType: t.flowType,
      flowDirection: t.flowDirection,
      reason: t.classificationReason,
      confidence: t.classificationConfidence,
      counterparty: t.counterpartyAccountId,
      resolverResult: `${m.status}:${m.reason}`,
      candidates: candAccounts.length === 0 ? "none" : candAccounts.map((a) => `${a.name}[${a.type}]`).join(" | "),
      whyUnproven,
      // TRANSFER + INTERNAL is the INTERNAL_TRANSFER signature: out of debt
      // totals, out of income, out of ordinary spending, visible as a transfer.
      totalsImpact: "leaves DEBT_PAYMENT totals; enters TRANSFER totals; stays out of income and ordinary spending (INTERNAL); Cash Flow net unchanged",
    });
  }

  rows.sort((a, b) => a.postingDate.localeCompare(b.postingDate));
  const byResolver = new Map<string, number>();
  const byAccount = new Map<string, number>();
  const byCandidateShape = new Map<string, number>();
  for (const r of rows) {
    byResolver.set(r.resolverResult, (byResolver.get(r.resolverResult) ?? 0) + 1);
    byAccount.set(r.account, (byAccount.get(r.account) ?? 0) + 1);
    byCandidateShape.set(r.candidates, (byCandidateShape.get(r.candidates) ?? 0) + 1);
  }

  if (verbose) {
    for (const r of rows) {
      console.log(`  ${r.id}`);
      console.log(`    account       ${r.account}   amount ${r.amount.toFixed(2)}`);
      console.log(`    economic ${r.economicDate}  posting ${r.postingDate}  lifecycle ${r.lifecycle}`);
      console.log(`    current       flowType=${r.flowType} flowDirection=${r.flowDirection} reason=${r.reason}/${r.confidence} counterparty=${r.counterparty ?? "null"}`);
      console.log(`    proposed      flowType=TRANSFER flowDirection=${r.flowDirection} (preserved) reason=${UNRESOLVED_REASON}/${UNRESOLVED_CONFIDENCE} counterparty=null`);
      console.log(`    resolver      ${r.resolverResult}`);
      console.log(`    candidates    ${r.candidates}`);
      console.log(`    why unproven  ${r.whyUnproven}`);
      console.log(`    totals        ${r.totalsImpact}`);
      console.log("");
    }
  } else {
    console.log("  (--verbose for the full per-row table)\n");
    console.log("  by source account:");
    for (const [k, n] of [...byAccount].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(34)} ${n}`);
    console.log("\n  by resolver result:");
    for (const [k, n] of byResolver) console.log(`    ${k.padEnd(40)} ${n}`);
    console.log("\n  by candidate-destination shape:");
    for (const [k, n] of [...byCandidateShape].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)} × ${k.slice(0, 96)}`);
    }
    console.log("");
  }

  if (blockers.length) {
    console.log(`  BLOCKERS (${blockers.length}) — these rows must NOT be demoted:`);
    const shape = new Map<string, number>();
    for (const b of blockers) {
      const k = (b.match(/every candidate destination is (\w+)/) ?? [])[1] ?? "other";
      shape.set(k, (shape.get(k) ?? 0) + 1);
    }
    for (const [k, n] of shape) console.log(`    ${String(n).padStart(3)} × every candidate destination is ${k}`);
    console.log("");
    for (const b of blockers.slice(0, 3)) console.log(`    e.g. ${b}`);
    console.log("");
  }
  console.log(`  proposals: ${proposals.length} (approved: ${APPROVED_ROW_COUNT})`);

  const alreadyRepaired = await db.transaction.count({
    where: {
      deletedAt: null, flowType: "TRANSFER", classificationReason: UNRESOLVED_REASON,
      classificationConfidence: UNRESOLVED_CONFIDENCE, counterpartyAccountId: null,
      amount: { lt: 0 },
    },
  });
  if (proposals.length === 0 && alreadyRepaired === APPROVED_ROW_COUNT) {
    console.log(`\n  Nothing to do — all ${APPROVED_ROW_COUNT} rows are already unresolved transfers. Idempotent and complete.\n`);
    return;
  }

  if (proposals.length !== APPROVED_ROW_COUNT || blockers.length > 0) {
    console.error(
      `\n  ABORT — approved for exactly ${APPROVED_ROW_COUNT} rows; this run found ${proposals.length}` +
      `${blockers.length ? ` with ${blockers.length} blocker(s)` : ""}.` +
      `\n  The evidence has changed since approval; re-approve before applying.\n`,
    );
    process.exit(1);
  }

  if (!apply) {
    console.log("\n  Dry run — nothing written. Re-run with --apply to write.\n");
    return;
  }

  const written = await db.$transaction(
    proposals.map((id) =>
      db.transaction.update({
        where: { id },
        data: {
          flowType:                 "TRANSFER",
          classificationReason:     UNRESOLVED_REASON,
          classificationConfidence: UNRESOLVED_CONFIDENCE,
          // flowDirection, counterpartyAccountId, and every immutable field are
          // deliberately absent — see the header.
        },
      }),
    ),
  );
  console.log(`\n  APPLIED — ${written.length} rows demoted to unresolved transfers.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
