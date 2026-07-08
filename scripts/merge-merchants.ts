/**
 * scripts/merge-merchants.ts
 *
 * Sanctioned, reusable merchant-merge utility (MI2 S1) — the generalization of
 * the one-off scripts/merge-wgu-merchants.ts. A THIN adapter around the merge
 * engine (lib/transactions/merchant-merge.ts): it parses flags, resolves the
 * survivor / duplicate merchants to ids, calls `mergeMerchants`, and prints the
 * returned report. It contains NO merge logic — every write decision and the
 * atomic $transaction live in the engine, single-sourced with any future caller
 * (the MI2 S2 accept-endpoint, Platform Operations).
 *
 * This retires the "next split cluster needs another custom script" failure mode:
 * any future merge is a flag invocation, not a new file.
 *
 * House pattern (mirrors scripts/backfill-merchant-intelligence.ts):
 *   • Dry-run is the DEFAULT; `--apply` is required to write.
 *   • No interactive prompts — survivor and duplicates are fully specified by flags.
 *
 * Usage:
 *   npx tsx scripts/merge-merchants.ts --survivor=<key|id> --absorb=<key|id> [--absorb=…]
 *   npx tsx scripts/merge-merchants.ts --survivor=… --absorb=…,…  --apply
 *   npx tsx scripts/merge-merchants.ts --survivor=… --absorb=…    --json
 *
 * Flags:
 *   --survivor=<canonicalKey|merchantId>   (required) the merchant that survives
 *   --absorb=<canonicalKey|merchantId>     (required, ≥1) repeatable and/or comma-separated
 *   --apply                                write (default: dry run)
 *   --json                                 emit the MergeReport as JSON instead of text
 *
 * Exit 0 on success, 1 on error (unresolved merchant, bad flags, engine failure).
 */

import { db } from "@/lib/db";
import { normalizeMerchantIdentity } from "@/lib/transactions/merchant-resolver";
import { mergeMerchants, type MergeReport } from "@/lib/transactions/merchant-merge";

const argv = process.argv.slice(2);

/** Collect a repeatable/comma-separated flag into a flat, de-duped list. */
function listFlag(name: string): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a.startsWith(`${name}=`)) {
      for (const part of a.slice(name.length + 1).split(",")) {
        const v = part.trim();
        if (v) out.push(v);
      }
    }
  }
  return [...new Set(out)];
}

/** Read a single-valued flag (last occurrence wins). */
function stringFlag(name: string): string | null {
  let val: string | null = null;
  for (const a of argv) if (a.startsWith(`${name}=`)) val = a.slice(name.length + 1).trim();
  return val && val.length ? val : null;
}

const APPLY = argv.includes("--apply");
const JSON_OUT = argv.includes("--json");

/**
 * Resolve a `--survivor`/`--absorb` token (a merchant id OR a canonicalKey/raw
 * descriptor) to a merchant id. Tries id first, then the normalized canonical key
 * — deterministic, no fuzzy matching (matches the WGU script's key resolution).
 */
async function resolveMerchantId(token: string): Promise<{ id: string; canonicalKey: string; displayName: string } | null> {
  const byId = await db.merchant.findUnique({
    where: { id: token },
    select: { id: true, canonicalKey: true, displayName: true },
  });
  if (byId) return byId;

  const { canonicalKey } = normalizeMerchantIdentity(token);
  const byKey = await db.merchant.findUnique({
    where: { canonicalKey },
    select: { id: true, canonicalKey: true, displayName: true },
  });
  return byKey;
}

function fail(message: string): never {
  console.error(`merge-merchants: ${message}`);
  process.exitCode = 1;
  // Signal to main() to stop; disconnect happens in finally.
  throw new Error(message);
}

function printReport(report: MergeReport): void {
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `\n${report.applied ? "[APPLIED] merchant merge — WROTE" : "[DRY RUN] merchant merge — READ-ONLY, no writes"}\n`,
  );
  console.log(
    `Survivor: ${report.survivor.displayName} (${report.survivor.id}) key=${report.survivor.canonicalKey}`,
  );
  for (const d of report.perDuplicate) {
    console.log(
      `${report.applied ? "Merged" : "Would merge"} ${d.canonicalKey} (${d.id}): ` +
        `${d.aliasesRepointed} alias(es) re-pointed, ${d.transactionsRepointed} transaction(s) re-pointed, ` +
        `${d.rulesMoved} rule(s) moved, ${d.rulesFolded} rule(s) folded` +
        `${d.plaidEntityTransferred ? ", plaidEntityId transferred" : ""}` +
        `${d.plaidEntityDropped ? `, plaidEntityId=${d.plaidEntityDropped} dropped (survivor already has one)` : ""}` +
        `${d.deleted ? ", merchant deleted" : ""}`,
    );
  }
  for (const n of report.notes) console.log(`(note) ${n}`);
  const v = report.verification;
  console.log(
    `\nVerification: duplicate merchants remaining=${v.duplicateMerchantsRemaining}` +
      `${report.applied ? " (want 0)" : ""}, transactions still on old ids=${v.transactionsOnOldIds}` +
      `${report.applied ? " (want 0)" : ""}, survivor aliases=${v.survivorAliasCount}`,
  );
  console.log(
    report.applied
      ? "\nApplied. Re-run to verify 0 remain (idempotent)."
      : "\nDry run only — no writes. Re-run with --apply to write.",
  );
}

async function main(): Promise<void> {
  const survivorToken = stringFlag("--survivor");
  const absorbTokens = listFlag("--absorb");

  if (!survivorToken) fail("missing required --survivor=<key|id>");
  if (absorbTokens.length === 0) fail("missing required --absorb=<key|id> (repeatable, comma-separated)");

  const survivor = await resolveMerchantId(survivorToken!);
  if (!survivor) fail(`survivor not resolved: no merchant matches "${survivorToken}"`);

  const duplicateIds: string[] = [];
  for (const token of absorbTokens) {
    const m = await resolveMerchantId(token);
    if (!m) fail(`--absorb not resolved: no merchant matches "${token}"`);
    if (m!.id === survivor!.id) fail(`--absorb "${token}" resolves to the survivor — cannot absorb a merchant into itself`);
    duplicateIds.push(m!.id);
  }

  const report = await mergeMerchants(db, {
    survivorId: survivor!.id,
    duplicateIds: [...new Set(duplicateIds)],
    dryRun: !APPLY,
    evidence: { signal: "cli", note: `merge-merchants ${APPLY ? "--apply" : "dry-run"}` },
  });

  printReport(report);
}

main()
  .catch((e) => {
    // fail() already set exitCode + logged; other errors are logged here.
    if (process.exitCode !== 1) console.error("merge-merchants failed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
