/**
 * scripts/audit-read-identity-consumers.ts   (W1 / D6 — INV-19)
 *
 * THE READ-IDENTITY CONSUMER SCAN. Source-only, no database.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * NO PRODUCT READ DERIVES TRANSACTION IDENTITY FROM A NON-EVENT KEY.
 *
 * Matching keys (the DF-4 raw-descriptor fingerprint, import external-id
 * idempotency) may decide whether a WRITE happens — row adoption on sync,
 * create/match/skip on import. They may never decide what a READ claims:
 * TransactionEvent is the one read-side identity authority, and a surface that
 * presents a fingerprint coincidence as identity re-opens the drawer's
 * "Possible duplicate" defect (two provider-distinct events rendered as one
 * transaction).
 *
 * Wallet/crypto rows stay OUTSIDE the banking event domain entirely — their
 * identity is chain evidence, owned by the crypto domain, never these tables.
 *
 * ── What is checked, mechanically ───────────────────────────────────────────
 *
 *   1. The fingerprint module's importer set is EXACTLY the write-path
 *      allowlist. A new importer — any read surface, assembler, or component —
 *      fails the build until it is either removed or consciously allowlisted
 *      here as a write path.
 *   2. The read-side similarity evidence (RelationshipResolver) defers to event
 *      identity: the cross-event exclusion predicate and the DF-4 raw-descriptor
 *      key are present; the retired identity-verdict shape (resolveDuplicate /
 *      a `duplicate:` output key) is gone.
 *   3. The detail read supplies the facts that make the exclusion possible
 *      (candidate select carries transactionEventId).
 *   4. The retired verdict copy ("Possible duplicate") does not reappear on any
 *      product surface.
 *   5. The banking event domain excludes WALLET/EXCHANGE (the crypto boundary),
 *      and the crypto writers do not import the fingerprint module.
 *
 * Tier: REQUIRED — corpus-independent (source is the corpus). ✗ ⇒ exit 1.
 *
 * Run: npx tsx scripts/audit-read-identity-consumers.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

/**
 * The WRITE paths allowed to consume the fingerprint module. Each entry is a
 * conscious decision, documented where the import lives:
 *   · lib/plaid/syncTransactions.ts — row adoption on sync (DF-4), guarded by
 *     the generalized EVENT-2 provider-identity refusal.
 *   · lib/imports/csv.ts — import create/match/skip idempotency (D2 4C/4D),
 *     matched and ambiguity-checked under the one DF-4 key.
 * Tests may import it freely (they pin its behavior).
 */
const FINGERPRINT_IMPORT_ALLOWLIST = new Set([
  "lib/plaid/syncTransactions.ts",
  "lib/imports/csv.ts",
]);

const SCAN_ROOTS = ["app", "components", "lib", "jobs", "scripts", "prisma", "types", "context"];

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) {
      if (childRel.includes("prototype")) continue; // gitignored design harnesses
      out.push(...walk(childRel));
      continue;
    }
    if (!/\.tsx?$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Strip comments so documentation of a shape never trips a scan for it. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function main(): void {
  console.log(`\n[AUDIT] INV-19 — read surfaces never derive transaction identity from non-event keys\n`);
  const files = SCAN_ROOTS.flatMap(walk);

  // ── 1. Fingerprint importer census ─────────────────────────────────────────
  const importers = files.filter((f) =>
    !/\.test\.tsx?$/.test(f) &&
    f !== "lib/transactions/fingerprint.ts" &&
    /from\s+["']@\/lib\/transactions\/fingerprint["']/.test(code(f)));
  const unexpected = importers.filter((f) => !FINGERPRINT_IMPORT_ALLOWLIST.has(f));
  const missing = [...FINGERPRINT_IMPORT_ALLOWLIST].filter((f) => !importers.includes(f));
  check("the fingerprint module is imported ONLY by the write-path allowlist",
    unexpected.length === 0,
    `unexpected importer(s): ${unexpected.join(", ")} — a read surface must consult TransactionEvent, never a matching key`);
  check("every allowlisted write path still exists and still imports it (allowlist is not stale)",
    missing.length === 0, `stale allowlist entries: ${missing.join(", ")}`);

  // ── 2. Similarity evidence defers to event identity ────────────────────────
  const resolver = code("lib/transactions/RelationshipResolver.ts");
  check("similarity excludes candidates the event ledger distinguishes (cross-event exclusion present)",
    /c\.transactionEventId != null && tx\.transactionEventId != null/.test(resolver),
    "the cross-event exclusion predicate is gone from resolveSimilarity");
  check("similarity keys on the DF-4 raw descriptor (`description ?? merchant`), not the enriched merchant",
    /normalizeMerchantKey\(tx\.description \?\? tx\.merchant\)/.test(resolver) &&
    /normalizeMerchantKey\(c\.description \?\? c\.merchant\)/.test(resolver));
  check("the identity-verdict shape is retired (no resolveDuplicate, no `duplicate:` output key)",
    !/resolveDuplicate|duplicate\s*:/.test(resolver));

  // ── 3. The detail read supplies the exclusion's facts ──────────────────────
  const detailRead = code("lib/data/transactions.ts");
  check("the drawer's candidate select carries transactionEventId (exclusion structurally possible)",
    /transactionEventId:\s*true/.test(detailRead),
    "without it the resolver cannot consult event identity and the exclusion silently disables");

  // ── 4. The retired verdict copy stays retired ──────────────────────────────
  // The exact retired lead ("Possible duplicate — …", the drawer's old
  // transaction-identity verdict). Deliberately NOT a bare "duplicate" scan:
  // account-dedup copy ("Possible duplicate accounts detected") is a different,
  // legitimate claim about a different entity.
  const productFiles = files.filter((f) =>
    !/\.test\.tsx?$/.test(f) && !f.startsWith("scripts") && !f.startsWith("prisma"));
  const verdictCopy = productFiles.filter((f) => /Possible duplicate —/.test(code(f)));
  check(`no product surface renders the retired transaction-identity verdict copy ("Possible duplicate — …")`,
    verdictCopy.length === 0, verdictCopy.join(", "));

  // ── 5. The crypto boundary ─────────────────────────────────────────────────
  const eventIdentity = code("lib/transactions/event-identity.ts");
  check("the banking event domain is exactly {PLAID, MANUAL, CSV} — WALLET/EXCHANGE excluded",
    /new Set\(\["PLAID", "MANUAL", "CSV"\]\)/.test(eventIdentity));
  const cryptoImporters = importers.filter((f) => f.startsWith("lib/crypto"));
  check("no crypto writer imports the fingerprint module",
    cryptoImporters.length === 0, cryptoImporters.join(", "));

  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} INV-19 check(s) violated.\n`);
    process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — event identity is the only read-side transaction identity. ✓\n`);
}

main();
