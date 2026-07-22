/**
 * lib/prices/providers/fixture.test.ts
 *
 * A8-1 — fixture provider contract. Standalone tsx script:
 *
 *     npx tsx lib/prices/providers/fixture.test.ts
 *
 * Proves the fixture adapter honors the PriceProviderAdapter contract that a
 * real vendor must also honor: window filtering, basis filtering, ascending
 * order, deterministic output, and never fabricating an absent date.
 */

import { PriceBasis } from "@prisma/client";
import { createFixturePriceProvider, type FixturePrice } from "./fixture";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const seed: FixturePrice[] = [
  { instrumentId: "i1", basis: PriceBasis.RAW_CLOSE, dateISO: "2026-06-05", price: 200 },
  { instrumentId: "i1", basis: PriceBasis.RAW_CLOSE, dateISO: "2026-06-08", price: 210 },
  { instrumentId: "i1", basis: PriceBasis.RAW_CLOSE, dateISO: "2026-06-09", price: 205 },
  { instrumentId: "i1", basis: PriceBasis.NAV, dateISO: "2026-06-08", price: 100 },
  { instrumentId: "i2", basis: PriceBasis.RAW_CLOSE, dateISO: "2026-06-08", price: 50 },
];

async function main(): Promise<void> {
  const provider = createFixturePriceProvider(seed, { source: "fixture" });

  // ── 1. Metadata ───────────────────────────────────────────────────────────
  console.log("1. Adapter metadata");
  check("source is stable provenance", provider.source === "fixture");
  check("supportedBases reflects the seeded bases",
    provider.supportedBases().includes(PriceBasis.RAW_CLOSE) && provider.supportedBases().includes(PriceBasis.NAV));
  check("historicalDepth is the earliest seeded date", provider.historicalDepth === "2026-06-05");

  // ── 2. Window + instrument + basis filtering ──────────────────────────────
  console.log("2. Window/instrument/basis filtering");
  {
    const rows = await provider.fetchDailyCloses({
      instrumentId: "i1", providerSymbol: "SYM", basis: PriceBasis.RAW_CLOSE,
      fromISO: "2026-06-06", toISO: "2026-06-08",
    });
    check("returns only rows inside [from,to] for the instrument+basis", rows.length === 1 && rows[0].dateISO === "2026-06-08");
    check("row carries instrument, basis, price, currency",
      rows[0].instrumentId === "i1" && rows[0].basis === PriceBasis.RAW_CLOSE && rows[0].price === 210 && rows[0].currency === "USD");
  }
  {
    const nav = await provider.fetchDailyCloses({
      instrumentId: "i1", providerSymbol: "SYM", basis: PriceBasis.NAV,
      fromISO: "2026-06-01", toISO: "2026-06-30",
    });
    check("NAV request never returns RAW_CLOSE rows", nav.length === 1 && nav[0].price === 100);
    const otherInst = await provider.fetchDailyCloses({
      instrumentId: "i2", providerSymbol: "SYM", basis: PriceBasis.RAW_CLOSE,
      fromISO: "2026-06-01", toISO: "2026-06-30",
    });
    check("another instrument's rows are isolated", otherInst.length === 1 && otherInst[0].instrumentId === "i2");
  }

  // ── 3. Ascending order + no fabrication of absent dates ───────────────────
  console.log("3. Ordering + absence");
  {
    const rows = await provider.fetchDailyCloses({
      instrumentId: "i1", providerSymbol: "SYM", basis: PriceBasis.RAW_CLOSE,
      fromISO: "2026-06-01", toISO: "2026-06-30",
    });
    check("rows in ascending date order", rows.map((x) => x.dateISO).join(",") === "2026-06-05,2026-06-08,2026-06-09");
    // 06-06 and 06-07 are absent in the seed — the fixture returns no row for them.
    check("absent dates are simply missing (never interpolated)", !rows.some((x) => x.dateISO === "2026-06-06" || x.dateISO === "2026-06-07"));
  }

  // ── 4. Determinism ────────────────────────────────────────────────────────
  console.log("4. Determinism");
  {
    const req = { instrumentId: "i1", providerSymbol: "SYM", basis: PriceBasis.RAW_CLOSE, fromISO: "2026-06-01", toISO: "2026-06-30" };
    const a = await provider.fetchDailyCloses(req);
    const b = await provider.fetchDailyCloses(req);
    check("identical request → byte-identical rows", JSON.stringify(a) === JSON.stringify(b));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll fixture provider checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
