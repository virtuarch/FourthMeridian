/**
 * lib/money/serialize.test.ts
 *
 * MC1 Phase 3 Slice 2 — SerializedConversionContext tests (pure: no DB, no
 * network). House-style standalone tsx script, auto-discovered by
 * scripts/run-tests.ts. This suite is deliberately the only exerciser of
 * serialization until the Slice 6 client flip.
 */

import { convertMoney, identityContext, rehydrateContext, serializeContext } from "./convert";
import { buildConversionContext } from "./context";
import { minusDaysISO } from "@/lib/fx/config";
import type { FxArchiveReader } from "@/lib/fx/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fakeArchive(rows: Record<string, number>): FxArchiveReader {
  const store = new Map(Object.entries(rows));
  return {
    async readLatestOnOrBefore(base, quote, dateISO, maxStaleDays) {
      if (base !== "USD") return null;
      for (let i = 0; i <= maxStaleDays; i++) {
        const d = minusDaysISO(dateISO, i);
        const rate = store.get(`${d}|${quote}`);
        if (rate !== undefined) return { dateISO: d, rate };
      }
      return null;
    },
  };
}

const D = "2026-07-01";

async function main(): Promise<void> {
  const rows = { [`${D}|EUR`]: 0.8, [`${minusDaysISO(D, 2)}|GBP`]: 0.5 };
  const built = await buildConversionContext(
    { target: "USD", currencies: ["EUR", "GBP", "SAR"], dates: [D] },
    fakeArchive(rows),
  );

  // ── round-trip: identical behavior after rehydration ────────────────────────
  {
    const s = serializeContext(built, ["EUR", "GBP", "SAR"], [D]);
    const re = rehydrateContext(s);
    check("round-trip: target preserved", re.target === "USD");
    for (const from of ["EUR", "GBP", "SAR"]) {
      check(`round-trip: resolve(${from}) byte-equal to original`,
        JSON.stringify(re.resolve(from, D)) === JSON.stringify(built.resolve(from, D)));
    }
    check("round-trip: unserialized pair → deterministic miss (same as unprefetched)",
      JSON.stringify(re.resolve("EUR", "2020-01-01")) === JSON.stringify(built.resolve("EUR", "2020-01-01")));
    // end-to-end through convertMoney: same ConvertedMoney either way
    const a = convertMoney({ amount: 80, currency: "EUR" }, D, built);
    const b = convertMoney({ amount: 80, currency: "EUR" }, D, re);
    check("round-trip: convertMoney byte-equal through rehydrated context",
      JSON.stringify(a) === JSON.stringify(b) && a.amount === 100);
  }

  // ── determinism ─────────────────────────────────────────────────────────────
  {
    const s1 = serializeContext(built, ["EUR", "GBP", "SAR"], [D]);
    const s2 = serializeContext(built, ["EUR", "GBP", "SAR"], [D]);
    check("determinism: serialize twice → byte-identical payload", JSON.stringify(s1) === JSON.stringify(s2));
    check("determinism: payload survives JSON transport",
      JSON.stringify(rehydrateContext(JSON.parse(JSON.stringify(s1)) ).resolve("EUR", D)) ===
      JSON.stringify(built.resolve("EUR", D)));
    const r1 = rehydrateContext(s1);
    const r2 = rehydrateContext(s1);
    check("determinism: rehydrate twice → identical resolutions",
      JSON.stringify(r1.resolve("GBP", D)) === JSON.stringify(r2.resolve("GBP", D)));
  }

  // ── frozen ──────────────────────────────────────────────────────────────────
  {
    const re = rehydrateContext(serializeContext(built, ["EUR"], [D]));
    check("frozen: rehydrated context frozen", Object.isFrozen(re));
  }

  // ── empty payload for all-USD ───────────────────────────────────────────────
  {
    const usdOnly = serializeContext(identityContext("USD"), ["USD", null, "USD"], [D]);
    check("all-USD Space: empty entries payload", Object.keys(usdOnly.entries).length === 0 && usdOnly.target === "USD");
    const re = rehydrateContext(usdOnly);
    const c = convertMoney({ amount: 42, currency: "USD" }, D, re);
    check("all-USD Space: rehydrated empty context is pure identity", c.amount === 42 && !c.estimated);
  }

  if (failures.length > 0) {
    console.error(`\nMC1 P3 serialization: ${failures.length} FAILURE(S) (${passed} checks passed):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`MC1 P3 serialization: all ${passed} checks passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("serialize.test.ts crashed:", e);
  process.exit(1);
});
