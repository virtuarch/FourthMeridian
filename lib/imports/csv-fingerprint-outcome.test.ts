/**
 * lib/imports/csv-fingerprint-outcome.test.ts
 *
 * W1 (D6) — the import idempotency key is the DF-4 raw-descriptor fingerprint,
 * computed EXACTLY ONE WAY on this path.
 *
 *   npx tsx lib/imports/csv-fingerprint-outcome.test.ts
 *
 * Before W1, resolveFingerprintOutcome() found its match under one key
 * (findByFingerprint's normalized `description ?? merchant`) and assessed the
 * match's AMBIGUITY under another (the enriched `merchant` alone) — a post-DF-4
 * drift inside one function. The two keys could disagree: two rows the raw
 * descriptor cleanly distinguishes shared an enriched merchant, so a clean
 * match was refused as "ambiguous" (and vice versa, an enrichment drift could
 * hide genuine ambiguity). Both sides now key on `description ?? merchant`.
 *
 * ⚠️ Doctrine boundary (W1/D6): this key decides WRITE outcomes — create vs
 * match vs skip on import. It is never read identity; TransactionEvent is the
 * read-side authority, and INV-19 (scripts/audit-read-identity-consumers.ts)
 * pins that the fingerprint module stays reachable from write paths only.
 *
 * House pattern: standalone tsx, DB-free — a fake client injected through the
 * additive `client` seam (same seam findByFingerprint carries).
 */

import { resolveFingerprintOutcome } from "./csv";

interface FakeRow {
  id: string;
  financialAccountId: string;
  externalTransactionId: string | null;
  date: Date;
  amount: number;
  pending: boolean;
  deletedAt: Date | null;
  merchant: string;
  description: string | null;
  plaidTransactionId: string | null;
  transactionEventId: string | null;
  pendingTransactionRef: string | null;
}

function fakeClient(rows: FakeRow[]) {
  return {
    transaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find(
          (r) =>
            r.financialAccountId === where.financialAccountId &&
            r.externalTransactionId === where.externalTransactionId &&
            r.deletedAt === null,
        ) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter(
          (r) =>
            r.financialAccountId === where.financialAccountId &&
            r.date.getTime() === (where.date as Date).getTime() &&
            r.amount === where.amount &&
            r.pending === where.pending &&
            r.deletedAt === null,
        ),
    },
  } as never;
}

const D = new Date("2026-08-10T00:00:00.000Z");
const base = (over: Partial<FakeRow> & { id: string }): FakeRow => ({
  financialAccountId: "fa_1",
  externalTransactionId: null,
  date: D,
  amount: -19.99,
  pending: false,
  deletedAt: null,
  merchant: "Amazon",
  description: null,
  plaidTransactionId: null,
  transactionEventId: null,
  pendingTransactionRef: null,
  ...over,
});

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  // ── 1. Idempotency preserved: replaying a row matches its existing row ──────
  {
    const rows = [base({ id: "t1", merchant: "Amazon", description: "AMZN Mktp US*RT4Y12" })];
    const r = await resolveFingerprintOutcome("fa_1", D, -19.99, "Amazon", null, "AMZN Mktp US*RT4Y12", fakeClient(rows));
    check("re-import of an existing row → MATCH via fingerprint",
      r.outcome === "MATCH" && r.matchedVia === "fingerprint" && r.transactionId === "t1",
      JSON.stringify(r));
  }

  // ── 2. Enrichment drift on merchant does not break idempotency (DF-4) ───────
  {
    const rows = [base({ id: "t1", merchant: "AMZN MKTP US*RT4Y12", description: "AMZN Mktp US*RT4Y12" })];
    const r = await resolveFingerprintOutcome("fa_1", D, -19.99, "Amazon", null, "AMZN Mktp US*RT4Y12", fakeClient(rows));
    check("drifted enriched merchant, same raw descriptor → still MATCH",
      r.outcome === "MATCH" && r.transactionId === "t1", JSON.stringify(r));
  }

  // ── 3. THE W1 PIN — ambiguity is assessed under the SAME key as the match ───
  // Two rows share the enriched merchant "Amazon" but carry DISTINCT raw
  // descriptors. The raw-descriptor key cleanly identifies t1. Pre-W1, the
  // ambiguity re-check keyed on `merchant` alone, counted both, and refused a
  // clean match as "ambiguous".
  {
    const rows = [
      base({ id: "t1", merchant: "Amazon", description: "AMZN Mktp US*RT4Y12" }),
      base({ id: "t2", merchant: "Amazon", description: "AMZN Mktp US*ZZ9Q88" }),
    ];
    const r = await resolveFingerprintOutcome("fa_1", D, -19.99, "Amazon", null, "AMZN Mktp US*RT4Y12", fakeClient(rows));
    check("distinct raw descriptors under one enriched merchant → clean MATCH, not SKIP",
      r.outcome === "MATCH" && r.transactionId === "t1", JSON.stringify(r));
  }

  // ── 4. Genuine ambiguity under the raw-descriptor key is still refused ──────
  {
    const rows = [
      base({ id: "t1", merchant: "Amazon", description: "AMZN Mktp US*RT4Y12" }),
      base({ id: "t2", merchant: "AMAZON.COM", description: "AMZN Mktp US*RT4Y12" }),
    ];
    const r = await resolveFingerprintOutcome("fa_1", D, -19.99, "Amazon", null, "AMZN Mktp US*RT4Y12", fakeClient(rows));
    check("two rows sharing the raw descriptor → SKIP (ambiguous), never a coin flip",
      r.outcome === "SKIP", JSON.stringify(r));
  }

  // ── 5. No match under the raw key → CREATE (within-file repeats stay honest) ─
  {
    const rows = [base({ id: "t1", merchant: "Amazon", description: "AMZN Mktp US*ZZ9Q88" })];
    const r = await resolveFingerprintOutcome("fa_1", D, -19.99, "Amazon", null, "AMZN Mktp US*RT4Y12", fakeClient(rows));
    check("different raw descriptor → CREATE", r.outcome === "CREATE", JSON.stringify(r));
  }

  // ── 6. Durable-id precedence unchanged: externalTransactionId wins first ────
  {
    const rows = [
      base({ id: "t1", externalTransactionId: "ext-77", merchant: "Amazon", description: "AMZN Mktp US*RT4Y12" }),
      base({ id: "t2", merchant: "Amazon", description: "AMZN Mktp US*RT4Y12" }),
    ];
    const r = await resolveFingerprintOutcome("fa_1", D, -19.99, "Amazon", "ext-77", "AMZN Mktp US*RT4Y12", fakeClient(rows));
    check("externalTransactionId match outranks the fingerprint",
      r.outcome === "MATCH" && r.matchedVia === "externalId" && r.transactionId === "t1",
      JSON.stringify(r));
  }

  // ── 7. Caller without a separate descriptor keeps the merchant-keyed match ──
  {
    const rows = [base({ id: "t1", merchant: "Blue Bottle Coffee", description: null })];
    const r = await resolveFingerprintOutcome("fa_1", D, -19.99, "  blue bottle   coffee ", null, null, fakeClient(rows));
    check("no raw descriptor on either side → normalized merchant fallback still matches",
      r.outcome === "MATCH" && r.transactionId === "t1", JSON.stringify(r));
  }

  console.log(failures === 0 ? "\ncsv-fingerprint-outcome: all passed.\n" : `\n${failures} check(s) failed\n`);
  // Explicit exit on BOTH paths (house pattern): importing lib/imports/csv.ts
  // constructs the shared PrismaClient, whose engine load is async and rejects
  // in engine-less environments AFTER the checks complete — exiting here keeps
  // this DB-free test green wherever it runs.
  process.exit(failures > 0 ? 1 : 0);
}

main();
