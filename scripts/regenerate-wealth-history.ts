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
 *
 * 2026-07-15 — --space is optional: pass --email=<login-email> instead (or
 * nothing at all — defaults to chr.hogan1997@gmail.com) to auto-resolve that
 * user's PERSONAL Space, matching scripts/diagnose-wealth-chart-gap.ts. Lets
 * this run as a one-liner without looking up a Space id first.
 *
 * 2026-07-15 — loads .env.local itself (house pattern — see
 * scripts/run-reconstruction.ts), so WEALTH_REGENERATION_ENABLED,
 * TIINGO_API_KEY, and COINGECKO_API_KEY all take effect without needing to be
 * retyped inline on the command line. A standalone `tsx` process does NOT
 * auto-load .env.local the way `next dev`/`next build` does, so before this
 * fix --apply silently no-op'd (kill switch looked "off") and price backfills
 * silently ran dark even when the keys were configured in .env.local.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "@/lib/db";
import { regenerateWealthHistory, wealthRegenerationEnabled } from "@/lib/snapshots/regenerate-history";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
function strFlag(name: string): string | null {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  return a ? (a.split("=")[1] ?? null) : null;
}

async function resolveSpaceId(explicitSpaceId: string | null, email: string): Promise<string> {
  if (explicitSpaceId) return explicitSpaceId;
  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`No user found with email "${email}". Pass --space=<id> explicitly.`);
    process.exit(1);
  }
  const personal = await db.space.findFirst({
    where:  { type: "PERSONAL", members: { some: { userId: user.id, role: "OWNER" } } },
    select: { id: true, name: true },
  });
  if (!personal) {
    console.error(`No Personal Space found for "${email}". Pass --space=<id> explicitly.`);
    process.exit(1);
  }
  console.log(`Resolved Personal Space: ${personal.name} (${personal.id})`);
  return personal.id;
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
  const email = strFlag("--email") ?? "chr.hogan1997@gmail.com";
  const spaceId = await resolveSpaceId(strFlag("--space"), email);
  const apply = has("--apply");
  const yesterday = minusDays(isoDay(new Date()), 1);
  const toDate = strFlag("--to") ?? yesterday;
  const fromDate = strFlag("--from") ?? minusDays(toDate, 30);

  console.log(`Wealth history regeneration — space ${spaceId} · [${fromDate} … ${toDate}] · ${apply ? "APPLY" : "DRY-RUN"}`);
  if (apply && !wealthRegenerationEnabled()) {
    console.log("⚠ --apply given but WEALTH_REGENERATION_ENABLED is not 'true' — writes are disabled (kill switch). Showing the plan only.");
  }

  const res = await regenerateWealthHistory({ spaceId, fromDate, toDate, dryRun: !apply });

  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));
  // 2026-07-15 — print cash/savings/debt/netWorth before→after too, not just
  // investments. The investment-only view made a real cash/debt regeneration
  // (the earliest-transaction floor fix) invisible in this output — it could
  // run and change nothing you could see here.
  for (const d of res.diffs) {
    const mark = d.action === "write" ? "✎" : d.action === "skip-frozen" ? "🔒" : d.action === "skip-membership-changed" ? "⚠" : "∅";
    console.log(`  ${mark} ${d.date}  [${d.action}/${d.tier}]`);
    console.log(`      investments ${fmt(d.stocksBefore)} → ${fmt(d.stocksAfter)}`);
    console.log(`      cash        ${fmt(d.cashBefore)} → ${fmt(d.cashAfter)}`);
    console.log(`      savings     ${fmt(d.savingsBefore)} → ${fmt(d.savingsAfter)}`);
    console.log(`      debt        ${fmt(d.debtBefore)} → ${fmt(d.debtAfter)}`);
    console.log(`      netWorth    ${fmt(d.netWorthBefore)} → ${fmt(d.netWorthAfter)}`);
  }
  console.log(
    `\nsummary — considered ${res.considered}, ` +
    `${res.applied ? `written ${res.written}` : "would write " + res.diffs.filter((d) => d.action === "write").length} (dry-run: ${!res.applied}), ` +
    `frozen ${res.skippedFrozen}, unsupported(flat-preserved) ${res.skippedUnsupported}, ` +
    `membership-changed(untouched) ${res.skippedMembershipChanged}`,
  );
  if (res.skippedMembershipChanged > 0) {
    console.log(
      `⚠ ${res.skippedMembershipChanged} day(s) left untouched because an account was removed from this Space after that date. ` +
      `Automatic regen never rewrites those on its own — see docs/initiatives/wealth-timeline/WEALTH_TIMELINE_AMENDMENT_SYSTEM_PROPOSAL.md.`,
    );
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("regenerate-wealth-history failed:", err);
  await db.$disconnect();
  process.exit(1);
});
