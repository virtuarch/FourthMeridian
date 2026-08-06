/**
 * scripts/repair-transfer-authority.ts
 *
 * Apply the canonical Transfer Resolution Authority's proposal to the corpus.
 *
 * DRY-RUN BY DEFAULT. `--apply` is required to write anything, and the write is a
 * SINGLE TRANSACTION: all rows land together or none do.
 *
 * ── What it writes, and nothing else ────────────────────────────────────────
 *
 *   A. counterpartyAccountId  — where the authority reports `persistableCounterparty`
 *   B. flowType (+ reason/confidence) — where `impliedFlowType` disagrees with the
 *      stored column
 *
 * ⚠️ It NEVER writes a leg id. At `ACCOUNT_CERTAIN_LEG_AMBIGUOUS` the destination
 * ACCOUNT is a fact and the opposing ROW is unknowable; there is no column for the
 * latter and there must not be one.
 *
 * ⚠️ A counterparty write does NOT touch `classificationReason`. Those rows are
 * already classified correctly, often by `PLAID_PFC_DETAILED`, and overwriting a
 * true provenance with a generic one would destroy evidence to no purpose.
 *
 * ⚠️ `amount`, `date`, `authorizedAt`, `settlementState`, `pending`, `deletedAt`
 * and `flowDirection` are absent by construction. They are provider facts or
 * lifecycle facts; a classification repair has no business in any of them.
 *
 * ── Pre-flight refusals (each stops the run entirely) ───────────────────────
 *
 *  1. the proposal set differs from the approved 344 / 18
 *  2. any proposed counterparty CONFLICTS with a persisted one
 *  3. any reclassification would CREATE a new classifier desync
 *  4. any reclassification's reason is not ACCOUNT_TYPE_CONTEXT-shaped
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/repair-transfer-authority.ts
 *   npx tsx --env-file=.env.local scripts/repair-transfer-authority.ts --apply
 */

import { db } from "@/lib/db";
// v2.6-OWN-1 — this repair applies the TRANSFER AUTHORITY's verdict, and says so
// on the row. `foreignFlowOwnershipFields` also nulls `classifierVersion`: once
// these columns hold the transfer authority's answer, "the classifier at version
// N produced these" is no longer a true statement about the row. Leaving that
// number behind is precisely what made these repairs look like classifier output
// and put them one `backfill-flowtype --only-version=4 --apply` from reversion.
import { foreignFlowOwnershipFields } from "@/lib/transactions/flow-authority";
import { createHash } from "node:crypto";
import { FlowType, FlowClassificationReason } from "@prisma/client";
import { admitTransferCandidate } from "@/lib/transactions/transfer-admission";
import {
  resolveDestinationEvidenceFor, maturityForEvidence, impliedFlowType,
  type TransferLeg,
} from "@/lib/transactions/transfer-maturation";
import { extractProviderLinks } from "@/lib/transactions/provider-link-extract";
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { classifyFlow } from "@/lib/transactions/flow-classifier";

/**
 * The APPROVED proposal set. Any deviation stops the run.
 *
 * ⚠️ Revised from 344/18 after the cross-authority pre-flight below refused 3 of
 * the original 18. Two were structurally impossible (a payment-app send matched
 * to a credit card) and produced the `legsQualify` payment-app ⊥ liability veto;
 * the third was a legitimate disagreement with the descriptor-blind classifier
 * and survives. Removing the impossible pairings FREED two card legs to find
 * their real funding rows, which is why the counterparty count ROSE.
 */
const APPROVED_COUNTERPARTY_WRITES = 346;
const APPROVED_RECLASSIFICATIONS = 16;

const REASON = FlowClassificationReason.ACCOUNT_TYPE_CONTEXT;
const CONFIDENCE = 1.0;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`\n[repair-transfer-authority] ${apply ? "APPLY" : "DRY RUN"}\n`);

  const accounts = await db.financialAccount.findMany({
    select: {
      id: true, name: true, type: true, institution: true, institutionId: true,
      mask: true, ownerUserId: true, ownerSpaceId: true, currency: true, debtSubtype: true,
    },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));
  const txs = await db.transaction.findMany({
    where: { deletedAt: null },
    select: {
      id: true, financialAccountId: true, date: true, amount: true, merchant: true,
      description: true, category: true, pending: true, settlementState: true,
      flowType: true, flowDirection: true, counterpartyAccountId: true,
      economicDate: true,
      counterpartyType: true, pfcPrimary: true, pfcDetailed: true, currency: true,
      classificationReason: true, classifierVersion: true, deletedAt: true,
    },
  });
  const rows = txs
    .filter((t) => t.financialAccountId && A.has(t.financialAccountId))
    .map((t) => ({ ...t, acct: A.get(t.financialAccountId!)! }));
  const ownerOf = (r: (typeof rows)[number]) => r.acct.ownerUserId ?? r.acct.ownerSpaceId ?? "?";

  const maskByOwner = new Map<string, Map<string, string[]>>();
  for (const a of accounts) {
    if (!a.mask) continue;
    const o = a.ownerUserId ?? a.ownerSpaceId ?? "?";
    const m = maskByOwner.get(o) ?? maskByOwner.set(o, new Map()).get(o)!;
    (m.get(a.mask) ?? m.set(a.mask, []).get(a.mask)!).push(a.id);
  }
  const ev = (r: (typeof rows)[number]) =>
    plaidTransferEvidence({ pfcDetailed: r.pfcDetailed, amount: r.amount, name: r.merchant });

  const admitted = rows.filter((r) => {
    const e = ev(r);
    return admitTransferCandidate({
      flowType: r.flowType, amount: r.amount, accountType: r.acct.type,
      accountId: r.financialAccountId, category: r.category, providerFamily: r.pfcPrimary,
      movementForm: e.movementForm ?? null, railType: e.railType ?? null,
      venueClass: e.venueClass ?? null,
    }) === "ADMITTED";
  });

  // ── Replay the authority, per owner ───────────────────────────────────────
  type Verdict = {
    row: (typeof rows)[number]; level: string; maturity: string;
    accountId: string | null; legId: string | null; persistable: boolean;
  };
  const verdicts: Verdict[] = [];
  const byOwner = new Map<string, typeof admitted>();
  for (const r of admitted) (byOwner.get(ownerOf(r)) ?? byOwner.set(ownerOf(r), []).get(ownerOf(r))!).push(r);

  for (const pool of byOwner.values()) {
    const masks = maskByOwner.get(ownerOf(pool[0])) ?? new Map<string, string[]>();
    const legs: TransferLeg[] = pool.map((r) => {
      const links = extractProviderLinks(`${r.merchant} ${r.description ?? ""}`, {
        institutionId: r.acct.institutionId, maskToAccountIds: masks, selfAccountId: r.acct.id,
      });
      const lc = resolveLifecycle({
        settlementState: r.settlementState, pending: r.pending, deletedAt: r.deletedAt,
        hasLivePostedSuccessor: false,
      });
      return {
        id: r.id, accountId: r.acct.id, accountType: r.acct.type as string, ownerId: ownerOf(r),
        amount: r.amount, currency: r.currency ?? r.acct.currency,
        // L8-B — the ECONOMIC chronology, matching the read boundary.
        dateMs: (r.economicDate ?? r.date).getTime(),
        superseded: lc.superseded, movementForm: ev(r).movementForm ?? null,
        railType: ev(r).railType ?? null,
        providerLinkKey: links.correlation?.linkKey ?? null,
        maskedDestinationAccountId: links.maskedAccountId,
      };
    });
    const byId = new Map(pool.map((r) => [r.id, r]));
    for (const l of legs) {
      const r = byId.get(l.id)!;
      const e = resolveDestinationEvidenceFor(l, legs);
      const x = ev(r);
      verdicts.push({
        row: r, level: e.level,
        maturity: maturityForEvidence(e, {
          accountType: r.acct.type, amount: r.amount, providerFamily: r.pfcPrimary,
          persistedCounterpartyAccountId: r.counterpartyAccountId,
          railType: x.railType ?? null, venueClass: x.venueClass ?? null,
          counterpartyClass: r.counterpartyType,
        }),
        accountId: e.accountId, legId: e.legId, persistable: e.persistableCounterparty,
      });
    }
  }

  // ── The proposal ─────────────────────────────────────────────────────────
  const cpWrites = verdicts.filter(
    (v) => v.persistable && v.accountId && v.row.counterpartyAccountId == null);
  const cpConflicts = verdicts.filter(
    (v) => v.persistable && v.accountId && v.row.counterpartyAccountId != null
      && v.row.counterpartyAccountId !== v.accountId);
  const reclass = verdicts.filter((v) => {
    const i = impliedFlowType(v.maturity as never);
    return i !== null && (v.row.flowType ?? null) !== i;
  });

  console.log(`  admitted candidates          ${admitted.length}`);
  console.log(`  A. counterparty writes       ${cpWrites.length}   (approved ${APPROVED_COUNTERPARTY_WRITES})`);
  console.log(`  B. reclassifications         ${reclass.length}   (approved ${APPROVED_RECLASSIFICATIONS})`);
  console.log(`  conflicting counterparties   ${cpConflicts.length}`);

  // ── Idempotence — nothing left to do is a SUCCESS, not a changed proposal ─
  //
  // Checked BEFORE the approval gate, deliberately. Once applied, the corpus no
  // longer produces the approved counts (the counterparties are persisted and the
  // flowTypes agree), and a gate consulted first would report a "changed
  // proposal" on every subsequent run. Same shape as
  // `repair-transfer-classification.ts`, which learned this the same way.
  if (cpWrites.length === 0 && reclass.length === 0) {
    console.log(`\n  ✓ IDEMPOTENT — nothing to do. The repair is already applied:`);
    console.log(`    every establishable counterparty is persisted, and every`);
    console.log(`    implied flowType already agrees with the stored column.`);
    console.log(`    conflicts: ${cpConflicts.length}\n`);
    if (cpConflicts.length > 0) process.exit(1);
    return;
  }

  // ── Refusal 1 — the proposal set must be EXACTLY as approved ─────────────
  if (cpWrites.length !== APPROVED_COUNTERPARTY_WRITES || reclass.length !== APPROVED_RECLASSIFICATIONS) {
    console.error(
      `\n  ✗ STOP — the proposal set has CHANGED since approval.\n` +
      `    approved: ${APPROVED_COUNTERPARTY_WRITES} counterparty writes, ${APPROVED_RECLASSIFICATIONS} reclassifications\n` +
      `    now:      ${cpWrites.length} counterparty writes, ${reclass.length} reclassifications\n` +
      `    Nothing was written. Re-approve before applying; do NOT partially apply.\n`);
    process.exit(1);
  }
  // ── Refusal 2 — never overwrite a persisted counterparty ─────────────────
  if (cpConflicts.length > 0) {
    console.error(`\n  ✗ STOP — ${cpConflicts.length} proposed counterparties CONFLICT with persisted values.\n`);
    for (const c of cpConflicts.slice(0, 20)) {
      console.error(`    ${c.row.id} stored=${c.row.counterpartyAccountId} authority=${c.accountId} (${c.level})`);
    }
    process.exit(1);
  }

  // ── Refusal 3 — a reclassification must not CREATE a classifier desync ───
  //
  // The transfer authority and `classifyFlow` are different authorities answering
  // overlapping questions. v2.6-TRUTH-3's real bug was found only by comparing two
  // entry points, so this compares them before writing rather than after.
  //
  // ⚠️ The line is DESTINATION EVIDENCE, not agreement.
  //
  // A first draft made ANY classifier disagreement a hard stop, and it caught the
  // two payment-app rows — but it also caught a legitimate one, because it treated
  // `classifyFlow` as authoritative on a question it structurally cannot answer.
  // The classifier is DESCRIPTOR-BLIND and sees only the provider family; it
  // cannot see that a movement landed on a credit card. `audit-flow-desync.ts`
  // documents exactly this in its own header (CF-4, CCPAY-2B): "a category →
  // flowType lookup cannot express context-dependent semantics", and the corpus
  // already carries 2 accepted rows of this class from the approved
  // `repair-type-certain-debt-payment`.
  //
  // So the guard now refuses a reclassification only where the transfer authority
  // has NO destination evidence of its own — which is the fabrication case, and
  // the only one where the classifier's answer is strictly better-founded than
  // ours. Where destination evidence exists, the disagreement is REPORTED (it will
  // surface in `audit:flow-desync`) rather than silently suppressed.
  console.log(`\n  cross-authority check — each reclassification vs classifyFlow:`);
  const agrees: typeof reclass = [], divergent: typeof reclass = [], unfounded: typeof reclass = [];
  const HAS_DESTINATION = new Set([
    "PROVIDER_LINKED", "ACCOUNT_CERTAIN", "ACCOUNT_CERTAIN_LEG_AMBIGUOUS",
    "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS",
  ]);
  for (const v of reclass) {
    const c = classifyFlow({
      category: v.row.category, amount: v.row.amount,
      accountType: v.row.acct.type, debtSubtype: v.row.acct.debtSubtype,
      pfcPrimary: v.row.pfcPrimary, pfcDetailed: v.row.pfcDetailed,
    });
    const target = impliedFlowType(v.maturity as never);
    if (c.flowType === target) agrees.push(v);
    else if (HAS_DESTINATION.has(v.level)) divergent.push(v);
    else unfounded.push(v);
  }
  console.log(`    classifier ALREADY agrees                          : ${agrees.length}`);
  console.log(`    classifier disagrees, destination evidence EXISTS  : ${divergent.length}  (reported, not blocked)`);
  console.log(`    classifier disagrees, NO destination evidence      : ${unfounded.length}`);
  for (const v of divergent) {
    console.log(`      ⓘ ${v.row.date.toISOString().slice(0, 10)} ${v.row.amount.toFixed(2).padStart(10)} ` +
      `[${v.level}] cp=${v.accountId ?? "null"} · ${JSON.stringify(v.row.merchant).slice(0, 42)}`);
    console.log(`        the authority sees the destination TYPE; the descriptor-blind classifier cannot.`);
  }
  if (unfounded.length > 0) {
    console.error(`\n  ✗ STOP — ${unfounded.length} reclassifications contradict the classifier ` +
      `with NO destination evidence to justify it.\n`);
    for (const v of unfounded.slice(0, 20)) {
      console.error(`    ${v.row.id} ${v.row.flowType} → ${impliedFlowType(v.maturity as never)} ` +
        `[${v.level}] cp=${v.accountId} · ${JSON.stringify(v.row.merchant).slice(0, 44)}`);
    }
    process.exit(1);
  }

  // ── Refusal 4 — the reason must be true of every reclassified row ─────────
  const badReason = reclass.filter((v) => v.level !== "ACCOUNT_CERTAIN"
    && v.level !== "PROVIDER_LINKED" && v.level !== "ACCOUNT_CERTAIN_LEG_AMBIGUOUS"
    && v.level !== "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS");
  if (badReason.length > 0) {
    console.error(`\n  ✗ STOP — ${badReason.length} reclassifications rest on no account/type evidence; ` +
      `ACCOUNT_TYPE_CONTEXT would be a false provenance.\n`);
    process.exit(1);
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const byLevel = new Map<string, number>();
  for (const v of cpWrites) byLevel.set(v.level, (byLevel.get(v.level) ?? 0) + 1);
  console.log(`\n  A. counterparty writes by evidence level:`);
  for (const [k, n] of [...byLevel].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${k}`);
  console.log(`     ✓ ${cpWrites.filter((v) => v.level === "ACCOUNT_CERTAIN_LEG_AMBIGUOUS" && v.legId === null).length}` +
    ` leg-ambiguous rows carry NO leg id (a leg is never written at any level)`);

  console.log(`\n  B. reclassifications:`);
  for (const v of reclass) {
    console.log(`     ${v.row.date.toISOString().slice(0, 10)} ${v.row.amount.toFixed(2).padStart(10)} ` +
      `${v.row.flowType}→${impliedFlowType(v.maturity as never)} ${v.level} · ${JSON.stringify(v.row.merchant).slice(0, 44)}`);
  }

  const fp = (label: string, parts: string[]) =>
    console.log(`  ${label.padEnd(30)} ${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)} (${parts.length})`);
  console.log(`\n  proposal fingerprints:`);
  fp("counterparty writes", cpWrites.map((v) => `${v.row.id}|${v.accountId}`).sort());
  fp("reclassifications", reclass.map((v) => `${v.row.id}|${impliedFlowType(v.maturity as never)}`).sort());

  if (!apply) {
    console.log(`\n  Dry run — nothing written. Re-run with --apply to write.\n`);
    return;
  }

  // ── Apply — ONE transaction ──────────────────────────────────────────────
  const reclassIds = new Set(reclass.map((v) => v.row.id));
  const ops = [
    // Counterparty-only writes. Classification and its provenance are untouched.
    ...cpWrites
      .filter((v) => !reclassIds.has(v.row.id))
      .map((v) => db.transaction.update({
        where: { id: v.row.id },
        data: { counterpartyAccountId: v.accountId },
      })),
    // Reclassifications, carrying the counterparty where one was also established.
    ...reclass.map((v) => {
      const cp = cpWrites.find((w) => w.row.id === v.row.id);
      return db.transaction.update({
        where: { id: v.row.id },
        data: {
          flowType: impliedFlowType(v.maturity as never) as FlowType,
          classificationReason: REASON,
          classificationConfidence: CONFIDENCE,
          ...foreignFlowOwnershipFields("TRANSFER_AUTHORITY"),
          ...(cp ? { counterpartyAccountId: cp.accountId } : {}),
        },
      });
    }),
  ];
  const written = await db.$transaction(ops);
  console.log(`\n  APPLIED — ${written.length} rows updated in one transaction.`);
  console.log(`    ${cpWrites.filter((v) => !reclassIds.has(v.row.id)).length} counterparty-only`);
  console.log(`    ${reclass.length} reclassified (of which ${reclass.filter((v) => cpWrites.some((w) => w.row.id === v.row.id)).length} also received a counterparty)\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
