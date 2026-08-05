/**
 * scripts/audit-economic-date-calibration.ts
 *
 * PHASE 2 — recalibrate the transfer authority for `economicDate`. READ-ONLY.
 *
 * Every window in the authority was measured on POSTING dates. This replays the
 * whole corpus on ECONOMIC dates and re-derives them, rather than assuming they
 * survive the change.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-economic-date-calibration.ts
 *
 * Nothing is written. Every query is a SELECT.
 */

import { db } from "@/lib/db";
import { admitTransferCandidate } from "@/lib/transactions/transfer-admission";
import {
  resolveDestinationEvidenceFor, maturityForEvidence, impliedFlowType,
  legsQualify, isUnresolvedMaturity, buildTransferCorpusIndex,
  TRANSFER_MATCH_WINDOW_DAYS, TRANSFER_AMOUNT_EPSILON,
  type TransferLeg, type DestinationEvidenceLevel, type TransferMaturity,
} from "@/lib/transactions/transfer-maturation";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { extractProviderLinks } from "@/lib/transactions/provider-link-extract";
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { CHAIN_CONTINUATION_WINDOW_DAYS } from "@/lib/transactions/transfer-chain";

const DAY = 86_400_000;
const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);
const histLine = (h: Map<number, number>, max = 20) =>
  [...h.entries()].filter(([d]) => d <= max).sort((a, b) => a[0] - b[0])
    .map(([d, c]) => `${d}:${c}`).join(" ");

type Basis = "POSTING" | "ECONOMIC";

async function main() {
  const accounts = await db.financialAccount.findMany({
    select: {
      id: true, name: true, type: true, institution: true, institutionId: true, mask: true,
      ownerUserId: true, ownerSpaceId: true, currency: true,
    },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));
  const txs = await db.transaction.findMany({
    where: { deletedAt: null },
    select: {
      id: true, financialAccountId: true, date: true, authorizedAt: true, amount: true,
      merchant: true, description: true, category: true, pending: true, settlementState: true,
      flowType: true, counterpartyAccountId: true, counterpartyType: true,
      pfcPrimary: true, pfcDetailed: true, currency: true, deletedAt: true,
      plaidTransactionId: true, pendingTransactionRef: true,
    },
  });
  const rows = txs
    .filter((t) => t.financialAccountId && A.has(t.financialAccountId))
    .map((t) => ({ ...t, acct: A.get(t.financialAccountId!)! }));
  const ownerOf = (r: (typeof rows)[number]) => r.acct.ownerUserId ?? r.acct.ownerSpaceId ?? "?";
  const ev = (r: (typeof rows)[number]) =>
    plaidTransferEvidence({ pfcDetailed: r.pfcDetailed, amount: r.amount, name: r.merchant });

  // ── The two chronologies ─────────────────────────────────────────────────
  const econ = new Map<string, ReturnType<typeof resolveEconomicDate>>();
  for (const r of rows) {
    econ.set(r.id, resolveEconomicDate({ postingDate: r.date, authorizedAt: r.authorizedAt }));
  }
  const msOf = (r: (typeof rows)[number], basis: Basis) =>
    basis === "POSTING" ? r.date.getTime() : Date.parse(`${econ.get(r.id)!.economicDate}T00:00:00Z`);

  const maskByOwner = new Map<string, Map<string, string[]>>();
  for (const a of accounts) {
    if (!a.mask) continue;
    const o = a.ownerUserId ?? a.ownerSpaceId ?? "?";
    const m = maskByOwner.get(o) ?? maskByOwner.set(o, new Map()).get(o)!;
    (m.get(a.mask) ?? m.set(a.mask, []).get(a.mask)!).push(a.id);
  }

  const admitted = rows.filter((r) => {
    const e = ev(r);
    return admitTransferCandidate({
      flowType: r.flowType, amount: r.amount, accountType: r.acct.type,
      accountId: r.financialAccountId, category: r.category, providerFamily: r.pfcPrimary,
      movementForm: e.movementForm ?? null, railType: e.railType ?? null,
      venueClass: e.venueClass ?? null,
    }) === "ADMITTED";
  });

  const byOwner = new Map<string, typeof admitted>();
  for (const r of admitted) (byOwner.get(ownerOf(r)) ?? byOwner.set(ownerOf(r), []).get(ownerOf(r))!).push(r);

  /** Build the leg corpus under one chronology. `windowOverride` lets a tier be
   *  measured in isolation without touching the authority's own constant. */
  const buildLegs = (pool: typeof admitted, basis: Basis): TransferLeg[] => {
    const masks = maskByOwner.get(ownerOf(pool[0])) ?? new Map<string, string[]>();
    return pool.map((r) => {
      const links = extractProviderLinks(`${r.merchant} ${r.description ?? ""}`, {
        institutionId: r.acct.institutionId, maskToAccountIds: masks, selfAccountId: r.acct.id,
      });
      const lc = resolveLifecycle({
        settlementState: r.settlementState, pending: r.pending, deletedAt: r.deletedAt,
        hasLivePostedSuccessor: false,
      });
      const x = ev(r);
      return {
        id: r.id, accountId: r.acct.id, accountType: r.acct.type as string, ownerId: ownerOf(r),
        amount: r.amount, currency: r.currency ?? r.acct.currency, dateMs: msOf(r, basis),
        superseded: lc.superseded, movementForm: x.movementForm ?? null,
        railType: x.railType ?? null,
        providerLinkKey: links.correlation?.linkKey ?? null,
        maskedDestinationAccountId: links.maskedAccountId,
      };
    });
  };

  type Verdict = {
    row: (typeof rows)[number]; level: DestinationEvidenceLevel; maturity: TransferMaturity;
    accountId: string | null; legId: string | null; persistable: boolean;
  };
  const replay = (basis: Basis): Map<string, Verdict> => {
    const out = new Map<string, Verdict>();
    for (const pool of byOwner.values()) {
      const legs = buildLegs(pool, basis);
      const byId = new Map(pool.map((r) => [r.id, r]));
      for (const l of legs) {
        const r = byId.get(l.id)!;
        const e = resolveDestinationEvidenceFor(l, legs);
        const x = ev(r);
        out.set(l.id, {
          row: r, level: e.level, accountId: e.accountId, legId: e.legId,
          persistable: e.persistableCounterparty,
          maturity: maturityForEvidence(e, {
            accountType: r.acct.type, amount: r.amount, providerFamily: r.pfcPrimary,
            persistedCounterpartyAccountId: r.counterpartyAccountId,
            railType: x.railType ?? null, venueClass: x.venueClass ?? null,
            counterpartyClass: r.counterpartyType,
          }),
        });
      }
    }
    return out;
  };

  const P = replay("POSTING");
  const E = replay("ECONOMIC");

  // ── 0. Chronology inventory ──────────────────────────────────────────────
  bar("0. CHRONOLOGY INVENTORY — every place transfer reasoning reads a date");
  console.log(`  LEG TIMESTAMP CONSTRUCTORS (all currently r.date = POSTING):`);
  for (const s of [
    "lib/transactions/RelationshipResolver.ts:527   toTransferLeg — THE read boundary",
    "scripts/audit-transfer-authority.ts:165        the census",
    "scripts/repair-transfer-authority.ts:135       the repair",
    "scripts/repair-transfer-classification.ts:133  historical, applied",
    "scripts/repair-type-certain-debt-payment.ts:106 historical, applied",
  ]) console.log(`    · ${s}`);
  console.log(`  WINDOW COMPARISONS (consume leg.dateMs):`);
  for (const s of [
    "transfer-maturation.ts:681   legsQualify              ± TRANSFER_MATCH_WINDOW_DAYS",
    "transfer-maturation.ts:713   legsQualifyIgnoringOwner ± TRANSFER_MATCH_WINDOW_DAYS",
    "transfer-maturation.ts:792   mutualPairsAt            ± tier tolerance (stratification)",
    "transfer-chain.ts:218        continues                ± CHAIN_CONTINUATION_WINDOW_DAYS",
    "transfer-chain.ts:208        hop ordering             deterministic sort",
  ]) console.log(`    · ${s}`);
  console.log(`  CANDIDATE-GATHERING DATE FILTERS (SQL, on Transaction.date):`);
  for (const s of [
    "transfer-resolution.ts:240-254  GATHER_WINDOW_MS = (window + 1) days",
    "lib/data/transactions.ts:556    RELATIONSHIP_WINDOW_MS = 7 days (drawer)",
  ]) console.log(`    · ${s}`);
  console.log(`  ⚠️ The SQL filters are on the STORED posting column and cannot be moved to`);
  console.log(`     economicDate without persistence. They must therefore be WIDENED by the`);
  console.log(`     maximum lag so an economic-date match can never be starved of its leg.`);

  // ── 1. Corpus lag distribution ───────────────────────────────────────────
  bar("1. CORPUS LAG DISTRIBUTION — posting vs economic");

  const basisCount = new Map<string, number>();
  for (const r of admitted) {
    const e = econ.get(r.id)!;
    basisCount.set(`${e.basis}/${e.state}`, (basisCount.get(`${e.basis}/${e.state}`) ?? 0) + 1);
  }
  console.log(`  economic-date basis over ${admitted.length} admitted legs:`);
  for (const [k, v] of [...basisCount].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
  const movers = admitted.filter((r) => econ.get(r.id)!.lagDays > 0).length;
  console.log(`  legs whose economic date DIFFERS from posting: ${movers} (${pct(movers, admitted.length)})`);

  /** Gap histogram over every pair that legsQualify accepts under `basis`. */
  const pairGaps = (basis: Basis, filter?: (a: TransferLeg, b: TransferLeg) => boolean) => {
    const h = new Map<number, number>();
    for (const pool of byOwner.values()) {
      const legs = buildLegs(pool, basis);
      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          const a = legs[i], b = legs[j];
          if (a.accountId === b.accountId) continue;
          if ((a.currency ?? null) !== (b.currency ?? null)) continue;
          if (Math.sign(a.amount) !== -Math.sign(b.amount)) continue;
          if (Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) > TRANSFER_AMOUNT_EPSILON) continue;
          if (filter && !filter(a, b)) continue;
          const d = Math.round(Math.abs(a.dateMs - b.dateMs) / DAY);
          if (d <= 45) h.set(d, (h.get(d) ?? 0) + 1);
        }
      }
    }
    return h;
  };
  console.log(`\n  ALL same-magnitude opposite-sign cross-account pairs (the window's population):`);
  console.log(`    POSTING  ${histLine(pairGaps("POSTING"), 16)}`);
  console.log(`    ECONOMIC ${histLine(pairGaps("ECONOMIC"), 16)}`);

  const typeFilter = (t: string) => (a: TransferLeg, b: TransferLeg) =>
    a.accountType === t || b.accountType === t;
  for (const t of ["savings", "checking", "debt", "investment", "crypto"]) {
    const p = pairGaps("POSTING", typeFilter(t)), e = pairGaps("ECONOMIC", typeFilter(t));
    if ([...p.values()].reduce((s, v) => s + v, 0) === 0) continue;
    console.log(`\n  ${t.toUpperCase()}`);
    console.log(`    POSTING  ${histLine(p, 10)}`);
    console.log(`    ECONOMIC ${histLine(e, 10)}`);
  }
  const instOf = (l: TransferLeg) => A.get(l.accountId)!.institutionId ?? "none";
  for (const [label, f] of [
    ["SAME institution", (a: TransferLeg, b: TransferLeg) => instOf(a) === instOf(b)],
    ["CROSS institution", (a: TransferLeg, b: TransferLeg) => instOf(a) !== instOf(b)],
  ] as const) {
    console.log(`\n  ${label}`);
    console.log(`    POSTING  ${histLine(pairGaps("POSTING", f), 10)}`);
    console.log(`    ECONOMIC ${histLine(pairGaps("ECONOMIC", f), 10)}`);
  }

  // ── 2. Candidate competition ─────────────────────────────────────────────
  bar("2. CANDIDATE COMPETITION — before (posting) vs after (economic)");
  const levelTally = (m: Map<string, Verdict>) => {
    const t = new Map<string, number>();
    for (const v of m.values()) t.set(v.level, (t.get(v.level) ?? 0) + 1);
    return t;
  };
  const lp = levelTally(P), le = levelTally(E);
  const allLevels = [...new Set([...lp.keys(), ...le.keys()])].sort();
  console.log(`  ${"level".padEnd(34)} POSTING  ECONOMIC   Δ`);
  for (const k of allLevels) {
    const a = lp.get(k) ?? 0, b = le.get(k) ?? 0;
    console.log(`  ${k.padEnd(34)} ${String(a).padStart(7)}  ${String(b).padStart(8)}   ${(b - a) >= 0 ? "+" : ""}${b - a}`);
  }
  const matTally = (m: Map<string, Verdict>) => {
    const t = new Map<string, number>();
    for (const v of m.values()) t.set(v.maturity, (t.get(v.maturity) ?? 0) + 1);
    return t;
  };
  const mp = matTally(P), me = matTally(E);
  console.log(`\n  ${"maturity".padEnd(34)} POSTING  ECONOMIC   Δ`);
  for (const k of [...new Set([...mp.keys(), ...me.keys()])].sort()) {
    const a = mp.get(k) ?? 0, b = me.get(k) ?? 0;
    console.log(`  ${k.padEnd(34)} ${String(a).padStart(7)}  ${String(b).padStart(8)}   ${(b - a) >= 0 ? "+" : ""}${b - a}`);
  }
  const persP = [...P.values()].filter((v) => v.persistable).length;
  const persE = [...E.values()].filter((v) => v.persistable).length;
  const unrP = [...P.values()].filter((v) => isUnresolvedMaturity(v.maturity)).length;
  const unrE = [...E.values()].filter((v) => isUnresolvedMaturity(v.maturity)).length;
  console.log(`\n  persistable  POSTING ${persP}  →  ECONOMIC ${persE}   (${persE - persP >= 0 ? "+" : ""}${persE - persP})`);
  console.log(`  unresolved   POSTING ${unrP}  →  ECONOMIC ${unrE}   (${unrE - unrP >= 0 ? "+" : ""}${unrE - unrP})`);

  // ── 3. Tier effectiveness ────────────────────────────────────────────────
  bar("3. TIER EFFECTIVENESS — measured independently, against provider ground truth");

  // Ground truth: the correlation-id pairs. Provider-issued, never inferred.
  const truth = new Map<string, string>();
  {
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const m = `${r.merchant} ${r.description ?? ""}`.match(/transaction#:\s*(\d{6,})/i);
      if (m) (groups.get(m[1]) ?? groups.set(m[1], []).get(m[1])!).push(r);
    }
    for (const v of groups.values()) {
      if (v.length === 2 && v[0].financialAccountId !== v[1].financialAccountId) {
        truth.set(v[0].id, v[1].id); truth.set(v[1].id, v[0].id);
      }
    }
  }
  console.log(`  ground truth: ${truth.size} legs (${truth.size / 2} provider-asserted movements)\n`);

  /** Mutual-uniqueness matching at ONE tolerance, ignoring identifiers, so a tier
   *  is measured for what IT contributes rather than what the ladder above it did. */
  const tierOnly = (basis: Basis, days: number) => {
    const claims = new Map<string, string>();
    for (const pool of byOwner.values()) {
      const legs = buildLegs(pool, basis).map((l) => ({ ...l, providerLinkKey: null, maskedDestinationAccountId: null }));
      const fwd = new Map<string, string[]>();
      for (const a of legs) for (const b of legs) {
        if (!legsQualify(a, b)) continue;
        if (Math.abs(a.dateMs - b.dateMs) / DAY > days) continue;
        (fwd.get(a.id) ?? fwd.set(a.id, []).get(a.id)!).push(b.id);
      }
      for (const [a, bs] of fwd) {
        if (bs.length !== 1) continue;
        const back = fwd.get(bs[0]) ?? [];
        if (back.length === 1 && back[0] === a) claims.set(a, bs[0]);
      }
    }
    return claims;
  };
  const score = (label: string, claims: Map<string, string>) => {
    let ok = 0, wrong = 0, abstain = 0;
    for (const [k, want] of truth) {
      const got = claims.get(k);
      if (!got) abstain++;
      else if (got === want) ok++;
      else wrong++;
    }
    const outside = [...claims.keys()].filter((k) => !truth.has(k)).length;
    const prec = ok + wrong === 0 ? "—" : `${((100 * ok) / (ok + wrong)).toFixed(1)}%`;
    console.log(`    ${label.padEnd(26)} coverage=${String(claims.size).padStart(4)}  correct=${String(ok).padStart(3)}  WRONG=${String(wrong).padStart(2)}  abstain=${String(abstain).padStart(3)}  precision=${prec}  recall=${pct(ok, truth.size)}  (+${outside} outside truth)`);
    return { ok, wrong };
  };
  for (const basis of ["POSTING", "ECONOMIC"] as Basis[]) {
    console.log(`  ${basis} — single tier, structural only:`);
    for (const d of [0, 1, 2, 3, 5, 7, 10, 14]) score(`±${d}d mutual`, tierOnly(basis, d));
  }

  /** Stratified: tighten-then-widen, each tier on the survivors. */
  const stratified = (basis: Basis, tiers: number[]) => {
    const claims = new Map<string, string>();
    for (const pool of byOwner.values()) {
      let legs = buildLegs(pool, basis).map((l) => ({ ...l, providerLinkKey: null, maskedDestinationAccountId: null }));
      for (const d of tiers) {
        const live = legs.filter((l) => !claims.has(l.id));
        const fwd = new Map<string, string[]>();
        for (const a of live) for (const b of live) {
          if (!legsQualify(a, b)) continue;
          if (Math.abs(a.dateMs - b.dateMs) / DAY > d) continue;
          (fwd.get(a.id) ?? fwd.set(a.id, []).get(a.id)!).push(b.id);
        }
        for (const [a, bs] of fwd) {
          if (bs.length !== 1) continue;
          const back = fwd.get(bs[0]) ?? [];
          if (back.length === 1 && back[0] === a) claims.set(a, bs[0]);
        }
      }
    }
    return claims;
  };
  console.log(`\n  STRATIFIED (the shipped shape and its neighbours):`);
  for (const basis of ["POSTING", "ECONOMIC"] as Basis[]) {
    console.log(`  ${basis}:`);
    for (const tiers of [[0, 5], [0, 3], [0, 7], [0, 2, 5], [0, 1, 2, 3, 5], [0, 10]]) {
      score(`tiers [${tiers.join(",")}]`, stratified(basis, tiers));
    }
  }

  // ── 4. Validate Phase 1 under economicDate ───────────────────────────────
  bar("4. PHASE-1 VALIDATION — does the APPLIED state survive economicDate?");
  const persisted = rows.filter((r) => r.counterpartyAccountId != null);
  console.log(`  persisted counterparties in the database: ${persisted.length}`);
  const lostCp: string[] = [], changedCp: string[] = [], weakerCp: string[] = [];
  const RANK: Record<string, number> = {
    PROVIDER_LINKED: 4, ACCOUNT_CERTAIN: 3, ACCOUNT_CERTAIN_LEG_AMBIGUOUS: 2,
    TYPE_CERTAIN_ACCOUNT_AMBIGUOUS: 1, TYPE_AMBIGUOUS: 0, NO_DESTINATION_EVIDENCE: 0,
    CASH_NO_COUNTERPARTY: 0,
  };
  for (const r of persisted) {
    const e = E.get(r.id), p = P.get(r.id);
    if (!e) { lostCp.push(`${r.id} NOT ADMITTED under economic replay`); continue; }
    if (!e.persistable || !e.accountId) {
      lostCp.push(`${r.id} [${p?.level} → ${e.level}] persisted=${r.counterpartyAccountId} now unsupported`);
      continue;
    }
    if (e.accountId !== r.counterpartyAccountId) {
      changedCp.push(`${r.id} persisted=${r.counterpartyAccountId} economic=${e.accountId} [${e.level}]`);
      continue;
    }
    if (p && RANK[e.level] < RANK[p.level]) {
      weakerCp.push(`${r.id} ${p.level} → ${e.level} (same account, lower certainty)`);
    }
  }
  console.log(`  ✓ still supported & identical : ${persisted.length - lostCp.length - changedCp.length}`);
  console.log(`  ✗ unsupported / ambiguous     : ${lostCp.length}`);
  console.log(`  ✗ CONTRADICTED (different acct): ${changedCp.length}`);
  console.log(`  ⚠ lower certainty (same acct)  : ${weakerCp.length}`);
  for (const s of [...lostCp, ...changedCp].slice(0, 25)) console.log(`      ${s}`);
  for (const s of weakerCp.slice(0, 25)) console.log(`      ${s}`);

  const repaired: unknown[] = [];
  // The 16 repaired rows are identifiable by reason + the authority's own implication.
  const reclassRows = rows.filter((r) => {
    const e = E.get(r.id); if (!e) return false;
    return impliedFlowType(e.maturity) !== null && (r.flowType ?? null) !== impliedFlowType(e.maturity);
  });
  console.log(`\n  rows whose economic-replay maturity DISAGREES with the stored flowType: ${reclassRows.length}`);
  for (const r of reclassRows.slice(0, 20)) {
    console.log(`      ${r.date.toISOString().slice(0, 10)} ${r.amount.toFixed(2).padStart(10)} ` +
      `${r.flowType} → ${impliedFlowType(E.get(r.id)!.maturity)} [${E.get(r.id)!.level}] ${JSON.stringify(r.merchant).slice(0, 40)}`);
  }
  void repaired;

  // ── 5. Collision audit ───────────────────────────────────────────────────
  bar("5. COLLISION AUDIT — does economicDate introduce NEW false pairings?");
  const newPairs: string[] = [];
  for (const [id, e] of E) {
    const p = P.get(id)!;
    if (e.accountId && e.accountId !== p.accountId) {
      newPairs.push(`${id} posting=${p.accountId ?? "none"}(${p.level}) economic=${e.accountId}(${e.level})`);
    }
  }
  console.log(`  legs whose resolved ACCOUNT changes under economicDate: ${newPairs.length}`);
  for (const s of newPairs.slice(0, 25)) console.log(`      ${s}`);

  const RISK: [string, (r: (typeof rows)[number]) => boolean][] = [
    ["payment-app rail", (r) => ev(r).railType === "PAYMENT_APP"],
    ["cash form (ATM)", (r) => ev(r).movementForm === "CASH"],
    ["brokerage/exchange venue", (r) => { const v = ev(r).venueClass; return v === "BROKERAGE" || v === "EXCHANGE"; }],
    ["depository venue", (r) => ev(r).venueClass === "DEPOSITORY"],
    ["card payment family", (r) => r.pfcPrimary === "LOAN_PAYMENTS" || r.pfcPrimary === "LOAN_DISBURSEMENTS"],
  ];
  console.log(`\n  per risk class — legs gaining an account under economicDate that had none:`);
  for (const [label, f] of RISK) {
    const pop = admitted.filter(f);
    const gained = pop.filter((r) => {
      const p = P.get(r.id), e = E.get(r.id);
      return p && e && !p.accountId && !!e.accountId;
    });
    const lost = pop.filter((r) => {
      const p = P.get(r.id), e = E.get(r.id);
      return p && e && !!p.accountId && !e.accountId;
    });
    console.log(`    ${label.padEnd(26)} n=${String(pop.length).padStart(4)}  gained=${gained.length}  lost=${lost.length}` +
      (gained.length ? "  ⚠️ REVIEW" : ""));
    for (const g of gained.slice(0, 5)) {
      console.log(`        ${g.date.toISOString().slice(0, 10)} ${g.amount.toFixed(2).padStart(10)} → ${E.get(g.id)!.accountId} ${JSON.stringify(g.merchant).slice(0, 40)}`);
    }
  }
  // The structural vetoes must still hold under the new chronology.
  const appToDebt = [...E.values()].filter((v) =>
    ev(v.row).railType === "PAYMENT_APP" && v.maturity === "DEBT_PAYMENT").length;
  const cashWithAccount = [...E.values()].filter((v) =>
    ev(v.row).movementForm === "CASH" && v.accountId !== null).length;
  console.log(`\n  payment-app legs maturing to DEBT_PAYMENT : ${appToDebt} ${appToDebt === 0 ? "✓" : "✗ VETO BREACHED"}`);
  console.log(`  cash legs carrying a counterparty account : ${cashWithAccount} ${cashWithAccount === 0 ? "✓" : "✗ VETO BREACHED"}`);

  // ── 6. Pending lifecycle ─────────────────────────────────────────────────
  bar("6. PENDING LIFECYCLE — does economicDate remove artificial delay?");
  const pendingRows = rows.filter((r) => r.pending);
  console.log(`  live pending rows: ${pendingRows.length}`);
  let withAuth = 0, moved = 0;
  for (const r of pendingRows) {
    const e = econ.get(r.id)!;
    if (r.authorizedAt) withAuth++;
    if (e.lagDays > 0) moved++;
  }
  console.log(`    carrying authorizedAt : ${withAuth}/${pendingRows.length}`);
  console.log(`    economic date differs : ${moved}`);
  // A posted successor and its pending predecessor must not BOTH become candidates.
  const dupCandidates = rows.filter((r) => r.pendingTransactionRef != null);
  console.log(`  posted rows pointing at a pending predecessor: ${dupCandidates.length}`);
  let bothAdmitted = 0;
  const admittedIds = new Set(admitted.map((r) => r.id));
  for (const r of dupCandidates) {
    const pred = rows.find((x) => x.plaidTransactionId === r.pendingTransactionRef);
    if (pred && admittedIds.has(r.id) && admittedIds.has(pred.id)) bothAdmitted++;
  }
  console.log(`    pairs where BOTH legs are admitted (duplicate-candidate risk): ${bothAdmitted} ${bothAdmitted === 0 ? "✓" : "⚠️"}`);

  // ── 7. Chain continuation ────────────────────────────────────────────────
  bar("7. CHAIN CONTINUATION — the theorem must still hold");
  console.log(`  TRANSFER_MATCH_WINDOW_DAYS      = ${TRANSFER_MATCH_WINDOW_DAYS}`);
  console.log(`  CHAIN_CONTINUATION_WINDOW_DAYS  = ${CHAIN_CONTINUATION_WINDOW_DAYS}`);
  console.log(`  continuation > match : ${CHAIN_CONTINUATION_WINDOW_DAYS > TRANSFER_MATCH_WINDOW_DAYS ? "✓" : "✗"}`);
  for (const basis of ["POSTING", "ECONOMIC"] as Basis[]) {
    let hops = 0;
    for (const pool of byOwner.values()) {
      const legs = buildLegs(pool, basis);
      const idx = buildTransferCorpusIndex(legs);
      hops += [...idx.claims.values()].filter((c) => c.tier === "ACCOUNT_CERTAIN" || c.tier === "PROVIDER_LINKED").length / 2;
    }
    console.log(`  ${basis} certified hops: ${hops}`);
  }

  // ── 8. Structural floor — what happens where NO identifier exists ────────
  //
  // The maturity table is unchanged partly BECAUSE the provider tier absorbs the
  // corrId pairs. An institution that supplies no identifier (American Express:
  // 0 of 147 measured rows) has only the structural tiers, so the floor is what
  // the cutover actually risks for most of the world.
  bar("8. STRUCTURAL FLOOR — identifiers disabled, the Amex-profile case");
  const replayNoId = (basis: Basis) => {
    const out = new Map<string, { level: string; accountId: string | null; persistable: boolean }>();
    for (const pool of byOwner.values()) {
      const legs = buildLegs(pool, basis).map((l) => ({ ...l, providerLinkKey: null, maskedDestinationAccountId: null }));
      for (const l of legs) {
        const e = resolveDestinationEvidenceFor(l, legs);
        out.set(l.id, { level: e.level, accountId: e.accountId, persistable: e.persistableCounterparty });
      }
    }
    return out;
  };
  const PF = replayNoId("POSTING"), EF = replayNoId("ECONOMIC");
  const tally = (m: Map<string, { level: string }>) => {
    const t = new Map<string, number>();
    for (const v of m.values()) t.set(v.level, (t.get(v.level) ?? 0) + 1);
    return t;
  };
  const tp = tally(PF), te = tally(EF);
  console.log(`  ${"level".padEnd(34)} POSTING  ECONOMIC   Δ`);
  for (const k of [...new Set([...tp.keys(), ...te.keys()])].sort()) {
    const a = tp.get(k) ?? 0, b = te.get(k) ?? 0;
    console.log(`  ${k.padEnd(34)} ${String(a).padStart(7)}  ${String(b).padStart(8)}   ${b - a >= 0 ? "+" : ""}${b - a}`);
  }
  const fp = [...PF.values()].filter((v) => v.persistable).length;
  const fe = [...EF.values()].filter((v) => v.persistable).length;
  console.log(`  persistable (floor)  POSTING ${fp}  →  ECONOMIC ${fe}   (${fe - fp >= 0 ? "+" : ""}${fe - fp})`);
  let floorLost = 0, floorChanged = 0;
  for (const [id, e] of EF) {
    const p = PF.get(id)!;
    if (p.accountId && !e.accountId) floorLost++;
    if (p.accountId && e.accountId && p.accountId !== e.accountId) floorChanged++;
  }
  console.log(`  floor legs LOSING an account under economicDate : ${floorLost}`);
  console.log(`  floor legs whose account CHANGES                : ${floorChanged} ${floorChanged === 0 ? "✓" : "✗"}`);

  // ── 9. Window optimization — sweep the tier list on the FLOOR ────────────
  //
  // The floor is where a window choice actually matters: with identifiers the
  // provider tier absorbs the hard cases, so any tier list looks fine.
  bar("9. WINDOW OPTIMIZATION — tier sweep, identifiers disabled");
  const sweep = (basis: Basis, tiers: number[]) => {
    let certain = 0, persist = 0, wrong = 0;
    for (const pool of byOwner.values()) {
      const legs = buildLegs(pool, basis).map((l) => ({ ...l, providerLinkKey: null, maskedDestinationAccountId: null }));
      const claims = new Map<string, string>();
      for (const d of tiers) {
        const live = legs.filter((l) => !claims.has(l.id));
        const fwd = new Map<string, string[]>();
        for (const a of live) for (const b of live) {
          if (!legsQualify(a, b)) continue;
          if (Math.abs(a.dateMs - b.dateMs) / DAY > d) continue;
          (fwd.get(a.id) ?? fwd.set(a.id, []).get(a.id)!).push(b.id);
        }
        for (const [a, bs] of fwd) {
          if (bs.length !== 1) continue;
          const back = fwd.get(bs[0]) ?? [];
          if (back.length === 1 && back[0] === a) claims.set(a, bs[0]);
        }
      }
      certain += claims.size;
      persist += claims.size;
      for (const [k, v] of claims) if (truth.has(k) && truth.get(k) !== v) wrong++;
    }
    return { certain, persist, wrong };
  };
  console.log(`  ${"tiers".padEnd(22)} POSTING(certain/wrong)   ECONOMIC(certain/wrong)`);
  for (const tiers of [[0], [5], [0,1], [0,2], [0,3], [0,5], [0,7], [0,1,5], [0,2,5], [0,3,5], [0,1,2,3,5], [0,1,3,5,7]]) {
    const p = sweep("POSTING", tiers), e = sweep("ECONOMIC", tiers);
    const flag = e.wrong > 0 ? "  ✗ WRONG" : "";
    console.log(`  [${tiers.join(",")}]`.padEnd(24) + `${String(p.certain).padStart(8)}/${p.wrong}` +
      `${String(e.certain).padStart(22)}/${e.wrong}${flag}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
