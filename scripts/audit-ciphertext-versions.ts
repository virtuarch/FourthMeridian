/**
 * scripts/audit-ciphertext-versions.ts
 *
 * SEC-1 / KD-6 — Slice 5a. READ-ONLY audit of encryption-at-rest formats.
 *
 * Scans every field encrypted by lib/plaid/encryption.ts and reports, per
 * table.field, how many stored values are:
 *
 *   v1       legacy root-key format   "iv:authTag:ciphertext"      (KD-6 debt)
 *   v2       purpose-derived format   "v2:iv:authTag:ciphertext"   (current)
 *   invalid  neither of the above (would throw in decryptWithPurpose)
 *   null     column is NULL / empty (nothing stored)
 *
 * This is the confirmation step for the re-encryption backfill (Slice 5b): it
 * quantifies the real v1 population before anything is rewritten.
 *
 * GUARANTEES:
 *   - Report mode only. Zero writes, zero mutations, zero data changes.
 *   - Never decrypts. It only classifies ciphertext *format* (no key use on
 *     row data), so it cannot leak plaintext and cannot fail on bad keys.
 *   - Reads a minimal projection (id + the encrypted column) in id-ordered
 *     pages, so it is safe to run against production.
 *
 * Run:
 *   npx tsx scripts/audit-ciphertext-versions.ts
 *
 * Exit code:
 *   0  — audit completed (regardless of how many v1 rows were found)
 *   1  — audit could not complete (e.g. DB unreachable)
 *
 * Finding v1 rows is a normal, expected result — it is the debt this audit
 * exists to measure, not an error. A non-zero exit means the audit itself
 * failed to run, not that v1 data exists.
 */

import { PrismaClient } from "@prisma/client";
import { detectCiphertextVersion, type CiphertextVersion } from "@/lib/plaid/encryption";

const db = new PrismaClient({ log: ["error", "warn"] });

const PAGE_SIZE = 1000;

type Counts = { v1: number; v2: number; invalid: number; null: number; total: number };

function emptyCounts(): Counts {
  return { v1: 0, v2: 0, invalid: 0, null: 0, total: 0 };
}

function tally(counts: Counts, value: string | null): void {
  counts.total++;
  if (value === null || value === "") {
    counts.null++;
    return;
  }
  const version: CiphertextVersion = detectCiphertextVersion(value);
  counts[version]++; // "v1" | "v2" | "invalid"
}

/**
 * Generic id-paged scan of one encrypted column. `page` returns rows with
 * `{ id, value }` for ids strictly greater than `afterId`, ordered by id.
 * READ-ONLY — the caller only ever passes Prisma findMany selects.
 */
async function scanField(
  label: string,
  page: (afterId: string | null) => Promise<Array<{ id: string; value: string | null }>>,
): Promise<{ label: string; counts: Counts }> {
  const counts = emptyCounts();
  let afterId: string | null = null;

  for (;;) {
    const rows = await page(afterId);
    if (rows.length === 0) break;
    for (const row of rows) tally(counts, row.value);
    afterId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }

  return { label, counts };
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function num(n: number, width: number): string {
  return rjust(String(n), width);
}

function rjust(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

async function main(): Promise<void> {
  console.log("");
  console.log("SEC-1 / KD-6 — ciphertext version audit (READ-ONLY, no writes)");
  console.log("=".repeat(72));

  const results = [];

  // ── PlaidItem.encryptedToken (required) — PLAID_ACCESS_TOKEN ────────────────
  results.push(
    await scanField("PlaidItem.encryptedToken", async (afterId) => {
      const rows = await db.plaidItem.findMany({
        where: afterId ? { id: { gt: afterId } } : undefined,
        select: { id: true, encryptedToken: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      });
      return rows.map((r) => ({ id: r.id, value: r.encryptedToken }));
    }),
  );

  // ── User.totpSecret (nullable) — TOTP_SECRET ────────────────────────────────
  results.push(
    await scanField("User.totpSecret", async (afterId) => {
      const rows = await db.user.findMany({
        where: afterId ? { id: { gt: afterId } } : undefined,
        select: { id: true, totpSecret: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      });
      return rows.map((r) => ({ id: r.id, value: r.totpSecret }));
    }),
  );

  // ── User.dateOfBirthEncrypted (nullable) — DATE_OF_BIRTH ─────────────────────
  results.push(
    await scanField("User.dateOfBirthEncrypted", async (afterId) => {
      const rows = await db.user.findMany({
        where: afterId ? { id: { gt: afterId } } : undefined,
        select: { id: true, dateOfBirthEncrypted: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      });
      return rows.map((r) => ({ id: r.id, value: r.dateOfBirthEncrypted }));
    }),
  );

  // ── Connection.credential (nullable) — CONNECTION_CREDENTIAL ─────────────────
  // Expected v2-only by construction (born with encryptWithPurpose); audited to
  // prove zero v1.
  results.push(
    await scanField("Connection.credential", async (afterId) => {
      const rows = await db.connection.findMany({
        where: afterId ? { id: { gt: afterId } } : undefined,
        select: { id: true, credential: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      });
      return rows.map((r) => ({ id: r.id, value: r.credential }));
    }),
  );

  // ── Report ──────────────────────────────────────────────────────────────────
  const LABEL_W = 28;
  console.log("");
  console.log(
    pad("table.field", LABEL_W) +
      ["v1", "v2", "invalid", "null", "total"].map((h) => rjust(h, 9)).join(""),
  );
  console.log("-".repeat(72));

  const grand = emptyCounts();
  for (const { label, counts } of results) {
    console.log(
      pad(label, LABEL_W) +
        num(counts.v1, 9) +
        num(counts.v2, 9) +
        num(counts.invalid, 9) +
        num(counts.null, 9) +
        num(counts.total, 9),
    );
    grand.v1 += counts.v1;
    grand.v2 += counts.v2;
    grand.invalid += counts.invalid;
    grand.null += counts.null;
    grand.total += counts.total;
  }

  console.log("-".repeat(72));
  console.log(
    pad("TOTAL", LABEL_W) +
      num(grand.v1, 9) +
      num(grand.v2, 9) +
      num(grand.invalid, 9) +
      num(grand.null, 9) +
      num(grand.total, 9),
  );

  console.log("");
  console.log(`Legacy v1 ciphertexts remaining (KD-6 debt): ${grand.v1}`);
  if (grand.invalid > 0) {
    console.log(
      `WARNING: ${grand.invalid} value(s) are neither v1 nor v2 — investigate ` +
        `before any re-encryption (Slice 5b).`,
    );
  }
  if (grand.v1 === 0 && grand.invalid === 0) {
    console.log("All stored ciphertexts are v2. KD-6 re-encryption backlog is empty.");
  }
  console.log("");
  console.log("READ-ONLY audit — no rows were read for decryption and none were modified.");
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Audit failed to complete:", err);
    await db.$disconnect();
    process.exit(1);
  });
