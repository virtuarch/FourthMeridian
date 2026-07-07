/**
 * scripts/backfill-merchant-intelligence.ts
 *
 * Merchant Intelligence — M3 historical backfill (OFFLINE migration utility).
 *
 * Populates Merchant Intelligence data for HISTORICAL transactions without
 * touching live sync/import behavior. For each unprocessed row it:
 *   1. runs the M2 resolver (lib/transactions/merchant-resolver.ts) — reused,
 *      NOT duplicated — to normalize the merchant and resolve category+source;
 *   2. mints a Merchant (and one MerchantAlias) when necessary, or reuses the
 *      existing one; and
 *   3. stamps `merchantId` and — only when the resolver confirms the already
 *      stored category — `categorySource`.
 *
 * It NEVER overwrites an existing merchant assignment, a USER_RULE /
 * USER_OVERRIDE (manual) provenance, or the stored `category` VALUE. The write
 * decision is the pure planner `computeBackfillPlan` (lib/transactions/
 * merchant-backfill.ts); this script only wires it to the database. See that
 * module's header for the full safety doctrine (no offline category rewrite →
 * no flow-desync risk).
 *
 * ── House backfill pattern (mirrors scripts/backfill-flowtype.ts) ────────────
 *   • Dry-run is the DEFAULT; `--apply` is required to write.
 *   • Keyset pagination by id — resume-safe, drift-free.
 *   • Idempotent: selection predicate is `merchantId IS NULL`, so a re-run finds
 *     only rows not yet processed; after a full apply a re-run reports 0.
 *   • Writes go through a per-row transaction: Merchant/MerchantAlias via
 *     UPSERT (unique-constraint-safe, no duplicates) and the transaction's MI
 *     columns via a PARAMETERIZED RAW UPDATE guarded by `merchantId IS NULL`,
 *     which deliberately does NOT bump `updatedAt` and touches no other column.
 *
 * Run:
 *   npx tsx scripts/backfill-merchant-intelligence.ts [--batch=N] [--limit=N] [--exclude-deleted] [--verbose]
 *   npx tsx scripts/backfill-merchant-intelligence.ts --apply [--batch=N] [--limit=N] [--exclude-deleted]
 */

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { resolveMerchant } from "@/lib/transactions/merchant-resolver";
import { computeBackfillPlan, type ExistingIdentity } from "@/lib/transactions/merchant-backfill";

const argv = process.argv.slice(2);

function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const APPLY           = argv.includes("--apply");
const EXCLUDE_DELETED = argv.includes("--exclude-deleted");
const VERBOSE         = argv.includes("--verbose");
const BATCH           = intFlag("--batch", 500);
const LIMIT           = intFlag("--limit", Number.POSITIVE_INFINITY);

/** Look up an existing merchant + alias for a row's normalized identity. */
async function lookupExisting(
  canonicalKey: string,
  aliasKey: string,
  plaidEntityId: string | null,
): Promise<ExistingIdentity> {
  // Alias is the strongest signal: it names both existence and the merchant.
  const aliasRow = await db.merchantAlias.findUnique({
    where: { aliasKey },
    select: { merchantId: true },
  });
  if (aliasRow) return { existingMerchant: { id: aliasRow.merchantId }, aliasExists: true };

  // Else resolve the merchant by its stable provider id, then canonical key.
  if (plaidEntityId) {
    const byEntity = await db.merchant.findUnique({ where: { plaidEntityId }, select: { id: true } });
    if (byEntity) return { existingMerchant: byEntity, aliasExists: false };
  }
  const byKey = await db.merchant.findUnique({ where: { canonicalKey }, select: { id: true } });
  return { existingMerchant: byKey, aliasExists: false };
}

async function main(): Promise<void> {
  const where: Prisma.TransactionWhereInput = EXCLUDE_DELETED
    ? { AND: [{ merchantId: null }, { deletedAt: null }] }
    : { merchantId: null };

  console.log(
    `\n${APPLY ? "[APPLY] MI backfill — WRITING merchant identity + provenance" : "[DRY RUN] MI backfill — READ-ONLY, no writes"}`,
  );
  console.log(
    `Selection: merchantId IS NULL${EXCLUDE_DELETED ? " (excluding soft-deleted)" : " (including soft-deleted)"}`,
  );
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  let scanned = 0;
  let minted = 0;
  let reused = 0;
  let aliasesCreated = 0;
  let stamped = 0;
  const bySource: Record<string, number> = {};
  let lastId = "";
  // Tracks merchants minted this run so dry-run counters (and within-batch
  // reuse) reflect true mint/reuse counts even before commits are visible.
  const seenKeys = new Map<string, string>();

  while (scanned < LIMIT) {
    const take = Math.min(BATCH, LIMIT - scanned);
    const rows = await db.transaction.findMany({
      where: lastId ? { AND: [where, { id: { gt: lastId } }] } : where,
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        merchant: true,
        description: true,
        category: true,
        categorySource: true,
        merchantId: true,
        merchantEntityId: true,
        pfcPrimary: true,
        pfcDetailed: true,
        pfcConfidenceLevel: true,
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const resolution = resolveMerchant({
        merchant: r.merchant,
        description: r.description,
        merchantEntityId: r.merchantEntityId,
        provider: {
          pfcPrimary: r.pfcPrimary,
          pfcDetailed: r.pfcDetailed,
          pfcConfidenceLevel: r.pfcConfidenceLevel,
        },
      });

      const { canonicalKey, displayName } = resolution.merchant;
      const aliasKey = resolution.alias.aliasKey;

      // In-run reuse: prefer a merchant already minted this run for this key.
      const already = seenKeys.get(canonicalKey);
      const existing = already
        ? { existingMerchant: { id: already }, aliasExists: true }
        : await lookupExisting(canonicalKey, aliasKey, r.merchantEntityId);

      const plan = computeBackfillPlan(
        {
          id: r.id,
          category: r.category,
          categorySource: r.categorySource,
          merchantId: r.merchantId,
          merchantEntityId: r.merchantEntityId,
        },
        resolution,
        existing,
      );

      if (plan.mintMerchant) minted++; else if (plan.assignMerchant) reused++;
      if (plan.createAlias) aliasesCreated++;
      if (plan.setCategorySource) {
        stamped++;
        bySource[plan.setCategorySource] = (bySource[plan.setCategorySource] ?? 0) + 1;
      }

      if (APPLY && !plan.skip) {
        await db.$transaction(async (tx) => {
          let merchantId = plan.reuseMerchantId;
          if (plan.mintMerchant) {
            const m = await tx.merchant.upsert({
              where: { canonicalKey: plan.mintMerchant.canonicalKey },
              create: {
                canonicalKey: plan.mintMerchant.canonicalKey,
                displayName: plan.mintMerchant.displayName,
                plaidEntityId: plan.mintMerchant.plaidEntityId,
              },
              update: {}, // idempotent: never overwrite an existing merchant's fields
              select: { id: true },
            });
            merchantId = m.id;
          }
          if (plan.createAlias && merchantId) {
            await tx.merchantAlias.upsert({
              where: { aliasKey: plan.createAlias.aliasKey },
              create: {
                aliasKey: plan.createAlias.aliasKey,
                source: plan.createAlias.source,
                merchantId,
              },
              update: {}, // never re-point an existing alias (avoid over-merge)
              select: { id: true },
            });
          }
          // Raw, parameterized update of ONLY the MI columns. Guarded by
          // `merchantId IS NULL` so it is idempotent and can never overwrite an
          // existing assignment; deliberately does NOT bump updatedAt.
          if (plan.assignMerchant && plan.setCategorySource) {
            await tx.$executeRaw`
              UPDATE "Transaction"
                 SET "merchantId" = ${merchantId},
                     "categorySource" = ${plan.setCategorySource}::"CategorySource"
               WHERE "id" = ${r.id} AND "merchantId" IS NULL`;
          } else if (plan.assignMerchant) {
            await tx.$executeRaw`
              UPDATE "Transaction"
                 SET "merchantId" = ${merchantId}
               WHERE "id" = ${r.id} AND "merchantId" IS NULL`;
          } else if (plan.setCategorySource) {
            await tx.$executeRaw`
              UPDATE "Transaction"
                 SET "categorySource" = ${plan.setCategorySource}::"CategorySource"
               WHERE "id" = ${r.id} AND "categorySource" IS NULL`;
          }
          if (merchantId) seenKeys.set(canonicalKey, merchantId);
        });
      } else if (plan.mintMerchant) {
        // Dry-run: record the identity so subsequent same-key rows count as reuse.
        seenKeys.set(canonicalKey, `dryrun:${canonicalKey}`);
      }

      if (VERBOSE) {
        console.log(
          `  ${r.id} → merchant=${displayName} (${plan.mintMerchant ? "mint" : plan.assignMerchant ? "reuse" : "keep"})` +
            ` category=${resolution.category ?? "unknown"} source=${plan.setCategorySource ?? "—"}`,
        );
      }

      lastId = r.id;
      scanned++;
    }

    if (rows.length < take) break;
  }

  const fmt = (rec: Record<string, number>) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ") || "none";

  if (scanned === 0) {
    console.log("Nothing to backfill — every row already has a merchantId. ✓");
    return;
  }
  console.log(`Scanned:            ${scanned}${scanned >= LIMIT ? " (--limit reached)" : ""}`);
  console.log(`Merchants minted:   ${minted}`);
  console.log(`Merchants reused:   ${reused}`);
  console.log(`Aliases created:    ${aliasesCreated}`);
  console.log(`categorySource set: ${stamped}  {${fmt(bySource)}}`);
  console.log(
    APPLY
      ? "\nApplied. Re-run with --apply to verify 0 remain (idempotent)."
      : "\nDry run only — no writes. Re-run with --apply to write.",
  );
}

main()
  .catch((err) => {
    console.error("backfill-merchant-intelligence failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
