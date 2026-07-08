/**
 * scripts/merge-wgu-merchants.ts
 *
 * ONE-OFF merchant unification: collapse the four WGU descriptor groups onto a
 * single Merchant. This is an explicit USER correction applied in bulk — the
 * alias re-points use the exact semantics of the M5 correction path
 * (lib/transactions/merchant-corrections.ts `pointAlias`: upsert with
 * `source: USER`), which is the ONLY sanctioned alias re-point in the system
 * (M4 / the M3 backfill never re-point). Plus the bounded historical
 * re-point that M5 deliberately does not do (identity column only).
 *
 * What it does (atomically, in one $transaction):
 *   1. Finds the survivor Merchant (canonicalKey of "Western Governors
 *      University") and the duplicate Merchants for the other three raw
 *      descriptor groups — keys computed via normalizeMerchantIdentity, the
 *      same normalizer the resolver uses (no hand-typed keys).
 *   2. Re-points every MerchantAlias owned by a duplicate to the survivor,
 *      stamping `source: USER` (this correction is a human decision).
 *   3. Re-points historical rows: Transaction.merchantId dup → survivor.
 *      NOTHING else on the row changes — merchant (raw descriptor),
 *      category, categorySource, categoryRuleId, flowType are untouched,
 *      so there is zero flow/category desync risk.
 *   4. Moves MerchantRules from dup → survivor; if the survivor already has a
 *      USER rule for the same owner, the dup rule's transactions are
 *      re-pointed to the survivor's rule and the dup rule is deleted
 *      (provenance links preserved; nothing SetNull'd).
 *   5. Transfers plaidEntityId to the survivor if the survivor has none.
 *   6. Deletes the (now empty) duplicate Merchants.
 *
 * Never touches: Transaction.merchant (raw descriptor), category values,
 * flowType, categorySource. No schema changes. Idempotent: a re-run finds no
 * duplicate merchants and reports nothing to do.
 *
 * House pattern (mirrors scripts/backfill-merchant-intelligence.ts):
 *   npx tsx scripts/merge-wgu-merchants.ts            # DRY RUN (default)
 *   npx tsx scripts/merge-wgu-merchants.ts --apply    # write
 */

import { db } from "@/lib/db";
import { normalizeMerchantIdentity } from "@/lib/transactions/merchant-resolver";

const APPLY = process.argv.includes("--apply");

/** Raw descriptor samples — one per observed group. Survivor listed first. */
const SURVIVOR_RAW = "Western Governors University";
const DUPLICATE_RAWS = [
  "Western Governors Un",
  "NBS-WGU*SERVICE FEE",
  "NBSWGUSERVICE FEE 08LINCOLN",
] as const;

async function main(): Promise<void> {
  console.log(
    `\n${APPLY ? "[APPLY] WGU merchant merge — WRITING" : "[DRY RUN] WGU merchant merge — READ-ONLY, no writes"}\n`,
  );

  const survivorKey = normalizeMerchantIdentity(SURVIVOR_RAW).canonicalKey;
  const dupKeys = DUPLICATE_RAWS.map((raw) => normalizeMerchantIdentity(raw).canonicalKey);

  const survivor = await db.merchant.findUnique({
    where: { canonicalKey: survivorKey },
    select: { id: true, canonicalKey: true, displayName: true, plaidEntityId: true },
  });
  if (!survivor) {
    console.error(`Survivor merchant not found (canonicalKey=${survivorKey}). Aborting.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Survivor: ${survivor.displayName} (${survivor.id}) key=${survivor.canonicalKey}`);

  const dups = await db.merchant.findMany({
    where: { canonicalKey: { in: dupKeys }, id: { not: survivor.id } },
    select: {
      id: true,
      canonicalKey: true,
      displayName: true,
      plaidEntityId: true,
      aliases: { select: { id: true, aliasKey: true } },
      rules: { select: { id: true, scope: true, ownerUserId: true, category: true } },
      _count: { select: { transactions: true } },
    },
  });

  if (dups.length === 0) {
    console.log("No duplicate merchants found — nothing to do (already merged?).");
    return;
  }

  for (const d of dups) {
    console.log(
      `Duplicate: ${d.displayName} (${d.id}) key=${d.canonicalKey} — ` +
        `${d.aliases.length} alias(es), ${d.rules.length} rule(s), ${d._count.transactions} transaction(s)` +
        `${d.plaidEntityId ? `, plaidEntityId=${d.plaidEntityId}` : ""}`,
    );
  }
  const missing = dupKeys.filter((k) => !dups.some((d) => d.canonicalKey === k));
  for (const k of missing) console.log(`(note) no merchant row for key=${k} — skipping that group`);

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write.");
    return;
  }

  await db.$transaction(async (tx) => {
    for (const dup of dups) {
      // 1) Re-point aliases (M5 pointAlias semantics: explicit user teach → USER source).
      const aliases = await tx.merchantAlias.updateMany({
        where: { merchantId: dup.id },
        data: { merchantId: survivor.id, source: "USER" },
      });

      // 2) Re-point historical transactions — merchant identity column ONLY.
      const rows = await tx.transaction.updateMany({
        where: { merchantId: dup.id },
        data: { merchantId: survivor.id },
      });

      // 3) Rules: move, or fold into an existing survivor rule for the same owner/scope.
      let rulesMoved = 0;
      let rulesFolded = 0;
      for (const rule of dup.rules) {
        const conflict = await tx.merchantRule.findFirst({
          where: {
            merchantId: survivor.id,
            scope: rule.scope,
            ownerUserId: rule.ownerUserId,
          },
          select: { id: true },
        });
        if (conflict) {
          await tx.transaction.updateMany({
            where: { categoryRuleId: rule.id },
            data: { categoryRuleId: conflict.id },
          });
          await tx.merchantRule.delete({ where: { id: rule.id } });
          rulesFolded++;
        } else {
          await tx.merchantRule.update({
            where: { id: rule.id },
            data: { merchantId: survivor.id },
          });
          rulesMoved++;
        }
      }

      // 4) plaidEntityId: transfer to survivor only if survivor has none (unique column).
      let entityTransferred = false;
      if (dup.plaidEntityId && !survivor.plaidEntityId) {
        await tx.merchant.update({ where: { id: dup.id }, data: { plaidEntityId: null } });
        await tx.merchant.update({
          where: { id: survivor.id },
          data: { plaidEntityId: dup.plaidEntityId },
        });
        survivor.plaidEntityId = dup.plaidEntityId;
        entityTransferred = true;
      } else if (dup.plaidEntityId) {
        console.log(
          `(note) dropping duplicate plaidEntityId=${dup.plaidEntityId} from ${dup.canonicalKey} ` +
            `(survivor already has ${survivor.plaidEntityId}); alias resolution covers future rows`,
        );
      }

      // 5) Delete the now-empty duplicate (no aliases/rules/transactions reference it).
      await tx.merchant.delete({ where: { id: dup.id } });

      console.log(
        `Merged ${dup.canonicalKey}: ${aliases.count} alias(es) re-pointed, ` +
          `${rows.count} transaction(s) re-pointed, ${rulesMoved} rule(s) moved, ` +
          `${rulesFolded} rule(s) folded${entityTransferred ? ", plaidEntityId transferred" : ""}, merchant deleted`,
      );
    }
  });

  // Post-merge verification.
  const remaining = await db.merchant.count({
    where: { canonicalKey: { in: dupKeys }, id: { not: survivor.id } },
  });
  const orphans = await db.transaction.count({
    where: { merchantId: { in: dups.map((d) => d.id) } },
  });
  const survivorAliases = await db.merchantAlias.count({ where: { merchantId: survivor.id } });
  console.log(
    `\nVerification: duplicate merchants remaining=${remaining} (want 0), ` +
      `transactions still on old ids=${orphans} (want 0), survivor aliases=${survivorAliases}`,
  );
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
