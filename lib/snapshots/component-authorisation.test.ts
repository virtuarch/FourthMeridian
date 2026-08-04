/**
 * lib/snapshots/component-authorisation.test.ts
 *
 * PER-COMPONENT REGENERATION AUTHORITY.
 *
 * The governing invariant:
 *
 *   An unsupported component must never authorise its own rewrite, but it must
 *   not block an independently supported component from being corrected.
 *
 * Unknown Investments stay unknown. Proven Debt is still repairable.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  regenerateDay, patchableRows, writableRows,
  type DayRegenInput, type SnapshotFieldPatch,
} from "./regenerate-history.core";
import {
  auditLiabilitySeries, aggregateIdentityViolations, type SeriesPoint,
} from "./series-integrity.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

/** A stored row whose every value is distinct, so "preserved" is provable. */
const STORED = {
  stocks: 5_000, crypto: 15_516.70, total: 20_516.70, cash: 1_642.55, savings: 7_001.94,
  // netWorth = totalAssets − debt = 29,161.19 − 29,359.05. The fixture is
  // internally consistent on purpose: a patched row must satisfy every stored
  // identity, and a fixture that starts inconsistent cannot prove that.
  debt: 29_359.05, netWorth: -197.86, totalAssets: 29_161.19, netLiquid: -20_714.56,
  cashOnHand: 1_642.55,
};

const base = () => ({
  totalInvestments: 5_000, totalDigitalAssets: 15_516.70,
  totalChecking: 1_642.55, totalSavings: 7_001.94,
  totalLiabilities: 29_505.03,          // the REPAIRED debt: +145.98
  totalRealAssets: 0,
});

const input = (over: Partial<DayRegenInput> = {}): DayRegenInput => ({
  date: "2025-03-28",
  existingIsEstimated: true,
  existing: STORED,
  base: base(),
  investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
  digitalAssetValue: 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: false,
  cashCardTier: "derived",
  membershipChangedSince: false,
  ...over,
});

const decision = (r: ReturnType<typeof regenerateDay>, c: string) =>
  r.components?.find((d) => d.component === c);
const keys = (p: SnapshotFieldPatch | null) => Object.keys(p ?? {}).sort();
/** Money equality. The engine sums floats; the test must not demand bit equality. */
const near = (a: number | undefined, b: number, what: string) =>
  assert.ok(a != null && Math.abs(a - b) < 0.005, `${what}: ${a} !~ ${b}`);

// ── A · unsupported Investments does not block supported Debt ───────────────
// This is the incident exactly: ownership prehistory before 2025-07-31.
{
  const r = regenerateDay(input({ ownershipIneligible: true }));
  assert.equal(r.action, "write-partial");
  assert.equal(decision(r, "stocks")?.action, "preserved");
  assert.equal(decision(r, "stocks")?.value, STORED.stocks, "preserved verbatim, never zeroed");
  assert.equal(decision(r, "stocks")?.authorized, false);
  assert.equal(decision(r, "debt")?.action, "recomputed");
  near(decision(r, "debt")?.value, 29_505.03, "debt recomputed");
  assert.ok((decision(r, "stocks")?.reason ?? "").includes("OWNERSHIP_PREHISTORY"));
  ok("A · unsupported Investments no longer blocks a supported Debt repair");
}

// ── B · unsupported Crypto does not block supported Debt ────────────────────
{
  const r = regenerateDay(input({ ownershipIneligible: true }));
  // base crypto is material and there is no crypto evidence ⇒ refused.
  assert.equal(decision(r, "crypto")?.action, "preserved");
  assert.equal(decision(r, "crypto")?.value, STORED.crypto);
  assert.ok((decision(r, "crypto")?.reason ?? "").includes("NO_CRYPTO_EVIDENCE"));
  assert.equal(decision(r, "debt")?.action, "recomputed");
  assert.equal(r.cryptoValuationStatus, "unavailable", "the crypto verdict survives the partial write");
  ok("B · unsupported Crypto no longer blocks a supported Debt repair");
}

// ── C/O · the patch names ONLY the fields authorised to change ──────────────
{
  const r = regenerateDay(input({ ownershipIneligible: true }));
  assert.deepEqual(keys(r.fieldPatch), ["debt", "netLiquid", "netWorth"]);
  // Never a reconstructed full row: the preserved components are absent.
  for (const untouched of ["stocks", "crypto", "total", "cash", "savings", "totalAssets", "cashOnHand"]) {
    assert.ok(!keys(r.fieldPatch).includes(untouched), `${untouched} must not be patched`);
  }
  near(r.fieldPatch?.debt, 29_505.03, "debt");
  near(r.fieldPatch?.netWorth, STORED.netWorth - 145.98, "netWorth moves by exactly -145.98");
  near(r.fieldPatch?.netLiquid, STORED.netLiquid - 145.98, "netLiquid moves by exactly -145.98");
  ok("C/O · the patch names exactly debt, netWorth, netLiquid — never a full row");
}

// ── D/E · an unsupported component is preserved and NOT marked supported ────
{
  const r = regenerateDay(input({ ownershipIneligible: true }));
  const stocks = decision(r, "stocks")!;
  assert.notEqual(stocks.value, 0, "never zeroed");
  assert.equal(stocks.value, STORED.stocks, "never a carried current balance — the stored value");
  assert.equal(stocks.authorized, false, "presence is not authorisation");
  assert.equal(r.contributingComponentCount, null, "composition counts are not attributed to a preserved value");
  ok("D/E · a preserved component is neither zeroed nor silently authorised");
}

// ── F/G/H · aggregate safety ────────────────────────────────────────────────
{
  // Every component supported ⇒ a full write, not a patch.
  const full = regenerateDay(input({
    base: { ...base(), totalInvestments: 0, totalDigitalAssets: 0 },
  }));
  assert.equal(full.action, "write");
  assert.equal(full.components?.every((c) => c.authorized), true);
  ok("F · with every term authorised the day is a full write");

  // A partial day recomputes aggregates so the ROW stays internally consistent…
  const partial = regenerateDay(input({ ownershipIneligible: true }));
  assert.deepEqual(aggregateIdentityViolations({ ...STORED, ...partial.fieldPatch }), [],
    "the patched row satisfies every stored identity");
  // …but assertability is NOT granted here: it is derived at the read boundary
  // from the component verdicts, and the crypto verdict is still `unavailable`.
  assert.equal(partial.cryptoValuationStatus, "unavailable");
  assert.equal(decision(partial, "crypto")?.authorized, false);
  ok("G/H · a mixed-basis row stays internally consistent without gaining authorisation");
}

// ── I · a frozen row produces no patch at all ───────────────────────────────
{
  const r = regenerateDay(input({ existingIsEstimated: false, ownershipIneligible: true }));
  assert.equal(r.action, "skip-frozen");
  assert.equal(r.fieldPatch, null);
  assert.equal(r.components, null);
  ok("I · a frozen row produces no components and no patch");
}

// ── J · membership change still blocks any write ────────────────────────────
{
  const r = regenerateDay(input({ membershipChangedSince: true }));
  assert.equal(r.action, "skip-membership-changed");
  assert.equal(r.fieldPatch, null);
  ok("J · a membership-changed row produces no patch");
}

// ── K · invalid DEBT evidence refuses debt without blocking the rest ────────
{
  const r = regenerateDay(input({
    base: { ...base(), totalLiabilities: -5 },        // impossible magnitude
    investmentValue: 6_000, hasInvestmentEvidence: true,
  }));
  assert.equal(r.action, "write-partial");
  assert.equal(decision(r, "debt")?.action, "preserved");
  assert.equal(decision(r, "debt")?.value, STORED.debt, "the impossible value is not written");
  assert.ok((decision(r, "debt")?.reason ?? "").includes("INVALID_VALUATION_EVIDENCE"));
  assert.equal(decision(r, "stocks")?.action, "recomputed", "the valid component is still corrected");
  near(decision(r, "stocks")?.value, 6_000, "stocks recomputed");
  ok("K · invalid Debt evidence refuses Debt alone, and Investments is still corrected");
}

// ── N · a second run produces no patch ──────────────────────────────────────
{
  const repaired = { ...STORED, debt: 29_505.03, netWorth: STORED.netWorth - 145.98, netLiquid: STORED.netLiquid - 145.98 };
  const r = regenerateDay(input({ ownershipIneligible: true, existing: repaired }));
  assert.deepEqual(keys(r.fieldPatch), [], "nothing left to change");
  assert.equal(patchableRows([r]).length, 0, "an empty patch is never written");
  ok("N · re-running over repaired rows yields an empty patch and zero writes");
}

// ── L/M · the phantom fixture, and clamps are not mistaken for it ───────────
{
  const points: SeriesPoint[] = [
    { dateISO: "2025-07-28", value: 100, movement: 0, isEstimated: true },
    { dateISO: "2025-07-29", value: 110, movement: -10, isEstimated: true },
    { dateISO: "2025-07-30", value: 120, movement: -10, isEstimated: true },
    // the phantom: step 155.98 where the ledger holds only 10
    { dateISO: "2025-07-31", value: 275.98, movement: -10, isEstimated: true },
    { dateISO: "2025-08-01", value: 285.98, movement: -10, isEstimated: true },
  ];
  const report = auditLiabilitySeries(points);
  const phantoms = report.violations.filter((v) => v.kind === "PHANTOM");
  assert.equal(phantoms.length, 1);
  assert.equal(phantoms[0].dateISO, "2025-07-31");
  assert.equal(report.healthy, false, "a phantom fails the probe");
  ok("L · the probe localises the phantom to its exact transition");

  // An observed boundary is not a defect and never fails the probe.
  const observed: SeriesPoint[] = [
    { dateISO: "2026-07-19", value: 17.12, movement: -187.13, isEstimated: false },
    { dateISO: "2026-07-20", value: 79.23, movement: 318.50, isEstimated: false },
  ];
  assert.equal(auditLiabilitySeries(observed).healthy, true);
  assert.equal(auditLiabilitySeries(observed).violations[0]?.kind, "OBSERVED_BOUNDARY");
  ok("M · an observed boundary is classified apart and never fails the probe");
}

// ── Static guards ───────────────────────────────────────────────────────────
{
  const core = readFileSync(new URL("./regenerate-history.core.ts", import.meta.url), "utf8");
  const binding = readFileSync(new URL("./regenerate-history.ts", import.meta.url), "utf8");

  // No component gate may treat Investments as a universal day-level permission.
  assert.ok(!/if\s*\(\s*!input\.hasInvestmentEvidence[^)]*\)\s*\{\s*return\s*\{[\s\S]{0,200}skip-unsupported/.test(core),
    "investment evidence no longer returns a whole-day skip on its own");
  // An unsupported component is never defaulted to zero.
  assert.ok(!/value:\s*0\s*,\s*authorized:\s*false/.test(core), "no unsupported component defaults to zero");
  assert.ok(/existing\[component\]/.test(core), "a preserved component reads the STORED value");
  // The repair path is the canonical regenerator; no bespoke financial SQL.
  assert.ok(!/\$executeRaw|\$queryRaw/.test(binding), "no raw SQL write path in the regenerator");
  // The standing probe re-reads rather than trusting what it meant to write.
  assert.ok(/verifyLiabilitySeries/.test(binding) && /spaceSnapshot\.findMany/.test(binding),
    "the write-time probe reads the rows back");
  ok("static guards · no day-level investment gate, no zero-default, no raw SQL, probe re-reads");
}

// One repository-wide guard: the audit script must not write.
{
  const audit = readFileSync(new URL("../../scripts/audit-snapshot-integrity.ts", import.meta.url), "utf8");
  assert.ok(!/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/.test(audit),
    "the integrity audit is read-only");
  ok("the repository-wide integrity audit is read-only");
}

assert.equal(writableRows([]).length, 0);

for (const c of checks) console.log("  ✓ " + c);
console.log(`component-authorisation: ${checks.length} checks passed`);
