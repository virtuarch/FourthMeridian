/**
 * lib/history/lens-roots.test.ts
 *
 * MULTIPLE CANONICAL ROOTS.
 *
 * Net Worth must be ONE entry point into the financial model, not the only
 * parent every other lens is reached through. These tests pin that each root
 * SELECTS an existing authority rather than forking one, and that the two
 * concepts the investigation rejected stay rejected.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LENS_ROOTS, normaliseLensRoot, isBucketRoot, isAggregateRoot,
  bucketKindForRoot, buildLensRootNode, buildLiquidityRootNode,
  reframeBucketAsRoot, LENS_ROOT_LABELS,
} from "./lens-root-node";
import type { Snapshot } from "@/types";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);

/** A self-consistent row: totalAssets − debt = netWorth, cash+savings−debt = netLiquid. */
const SNAP = {
  date: "2026-06-18",
  totalInvestments: 5_000, totalCrypto: 15_000, totalCash: 2_000, totalSavings: 3_000,
  totalDebt: 1_000,
  total: 20_000,                // stocks + crypto, the stored column
  totalAssets: 25_500,          // + 500 real assets
  netWorth: 24_500,
  netLiquid: 4_000,             // 2000 + 3000 − 1000
  cashOnHand: 2_000,
  isEstimated: true,
  completenessTier: "derived",
  currency: "USD",
} as unknown as Snapshot;

const build = (lens: Parameters<typeof buildLensRootNode>[0]["lens"]) =>
  buildLensRootNode({
    snapshot: SNAP, lens, dateISO: "2026-06-18",
    fromISO: "2026-01-01", toISO: "2026-06-18", currency: "USD",
  });

// ── liabilities is NOT a root ───────────────────────────────────────────────
{
  assert.ok(!(LENS_ROOTS as readonly string[]).includes("liabilities"),
    "there is no lens:liabilities — debt is a component, not an aggregate");
  assert.equal(normaliseLensRoot("liabilities"), "debt",
    "the product label resolves to the debt identity");
  ok("`liabilities` is an ALIAS for debt, never a root of its own");
}

// ── an absent or unknown root falls back, it never opens nothing ────────────
{
  assert.equal(normaliseLensRoot(null), null);
  assert.equal(normaliseLensRoot("nonsense"), null);
  assert.equal(normaliseLensRoot("NET-WORTH"), "net-worth", "case-insensitive");
  assert.equal(normaliseLensRoot("wealth"), "net-worth", "the workspace id aliases too");
  ok("root normalisation is total and case-insensitive; unknown yields null for the caller to default");
}

// ── root taxonomy ──────────────────────────────────────────────────────────
{
  // `investments` is deliberately NOT here: it is the `total` AGGREGATE
  // (securities + crypto), because that is what the Investments chart plots.
  for (const b of ["crypto", "cash", "savings", "debt"] as const) {
    assert.ok(isBucketRoot(b), `${b} is a bucket root`);
    assert.ok(bucketKindForRoot(b), `${b} maps to a bucket kind`);
    assert.equal(build(b), null, "a bucket root is resolved by the binding, not purely");
  }
  for (const a of ["assets", "liquid-net-worth", "investments"] as const) {
    assert.ok(isAggregateRoot(a), `${a} is an aggregate root`);
    assert.ok(!isBucketRoot(a));
  }
  ok("bucket roots and aggregate roots are distinguished, and each resolves the right way");
}

// ── ASSETS: the canonical asset composition, no subtrahend ─────────────────
{
  const n = build("assets")!;
  assert.equal(n.nodeType, "lens");
  assert.equal(n.lens, "assets");
  assert.equal(n.displayedValue, 25_500, "totals the STORED totalAssets column");
  assert.equal(n.provenance.note, "Investments + Crypto + Cash + Savings + Real assets");
  const kinds = n.components.map((c) => (c.nodeType === "bucket" ? c.bucketKind : c.nodeType));
  assert.deepEqual(kinds, ["investments", "crypto", "cash", "savings", "real-assets"]);
  assert.ok(n.components.every((c) => c.nodeType === "bucket" && !c.subtracts),
    "Assets has no subtrahend — debt is absent, not negated");
  assert.equal(n.explainedLiabilities, 0);
  ok("ASSETS · five asset buckets, no debt, totalling the stored totalAssets");
}

// ── LIQUID NET WORTH: the repository's actual formula ──────────────────────
{
  const n = build("liquid-net-worth")!;
  assert.equal(n.displayedValue, 4_000, "totals the STORED netLiquid column");
  assert.equal(n.provenance.note, "Cash + Savings − Debt");
  const kinds = n.components.map((c) => (c.nodeType === "bucket" ? c.bucketKind : ""));
  assert.deepEqual(kinds, ["cash", "savings", "debt"], "exactly three children");
  // Investments and crypto are ABSENT, not hidden. A root that showed them
  // greyed out would teach the reader the total ought to include them.
  assert.ok(!kinds.includes("investments") && !kinds.includes("crypto"),
    "investments and crypto are excluded from the composition entirely");
  const debt = n.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "debt");
  assert.ok(debt && debt.nodeType === "bucket" && debt.subtracts, "debt SUBTRACTS here");
  assert.equal(n.explainedValue, 4_000, "2000 + 3000 − 1000");
  assert.equal(n.reconciliation, "EXACT");
  ok("LIQUID NET WORTH · cash + savings − debt, three children, EXACT");
}

// ── the same bucket carries a DIFFERENT sign under a different root ────────
{
  const nw = build("net-worth")!;
  const lnw = build("liquid-net-worth")!;
  const assets = build("assets")!;
  const debtUnderNW = nw.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "debt");
  const debtUnderLNW = lnw.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "debt");
  assert.ok(debtUnderNW?.nodeType === "bucket" && debtUnderNW.subtracts);
  assert.ok(debtUnderLNW?.nodeType === "bucket" && debtUnderLNW.subtracts);
  const cashUnderAssets = assets.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "cash");
  assert.ok(cashUnderAssets?.nodeType === "bucket" && !cashUnderAssets.subtracts);
  // The VALUE is identical across roots — only the frame differs.
  const cashUnderNW = nw.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "cash");
  assert.equal(cashUnderAssets?.displayedValue, cashUnderNW?.displayedValue,
    "the same bucket has the same value under every root");
  ok("a shared bucket keeps its value across roots while its SIGN follows the root's formula");
}

// ── breadcrumbs are rebased on the root the user entered ──────────────────
{
  const n = build("assets")!;
  assert.deepEqual(n.breadcrumb.map((c) => c.label), ["Assets"]);
  const child = n.components[0];
  assert.deepEqual(child.breadcrumb.map((c) => c.label), ["Assets", child.label],
    "a child under Assets does NOT claim Net worth as its parent");
  ok("breadcrumbs start at the root the user entered, never a derived canonical parent");
}

// ── re-framing a bucket as a root drops the subtraction ───────────────────
{
  const nw = build("net-worth")!;
  const debtBucket = nw.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "debt");
  assert.ok(debtBucket && debtBucket.nodeType === "bucket");
  const root = reframeBucketAsRoot(debtBucket, "debt", LENS_ROOT_LABELS.debt);
  assert.equal(root.nodeType, "lens");
  assert.equal(root.displayedValue, debtBucket.displayedValue, "the VALUE is unchanged");
  assert.equal(root.reconciliation, debtBucket.reconciliation, "the reconciliation is unchanged");
  assert.deepEqual(root.breadcrumb.map((c) => c.label), ["Debt"]);
  // Debt as a root is "what you owe", positive — not "−$X against your assets".
  assert.equal(root.explainedLiabilities, debtBucket.explainedValue);
  assert.equal(root.explainedAssets, null);
  ok("a bucket re-framed as a root keeps its finances and drops its parent's sign");
}

// ── INVESTMENTS · securities + crypto, matching what the chart plots ───────
{
  const n = build("investments")!;
  assert.equal(n.lens, "investments");
  // THE BUG THIS FIXES: the root explained `stocks` while the chart plotted
  // `stocks + crypto` (portfolio-series.ts: "never plot `stocks` alone (that
  // silently drops crypto)"), so the panel answered a different question than
  // the point that opened it.
  assert.equal(n.displayedValue, 20_000, "stocks 5000 + crypto 15000 — the plotted value");
  assert.equal(n.provenance.note, "Securities + Crypto");

  const kinds = n.components.map((c) => (c.nodeType === "bucket" ? c.bucketKind : ""));
  assert.deepEqual(kinds, ["investments", "crypto"], "both branches, in display order");

  // A · both branches present.  B · they reconcile exactly.
  const sec = n.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "investments")!;
  const cry = n.components.find((c) => c.nodeType === "bucket" && c.bucketKind === "crypto")!;
  assert.equal(sec.displayedValue, 5_000);
  assert.equal(cry.displayedValue, 15_000);
  assert.equal(n.explainedValue, 20_000, "securities + crypto === the parent");
  assert.equal(n.reconciliation, "EXACT");
  // A computed parent may never invent a remainder.
  assert.equal(n.unattributedObservedAmount, null);

  // The securities child is RELABELLED under this root — "Investments ›
  // Investments" reads as a bug — while its IDENTITY is untouched, so a deep
  // link and a reconciliation still refer to the same node.
  assert.equal(sec.label, "Securities");
  assert.equal(sec.id, "bucket:investments", "the id never changes with the label");
  assert.deepEqual(sec.breadcrumb.map((c) => c.label), ["Investments", "Securities"]);
  ok("INVESTMENTS · securities + crypto, EXACT, matching the value the chart plots");
}

// ── D · no crypto ⇒ no phantom crypto branch ──────────────────────────────
{
  const noCrypto = { ...SNAP, totalCrypto: 0, total: 5_000, totalAssets: 10_500, netWorth: 9_500 } as unknown as Snapshot;
  const n = buildLensRootNode({
    snapshot: noCrypto, lens: "investments", dateISO: "2026-06-18",
    fromISO: "2026-01-01", toISO: "2026-06-18", currency: "USD",
  })!;
  const kinds = n.components.map((c) => (c.nodeType === "bucket" ? c.bucketKind : ""));
  assert.ok(!kinds.includes("crypto"), "an immaterial crypto column produces NO child");
  assert.equal(n.displayedValue, 5_000);
  // A legitimate absence is not the same as unavailable history.
  assert.equal(n.reconciliation, "EXACT");
  ok("D · no crypto holding ⇒ no phantom crypto branch, and still EXACT");
}

// ── LIQUIDITY · tiers, and no liability side ──────────────────────────────
{
  const n = buildLiquidityRootNode({
    snapshot: SNAP, dateISO: "2026-06-18", fromISO: "2026-01-01", toISO: "2026-06-18", currency: "USD",
  });
  assert.equal(n.lens, "liquidity");
  const tiers = n.components.filter((c) => c.nodeType === "tier");
  assert.equal(tiers.length, n.components.length, "every child is a TIER, not a bucket");
  const keys = tiers.map((t) => (t.nodeType === "tier" ? t.tier : ""));
  // The fixture carries 500 of real assets (25,500 − 25,000), so all three
  // tiers are present and their sum is the asset side.
  assert.deepEqual(keys, ["cashNow", "marketable", "illiquid"]);
  const illiquid = tiers.find((t) => t.nodeType === "tier" && t.tier === "illiquid")!;
  assert.equal(illiquid.displayedValue, 500, "the real-assets residual is the illiquid tier");
  assert.equal(n.displayedValue, 25_500, "the tiers total the stored totalAssets — the ASSET side");
  assert.equal(n.reconciliation, "EXACT");

  const cashNow = tiers.find((t) => t.nodeType === "tier" && t.tier === "cashNow")!;
  assert.equal(cashNow.displayedValue, 5_000, "cash 2000 + savings 3000");
  const marketable = tiers.find((t) => t.nodeType === "tier" && t.tier === "marketable")!;
  assert.equal(marketable.displayedValue, 20_000, "investments 5000 + crypto 15000");

  // NO LIABILITY SUBTRACTION anywhere. Liquidity asks how fast cash can be
  // raised, not what is owned net of debt — that is Liquid Net Worth.
  assert.ok(!n.components.some((c) => c.nodeType === "tier" && c.tier === ("debt" as never)),
    "debt is not a liquidity tier");
  assert.equal(n.explainedLiabilities, null, "stating 0 would imply a liability side exists");
  assert.ok(!/credit/i.test(JSON.stringify(n.components)), "borrowing capacity is not a child");
  assert.ok((n.provenance.note ?? "").includes("Borrowing capacity is not liquidity"),
    "and the exclusion is stated to the reader");

  // A tier is COMPUTED from its buckets, so it may never carry an observed remainder.
  assert.ok(tiers.every((t) => t.unattributedObservedAmount === null),
    "a computed tier never invents a remainder");
  ok("LIQUIDITY · three tiers, no liability side, credit excluded and said so");
}

// ── STATIC · no forked authority ──────────────────────────────────────────
{
  const src = readFileSync(new URL("./lens-root-node.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // EVERY root builder projects the ONE partition. The count is not the point —
  // two builders may each project it — what matters is that no builder computes
  // a partition of its own, which is what would let two roots disagree about a
  // bucket they share.
  const builders = src.match(/export function build\w*RootNode/g) ?? [];
  assert.ok(builders.length >= 2, "there is more than one root builder");
  assert.equal((src.match(/buildNetWorthNode\(/g) ?? []).length, builders.length,
    "each root builder projects buildNetWorthNode exactly once");
  // EVERY aggregate root READS its stored, authorised column rather than
  // recomputing the formula — the discipline that retired the duplicated
  // `liquidNetWorth` derivation. A `??` fallback restating that column's own
  // definition is permitted for a DTO built before the boundary exposed it, and
  // is the only place a sum may appear.
  for (const col of ["s.total", "s.totalAssets", "s.netLiquid"]) {
    assert.ok(src.includes(col), `an aggregate root reads the stored ${col}`);
  }
  const sums = src.match(/s\.total\w* \+ s\.total\w*/g) ?? [];
  for (const sum of sums) {
    assert.ok(new RegExp(`\\?\\?\\s*\\(${sum.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`).test(src),
      `"${sum}" appears only as a documented ?? fallback, never as the primary value`);
  }
  ok("STATIC · every aggregate root reads its stored column; sums appear only as fallbacks");
  // No valuation, ownership, replay or authorisation is re-derived here.
  for (const forbidden of [
    "getInvestmentValueForWindow", "loadHoldingOwnership", "valueCryptoDay",
    "authoriseAggregates", "computeSnapshotFields", "amountOwed",
  ]) {
    assert.ok(!src.includes(forbidden), `${forbidden} must not be re-derived in a root`);
  }
  assert.ok(!/\.(create|update|upsert|delete)\s*\(/.test(src), "roots write nothing");
  ok("STATIC · roots select authorities; none forks valuation, ownership or authorisation");
}

// ── L · no duplicate Investments or Crypto authority ──────────────────────
{
  const src = readFileSync(new URL("./lens-root-node.ts", import.meta.url), "utf8");
  // The crypto branch under Investments is the SAME bucket node Net Worth uses,
  // projected — not a second crypto composition.
  assert.ok(!/valueCryptoDay|readBtcUsdWindow|licenseConstantQuantityCarry|reconcileWalletLedger/.test(src),
    "no crypto authority is reconstructed in the root layer");
  assert.ok(!/historicalHoldingsForWindow|getInvestmentValueForWindow/.test(src),
    "no investments authority is reconstructed in the root layer");
  ok("L · Investments and Crypto branches reuse the one partition; no second authority");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`lens-roots: ${checks.length} checks passed`);
