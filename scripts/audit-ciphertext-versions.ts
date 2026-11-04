/**
 * scripts/audit-ciphertext-versions.ts
 *
 * SEC-1 / KD-6 — Slice 5a. READ-ONLY audit of encryption-at-rest formats.
 *
 * Scans every CIPHER-format field of ENCRYPTED_FIELDS (lib/plaid/encrypted-fields.ts),
 * honouring each field's `scope` (Connection.credential: provider ≠ WALLET, whose
 * descriptor is clear-text by design), and reports, per
 * table.field, how many stored values are (per-KEY-ID counts and the
 * re-encryption itself: scripts/rotate-encryption-key.ts):
 *
 *   v1       legacy root-key format   "iv:authTag:ciphertext"      (KD-6 debt)
 *   v2       purpose-derived format   "v2:iv:authTag:ciphertext"   (no key id; the write format outside a rotation)
 *   v3       keyring format           "v3:kid:iv:authTag:ciphertext" (written only during a key rotation, PRIV-004)
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
import { ENCRYPTED_FIELDS, fieldLabel, scopeWhere } from "@/lib/plaid/encrypted-fields";

const db = new PrismaClient({ log: ["error", "warn"] });

type FindManyDelegate = { findMany(args: unknown): Promise<Array<Record<string, unknown>>> };
/** The Prisma delegate of a registry model (`PlaidItem` → `db.plaidItem`). READ-ONLY use: findMany only. */
function delegateOf(model: string): FindManyDelegate {
  const d = (db as unknown as Record<string, FindManyDelegate | undefined>)[model[0].toLowerCase() + model.slice(1)];
  if (!d) throw new Error(`no Prisma delegate for registry model ${model}`);
  return d;
}

const PAGE_SIZE = 1000;

type Counts = { v1: number; v2: number; v3: number; invalid: number; null: number; total: number };

function emptyCounts(): Counts {
  return { v1: 0, v2: 0, v3: 0, invalid: 0, null: 0, total: 0 };
}

function tally(counts: Counts, value: string | null): void {
  counts.total++;
  if (value === null || value === "") {
    counts.null++;
    return;
  }
  const version: CiphertextVersion = detectCiphertextVersion(value);
  counts[version]++; // "v1" | "v2" | "v3" | "invalid"
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
  console.log("=".repeat(100));

  const results = [];

  // Every CIPHER-format column of the one registry (lib/plaid/encrypted-fields.ts),
  // restricted to the rows that hold ciphertext at all: Connection.credential
  // excludes provider = WALLET, whose public watch-only descriptor is stored in
  // clear by design and would otherwise be miscounted as "invalid". The sealed
  // (compact c1.) column is not a hex-segment format; its key coverage is
  // reported by scripts/rotate-encryption-key.ts (--verify-complete).
  for (const f of ENCRYPTED_FIELDS.filter((x) => x.format === "cipher")) {
    const delegate = delegateOf(f.model);
    results.push(
      await scanField(fieldLabel(f) + (f.scope ? ` (${f.scope.column}≠${f.scope.notEqual})` : ""), async (afterId) => {
        const rows = await delegate.findMany({
          where: { AND: [afterId ? { id: { gt: afterId } } : {}, scopeWhere(f)] },
          select: { id: true, [f.field]: true },
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
        });
        return rows.map((r) => ({ id: String(r.id), value: (r[f.field] as string | null) ?? null }));
      }),
    );
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const LABEL_W = 46;
  console.log("");
  console.log(
    pad("table.field", LABEL_W) +
      ["v1", "v2", "v3", "invalid", "null", "total"].map((h) => rjust(h, 9)).join(""),
  );
  console.log("-".repeat(100));

  const grand = emptyCounts();
  for (const { label, counts } of results) {
    console.log(
      pad(label, LABEL_W) +
        num(counts.v1, 9) +
        num(counts.v2, 9) +
        num(counts.v3, 9) +
        num(counts.invalid, 9) +
        num(counts.null, 9) +
        num(counts.total, 9),
    );
    grand.v1 += counts.v1;
    grand.v2 += counts.v2;
    grand.v3 += counts.v3;
    grand.invalid += counts.invalid;
    grand.null += counts.null;
    grand.total += counts.total;
  }

  console.log("-".repeat(100));
  console.log(
    pad("TOTAL", LABEL_W) +
      num(grand.v1, 9) +
      num(grand.v2, 9) +
      num(grand.v3, 9) +
      num(grand.invalid, 9) +
      num(grand.null, 9) +
      num(grand.total, 9),
  );

  console.log("");
  console.log(`Legacy v1 ciphertexts remaining (KD-6 debt): ${grand.v1}`);
  if (grand.invalid > 0) {
    console.log(
      `WARNING: ${grand.invalid} value(s) are neither v1, v2 nor v3 — investigate ` +
        `before any re-encryption (Slice 5b).`,
    );
  }
  if (grand.v1 === 0 && grand.invalid === 0) {
    console.log("No v1 and no invalid ciphertexts. KD-6 re-encryption backlog is empty.");
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
