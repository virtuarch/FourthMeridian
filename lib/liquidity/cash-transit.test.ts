/**
 * lib/liquidity/cash-transit.test.ts   (v2.7-P2 — cash in transit, disclosure only)
 *
 *   1. classification — source-first / destination-first settlement, partial
 *      match, stale, duplicate pending+posted twin, unknown external, currency,
 *      destination pending vs counted, source not yet deducted
 *   2. the REAL read path (loadCashTransitLegs → resolveTransferAssessments →
 *      matchTransferCandidate) over an in-memory client — no DB
 *   3. totals never move: the ledger renders the line, total cash / accessible
 *      are byte-identical with and without it
 *   4. source scans — read-only, scoped, guarded route
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/liquidity/cash-transit.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from "node:fs";
import {
  CASH_TRANSIT_WINDOW_DAYS, classifyCashTransitLeg, summarizeCashTransit, cashTransitDisclosure,
  type CashTransitLeg,
} from "@/lib/liquidity/cash-transit";
import type { AdjustedBalanceBasis } from "@/lib/balances/account-balances";
import { TRANSFER_MATCH_WINDOW_DAYS } from "@/lib/transactions/transfer-maturation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-27T15:00:00Z");
const fmt = (n: number) => `$${n.toFixed(2)}`;

function leg(over: Partial<CashTransitLeg>): CashTransitLeg {
  return {
    sourceAccountId: "chk", amount: -1500, currency: "USD", date: "2026-10-26",
    lifecycle: "POSTED", superseded: false, match: "UNMATCHED", destination: null, ...over,
  };
}
const bases = (m: Record<string, AdjustedBalanceBasis | null>) => (id: string) => m[id] ?? null;

async function main() {
  console.log("\n1. classification");
  check("the window is the transfer authority's own bound", CASH_TRANSIT_WINDOW_DAYS === TRANSFER_MATCH_WINDOW_DAYS);

  // Source-first: source debit posted (inside C), destination nothing yet.
  {
    const s = summarizeCashTransit([leg({})], bases({ chk: "NO_PENDING" }), NOW);
    check("source-first: posted debit, no destination ⇒ UNMATCHED_OUTGOING", s.states[0] === "UNMATCHED_OUTGOING");
    const lines = cashTransitDisclosure(s, fmt);
    check("source-first: one NEUTRAL line with the amount, never 'in transit' as a fact",
      lines.length === 1 && lines[0] === "1 outgoing transfer ($1500.00) — destination not yet confirmed; not added to total cash."
      && !/external/i.test(lines[0])
      && !/in transit/i.test(lines[0]), JSON.stringify(lines));
  }
  // Source-first, source debit still PENDING.
  check("source pending, PENDING_EXCLUDED source (removed from total) ⇒ UNMATCHED_OUTGOING",
    classifyCashTransitLeg(leg({ lifecycle: "PENDING" }), bases({ chk: "PENDING_EXCLUDED" }), NOW) === "UNMATCHED_OUTGOING");
  check("source pending, PENDING_INCLUDED source (already in C) ⇒ UNMATCHED_OUTGOING",
    classifyCashTransitLeg(leg({ lifecycle: "PENDING" }), bases({ chk: "PENDING_INCLUDED" }), NOW) === "UNMATCHED_OUTGOING");
  check("source pending, UNPROVEN source (still counted at source) ⇒ NOT_DEDUCTED_AT_SOURCE, nothing shown",
    classifyCashTransitLeg(leg({ lifecycle: "PENDING" }), bases({ chk: "UNPROVEN" }), NOW) === "NOT_DEDUCTED_AT_SOURCE");
  check("source pending, no claim ⇒ NOT_DEDUCTED_AT_SOURCE",
    classifyCashTransitLeg(leg({ lifecycle: "PENDING" }), bases({}), NOW) === "NOT_DEDUCTED_AT_SOURCE");

  // Destination-first (the Production fixture shape): destination credit posted,
  // source debit pending and removed by PENDING_EXCLUDED ⇒ counted once.
  {
    const l = leg({ lifecycle: "PENDING", match: "MATCHED", destination: { accountId: "sav", lifecycle: "POSTED" } });
    const s = summarizeCashTransit([l], bases({ chk: "PENDING_EXCLUDED", sav: "NO_PENDING" }), NOW);
    check("destination-first: posted destination credit ⇒ CONFIRMED_INTERNAL, nothing shown",
      s.states[0] === "CONFIRMED_INTERNAL" && cashTransitDisclosure(s, fmt).length === 0);
  }
  // Both legs posted.
  check("both legs posted ⇒ CONFIRMED_INTERNAL",
    classifyCashTransitLeg(leg({ match: "MATCHED", destination: { accountId: "sav", lifecycle: "POSTED" } }), bases({}), NOW) === "CONFIRMED_INTERNAL");
  // Pending destination credit.
  check("destination credit pending, destination PENDING_EXCLUDED (counted in C + P) ⇒ CONFIRMED_INTERNAL",
    classifyCashTransitLeg(leg({ match: "MATCHED", destination: { accountId: "sav", lifecycle: "PENDING" } }), bases({ sav: "PENDING_EXCLUDED" }), NOW) === "CONFIRMED_INTERNAL");
  {
    const l = leg({ match: "MATCHED", destination: { accountId: "sav", lifecycle: "PENDING" } });
    const s = summarizeCashTransit([l], bases({ sav: "UNPROVEN" }), NOW);
    const lines = cashTransitDisclosure(s, fmt);
    check("destination credit pending, destination UNPROVEN ⇒ DESTINATION_PENDING, neutral line",
      s.states[0] === "DESTINATION_PENDING" && lines.length === 1
      && lines[0] === "1 transfer ($1500.00) still pending at the destination — not yet confirmed in that account's balance.", JSON.stringify(lines));
  }
  check("destination account certain, leg ambiguous ⇒ DESTINATION_AMBIGUOUS, nothing shown",
    classifyCashTransitLeg(leg({ match: "MATCHED", destination: { accountId: "sav", lifecycle: null } }), bases({}), NOW) === "DESTINATION_AMBIGUOUS");
  check("ambiguous destination ⇒ nothing shown",
    classifyCashTransitLeg(leg({ match: "AMBIGUOUS" }), bases({}), NOW) === "DESTINATION_AMBIGUOUS");
  check("unknown external destination ⇒ EXTERNAL, nothing shown",
    classifyCashTransitLeg(leg({ match: "EXTERNAL" }), bases({}), NOW) === "EXTERNAL");

  // Stale: older than the window ⇒ "not yet" no longer applies.
  check("stale (old) unmatched leg ⇒ STALE, nothing shown",
    classifyCashTransitLeg(leg({ date: "2026-10-15" }), bases({}), NOW) === "STALE");
  check("old PENDING leg on an UNPROVEN source is still NOT_DEDUCTED (never transit)",
    classifyCashTransitLeg(leg({ date: "2026-10-01", lifecycle: "PENDING" }), bases({ chk: "UNPROVEN" }), NOW) === "NOT_DEDUCTED_AT_SOURCE");
  check("edge of window (6 days) still disclosed; 7 days stale",
    classifyCashTransitLeg(leg({ date: "2026-10-21" }), bases({}), NOW) === "UNMATCHED_OUTGOING"
    && classifyCashTransitLeg(leg({ date: "2026-10-20" }), bases({}), NOW) === "STALE");

  // Duplicate provider events: pending observation + its posted twin.
  {
    const s = summarizeCashTransit([
      leg({ lifecycle: "PENDING", superseded: true }),
      leg({ lifecycle: "POSTED" }),
    ], bases({ chk: "PENDING_EXCLUDED" }), NOW);
    check("pending+posted twin ⇒ counted ONCE (SUPERSEDED + UNMATCHED)",
      s.states.join() === "SUPERSEDED,UNMATCHED_OUTGOING" && s.unmatched.count === 1 && s.unmatched.total === 1500);
  }
  // Currency.
  {
    const eurToUsd = (a: number, c: string | null) => (c === "EUR" ? a * 1.1 : a);
    const s = summarizeCashTransit([leg({ currency: "EUR", amount: -100 }), leg({ amount: -50 })], bases({}), NOW, eurToUsd);
    check("currency: each leg converted once into the display currency", Math.abs((s.unmatched.total ?? 0) - 160) < 1e-9);
    const s2 = summarizeCashTransit([leg({ currency: "XXX", amount: -100 })], bases({}), NOW, (a, c) => (c === "XXX" ? null : a));
    const l2 = cashTransitDisclosure(s2, fmt);
    check("currency: unconvertible ⇒ count disclosed, no amount claimed",
      s2.unmatched.total === null && l2[0] === "1 outgoing transfer — destination not yet confirmed; not added to total cash.");
  }
  // ── Owner ruling (PR #63) — possible temporary double counting ────────────
  {
    const m = { accountId: "sav", lifecycle: "POSTED" as const };
    const twice = summarizeCashTransit([leg({ lifecycle: "PENDING", match: "MATCHED", destination: m })], bases({ chk: "UNPROVEN", sav: "NO_PENDING" }), NOW);
    check("ruling 2: source pending on an UNPROVEN basis + destination credit POSTED ⇒ POSSIBLY_COUNTED_TWICE", twice.states[0] === "POSSIBLY_COUNTED_TWICE");
    const tl = cashTransitDisclosure(twice, fmt);
    check("ruling 2: one neutral line, totals explicitly not adjusted, no 'in transit'",
      tl.length === 1 && tl[0] === "1 transfer ($1500.00) may be counted in both accounts until the sending bank posts it — totals are not adjusted." && !/in transit/i.test(tl[0]), JSON.stringify(tl));
    check("ruling 2: source pending with NO claim + destination posted ⇒ POSSIBLY_COUNTED_TWICE",
      classifyCashTransitLeg(leg({ lifecycle: "PENDING", match: "MATCHED", destination: m }), bases({}), NOW) === "POSSIBLY_COUNTED_TWICE");
    check("ruling 2: destination pending on a basis that COUNTS pending ⇒ POSSIBLY_COUNTED_TWICE",
      classifyCashTransitLeg(leg({ lifecycle: "PENDING", match: "MATCHED", destination: { accountId: "sav", lifecycle: "PENDING" } }), bases({ chk: "UNPROVEN", sav: "PENDING_EXCLUDED" }), NOW) === "POSSIBLY_COUNTED_TWICE");
    check("ruling 2: destination pending on an UNPROVEN basis ⇒ not proven double ⇒ NOT_DEDUCTED_AT_SOURCE (nothing shown)",
      classifyCashTransitLeg(leg({ lifecycle: "PENDING", match: "MATCHED", destination: { accountId: "sav", lifecycle: "PENDING" } }), bases({ chk: "UNPROVEN", sav: "UNPROVEN" }), NOW) === "NOT_DEDUCTED_AT_SOURCE");
    check("ruling 2: source PENDING_EXCLUDED (deducted) + destination posted ⇒ counted once ⇒ CONFIRMED_INTERNAL",
      classifyCashTransitLeg(leg({ lifecycle: "PENDING", match: "MATCHED", destination: m }), bases({ chk: "PENDING_EXCLUDED" }), NOW) === "CONFIRMED_INTERNAL");
    check("ruling 2: destination leg ambiguous ⇒ no double-count claim", classifyCashTransitLeg(leg({ lifecycle: "PENDING", match: "MATCHED", destination: { accountId: "sav", lifecycle: null } }), bases({ chk: "UNPROVEN" }), NOW) === "NOT_DEDUCTED_AT_SOURCE");
    check("ruling 3: no definitive 'In transit $X' wording anywhere", !/in transit \$/i.test(JSON.stringify(cashTransitDisclosure({ unmatched: { count: 2, total: 10 }, destinationPending: { count: 1, total: 5 }, possiblyCountedTwice: { count: 1, total: 3 }, states: [] }, fmt))));
  }

  check("nothing to disclose ⇒ []", cashTransitDisclosure(summarizeCashTransit([], bases({}), NOW), fmt).length === 0);

  console.log("\n2. the real read path (in-memory client)");
  {
    const { loadCashTransitLegs, projectTransferMatch } = await import("@/lib/liquidity/cash-transit-read");
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const tx = (o: any) => ({
      deletedAt: null, pending: false, settlementState: "POSTED", currency: "USD", flowType: "TRANSFER",
      merchant: "Online Transfer", description: null, category: "Transfer", counterpartyType: null,
      counterpartyAccountId: null, plaidTransactionId: null, transactionEventId: null, pendingTransactionRef: null,
      ...o, economicDate: day(o.date), date: day(o.date),
      pfcPrimary: o.amount < 0 ? "TRANSFER_OUT" : "TRANSFER_IN",
      pfcDetailed: o.amount < 0 ? "TRANSFER_OUT_ACCOUNT_TRANSFER" : "TRANSFER_IN_ACCOUNT_TRANSFER",
    });
    const accounts = [
      { id: "chk", type: "checking", ownerUserId: "u1", mask: "1111", institutionId: "ins_a" },
      { id: "sav", type: "savings",  ownerUserId: "u1", mask: "2222", institutionId: "ins_b" },
      { id: "sav2", type: "savings", ownerUserId: "u1", mask: "3333", institutionId: "ins_c" },
    ];
    const rows = [
      // A: source-first — posted debit, no arrival anywhere.
      tx({ id: "a", financialAccountId: "chk", amount: -1500, date: "2026-10-26" }),
      // B: partial match — −700 out, +699.50 in: amounts differ ⇒ never paired.
      tx({ id: "b", financialAccountId: "chk", amount: -700, date: "2026-10-25" }),
      tx({ id: "b2", financialAccountId: "sav2", amount: 699.5, date: "2026-10-25" }),
      // C: destination-first — +125.41 posted at savings; source debit pending.
      tx({ id: "c", financialAccountId: "chk", amount: -125.41, date: "2026-10-24", pending: true, settlementState: "PENDING", plaidTransactionId: "p-c" }),
      tx({ id: "c2", financialAccountId: "sav", amount: 125.41, date: "2026-10-23" }),
      // D: stale unmatched (outside the gather window entirely).
      tx({ id: "d", financialAccountId: "chk", amount: -90, date: "2026-10-01" }),
      // E: pending observation with a live posted twin, both −40.
      tx({ id: "e-p", financialAccountId: "chk", amount: -40, date: "2026-10-26", pending: true, settlementState: "PENDING", plaidTransactionId: "p-e" }),
      tx({ id: "e", financialAccountId: "chk", amount: -40, date: "2026-10-26", pendingTransactionRef: "p-e" }),
    ];
    const inIds = (w: any, k: string, v: any) => !w?.[k]?.in || w[k].in.includes(v);
    const client: any = {
      financialAccount: {
        findMany: async ({ where }: any) => {
          if (where.type) return accounts.filter((a) => where.type.in.includes(a.type)).map((a) => ({ id: a.id }));
          if (where.ownerUserId) return accounts.filter((a) => where.ownerUserId.in.includes(a.ownerUserId));
          if (where.spaceAccountLinks) return accounts.filter((a) => where.id.in.includes(a.id)).map((a) => ({ id: a.id }));
          return accounts.filter((a) => where.id.in.includes(a.id));
        },
      },
      transaction: {
        findMany: async ({ where }: any) => {
          if (where.AND) {
            const w = where.AND[0];
            return rows.filter((r) => inIds(w, "financialAccountId", r.financialAccountId) && r.amount < 0 && r.date >= w.date.gte);
          }
          if (where.pendingTransactionRef) return rows.filter((r) => r.pendingTransactionRef && where.pendingTransactionRef.in.includes(r.pendingTransactionRef));
          if (where.id) return rows.filter((r) => where.id.in.includes(r.id));
          // the resolver's candidate gather
          return rows.filter((r) => where.financialAccountId.in.includes(r.financialAccountId) && r.date >= where.date.gte && r.date <= where.date.lte);
        },
      },
    };
    const legs = await loadCashTransitLegs(client, { spaceId: "s1", now: NOW });
    const byAmt = (a: number) => legs.filter((l) => l.amount === a);
    check("stale leg is not gathered", byAmt(-90).length === 0);
    check("A (source-first, Plaid ACCOUNT_TRANSFER ⇒ derived EXTERNAL_DEPOSITORY leaf) projects UNMATCHED", byAmt(-1500)[0]?.match === "UNMATCHED", JSON.stringify(byAmt(-1500)));
    check("B (amount mismatch) projects UNMATCHED — partial matches are never paired", byAmt(-700)[0]?.match === "UNMATCHED", JSON.stringify(byAmt(-700)));
    const c = byAmt(-125.41)[0];
    check("C (destination-first) projects MATCHED to savings with a POSTED destination leg",
      c?.match === "MATCHED" && c.destination?.accountId === "sav" && c.destination.lifecycle === "POSTED" && c.lifecycle === "PENDING", JSON.stringify(c));
    const e = byAmt(-40);
    check("E pending observation flagged superseded by its posted twin", e.length === 2 && e.filter((l) => l.superseded).length === 1);
    check("the projection carries no names, descriptors or transaction ids",
      legs.every((l) => Object.keys(l).sort().join() === "amount,currency,date,destination,lifecycle,match,sourceAccountId,superseded"));

    const s = summarizeCashTransit(legs, bases({ chk: "PENDING_EXCLUDED", sav: "NO_PENDING", sav2: "NO_PENDING" }), NOW);
    check("end to end: A + B + E disclosed once each (3 unmatched, $2,240.00); C confirmed",
      s.unmatched.count === 3 && Math.abs((s.unmatched.total ?? 0) - 2240) < 1e-9 && s.destinationPending.count === 0, JSON.stringify(s));

    // Projection of authority answers that the fixture does not reach.
    const base: any = { status: "NONE", persistableCounterparty: false, counterpartyAccountId: null, maturity: "UNRESOLVED_TRANSFER", reason: "NO_CANDIDATE", unresolvedReason: "NO_COUNTERPART_EVIDENCE" };
    check("projection: payment-app person ⇒ EXTERNAL", projectTransferMatch({ ...base, maturity: "EXTERNAL_PERSON_TRANSFER", reason: "EXTERNAL_TERMINAL", unresolvedReason: null }, false) === "EXTERNAL");
    check("projection: unconnected venue ⇒ EXTERNAL", projectTransferMatch({ ...base, maturity: "EXTERNAL_VENUE_TRANSFER", reason: "EXTERNAL_TERMINAL", unresolvedReason: null }, false) === "EXTERNAL");
    check("projection: non-owned counterparty class ⇒ EXTERNAL", projectTransferMatch({ ...base, maturity: "EXTERNAL_UNKNOWN_TRANSFER", reason: "EXTERNAL_TERMINAL", unresolvedReason: null }, false) === "EXTERNAL");
    check("projection: generic depository leaf with no owned leg ⇒ UNMATCHED (it may be an owned destination not yet credited)",
      projectTransferMatch({ ...base, maturity: "EXTERNAL_DEPOSITORY_TRANSFER", reason: "EXTERNAL_TERMINAL", unresolvedReason: null }, false) === "UNMATCHED");
    check("projection: truly unresolved (no attested venue) ⇒ UNMATCHED", projectTransferMatch(base, false) === "UNMATCHED");
    check("projection: CASH_MOVEMENT ⇒ EXTERNAL", projectTransferMatch({ ...base, maturity: "CASH_MOVEMENT", reason: "CASH_MOVEMENT_NO_COUNTERPARTY", unresolvedReason: null }, false) === "EXTERNAL");
    check("projection: cross-owner boundary ⇒ not UNMATCHED", projectTransferMatch({ ...base, unresolvedReason: "CROSS_OWNER_BOUNDARY" }, false) !== "UNMATCHED");
    check("projection: type-certain / account-ambiguous ⇒ AMBIGUOUS", projectTransferMatch({ ...base, status: "AMBIGUOUS", reason: "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS", maturity: "SAVINGS_TRANSFER", unresolvedReason: null }, false) === "AMBIGUOUS");
    check("projection: KD-15-gated (invisible) counterparty ⇒ AMBIGUOUS, never UNMATCHED", projectTransferMatch({ ...base, status: "RESOLVED", reason: "DETERMINISTIC_UNIQUE", maturity: "SAVINGS_TRANSFER", unresolvedReason: null }, false) === "AMBIGUOUS");
    check("projection: provider-persisted link ⇒ AMBIGUOUS (a destination exists)", projectTransferMatch(undefined, true) === "AMBIGUOUS");
  }

  console.log("\n3. totals never move");
  {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { CashAccountsLedger } = await import("@/components/space/widgets/liquidity/CashAccountsLedger");
    const { buildCashAccounts } = await import("@/components/space/widgets/liquidity/cash-accounts");
    const accounts: any[] = [
      { id: "chk", name: "Checking", type: "checking", balance: 929.01, currency: "USD", institution: "Bank A",
        currentState: { reachable: 929.01, unexplained: 0, state: "EXACT", pendingCount: 0, basis: "NO_PENDING", adjusted: 929.01, pendingSum: 0 }, adjustedBalance: 929.01 },
      { id: "sav", name: "Savings", type: "savings", balance: 5000, currency: "USD", institution: "Bank B",
        currentState: { reachable: 5000, unexplained: 0, state: "EXACT", pendingCount: 0, basis: "NO_PENDING", adjusted: 5000, pendingSum: 0 }, adjustedBalance: 5000 },
    ];
    const summary = buildCashAccounts(accounts);
    const props = { spaceId: "s1", accounts, summary, currency: "USD", detailRows: [] as any[], now: NOW };
    const without = renderToStaticMarkup(createElement(CashAccountsLedger, { ...props, transitLegs: [] }));
    const withLine = renderToStaticMarkup(createElement(CashAccountsLedger, { ...props, transitLegs: [leg({})] }));
    check("the ledger renders the transit line only when there is one",
      !without.includes("data-cash-transit-line") && withLine.includes("data-cash-transit-line") && withLine.includes("destination not yet confirmed"));
    const strip = (h: string) => h.replace(/<p[^>]*data-cash-transit-line[^>]*>[\s\S]*?<\/p>/g, "");
    check("everything else — total cash, accessible, every row — is byte-identical", strip(withLine) === without);
    check("total cash is unchanged by a transit leg (5,929.01)", summary.totalCash === 5929.01 && withLine.includes("$5,929.01"));
  }

  console.log("\n4. source scans");
  {
    const read = readFileSync("lib/liquidity/cash-transit-read.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    check("the read is READ-ONLY (no create/update/upsert/delete/$executeRaw)", !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/.test(read));
    check("the read is scoped to transaction-detail visibility and the event projection",
      /TRANSACTION_DETAIL_VISIBILITY/.test(read) && /eventProjectionWhere\(\)/.test(read) && /BANKING_POPULATION/.test(read));
    check("only TRANSFER legs are considered (DEBT_PAYMENT names a liability)", /flowType: FlowType\.TRANSFER/.test(read));
    check("the transfer authority is CALLED, not re-implemented", /resolveTransferAssessments\(/.test(read) && !/matchTransferCandidate/.test(read));
    const route = readFileSync("app/api/spaces/[id]/liquidity/cash-transit/route.ts", "utf8");
    check("the route is membership-guarded and tenant-scoped", /requireSpaceAction\(spaceId, "perspective:read"\)/.test(route) && /withTenantDb\(/.test(route));
    const pure = readFileSync("lib/liquidity/cash-transit.ts", "utf8");
    check("the pure module imports no DB / server code", !/@prisma|server-only|@\/lib\/db/.test(pure));
  }

  if (failures > 0) { console.error(`\n${failures} cash-transit check(s) failed`); process.exit(1); }
  console.log("\nAll cash-transit checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
