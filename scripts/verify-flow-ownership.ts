/**
 * scripts/verify-flow-ownership.ts
 *
 * v2.6-OWN-1 — the before/after proof for the ownership stamp. READ-ONLY.
 *
 *   npx tsx --env-file=.env.local scripts/verify-flow-ownership.ts
 *
 * Prints two fingerprints over the WHOLE corpus (tombstones included), ordered
 * by id so they are stable and comparable across runs:
 *
 *   FINANCIAL   id + flowType + flowDirection + classificationReason +
 *               classificationConfidence + counterpartyAccountId + category +
 *               amount
 *               → the facts that decide every total on every surface. This MUST
 *                 be identical before and after the ownership backfill. If it
 *                 moves, a repair was reverted or a value was rewritten.
 *
 *   OWNERSHIP   id + flowAuthority + classifierVersion
 *               → the metadata the slice intentionally changes.
 *
 * Also prints the per-authority census and the repaired-row roll call, so
 * "previously repaired rows remain repaired" is a statement about named rows
 * rather than a count.
 */

import { createHash } from "node:crypto";

import { db } from "@/lib/db";

/** The rows the transfer-authority repairs corrected, identified BEFORE the
 *  stamp by the one proof available then: the classifier does not reproduce
 *  their stored value. Frozen here so the after-run checks the same 12 rows it
 *  measured, not "whatever disagrees now". */
const REPAIRED_ROW_IDS = [
  "cmrrmeoeq01p47znw3c5kat5v", "cmrrmeofj01pa7znwnmxzttba", "cmrrmeoib01pm7znwav7h4w13",
  "cmrrmmv4h07vg7znwja8sr83a", "cmrrmmvdx07x97znwa74mmzyb", "cmrrmmz7k08017znwqgls8kno",
  "cmrrmmzbd080p7znwlcp71yzv", "cmrrmmzcp08117znwngh24x7y", "cmrrmmzlw08447znw6y6zyhlb",
  "cmrrmmzpk08587znwv4xhm0qp", "cmrrmmzsb086q7znwtj6e5iak", "cmsddr73b001jmv1ld9dwt4v9",
] as const;

function fp(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  const rows = await db.transaction.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true, flowType: true, flowDirection: true,
      classificationReason: true, classificationConfidence: true,
      counterpartyAccountId: true, category: true, amount: true,
      flowAuthority: true, classifierVersion: true,
    },
  });

  const financial = rows.map((r) =>
    `${r.id}|${r.flowType}|${r.flowDirection}|${r.classificationReason}|` +
    `${r.classificationConfidence}|${r.counterpartyAccountId}|${r.category}|${r.amount}`);
  const ownership = rows.map((r) => `${r.id}|${r.flowAuthority}|${r.classifierVersion}`);

  console.log("\n[VERIFY] v2.6-OWN-1 flow ownership — READ-ONLY\n");
  console.log(`  rows                     : ${rows.length}`);
  console.log(`  FINANCIAL fingerprint    : ${fp(financial)}   ← must NOT move`);
  console.log(`  OWNERSHIP fingerprint    : ${fp(ownership)}   ← intentionally moves once`);
  console.log("");

  const census = new Map<string, number>();
  for (const r of rows) {
    const k = r.flowAuthority ?? "(unowned)";
    census.set(k, (census.get(k) ?? 0) + 1);
  }
  console.log("  ownership census:");
  for (const [k, v] of [...census.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  console.log("");

  const byId = new Map(rows.map((r) => [r.id, r]));
  console.log(`  repaired-row roll call (${REPAIRED_ROW_IDS.length} rows the transfer authority corrected):`);
  let missing = 0, misowned = 0;
  for (const id of REPAIRED_ROW_IDS) {
    const r = byId.get(id);
    if (!r) { console.log(`    ${id}  ✗ MISSING FROM CORPUS`); missing++; continue; }
    const owned = r.flowAuthority === "TRANSFER_AUTHORITY";
    if (!owned) misowned++;
    console.log(
      `    ${id}  ${String(r.flowType).padEnd(13)} ${String(r.classificationReason).padEnd(21)} ` +
      `conf=${r.classificationConfidence}  owner=${r.flowAuthority ?? "null"}  ` +
      `ver=${r.classifierVersion ?? "null"}  ${owned ? "✓" : "✗ NOT transfer-authority-owned"}`,
    );
  }
  console.log("");
  if (missing > 0 || misowned > 0) {
    console.error(`[VERIFY] FAILED — ${missing} missing, ${misowned} not owned by the transfer authority.\n`);
    process.exitCode = 1;
    return;
  }
  console.log("[VERIFY] every repaired row survives and is owned by the transfer authority. ✓\n");
}

main()
  .catch((err) => { console.error("verify-flow-ownership failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
