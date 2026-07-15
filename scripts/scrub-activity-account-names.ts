/**
 * scripts/scrub-activity-account-names.ts
 *
 * P1 closeout — one-time, idempotent scrub that removes historically-persisted
 * REAL account names from non-FULL account-sharing activity metadata. Before
 * P1-3 added write-time redaction, `ACCOUNT_SHARED` / `ACCOUNT_REVOKED` AuditLog
 * rows persisted `metadata.accountName = <real FinancialAccount name>` regardless
 * of the share's visibility tier — so a BALANCE_ONLY / SUMMARY_ONLY account's
 * real name sits in AuditLog metadata that the activity feed (and any other
 * metadata consumer) can read. P1-3's read-time redaction already HIDES it on
 * render; this scrub removes it from STORAGE.
 *
 * Policy (reuses the canonical helpers via lib/activity/scrub-account-name.ts —
 * no new privacy model):
 *   - FULL rows keep their real name (skipped).
 *   - BALANCE_ONLY / SUMMARY_ONLY → genericAccountName(account type/subtype).
 *   - Rows with NO visibility marker (legacy revoke) → fail closed (redacted),
 *     matching the read-time displayActivityAccountName doctrine.
 *   - Deleted/missing account (no type hint) → the generic label constant.
 * Only the `accountName` field is rewritten; financialAccountId, visibilityLevel,
 * every other metadata key, the row id, and createdAt are preserved (AuditLog has
 * no @updatedAt, so scrubbed rows never look freshly modified).
 *
 * Idempotent: the safe value is deterministic, so a second run finds 0 candidates.
 *
 * SAFETY: dry-run by DEFAULT (report only, zero writes). `--apply` writes, and
 * MUST only ever be run against a LOCAL database — never Preview/Production.
 *
 * Run (loads .env.local for DATABASE_URL; the server-only preload lets the
 * transitively-imported account-privacy module resolve under bare tsx, same as
 * scripts/run-tests.ts):
 *   npx dotenv -e .env.local -- npx tsx --require ./scripts/lib/server-only-preload.cjs \
 *     scripts/scrub-activity-account-names.ts             # dry-run (default)
 *   … scripts/scrub-activity-account-names.ts --apply     # write (LOCAL ONLY)
 *   … scripts/scrub-activity-account-names.ts [--limit=N]
 */

import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { decideScrub } from "@/lib/activity/scrub-account-name";
import type { AccountTypeHint } from "@/lib/account-privacy";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const LIMIT = intFlag("--limit", Number.POSITIVE_INFINITY);

const SHARE_ACTIONS = [AuditAction.ACCOUNT_SHARED, AuditAction.ACCOUNT_REVOKED];

type Meta = Record<string, unknown>;
function asMeta(v: unknown): Meta | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Meta) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function main(): Promise<void> {
  console.log(`[scrub-activity-account-names] mode=${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);

  // 1. Load candidate-eligible rows (both account-sharing actions).
  const rows = await db.auditLog.findMany({
    where:   { action: { in: SHARE_ACTIONS } },
    orderBy: { createdAt: "asc" },
    select:  { id: true, action: true, metadata: true, createdAt: true },
  });
  console.log(`  scanned ${rows.length} ACCOUNT_SHARED/ACCOUNT_REVOKED rows`);

  // 2. Resolve type hints for every referenced FinancialAccount in one query
  //    (soft-deleted accounts included — a deleted account still has a type).
  const accountIds = new Set<string>();
  for (const r of rows) {
    const meta = asMeta(r.metadata);
    const faId = meta && str(meta.financialAccountId);
    if (faId) accountIds.add(faId);
  }
  const accounts = accountIds.size === 0 ? [] : await db.financialAccount.findMany({
    where:  { id: { in: [...accountIds] } },
    select: { id: true, type: true, debtSubtype: true },
  });
  const hintById = new Map<string, AccountTypeHint>(
    accounts.map((a) => [a.id, { type: a.type, debtSubtype: a.debtSubtype ?? null }]),
  );

  // 3. Classify.
  interface Candidate { id: string; action: string; before: string; after: string; meta: Meta; }
  const candidates: Candidate[] = [];
  let fullSkipped = 0;
  let alreadySafe = 0;

  for (const r of rows) {
    const meta = asMeta(r.metadata);
    if (!meta) continue;
    const storedName = str(meta.accountName);
    if (storedName === null) continue; // no accountName field → nothing to scrub
    // Match the read path's marker resolution EXACTLY (activity/route.ts reads
    // `meta.visibilityLevel || meta.visibility`): legacy rows (incl. the seed)
    // carry the tier under the older `visibility` key. Missing both → null →
    // fail closed (redacted). A FULL marker under EITHER key retains the name.
    const visibilityLevel = str(meta.visibilityLevel) ?? str(meta.visibility);
    const faId = str(meta.financialAccountId);
    const hint = faId ? hintById.get(faId) ?? null : null;

    const decision = decideScrub({ visibilityLevel, storedName, hint });
    if (visibilityLevel === "FULL") { fullSkipped++; continue; }
    if (!decision.isCandidate) { alreadySafe++; continue; }
    candidates.push({ id: r.id, action: r.action, before: storedName, after: decision.safeName, meta });
  }

  const capped = Number.isFinite(LIMIT) ? candidates.slice(0, LIMIT) : candidates;

  // 4. Report.
  console.log(`\n  FULL rows retained (real name kept):     ${fullSkipped}`);
  console.log(`  non-FULL rows already safe (no change):  ${alreadySafe}`);
  console.log(`  CANDIDATES (real name to redact):        ${candidates.length}${capped.length !== candidates.length ? ` (capped to ${capped.length} by --limit)` : ""}`);
  const sample = capped.slice(0, 10);
  if (sample.length > 0) {
    console.log(`\n  sample (${sample.length} of ${capped.length}):`);
    for (const c of sample) {
      console.log(`    ${c.id} [${c.action}]  "${c.before}"  →  "${c.after}"`);
    }
  }

  if (!APPLY) {
    console.log(`\n  DRY-RUN — no rows written. Re-run with --apply (LOCAL DB only) to redact.`);
    console.log(`  would-redact count: ${capped.length}`);
    await db.$disconnect();
    return;
  }

  // 5. Apply — rewrite ONLY the accountName field; preserve all other metadata.
  let updated = 0;
  for (const c of capped) {
    await db.auditLog.update({
      where: { id: c.id },
      data:  { metadata: { ...c.meta, accountName: c.after } },
    });
    updated++;
  }
  console.log(`\n  APPLIED — redacted ${updated} row(s).`);

  // 6. Post-run verification — recount candidates from scratch (must be 0 when
  //    the whole set was processed, i.e. no --limit truncation).
  const verifyRows = await db.auditLog.findMany({
    where:   { action: { in: SHARE_ACTIONS } },
    select:  { id: true, metadata: true },
  });
  let remaining = 0;
  for (const r of verifyRows) {
    const meta = asMeta(r.metadata);
    if (!meta) continue;
    const storedName = str(meta.accountName);
    if (storedName === null) continue;
    const visibilityLevel = str(meta.visibilityLevel) ?? str(meta.visibility);
    if (visibilityLevel === "FULL") continue;
    const faId = str(meta.financialAccountId);
    const hint = faId ? hintById.get(faId) ?? null : null;
    if (decideScrub({ visibilityLevel, storedName, hint }).isCandidate) remaining++;
  }
  console.log(`  VERIFICATION — remaining non-FULL rows with an unredacted name: ${remaining}`);
  if (remaining > 0 && Number.isFinite(LIMIT)) {
    console.log(`  (a --limit was set; re-run without --limit to finish the remainder)`);
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("[scrub-activity-account-names] FAILED:", err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
