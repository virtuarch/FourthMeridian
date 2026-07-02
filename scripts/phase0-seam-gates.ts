/**
 * scripts/phase0-seam-gates.ts
 *
 * v2.5-A Phase 0 — seam-retirement readiness count gates. READ-ONLY.
 * See docs/investigations/V25A_PHASE0_SEAM_RETIREMENT_READINESS.md §2.
 *
 * Run against dev:   npx tsx scripts/phase0-seam-gates.ts
 * Run against prod:  DATABASE_URL=<prod-url> npx tsx scripts/phase0-seam-gates.ts
 *
 * Gates:
 *   A — Holding rows anchored to legacy Account (accountId set, financialAccountId null)
 *   B — Transaction rows anchored to legacy Account (same shape)
 *   C — legacy Account rows (total + non-deleted)
 *   D — WorkspaceAccountShare rows NOT mirrored into SpaceAccountLink
 *   E — SHARED visibility residue on SpaceAccountLink and legacy Account
 *
 * Decision rule:
 *   A=B=C=0 (prod)  → Phase 5 (Account drop) in-scope; else DEFERRED.
 *   D=0             → Phase 4 (WAS drop) may proceed.
 *   E(Account)>0    → VisibilityLevel.SHARED enum removal stays coupled to Phase 5.
 *
 * This script performs no writes of any kind.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function pass(n: number): string {
  return n === 0 ? "✅ PASS (0)" : `❌ BLOCKING (${n})`;
}

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/\/\/[^@]*@/, "//***@").split("?")[0];
  console.log(`Phase 0 seam gates — ${new Date().toISOString()}`);
  console.log(`Database: ${dbHost || "(DATABASE_URL not set)"}\n`);

  // ── Gate A — legacy-anchored holdings ──────────────────────────────────────
  const gateA = await prisma.holding.count({
    where: { accountId: { not: null }, financialAccountId: null },
  });
  // Context: dual-anchored rows (both FKs set) and fully-orphaned rows (neither)
  const holdingBoth = await prisma.holding.count({
    where: { accountId: { not: null }, financialAccountId: { not: null } },
  });
  const holdingNeither = await prisma.holding.count({
    where: { accountId: null, financialAccountId: null },
  });

  // ── Gate B — legacy-anchored transactions ──────────────────────────────────
  const gateB = await prisma.transaction.count({
    where: { accountId: { not: null }, financialAccountId: null },
  });
  const txnBoth = await prisma.transaction.count({
    where: { accountId: { not: null }, financialAccountId: { not: null } },
  });
  const txnNeither = await prisma.transaction.count({
    where: { accountId: null, financialAccountId: null },
  });

  // ── Gate C — legacy Account rows ───────────────────────────────────────────
  const gateCTotal = await prisma.account.count();
  const gateCLive = await prisma.account.count({ where: { deletedAt: null } });

  // ── Gate D — WAS rows not mirrored into SAL ────────────────────────────────
  // WAS physical column is "workspaceId"; SAL physical column is "spaceId".
  // Raw SQL (not the Prisma delegate): the WorkspaceAccountShare model was
  // dropped from the schema in v2.5-A Phase 4c, so the delegate no longer
  // exists. Against a database where the migration has already been applied
  // (table gone), Gate D reports RETIRED and passes vacuously.
  let gateD = 0;
  let gateDDrift = 0;
  let wasTotal = 0;
  let wasDropped = false;
  try {
    const gateDRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "WorkspaceAccountShare" was
      WHERE NOT EXISTS (
        SELECT 1 FROM "SpaceAccountLink" sal
        WHERE sal."spaceId" = was."workspaceId"
          AND sal."financialAccountId" = was."financialAccountId"
      )`;
    gateD = Number(gateDRows[0].count);
    const wasTotalRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "WorkspaceAccountShare"`;
    wasTotal = Number(wasTotalRows[0].count);
    // Mirror fidelity: mirrored pairs whose status or visibility disagree.
    const gateDDriftRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "WorkspaceAccountShare" was
      JOIN "SpaceAccountLink" sal
        ON sal."spaceId" = was."workspaceId"
       AND sal."financialAccountId" = was."financialAccountId"
      WHERE sal."status" <> was."status"
         OR sal."visibilityLevel" <> was."visibilityLevel"`;
    gateDDrift = Number(gateDDriftRows[0].count);
  } catch (e) {
    // 42P01 undefined_table → the retirement migration has been applied here.
    const msg = String(e);
    if (msg.includes("42P01") || (msg.includes("WorkspaceAccountShare") && msg.includes("does not exist"))) {
      wasDropped = true;
    } else {
      throw e;
    }
  }
  const salTotal = await prisma.spaceAccountLink.count();

  // ── Gate E — SHARED visibility residue ─────────────────────────────────────
  const gateESal = await prisma.spaceAccountLink.count({
    where: { visibilityLevel: "SHARED" },
  });
  const gateEAccount = await prisma.account.count({
    where: { visibilityLevel: "SHARED" },
  });

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log("Gate A — Holding legacy anchors (accountId set, financialAccountId null)");
  console.log(`   ${pass(gateA)}   [context: both FKs set: ${holdingBoth}, neither: ${holdingNeither}]`);
  console.log("Gate B — Transaction legacy anchors (accountId set, financialAccountId null)");
  console.log(`   ${pass(gateB)}   [context: both FKs set: ${txnBoth}, neither: ${txnNeither}]`);
  console.log("Gate C — legacy Account rows");
  console.log(`   ${pass(gateCTotal)}   [total: ${gateCTotal}, non-deleted: ${gateCLive}]`);
  console.log("Gate D — WAS rows not mirrored into SAL (blocks WAS drop)");
  if (wasDropped) {
    console.log(`   ✅ RETIRED — WorkspaceAccountShare table already dropped (Phase 4c applied)   [SAL total: ${salTotal}]`);
  } else {
    console.log(`   ${pass(gateD)}   [WAS total: ${wasTotal}, SAL total: ${salTotal}, mirrored-but-drifted (status/visibility): ${gateDDrift}]`);
  }
  console.log("Gate E — SHARED visibility residue (blocks enum-value removal only)");
  console.log(`   SpaceAccountLink: ${pass(gateESal)}   Account: ${pass(gateEAccount)}`);

  console.log("\nDecision:");
  console.log(`   Phase 4 (WAS drop):      ${wasDropped ? "DONE (applied)" : gateD === 0 && gateDDrift === 0 ? "CLEAR to prepare" : "BLOCKED — un-mirrored/drifted WAS rows"}`);
  console.log(`   Phase 5 (Account drop):  ${gateA === 0 && gateB === 0 && gateCTotal === 0 ? "CLEAR (pending approval)" : "DEFERRED — legacy anchors present"}`);
  console.log(`   SHARED enum removal:     ${gateESal === 0 && gateEAccount === 0 ? "unblocked (rides with Phase 5 regardless)" : "BLOCKED — SHARED rows exist"}`);
}

main()
  .catch((e) => { console.error("❌  Gate script failed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
