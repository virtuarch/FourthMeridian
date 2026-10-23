/**
 * scripts/audit-crypto-holding-tombstone.ts   (W5 — Crypto Current-Value Authority)
 *
 * THE LEGACY-HOLDING TOMBSTONE SCAN. Source-only, no database.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * THERE IS EXACTLY ONE CURRENT-VALUE AUTHORITY FOR POSITIONS — CRYPTO
 * INCLUDED — AND NO PRODUCTION READ PATH TOUCHES THE LEGACY `Holding` TABLE.
 *
 * W5 executed the deletion conditions P2-4/P2-5/P2-6 wrote for themselves:
 * the crypto-only bridge (lib/investments/legacy-crypto-holdings.ts), the
 * CANONICAL-WINS dedup rule (lib/investments/canonical-precedence.core.ts),
 * btc-sync's wallet `Holding` dual-write, and the export's `crypto-compat`
 * source are all GONE. Current positions — wallets included — are
 * PositionObservations read through `getCurrentPositions()` and valued at
 * DATED archive prices; a wallet with no spine observation is honestly absent
 * (position-unknown), never back-filled from a legacy row and never re-valued
 * from an undated sync-time spot quote.
 *
 * What legitimately remains, and is pinned as the ONLY remainder:
 *   - lib/investments/sync-current-holdings.ts — the reader-less brokerage
 *     `Holding` PROJECTION WRITER (its internal findMany serves its own write
 *     reconciliation, not a consumer). Kept per its own documented reasons
 *     (SyncCounts evidence + flag-off rollback posture); its retirement has
 *     its own recorded DELETION CONDITION.
 *   - prisma/schema.prisma still defines `Holding` — table retirement belongs
 *     to the migration train, exactly like the goals models.
 *
 * ── Mechanics ───────────────────────────────────────────────────────────────
 * Non-test source, comments stripped (tombstone comments are encouraged and
 * never counted), prisma/ excluded. Product roots (lib/ app/ components/
 * jobs/ types/ context/) are held to the accessor invariant; scripts/ is
 * additionally scanned for the retired identifiers (ops row-count tools may
 * count holding rows; they may not resurrect the retired read surface).
 *
 * Tier: REQUIRED — corpus-independent (source is the corpus). ✗ ⇒ exit 1.
 *
 * Run: npx tsx scripts/audit-crypto-holding-tombstone.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const PRODUCT_ROOTS = ["lib", "app", "components", "jobs", "types", "context"];
const ALL_ROOTS = [...PRODUCT_ROOTS, "scripts"];

/** The retired vocabulary — identifiers only; prose in comments never matches. */
const TOMBSTONED = [
  "readLegacyCryptoWalletPositions", "LegacyCryptoPosition",
  "toExportHoldingFromLegacyCrypto", "excludeCanonicalAccounts",
  "excludeCanonicalCryptoAccounts", "CryptoHoldingsInput", "writeBtcHolding",
] as const;
const RE_TOMBSTONE = new RegExp(`\\b(${TOMBSTONED.join("|")})\\b`);
/** The retired export source literal (string, so scanned raw but comment-stripped). */
const RE_CRYPTO_COMPAT = /["']crypto-compat["']/;

/** Any Prisma `holding` accessor: reads AND writes. */
const RE_HOLDING_ACCESSOR = /\.holding\.(findMany|findFirst|findUnique|aggregate|groupBy|count|upsert|create|createMany|update|updateMany|delete|deleteMany)\b/;

/** The one sanctioned toucher (writer + its internal write-plan read). */
const ACCESSOR_ALLOWLIST = new Set([
  path.join("lib", "investments", "sync-current-holdings.ts"),
]);

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) {
      if (childRel.includes("prototype")) continue;
      out.push(...walk(childRel));
      continue;
    }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    if (childRel === path.join("scripts", "audit-crypto-holding-tombstone.ts")) continue;
    out.push(childRel);
  }
  return out;
}

/** Strip block + line comments so tombstone documentation never trips the scan. */
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

function main(): void {
  console.log(`\n[AUDIT] crypto Holding tombstone — one current-value authority; no legacy Holding read path\n`);

  // 1. No production `holding` accessor outside the one sanctioned writer.
  const accessorOffenders: string[] = [];
  for (const f of PRODUCT_ROOTS.flatMap(walk)) {
    if (ACCESSOR_ALLOWLIST.has(f)) continue;
    const m = code(f).match(RE_HOLDING_ACCESSOR);
    if (m) accessorOffenders.push(`${f} — ${m[0]}`);
  }
  check("no production `holding` accessor outside lib/investments/sync-current-holdings.ts",
    accessorOffenders.length === 0, accessorOffenders.slice(0, 10).join("\n      "));

  // …and the sanctioned writer really is write-shaped: its only read is the
  // reconciliation findMany that feeds its own plan.
  const writer = code(path.join("lib", "investments", "sync-current-holdings.ts"));
  check("sync-current-holdings remains a projection writer (plan-read + writes only)",
    /\.holding\.findMany\(/.test(writer) && !/\.holding\.(findFirst|findUnique|aggregate|groupBy)\b/.test(writer));

  // 2. The retired vocabulary is gone from every root (scripts included).
  const vocabOffenders: string[] = [];
  for (const f of ALL_ROOTS.flatMap(walk)) {
    const c = code(f);
    const m = c.match(RE_TOMBSTONE) ?? (RE_CRYPTO_COMPAT.test(c) ? ["crypto-compat"] : null);
    if (m) {
      const line = c.slice(0, c.indexOf(m[0])).split("\n").length;
      vocabOffenders.push(`${f}:${line} — ${m[0]}`);
    }
  }
  check("no non-test source speaks the retired legacy-crypto vocabulary",
    vocabOffenders.length === 0, vocabOffenders.slice(0, 10).join("\n      "));

  // 3. The deletion set stays deleted.
  for (const gone of [
    "lib/investments/legacy-crypto-holdings.ts",
    "lib/investments/canonical-precedence.core.ts",
  ]) {
    let exists = true;
    try { statSync(path.join(ROOT, gone)); } catch { exists = false; }
    check(`${gone} stays deleted`, !exists);
  }

  // 4. The canonical seam is what the two former bridge consumers read.
  const aiBinding = code(path.join("lib", "ai", "assemblers", "holdings.ts"));
  const exportAsm = code(path.join("lib", "export", "assemble.ts"));
  check("AI holdings assembler reads getCurrentPositions (and no bridge)",
    /getCurrentPositions\(/.test(aiBinding) && !/legacy-crypto/.test(aiBinding));
  check("data export reads getCurrentPositions (and no bridge)",
    /getCurrentPositions\(/.test(exportAsm) && !/legacy-crypto/.test(exportAsm));

  // 5. Schema residue is EXACTLY the expected one: `Holding` remains until the
  //    migration train drops it — when it vanishes, the last writer went with
  //    it; retire this clause (and the writer allowlist) together.
  const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  check("schema still carries the Holding model (migration-train residue; retire clause with the train)",
    /model Holding /.test(schema));

  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} crypto-Holding tombstone check(s) violated.\n`);
    process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — one current-value authority; the legacy Holding read surface stays dead. ✓\n`);
}

main();
