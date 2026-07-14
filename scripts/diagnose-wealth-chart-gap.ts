/**
 * scripts/diagnose-wealth-chart-gap.ts
 *
 * READ-ONLY diagnostic for two reported Wealth Perspective symptoms (2026-07-14):
 *   1. The chart's Assets / Liabilities / Liquid NW metrics render as missing
 *      data after a snapshot backfill/reconstruction (Net Worth renders fine).
 *   2. The default Net Worth view shows an unexplained ~$10k jump between
 *      yesterday and today.
 *
 * Strictly SELECT-only — no create/update/delete/upsert anywhere. Prints the
 * exact SpaceSnapshot columns the Wealth chart reads (lib/wealth/wealth-time-
 * machine.ts's toState/toChartPoint: netWorth, totalAssets, debt→totalLiabilities,
 * cash+savings-debt→liquidNetWorth), an arithmetic-identity check (catches NULL/
 * NaN columns — a single bad value on ANY point poisons the chart's shared
 * Math.min/max y-scale and makes that entire metric's line vanish, which reads
 * exactly like "missing data"), and adjacent-day deltas (isolates which day
 * boundary the jump lands on and whether it coincides with a LIVE/estimated
 * writer-boundary crossing — the today-vs-history valuation-method seam
 * regenerate.ts's live classifyAccounts() call vs regenerate-history.ts's
 * getInvestmentValueAsOf() call are not guaranteed to agree at).
 *
 * Usage:
 *   npx tsx scripts/diagnose-wealth-chart-gap.ts [--email <login-email>] [--days 21]
 *   Default email: chr.hogan1997@gmail.com. Default days: 21 (3 weeks back).
 *   Resolves the user's PERSONAL Space; pass --spaceId to target a different one.
 */

import { db } from "@/lib/db";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const EMAIL   = (argValue("--email") ?? "chr.hogan1997@gmail.com").trim();
const DAYS    = Number(argValue("--days") ?? "21") || 21;
const SPACE_ID_ARG = argValue("--spaceId");

function fmt(n: number | null | undefined, w = 10): string {
  if (n === null || n === undefined) return "NULL".padStart(w);
  if (Number.isNaN(n)) return "NaN".padStart(w);
  return (Math.round(n * 100) / 100).toString().padStart(w);
}
function pad(s: string, w: number): string {
  const t = s.length > w ? s.slice(0, w - 1) + "…" : s;
  return t.padEnd(w);
}
function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function isoTime(d: Date): string { return d.toISOString().replace("T", " ").slice(0, 19); }

async function main(): Promise<void> {
  console.log(`\n=== Wealth chart diagnostic — ${EMAIL}, last ${DAYS} days ===\n`);

  const user = await db.user.findUnique({
    where:  { email: EMAIL },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error(`No user found with email "${EMAIL}".`);
    process.exitCode = 1;
    return;
  }

  let spaceId = SPACE_ID_ARG;
  if (!spaceId) {
    const personal = await db.space.findFirst({
      where:  { type: "PERSONAL", members: { some: { userId: user.id, role: "OWNER" } } },
      select: { id: true, name: true },
    });
    if (!personal) {
      console.error("No Personal Space found for this user. Pass --spaceId explicitly.");
      process.exitCode = 1;
      return;
    }
    spaceId = personal.id;
    console.log(`Resolved Personal Space: ${personal.name} (${spaceId})\n`);
  }

  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - DAYS);

  const snaps = await db.spaceSnapshot.findMany({
    where:   { spaceId, date: { gte: from } },
    orderBy: { date: "asc" },
    select: {
      date: true, createdAt: true, isEstimated: true, reportingCurrency: true,
      cash: true, savings: true, debt: true, stocks: true, crypto: true,
      totalAssets: true, netWorth: true, netLiquid: true, cashOnHand: true, total: true,
    },
  });

  if (snaps.length === 0) {
    console.log("(no snapshot rows in range — nothing to diagnose)");
    return;
  }

  // ── 1. Raw rows — every field the Wealth chart's four metrics derive from ──
  console.log("1) SNAPSHOT ROWS");
  console.log(
    pad("date", 11) + pad("live?", 6) +
    ["cash", "savings", "debt", "stocks", "crypto", "total", "totAssets", "netWorth", "netLiquid"]
      .map((h) => h.padStart(10)).join("") + "  createdAt  stamp",
  );
  for (const r of snaps) {
    console.log(
      pad(iso(r.date), 11) + pad(r.isEstimated ? "est" : "LIVE", 6) +
      fmt(r.cash) + fmt(r.savings) + fmt(r.debt) + fmt(r.stocks) + fmt(r.crypto) +
      fmt(r.total) + fmt(r.totalAssets) + fmt(r.netWorth) + fmt(r.netLiquid) +
      "  " + isoTime(r.createdAt) + "  " + (r.reportingCurrency ?? "USD"),
    );
  }

  // ── 2. Identity check — catches the NULL/NaN-poisons-the-whole-line shape ──
  console.log("\n2) ARITHMETIC IDENTITY CHECK (netWorth == totalAssets − debt; netLiquid == cash+savings−debt)");
  let anyBad = false;
  for (const r of snaps) {
    const fieldsPresent =
      r.totalAssets !== null && r.debt !== null && r.netWorth !== null &&
      r.cash !== null && r.savings !== null && r.netLiquid !== null;
    if (!fieldsPresent) {
      anyBad = true;
      console.log(`   ✗ ${iso(r.date)} — NULL field present (totalAssets=${r.totalAssets} debt=${r.debt} netWorth=${r.netWorth} cash=${r.cash} savings=${r.savings} netLiquid=${r.netLiquid})`);
      continue;
    }
    const nwOk = Math.abs(r.netWorth - (r.totalAssets - r.debt)) < 0.01;
    const nlOk = Math.abs(r.netLiquid - (r.cash + r.savings - r.debt)) < 0.01;
    if (!nwOk || !nlOk) {
      anyBad = true;
      console.log(`   ✗ ${iso(r.date)} netWorthOk=${nwOk} netLiquidOk=${nlOk}`);
    }
  }
  console.log(anyBad ? "   ✗ identity violation(s) or NULLs above — this WILL blank the affected metric's chart line" : "   ✓ all rows satisfy the identities, no NULLs");

  // ── 3. Adjacent-day deltas — isolates the jump + writer-boundary crossings ──
  console.log("\n3) ADJACENT-DAY DELTAS");
  console.log(
    pad("from→to", 24) + ["Δcash", "Δsav", "Δdebt", "Δstk", "Δcry", "Δasset", "ΔnetW"]
      .map((h) => h.padStart(9)).join("") + "  boundary",
  );
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1], b = snaps[i];
    const boundary = a.isEstimated !== b.isEstimated
      ? (a.isEstimated ? "est→LIVE" : "LIVE→est")
      : (a.isEstimated ? "est" : "live");
    console.log(
      pad(`${iso(a.date)}→${iso(b.date)}`, 24) +
      fmt(b.cash - a.cash, 9) + fmt(b.savings - a.savings, 9) + fmt(b.debt - a.debt, 9) +
      fmt(b.stocks - a.stocks, 9) + fmt(b.crypto - a.crypto, 9) +
      fmt(b.totalAssets - a.totalAssets, 9) + fmt(b.netWorth - a.netWorth, 9) +
      "  " + boundary,
    );
  }

  console.log("\nDone. Share this output back to diagnose the two symptoms.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
