/**
 * scripts/audit-transfer-authority.ts
 *
 * The canonical Transfer Resolution Authority — FULL-CORPUS CENSUS + REPAIR DRY RUN.
 *
 * READ-ONLY. Every query is a SELECT. It proposes; it never applies. There is no
 * `--apply` flag and adding one is a separate, separately-approved act.
 *
 * Run:  npx tsx --env-file=.env.local scripts/audit-transfer-authority.ts
 *
 * Reports:
 *   1. ADMISSION — before/after candidate population, every exclusion named
 *   2. RESOLUTION — the evidence ladder, tier by tier
 *   3. UNRESOLVED — by explicit reason; never a generic bucket
 *   4. COUNTERPARTY — deterministic improvement vs the persisted column
 *   5. PROVIDER VALUE — structural-only vs identifier-assisted, per institution
 *   6. REPAIR PROPOSAL — counterparty writes and reclassifications, unapplied
 *   7. FINGERPRINTS — corpus digests, so a later run can prove nothing changed
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import {
  admitTransferCandidate, ADMISSION_LABEL, type TransferAdmission,
} from "@/lib/transactions/transfer-admission";
import {
  resolveDestinationEvidenceFor, maturityForEvidence, impliedFlowType,
  isUnresolvedMaturity, MATURITY_LABEL, UNRESOLVED_REASON_LABEL,
  isTransferPrefilterCandidate,
  type TransferLeg, type TransferMaturity, type DestinationEvidenceLevel,
  type TransferUnresolvedReason,
} from "@/lib/transactions/transfer-maturation";
import { extractProviderLinks, institutionsWithCorrelationExtractors } from "@/lib/transactions/provider-link-extract";
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";

const money = (n: number) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const pct = (n: number, d: number) => d === 0 ? "0.0%" : `${((100 * n) / d).toFixed(1)}%`;
const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

type Tally = Map<string, { n: number; amt: number }>;
const add = (t: Tally, k: string, amt: number) => {
  const c = t.get(k) ?? { n: 0, amt: 0 };
  c.n++; c.amt += Math.abs(amt); t.set(k, c);
};
const dump = (t: Tally, total: number) => {
  for (const [k, v] of [...t.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(v.n).padStart(5)}  ${pct(v.n, total).padStart(6)}  ${money(v.amt).padStart(14)}  ${k}`);
  }
};

async function main() {
  const accounts = await db.financialAccount.findMany({
    select: {
      id: true, name: true, type: true, institution: true, institutionId: true,
      mask: true, ownerUserId: true, ownerSpaceId: true, currency: true,
      plaidAccountId: true, walletAddress: true, deletedAt: true,
    },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));

  const txs = await db.transaction.findMany({
    where: { deletedAt: null },
    select: {
      id: true, financialAccountId: true, date: true, amount: true, merchant: true,
      description: true, category: true, pending: true, settlementState: true,
      flowType: true, classifierVersion: true, counterpartyAccountId: true,
      economicDate: true,
      counterpartyType: true, pfcPrimary: true, pfcDetailed: true, currency: true,
      transferRail: true, transferMovementForm: true, transferVenueClass: true,
      deletedAt: true,
    },
  });

  type Row = (typeof txs)[number] & { acct: NonNullable<ReturnType<typeof A.get>> };
  const rows: Row[] = txs
    .filter((t) => t.financialAccountId && A.has(t.financialAccountId))
    .map((t) => ({ ...t, acct: A.get(t.financialAccountId!)! }));
  const ownerOf = (r: Row) => r.acct.ownerUserId ?? r.acct.ownerSpaceId ?? "?";

  // Per-owner mask index — never global. Two users may share a mask harmlessly.
  const maskByOwner = new Map<string, Map<string, string[]>>();
  for (const a of accounts) {
    if (!a.mask) continue;
    const o = a.ownerUserId ?? a.ownerSpaceId ?? "?";
    const m = maskByOwner.get(o) ?? maskByOwner.set(o, new Map()).get(o)!;
    (m.get(a.mask) ?? m.set(a.mask, []).get(a.mask)!).push(a.id);
  }

  const evidenceOf = (r: Row) =>
    plaidTransferEvidence({ pfcDetailed: r.pfcDetailed, amount: r.amount, name: r.merchant });

  const admissionOf = (r: Row): TransferAdmission => {
    const e = evidenceOf(r);
    return admitTransferCandidate({
      flowType: r.flowType, amount: r.amount, accountType: r.acct.type,
      accountId: r.financialAccountId, category: r.category,
      providerFamily: r.pfcPrimary,
      movementForm: e.movementForm ?? null,
      railType: e.railType ?? null,
      venueClass: e.venueClass ?? null,
    });
  };

  // ══ 1. ADMISSION ═════════════════════════════════════════════════════════
  bar("1. ADMISSION — the canonical transfer candidate population");

  const beforeCandidates = rows.filter((r) => isTransferPrefilterCandidate(r.flowType));
  const admission = new Map<string, TransferAdmission>();
  for (const r of rows) admission.set(r.id, admissionOf(r));
  const admitted = rows.filter((r) => admission.get(r.id) === "ADMITTED");

  console.log(`  active transactions            ${rows.length}`);
  console.log(`  BEFORE — prefilter candidates  ${beforeCandidates.length}`);
  console.log(`  AFTER  — admitted candidates   ${admitted.length}   (${beforeCandidates.length - admitted.length} removed)`);
  console.log(`\n  every excluded row, under exactly one reason:`);
  const exclusions: Tally = new Map();
  for (const r of beforeCandidates) {
    const a = admission.get(r.id)!;
    if (a === "ADMITTED") continue;
    add(exclusions, `${a} — ${ADMISSION_LABEL[a]}`, r.amount);
  }
  dump(exclusions, beforeCandidates.length);
  const excludedTotal = [...exclusions.values()].reduce((s, v) => s + v.n, 0);
  console.log(`  ${String(excludedTotal).padStart(5)}          ${" ".repeat(14)}  TOTAL EXCLUDED`);
  console.log(admitted.length + excludedTotal === beforeCandidates.length
    ? "  ✓ every prefiltered row is accounted for exactly once"
    : "  ✗ CENSUS DOES NOT BALANCE");

  // The backlog is reported, never silently dropped.
  const backlog = beforeCandidates.filter((r) => admission.get(r.id) === "NOT_CLASSIFIED");
  const backlogByAccount: Tally = new Map();
  for (const r of backlog) add(backlogByAccount, `${r.acct.institution} (${r.acct.type})`, r.amount);
  console.log(`\n  CLASSIFICATION BACKLOG — ${backlog.length} rows awaiting a classifier:`);
  dump(backlogByAccount, backlog.length);

  // ══ 2. RESOLUTION ════════════════════════════════════════════════════════
  bar("2. RESOLUTION — the evidence ladder");

  // Legs are built PER OWNER: the ownership boundary is a precondition, not a rule.
  const byOwner = new Map<string, Row[]>();
  for (const r of admitted) (byOwner.get(ownerOf(r)) ?? byOwner.set(ownerOf(r), []).get(ownerOf(r))!).push(r);

  type Assessed = {
    row: Row; level: DestinationEvidenceLevel; maturity: TransferMaturity;
    accountId: string | null; legId: string | null; persistable: boolean;
    unresolvedReason: TransferUnresolvedReason | null; usedIdentifier: boolean;
  };
  const assess = (pool: Row[], withIdentifiers: boolean): Assessed[] => {
    const masks = maskByOwner.get(ownerOf(pool[0])) ?? new Map<string, string[]>();
    const legs: TransferLeg[] = pool.map((r) => {
      const links = withIdentifiers
        ? extractProviderLinks(`${r.merchant} ${r.description ?? ""}`, {
            institutionId: r.acct.institutionId,
            maskToAccountIds: masks,
            selfAccountId: r.acct.id,
          })
        : { correlation: null, maskedAccountId: null, maskAmbiguous: false };
      const lc = resolveLifecycle({
        settlementState: r.settlementState, pending: r.pending, deletedAt: r.deletedAt,
        hasLivePostedSuccessor: false,
      });
      return {
        id: r.id, accountId: r.acct.id, accountType: r.acct.type as string,
        ownerId: ownerOf(r), amount: r.amount, currency: r.currency ?? r.acct.currency,
        // L8-B — the ECONOMIC chronology, matching what the read boundary
        // (RelationshipResolver.toTransferLeg) does. An audit on the posting
        // basis would certify an authority production no longer runs.
        dateMs: (r.economicDate ?? r.date).getTime(), superseded: lc.superseded,
        movementForm: evidenceOf(r).movementForm ?? null,
        railType: evidenceOf(r).railType ?? null,
        providerLinkKey: links.correlation?.linkKey ?? null,
        maskedDestinationAccountId: links.maskedAccountId,
      };
    });
    const byId = new Map(pool.map((r) => [r.id, r]));
    return legs.map((l) => {
      const r = byId.get(l.id)!;
      const e = resolveDestinationEvidenceFor(l, legs);
      const ev = evidenceOf(r);
      const m = maturityForEvidence(e, {
        accountType: r.acct.type, amount: r.amount,
        providerFamily: r.pfcPrimary, persistedCounterpartyAccountId: r.counterpartyAccountId,
        railType: ev.railType ?? null, venueClass: ev.venueClass ?? null,
        counterpartyClass: r.counterpartyType,
      });
      return {
        row: r, level: e.level, maturity: m, accountId: e.accountId, legId: e.legId,
        persistable: e.persistableCounterparty,
        unresolvedReason: isUnresolvedMaturity(m)
          ? (e.unresolvedReason ?? (m === "UNRESOLVED_LIABILITY_INFLOW"
              ? "LIABILITY_INFLOW_UNATTESTED" : "NO_COUNTERPART_EVIDENCE"))
          : null,
        usedIdentifier: l.providerLinkKey != null || l.maskedDestinationAccountId != null,
      };
    });
  };

  const all: Assessed[] = [];
  const structuralOnly: Assessed[] = [];
  for (const pool of byOwner.values()) {
    if (pool.length === 0) continue;
    all.push(...assess(pool, true));
    structuralOnly.push(...assess(pool, false));
  }

  const levels: Tally = new Map();
  for (const a of all) add(levels, a.level, a.row.amount);
  console.log(`  evidence level over ${all.length} admitted legs:`);
  dump(levels, all.length);

  const maturities: Tally = new Map();
  for (const a of all) add(maturities, `${a.maturity} — ${MATURITY_LABEL[a.maturity]}`, a.row.amount);
  console.log(`\n  canonical maturity:`);
  dump(maturities, all.length);

  const persistable = all.filter((a) => a.persistable).length;
  const terminal = all.filter((a) => !isUnresolvedMaturity(a.maturity) && !a.persistable).length;
  const unresolved = all.filter((a) => isUnresolvedMaturity(a.maturity));
  console.log(`\n  ⇒ counterparty PERSISTABLE  ${persistable}  (${pct(persistable, all.length)})`);
  console.log(`  ⇒ TERMINAL, no account      ${terminal}  (${pct(terminal, all.length)})`);
  console.log(`  ⇒ UNRESOLVED                ${unresolved.length}  (${pct(unresolved.length, all.length)})`);

  // ══ 2b. REGRESSION GUARDS ════════════════════════════════════════════════
  //
  // ⚠️ A falling failure count is NOT evidence of success. This repository has
  // shipped a FALSE PASS before — an audit whose `select` silently omitted
  // `pfcPrimary`, so everything resolved UNDETERMINED and the disagreements
  // "cleared" for entirely the wrong reason. These guards check that the
  // EXPECTED buckets are populated, not merely that the bad one emptied.
  bar("2b. REGRESSION GUARDS — what must NOT have changed");

  const storedDebtPayments = admitted.filter((r) => r.flowType === "DEBT_PAYMENT");
  const byIdAll = new Map(all.map((a) => [a.row.id, a]));
  const lostDebt = storedDebtPayments.filter((r) => byIdAll.get(r.id)?.maturity !== "DEBT_PAYMENT");
  console.log(`  stored DEBT_PAYMENT rows admitted          ${storedDebtPayments.length}`);
  console.log(`  ...still maturing to DEBT_PAYMENT          ${storedDebtPayments.length - lostDebt.length}`);
  console.log(lostDebt.length === 0
    ? `  ✓ no stored debt payment lost its classification`
    : `  ✗ ${lostDebt.length} stored DEBT_PAYMENT rows changed — REVIEW`);
  for (const r of lostDebt.slice(0, 10)) {
    console.log(`      ${r.id} → ${byIdAll.get(r.id)?.maturity} (${byIdAll.get(r.id)?.level})`);
  }

  // The V27-TRUTH-3 population: where did the issuer credits go?
  const liabilityInflows = rows.filter((r) => r.acct.type === "debt" && r.amount > 0);
  const inflowFate: Tally = new Map();
  for (const r of liabilityInflows) {
    const a = byIdAll.get(r.id);
    add(inflowFate, a ? a.maturity : `EXCLUDED: ${admission.get(r.id)}`, r.amount);
  }
  console.log(`\n  liability INFLOWS (the issuer-credit population), ${liabilityInflows.length} rows:`);
  dump(inflowFate, liabilityInflows.length);
  const excludedInflows = liabilityInflows.filter((r) => admission.get(r.id) !== "ADMITTED");
  if (excludedInflows.length) {
    console.log(`  the ${excludedInflows.length} EXCLUDED inflows — these were ISSUER_CREDIT under the old ladder,`);
    console.log(`  which made no flowType claim either (impliedFlowType returned null). Excluding them at`);
    console.log(`  admission says the same thing one step earlier: not this authority's business.`);
    for (const r of excludedInflows.slice(0, 10)) {
      console.log(`      ${r.date.toISOString().slice(0, 10)} ${r.amount.toFixed(2).padStart(9)} ` +
        `flowType=${r.flowType} pfc=${r.pfcPrimary} · ${JSON.stringify(r.merchant).slice(0, 42)}`);
    }
  }

  // No admitted row may carry a leg id at a level that forbids one.
  const legLeak = all.filter((a) =>
    a.legId !== null && a.level !== "ACCOUNT_CERTAIN" && a.level !== "PROVIDER_LINKED");
  console.log(`\n  rows carrying a leg id at a level that forbids one: ${legLeak.length}` +
    (legLeak.length ? "  ✗ FABRICATION" : "  ✓"));
  const acctLeak = all.filter((a) => a.accountId !== null && !a.persistable);
  console.log(`  rows carrying an account id without persistability:  ${acctLeak.length}` +
    (acctLeak.length ? "  ✗ FABRICATION" : "  ✓"));

  // ══ 3. UNRESOLVED, BY EXPLICIT REASON ════════════════════════════════════
  bar("3. UNRESOLVED — every row under a named limitation");

  const reasons: Tally = new Map();
  for (const a of unresolved) {
    const inst = a.row.acct.institutionId;
    const hasExtractor = inst != null && institutionsWithCorrelationExtractors().includes(inst);
    // The institution dimension turns "insufficient evidence" into the sharper
    // "this institution exposes no identifier", which is an ACTIONABLE fact.
    const key = a.unresolvedReason === "NO_COUNTERPART_EVIDENCE" && !hasExtractor && a.level !== "NO_DESTINATION_EVIDENCE"
      ? "PROVIDER_EVIDENCE_UNAVAILABLE — the institution exposes no identifier"
      : `${a.unresolvedReason} — ${UNRESOLVED_REASON_LABEL[a.unresolvedReason!]}`;
    add(reasons, key, a.row.amount);
  }
  dump(reasons, unresolved.length);
  console.log(unresolved.every((a) => a.unresolvedReason !== null)
    ? `  ✓ no generic bucket — every unresolved row carries a specific limitation`
    : `  ✗ some rows are unresolved with no reason`);

  for (const a of unresolved.slice(0, 12)) {
    console.log(`      ${a.row.date.toISOString().slice(0, 10)} ${a.row.amount.toFixed(2).padStart(11)} ` +
      `${a.row.acct.type.padEnd(10)} ${a.unresolvedReason} · ${JSON.stringify(a.row.merchant).slice(0, 44)}`);
  }

  // ══ 4. DETERMINISTIC COUNTERPARTY IMPROVEMENT ════════════════════════════
  bar("4. COUNTERPARTY — deterministic improvement over the persisted column");

  const persistedNow = admitted.filter((r) => r.counterpartyAccountId != null).length;
  const resolvable = all.filter((a) => a.persistable && a.accountId);
  const newWrites = resolvable.filter((a) => a.row.counterpartyAccountId == null);
  const agree = resolvable.filter((a) => a.row.counterpartyAccountId === a.accountId);
  const conflict = resolvable.filter(
    (a) => a.row.counterpartyAccountId != null && a.row.counterpartyAccountId !== a.accountId);
  console.log(`  persisted today                        ${persistedNow}`);
  console.log(`  authority can establish an account      ${resolvable.length}  (${pct(resolvable.length, all.length)})`);
  console.log(`    ...agreeing with a persisted value    ${agree.length}`);
  console.log(`    ...NEW (currently null)               ${newWrites.length}`);
  console.log(`    ...CONFLICTING with a persisted value ${conflict.length}${conflict.length ? "  ⚠️ REVIEW BEFORE ANY APPLY" : ""}`);
  for (const c of conflict.slice(0, 10)) {
    console.log(`      ${c.row.id} stored=${c.row.counterpartyAccountId} authority=${c.accountId} level=${c.level}`);
  }
  const legAmbiguous = all.filter((a) => a.level === "ACCOUNT_CERTAIN_LEG_AMBIGUOUS");
  console.log(`\n  of which ACCOUNT_CERTAIN_LEG_AMBIGUOUS: ${legAmbiguous.length} rows, ` +
    `${money(legAmbiguous.reduce((s, a) => s + Math.abs(a.row.amount), 0))}`);
  console.log(`    — the account is a fact, the opposing ROW is unknowable and is never written`);
  console.log(legAmbiguous.every((a) => a.legId === null)
    ? `    ✓ not one of them carries a leg id` : `    ✗ a leg id leaked at this level`);

  // ══ 5. PROVIDER VALUE ════════════════════════════════════════════════════
  bar("5. PROVIDER VALUE — structural-only vs identifier-assisted");

  const sPersist = structuralOnly.filter((a) => a.persistable).length;
  const sUnres = structuralOnly.filter((a) => isUnresolvedMaturity(a.maturity)).length;
  console.log(`  structural only (all identifiers DISABLED)`);
  console.log(`    persistable ${sPersist} (${pct(sPersist, structuralOnly.length)})   unresolved ${sUnres} (${pct(sUnres, structuralOnly.length)})`);
  console.log(`  identifier-assisted`);
  console.log(`    persistable ${persistable} (${pct(persistable, all.length)})   unresolved ${unresolved.length} (${pct(unresolved.length, all.length)})`);
  console.log(`  ⇒ identifiers contribute ${persistable - sPersist} legs; structure contributes the rest.`);

  // Disagreement between the two runs would mean an identifier CHANGED a
  // structural answer rather than only adding to it — the cascade risk, measured.
  const sById = new Map(structuralOnly.map((a) => [a.row.id, a]));
  const contradictions = all.filter((a) => {
    const s = sById.get(a.row.id);
    return s?.accountId && a.accountId && s.accountId !== a.accountId;
  });
  console.log(`  identifier vs structural CONTRADICTIONS: ${contradictions.length}` +
    (contradictions.length ? "  ⚠️ an identifier overrode a structural answer" : "  ✓ identifiers only ADD"));

  console.log(`\n  per institution:`);
  const perInst = new Map<string, { n: number; res: number; corr: number; mask: number }>();
  for (const a of all) {
    const k = `${a.row.acct.institution} (${a.row.acct.institutionId ?? "no id"})`;
    const c = perInst.get(k) ?? { n: 0, res: 0, corr: 0, mask: 0 };
    c.n++;
    if (a.persistable) c.res++;
    const masks = maskByOwner.get(ownerOf(a.row)) ?? new Map<string, string[]>();
    const links = extractProviderLinks(`${a.row.merchant} ${a.row.description ?? ""}`, {
      institutionId: a.row.acct.institutionId, maskToAccountIds: masks, selfAccountId: a.row.acct.id,
    });
    if (links.correlation) c.corr++;
    if (links.maskedAccountId) c.mask++;
    perInst.set(k, c);
  }
  for (const [k, c] of [...perInst.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${k.padEnd(34)} n=${String(c.n).padStart(4)}  corrId=${String(c.corr).padStart(4)} (${pct(c.corr, c.n)})` +
      `  mask=${String(c.mask).padStart(4)} (${pct(c.mask, c.n)})  resolved=${String(c.res).padStart(4)} (${pct(c.res, c.n)})`);
  }
  console.log(`  registered correlation extractors: ${institutionsWithCorrelationExtractors().join(", ") || "(none)"}`);

  // ══ 6. REPAIR PROPOSAL (NOTHING IS APPLIED) ══════════════════════════════
  bar("6. REPAIR PROPOSAL — proposed only; this script applies nothing");

  const reclass = all.filter((a) => {
    const implied = impliedFlowType(a.maturity);
    return implied !== null && (a.row.flowType ?? null) !== implied;
  });
  const reclassTally: Tally = new Map();
  for (const a of reclass) add(reclassTally, `${a.row.flowType ?? "null"} → ${impliedFlowType(a.maturity)}  (${a.maturity})`, a.row.amount);

  console.log(`  A. COUNTERPARTY WRITES     ${newWrites.length} rows (currently null → an established account)`);
  const writeTally: Tally = new Map();
  for (const a of newWrites) add(writeTally, `${a.level} → ${A.get(a.accountId!)!.type}`, a.row.amount);
  dump(writeTally, newWrites.length);

  console.log(`\n  B. FLOWTYPE RECLASSIFICATIONS  ${reclass.length} rows`);
  dump(reclassTally, Math.max(reclass.length, 1));

  const externals = all.filter((a) => a.maturity.startsWith("EXTERNAL_"));
  console.log(`\n  C. EXTERNAL CLASSIFICATIONS  ${externals.length} rows — a NAME change only, no counterparty, no flowType change`);
  const extTally: Tally = new Map();
  for (const a of externals) add(extTally, `${a.maturity} — ${MATURITY_LABEL[a.maturity]}`, a.row.amount);
  dump(extTally, Math.max(externals.length, 1));

  const cash = all.filter((a) => a.maturity === "CASH_MOVEMENT");
  console.log(`\n  D. CASH CLASSIFICATIONS  ${cash.length} rows — terminal, no counterparty, unchanged`);

  console.log(`\n  ⚠️ NOTHING ABOVE HAS BEEN APPLIED. No UPDATE, no INSERT, no DELETE was issued.`);
  console.log(`     Applying any of it is a separate, separately-approved act.`);

  // ══ 7. FINGERPRINTS ══════════════════════════════════════════════════════
  bar("7. FINGERPRINTS — prove a later run changed nothing");

  const fp = (label: string, parts: string[]) => {
    const h = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
    console.log(`  ${label.padEnd(34)} ${h}  (${parts.length} rows)`);
  };
  fp("corpus (all active transactions)", rows.map((r) =>
    `${r.id}|${r.amount}|${r.date.toISOString().slice(0, 10)}|${r.flowType}|${r.counterpartyAccountId}`).sort());
  fp("admitted candidate set", admitted.map((r) => r.id).sort());
  fp("authority verdicts", all.map((a) =>
    `${a.row.id}|${a.level}|${a.maturity}|${a.accountId}|${a.legId}|${a.unresolvedReason}`).sort());
  fp("persisted counterparties", rows
    .filter((r) => r.counterpartyAccountId).map((r) => `${r.id}|${r.counterpartyAccountId}`).sort());

  const counts = {
    transactions: await db.transaction.count(),
    active: await db.transaction.count({ where: { deletedAt: null } }),
    accounts: await db.financialAccount.count(),
    withCounterparty: await db.transaction.count({ where: { counterpartyAccountId: { not: null } } }),
  };
  console.log(`\n  row counts: ${JSON.stringify(counts)}`);
  console.log(`  (identical before and after this run — the script issues SELECTs only)`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
