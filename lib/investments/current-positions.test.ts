/**
 * lib/investments/current-positions.test.ts
 *
 * P2-3 — the getCurrentPositions binding. Standalone tsx (no DB — fake client +
 * pure helpers + source-scan guards, mirroring investments-time-machine*.test.ts):
 *
 *     npx tsx lib/investments/current-positions.test.ts
 *
 * Pins the three things the DB-touching binding must guarantee without a live DB:
 *   1. Read-strategy PARITY — resolving the cheap latest-per-pair set is
 *      byte-identical to resolving the full window (the ONLY documented diff).
 *   2. Cost-basis resolution follows the SAME resolved row valuation values.
 *   3. Visibility (KD-21a) — the seam always scopes to detail-eligible (FULL),
 *      so BALANCE_ONLY / SUMMARY_ONLY / REVOKED / deleted expose no position.
 *   4. Source guards — it composes the canonical valuation path (no forked
 *      engine), reads latest-per-pair (no full-history scan), and never widens
 *      visibility.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PositionOrigin, VisibilityLevel, ShareStatus } from "@prisma/client";

import { resolvePositionAsOf } from "./reconstruction-read";
import { latestObservationsPerPair } from "./current-positions-core";
import { resolveLatestCostBasis } from "./current-positions";
import { resolveInvestmentScopeAndCurrency } from "./valuation";
import type { ObservationValuationRow } from "./valuation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function main(): Promise<void> {
// ── 1. Read-strategy parity: latest-per-pair resolves like the full window ────
console.log("1. Read-strategy parity (cheap latest read ≡ full-window resolution)");

interface PR { financialAccountId: string; instrumentId: string; date: string; quantity: number; origin: PositionOrigin; completeness: string | null; }
const toResolverRows = (rows: PR[]) => rows.map((r) => ({ date: r.date, quantity: r.quantity, origin: r.origin, completeness: r.completeness }));

function assertParity(name: string, window: PR[], asOf: string): void {
  // Group per pair, resolve full window vs the latest-per-pair reduction.
  const pairs = [...new Set(window.map((r) => `${r.financialAccountId}|${r.instrumentId}`))];
  const latest = latestObservationsPerPair(window);
  let ok = true;
  for (const p of pairs) {
    const full = resolvePositionAsOf(toResolverRows(window.filter((r) => `${r.financialAccountId}|${r.instrumentId}` === p)), asOf);
    const cheap = resolvePositionAsOf(toResolverRows(latest.filter((r) => `${r.financialAccountId}|${r.instrumentId}` === p)), asOf);
    if (JSON.stringify(full) !== JSON.stringify(cheap)) ok = false;
  }
  check(name, ok);
}

const O = PositionOrigin.OBSERVED, I = PositionOrigin.IMPORTED, DV = PositionOrigin.DERIVED;
assertParity("latest observation wins (multi-date history)", [
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-01-01", quantity: 5, origin: O, completeness: null },
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", quantity: 9, origin: O, completeness: null },
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-03-01", quantity: 7, origin: I, completeness: null },
], "2026-07-01");
assertParity("multiple accounts, same instrument (independent latest)", [
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", quantity: 9, origin: O, completeness: null },
  { financialAccountId: "a2", instrumentId: "i1", date: "2026-05-01", quantity: 4, origin: O, completeness: null },
  { financialAccountId: "a2", instrumentId: "i1", date: "2026-02-01", quantity: 2, origin: O, completeness: null },
], "2026-07-01");
assertParity("same-date origin tiebreak (OBSERVED beats DERIVED)", [
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", quantity: 9, origin: DV, completeness: "incomplete" },
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", quantity: 9, origin: O, completeness: null },
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-05-01", quantity: 8, origin: O, completeness: null },
], "2026-07-01");
assertParity("closed position (latest quantity 0) excluded identically", [
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-04-01", quantity: 12, origin: O, completeness: null },
  { financialAccountId: "a1", instrumentId: "i1", date: "2026-06-01", quantity: 0, origin: O, completeness: null },
], "2026-07-01");

// ── 2. Cost-basis resolution ──────────────────────────────────────────────────
console.log("2. resolveLatestCostBasis — costBasis of the resolved latest row");

function obs(over: Partial<ObservationValuationRow & { costBasis: number | null }>): ObservationValuationRow & { costBasis: number | null } {
  return {
    financialAccountId: "a1", instrumentId: "i1", date: D("2026-06-01"), quantity: 10,
    origin: PositionOrigin.OBSERVED, completeness: null, isCash: false, currency: "USD",
    institutionValue: null, institutionPrice: null, institutionPriceAsOf: null, costBasis: null,
    ...over,
  };
}
{
  const cb = resolveLatestCostBasis([
    obs({ instrumentId: "i1", costBasis: 1800 }),
    obs({ instrumentId: "i2", costBasis: 900, quantity: 4 }),
  ], "2026-07-01");
  check("costBasis keyed per pair", cb["a1|i1"] === 1800 && cb["a1|i2"] === 900);
}
{
  // Same date, two origins: OBSERVED wins → its costBasis, not the DERIVED one.
  const cb = resolveLatestCostBasis([
    obs({ origin: PositionOrigin.DERIVED, completeness: "derived", costBasis: null }),
    obs({ origin: PositionOrigin.OBSERVED, costBasis: 1234 }),
  ], "2026-07-01");
  check("resolved-row origin decides costBasis (OBSERVED beats DERIVED)", cb["a1|i1"] === 1234);
}
{
  // Same (date, origin), two sources — greatest institutionValue wins (mirrors pickResolvedRow).
  const cb = resolveLatestCostBasis([
    obs({ institutionValue: 100, costBasis: 500 }),
    obs({ institutionValue: 900, costBasis: 777 }),
  ], "2026-07-01");
  check("multi-source tie broken by institutionValue desc", cb["a1|i1"] === 777);
}
{
  const cb = resolveLatestCostBasis([obs({ costBasis: null })], "2026-07-01");
  check("no provider cost basis ⇒ null (honest, never fabricated)", cb["a1|i1"] === null);
}

// ── 3. Visibility inside the seam (KD-21a) via resolveInvestmentScopeAndCurrency ─
console.log("3. Visibility — the seam scopes to detail-eligible (FULL) only");

interface FLink { financialAccountId: string; spaceId: string; visibilityLevel: VisibilityLevel; status: ShareStatus; deleted: boolean; }
function fakeClient(links: FLink[], reportingCurrency = "USD") {
  const matches = (l: FLink, where: Record<string, unknown>): boolean => {
    if (where.spaceId !== undefined && l.spaceId !== where.spaceId) return false;
    if (where.status !== undefined && l.status !== where.status) return false;
    if (where.financialAccountId !== undefined && l.financialAccountId !== where.financialAccountId) return false;
    const fa = where.financialAccount as { deletedAt?: null } | undefined;
    if (fa && fa.deletedAt === null && l.deleted) return false;
    const vis = where.visibilityLevel as { in?: VisibilityLevel[] } | undefined;
    if (vis?.in && !vis.in.includes(l.visibilityLevel)) return false;
    return true;
  };
  return {
    spaceAccountLink: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => links.filter((l) => matches(l, where)).map((l) => ({ financialAccountId: l.financialAccountId })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) => { const m = links.find((l) => matches(l, where)); return m ? { spaceId: m.spaceId } : null; },
    },
    space: { findUnique: async () => ({ reportingCurrency }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
function link(id: string, visibilityLevel: VisibilityLevel, opts: Partial<FLink> = {}): FLink {
  return { financialAccountId: id, spaceId: opts.spaceId ?? "space-1", visibilityLevel, status: opts.status ?? ShareStatus.ACTIVE, deleted: opts.deleted ?? false };
}

{
  const shared = [
    link("faFull", VisibilityLevel.FULL),
    link("faBalance", VisibilityLevel.BALANCE_ONLY),
    link("faSummary", VisibilityLevel.SUMMARY_ONLY),
    link("faRevoked", VisibilityLevel.FULL, { status: ShareStatus.REVOKED }),
    link("faGone", VisibilityLevel.FULL, { deleted: true }),
  ];
  const r = await resolveInvestmentScopeAndCurrency(fakeClient(shared, "GBP"), { spaceId: "space-1" }, "detailEligible");
  check("FULL account exposes positions (in scope)", r.accountIds.includes("faFull"));
  check("BALANCE_ONLY NOT in position detail", !r.accountIds.includes("faBalance"));
  check("SUMMARY_ONLY NOT in position detail", !r.accountIds.includes("faSummary"));
  check("REVOKED link excluded", !r.accountIds.includes("faRevoked"));
  check("deleted account excluded", !r.accountIds.includes("faGone"));
  check("exactly the live FULL account is in scope", r.accountIds.length === 1 && r.accountIds[0] === "faFull");
  check("reporting currency resolved from the Space", r.reportingCurrency === "GBP");
}
{
  // Owner / current Personal: every link is FULL → all positions visible.
  const personal = [link("p1", VisibilityLevel.FULL), link("p2", VisibilityLevel.FULL)];
  const r = await resolveInvestmentScopeAndCurrency(fakeClient(personal), { spaceId: "space-1" }, "detailEligible");
  check("owner's own FULL accounts all in scope", r.accountIds.length === 2 && r.accountIds.includes("p1") && r.accountIds.includes("p2"));
}
{
  // Single-account scope fails closed for a non-FULL link.
  const bal = await resolveInvestmentScopeAndCurrency(fakeClient([link("faBal", VisibilityLevel.BALANCE_ONLY)]), { financialAccountId: "faBal" }, "detailEligible");
  check("single BALANCE_ONLY account fails closed (no positions)", bal.accountIds.length === 0);
}

// ── 4. Source guards — canonical composition, cheap read, visibility inside ───
console.log("4. Source guards");
{
  const raw = readFileSync(join(process.cwd(), "lib/investments/current-positions.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments

  check("visibility enforced INSIDE — scopes to detailEligible", /resolveInvestmentScopeAndCurrency\([^)]*"detailEligible"\s*\)/.test(code));
  check("never widens to the wealth-total 'all' scope", !/"all"/.test(code));
  check("values via the canonical valuePositionRows (A10 path), not a fork", /valuePositionRows\s*\(/.test(code));
  check("no second price engine (no lib/prices import / price service)", !/@\/lib\/prices/.test(code) && !/priceArchive|createPriceService|getPriceAsOf/.test(code));
  check("no bespoke per-instrument valuation arithmetic", !/valueInstrumentAsOf\s*\(/.test(code));
  check("cheap latest-per-pair read via groupBy(_max: date)", /\.groupBy\(/.test(code) && /_max:\s*\{\s*date:/.test(code));
  check("latest rows fetched by pair filter, not a full-history window", /OR:\s*pairFilters/.test(code));
  check("current read never holds a quantity constant backward (holdConstant false)", /holdConstant:\s*false/.test(code));

  // countCurrentPositionsByAccount — the Connections position-presence signal.
  check("count helper WRAPS getCurrentPositions (no second position read)", /countCurrentPositionsByAccount[\s\S]*getCurrentPositions\s*\(/.test(code));
  check("count helper excludes cash rows (matches legacy positionCount)", /countCurrentPositionsByAccount[\s\S]*if\s*\(\s*r\.isCash\s*\)\s*continue/.test(code));
}

}

// ── Exit ──────────────────────────────────────────────────────────────────────
main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nAll current-positions binding checks passed.");
}).catch((e) => { console.error(e); process.exit(1); });
