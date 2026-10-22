/**
 * lib/transactions/fingerprint.test.ts  (DF-4)
 *
 * Reconnection-safe transaction identity: the fingerprint fallback must key on
 * the RAW descriptor (stable across Plaid enrichment drift), not the enriched
 * merchant. Standalone tsx script (house pattern): npx tsx <this> — exits 0/1.
 * NO live DB — findByFingerprint takes an injected `client`.
 *
 * Models the ACTUAL 6-Amazon-rows production incident: the same real purchase
 * re-pulled with drifting `personal_finance_category`/`merchant_name` (one pass
 * enriched to "Amazon" GENERAL_MERCHANDISE, another un-enriched OTHER_OTHER with
 * merchant_name null → raw descriptor). The old merchant-key missed and created
 * a duplicate; the raw-descriptor key matches, so replay is idempotent.
 */

import { findByFingerprint, resolveFingerprint, normalizeMerchantKey } from "@/lib/transactions/fingerprint";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

interface Row { id: string; financialAccountId: string; date: Date; amount: number; pending: boolean; merchant: string; description: string | null; plaidTransactionId: string | null; deletedAt: Date | null }
function fakeClient(rows: Row[]) {
  return {
    transaction: {
      async findMany({ where }: { where: { financialAccountId: string; date: Date; amount: number; pending: boolean; deletedAt: null } }) {
        return rows
          .filter((r) => r.financialAccountId === where.financialAccountId && +r.date === +where.date && r.amount === where.amount && r.pending === where.pending && r.deletedAt === null)
          .map((r) => ({ id: r.id, merchant: r.merchant, description: r.description, plaidTransactionId: r.plaidTransactionId }));
      },
    },
  } as unknown as Parameters<typeof findByFingerprint>[5];
}

const D19 = new Date("2026-07-19");
const RAW = "AMAZON MARKETPLACE NAMZN.COM/BILL"; // Plaid's verbatim txn.name — stable across enrichment

async function main() {
  // ── The incident: enriched row exists; re-pull arrives un-enriched (raw). ──
  {
    // Pass 1 persisted an ENRICHED row: merchant "Amazon", description = raw.
    const rows: Row[] = [{ id: "orig", financialAccountId: "acctA", date: D19, amount: -62.11, pending: false, merchant: "Amazon", description: RAW, plaidTransactionId: "plaid-1" }].map((r) => ({ ...r, deletedAt: null }));
    // The re-pull (un-enriched, merchant_name null) resolves to descriptor = RAW.
    const match = await findByFingerprint("acctA", D19, -62.11, RAW, false, fakeClient(rows));
    check("incident: re-pull with raw descriptor MATCHES the enriched row (no duplicate)", match?.id === "orig");
    // Prove the OLD merchant-key would have missed: raw descriptor ≠ enriched "Amazon".
    check("incident: raw descriptor and enriched merchant are different keys (why the old code duplicated)", normalizeMerchantKey(RAW) !== normalizeMerchantKey("Amazon"));
  }

  // ── Symmetric: existing row is the un-enriched one; enriched re-pull. ──
  {
    const rows: Row[] = [{ id: "orig2", financialAccountId: "acctA", date: D19, amount: -62.11, pending: false, merchant: RAW, description: RAW, plaidTransactionId: "plaid-2", deletedAt: null }];
    const match = await findByFingerprint("acctA", D19, -62.11, RAW, false, fakeClient(rows));
    check("symmetric: descriptor key matches regardless of which pass persisted first", match?.id === "orig2");
  }

  // ── Distinct purchases with DIFFERENT descriptors stay distinct. ──
  {
    const rows: Row[] = [
      { id: "amz", financialAccountId: "acctA", date: D19, amount: -62.11, pending: false, merchant: "Amazon", description: RAW, plaidTransactionId: "p-amz", deletedAt: null },
      { id: "sbux", financialAccountId: "acctA", date: D19, amount: -62.11, pending: false, merchant: "Starbucks", description: "STARBUCKS STORE 123", plaidTransactionId: "p-sbux", deletedAt: null },
    ];
    const m = await findByFingerprint("acctA", D19, -62.11, "STARBUCKS STORE 123", false, fakeClient(rows));
    check("distinct: same account/date/amount but different descriptor → matches only its own row", m?.id === "sbux");
  }

  // ── Cross-account isolation: a row on another account cannot match. ──
  {
    const rows: Row[] = [{ id: "other", financialAccountId: "acctB", date: D19, amount: -62.11, pending: false, merchant: "Amazon", description: RAW, plaidTransactionId: "p-b", deletedAt: null }];
    const m = await findByFingerprint("acctA", D19, -62.11, RAW, false, fakeClient(rows));
    check("cross-account: fingerprint is scoped to financialAccountId (no cross-account merge)", m === null);
  }

  // ── Tombstoned candidate is not matched (import-rollback safety preserved). ──
  {
    const rows: Row[] = [{ id: "dead", financialAccountId: "acctA", date: D19, amount: -62.11, pending: false, merchant: "Amazon", description: RAW, plaidTransactionId: "p-dead", deletedAt: new Date() }];
    const m = await findByFingerprint("acctA", D19, -62.11, RAW, false, fakeClient(rows));
    check("tombstone: soft-deleted row is not a fingerprint candidate (deletedAt filter preserved)", m === null);
  }

  // ── CSV without a raw descriptor: coalesce falls back to merchant (no regression). ──
  {
    const rows: Row[] = [{ id: "csv", financialAccountId: "acctA", date: D19, amount: -62.11, pending: false, merchant: "MANUAL PAYEE", description: null, plaidTransactionId: null, deletedAt: null }];
    const m = await findByFingerprint("acctA", D19, -62.11, "MANUAL PAYEE", false, fakeClient(rows));
    check("csv: description null → coalesce to merchant (prior behavior preserved)", m?.id === "csv");
  }

  // ── FIN-009 — ambiguity is answered, not coin-tossed ───────────────────────
  {
    const twins: Row[] = [
      { id: "twin-a", financialAccountId: "acctA", date: D19, amount: -12.05, pending: false, merchant: "Talabat", description: "TAP TALABAT food", plaidTransactionId: null, deletedAt: null },
      { id: "twin-b", financialAccountId: "acctA", date: D19, amount: -12.05, pending: false, merchant: "Talabat", description: "TAP TALABAT food", plaidTransactionId: null, deletedAt: null },
      { id: "other",  financialAccountId: "acctA", date: D19, amount: -12.05, pending: false, merchant: "Uber", description: "UBER TRIP", plaidTransactionId: null, deletedAt: null },
    ];
    const amb = await resolveFingerprint("acctA", D19, -12.05, "TAP TALABAT food", false, fakeClient(twins));
    check("FIN-009: two rows with the same fingerprint ⇒ AMBIGUOUS, naming both twins and not the unrelated row",
      amb.kind === "AMBIGUOUS" && amb.matches.map((m) => m.id).sort().join(",") === "twin-a,twin-b", JSON.stringify(amb));
    const one = await resolveFingerprint("acctA", D19, -12.05, "UBER TRIP", false, fakeClient(twins));
    check("FIN-009: exactly one row ⇒ MATCH", one.kind === "MATCH" && one.row.id === "other");
    const none = await resolveFingerprint("acctA", D19, -99, "UBER TRIP", false, fakeClient(twins));
    check("FIN-009: no row ⇒ NONE", none.kind === "NONE");
    const legacy = await findByFingerprint("acctA", D19, -12.05, "TAP TALABAT food", false, fakeClient(twins));
    check("FIN-009: the legacy helper keeps its first-of-several contract for the CSV import (which SKIPs on its own re-check)",
      legacy?.id === "twin-a");
  }

  console.log(failures === 0 ? "\nAll fingerprint guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
