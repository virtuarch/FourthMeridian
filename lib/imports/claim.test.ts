/**
 * lib/imports/claim.test.ts  (IDEMP-001 · SEC-007 · OPS-007)
 *
 * The import idempotency key and its caps, over a fake client that enforces
 * the partial unique index ImportBatch_account_file_live_key the way Postgres
 * does (23505 ⇒ Prisma P2002). Standalone tsx (house pattern):
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/imports/claim.test.ts
 *
 *   1. two concurrent claims for the same (account, file) ⇒ one batch, the
 *      loser learns the winner's id (the route's 409);
 *   2. a different file, or the same file into another account, is not blocked;
 *   3. after a ROLLED_BACK (or FAILED) batch the same file claims again;
 *      a PROCESSING / COMPLETED batch still blocks;
 *   4. rollbackClaimWhere admits a stalled PROCESSING batch only past the budget;
 *   5. caps and chunking are what the route relies on;
 *   6. source scans: the route claims before parsing, declares maxDuration,
 *      refuses oversize bytes and rows; the rollback route uses the shared
 *      predicate; the migration's predicate mirrors IMPORT_LIVE_STATUSES.
 */

import { readFileSync } from "node:fs";
import { ImportBatchStatus, ImportSource } from "@prisma/client";
import {
  claimImportBatch, chunkRows, rollbackClaimWhere, sha256Hex, stalledImportCutoff,
  IMPORT_BUDGET_MS, IMPORT_CHUNK_ROWS, IMPORT_LIVE_STATUSES, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, IMPORT_STALL_SLACK_MS,
  type ImportClaimClient,
} from "@/lib/imports/claim";

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

// ── A fake that enforces the partial unique index ────────────────────────────

type Row = { id: string; financialAccountId: string; fileSha256: string | null; status: ImportBatchStatus; createdAt: Date };

function makeFake() {
  const rows: Row[] = [];
  let seq = 0;
  const yieldTick = () => new Promise<void>((r) => setImmediate(r));
  const live = (r: Row) => r.fileSha256 !== null && IMPORT_LIVE_STATUSES.includes(r.status);
  const client: ImportClaimClient = {
    importBatch: {
      async create({ data }) {
        await yieldTick(); // the round trip — lets two claims interleave
        const conflict = rows.some((r) => live(r) && r.financialAccountId === data.financialAccountId && r.fileSha256 === data.fileSha256);
        if (conflict) throw Object.assign(new Error("Unique constraint failed on the fields: (`financialAccountId`,`fileSha256`)"), { code: "P2002" });
        const row: Row = { id: `b${++seq}`, financialAccountId: data.financialAccountId as string, fileSha256: (data.fileSha256 as string | null) ?? null, status: (data.status as ImportBatchStatus) ?? ImportBatchStatus.PENDING, createdAt: new Date() };
        rows.push(row);
        return { id: row.id };
      },
      async findFirst({ where }) {
        const statuses = (where.status as { in: ImportBatchStatus[] }).in;
        const r = rows.find((x) => x.financialAccountId === where.financialAccountId && x.fileSha256 === where.fileSha256 && statuses.includes(x.status));
        return r ? { id: r.id, status: r.status, createdAt: r.createdAt } : null;
      },
    },
  };
  return { client, rows, setStatus: (id: string, status: ImportBatchStatus) => { rows.find((r) => r.id === id)!.status = status; } };
}

const input = (acct = "acct_1", sha = "a".repeat(64)) => ({
  financialAccountId: acct, createdByUserId: "u1", source: ImportSource.CSV, originalFilename: "statement.csv", fileSha256: sha,
});

async function main() {
  console.log("1. concurrent double submit ⇒ one batch");
  {
    const f = makeFake();
    const [a, b] = await Promise.all([claimImportBatch(f.client, input()), claimImportBatch(f.client, input())]);
    const wins = [a, b].filter((r) => r.ok);
    const loses = [a, b].filter((r) => !r.ok);
    check("exactly one claim wins", wins.length === 1 && loses.length === 1);
    check("exactly one batch row exists", f.rows.length === 1);
    check("the loser reports duplicate with the winner's id and status",
      !loses[0].ok && loses[0].reason === "duplicate" && loses[0].existing?.id === (wins[0] as { batchId: string }).batchId && loses[0].existing?.status === "PENDING");
  }

  console.log("\n2. the key is (account, bytes)");
  {
    const f = makeFake();
    await claimImportBatch(f.client, input());
    check("a different file into the same account claims", (await claimImportBatch(f.client, input("acct_1", "b".repeat(64)))).ok);
    check("the same file into another account claims", (await claimImportBatch(f.client, input("acct_2"))).ok);
    check("the same file again is refused", !(await claimImportBatch(f.client, input())).ok);
    check("sha256Hex is the hex digest of the bytes", sha256Hex(new TextEncoder().encode("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  }

  console.log("\n3. a rolled-back or failed batch frees the slot; a live one holds it");
  {
    const f = makeFake();
    const first = await claimImportBatch(f.client, input());
    const id = (first as { batchId: string }).batchId;
    for (const s of [ImportBatchStatus.PROCESSING, ImportBatchStatus.COMPLETED, ImportBatchStatus.COMPLETED_WITH_ERRORS]) {
      f.setStatus(id, s);
      check(`${s} still blocks a re-import`, !(await claimImportBatch(f.client, input())).ok);
    }
    f.setStatus(id, ImportBatchStatus.ROLLED_BACK);
    const again = await claimImportBatch(f.client, input());
    check("ROLLED_BACK frees the slot (retry after a 409 + rollback)", again.ok);
    const f2 = makeFake();
    f2.setStatus((await claimImportBatch(f2.client, input()) as { batchId: string }).batchId, ImportBatchStatus.FAILED);
    check("FAILED frees the slot", (await claimImportBatch(f2.client, input())).ok);
  }

  console.log("\n4. rollback eligibility — a stalled PROCESSING batch past the budget");
  {
    const now = new Date("2026-10-22T10:00:00Z");
    const w = rollbackClaimWhere("b1", now);
    const or = w.OR as Array<Record<string, unknown>>;
    check("terminal statuses stay eligible", JSON.stringify((or[0].status as { in: string[] }).in) === JSON.stringify(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"]));
    check("PENDING/PROCESSING are eligible only when updatedAt is older than budget + slack",
      JSON.stringify((or[1].status as { in: string[] }).in) === JSON.stringify(["PENDING", "PROCESSING"])
      && (or[1].updatedAt as { lt: Date }).lt.getTime() === now.getTime() - IMPORT_BUDGET_MS - IMPORT_STALL_SLACK_MS);
    check("stalledImportCutoff is budget + slack before now", stalledImportCutoff(now).getTime() === now.getTime() - 360_000);
  }

  console.log("\n5. caps and chunking");
  {
    check("byte cap 10 MB, row cap 10,000, budget 300 s", IMPORT_MAX_BYTES === 10 * 1024 * 1024 && IMPORT_MAX_ROWS === 10_000 && IMPORT_BUDGET_MS === 300_000);
    const chunks = chunkRows(Array.from({ length: 450 }, (_, i) => i));
    check(`chunks of ${IMPORT_CHUNK_ROWS}: 450 rows ⇒ 200/200/50 in order`, chunks.length === 3 && chunks[0].length === 200 && chunks[2].length === 50 && chunks[2][0] === 400);
    check("empty input ⇒ no chunks", chunkRows([]).length === 0);
  }

  console.log("\n6. source: the route, the rollback route, the migration");
  {
    const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    const route = strip("app/api/accounts/[id]/import/route.ts");
    check("route declares maxDuration = 300", /export const maxDuration = 300/.test(route));
    const iClaim = route.indexOf("claimImportBatch(");
    const iParse = route.indexOf("runImportPipeline(");
    const iHash = route.indexOf("sha256Hex(");
    check("route hashes, then CLAIMS, then parses (claim before parse)", iHash > 0 && iClaim > iHash && iParse > iClaim, `hash@${iHash} claim@${iClaim} parse@${iParse}`);
    check("route answers 409 duplicate-import with the existing batch id", /status: 409/.test(route) && /"duplicate-import"/.test(route) && /claim\.existing\?\.id/.test(route));
    check("route refuses oversize bytes with 413 BEFORE reading them", /file\.size > IMPORT_MAX_BYTES/.test(route) && route.indexOf("IMPORT_MAX_BYTES") < route.indexOf("arrayBuffer()"));
    check("route refuses oversize row counts and marks the claimed batch FAILED", /rows\.length > IMPORT_MAX_ROWS/.test(route) && /failBatch\(reason\)/.test(route));
    check("route writes rows in chunks with a per-row fallback", /chunkRows\(rows\)/.test(route) && /importRow\(tenant, row/.test(route) && /catch \(rowErr\)/.test(route));
    const rollback = strip("app/api/imports/[id]/rollback/route.ts");
    check("rollback route claims through rollbackClaimWhere", /where: rollbackClaimWhere\(batch\.id, new Date\(\)\)/.test(rollback));
    const migration = readFileSync("prisma/migrations/20261022000100_import_batch_file_sha256/migration.sql", "utf8");
    const predicate = migration.match(/"status" IN \(([^)]*)\)/)?.[1].replace(/['\s]/g, "").split(",") ?? [];
    check("the migration's partial-unique predicate mirrors IMPORT_LIVE_STATUSES", JSON.stringify(predicate) === JSON.stringify([...IMPORT_LIVE_STATUSES]), predicate.join());
    check("the index is UNIQUE on (financialAccountId, fileSha256)", /CREATE UNIQUE INDEX "ImportBatch_account_file_live_key"\s+ON "ImportBatch" \("financialAccountId", "fileSha256"\)/.test(migration));
    const excel = strip("lib/imports/excel.ts");
    check("the XLSX parser bounds the inflated size BEFORE ExcelJS loads", excel.indexOf("readZipBounds(") > 0 && excel.indexOf("readZipBounds(") < excel.indexOf("workbook.xlsx.load("));
  }

  if (failures > 0) { console.error(`\n❌ import claim: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ import claim: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
