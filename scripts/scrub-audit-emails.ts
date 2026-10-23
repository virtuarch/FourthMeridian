/**
 * scripts/scrub-audit-emails.ts  (PRIV-002 — historical residue, OWNER-RUN)
 *
 * Replaces raw e-mail addresses left in AuditLog.metadata by writers that
 * pre-date the remediation (`email`, `targetEmail`) with their digests, using the
 * pure rule in lib/audit-scrub/email-metadata.ts. Only `metadata` is rewritten;
 * id, action, userId and createdAt are preserved.
 *
 * SAFETY:
 *   - dry-run by DEFAULT (counts and a sample of row ids; zero writes);
 *   - `--apply` writes; take a backup first and run it deliberately against each
 *     environment — this program never ran it against Preview or Production;
 *   - FM_DB_GUARD / scripts/db-guard.ts rules apply as for every script.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/scrub-audit-emails.ts            # dry run
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/scrub-audit-emails.ts --apply    # write
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decideEmailScrub } from "@/lib/audit-scrub/email-metadata";

const APPLY = process.argv.slice(2).includes("--apply");
const BATCH = 500;

async function main(): Promise<void> {
  let cursor: string | undefined;
  let scanned = 0, candidates = 0, written = 0;
  const sample: string[] = [];
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: { OR: [{ metadata: { path: ["email"], not: Prisma.AnyNull } }, { metadata: { path: ["targetEmail"], not: Prisma.AnyNull } }] },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, metadata: true },
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      scanned++;
      const d = decideEmailScrub(r.metadata);
      if (d.kind === "skip") continue;
      candidates++;
      if (sample.length < 10) sample.push(r.id);
      if (APPLY) {
        await db.auditLog.update({ where: { id: r.id }, data: { metadata: d.metadata as object } });
        written++;
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  console.log(`[scrub-audit-emails] ${APPLY ? "APPLY" : "DRY RUN"}: scanned ${scanned}, candidates ${candidates}, written ${written}`);
  if (sample.length) console.log(`  sample ids: ${sample.join(", ")}`);
  if (!APPLY && candidates) console.log("  re-run with --apply to rewrite (backup first).");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
