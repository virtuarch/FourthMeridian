/**
 * scripts/regenerate-wealth-history.ts
 *
 * A9 — manual, bounded Wealth-history regeneration with a dry-run preview.
 * House pattern (scripts/backfill-fx-rates.ts, scripts/run-reconstruction.ts):
 * dry-run by default, --apply to write, idempotent, re-runnable, per-row diff.
 *
 * Re-derives each estimated SpaceSnapshot row's investment component from the
 * canonical A8 historical valuation (never the flat current balance), keeping
 * cash/card walk-backs and crypto/real components, through
 * lib/snapshots/regenerate-history.ts. Frozen (observed) rows are never touched.
 * Writes require BOTH --apply AND WEALTH_REGENERATION_ENABLED=true.
 *
 * Run:
 *   npx tsx scripts/regenerate-wealth-history.ts --space=<id>                 # dry-run
 *   WEALTH_REGENERATION_ENABLED=true npx tsx scripts/regenerate-wealth-history.ts --space=<id> --apply
 *   flags: --from=YYYY-MM-DD  --to=YYYY-MM-DD  (defaults: --to=yesterday, --from=to−30d)
 */

import { db } from "@/lib/db";
import { regenerateWealthHistory, wealthRegenerationEnabled } from "@/lib/snapshots/regenerate-history";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
function strFlag(name: string): string | null {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  return a ? (a.split("=")[1] ?? null) : null;
}

function isoDay(d: Date): string {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}
function minusDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const spaceId = strFlag("--space");
  if (!spaceId) {
    console.error("usage: --space=<spaceId> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--apply]");
    process.exit(1);
  }
  const apply = has("--apply");
  const yesterday = minusDays(isoDay(new Date()), 1);
  const toDate = strFlag("--to") ?? yesterday;
  const fromDate = strFlag("--from") ?? minusDays(toDate, 30);

  console.log(`Wealth history regeneration — space ${spaceId} · [${fromDate} … ${toDate}] · ${apply ? "APPLY" : "DRY-RUN"}`);
  if (apply && !wealthRegenerationEnabled()) {
    console.log("⚠ --apply given but WEALTH_REGENERATION_ENABLED is not 'true' — writes are disabled (kill switch). Showing the plan only.");
  }

  const res = await regenerateWealthHistory({ spaceId, fromDate, toDate, dryRun: !apply });

  for (const d of res.diffs) {
    const before = d.stocksBefore == null ? "—" : d.stocksBefore.toFixed(2);
    const after = d.stocksAfter == null ? "—" : d.stocksAfter.toFixed(2);
    const mark = d.action === "write" ? "✎" : d.action === "skip-frozen" ? "🔒" : "∅";
    console.log(`  ${mark} ${d.date}  investments ${before} → ${after}  [${d.action}/${d.tier}]`);
  }
  console.log(
    `\nsummary — considered ${res.considered}, ` +
    `${res.applied ? `written ${res.written}` : "would write " + res.diffs.filter((d) => d.action === "write").length} (dry-run: ${!res.applied}), ` +
    `frozen ${res.skippedFrozen}, unsupported(flat-preserved) ${res.skippedUnsupported}`,
  );

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("regenerate-wealth-history failed:", err);
  await db.$disconnect();
  process.exit(1);
});
